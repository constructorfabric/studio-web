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
 * Storage: the access token lives in memory; sessionStorage keeps the refresh
 * token, id token (logout hint) and the transient PKCE verifier + state.
 * Script running on this origin can still reach the refresh token — the usual
 * SPA-without-a-BFF tradeoff — sessionStorage just scopes it per-tab and
 * clears it when the tab closes.
 */

import type {
  AuthCallbackInput,
  AuthCheckResult,
  AuthContext,
  AuthIdentity,
  AuthLoginInput,
  AuthProvider,
  AuthSession,
  AuthStateEvent,
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
/**
 * Cap for token-endpoint requests. The transport awaits getSession() before
 * every REST call, so a hung (not down) IdP would otherwise hang every
 * request in the host and all MFEs.
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Auth state event extended with why the session ended, so the UI can tell
 * an explicit sign-out from a lost session ("Session expired").
 */
export interface StudioAuthStateEvent extends AuthStateEvent {
  reason?: 'signed-out';
}

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

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined;
}

/** Display-only: decodes the JWT payload; opaque tokens yield null. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    // atob yields Latin-1 bytes while JWT payloads are UTF-8 — decode
    // explicitly or every non-ASCII name claim arrives mangled.
    const bytes = Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0)
    );
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
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
  /** Bumped on every local sign-out; in-flight refreshes from an older epoch discard their result. */
  private sessionEpoch = 0;
  private warnedDefaultIssuer = false;

  private get issuer(): string {
    const configured = env.oidcIssuer;
    if (configured) return configured;
    if (import.meta.env.PROD && !this.warnedDefaultIssuer) {
      this.warnedDefaultIssuer = true;
      console.warn(`[auth] STUDIO_OIDC_ISSUER is not configured — falling back to ${DEFAULT_ISSUER}`);
    }
    return DEFAULT_ISSUER;
  }
  private get clientId(): string {
    return env.oidcClientId ?? DEFAULT_CLIENT_ID;
  }
  private endpoint(name: 'auth' | 'token' | 'logout'): string {
    return `${this.issuer}/protocol/openid-connect/${name}`;
  }

  // --- AuthProvider: required ---

  // ctx.signal is deliberately not threaded into the shared refresh: one
  // in-flight refresh serves every caller, so one caller's abort must not
  // cancel it for the rest. FETCH_TIMEOUT_MS caps the worst case instead.
  async getSession(_ctx?: AuthContext): Promise<AuthSession | null> {
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
    this.notify('unauthenticated', undefined, 'signed-out');
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
      // Dev-only path (backend static-token profiles): the whole body is
      // eliminated from production bundles, where only the throw remains.
      if (import.meta.env.DEV) {
        const token = String(input.payload.token ?? '');
        if (!token) throw new Error('static-token login requires a non-empty token');
        this.session = { kind: 'bearer', token }; // no refresh, no expiry
        this.notify('authenticated', this.session);
        return { type: 'none' };
      }
      throw new Error('static-token sign-in is available only in dev builds');
    }

    if (!crypto.subtle) {
      throw new Error('Sign-in requires a secure context (HTTPS or localhost).');
    }
    const verifier = randomToken();
    const state = randomToken();
    sessionStorage.setItem(KEY_VERIFIER, verifier);
    sessionStorage.setItem(KEY_STATE, state);

    const url = new URL(this.endpoint('auth'));
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', `${window.location.origin}/`);
    url.searchParams.set('response_type', 'code');
    // profile+email are requested explicitly: the header depends on their
    // claims, and default-client-scope configuration is not guaranteed.
    url.searchParams.set('scope', 'openid profile email');
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
    // Fail closed: a verifier without a stored state is not a valid login
    // attempt from this tab, whatever wrote it.
    if (expectedState === null || (input.params.state ?? input.state) !== expectedState) {
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
      signal: timeoutSignal(),
    });
    if (!res.ok) throw new Error(`SSO token exchange failed: HTTP ${res.status}`);
    this.storeSession(await parseTokenResponse(res));
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
    // Identity comes from the ID token — the OIDC identity document; the
    // access token is only a fallback for static dev tokens. Display-only,
    // so never a network round-trip: an expired session is not refreshed here.
    const idToken = sessionStorage.getItem(KEY_ID_TOKEN);
    const claims =
      (idToken ? decodeJwtClaims(idToken) : null) ??
      (this.session ? decodeJwtClaims(this.session.token) : null);
    if (!claims) return null;
    const sub = typeof claims.sub === 'string' ? claims.sub : 'unknown';
    return { sub, claims: claims as AuthIdentity['claims'] };
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
    const epoch = this.sessionEpoch;
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
        signal: timeoutSignal(),
      });
    } catch {
      // Network failure or timeout: keep the refresh token, the next attempt
      // may succeed.
      return null;
    }
    let bodyJson: TokenResponse | null = null;
    if (res.ok) {
      try {
        bodyJson = (await res.json()) as TokenResponse;
      } catch {
        // Non-JSON 200 (issuer misconfigured to a page that answers 200 for
        // everything, captive portal): retrying will not make it readable —
        // treat as a rejected refresh, never let it escape as a throw.
        bodyJson = null;
      }
    }
    // Signed out while the request was in flight: the session was already
    // cleared — discard the result instead of resurrecting it.
    if (epoch !== this.sessionEpoch) return null;
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
    this.armRenewTimer(Math.max(MIN_RENEW_DELAY_MS, expiresIn * 1000 - EXPIRY_SKEW_MS));
    this.notify('authenticated', this.session);
  }

  private armRenewTimer(delayMs: number): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => {
      void this.refresh().then((session) => {
        if (session !== null) return; // success: storeSession re-armed the timer
        // null with the refresh token intact = transient network failure —
        // retry, or an idle tab silently loses its renewal loop. A rejected
        // refresh clears the token, which ends the loop here.
        if (sessionStorage.getItem(KEY_REFRESH) !== null) {
          this.armRenewTimer(MIN_RENEW_DELAY_MS);
        }
      });
    }, delayMs);
  }

  private clearLocalSession(): void {
    this.sessionEpoch += 1;
    this.session = null;
    sessionStorage.removeItem(KEY_REFRESH);
    sessionStorage.removeItem(KEY_ID_TOKEN);
    sessionStorage.removeItem(KEY_VERIFIER);
    sessionStorage.removeItem(KEY_STATE);
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewTimer = null;
  }

  private notify(
    state: 'authenticated' | 'unauthenticated',
    session?: AuthSession,
    reason?: 'signed-out'
  ): void {
    const event: StudioAuthStateEvent = { state, session, reason };
    for (const listener of this.listeners) listener(event);
  }
}

async function parseTokenResponse(res: Response): Promise<TokenResponse> {
  try {
    return (await res.json()) as TokenResponse;
  } catch {
    throw new Error('SSO token endpoint returned a non-JSON response — check the OIDC issuer URL');
  }
}

export const keycloakOidcProvider = new KeycloakOidcProvider();
