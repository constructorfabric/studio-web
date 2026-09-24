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
  setContextProjectsStatus,
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
          ? Promise.reject(Object.assign(new Error('Not Found'), { response: { status: 404 } }))
          : Promise.resolve(tenant('o1', 'Org', TENANT_TYPES.organization)),
    }));
    accounts.getWorkspaces.mockReturnValue({ fetch: () => Promise.resolve({ items: [] }) });

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).toHaveBeenCalledWith(setContextOrganizations([{ id: 'o1', name: 'Org', count: 0 }]));
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('ready'));
    expect(onChange).toHaveBeenCalled();
  });

  // Reviewer finding (coderabbit): a membership whose read failed for any
  // other reason was dropped like a refused one — a deep link to it was lost,
  // and a person whose reads all failed was shown the onboarding screen.
  it('does not drop a membership, or report no access, when its read merely failed', async () => {
    accounts.getMe.fetch.mockResolvedValue({ subject_tenant_id: 'home' });
    identity.myMemberships.fetch.mockResolvedValue({ items: [{ org_id: 'o1' }, { org_id: 'o2' }] });
    accounts.getTenant.mockImplementation(({ tenantId }: { tenantId: string }) => ({
      fetch: () =>
        tenantId === 'o2'
          ? Promise.reject(new Error('502'))
          : Promise.resolve(tenant('o1', 'Org', TENANT_TYPES.organization)),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).not.toHaveBeenCalledWith(setContextAccess('unassigned'));
    expect(dispatch.mock.calls.some(([action]) => action.type === setContextOrganizations([]).type)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("walks the root's children for the platform administrator", async () => {
    accounts.getMe.fetch.mockResolvedValue({ subject_tenant_id: PLATFORM_ROOT_TENANT_ID });
    accounts.getChildren.mockReturnValue({
      fetch: () => Promise.resolve({ items: [tenant('o1', 'Org', TENANT_TYPES.organization), tenant('x', 'Not', 'workspace')] }),
    });
    accounts.getWorkspaces.mockReturnValue({ fetch: () => Promise.resolve({ items: [] }) });

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).toHaveBeenCalledWith(setContextOrganizations([{ id: 'o1', name: 'Org', count: 0 }]));
    expect(identity.myMemberships.fetch).not.toHaveBeenCalled();
  });

  // Reviewer finding (vasylcf): the old suite pinned the difference between
  // "member of nothing" and "the resolve failed"; both cases come back here.
  it('reports no access when a person is a member of nothing', async () => {
    accounts.getMe.fetch.mockResolvedValue({ subject_tenant_id: 'home' });
    identity.myMemberships.fetch.mockResolvedValue({ items: [] });

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).toHaveBeenCalledWith(setContextOrganizations([]));
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('unassigned'));
  });

  // Reviewer finding (vasylcf): the platform administrator's path swallowed its
  // failure into an empty list, which read as "member of nothing".
  it("does not report no access when the platform administrator's list merely failed", async () => {
    accounts.getMe.fetch.mockResolvedValue({ subject_tenant_id: PLATFORM_ROOT_TENANT_ID });
    accounts.getChildren.mockReturnValue({ fetch: () => Promise.reject(new Error('502')) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).not.toHaveBeenCalledWith(setContextAccess('unassigned'));
    expect(dispatch).not.toHaveBeenCalledWith(setContextOrganizations([]));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not report no access when the resolve merely failed', async () => {
    accounts.getMe.fetch.mockRejectedValue(new Error('network'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(dispatch).not.toHaveBeenCalledWith(setContextAccess('unassigned'));
    expect(dispatch).not.toHaveBeenCalledWith(setContextAccess('ready'));
    expect(onChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

  // Reviewer finding (vasylcf): the loop-breaker on the retry had no test.
  it('asks for one retry when the workspace read fails, and none when the retry fails too', async () => {
    accounts.getWorkspaces.mockReturnValue({ fetch: () => Promise.reject(new Error('down')) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalogs = createContextCatalogs(app, onChange);

    catalogs.loadWorkspaces('o1');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(setContextWorkspacesStatus('failed')));
    expect(mockEmit).toHaveBeenCalledWith('app/context/workspaces/failed');
    expect(onChange).toHaveBeenCalledTimes(1);

    mockEmit.mockClear();
    catalogs.loadWorkspaces('o1', true);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(mockEmit).not.toHaveBeenCalled();
    warn.mockRestore();
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

  // Reviewer finding (vasylcf): a failed projects read must not be re-issued on every pass.
  // Reviewer finding (vasylcf): the stale-scope guard of loadProjects had no
  // test, unlike its twin in loadWorkspaces.
  it('drops a projects list that arrives for a workspace since left', async () => {
    let resolve!: (value: unknown) => void;
    accounts.getProjects.mockReturnValue({ fetch: () => new Promise((r) => { resolve = r; }) });
    const catalogs = createContextCatalogs(app, onChange);

    catalogs.loadProjects('w1');
    state['app/context'] = { org: { id: 'o1', name: 'Org' }, workspace: { id: 'w2', name: 'Other' } };
    resolve({ items: [tenant('p1', 'Atlas', 'project', 'w1')] });
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatch).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops a projects failure that arrives for a workspace since left', async () => {
    let reject!: (reason: unknown) => void;
    accounts.getProjects.mockReturnValue({ fetch: () => new Promise((_r, rj) => { reject = rj; }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalogs = createContextCatalogs(app, onChange);

    catalogs.loadProjects('w1');
    state['app/context'] = { org: { id: 'o1', name: 'Org' }, workspace: { id: 'w2', name: 'Other' } };
    reject(new Error('down'));
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatch).not.toHaveBeenCalledWith(setContextProjectsStatus('failed'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('marks the projects list failed when the read fails', async () => {
    accounts.getProjects.mockReturnValue({ fetch: () => Promise.reject(new Error('down')) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createContextCatalogs(app, onChange).loadProjects('w1');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(setContextProjectsStatus('failed')));
    expect(onChange).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answers null for a project the backend refuses', async () => {
    for (const status of [404, 403]) {
      const refused = Object.assign(new Error(`HTTP ${status}`), { response: { status } });
      accounts.getTenant.mockReturnValue({ fetch: () => Promise.reject(refused) });
      await expect(createContextCatalogs(app, onChange).resolveProject('p9')).resolves.toBeNull();
    }
  });

  // Reviewer finding (coderabbit): a network failure is not an answer about the project.
  it('says unavailable for a read that failed without answering', async () => {
    accounts.getTenant.mockReturnValue({ fetch: () => Promise.reject(new Error('network')) });
    await expect(createContextCatalogs(app, onChange).resolveProject('p9')).resolves.toBe('unavailable');
  });

  it('leaves the workspace list to whoever applies the address, instead of loading the first organization\'s eagerly', async () => {
    accounts.getMe.fetch.mockResolvedValue({ subject_tenant_id: 'home' });
    identity.myMemberships.fetch.mockResolvedValue({ items: [{ org_id: 'o1' }] });
    accounts.getTenant.mockReturnValue({ fetch: () => Promise.resolve(tenant('o1', 'Org', TENANT_TYPES.organization)) });
    accounts.getWorkspaces.mockReturnValue({ fetch: () => Promise.resolve({ items: [] }) });

    await createContextCatalogs(app, onChange).loadOrganizations();

    expect(accounts.getWorkspaces).not.toHaveBeenCalled();
  });
});
