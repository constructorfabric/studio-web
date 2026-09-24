/**
 * The catalogs the shell reads to give the address its names (ADR-0028,
 * "`materialize` is the only writer of the context").
 *
 * Nothing here decides what is selected. Each read writes a list, or a status,
 * into the slice and calls `onChange`, and `materialize` decides what the
 * address names against the list that is now there. The scope guards are the
 * ones the old effects had: an answer for an organization or workspace since
 * left is dropped, not applied to whatever is current now.
 */
import { apiRegistry, eventBus, type FrontXApp } from '@gears-frontx/react';
import {
  AccountsApiService,
  TENANT_TYPES,
  errorMessage,
  responseStatus,
  type Tenant,
} from '@constructor-studio/mfe-shared';
import { IdentityApiService, PLATFORM_ROOT_TENANT_ID } from '@/app/api';
import {
  readAppContext,
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextProjects,
  setContextProjectsStatus,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  type ContextEntity,
} from '@/app/slices/appContextSlice';

/**
 * What a tenant read for an address's project came back with: the tenant, a
 * definite refusal (`null` — the backend answered that there is no such tenant
 * for this caller), or nothing at all (`'unavailable'` — the read failed and
 * said nothing about the project).
 */
export type ProjectLookup = Tenant | null | 'unavailable';

export interface ContextCatalogs {
  loadOrganizations(): Promise<void>;
  loadWorkspaces(orgId: string, isRetry?: boolean): void;
  loadProjects(workspaceId: string): void;
  resolveProject(projectId: string): Promise<ProjectLookup>;
}

function isOrganization(tenant: Tenant): boolean {
  return tenant.tenant_type === TENANT_TYPES.organization;
}

function toEntity(tenant: Tenant): ContextEntity {
  return {
    id: tenant.id,
    name: tenant.name,
    ...(tenant.child_count !== undefined && { count: tenant.child_count }),
  };
}

/**
 * A 404 or 403 is the backend's answer about the tenant — outside the caller's
 * subtree account-management answers 404 by design. Anything else (a network
 * failure, an aborted request, a 5xx) is not an answer.
 */
function isRefusal(error: unknown): boolean {
  const status = responseStatus(error);
  return status === 404 || status === 403;
}

