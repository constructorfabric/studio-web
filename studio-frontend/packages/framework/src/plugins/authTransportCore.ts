/**
 * The one REST transport implementation for auth, shared by `auth()` (host) and
 * `authShared()` (MFE).
 *
 * The two used to be copies, and the copy had lost half the rules: no CSRF
 * header, no cookie-origin scoping, no `onTransportError`, no refresh dedup.
 * None of that is policy an MFE gets to differ on — it is the host's, applied to
 * requests that merely originate in another module realm. All that genuinely
 * differs is WHERE the session comes from, which is what subclasses supply.
 *
 * Not exported from the package barrels: an internal contract between auth.ts
 * and authShared.ts, which is what keeps the shape free to change.
 */

import {
  RestPlugin,
  type ApiPluginErrorContext,
  type RestRequestContext,
  type RestResponseContext,
} from '@gears-frontx/api';
import type { AuthContext, AuthSession, AuthTransportRequest } from '@gears-frontx/auth';

/**
 * Where a realm gets its session, and what it may do about a 401.
 *
 * `refresh` takes NO arguments on purpose: it is shared between concurrent
 * callers, so binding it to one request's `AbortSignal` would let the first
 * caller's abort cancel the refresh every other waiter is awaiting. Cancelling
 * the refresh itself is the provider's business (timeout, internal lifecycle).
 */
export interface AuthTransportSessionSource {
  getSession: (ctx?: AuthContext) => Promise<AuthSession | null>;
  refresh?: () => Promise<AuthSession | null>;
  onTransportError?: (event: {
    request: AuthTransportRequest;
    error: Error;
    status?: number;
  }) => void;
}

/** Cookie-transport policy. Owned by the host, wherever the request comes from. */
export interface AuthTransportOptions {
  allowedCookieOrigins?: readonly string[];
  csrfHeaderName?: string;
}

export interface ResolvedAuthTransport {
  source: AuthTransportSessionSource;
  options: AuthTransportOptions;
}

// ---------------------------------------------------------------------------
// REST transport helpers
// ---------------------------------------------------------------------------

function isSupportedAuthTransportMethod(
  method: RestRequestContext['method']
): method is AuthTransportRequest['method'] {
  // @cpt-begin:cpt-frontx-algo-auth-plugin-transport-request:p1:inst-method-guard
  return method === 'GET'
    || method === 'POST'
    || method === 'PUT'
    || method === 'DELETE'
    || method === 'PATCH'
    || method === 'HEAD'
    || method === 'OPTIONS';
  // @cpt-end:cpt-frontx-algo-auth-plugin-transport-request:p1:inst-method-guard
}

export function toAuthTransportRequest(request: RestRequestContext): AuthTransportRequest | null {
  if (!isSupportedAuthTransportMethod(request.method)) return null;

  // @cpt-begin:cpt-frontx-algo-auth-plugin-transport-request:p1:inst-body-serialize
  let body: string | undefined;
  if (typeof request.body === 'string') {
    body = request.body;
  } else if (request.body !== undefined) {
    try {
      body = JSON.stringify(request.body);
    } catch {
      body = undefined;
    }
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-transport-request:p1:inst-body-serialize

  // @cpt-begin:cpt-frontx-algo-auth-plugin-transport-request:p1:inst-request-shape
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  };
  // @cpt-end:cpt-frontx-algo-auth-plugin-transport-request:p1:inst-request-shape
}

function isRelativeUrl(url: string): boolean {
  // @cpt-begin:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-relative-url
  return url.startsWith('/') && !url.startsWith('//');
  // @cpt-end:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-relative-url
}

function getOrigin(url: string): string | null {
  // @cpt-begin:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-get-origin
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-get-origin
}

function getRuntimeOrigin(): string | null {
  // @cpt-begin:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-runtime-origin
  const maybeLocation = (globalThis as { location?: { origin?: string } }).location;
  if (!maybeLocation?.origin || maybeLocation.origin === 'null') return null;
  return maybeLocation.origin;
  // @cpt-end:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-runtime-origin
}

