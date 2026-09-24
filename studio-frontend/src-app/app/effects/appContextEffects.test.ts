import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontXApp } from '@gears-frontx/react';

type BusHandler = (payload?: unknown) => void | Promise<void>;

const { SCREEN_DOMAIN, listeners, mockEmit, handle, catalogs, mockStartRouting } = vi.hoisted(() => {
  const handle = {
    navigation: { currentRoute: vi.fn(), navigate: vi.fn() },
    groups: vi.fn(),
    materialize: vi.fn(),
    retry: vi.fn(),
    release: vi.fn(),
  };
  const catalogs = { loadOrganizations: vi.fn(), loadWorkspaces: vi.fn(), loadProjects: vi.fn(), resolveProject: vi.fn() };
  return {
    SCREEN_DOMAIN: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
    listeners: new Map<string, BusHandler[]>(),
    mockEmit: vi.fn(),
    handle,
    catalogs,
    mockStartRouting: vi.fn(() => handle),
  };
});

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: {
    on: vi.fn((eventName: string, handler: BusHandler) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), handler]);
      return () => listeners.delete(eventName);
    }),
    emit: mockEmit,
  },
  screenDomain: { id: SCREEN_DOMAIN },
}));
vi.mock('@/app/routing/startRouting', () => ({ startRouting: mockStartRouting }));
vi.mock('@/app/effects/contextCatalogs', () => ({ createContextCatalogs: vi.fn(() => catalogs) }));

import { screen } from '@frontx-test-utils/screenFixture';
import { groupScreens } from '@/app/routing/screenTokens';
import {
  addContextWorkspace,
  rememberProject,
  setContextProjects,
  setContextWorkspace,
} from '@/app/slices/appContextSlice';
import { registerAppContextEffects } from './appContextEffects';

const screens = [
  screen('org.overview', '/organization/overview', 'organization', { section: 'overview', order: 10 }),
  screen('org.workspaces', '/organization/workspaces', 'organization', { section: 'workspaces', order: 20 }),
  screen('people', '/people', 'organization', { order: 30 }),
  screen('projects.main', '/projects', 'workspace', { order: 20 }),
  screen('projects.overview', '/projects/overview', 'project', { section: 'overview', order: 10 }),
  screen('projects.artifacts', '/projects/artifacts', 'project', { section: 'artifacts', order: 20 }),
];

async function emit(eventName: string, payload?: unknown): Promise<void> {
  await Promise.all((listeners.get(eventName) ?? []).map((h) => h(payload)));
}

const IN_PROJECT = { token: 'projects', org: 'o1', workspace: 'w1', project: 'p1', section: 'overview' };

