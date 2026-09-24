import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontXApp, ScreenExtension } from '@gears-frontx/react';

const { SCREEN_DOMAIN, mocks } = vi.hoisted(() => ({
  SCREEN_DOMAIN: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
  mocks: {
    mounted: [] as string[],
    mountScreen: vi.fn(),
    isMountingScreen: vi.fn(() => false),
    publish: vi.fn(),
  },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  screenDomain: { id: SCREEN_DOMAIN },
}));
vi.mock('@/app/mfe/mountScreen', () => ({
  mountScreen: mocks.mountScreen,
  isMountingScreen: mocks.isMountingScreen,
}));
vi.mock('@/app/mfe/sharedContext', () => ({ publishStudioContext: mocks.publish }));

import { freshNavigationHistory } from '@frontx-test-utils/memoryNavigationHistory';
import reducer, { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { createShellNavigation } from './navigation';
import { groupScreens } from './screenTokens';
import { createMaterializer } from './materialize';

const screen = (id: string, route: string, level: string, extra: Record<string, unknown> = {}): ScreenExtension =>
  ({ id, entry: `entry.${route.split('/')[1]}`, presentation: { label: id, route, level, ...extra } }) as never;

const screens = [
  screen('org.overview', '/organization/overview', 'organization', { section: 'overview', order: 10 }),
  screen('org.workspaces', '/organization/workspaces', 'organization', { section: 'workspaces', order: 20 }),
  screen('people', '/people', 'organization', { order: 30 }),
  screen('projects.main', '/projects', 'workspace', { order: 20 }),
  screen('projects.overview', '/projects/overview', 'project', { section: 'overview', order: 10 }),
  screen('projects.artifacts', '/projects/artifacts', 'project', { section: 'artifacts', order: 20 }),
];
const groups = groupScreens(screens);

const ORG = { id: 'o1', name: 'Org' };
const WS = { id: 'w1', name: 'Work' };
const ATLAS = { id: 'p1', name: 'Atlas' };

function fakeApp(initial: Partial<AppContextState>) {
  let state: AppContextState = { ...reducer(undefined, { type: '@@init' }), ...initial };
  const registry = {
    getExtensionsForDomain: () => screens,
    getMountedExtensions: () => mocks.mounted,
  };
  const app = {
    store: {
      dispatch: (action: unknown) => { state = reducer(state, action as never); },
      getState: () => ({ [APP_CONTEXT_SLICE_KEY]: state }),
    },
    mfeRegistry: registry,
  } as unknown as FrontXApp;
  return { app, state: () => state };
}

function setup(url: string, initial: Partial<AppContextState>) {
  const { history, adapter } = freshNavigationHistory(url);
  const navigation = createShellNavigation(history);
  const { app, state } = fakeApp(initial);
  const catalogs = {
    loadOrganizations: vi.fn(),
    loadWorkspaces: vi.fn(),
    loadProjects: vi.fn(),
    resolveProject: vi.fn(),
  };
  const warn = vi.fn();
  const { materialize } = createMaterializer({ app, navigation, groups: () => groups, catalogs, warn });
  return { materialize, adapter, state, catalogs, warn, navigation };
}

const ready = { org: ORG, orgs: [ORG], access: 'ready' as const, workspace: WS, workspaces: [WS], workspacesStatus: 'ready' as const };

beforeEach(() => {
  mocks.mounted = [];
  mocks.mountScreen.mockImplementation(async (_registry: unknown, ext: ScreenExtension) => { mocks.mounted = [ext.id]; });
  mocks.isMountingScreen.mockReturnValue(false);
});
afterEach(() => vi.clearAllMocks());

describe('materialize', () => {
  it("opens the organization level's entry point on an empty address, written once with replace", () => {
    const { materialize, adapter } = setup('/', ready);
    materialize();
    expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview');
    expect(adapter.length()).toBe(1);
    expect(mocks.mountScreen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'org.overview' }));
  });

  // Review Focus 5
  it('fills the default organization once and then stays quiet', () => {
    const { materialize, adapter } = setup('/?screen=people', ready);
    const writes = vi.spyOn(adapter, 'replaceState');
    materialize();
    expect(adapter.url()).toBe('/?screen=people;org=o1');
    materialize();
    materialize();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(adapter.length()).toBe(1);
  });

  it("mounts the group's owner and opens the cached project at its section", () => {
    const { materialize, state } = setup('/?screen=projects;org=o1;workspace=w1;project=p1;section=artifacts', {
      ...ready, projects: [ATLAS],
    });
    materialize();
    expect(mocks.mountScreen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'projects.main' }));
    expect(state().project).toEqual(ATLAS);
    expect(state().section).toBe('artifacts');
    expect(mocks.publish).toHaveBeenCalled();
  });

  it('waits for the workspace list before opening the project, then opens it', () => {
    const { materialize, state, catalogs, adapter } = setup('/?screen=projects;org=o1;workspace=w1;project=p1', {
      ...ready, workspace: null, workspaces: [], workspacesStatus: 'pending', projects: [ATLAS],
    });
    materialize();
    expect(catalogs.loadWorkspaces).toHaveBeenCalledWith('o1');
    expect(state().project).toBeNull();
    // The project stays in the address while the list is on its way.
    expect(adapter.url()).toContain('project=p1');
    // Mount does not wait for a catalog.
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);
  });

  it('asks for a project it does not know, and closes it when the tenant is elsewhere', async () => {
    const { materialize, adapter, catalogs, state } = setup('/?screen=projects;org=o1;workspace=w1;project=p9;section=overview', ready);
    catalogs.resolveProject.mockResolvedValue({ id: 'p9', name: 'Nine', parent_id: 'w-other' });
    materialize();
    expect(state().project).toEqual({ id: 'p9', name: '' });
    await vi.waitFor(() => expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1'));
    expect(adapter.length()).toBe(1);
  });

  // Review Focus 1
  it('accepts a project whose parent is the organization', async () => {
    const { materialize, catalogs, state } = setup('/?screen=projects;org=o1;workspace=w1;project=p9', ready);
    catalogs.resolveProject.mockResolvedValue({ id: 'p9', name: 'Nine', parent_id: 'o1' });
    materialize();
    await vi.waitFor(() => expect(state().project).toEqual({ id: 'p9', name: 'Nine' }));
  });

  it('lists the workspace\'s projects for the switcher when it knows none', () => {
    const { materialize, catalogs } = setup('/?screen=projects;org=o1;workspace=w1;project=p1', { ...ready, projects: [] });
    catalogs.resolveProject.mockReturnValue(new Promise(() => undefined));
    materialize();
    expect(catalogs.loadProjects).toHaveBeenCalledWith('w1');
  });

  it("drops an organization that is not the person's and keeps the first", () => {
    const { materialize, adapter, warn } = setup('/?screen=people;org=stranger', ready);
    materialize();
    expect(adapter.url()).toBe('/?screen=people;org=o1');
    expect(adapter.length()).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('drops a workspace not in the list, and the project with it', () => {
    const { materialize, adapter, state } = setup('/?screen=projects;org=o1;workspace=w9;project=p1', { ...ready, projects: [ATLAS] });
    materialize();
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1');
    expect(state().project).toBeNull();
  });

  it('refuses an unknown token and lands on the organization entry point', () => {
    const { materialize, adapter, warn } = setup('/?screen=nowhere;org=o1', ready);
    materialize();
    expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview');
    expect(warn).toHaveBeenCalled();
  });

  // Review Focus 4
  it('does nothing for a person with no organization', () => {
    const { materialize, adapter } = setup('/?screen=projects;org=o1;workspace=w1', { ...ready, orgs: [], org: null, access: 'unassigned' });
    materialize();
    expect(mocks.mountScreen).not.toHaveBeenCalled();
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1');
  });

  it('closes the project when the address no longer names one', () => {
    mocks.mounted = ['projects.main'];
    const { materialize, state } = setup('/?screen=projects;org=o1;workspace=w1', { ...ready, project: ATLAS, projects: [ATLAS], section: 'artifacts' });
    materialize();
    expect(state().project).toBeNull();
    expect(state().section).toBeNull();
    expect(mocks.mountScreen).not.toHaveBeenCalled();
  });

  it('does not carry a workspace on an organization-level screen', () => {
    const { materialize, adapter } = setup('/?screen=people;org=o1;workspace=w1', ready);
    materialize();
    expect(adapter.url()).toBe('/?screen=people;org=o1');
  });

  it('replaces an invalid section with the level\'s first one', () => {
    const { materialize, adapter } = setup('/?screen=organization;org=o1;section=bogus', ready);
    materialize();
    expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview');
  });

  it("falls back to the level's entry point once when the mount fails", async () => {
    mocks.mountScreen
      .mockRejectedValueOnce(new Error('no such entry'))
      .mockRejectedValueOnce(new Error('still no'));
    const { materialize, adapter, warn } = setup('/?screen=people;org=o1', ready);
    materialize();
    await vi.waitFor(() => expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview'));
    await vi.waitFor(() => expect(mocks.mountScreen).toHaveBeenCalledTimes(2));
    expect(adapter.length()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not call mountScreen while one is running', () => {
    mocks.isMountingScreen.mockReturnValue(true);
    const { materialize } = setup('/?screen=people;org=o1', ready);
    materialize();
    expect(mocks.mountScreen).not.toHaveBeenCalled();
  });
});
