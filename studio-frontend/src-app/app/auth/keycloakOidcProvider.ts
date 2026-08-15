/**
 * Keycloak OIDC provider for the FrontX auth plugin.
 *
 * A dependency-free Authorization Code + PKCE (S256) client ported from the
 * prototype portal (studio-frontend-prototype/src/oidc.ts), reshaped onto the
 * @gears-frontx/auth AuthProvider contract. Endpoints are the fixed Keycloak
 * paths — no /.well-known discovery; token signature validation stays
 * server-side (oidc-authn-plugin), the SPA treats tokens as opaque except for
 * display-only claim decoding.
 *
 * Storage: the access token lives only in memory; sessionStorage keeps the
 * refresh token, id token (logout hint) and the transient PKCE verifier +
 * state — same `studio.oidc.*` keys as the prototype, plus `state` (a CSRF
 * gap the prototype had).
 */

import type {
  AuthCallbackInput,
  AuthCheckResult,
  AuthIdentity,
  AuthLoginInput,
  AuthProvider,
  AuthSession,
  AuthStateListener,
  AuthTransition,
  AuthUnsubscribe,
  BearerAuthSession,
} from '@gears-frontx/auth';
import { env } from '../config/env';

const KEY_VERIFIER = 'studio.oidc.verifier';
const KEY_STATE = 'studio.oidc.state';
const KEY_REFRESH = 'studio.oidc.refresh';
const KEY_ID_TOKEN = 'studio.oidc.id';

const DEFAULT_ISSUER = 'https://localhost:8443/realms/studio';
const DEFAULT_CLIENT_ID = 'studio-portal';

/** Renew this long before the token actually expires. */
const EXPIRY_SKEW_MS = 60_000;
/** Never schedule a renewal sooner than this (misconfigured tiny lifetimes). */
const MIN_RENEW_DELAY_MS = 30_000;

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Display-only: decodes the JWT payload; opaque tokens yield null. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims: unknown = JSON.parse(json);
    return typeof claims === 'object' && claims !== null
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
}

export class KeycloakOidcProvider implements AuthProvider {
  private session: BearerAuthSession | null = null;
  private readonly listeners = new Set<AuthStateListener>();
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<AuthSession | null> | null = null;

  private get issuer(): string {
    return env.oidcIssuer ?? DEFAULT_ISSUER;
  }
  private get clientId(): string {
    return env.oidcClientId ?? DEFAULT_CLIENT_ID;
  }
  private endpoint(name: 'auth' | 'token' | 'logout'): string {
    return `${this.issuer}/protocol/openid-connect/${name}`;
  }

  // --- AuthProvider: required ---

  async getSession(): Promise<AuthSession | null> {
    if (this.session && !this.isExpired(this.session)) return this.session;
    if (sessionStorage.getItem(KEY_REFRESH)) return this.refresh();
    return null;
  }

  async checkAuth(): Promise<AuthCheckResult> {
    const session = await this.getSession();
    return session ? { authenticated: true, session } : { authenticated: false };
  }

  async logout(): Promise<AuthTransition> {
    const idToken = sessionStorage.getItem(KEY_ID_TOKEN);
    const hadSso = idToken !== null || sessionStorage.getItem(KEY_REFRESH) !== null;
    this.clearLocalSession();
    this.notify('unauthenticated');
    if (!hadSso) return { type: 'none' }; // static-token sessions end locally
    const url = new URL(this.endpoint('logout'));
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('post_logout_redirect_uri', `${window.location.origin}/`);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    return { type: 'redirect', redirectUrl: url.toString() };
  }

  // --- AuthProvider: lifecycle ---

  async login(input: AuthLoginInput): Promise<AuthTransition> {
    if (input.type === 'static-token') {
      const token = String(input.payload.token ?? '');
      if (!token) throw new Error('static-token login requires a non-empty token');
      // Dev-only path (backend static-token profiles): no refresh, no expiry.
      this.session = { kind: 'bearer', token };
      this.notify('authenticated', this.session);
      return { type: 'none' };
    }

    const verifier = randomToken();
    const state = randomToken();
    sessionStorage.setItem(KEY_VERIFIER, verifier);
    sessionStorage.setItem(KEY_STATE, state);

    const url = new URL(this.endpoint('auth'));
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', `${window.location.origin}/`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', await s256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    const idpHint = input.payload.idpHint;
    if (typeof idpHint === 'string' && idpHint) url.searchParams.set('kc_idp_hint', idpHint);
    return { type: 'redirect', redirectUrl: url.toString() };
  }

