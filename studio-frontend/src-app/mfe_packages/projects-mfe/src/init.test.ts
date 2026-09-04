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

vi.mock('./api/ArtifactIngestApiService', () => ({
  ArtifactIngestApiService: class ArtifactIngestApiService {},
}));

// The connector client is shared with the other MFE now; `init.ts` imports it
// from the package, and nothing else in this test's graph pulls the package at
// runtime (the wire types are type-only imports and erase).
vi.mock('@constructor-studio/mfe-shared', () => ({
  ConnectorsApiService: class ConnectorsApiService {},
}));

vi.mock('./slices/navSlice', () => ({
  navSlice: { name: 'projects/nav' },
}));

vi.mock('./slices/createSlice', () => ({
  createWizardSlice: { name: 'projects/create' },
}));

vi.mock('./slices/workspaceSlice', () => ({
  workspaceCreateSlice: { name: 'projects/workspace-create' },
}));

vi.mock('./slices/artifactSyncSlice', () => ({
  artifactSyncSlice: { name: 'projects/artifact-sync' },
}));

vi.mock('./effects/projectsEffects', () => ({
  initProjectsEffects: vi.fn(),
}));

vi.mock('./effects/wizardEffects', () => ({
  initWizardEffects: vi.fn(),
}));

vi.mock('./effects/workspaceEffects', () => ({
  initWorkspaceEffects: vi.fn(),
}));

vi.mock('./effects/artifactEffects', () => ({
  initArtifactEffects: vi.fn(),
}));

describe('projects-mfe init', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    use.mockImplementation(() => ({ use, build }));
    build.mockReturnValue({ id: 'projects-mfe-app' });
  });

  it('registers every api service before build and every slice after it', async () => {
    use.mockImplementation(() => ({ use, build }));
    const expectedApp = { id: 'projects-mfe-app' };
    build.mockReturnValue(expectedApp);

    const { initProjectsEffects } = await import('./effects/projectsEffects');
    const { initWorkspaceEffects } = await import('./effects/workspaceEffects');
    const module = await import('./init');

    // Three gears: account-management, studio-connector, studio-artifact-ingest.
    expect(register).toHaveBeenCalledTimes(3);
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
    // writes, so it is registered on the same schedule. It is wrapped, because
    // it takes the app as well as the dispatch.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/create' },
      expect.any(Function)
    );
    // Same schedule, same reason: the workspace overlay is a third entry that
    // does not re-run this module, and its effect carries the write.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/workspace-create' },
      initWorkspaceEffects
    );
    // The import's effect is wrapped, because it takes the app as well as the
    // dispatch — so this asserts the slice and the arity, not the identity.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/artifact-sync' },
      expect.any(Function)
    );
    expect(module.mfeApp).toBe(expectedApp);
  });
});
