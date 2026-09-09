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
const queryCacheShared = vi.fn(() => 'query-cache-shared-plugin');
const authShared = vi.fn(() => 'auth-shared-plugin');
const i18n = vi.fn(() => 'i18n-plugin');

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
  authShared,
  // The accounts client extends the kit's base service; the module is imported
  // for real by init.ts, so the mock has to carry these.
  BaseApiService: class BaseApiServiceStub {
    protocol() {
      return { queryWith: () => () => undefined };
    }
  },
  RestProtocol: class RestProtocolStub {},
  RestEndpointProtocol: class RestEndpointProtocolStub {},
}));

vi.mock('./api/_BlankApiService', () => ({
  _BlankApiService: class BlankApiService {
    static {
      void 0;
    }
  },
}));

vi.mock('./slices/homeSlice', () => ({
  homeSlice: { name: '_blank/home' },
}));

vi.mock('./effects/homeEffects', () => ({
  initHomeEffects: vi.fn(),
}));

describe('organization-mfe init', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    use.mockImplementation(() => ({ use, build }));
    build.mockReturnValue({ id: 'blank-mfe-app' });
  });

  it('registers services before build and registers slices after build', async () => {
    use.mockImplementation(() => ({ use, build }));
    const expectedApp = { id: 'blank-mfe-app' };
    build.mockReturnValue(expectedApp);

    const { initHomeEffects } = await import('./effects/homeEffects');
    const module = await import('./init');

    // Two services now: the scaffold's and the accounts client this MFE reads
    // the organization's workspaces with.
    expect(register).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(createFrontX).toHaveBeenCalledTimes(1);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(queryCacheShared).toHaveBeenCalledTimes(1);
    // No mock map: this MFE talks to a real gear, so it needs the host's
    // bearer instead — see the composition in init.ts.
    expect(authShared).toHaveBeenCalledTimes(1);
    expect(i18n).toHaveBeenCalledTimes(1);
    expect(use.mock.calls).toEqual(expect.arrayContaining([
      ['effects-plugin'],
      ['i18n-plugin'],
      ['query-cache-shared-plugin'],
      ['auth-shared-plugin'],
    ]));
    expect(build).toHaveBeenCalledTimes(1);
    expect(registerSlice).toHaveBeenCalledWith({ name: '_blank/home' }, initHomeEffects);
    expect(module.mfeApp).toBe(expectedApp);
  });
});