  async handleCallback(input: AuthCallbackInput): Promise<AuthTransition> {
    const code = input.params.code;
    const verifier = sessionStorage.getItem(KEY_VERIFIER);
    if (!code || !verifier) return { type: 'none' };
    // Remove the one-shot values synchronously: a re-entrant call (e.g. React
    // StrictMode double-invoke) must become a no-op, not a second exchange.
    sessionStorage.removeItem(KEY_VERIFIER);
    const expectedState = sessionStorage.getItem(KEY_STATE);
    sessionStorage.removeItem(KEY_STATE);
    if (expectedState !== null && (input.params.state ?? input.state) !== expectedState) {
      throw new Error('SSO callback state mismatch');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code,
      redirect_uri: `${window.location.origin}/`,
      code_verifier: verifier,
    });
    const res = await fetch(this.endpoint('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`SSO token exchange failed: HTTP ${res.status}`);
    this.storeSession((await res.json()) as TokenResponse);
    return { type: 'none' };
  }

  async refresh(): Promise<AuthSession | null> {
    // One in-flight refresh serves every caller (concurrent 401s, the timer,
    // getSession) — mirrors the framework transport's own dedup.
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  destroy(): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewTimer = null;
    this.listeners.clear();
  }

  // --- AuthProvider: identity & events ---

  async getIdentity(): Promise<AuthIdentity | null> {
    const session = await this.getSession();
    if (!session || session.kind !== 'bearer') return null;
    const claims = decodeJwtClaims(session.token);
    const sub = typeof claims?.sub === 'string' ? claims.sub : 'unknown';
    return { sub, claims: (claims ?? undefined) as AuthIdentity['claims'] };
  }

  subscribe(listener: AuthStateListener): AuthUnsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- internals ---

  private isExpired(session: BearerAuthSession): boolean {
    return session.expiresAt !== undefined && Date.now() >= session.expiresAt - EXPIRY_SKEW_MS;
  }

  private async doRefresh(): Promise<AuthSession | null> {
    const refreshToken = sessionStorage.getItem(KEY_REFRESH);
    if (!refreshToken) return null;
    let res: Response;
    try {
      res = await fetch(this.endpoint('token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.clientId,
          refresh_token: refreshToken,
        }),
      });
    } catch {
      // Network failure: keep the refresh token, the next attempt may succeed.
      return null;
    }
    const bodyJson = res.ok ? ((await res.json()) as TokenResponse) : null;
    if (!bodyJson?.access_token) {
      this.clearLocalSession();
      this.notify('unauthenticated');
      return null;
    }
    this.storeSession(bodyJson);
    return this.session;
  }

  private storeSession(body: TokenResponse): void {
    if (!body.access_token) throw new Error('SSO token response has no access_token');
    const expiresIn = body.expires_in ?? 300;
    this.session = {
      kind: 'bearer',
      token: body.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    if (body.refresh_token) sessionStorage.setItem(KEY_REFRESH, body.refresh_token);
    if (body.id_token) sessionStorage.setItem(KEY_ID_TOKEN, body.id_token);
    this.scheduleRenewal(expiresIn);
    this.notify('authenticated', this.session);
  }

  private scheduleRenewal(expiresInSeconds: number): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    const delay = Math.max(MIN_RENEW_DELAY_MS, expiresInSeconds * 1000 - EXPIRY_SKEW_MS);
    this.renewTimer = setTimeout(() => {
      void this.refresh();
    }, delay);
  }

  private clearLocalSession(): void {
    this.session = null;
    sessionStorage.removeItem(KEY_REFRESH);
    sessionStorage.removeItem(KEY_ID_TOKEN);
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewTimer = null;
  }

  private notify(state: 'authenticated' | 'unauthenticated', session?: AuthSession): void {
    for (const listener of this.listeners) listener({ state, session });
  }
}

export const keycloakOidcProvider = new KeycloakOidcProvider();