describe('registerAppContextEffects', () => {
  const dispatch = vi.fn();
  const state: { 'app/context': Record<string, unknown> } = { 'app/context': {} };
  const app = {
    store: { dispatch, getState: () => state },
    mfeRegistry: { getExtensionsForDomain: vi.fn(() => screens) },
  } as unknown as FrontXApp;

  beforeEach(async () => {
    state['app/context'] = {
      org: { id: 'o1', name: 'Org' }, orgs: [{ id: 'o1', name: 'Org' }],
      workspace: { id: 'w1', name: 'W' }, workspaces: [{ id: 'w1', name: 'W' }], workspacesStatus: 'ready',
      project: null, projects: [], section: null,
    };
    handle.groups.mockReturnValue(groupScreens(screens));
    handle.navigation.currentRoute.mockReturnValue(IN_PROJECT);
    registerAppContextEffects(app);
    await emit('app/routing/start');
  });

  afterEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });

  it('starts routing once the slot is attached, and only retries the address after that', async () => {
    expect(mockStartRouting).toHaveBeenCalledTimes(1);
    await emit('app/routing/start');
    expect(mockStartRouting).toHaveBeenCalledTimes(1);
    expect(handle.retry).toHaveBeenCalledTimes(1);
    expect(handle.materialize).not.toHaveBeenCalled();
  });

  it('loads the organizations when the context is asked for', async () => {
    await emit('app/context/fetch');
    expect(catalogs.loadOrganizations).toHaveBeenCalled();
  });

  it('a rail click on an organization-level screen navigates with the organization only', async () => {
    await emit('app/context/screen/requested', { extensionId: 'people' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'people', org: 'o1' }, 'push');
  });

  it('a rail click on a project section keeps the project and names the section', async () => {
    await emit('app/context/screen/requested', { extensionId: 'projects.artifacts' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith(
      { token: 'projects', org: 'o1', workspace: 'w1', project: 'p1', section: 'artifacts' }, 'push'
    );
  });

  it('entering the workspace level drops the project', async () => {
    await emit('app/context/level/requested', { level: 'workspace' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'projects', org: 'o1', workspace: 'w1' }, 'push');
  });

  it('entering the project level without a project does nothing', async () => {
    handle.navigation.currentRoute.mockReturnValue({ token: 'projects', org: 'o1', workspace: 'w1' });
    state['app/context'].project = null;
    await emit('app/context/level/requested', { level: 'project' });
    expect(handle.navigation.navigate).not.toHaveBeenCalled();
  });

  it('switching organization from a deeper level goes to the organization entry point', async () => {
    await emit('app/context/org/changed', { orgId: 'o2' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'organization', org: 'o2' }, 'push');
  });

  it('switching organization on an organization-level screen keeps the screen and its section', async () => {
    handle.navigation.currentRoute.mockReturnValue({ token: 'organization', org: 'o1', section: 'workspaces' });
    await emit('app/context/org/changed', { orgId: 'o2' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'organization', org: 'o2', section: 'workspaces' }, 'push');
  });

  it('picking the same organization again only retries a failed workspace list', async () => {
    state['app/context'].workspacesStatus = 'failed';
    await emit('app/context/org/changed', { orgId: 'o1' });
    expect(catalogs.loadWorkspaces).toHaveBeenCalledWith('o1');
    expect(handle.navigation.navigate).not.toHaveBeenCalled();
  });

  it('a workspace picked with enter goes to the workspace entry point, remembering its name', async () => {
    await emit('app/context/workspace/changed', { workspaceId: 'w2', name: 'Two', enter: true });
    expect(dispatch).toHaveBeenCalledWith(addContextWorkspace({ id: 'w2', name: 'Two' }));
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'projects', org: 'o1', workspace: 'w2' }, 'push');
  });

  it('a workspace picked at the organization level is a preference, not a navigation', async () => {
    handle.navigation.currentRoute.mockReturnValue({ token: 'people', org: 'o1' });
    await emit('app/context/workspace/changed', { workspaceId: 'w2' });
    expect(dispatch).toHaveBeenCalledWith(setContextWorkspace('w2'));
    expect(handle.materialize).toHaveBeenCalled();
    expect(handle.navigation.navigate).not.toHaveBeenCalled();
  });

  // Reviewer finding (vasylcf): the chain's own workspace pick below the
  // organization — no `enter`, no name — had no test.
  it('a workspace picked in the chain below the organization keeps the screen and leaves the project', async () => {
    await emit('app/context/workspace/changed', { workspaceId: 'w2' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'projects', org: 'o1', workspace: 'w2' }, 'push');
    expect(dispatch).not.toHaveBeenCalled();
    expect(handle.materialize).not.toHaveBeenCalled();
  });

  it('drops a workspace announced for an organization since left', async () => {
    await emit('app/context/workspace/changed', { workspaceId: 'w2', organizationId: 'o9', enter: true });
    expect(handle.navigation.navigate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Reviewer finding (vasylcf): the created-workspace handler branches on the
  // level, and the old suite's two cases for it were not carried over.
  it('a workspace created at the organization level joins the list as the preference, without navigating', async () => {
    handle.navigation.currentRoute.mockReturnValue({ token: 'organization', org: 'o1', section: 'workspaces' });
    await emit('app/context/workspace/created', { id: 'w2', name: 'Two', organizationId: 'o1' });
    expect(dispatch).toHaveBeenCalledWith(addContextWorkspace({ id: 'w2', name: 'Two' }));
    expect(handle.materialize).toHaveBeenCalled();
    expect(handle.navigation.navigate).not.toHaveBeenCalled();
  });

  it('a workspace created below the organization is entered on the current screen, leaving the project', async () => {
    await emit('app/context/workspace/created', { id: 'w2', name: 'Two', organizationId: 'o1' });
    expect(dispatch).toHaveBeenCalledWith(addContextWorkspace({ id: 'w2', name: 'Two' }));
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'projects', org: 'o1', workspace: 'w2' }, 'push');
  });

  it('drops a workspace created under an organization since left', async () => {
    await emit('app/context/workspace/created', { id: 'w2', name: 'Two', organizationId: 'o9' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(handle.navigation.navigate).not.toHaveBeenCalled();
    expect(handle.materialize).not.toHaveBeenCalled();
  });

  it('an opened project is remembered, then navigated to', async () => {
    handle.navigation.currentRoute.mockReturnValue({ token: 'projects', org: 'o1', workspace: 'w1' });
    await emit('app/context/project/opened', { id: 'p1', name: 'Atlas', workspaceId: 'w1' });
    expect(dispatch).toHaveBeenCalledWith(rememberProject({ id: 'p1', name: 'Atlas' }));
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'projects', org: 'o1', workspace: 'w1', project: 'p1' }, 'push');
  });

  it('keeps the sibling list only for the workspace in scope', async () => {
    await emit('app/context/projects', { items: [{ id: 'p2', name: 'B' }], workspaceId: 'w1' });
    expect(dispatch).toHaveBeenCalledWith(setContextProjects([{ id: 'p2', name: 'B' }]));
    dispatch.mockClear();
    await emit('app/context/projects', { items: [{ id: 'p3', name: 'C' }], workspaceId: 'w9' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('closing the project navigates back to the workspace', async () => {
    await emit('app/context/project/closed');
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'projects', org: 'o1', workspace: 'w1' }, 'push');
  });

  it('a section the MFE moved to is written with replace', async () => {
    await emit('app/context/project/section', { section: 'artifacts' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ ...IN_PROJECT, section: 'artifacts' }, 'replace');
  });

  it('picking the open project again does nothing', async () => {
    await emit('app/context/project/changed', { projectId: 'p1' });
    expect(handle.navigation.navigate).not.toHaveBeenCalled();
  });

  it('picking another project navigates to it', async () => {
    await emit('app/context/project/changed', { projectId: 'p2' });
    expect(handle.navigation.navigate).toHaveBeenCalledWith({ token: 'projects', org: 'o1', workspace: 'w1', project: 'p2' }, 'push');
  });
});
