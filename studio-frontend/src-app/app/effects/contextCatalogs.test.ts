import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontXApp } from '@gears-frontx/react';

const { mockEmit, mockHas, mockGetService } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockHas: vi.fn(),
  mockGetService: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: { on: vi.fn(), emit: mockEmit },
  apiRegistry: { has: mockHas, getService: mockGetService },
}));

import { AccountsApiService, TENANT_TYPES } from '@constructor-studio/mfe-shared';
import { IdentityApiService, PLATFORM_ROOT_TENANT_ID } from '@/app/api';
import {
  setContextAccess,
  setContextOrganizations,
  setContextProjects,
  setContextWorkspaces,
  setContextWorkspacesStatus,
} from '@/app/slices/appContextSlice';
import { createContextCatalogs } from './contextCatalogs';

const tenant = (id: string, name: string, tenant_type: string, parent_id: string | null = null) => ({
  id, name, tenant_type, parent_id, child_count: 0,
});

describe('createContextCatalogs', () => {
  const dispatch = vi.fn();
  const state: { 'app/context': Record<string, unknown> } = { 'app/context': {} };
  const app = { store: { dispatch, getState: () => state } } as unknown as FrontXApp;
  const onChange = vi.fn();
  const accounts = {
    getMe: { fetch: vi.fn() },
    getTenant: vi.fn(),
    getChildren: vi.fn(),
    getWorkspaces: vi.fn(),
    getProjects: vi.fn(),
  };
  const identity = { myMemberships: { fetch: vi.fn() } };

  beforeEach(() => {
    state['app/context'] = { org: { id: 'o1', name: 'Org' }, workspace: { id: 'w1', name: 'W' } };
    mockHas.mockReturnValue(true);
    mockGetService.mockImplementation((service: unknown) =>
      service === AccountsApiService ? accounts : service === IdentityApiService ? identity : undefined
    );
  });
  afterEach(() => vi.clearAllMocks());

  it("lists a member's organizations from memberships and tells the caller", async () => {
    accounts.getMe.fetch.mockResolvedValue({ subject_tenant_id: 'home' });
    identity.myMemberships.fetch.mockResolvedValue({ items: [{ org_id: 'o1' }, { org_id: 'o2' }] });
    accounts.getTenant.mockImplementation(({ tenantId }: { tenantId: string }) => ({
      fetch: () =>
        tenantId === 'o2'
          ? Promise.reject(new Error('404'))
          : Promise.resolve(tenant('o1', 'Org', TENANT_TYPES.organization)),
    }));
    accounts.getWorkspaces.mockReturnValue({ fetch: () => Promise.resolve({ items: [] }) });

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).toHaveBeenCalledWith(
      setContextOrganizations({ current: { id: 'o1', name: 'Org', count: 0 }, items: [{ id: 'o1', name: 'Org', count: 0 }] })
    );
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('ready'));
    expect(onChange).toHaveBeenCalled();
  });

  it("walks the root's children for the platform administrator", async () => {
    accounts.getMe.fetch.mockResolvedValue({ subject_tenant_id: PLATFORM_ROOT_TENANT_ID });
    accounts.getChildren.mockReturnValue({
      fetch: () => Promise.resolve({ items: [tenant('o1', 'Org', TENANT_TYPES.organization), tenant('x', 'Not', 'workspace')] }),
    });
    accounts.getWorkspaces.mockReturnValue({ fetch: () => Promise.resolve({ items: [] }) });

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).toHaveBeenCalledWith(
      setContextOrganizations({ current: { id: 'o1', name: 'Org', count: 0 }, items: [{ id: 'o1', name: 'Org', count: 0 }] })
    );
    expect(identity.myMemberships.fetch).not.toHaveBeenCalled();
  });

  it('drops a workspace list that arrives for an organization since left', async () => {
    let resolve!: (value: unknown) => void;
    accounts.getWorkspaces.mockReturnValue({ fetch: () => new Promise((r) => { resolve = r; }) });
    const catalogs = createContextCatalogs(app, onChange);

    catalogs.loadWorkspaces('o1');
    state['app/context'] = { org: { id: 'o2', name: 'Other' } };
    resolve({ items: [tenant('w1', 'W', 'workspace')] });
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledWith(setContextWorkspacesStatus('pending'));
    expect(dispatch).not.toHaveBeenCalledWith(setContextWorkspaces([{ id: 'w1', name: 'W', count: 0 }]));
  });

  it('loads one workspace list at a time for the same organization', () => {
    accounts.getWorkspaces.mockReturnValue({ fetch: () => new Promise(() => undefined) });
    const catalogs = createContextCatalogs(app, onChange);
    catalogs.loadWorkspaces('o1');
    catalogs.loadWorkspaces('o1');
    expect(accounts.getWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('lists the projects of the workspace in scope and tells the caller', async () => {
    accounts.getProjects.mockReturnValue({
      fetch: () => Promise.resolve({ items: [tenant('p1', 'Atlas', 'project', 'w1')] }),
    });
    const catalogs = createContextCatalogs(app, onChange);
    catalogs.loadProjects('w1');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(setContextProjects([{ id: 'p1', name: 'Atlas', count: 0 }])));
    expect(accounts.getProjects).toHaveBeenCalledWith({ parentId: 'w1' });
    expect(onChange).toHaveBeenCalled();
  });

  it('answers null for a project it cannot read', async () => {
    accounts.getTenant.mockReturnValue({ fetch: () => Promise.reject(new Error('403')) });
    await expect(createContextCatalogs(app, onChange).resolveProject('p9')).resolves.toBeNull();
  });
});
