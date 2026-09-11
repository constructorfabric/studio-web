import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FrontXApp } from '@gears-frontx/react';

type BusHandler = (payload?: unknown) => void | Promise<void>;

const {
  SCREEN_DOMAIN,
  listeners,
  mockEmit,
  mockHas,
  mockGetService,
  mockMountScreen,
  mockIsMounting,
} = vi.hoisted(() => ({
  SCREEN_DOMAIN: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
  listeners: new Map<string, ((payload?: unknown) => void | Promise<void>)[]>(),
  mockEmit: vi.fn(),
  mockHas: vi.fn(),
  mockGetService: vi.fn(),
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
  apiRegistry: { has: mockHas, getService: mockGetService },
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

import { AccountsApiService, TENANT_TYPES } from '@constructor-studio/mfe-shared';
import { IdentityApiService, PLATFORM_ROOT_TENANT_ID } from '@/app/api';
import { registerAppContextEffects } from './appContextEffects';
import {
  closeContextProject,
  openContextProject,
  setContextAccess,
  setContextOrganizations,
  setContextSection,
} from '@/app/slices/appContextSlice';

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
    // Written, not announced: the shell is the one deciding here, and a shell
    // talking to itself through the bus is how the decision arrives late.
    expect(dispatch).toHaveBeenCalledWith(setContextSection('artifacts'));
    expect(publishes.section).toHaveBeenCalled();
  });

  it('names the section when the item is picked, not when the mount resolves', async () => {
    mockMountScreen.mockReturnValue(new Promise<void>(() => undefined));

    await emit('app/context/level/requested', { level: 'project' });

    expect(mockMountScreen).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(setContextSection('overview'));
  });

  // The race the emit in `mountScreen` used to lose: an earlier mount whose lock
  // was released lands after a later navigation has already moved the section.
  // Nothing is left to overwrite it, because the mount names no section.
  it('leaves the section with the later navigation when an earlier mount lands after it', async () => {
    let landLate = (): void => undefined;
    mockMountScreen.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        landLate = resolve;
      })
    );

    // Another entry, so it mounts — and hangs.
    await emit('app/context/screen/requested', { extensionId: 'ext.people' });
    expect(dispatch).toHaveBeenLastCalledWith(setContextSection(null));

    // The entry already on screen, so this one only moves the section.
    await emit('app/context/screen/requested', { extensionId: 'ext.project.artifacts' });
    expect(dispatch).toHaveBeenLastCalledWith(setContextSection('artifacts'));

    landLate();
    await Promise.resolve();
    expect(dispatch).toHaveBeenLastCalledWith(setContextSection('artifacts'));
  });

  // Reachable by hand: open a project, then click a rail item of the screen you
  // are leaving before the project's screen lands. The relay would name a
  // section of the old entry, and the screen that arrives is of another one —
  // a rail with no active item at all, since no item of the new entry carries
  // that token.
  it('ignores a section click while a mount is still running', async () => {
    mockIsMounting.mockReturnValue(true);

    await emit('app/context/screen/requested', { extensionId: 'ext.project.artifacts' });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('puts the section back when a mount that left no project fails', async () => {
    mockMountScreen.mockRejectedValue(new Error('no such entry'));

    await emit('app/context/level/requested', { level: 'project' });

    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(setContextSection('artifacts'))
    );
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

    it('drops the sibling list announced from a workspace since left', async () => {
      await emit('app/context/projects', {
        items: [{ id: 'p9', name: 'Late' }],
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

/**
 * Where the top bar's organization list comes from.
 *
 * The rule under test: membership decides which organizations an ordinary person
 * may act in (ADR-0011 §2), while the home tenant on the token decides only
 * whether the caller is the platform administrator. Getting this wrong is
 * expensive in both directions — read the home tenant as membership and everyone
 * gains access to the whole tree, read the platform root's own membership as an
 * organization and every administrator loses their list — so both paths are
 * pinned here.
 */
describe('the organization list', () => {
  const dispatch = vi.fn();
  const app = {
    store: { dispatch, getState: () => ({}) },
  } as unknown as FrontXApp;

  const ORG_A = '00000000-0000-0000-0000-0000000000a1';
  const ORG_B = '00000000-0000-0000-0000-0000000000b2';

  function tenant(id: string, name: string, type: string = TENANT_TYPES.organization) {
    return { id, name, tenant_type: type };
  }

  /** `query(...)` / `queryWith(...)` endpoints both end in `.fetch()`. */
  function endpoint<T>(value: T) {
    return { fetch: vi.fn().mockResolvedValue(value) };
  }

  /** Wire the two services the handler reaches for. */
  function services(options: {
    homeTenantId?: string;
    memberships?: { org_id: string; role: string }[];
    tenants?: Record<string, ReturnType<typeof tenant>>;
    children?: ReturnType<typeof tenant>[];
  }) {
    const accounts = {
      getMe: endpoint({ subject_id: 'who', subject_tenant_id: options.homeTenantId }),
      getTenant: vi.fn(({ tenantId }: { tenantId: string }) => {
        const found = options.tenants?.[tenantId];
        return found
          ? endpoint(found)
          : { fetch: vi.fn().mockRejectedValue(new Error('404')) };
      }),
      getChildren: vi.fn(() => endpoint({ items: options.children ?? [] })),
      getWorkspaces: vi.fn(() => endpoint({ items: [] })),
    };
    const identity = {
      myMemberships: endpoint({
        items: (options.memberships ?? []).map((m) => ({
          user_id: 'who',
          source: 'assignment',
          ...m,
        })),
      }),
    };
    mockGetService.mockImplementation((service: unknown) => {
      if (service === IdentityApiService) return identity;
      if (service === AccountsApiService) return accounts;
      return {};
    });
    return { accounts, identity };
  }

  function organizationsDispatched() {
    const call = dispatch.mock.calls.find(
      ([action]) => action?.type === setContextOrganizations({ current: null, items: [] }).type
    );
    return call?.[0]?.payload as { current: unknown; items: { id: string }[] } | undefined;
  }

  beforeEach(() => {
    registerAppContextEffects(app);
    mockHas.mockReturnValue(true);
  });

  afterEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });

  it('is the memberships of an ordinary person, not their home tenant', async () => {
    const { accounts, identity } = services({
      homeTenantId: ORG_A,
      memberships: [{ org_id: ORG_B, role: 'member' }],
      tenants: { [ORG_B]: tenant(ORG_B, 'Second Org') },
    });

    await emit('app/context/fetch');

    expect(identity.myMemberships.fetch).toHaveBeenCalled();
    // The home tenant is NOT consulted for the list: only the membership is.
    expect(accounts.getChildren).not.toHaveBeenCalled();
    expect(organizationsDispatched()?.items.map((o) => o.id)).toEqual([ORG_B]);
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('ready'));
  });

  it('is the tree under the root for a platform administrator, whose access is not a membership', async () => {
    const { accounts, identity } = services({
      homeTenantId: PLATFORM_ROOT_TENANT_ID,
      children: [
        tenant(ORG_A, 'First Org'),
        tenant(ORG_B, 'Second Org'),
        // A workspace under the root must never reach the organization switcher.
        tenant('00000000-0000-0000-0000-0000000000c3', 'A Workspace', TENANT_TYPES.workspace),
      ],
    });

    await emit('app/context/fetch');

    expect(accounts.getChildren).toHaveBeenCalledWith({ tenantId: PLATFORM_ROOT_TENANT_ID });
    expect(identity.myMemberships.fetch).not.toHaveBeenCalled();
    expect(organizationsDispatched()?.items.map((o) => o.id)).toEqual([ORG_A, ORG_B]);
  });

  it('reports no access when a person is a member of nothing', async () => {
    services({ homeTenantId: ORG_A, memberships: [] });

    await emit('app/context/fetch');

    expect(organizationsDispatched()?.items).toEqual([]);
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('unassigned'));
  });

  it('drops an organization whose tenant cannot be read rather than showing it nameless', async () => {
    // From outside a self-managed organization's subtree the backend answers 404
    // by design. That is isolation working, and the rest of the list must survive.
    services({
      homeTenantId: ORG_A,
      memberships: [
        { org_id: ORG_A, role: 'owner' },
        { org_id: ORG_B, role: 'member' },
      ],
      tenants: { [ORG_A]: tenant(ORG_A, 'Readable Org') },
    });

    await emit('app/context/fetch');

    expect(organizationsDispatched()?.items.map((o) => o.id)).toEqual([ORG_A]);
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('ready'));
  });

  it('does not show the onboarding screen when the resolve merely failed', async () => {
    // A transient failure is not the same as having no organization: somebody
    // with access must not be told they have none because a request timed out.
    mockGetService.mockImplementation(() => ({
      getMe: { fetch: vi.fn().mockRejectedValue(new Error('network')) },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await emit('app/context/fetch');

    expect(dispatch).not.toHaveBeenCalledWith(setContextAccess('unassigned'));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
