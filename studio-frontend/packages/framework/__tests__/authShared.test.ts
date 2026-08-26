/**
 * Unit tests for authShared — the MFE side of the auth transport.
 *
 * This path used to be a hand-copy of auth()'s plugin that had lost half its
 * rules, with no coverage but an MFE init asserting the plugin got composed. What
 * is checked here is that a child realm's requests obey the SAME policy as the
 * host's, and that the policy travels across the `globalThis` handoff rather than
 * being guessed.
 *
 * Covers:
 * 1. Bearer header from the host-published session.
 * 2. Cookie credentials scoped by the host's allowedCookieOrigins, plus CSRF.
 * 3. 401 refresh + retry, and dedup of concurrent 401s within one realm.
 * 4. Cross-realm dedup: N children collapse into one token request.
 * 5. No host published: requests pass through, 401s are not retried.
 * 6. onTransportError reaches the host's provider from a child realm.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiRegistry, RestProtocol } from '@gears-frontx/api';
import { createStore } from '@gears-frontx/state';
import type { RestPlugin, RestPluginHooks, RestRequestContext } from '@gears-frontx/api';
import type { AuthProvider, AuthSession } from '@gears-frontx/auth';
import { createFrontX } from '../src/createFrontX';
import { auth } from '../src/plugins/auth';
import {
  authShared,
  clearSharedAuthSession,
  publishSharedAuthSession,
  readSharedAuthSession,
  type SharedAuthSessionAccessor,
} from '../src/plugins/authShared';

/** Concrete auth transport plugins implement hooks; `RestPlugin` instance type omits optional hook keys. */
type AuthRestPlugin = RestPlugin & Pick<RestPluginHooks, 'onRequest' | 'onError'>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a child realm's plugin the way an MFE does — by composing
 * `authShared()` — and digs the instance back out. The registry stands in for the
 * child's own copy of @gears-frontx/api; in a browser each MFE load gets a fresh
 * one from its own blob chain.
 */
function childPlugin(): AuthRestPlugin {
  const captured: RestPlugin[] = [];
  const app = {
    apiRegistry: {
      plugins: {
        add: (_protocol: unknown, plugin: RestPlugin) => captured.push(plugin),
        remove: vi.fn(),
      },
    },
  };

  authShared().onInit?.(app as never);

  const plugin = captured[0] as AuthRestPlugin | undefined;
  if (!plugin) throw new Error('authShared() did not register a REST plugin');
  return plugin;
}

function makeReqCtx(url: string, headers: Record<string, string> = {}): RestRequestContext {
  return { method: 'GET', url, headers };
}

function make401Ctx() {
  return {
    error: new Error('HTTP 401'),
    request: makeReqCtx('/api'),
    response: { status: 401, headers: {}, data: null },
    retryCount: 0,
    retry: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: {} }),
  };
}

