import { afterEach, describe, expect, it, vi } from 'vitest';

const build = vi.fn();
const use = vi.fn();
const createFrontX = vi.fn(() => ({
  use,
}));
const registerSlice = vi.fn();
const register = vi.fn();
const initialize = vi.fn();
const effects = vi.fn(() => 'effects-plugin');
const i18n = vi.fn(() => 'i18n-plugin');
const queryCacheShared = vi.fn(() => 'query-cache-shared-plugin');
const authShared = vi.fn(() => 'auth-shared-plugin');

vi.mock('@gears-frontx/react', () => ({
  createFrontX,
  registerSlice,
  apiRegistry: {
    register,
    initialize,
  },
  effects,
  i18n,
  queryCacheShared,
}));

// The connector client is shared with the other MFE now; `init.ts` imports it
// from the package, and nothing else in this test's graph pulls the package at
// runtime (the wire types are type-only imports and erase).
vi.mock('@constructor-studio/mfe-shared', () => ({
  ConnectorsApiService: class ConnectorsApiService {},
  authShared,
}));

vi.mock('./slices/connectSlice', () => ({
  connectSlice: { name: 'connections/connect' },
}));

vi.mock('./effects/connectEffects', () => ({
  initConnectEffects: vi.fn(),
}));

describe('connections-mfe init', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    use.mockImplementation(() => ({ use, build }));
    build.mockReturnValue({ id: 'connections-mfe-app' });
  });

  it('registers services before build and registers slices after build', async () => {
    use.mockImplementation(() => ({ use, build }));
    const expectedApp = { id: 'connections-mfe-app' };
    build.mockReturnValue(expectedApp);

    const { initConnectEffects } = await import('./effects/connectEffects');
    const module = await import('./init');

    expect(register).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(createFrontX).toHaveBeenCalledTimes(1);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(i18n).toHaveBeenCalledTimes(1);
    expect(queryCacheShared).toHaveBeenCalledTimes(1);
    expect(authShared).toHaveBeenCalledTimes(1);
    expect(use.mock.calls).toEqual(expect.arrayContaining([
      ['effects-plugin'],
      ['i18n-plugin'],
      ['query-cache-shared-plugin'],
      ['auth-shared-plugin'],
    ]));
    expect(build).toHaveBeenCalledTimes(1);
    expect(module.mfeApp).toBe(expectedApp);

    // The effects initializer is wrapped rather than passed straight through:
    // `registerSlice` hands it only a dispatch, and the write path needs the app
    // to invalidate the shared cache after the form may already be unmounted.
    expect(registerSlice).toHaveBeenCalledWith({ name: 'connections/connect' }, expect.any(Function));
    const initEffects = registerSlice.mock.calls[0]?.[1] as (dispatch: unknown) => void;
    const dispatch = vi.fn();
    initEffects(dispatch);
    expect(initConnectEffects).toHaveBeenCalledWith(dispatch, expectedApp);
  });
});
