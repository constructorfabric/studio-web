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
import { screen } from '@frontx-test-utils/screenFixture';
import reducer, {
  APP_CONTEXT_SLICE_KEY,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  type AppContextState,
} from '@/app/slices/appContextSlice';
import { createShellNavigation } from './navigation';
import { groupScreens } from './screenTokens';
import { TENANT_TYPES } from '@constructor-studio/mfe-shared';
import { createMaterializer } from './materialize';

const screens = [
  screen('org.overview', '/organization/overview', 'organization', { section: 'overview', order: 10 }),
  screen('org.workspaces', '/organization/workspaces', 'organization', { section: 'workspaces', order: 20 }),
  screen('people', '/people', 'organization', { order: 30 }),
  screen('gears', '/gears', 'organization', { order: 40 }),
  screen('projects.main', '/projects', 'workspace', { order: 20 }),
  screen('projects.overview', '/projects/overview', 'project', { section: 'overview', order: 10 }),
  screen('projects.artifacts', '/projects/artifacts', 'project', { section: 'artifacts', order: 20 }),
];
const groups = groupScreens(screens);

const ORG = { id: 'o1', name: 'Org' };
const WS = { id: 'w1', name: 'Work' };
const WS2 = { id: 'w2', name: 'Other' };
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
  const { materialize, transition, retry } = createMaterializer({ app, navigation, groups: () => groups, catalogs, warn });
  // `transition` stands in for the observer's report: in production every
  // `navigate` below would be followed by it.
  return { materialize, transition, retry, adapter, state, catalogs, warn, navigation, app };
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

  // Reviewer finding (vasylcf, round 8): since the reducer picks nothing, this
  // fallback is the only thing that chooses the first organization at a cold start.
  it('picks the first organization at a cold start, once the list is known and nothing is in scope yet', () => {
    const { materialize, adapter, state } = setup('/?screen=people', { orgs: [ORG], org: null, access: 'ready' });
    materialize();
    expect(adapter.url()).toBe('/?screen=people;org=o1');
    expect(state().org).toEqual(ORG);
    expect(adapter.length()).toBe(1);
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

  // Reviewer finding (vasylcf, round 8): a link naming the project alone lost it
  // on the first pass — the project step was gated on a workspace the pending
  // list could not yet default.
  it('keeps a project named without a workspace while the list is pending, and opens it once the list is ready', async () => {
    const { materialize, adapter, state, catalogs, app } = setup('/?screen=projects;org=o1;project=p1', {
      ...ready, workspace: null, workspaces: [], workspacesStatus: 'pending',
    });
    catalogs.resolveProject.mockResolvedValue({ id: 'p1', name: 'Atlas', tenant_type: TENANT_TYPES.project, parent_id: 'w1' });
    materialize();
    expect(adapter.url()).toContain('project=p1');
    expect(state().project).toBeNull();
    expect(catalogs.resolveProject).not.toHaveBeenCalled();

    app.store.dispatch(setContextWorkspaces([WS]));
    app.store.dispatch(setContextWorkspacesStatus('ready'));
    materialize();
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1;project=p1;section=overview');
    await vi.waitFor(() => expect(state().project).toEqual(ATLAS));
    expect(adapter.length()).toBe(1);
  });

  it("moves the address to the project's own workspace when the tenant says it lives in another one of the organization", async () => {
    const { materialize, adapter, state, catalogs } = setup('/?screen=projects;org=o1;workspace=w1;project=p9', {
      ...ready, workspaces: [WS, WS2],
    });
    catalogs.resolveProject.mockResolvedValue({ id: 'p9', name: 'Nine', tenant_type: TENANT_TYPES.project, parent_id: 'w2' });
    materialize();
    await vi.waitFor(() => expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w2;project=p9;section=overview'));
    expect(state().workspace).toEqual(WS2);
    await vi.waitFor(() => expect(state().project).toEqual({ id: 'p9', name: 'Nine' }));
    expect(adapter.length()).toBe(1);
  });

  it('asks for a project it does not know, and closes it when the tenant is elsewhere', async () => {
    const { materialize, adapter, catalogs, state } = setup('/?screen=projects;org=o1;workspace=w1;project=p9;section=overview', ready);
    catalogs.resolveProject.mockResolvedValue({ id: 'p9', name: 'Nine', tenant_type: TENANT_TYPES.project, parent_id: 'w-other' });
    materialize();
    expect(state().project).toEqual({ id: 'p9', name: '' });
    await vi.waitFor(() => expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1'));
    expect(adapter.length()).toBe(1);
  });

  // Reviewer finding (coderabbit): a read that failed used to close the project
  // and overwrite the pasted link, with nothing left to retry from.
  it('keeps a project in the address when its read merely failed, and asks again on the next pass', async () => {
    const { materialize, adapter, catalogs, state, warn } = setup('/?screen=projects;org=o1;workspace=w1;project=p9;section=overview', ready);
    catalogs.resolveProject.mockResolvedValue('unavailable');
    materialize();
    expect(catalogs.resolveProject).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1;project=p9;section=overview');
    expect(state().project).toEqual({ id: 'p9', name: '' });
    expect(warn).not.toHaveBeenCalled();
    const asked = catalogs.resolveProject.mock.calls.length;
    materialize();
    expect(catalogs.resolveProject).toHaveBeenCalledTimes(asked + 1);
  });

  // Reviewer finding (coderabbit): the same project id asked for under one
  // workspace and answered under another must not be judged by the old scope.
  it('judges a lookup by the scope that is current when it lands, not the one it was asked in', async () => {
    const { materialize, transition, adapter, catalogs, state, navigation } = setup(
      '/?screen=projects;org=o1;workspace=w1;project=p9',
      { ...ready, workspaces: [WS, WS2] }
    );
    const nine = { id: 'p9', name: 'Nine', tenant_type: TENANT_TYPES.project, parent_id: 'w1' };
    let first!: (tenant: unknown) => void;
    let second!: (tenant: unknown) => void;
    catalogs.resolveProject
      .mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { second = resolve; }))
      .mockResolvedValue(nine);
    materialize();
    expect(catalogs.resolveProject).toHaveBeenCalledTimes(1);

    navigation.navigate({ token: 'projects', org: 'o1', workspace: 'w2', project: 'p9' }, 'push');
    transition();
    expect(state().workspace).toEqual(WS2);
    first(nine);

    // The stale answer is not applied under w2 — no name, no move — and the pass for w2 asks again.
    await vi.waitFor(() => expect(catalogs.resolveProject).toHaveBeenCalledTimes(2));
    expect(state().project).toEqual({ id: 'p9', name: '' });
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w2;project=p9;section=overview');

    // That answer says p9 lives under w1, another workspace of the organization:
    // the address moves to the project's workspace rather than refusing it.
    second(nine);
    await vi.waitFor(() => expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1;project=p9;section=overview'));
    await vi.waitFor(() => expect(state().project).toEqual({ id: 'p9', name: 'Nine' }));
  });

  // Review Focus 1
  it('accepts a project whose parent is the organization', async () => {
    const { materialize, catalogs, state } = setup('/?screen=projects;org=o1;workspace=w1;project=p9', ready);
    catalogs.resolveProject.mockResolvedValue({ id: 'p9', name: 'Nine', tenant_type: TENANT_TYPES.project, parent_id: 'o1' });
    materialize();
    await vi.waitFor(() => expect(state().project).toEqual({ id: 'p9', name: 'Nine' }));
  });

  it('lists the workspace\'s projects for the switcher when it knows none', () => {
    const { materialize, catalogs } = setup('/?screen=projects;org=o1;workspace=w1;project=p1', { ...ready, projects: [] });
    catalogs.resolveProject.mockReturnValue(new Promise(() => undefined));
    materialize();
    expect(catalogs.loadProjects).toHaveBeenCalledWith('w1');
  });

  // Reviewer finding (vasylcf): an empty list was asked for again on every pass.
  it('does not ask for the projects list again once it has been read or has failed', () => {
    for (const projectsStatus of ['ready', 'failed'] as const) {
      const { materialize, catalogs } = setup('/?screen=projects;org=o1;workspace=w1;project=p1', { ...ready, projects: [], projectsStatus });
      catalogs.resolveProject.mockReturnValue(new Promise(() => undefined));
      materialize();
      expect(catalogs.loadProjects).not.toHaveBeenCalled();
    }
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

  // Reviewer finding (MarinaLitueva): the default used to be the reducer's pick.
  it('fills the workspace preference from the list at the organization level, without writing it to the address', () => {
    const { materialize, adapter, state } = setup('/?screen=people;org=o1', { ...ready, workspace: null });
    materialize();
    expect(state().workspace).toEqual(WS);
    expect(adapter.url()).toBe('/?screen=people;org=o1');
    expect(mocks.publish).toHaveBeenCalled();
  });

  // Reviewer finding (vasylcf): the organization-level twin of the branch above had no test.
  it('closes the project when an organization-level screen is opened over it', () => {
    const { materialize, state } = setup('/?screen=people;org=o1', { ...ready, project: ATLAS, projects: [ATLAS], section: 'artifacts' });
    materialize();
    expect(state().project).toBeNull();
    expect(state().section).toBeNull();
    expect(mocks.mountScreen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'people' }));
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

  // Reviewer finding: the registry logs a failed chain and resolves — it never rejects.
  it('stops after one fallback when the chain resolves without mounting', async () => {
    mocks.mountScreen.mockImplementation(async () => undefined);
    const { materialize, transition, adapter, warn, navigation } = setup('/?screen=people;org=o1', ready);
    materialize();
    await vi.waitFor(() => expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview'));
    await vi.waitFor(() => expect(mocks.mountScreen).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Catalog arrivals re-run the pass without a transition: nothing is tried again.
    materialize();
    materialize();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.mountScreen).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(adapter.length()).toBe(1);

    // A new address is a new chance.
    navigation.navigate({ token: 'projects', org: 'o1', workspace: 'w1' }, 'push');
    transition();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(3);
  });

  // Reviewer finding (vasylcf): the guard against a second fallback was one flag
  // for the whole session, so after an entry point failed once no later failure
  // anywhere was fallen back from.
  it('falls back once per address: a later failure elsewhere gets its own fallback', async () => {
    mocks.mountScreen.mockImplementation(async () => undefined);
    const { materialize, transition, adapter, warn, navigation } = setup('/?screen=people;org=o1', ready);
    materialize();
    await vi.waitFor(() => expect(mocks.mountScreen).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview');
    expect(warn).toHaveBeenCalledTimes(2);

    navigation.navigate({ token: 'gears', org: 'o1' }, 'push');
    transition();
    await vi.waitFor(() => expect(mocks.mountScreen).toHaveBeenCalledTimes(4));
    expect(mocks.mountScreen.mock.calls[2][1]).toMatchObject({ id: 'gears' });
    expect(mocks.mountScreen.mock.calls[3][1]).toMatchObject({ id: 'org.overview' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.url()).toBe('/?screen=organization;org=o1;section=overview');
    expect(adapter.length()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('a failure about an address since left re-applies the current one instead of replacing it', async () => {
    let finish!: () => void;
    mocks.mountScreen.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { materialize, transition, adapter, navigation } = setup('/?screen=people;org=o1', ready);
    materialize();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);

    mocks.isMountingScreen.mockReturnValue(true);
    navigation.navigate({ token: 'gears', org: 'o1' }, 'push');
    transition();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);

    mocks.isMountingScreen.mockReturnValue(false);
    finish();
    await vi.waitFor(() => expect(mocks.mountScreen).toHaveBeenCalledTimes(2));
    expect(mocks.mountScreen.mock.calls[1][1]).toMatchObject({ id: 'gears' });
    expect(adapter.url()).toBe('/?screen=gears;org=o1');
    expect(adapter.length()).toBe(2);
  });

  // Reviewer finding (vasylcf, round 3): the stuck guard was keyed by a hash of
  // the route, which a quick there-and-back reproduces — the abandoned attempt
  // then looked like a failure of the current visit and blocked the address.
  it('a mount abandoned by a quick there-and-back gets a fresh attempt when it settles as a failure', async () => {
    let finish!: () => void;
    mocks.mountScreen.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { materialize, transition, adapter, navigation } = setup('/?screen=people;org=o1', ready);
    materialize();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);

    mocks.isMountingScreen.mockReturnValue(true);
    navigation.navigate({ token: 'gears', org: 'o1' }, 'push');
    transition();
    navigation.navigate({ token: 'people', org: 'o1' }, 'push');
    transition();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);

    mocks.isMountingScreen.mockReturnValue(false);
    finish();
    await vi.waitFor(() => expect(mocks.mountScreen).toHaveBeenCalledTimes(2));
    expect(mocks.mountScreen.mock.calls[1][1]).toMatchObject({ id: 'people' });
    await vi.waitFor(() => expect(mocks.mounted).toEqual(['people']));
    expect(adapter.url()).toBe('/?screen=people;org=o1');
  });

  // Reviewer finding (vasylcf, round 2): a failure about an address since left
  // must not mark that address stuck for a later return to it.
  it('a failure about an address since left does not block a later return to it', async () => {
    mocks.mounted = ['gears'];
    let finish!: () => void;
    mocks.mountScreen.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { materialize, transition, navigation } = setup('/?screen=people;org=o1', ready);
    materialize();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);

    mocks.isMountingScreen.mockReturnValue(true);
    navigation.navigate({ token: 'gears', org: 'o1' }, 'push');
    transition();
    mocks.isMountingScreen.mockReturnValue(false);
    // The chain failed before it evicted gears: nothing to mount for the current address.
    finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.mountScreen).toHaveBeenCalledTimes(1);

    navigation.navigate({ token: 'people', org: 'o1' }, 'push');
    transition();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(2);
    expect(mocks.mountScreen.mock.calls[1][1]).toMatchObject({ id: 'people' });
  });

  it('does not treat a superseded mount as a failure while another one is running', async () => {
    mocks.mountScreen.mockImplementation(async () => {
      mocks.isMountingScreen.mockReturnValue(true);
    });
    const { materialize, adapter, warn } = setup('/?screen=people;org=o1', ready);
    materialize();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warn).not.toHaveBeenCalled();
    expect(adapter.url()).toBe('/?screen=people;org=o1');
  });

  it('retries a stuck screen when asked to, once the slot is attached again', async () => {
    mocks.mountScreen.mockImplementation(async () => undefined);
    const { materialize, retry } = setup('/?screen=people;org=o1', ready);
    materialize();
    await vi.waitFor(() => expect(mocks.mountScreen).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    mocks.mountScreen.mockImplementation(async (_registry: unknown, ext: ScreenExtension) => { mocks.mounted = [ext.id]; });
    retry();
    expect(mocks.mountScreen).toHaveBeenCalledTimes(3);
    expect(mocks.mounted).toEqual(['org.overview']);
  });

  // Reviewer finding: every workspace's parent is the organization too.
  it('refuses a tenant that is not a project, even under the organization', async () => {
    const { materialize, adapter, catalogs } = setup('/?screen=projects;org=o1;workspace=w1;project=w1', ready);
    catalogs.resolveProject.mockResolvedValue({ id: 'w1', name: 'Work', tenant_type: TENANT_TYPES.workspace, parent_id: 'o1' });
    materialize();
    await vi.waitFor(() => expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1'));
  });

  // Reviewer finding: before this branch an organization change always loaded its
  // workspaces; an organization-level screen must not leave the list pending.
  it('loads the workspaces of the organization in scope on an organization-level screen too', () => {
    const { materialize, catalogs } = setup('/?screen=people;org=o1', {
      ...ready, workspace: null, workspaces: [], workspacesStatus: 'pending',
    });
    materialize();
    expect(catalogs.loadWorkspaces).toHaveBeenCalledWith('o1');
  });
});