function publishBearer(
  token: string,
  extra: Partial<SharedAuthSessionAccessor> = {}
): SharedAuthSessionAccessor {
  const accessor: SharedAuthSessionAccessor = {
    getSession: vi.fn().mockResolvedValue({ kind: 'bearer', token } satisfies AuthSession),
    ...extra,
  };
  publishSharedAuthSession(accessor);
  return accessor;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('authShared plugin', () => {
  beforeEach(() => {
    apiRegistry.reset();
    createStore({});
  });

  afterEach(() => {
    const published = readSharedAuthSession();
    if (published) clearSharedAuthSession(published);
    apiRegistry.reset();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Bearer
  // -------------------------------------------------------------------------
  it('attaches the host session as a Bearer header', async () => {
    publishBearer('tok-child');
    const plugin = childPlugin();

    const result = (await plugin.onRequest?.(makeReqCtx('/api'))) as RestRequestContext;

    expect(result.headers['Authorization']).toBe('Bearer tok-child');
  });

  // -------------------------------------------------------------------------
  // 2. Cookie scoping + CSRF — the two rules the hand-copy had lost
  // -------------------------------------------------------------------------
  describe('cookie sessions follow the host policy', () => {
    function publishCookie(transport?: SharedAuthSessionAccessor['transport']): void {
      publishSharedAuthSession({
        getSession: vi
          .fn()
          .mockResolvedValue({ kind: 'cookie', csrfToken: 'csrf-1' } satisfies AuthSession),
        transport,
      });
    }

    it('sends credentials and the CSRF header for a relative URL', async () => {
      publishCookie({ csrfHeaderName: 'X-CSRF-Token' });
      const plugin = childPlugin();

      const result = (await plugin.onRequest?.(makeReqCtx('/relative'))) as RestRequestContext;

      expect(result.withCredentials).toBe(true);
      expect(result.headers['X-CSRF-Token']).toBe('csrf-1');
    });

    it('leaves a cross-origin request untouched when the origin is not allowlisted', async () => {
      publishCookie({ csrfHeaderName: 'X-CSRF-Token', allowedCookieOrigins: ['https://allowed.example'] });
      const plugin = childPlugin();

      const result = (await plugin.onRequest?.(
        makeReqCtx('https://elsewhere.example/api')
      )) as RestRequestContext;

      expect(result.withCredentials).toBeUndefined();
      expect(result.headers['X-CSRF-Token']).toBeUndefined();
    });

    it('sends credentials to an allowlisted cross-origin host', async () => {
      publishCookie({ allowedCookieOrigins: ['https://allowed.example'] });
      const plugin = childPlugin();

      const result = (await plugin.onRequest?.(
        makeReqCtx('https://allowed.example/api')
      )) as RestRequestContext;

      expect(result.withCredentials).toBe(true);
    });

    it('treats a missing published policy as relative-only, not as permissive', async () => {
      publishCookie(undefined);
      const plugin = childPlugin();

      const result = (await plugin.onRequest?.(
        makeReqCtx('https://elsewhere.example/api')
      )) as RestRequestContext;

      expect(result.withCredentials).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. 401 handling
  // -------------------------------------------------------------------------
  describe('401 refresh', () => {
    it('refreshes through the host and retries with the new token', async () => {
      const refresh = vi
        .fn()
        .mockResolvedValue({ kind: 'bearer', token: 'fresh' } satisfies AuthSession);
      publishBearer('stale', { refresh });
      const plugin = childPlugin();
      const errCtx = make401Ctx();

      await plugin.onError?.(errCtx);

      expect(refresh).toHaveBeenCalledTimes(1);
      // Zero-arg: a shared refresh must not inherit one request's AbortSignal.
      expect(refresh).toHaveBeenCalledWith();
      expect(errCtx.retry).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer fresh' } });
    });

    it('does not fall back to getSession when the host published no refresh', async () => {
      const accessor = publishBearer('stale');
      const plugin = childPlugin();
      const errCtx = make401Ctx();

      const result = await plugin.onError?.(errCtx);

      expect(errCtx.retry).not.toHaveBeenCalled();
      expect(result).toBe(errCtx.error);
      // The old implementation re-read the session here and retried with the
      // same expired token, turning a 401 into two 401s.
      expect(accessor.getSession).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent 401s inside one realm', async () => {
      let resolveRefresh!: (value: AuthSession) => void;
      const pending = new Promise<AuthSession>((resolve) => {
        resolveRefresh = resolve;
      });
      const refresh = vi.fn().mockReturnValue(pending);
      publishBearer('stale', { refresh });
      const plugin = childPlugin();

      const first = make401Ctx();
      const second = make401Ctx();
      const p1 = plugin.onError?.(first);
      const p2 = plugin.onError?.(second);
      resolveRefresh({ kind: 'bearer', token: 'fresh' });
      await Promise.all([p1, p2]);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(first.retry).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer fresh' } });
      expect(second.retry).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer fresh' } });
    });

    it('returns the error untouched for a non-401', async () => {
      const refresh = vi.fn();
      publishBearer('tok', { refresh });
      const plugin = childPlugin();
      const errCtx = { ...make401Ctx(), response: { status: 500, headers: {}, data: null } };

      const result = await plugin.onError?.(errCtx);

      expect(refresh).not.toHaveBeenCalled();
      expect(result).toBe(errCtx.error);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cross-realm dedup — the multi-MFE case
  // -------------------------------------------------------------------------
  it('collapses 401s from several MFEs into one token request', async () => {
    let resolveRefresh!: (value: AuthSession) => void;
    const pending = new Promise<AuthSession>((resolve) => {
      resolveRefresh = resolve;
    });
    // The provider does NOT dedupe: this asserts the guarantee comes from
    // auth()'s published accessor, not from a provider that happens to.
    const providerRefresh = vi.fn().mockReturnValue(pending);
    const provider: AuthProvider = {
      getSession: vi.fn().mockResolvedValue({ kind: 'bearer', token: 'stale' } satisfies AuthSession),
      checkAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      logout: vi.fn().mockResolvedValue({ type: 'none' }),
      refresh: providerRefresh,
    };

    const host = createFrontX().use(auth({ provider })).build();

    const mfeA = childPlugin();
    const mfeB = childPlugin();
    // Two instances, hence two per-realm dedups that cannot see each other. One
    // instance would dedup alone and prove nothing about the host.
    expect(mfeA).not.toBe(mfeB);
    const ctxA = make401Ctx();
    const ctxB = make401Ctx();

    const pA = mfeA.onError?.(ctxA);
    const pB = mfeB.onError?.(ctxB);
    resolveRefresh({ kind: 'bearer', token: 'fresh' });
    await Promise.all([pA, pB]);

    expect(providerRefresh).toHaveBeenCalledTimes(1);
    expect(ctxA.retry).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer fresh' } });
    expect(ctxB.retry).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer fresh' } });

    host.destroy();
  });

  // -------------------------------------------------------------------------
  // 5. No host
  // -------------------------------------------------------------------------
  describe('no host session published', () => {
    it('passes the request through untouched', async () => {
      const plugin = childPlugin();

      const result = (await plugin.onRequest?.(makeReqCtx('/api'))) as RestRequestContext;

      expect(result.headers['Authorization']).toBeUndefined();
      expect(result.withCredentials).toBeUndefined();
    });

    it('does not retry a 401', async () => {
      const plugin = childPlugin();
      const errCtx = make401Ctx();

      const result = await plugin.onError?.(errCtx);

      expect(errCtx.retry).not.toHaveBeenCalled();
      expect(result).toBe(errCtx.error);
    });

    it('warns on init, because the far likelier cause is a host with no auth()', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      childPlugin();

      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Transport error reporting
  // -------------------------------------------------------------------------
  it('reports a child realm transport error to the host provider', async () => {
    const onTransportError = vi.fn();
    publishBearer('tok', { onTransportError });
    const plugin = childPlugin();
    const errCtx = { ...make401Ctx(), response: { status: 503, headers: {}, data: null } };

    await plugin.onError?.(errCtx);

    expect(onTransportError).toHaveBeenCalledTimes(1);
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ error: errCtx.error, status: 503 })
    );
  });

  // -------------------------------------------------------------------------
  // Plugin identity: removal must not cross realms
  // -------------------------------------------------------------------------
  it('removes its own plugin class on destroy', () => {
    const remove = vi.fn();
    const app = {
      apiRegistry: { plugins: { add: vi.fn(), remove } },
    };
    const plugin = authShared();

    plugin.onInit?.(app as never);
    plugin.onDestroy?.(app as never);

    expect(remove).toHaveBeenCalledTimes(1);
    const [protocol, pluginClass] = remove.mock.calls[0] as [unknown, unknown];
    expect(protocol).toBe(RestProtocol);
    // Not the host's class, and not the shared base: removal matches the first
    // `instanceof`, so a class shared with auth() could unregister its plugin.
    expect((pluginClass as { name: string }).name).toBe('SharedAuthRestPlugin');
  });
});
