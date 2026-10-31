// Minimal OIDC Authorization Code + PKCE client (no dependencies).
// Defaults target the dev Keycloak from docker-compose; override via
// VITE_OIDC_ISSUER / VITE_OIDC_CLIENT_ID for an external IdP.
//
// Requirements for ANY IdP (see README "OIDC login"): a public client with
// PKCE (S256), UUID `sub`, and a `tenant_id` claim carrying the user's home
// tenant UUID (validated server-side by the oidc-authn-plugin gear).
//
// Session handling: access tokens are short-lived (Keycloak default 1 h), so
// the refresh token is kept in storage and used to renew silently — both on a
// timer and after a 401.
//
// It lives in localStorage, not sessionStorage, so the session survives a
// reload AND a second tab. That is a deliberate trade: a refresh token in
// localStorage is readable by any script that gets into the page, and it
// outlives the tab. The alternative was signing people out every time they
// opened the portal beside the one they were already using, which is what
// sessionStorage does. The PKCE verifier stays per-tab, where it belongs — it
// is one login attempt, not a session.

import { env } from "./env";

/** The issuer this portal signs in with, the default included. */
export const ISSUER: string = env.oidcIssuer ?? "https://localhost:8443/realms/studio";
const CLIENT_ID: string = env.oidcClientId ?? "studio-portal";

/** The route the portal mirrors an open space on (`App.tsx` owns the pair). */
const SPACE_ROUTE = /\/space(\/[0-9a-f-]*)?\/?$/;

// Vite's relative base (`./`) lets one image run at `/` on the dedicated POC
// host and at a legacy nested mount, so the mount point has to be recovered
// from the address bar rather than read from a constant.
//
// IT USED TO BE `new URL(import.meta.env.BASE_URL, window.location.href)`, and
// that is wrong in exactly one place, which happens to be the place people sign
// in from. `BASE_URL` is `./`, and `./` resolves against the DIRECTORY of the
// current URL — it drops the last segment:
//
//     /                                    ->  /          (worked)
//     /space/01d89b55-aef7-4ca4-921a-...    ->  /space/    (did not)
//
// So signing in with a project open handed Keycloak `redirect_uri=/space/`, and
// Keycloak faithfully returned the person to `/space/?code=...` — a path the
// portal has no route for, which is why the tab sat blank and why opening `/`
// by hand then signed them straight in. Both were the same bug seen from its
// two ends.
//
// The mount point is the address minus the route, and there is one route with a
// path: `/space/{id}`. Query and fragment go too — a `redirect_uri` is a place,
// and the token exchange must send back character-for-character what the
// authorization request sent.
function applicationUrl(): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(SPACE_ROUTE, "");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

const VERIFIER_KEY = "studio.oidc.verifier";
const RETURN_KEY = "studio.oidc.return";
const REFRESH_KEY = "studio.oidc.refresh";
const ID_TOKEN_KEY = "studio.oidc.id";

/** Session storage that degrades instead of throwing.
 *
 *  Private mode and blocked site data make every access throw, and an
 *  exception here would take down sign-in itself rather than the convenience
 *  it provides. A session that cannot be stored simply does not survive a
 *  reload. */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* nothing to do — the session lives only in memory */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* already gone as far as anyone can tell */
    }
  },
};

export interface SsoSession {
  accessToken: string;
  /** Seconds until the access token expires (per the IdP). */
  expiresIn: number;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tokenEndpoint(): string {
  return `${ISSUER}/protocol/openid-connect/token`;
}

function storeSession(body: {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}): SsoSession {
  if (!body.access_token) throw new Error("SSO: no access_token in the token response");
  if (body.refresh_token) store.set(REFRESH_KEY, body.refresh_token);
  // Kept for RP-initiated logout (id_token_hint) — lets Sign out end the
  // IdP session too, so the next login shows the account form instead of
  // silently reusing the Keycloak SSO cookie.
  if (body.id_token) store.set(ID_TOKEN_KEY, body.id_token);
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 300 };
}

/**
 * Redirect to the IdP's authorization endpoint (never returns).
 * `idpHint` (Keycloak `kc_idp_hint`) jumps straight to a federated identity
 * provider — google / github / microsoft — when one is configured in the
 * realm (Identity Providers section); otherwise Keycloak shows its own form.
 */
