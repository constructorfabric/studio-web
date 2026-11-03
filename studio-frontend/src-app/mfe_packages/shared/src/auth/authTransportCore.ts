/**
 * The REST transport rules `authShared()` applies to an MFE's requests. They are
 * the host's, carried over from the framework copy we used to vendor and kept in
 * step with the one npm's framework keeps inside `frontxApiTransport()`
 * (`AuthRestPlugin`, 0.2.0-alpha.16), its refresh guard included.
 *
 * None of this is policy an MFE gets to differ on: it is the host's, applied to
 * requests that merely originate in another module realm. All that differs is
 * WHERE the session comes from, which `authShared.ts` supplies.
 */

import {
  RestPlugin,
  type ApiPluginErrorContext,
  type RestRequestContext,
  type RestResponseContext,
} from '@gears-frontx/react';
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
  return method === 'GET'
    || method === 'POST'
    || method === 'PUT'
    || method === 'DELETE'
    || method === 'PATCH'
    || method === 'HEAD'
    || method === 'OPTIONS';
}

export function toAuthTransportRequest(request: RestRequestContext): AuthTransportRequest | null {
  if (!isSupportedAuthTransportMethod(request.method)) return null;

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

  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  };
}

function isRelativeUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function getRuntimeOrigin(): string | null {
  const maybeLocation = (globalThis as { location?: { origin?: string } }).location;
  if (!maybeLocation?.origin || maybeLocation.origin === 'null') return null;
  return maybeLocation.origin;
}

export function shouldIncludeCredentials(
  url: string,
  allowedOrigins: readonly string[] | undefined
): boolean {
  if (isRelativeUrl(url)) return true;

  const origin = getOrigin(url);
  if (!origin) return false;

  const runtimeOrigin = getRuntimeOrigin();
  if (runtimeOrigin && origin === runtimeOrigin) return true;

  if (!allowedOrigins || allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(origin);
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/** npm's `AuthRestPlugin` values: see `refreshExhausted`. */
const MAX_REFRESHES_WITHOUT_SUCCESS = 2;
const REFRESH_BACKOFF_MS = 30_000;

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
  /** Refreshes started since the last 2xx response, and when the last one started. */
  private refreshesWithoutSuccess = 0;
  private lastRefreshAt = 0;

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

    const session = await source.getSession({ signal: ctx.signal });
    if (!session) return ctx;

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

    if (session.kind === 'bearer' && session.token) {
      return {
        ...ctx,
        headers: {
          ...ctx.headers,
          Authorization: `Bearer ${session.token}`,
        },
      };
    }

    // Custom sessions: no standard transport mechanism — use a custom transport binder for retry.
    return ctx;
  }

  onResponse(ctx: RestResponseContext): RestResponseContext {
    if (ctx.status >= 200 && ctx.status < 300) this.refreshesWithoutSuccess = 0;
    return ctx;
  }

  /**
   * A server that keeps answering 401 to a refreshed session would otherwise get
   * a refresh for every request: after `MAX_REFRESHES_WITHOUT_SUCCESS` refreshes
   * with no 2xx response, a 401 fails without one until `REFRESH_BACKOFF_MS` pass
   * or a request succeeds.
   */
  private refreshExhausted(): boolean {
    if (this.refreshesWithoutSuccess < MAX_REFRESHES_WITHOUT_SUCCESS) return false;
    if (Date.now() - this.lastRefreshAt < REFRESH_BACKOFF_MS) return true;
    this.refreshesWithoutSuccess = 0;
    return false;
  }

  async onError(ctx: ApiPluginErrorContext): Promise<Error | RestResponseContext> {
    const resolved = this.resolveTransport();
    if (!resolved) return ctx.error;
    const { source } = resolved;

    // Notify provider of every transport error (informational; called before retry decisions).
    const requestForHook = toAuthTransportRequest(ctx.request);
    if (requestForHook) {
      source.onTransportError?.({
        request: requestForHook,
        error: ctx.error,
        status: ctx.response?.status,
      });
    }

    if (ctx.response?.status !== 401) return ctx.error;
    if (ctx.retryCount !== 0) return ctx.error;
    const refresh = source.refresh;
    if (!refresh) return ctx.error;

    // Dedup concurrent 401 refresh calls into a single in-flight promise.
    // NOTE: shared refresh must NOT be bound to any single request's AbortSignal —
    // otherwise aborting the first caller would cancel refresh for all concurrent
    // waiters on the same promise. Cancellation of the refresh call itself is the
    // provider's responsibility (timeout / internal lifecycle).
    //
    // This dedups within ONE realm only. Several mounted MFEs each hold their own
    // copy of this plugin, which is why the shell's `sharedAuthTransport()`
    // publishes an already-shared refresh rather than the raw provider method.
    if (!this.refreshPromise && this.refreshExhausted()) return ctx.error;
    if (!this.refreshPromise) {
      this.refreshesWithoutSuccess += 1;
      this.lastRefreshAt = Date.now();
      this.refreshPromise = refresh()
        .finally(() => {
          this.refreshPromise = null;
        });
    }

    let refreshed: AuthSession | null;
    try {
      refreshed = await this.refreshPromise;
    } catch {
      return ctx.error;
    }
    if (!refreshed) return ctx.error;

    if (refreshed.kind === 'bearer') {
      if (!refreshed.token) return ctx.error;
      return ctx.retry({
        headers: { Authorization: `Bearer ${refreshed.token}` },
      });
    }

    if (refreshed.kind === 'cookie') {
      // Cookie credentials are sent automatically via withCredentials.
      // No Authorization header override needed after refresh.
      return ctx.retry();
    }

    // Custom sessions: no standard retry mechanism — use a custom transport binder.
    return ctx.error;
  }
}
