import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthProvider, AuthSession, RestPlugin, RestPluginHooks } from '@gears-frontx/react';
import { authShared, readSharedAuthSession } from '@constructor-studio/mfe-shared';
import { sharedAuthTransport } from './sharedAuthTransport';

const STALE: AuthSession = { kind: 'bearer', token: 'stale' };
const FRESH: AuthSession = { kind: 'bearer', token: 'fresh' };

function provider(refresh?: AuthProvider['refresh']): AuthProvider {
  return {
    getSession: vi.fn().mockResolvedValue(STALE),
    checkAuth: vi.fn().mockResolvedValue({ authenticated: true }),
    logout: vi.fn().mockResolvedValue({ type: 'none' }),
    refresh,
  };
}

function bind(authProvider: AuthProvider, trackRefresh?: () => (outcome: unknown) => Promise<void>) {
  const removeRestPlugin = vi.fn();
  const binding = sharedAuthTransport()({
    provider: authProvider,
    addRestPlugin: vi.fn(),
    removeRestPlugin,
    trackRefresh,
  });
  return { binding, removeRestPlugin };
}

/** An MFE's REST plugin, built the way its `init.ts` composes `authShared()`. */
function childPlugin(): RestPlugin & Pick<RestPluginHooks, 'onError'> {
  const captured: RestPlugin[] = [];
  const app = { apiRegistry: { plugins: { add: (_protocol: unknown, plugin: RestPlugin) => captured.push(plugin), remove: vi.fn() } } };
  authShared().onInit?.(app as never);
  return captured[0] as RestPlugin & Pick<RestPluginHooks, 'onError'>;
}

function unauthorized() {
  return {
    error: new Error('HTTP 401'),
    request: { method: 'GET', url: '/api', headers: {} },
    response: { status: 401, headers: {}, data: null },
    retryCount: 0,
    retry: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: {} }),
  };
}

const bindings: Array<{ destroy(): void }> = [];

afterEach(() => {
  for (const binding of bindings.splice(0)) binding.destroy();
  vi.restoreAllMocks();
});

describe('sharedAuthTransport', () => {
  it('publishes the session accessor on bind and removes it on destroy', async () => {
    const { binding, removeRestPlugin } = bind(provider());

    await expect(readSharedAuthSession()?.getSession()).resolves.toEqual(STALE);

    binding.destroy();
    expect(readSharedAuthSession()).toBeUndefined();
    expect(removeRestPlugin).toHaveBeenCalled();
  });

  it('a refresh asked for by a child goes through trackRefresh', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const trackRefresh = vi.fn(() => report);
    const { binding } = bind(provider(vi.fn().mockResolvedValue(FRESH)), trackRefresh);
    bindings.push(binding);

    await expect(readSharedAuthSession()?.refresh?.()).resolves.toEqual(FRESH);

    expect(trackRefresh).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ session: FRESH });
  });

  it('collapses 401s from several MFEs into one token request', async () => {
    let resolveRefresh!: (session: AuthSession) => void;
    // The provider does not dedupe: the guarantee has to come from the host's accessor.
    const refresh = vi.fn().mockReturnValue(new Promise<AuthSession>((resolve) => (resolveRefresh = resolve)));
    const { binding } = bind(provider(refresh));
    bindings.push(binding);
    const first = unauthorized();
    const second = unauthorized();

    const retried = Promise.all([childPlugin().onError?.(first as never), childPlugin().onError?.(second as never)]);
    resolveRefresh(FRESH);
    await retried;

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(first.retry).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer fresh' } });
    expect(second.retry).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer fresh' } });
  });

  it('a failed refresh rejects every MFE waiting on it and is reported as rejected', async () => {
    const failure = new Error('refresh token expired');
    const report = vi.fn().mockResolvedValue(undefined);
    const { binding } = bind(provider(vi.fn().mockRejectedValue(failure)), () => report);
    bindings.push(binding);
    const accessor = readSharedAuthSession();

    const outcomes = await Promise.allSettled([accessor?.refresh?.(), accessor?.refresh?.()]);

    expect(outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ rejected: failure });
  });

  it('asks the provider again once a refresh has failed', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(FRESH);
    const { binding } = bind(provider(refresh));
    bindings.push(binding);
    const accessor = readSharedAuthSession();

    await expect(accessor?.refresh?.()).rejects.toThrow('offline');
    await expect(accessor?.refresh?.()).resolves.toEqual(FRESH);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('publishes no refresh when the provider has none', () => {
    const { binding } = bind(provider());
    bindings.push(binding);

    expect(readSharedAuthSession()?.refresh).toBeUndefined();
  });
});