export function shouldIncludeCredentials(
  url: string,
  allowedOrigins: readonly string[] | undefined
): boolean {
  // @cpt-begin:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-scope-check
  if (isRelativeUrl(url)) return true;

  const origin = getOrigin(url);
  if (!origin) return false;

  const runtimeOrigin = getRuntimeOrigin();
  if (runtimeOrigin && origin === runtimeOrigin) return true;

  if (!allowedOrigins || allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(origin);
  // @cpt-end:cpt-frontx-algo-auth-plugin-credentials-scope:p1:inst-scope-check
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * Attaches the session to outgoing REST calls and refreshes once on a 401.
 *
 * Subclasses exist only to answer "whose session, under whose policy" — and they
 * must stay DISTINCT leaf classes. `apiRegistry.plugins.remove(protocol, cls)`
 * matches instances with `instanceof` and stops at the first hit, so a shared
 * class would let one plugin's teardown unregister the other's instance in any
 * app that composed both.
 */
export abstract class BaseAuthRestPlugin extends RestPlugin {
  /** Shared in-flight refresh promise — deduplicates concurrent 401 refresh calls. */
  private refreshPromise: Promise<AuthSession | null> | null = null;

  /**
   * Resolved per request, never cached: the host may publish its session after a
   * child's `onInit` (module evaluation order across a blob chain is not
   * something a child can rely on), and the session object is replaced on every
   * refresh. `null` means this realm has no session source at all — the request
   * goes out untouched.
   */
  protected abstract resolveTransport(): ResolvedAuthTransport | null;

  async onRequest(ctx: RestRequestContext): Promise<RestRequestContext> {
    const resolved = this.resolveTransport();
    if (!resolved) return ctx;
    const { source, options } = resolved;

    // @cpt-begin:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-session-fetch
    const session = await source.getSession({ signal: ctx.signal });
    if (!session) return ctx;
    // @cpt-end:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-session-fetch

    // @cpt-begin:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-cookie-credentials
    if (session.kind === 'cookie') {
      if (!shouldIncludeCredentials(ctx.url, options.allowedCookieOrigins)) return ctx;

      const next: RestRequestContext = { ...ctx, withCredentials: true };
      const csrfHeaderName = options.csrfHeaderName;
      if (csrfHeaderName && session.csrfToken) {
        return {
          ...next,
          headers: {
            ...next.headers,
            [csrfHeaderName]: session.csrfToken,
          },
        };
      }
      return next;
    }
    // @cpt-end:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-cookie-credentials

    // @cpt-begin:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-bearer-header
    if (session.kind === 'bearer' && session.token) {
      return {
        ...ctx,
        headers: {
          ...ctx.headers,
          Authorization: `Bearer ${session.token}`,
        },
      };
    }
    // @cpt-end:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-bearer-header

    // @cpt-begin:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-custom-passthrough
    // Custom sessions: no standard transport mechanism — use a custom transport binder for retry.
    return ctx;
    // @cpt-end:cpt-frontx-flow-auth-plugin-session-attach:p1:inst-custom-passthrough
  }

  async onError(ctx: ApiPluginErrorContext): Promise<Error | RestResponseContext> {
    const resolved = this.resolveTransport();
    if (!resolved) return ctx.error;
    const { source } = resolved;

    // @cpt-begin:cpt-frontx-algo-auth-plugin-refresh-dedup:p1:inst-error-notify
    // Notify provider of every transport error (informational; called before retry decisions).
    const requestForHook = toAuthTransportRequest(ctx.request);
    if (requestForHook) {
      source.onTransportError?.({
        request: requestForHook,
        error: ctx.error,
        status: ctx.response?.status,
      });
    }
    // @cpt-end:cpt-frontx-algo-auth-plugin-refresh-dedup:p1:inst-error-notify

    if (ctx.response?.status !== 401) return ctx.error;
    if (ctx.retryCount !== 0) return ctx.error;
    const refresh = source.refresh;
    if (!refresh) return ctx.error;

    // @cpt-begin:cpt-frontx-algo-auth-plugin-refresh-dedup:p1:inst-refresh-dedup
    // Dedup concurrent 401 refresh calls into a single in-flight promise.
    // NOTE: shared refresh must NOT be bound to any single request's AbortSignal —
    // otherwise aborting the first caller would cancel refresh for all concurrent
    // waiters on the same promise. Cancellation of the refresh call itself is the
    // provider's responsibility (timeout / internal lifecycle).
    //
    // This dedups within ONE realm only. Several mounted MFEs each hold their own
    // copy of this plugin, which is why auth() publishes an already-shared
    // refresh rather than the raw provider method.
    if (!this.refreshPromise) {
      this.refreshPromise = refresh()
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    // @cpt-end:cpt-frontx-algo-auth-plugin-refresh-dedup:p1:inst-refresh-dedup

    // @cpt-begin:cpt-frontx-algo-auth-plugin-refresh-dedup:p1:inst-refresh-await
    let refreshed: AuthSession | null;
    try {
      refreshed = await this.refreshPromise;
    } catch {
      return ctx.error;
    }
    if (!refreshed) return ctx.error;
    // @cpt-end:cpt-frontx-algo-auth-plugin-refresh-dedup:p1:inst-refresh-await

    // @cpt-begin:cpt-frontx-flow-auth-plugin-refresh-retry:p1:inst-retry-bearer
    if (refreshed.kind === 'bearer') {
      if (!refreshed.token) return ctx.error;
      return ctx.retry({
        headers: { Authorization: `Bearer ${refreshed.token}` },
      });
    }
    // @cpt-end:cpt-frontx-flow-auth-plugin-refresh-retry:p1:inst-retry-bearer

    // @cpt-begin:cpt-frontx-flow-auth-plugin-refresh-retry:p1:inst-retry-cookie
    if (refreshed.kind === 'cookie') {
      // Cookie credentials are sent automatically via withCredentials.
      // No Authorization header override needed after refresh.
      return ctx.retry();
    }
    // @cpt-end:cpt-frontx-flow-auth-plugin-refresh-retry:p1:inst-retry-cookie

    // Custom sessions: no standard retry mechanism — use a custom transport binder.
    return ctx.error;
  }
}
