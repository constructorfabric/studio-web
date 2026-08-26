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
}));

vi.mock('./api/AccountsApiService', () => ({
  AccountsApiService: class AccountsApiService {},
}));

vi.mock('./api/ConnectorsApiService', () => ({
  ConnectorsApiService: class ConnectorsApiService {},
}));

vi.mock('./slices/navSlice', () => ({
  navSlice: { name: 'projects/nav' },
}));

vi.mock('./slices/createSlice', () => ({
  createWizardSlice: { name: 'projects/create' },
}));

vi.mock('./effects/projectsEffects', () => ({
  initProjectsEffects: vi.fn(),
}));

vi.mock('./effects/wizardEffects', () => ({
  initWizardEffects: vi.fn(),
}));

describe('projects-mfe init', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    use.mockImplementation(() => ({ use, build }));
    build.mockReturnValue({ id: 'projects-mfe-app' });
  });

  it('registers both api services before build and both slices after it', async () => {
    use.mockImplementation(() => ({ use, build }));
    const expectedApp = { id: 'projects-mfe-app' };
    build.mockReturnValue(expectedApp);

    const { initProjectsEffects } = await import('./effects/projectsEffects');
    const { initWizardEffects } = await import('./effects/wizardEffects');
    const module = await import('./init');

    // Two gears: account-management and studio-connector.
    expect(register).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(createFrontX).toHaveBeenCalledTimes(1);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(queryCacheShared).toHaveBeenCalledTimes(1);
    expect(authShared).toHaveBeenCalledTimes(1);
    expect(i18n).toHaveBeenCalledTimes(1);
    expect(use.mock.calls).toEqual(
      expect.arrayContaining([
        ['effects-plugin'],
        ['i18n-plugin'],
        ['query-cache-shared-plugin'],
        ['auth-shared-plugin'],
      ])
    );
    expect(build).toHaveBeenCalledTimes(1);
    expect(registerSlice).toHaveBeenCalledWith({ name: 'projects/nav' }, initProjectsEffects);
    // The wizard's slice must exist before the overlay entry mounts, and that
    // entry does not run this module a second time. Its effect carries the two
    // writes, so it is registered on the same schedule.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/create' },
      initWizardEffects
    );
    expect(module.mfeApp).toBe(expectedApp);
  });
});