export function createContextCatalogs(app: FrontXApp, onChange: () => void): ContextCatalogs {
  const dispatch = app.store.dispatch;
  const context = () => readAppContext(app);

  let workspacesInFlightFor: string | null = null;
  const projectsInFlightFor = new Set<string>();

  // A failure here is the caller's to judge: swallowed into an empty list it
  // would read as "member of nothing" and show the administrator the
  // onboarding screen (reviewer finding).
  const platformOrganizations = async (rootId: string): Promise<Tenant[]> => {
    const accounts = apiRegistry.getService(AccountsApiService);
    const children = (await accounts.getChildren({ tenantId: rootId }).fetch())?.items ?? [];
    return children.filter(isOrganization);
  };

  const memberOrganizations = async (): Promise<Tenant[]> => {
    if (!apiRegistry.has(IdentityApiService)) return [];
    const identity = apiRegistry.getService(IdentityApiService);
    const accounts = apiRegistry.getService(AccountsApiService);
    const memberships = (await identity.myMemberships.fetch())?.items ?? [];
    const resolved = await Promise.all(
      memberships.map(async (membership) => {
        try {
          return await accounts.getTenant({ tenantId: membership.org_id }).fetch();
        } catch (error) {
          // Outside a self-managed organization's subtree the backend answers
          // 404 by design: that membership is dropped. A read that failed for
          // another reason says nothing about it, and the whole resolve fails
          // rather than reading as "member of fewer" (reviewer finding).
          if (isRefusal(error)) return null;
          throw error;
        }
      })
    );
    return resolved.filter((tenant): tenant is Tenant => tenant !== null).filter(isOrganization);
  };

  const loadWorkspaces = (orgId: string, isRetry = false): void => {
    if (!apiRegistry.has(AccountsApiService)) {
      dispatch(setContextWorkspaces([]));
      dispatch(setContextWorkspacesStatus('ready'));
      onChange();
      return;
    }
    if (workspacesInFlightFor === orgId) return;
    workspacesInFlightFor = orgId;
    const accounts = apiRegistry.getService(AccountsApiService);
    dispatch(setContextWorkspacesStatus('pending'));
    void (async () => {
      try {
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-1
        const page = await accounts.getWorkspaces({ organizationId: orgId }).fetch();
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-1
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-2
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-3
        if (context().org?.id !== orgId) return;
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-2
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-3
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-7
        dispatch(setContextWorkspaces((page?.items ?? []).map(toEntity)));
        dispatch(setContextWorkspacesStatus('ready'));
        onChange();
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-7
      } catch (error) {
        if (context().org?.id !== orgId) return;
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-4
        console.warn('Failed to list workspaces:', errorMessage(error));
        dispatch(setContextWorkspacesStatus('failed'));
        onChange();
        // Once: the retry is for an aborted duplicate, not for a gear that is down.
        if (!isRetry) eventBus.emit('app/context/workspaces/failed');
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-4
      } finally {
        if (workspacesInFlightFor === orgId) workspacesInFlightFor = null;
      }
    })();
  };

  const loadOrganizations = async (): Promise<void> => {
    if (!apiRegistry.has(AccountsApiService)) return;
    const accounts = apiRegistry.getService(AccountsApiService);
    dispatch(setContextLoading(true));
    try {
      const me = await accounts.getMe.fetch();
      const homeTenantId = me?.subject_tenant_id;
      // The home tenant no longer decides WHICH organizations are on offer —
      // only whether this caller is the platform administrator, which is a
      // fact about the token and not a membership (ADR-0011).
      const organizations =
        homeTenantId === PLATFORM_ROOT_TENANT_ID
          ? await platformOrganizations(homeTenantId)
          : await memberOrganizations();
      const items = organizations.map(toEntity);
      dispatch(setContextOrganizations(items));
      // An authenticated person with no organization is a supported state, and
      // the shell has to say so rather than render an empty switcher.
      dispatch(setContextAccess(items.length > 0 ? 'ready' : 'unassigned'));
      // The workspaces of whichever organization the address names are loaded
      // by `materialize` on this callback; loading the first organization's
      // here would race it and be thrown away when the address names another.
      onChange();
    } catch (error) {
      console.warn('Failed to resolve organizations:', errorMessage(error));
      // A failed resolve is not the same as having no access: leave the access
      // state alone so a transient failure does not show an onboarding screen
      // to somebody who has an organization.
    } finally {
      dispatch(setContextLoading(false));
    }
  };

  const loadProjects = (workspaceId: string): void => {
    if (!apiRegistry.has(AccountsApiService)) {
      dispatch(setContextProjects([]));
      return;
    }
    if (projectsInFlightFor.has(workspaceId)) return;
    projectsInFlightFor.add(workspaceId);
    const accounts = apiRegistry.getService(AccountsApiService);
    void (async () => {
      try {
        const page = await accounts.getProjects({ parentId: workspaceId }).fetch();
        if (context().workspace?.id !== workspaceId) return;
        dispatch(setContextProjects((page?.items ?? []).map(toEntity)));
        onChange();
      } catch (error) {
        if (context().workspace?.id !== workspaceId) return;
        console.warn('Failed to list projects:', errorMessage(error));
        // Once per workspace: `materialize` asks while the list is pending,
        // and a list that could not be read is not pending. The MFE's own
        // list, published when its screen shows, still fills the switcher.
        dispatch(setContextProjectsStatus('failed'));
      } finally {
        projectsInFlightFor.delete(workspaceId);
      }
    })();
  };

  const resolveProject = async (projectId: string): Promise<ProjectLookup> => {
    if (!apiRegistry.has(AccountsApiService)) return null;
    try {
      return await apiRegistry.getService(AccountsApiService).getTenant({ tenantId: projectId }).fetch();
    } catch (error) {
      console.warn(`Failed to read project ${projectId}:`, errorMessage(error));
      return isRefusal(error) ? null : 'unavailable';
    }
  };

  return { loadOrganizations, loadWorkspaces, loadProjects, resolveProject };
}
