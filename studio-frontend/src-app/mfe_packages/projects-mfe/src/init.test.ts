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

vi.mock('./api/ArtifactIngestApiService', () => ({
  ArtifactIngestApiService: class ArtifactIngestApiService {},
}));

vi.mock('./api/DocumentsApiService', () => ({
  DocumentsApiService: class DocumentsApiService {},
}));

vi.mock('./api/SpecQualityApiService', () => ({
  SpecQualityApiService: class SpecQualityApiService {},
}));

// These gears' clients are shared with the other MFEs now; `init.ts` imports
// them from the package, and nothing else in this test's graph pulls the
// package at runtime (the wire types are type-only imports and erase).
vi.mock('@constructor-studio/mfe-shared', () => ({
  AccountsApiService: class AccountsApiService {},
  ConnectorsApiService: class ConnectorsApiService {},
  StudioTasksApiService: class StudioTasksApiService {},
  StudioEventsApiService: class StudioEventsApiService {},
}));

vi.mock('./slices/navSlice', () => ({
  navSlice: { name: 'projects/nav' },
}));

vi.mock('./slices/specsFilterSlice', () => ({
  specsFilterSlice: { name: 'projects/specsFilter' },
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

vi.mock('./slices/sourcesConnectSlice', () => ({
  sourcesConnectSlice: { name: 'projects/sources-connect' },
}));

vi.mock('./slices/typeDecisionSlice', () => ({
  typeDecisionSlice: { name: 'projects/typeDecision' },
}));

vi.mock('./slices/specsCheckSlice', () => ({
  specsCheckSlice: { name: 'projects/specsCheck' },
}));

vi.mock('./slices/documentUploadSlice', () => ({
  documentUploadSlice: { name: 'projects/documentUpload' },
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

vi.mock('./effects/sourcesConnectEffects', () => ({
  initSourcesConnectEffects: vi.fn(),
}));

vi.mock('./effects/typeDecisionEffects', () => ({
  initTypeDecisionEffects: vi.fn(),
}));

vi.mock('./effects/specsCheckEffects', () => ({
  initSpecsCheckEffects: vi.fn(),
}));

vi.mock('./effects/documentUploadEffects', () => ({
  initDocumentUploadEffects: vi.fn(),
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

    const { initWorkspaceEffects } = await import('./effects/workspaceEffects');
    const { initSpecsCheckEffects } = await import('./effects/specsCheckEffects');
    const module = await import('./init');

    // Seven gears: account-management, studio-connector, studio-artifact-ingest,
    // studio-tasks (the run each repository's sync is), studio-events (the
    // stream those runs are announced on), studio-documents (the journey-stage
    // catalogue the create wizard reads, and the project's specs) and
    // studio-spec-quality (whether those specs can be checked).
    expect(register).toHaveBeenCalledTimes(7);
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
    // No effects initializer: this MFE has no local intents left to turn into
    // `projects/nav` — the shell's properties are what write it.
    expect(registerSlice).toHaveBeenCalledWith({ name: 'projects/nav' });
    expect(registerSlice).toHaveBeenCalledWith({ name: 'projects/specsFilter' });
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
    // Connect source's slice, for the fourth entry; its effect writes the config.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/sources-connect' },
      expect.any(Function)
    );
    // The Specs list's type decisions; the effect drops cached counts on the app.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/typeDecision' },
      expect.any(Function)
    );
    // Check's runs; the effect needs only the dispatch.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/specsCheck' },
      initSpecsCheckEffects
    );
    // Upload documents; the effect invalidates the documents read on the app.
    expect(registerSlice).toHaveBeenCalledWith(
      { name: 'projects/documentUpload' },
      expect.any(Function)
    );
    expect(module.mfeApp).toBe(expectedApp);
  });
});
