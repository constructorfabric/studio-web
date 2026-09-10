import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FrontXApp } from '@gears-frontx/react';

type BusHandler = (payload?: unknown) => void | Promise<void>;

const { SCREEN_DOMAIN, listeners, mockEmit, mockHas, mockMountScreen, mockIsMounting } =
  vi.hoisted(() => ({
  SCREEN_DOMAIN: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
  listeners: new Map<string, ((payload?: unknown) => void | Promise<void>)[]>(),
  mockEmit: vi.fn(),
  mockHas: vi.fn(),
  mockMountScreen: vi.fn(),
  mockIsMounting: vi.fn((_registry: unknown) => false),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: {
    on: vi.fn((eventName: string, handler: BusHandler) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), handler]);
      return () => listeners.delete(eventName);
    }),
    emit: mockEmit,
  },
  apiRegistry: { has: mockHas, getService: vi.fn() },
  screenDomain: { id: SCREEN_DOMAIN },
}));

vi.mock('@/app/mfe/mountScreen', () => ({
  mountScreen: mockMountScreen,
  isMountingScreen: mockIsMounting,
}));

const publishes = vi.hoisted(() => ({
  project: vi.fn(),
  section: vi.fn(),
  organization: vi.fn(),
  workspace: vi.fn(),
}));

vi.mock('@/app/mfe/sharedContext', () => ({
  publishSelectedProject: publishes.project,
  publishSelectedSection: publishes.section,
  publishSelectedOrganization: publishes.organization,
  publishSelectedWorkspace: publishes.workspace,
}));

import { registerAppContextEffects } from './appContextEffects';
import { closeContextProject, openContextProject, setContextSection } from '@/app/slices/appContextSlice';

/** The project rail: two sections of one entry, plus a screen of its own. */
const overview = {
  id: 'ext.project.overview',
  entry: 'entry.projects',
  presentation: { label: 'Overview', level: 'project', section: 'overview' },
};
const artifacts = {
  id: 'ext.project.artifacts',
  entry: 'entry.projects',
  presentation: { label: 'Artifacts', level: 'project', section: 'artifacts' },
};
const people = {
  id: 'ext.people',
  entry: 'entry.people',
  presentation: { label: 'People', level: 'organization', order: 10 },
};

const OPEN_PROJECT = { id: 'p1', name: 'Atlas' };

async function emit(eventName: string, payload?: unknown): Promise<void> {
  await Promise.all((listeners.get(eventName) ?? []).map((h) => h(payload)));
}