export async function startSsoLogin(idpHint?: string, loginHint?: string): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  /*
   * `state` carries the way back.
   *
   * `redirect_uri` is now the application's root and only that — one place, and
   * one the IdP has registered — so the route the person was on cannot ride
   * home in it. `state` is the parameter for exactly this: the IdP returns it
   * untouched, and it binds the response to the request this tab made. Before
   * this, nothing was sent in it at all.
   *
   * Per tab, beside the PKCE verifier and for its reason: this is one sign-in
   * attempt, not a session, and two tabs signing in are two places to return
   * to.
   */
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  try {
    const path = window.location.pathname + window.location.search + window.location.hash;
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ state, path }));
  } catch {
    /* No storage, no return trip — sign-in itself still works, and landing on
       the portal root is where it landed before any of this. */
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: applicationUrl(),
    response_type: "code",
    scope: "openid",
    state,
    code_challenge: b64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  });
  // Always the IdP's form, never its session cookie: a browser still signed
  // in to Keycloak as someone else — who closed the tab without signing out —
  // would otherwise sign the next person in as them with no form shown. The
  // desktop has sent the same since #395. Renewal is untouched: it goes by
  // refresh token, not through here.
  params.set("prompt", "login");
  if (idpHint) params.set("kc_idp_hint", idpHint);
  // Pre-fills the IdP's own form, so an e-mail typed here is not asked twice.
  if (loginHint) params.set("login_hint", loginHint);
  window.location.href = `${ISSUER}/protocol/openid-connect/auth?${params.toString()}`;
}

/** What a password sign-in came to. */
export type PasswordSignIn =
  | { kind: "signed-in"; session: SsoSession }
  /** The IdP checked the credentials and said no; `reason` is for the person. */
  | { kind: "rejected"; reason: string }
  /** The portal could not finish here and handed over to the IdP's form. */
  | { kind: "redirected" };

/**
 * Sign in with an e-mail and a password without leaving the portal.
 *
 * This is the password grant (Keycloak "Direct access grants" on the client),
 * the only way a password typed on this page becomes a session without the
 * browser visiting the IdP. Its costs are known and accepted for our own
 * first-party page: the password passes through this script on its way to the
 * IdP, and the grant cannot run anything interactive — no OTP, no "update
 * your password", no terms to accept.
 *
 * So whatever the grant cannot finish goes on to the IdP's own form with the
 * e-mail filled in, rather than failing: a client with direct grants switched
 * off (`unauthorized_client`), and an account Keycloak calls "not fully set
 * up" (pending required actions). Only a refusal of the credentials stays
 * here as an error, because the IdP's form would refuse them too.
 */
export async function signInWithPassword(username: string, password: string): Promise<PasswordSignIn> {
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: CLIENT_ID,
      username,
      password,
      scope: "openid",
    }),
  });
  if (res.ok) return { kind: "signed-in", session: storeSession(await res.json()) };
  let body: { error?: string; error_description?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* not an OAuth error body — treated as "cannot finish here" below */
  }
  const description = body.error_description ?? "";
  if (body.error === "invalid_grant" && !/not fully set up/i.test(description)) {
    return {
      kind: "rejected",
      reason:
        !description || /invalid user credentials/i.test(description)
          ? "Wrong email or password."
          : description,
    };
  }
  await startSsoLogin(undefined, username);
  return { kind: "redirected" };
}

/** Keycloak's own "forgot password" form for this client. It needs no
 *  sign-in in progress: given a client id, Keycloak starts one itself. */
export function resetPasswordUrl(): string {
  return `${ISSUER}/login-actions/reset-credentials?${new URLSearchParams({ client_id: CLIENT_ID })}`;
}

/** The return trip this tab stored, consumed so a reload cannot replay it. */
function takeReturnIntent(): { state: string; path: string } | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { state?: unknown }).state !== "string" ||
      // Same-document paths only. A stored value is this tab's own, but it
      // decides where the browser goes next, and "//evil.example" is a path
      // that is not one.
      !/^\/(?!\/)/.test(String((parsed as { path?: unknown }).path ?? ""))
    ) {
      return null;
    }
    return parsed as { state: string; path: string };
  } catch {
    return null;
  }
}

