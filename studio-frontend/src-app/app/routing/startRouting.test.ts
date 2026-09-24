import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontXApp, ScreenExtension } from '@gears-frontx/react';

const { SCREEN_DOMAIN, mocks } = vi.hoisted(() => ({
  SCREEN_DOMAIN: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
  mocks: { mounted: [] as string[], mountScreen: vi.fn(), isMountingScreen: vi.fn(() => false), publish: vi.fn() },
}));
vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  screenDomain: { id: SCREEN_DOMAIN },
}));
vi.mock('@/app/mfe/mountScreen', () => ({ mountScreen: mocks.mountScreen, isMountingScreen: mocks.isMountingScreen }));
vi.mock('@/app/mfe/sharedContext', () => ({ publishStudioContext: mocks.publish }));

import { freshNavigationHistory } from '@frontx-test-utils/memoryNavigationHistory';
import { screen } from '@frontx-test-utils/screenFixture';
import reducer, { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { startRouting } from './startRouting';

const screens = [
  screen('org.overview', '/organization/overview', 'organization', { section: 'overview', order: 10 }),
  screen('people', '/people', 'organization', { order: 30 }),
  screen('projects.main', '/projects', 'workspace', { order: 20 }),
  screen('projects.overview', '/projects/overview', 'project', { section: 'overview', order: 10 }),
  screen('projects.artifacts', '/projects/artifacts', 'project', { section: 'artifacts', order: 20 }),
];
const ORG = { id: 'o1', name: 'Org' };
const WS = { id: 'w1', name: 'Work' };
const ATLAS = { id: 'p1', name: 'Atlas' };
const ready: Partial<AppContextState> = { org: ORG, orgs: [ORG], access: 'ready', workspace: WS, workspaces: [WS], workspacesStatus: 'ready', projects: [ATLAS] };

function fakeApp(initial: Partial<AppContextState>) {
  let state: AppContextState = { ...reducer(undefined, { type: '@@init' }), ...initial };
  const app = {
    store: { dispatch: (action: unknown) => { state = reducer(state, action as never); }, getState: () => ({ [APP_CONTEXT_SLICE_KEY]: state }) },
    mfeRegistry: { getExtensionsForDomain: () => screens, getMountedExtensions: () => mocks.mounted },
  } as unknown as FrontXApp;
  return { app, state: () => state };
}
const catalogs = () => ({ loadOrganizations: vi.fn(), loadWorkspaces: vi.fn(), loadProjects: vi.fn(), resolveProject: vi.fn() });

beforeEach(() => {
  mocks.mounted = [];
  mocks.mountScreen.mockImplementation(async (_r: unknown, ext: ScreenExtension) => { mocks.mounted = [ext.id]; });
  mocks.isMountingScreen.mockReturnValue(false);
});
afterEach(() => vi.clearAllMocks());

describe('startRouting', () => {
  it('applies a deep link with its first, synchronous report', () => {
    const { history } = freshNavigationHistory('/?screen=projects;org=o1;workspace=w1;project=p1;section=artifacts');
    const { app, state } = fakeApp(ready);
    startRouting(app, catalogs(), history);
    expect(mocks.mountScreen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'projects.main' }));
    expect(state().project).toEqual(ATLAS);
    expect(state().section).toBe('artifacts');
  });

  it('opens the organization entry point on an empty address and writes it with replace', () => {
    const { history, adapter } = freshNavigationHistory('/');
    const { app } = fakeApp(ready);
    startRouting(app, catalogs(), history);
    expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview');
    expect(adapter.length()).toBe(1);
  });

  it('follows a navigate, and Back brings the previous state back', async () => {
    const { history, adapter } = freshNavigationHistory('/?screen=projects;org=o1;workspace=w1');
    const { app, state } = fakeApp(ready);
    const handle = startRouting(app, catalogs(), history);
    await vi.waitFor(() => expect(mocks.mounted).toEqual(['projects.main']));

    handle.navigation.navigate({ token: 'projects', org: 'o1', workspace: 'w1', project: 'p1' }, 'push');
    expect(state().project).toEqual(ATLAS);
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1;project=p1;section=overview');
    expect(adapter.length()).toBe(2);

    history.go(-1);
    await adapter.settle();
    expect(state().project).toBeNull();
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1');
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);
  });

  it('switches screens on Back, across a level', async () => {
    const { history, adapter } = freshNavigationHistory('/?screen=people;org=o1');
    const { app } = fakeApp(ready);
    const handle = startRouting(app, catalogs(), history);
    await vi.waitFor(() => expect(mocks.mounted).toEqual(['people']));
    handle.navigation.navigate({ token: 'projects', org: 'o1', workspace: 'w1' }, 'push');
    await vi.waitFor(() => expect(mocks.mounted).toEqual(['projects.main']));
    history.go(-1);
    await adapter.settle();
    await vi.waitFor(() => expect(mocks.mounted).toEqual(['people']));
  });

  // Review Focus 2
  it('applies the entry a Back landed on after an in-flight mount finishes', async () => {
    const { history, adapter } = freshNavigationHistory('/?screen=people;org=o1');
    const { app } = fakeApp(ready);
    let landProjects!: () => void;
    mocks.mountScreen.mockImplementation((_r: unknown, ext: ScreenExtension) =>
      ext.id === 'projects.main'
        ? new Promise<void>((resolve) => { landProjects = () => { mocks.mounted = [ext.id]; resolve(); }; })
        : Promise.resolve().then(() => { mocks.mounted = [ext.id]; })
    );
    const handle = startRouting(app, catalogs(), history);
    await vi.waitFor(() => expect(mocks.mounted).toEqual(['people']));

    handle.navigation.navigate({ token: 'projects', org: 'o1', workspace: 'w1' }, 'push');
    mocks.isMountingScreen.mockReturnValue(true);
    history.go(-1);
    await adapter.settle();
    expect(mocks.mounted).toEqual(['people']);

    mocks.isMountingScreen.mockReturnValue(false);
    landProjects();
    await vi.waitFor(() => expect(mocks.mounted).toEqual(['people']));
    expect(mocks.mountScreen).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ id: 'people' }));
  });

  it('stops listening once released', () => {
    const { history } = freshNavigationHistory('/?screen=people;org=o1');
    const { app, state } = fakeApp(ready);
    const handle = startRouting(app, catalogs(), history);
    handle.release();
    handle.navigation.navigate({ token: 'projects', org: 'o1', workspace: 'w1', project: 'p1' }, 'push');
    expect(state().project).toBeNull();
  });
});