describe('entering a screen', () => {
  const dispatch = vi.fn();
  const state = {
    'app/context': { project: OPEN_PROJECT, section: 'artifacts' } as Record<string, unknown>,
  };
  const mfeRegistry = {
    getExtensionsForDomain: vi.fn(() => [overview, artifacts, people]),
    // The registry answers with ids, not extensions.
    getMountedExtensions: vi.fn(() => [overview.id]),
  };
  const app = {
    store: { dispatch, getState: () => state },
    mfeRegistry,
  } as unknown as FrontXApp;

  beforeEach(() => {
    mockHas.mockReturnValue(false);
    mockIsMounting.mockReturnValue(false);
    mockMountScreen.mockResolvedValue(undefined);
    state['app/context'] = { project: OPEN_PROJECT, section: 'artifacts' };
    registerAppContextEffects(app);
  });

  afterEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });

  it('moves the section instead of mounting, when the entry is already on screen', async () => {
    await emit('app/context/screen/requested', { extensionId: 'ext.project.artifacts' });

    expect(mockMountScreen).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith('app/context/project/section', {
      section: 'artifacts',
    });
  });

  it('leaves the project scope and mounts, when the entry is another one', async () => {
    await emit('app/context/screen/requested', { extensionId: 'ext.people' });

    expect(dispatch).toHaveBeenCalledWith(closeContextProject());
    expect(mockMountScreen).toHaveBeenCalledWith(mfeRegistry, people);
  });

  it('puts the project and its section back when the mount fails', async () => {
    mockMountScreen.mockRejectedValue(new Error('no such entry'));

    await emit('app/context/screen/requested', { extensionId: 'ext.people' });
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(openContextProject(OPEN_PROJECT))
    );
    expect(dispatch).toHaveBeenCalledWith(setContextSection('artifacts'));
  });

  // The guard itself lives in `mountScreen`; what matters here is that the
  // context is not cleared for a mount that is going to be dropped.
  it('clears nothing when a mount is already running', async () => {
    mockIsMounting.mockReturnValue(true);

    await emit('app/context/screen/requested', { extensionId: 'ext.people' });

    expect(dispatch).not.toHaveBeenCalled();
    expect(mockMountScreen).not.toHaveBeenCalled();
  });

  it('does not close the project when the level requested is the project itself', async () => {
    await emit('app/context/level/requested', { level: 'project' });

    expect(dispatch).not.toHaveBeenCalledWith(closeContextProject());
  });

  describe('picking a project in the switcher', () => {
    beforeEach(() => {
      state['app/context'] = {
        project: OPEN_PROJECT,
        section: 'artifacts',
        projects: [OPEN_PROJECT, { id: 'p2', name: 'Borealis' }],
      };
    });

    it('opens another project at the first item of its rail', async () => {
      await emit('app/context/project/changed', { projectId: 'p2' });

      expect(dispatch).toHaveBeenCalledWith(openContextProject({ id: 'p2', name: 'Borealis' }));
    });

    // The regression: re-picking the open project threw the member back to the
    // rail's first item, discarding the section they were reading.
    it('keeps the section when the project picked is the one already open', async () => {
      await emit('app/context/project/changed', { projectId: OPEN_PROJECT.id });

      expect(dispatch).not.toHaveBeenCalled();
      expect(publishes.section).not.toHaveBeenCalled();
    });
  });

  // The rule the workspace read already follows: an answer that belongs to a
  // scope the session has left is dropped, not applied to the current one.
  describe('announcements from a scope that has been left', () => {
    beforeEach(() => {
      state['app/context'] = {
        org: { id: 'org-1', name: 'Fabric' },
        workspace: { id: 'ws-1', name: 'Platform' },
        project: OPEN_PROJECT,
        section: 'artifacts',
      };
    });

    it('drops a workspace created under an organization since switched away from', async () => {
      await emit('app/context/workspace/created', {
        id: 'ws-9',
        name: 'Late',
        organizationId: 'org-OLD',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('keeps a workspace created under the organization still in scope', async () => {
      await emit('app/context/workspace/created', {
        id: 'ws-9',
        name: 'Fresh',
        organizationId: 'org-1',
      });

      expect(dispatch).toHaveBeenCalled();
    });

    it('drops a workspace picked on a screen listing another organization', async () => {
      await emit('app/context/workspace/changed', {
        workspaceId: 'ws-9',
        name: 'Late',
        organizationId: 'org-OLD',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('drops a project announced from a workspace since left', async () => {
      await emit('app/context/project/opened', {
        id: 'p9',
        name: 'Late',
        workspaceId: 'ws-OLD',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('keeps a project announced from the workspace still in scope', async () => {
      await emit('app/context/project/opened', {
        id: 'p9',
        name: 'Fresh',
        workspaceId: 'ws-1',
      });

      expect(dispatch).toHaveBeenCalledWith(openContextProject({ id: 'p9', name: 'Fresh' }));
    });

    // The shell's own top-bar slots announce without naming a scope. An
    // unclaimed scope is not a mismatched one.
    it('accepts an announcement that names no scope at all', async () => {
      await emit('app/context/workspace/changed', { workspaceId: 'ws-2' });

      expect(dispatch).toHaveBeenCalled();
    });
  });

  it('leaves the project alone when the level has no screen to enter', async () => {
    mfeRegistry.getExtensionsForDomain.mockReturnValueOnce([]);

    await emit('app/context/level/requested', { level: 'organization' });

    expect(dispatch).not.toHaveBeenCalledWith(closeContextProject());
    expect(mockMountScreen).not.toHaveBeenCalled();
  });
});