/**
 * If the current URL is an OIDC redirect (?code=...), exchange the code for
 * tokens and clean the URL. Returns null when not a redirect.
 */
export async function completeSsoLogin(): Promise<SsoSession | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!code || !verifier) return null;
  sessionStorage.removeItem(VERIFIER_KEY);

  // The token exchange has to repeat the redirect_uri the authorization request
  // sent, so it is read here — while the address bar still holds what the IdP
  // redirected to — and reused below rather than recomputed after the URL has
  // been rewritten.
  const redirectUri = applicationUrl();

  const intent = takeReturnIntent();
  if (intent && url.searchParams.get("state") !== intent.state) {
    throw new Error("SSO state does not match the sign-in this tab started");
  }

  for (const p of ["code", "state", "session_state", "iss"]) url.searchParams.delete(p);
  // Back where they were, not at the root the IdP had to be pointed at. The
  // main application reads the path on mount, and it mounts after this
  // resolves, so rewriting it here is what puts the open project back.
  window.history.replaceState({}, "", intent?.path ?? url.pathname + (url.search || ""));

  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`SSO token exchange failed: HTTP ${res.status}`);
  return storeSession(await res.json());
}

/** The renewal currently in flight, if any — see [`refreshSsoSession`]. */
let inFlight: Promise<SsoSession | null> | null = null;

/**
 * Renew the access token with the stored refresh token. Returns null when no
 * refresh token is stored or the IdP declines (then a full login is needed).
 *
 * **Single-flight, and that is the point.** A refresh token is single-use when
 * the realm rotates them: the first exchange invalidates it. The portal fires
 * many calls at once, so a burst of 401s used to start a renewal each — one
 * won, the rest were told their token was already spent, and each of those
 * deleted the session that had just been renewed. A signed-in user was thrown
 * back to the login screen seconds after arriving. Everyone now waits on the
 * same exchange.
 */
export function refreshSsoSession(): Promise<SsoSession | null> {
  if (!inFlight) {
    inFlight = exchangeRefreshToken().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function exchangeRefreshToken(): Promise<SsoSession | null> {
  const refreshToken = store.get(REFRESH_KEY);
  if (!refreshToken) return null;
  let res: Response;
  try {
    res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
  } catch {
    // The IdP was unreachable — a network blip, not a verdict on the session.
    // Keep the token; the next 401 or the renewal timer tries again.
    return null;
  }
  if (!res.ok) {
    discardIfStillOurs(refreshToken);
    return null;
  }
  try {
    return storeSession(await res.json());
  } catch {
    discardIfStillOurs(refreshToken);
    return null;
  }
}

/** Forget the session only if nobody has replaced it meanwhile.
 *
 *  Another TAB shares this storage and rotates the same token, so a refusal
 *  can arrive for a token that has already been succeeded by a good one. This
 *  is the cross-tab half of the race the single-flight above closes within
 *  one tab. */
function discardIfStillOurs(attempted: string): void {
  if (store.get(REFRESH_KEY) === attempted) {
    store.remove(REFRESH_KEY);
  }
}

export function hasSsoSession(): boolean {
  return Boolean(store.get(REFRESH_KEY));
}

export function clearSsoSession(): void {
  store.remove(REFRESH_KEY);
  store.remove(ID_TOKEN_KEY);
}

/**
 * RP-initiated logout: clear local state AND end the IdP session, so the
 * next "Sign in with SSO" asks for credentials instead of silently reusing
 * the Keycloak SSO cookie (the "can't switch user" trap).
 *
 * Returns true when a redirect to the IdP was issued (the page navigates
 * away); false when there was no SSO session — static-token logins just
 * clear locally.
 */
export function endSsoSession(): boolean {
  const idToken = store.get(ID_TOKEN_KEY);
  const hadSso = hasSsoSession() || Boolean(idToken);
  clearSsoSession();
  if (!hadSso) return false;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    post_logout_redirect_uri: applicationUrl(),
  });
  // With the hint Keycloak logs out and redirects straight back; without it
  // (e.g. storage was wiped) it shows its own logout confirmation page.
  if (idToken) params.set("id_token_hint", idToken);
  window.location.href = `${ISSUER}/protocol/openid-connect/logout?${params.toString()}`;
  return true;
}
