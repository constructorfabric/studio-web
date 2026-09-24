/**
 * The catalogs the shell reads to give the address its names (ADR-0022,
 * "`materialize` is the only writer of the context").
 *
 * Nothing here decides what is selected. Each read writes a list, or a status,
 * into the slice and calls `onChange`, and `materialize` decides what the
 * address names against the list that is now there. The scope guards are the
 * ones the old effects had: an answer for an organization or workspace since
 * left is dropped, not applied to whatever is current now.
 */
import { apiRegistry, eventBus, type FrontXApp } from '@gears-frontx/react';
import { AccountsApiService, TENANT_TYPES, type Tenant } from '@constructor-studio/mfe-shared';
import { IdentityApiService, PLATFORM_ROOT_TENANT_ID } from '@/app/api';
import {
  APP_CONTEXT_SLICE_KEY,
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextProjects,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  type AppContextState,
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A 404 or 403 is the backend's answer about the tenant — outside the caller's
 * subtree account-management answers 404 by design. Anything else (a network
 * failure, an aborted request, a 5xx) is not an answer.
 */
function isRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { response?: { status?: number } }).response?.status;
  return status === 404 || status === 403;
}

export function createContextCatalogs(app: FrontXApp, onChange: () => void): ContextCatalogs {
  const dispatch = app.store.dispatch;
  const context = (): Partial<AppContextState> =>
    ((app.store.getState() as Record<string, unknown>)[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined) ?? {};

  let workspacesInFlightFor: string | null = null;
  const projectsInFlightFor = new Set<string>();

  const platformOrganizations = async (rootId: string): Promise<Tenant[]> => {
    const accounts = apiRegistry.getService(AccountsApiService);
    try {
      const children = (await accounts.getChildren({ tenantId: rootId }).fetch())?.items ?? [];
      return children.filter(isOrganization);
    } catch (error) {
      console.warn('Failed to list organizations under the platform root:', message(error));
      return [];
    }
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
        } catch {
          return null;
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
        const page = await accounts.getWorkspaces({ organizationId: orgId }).fetch();
        if (context().org?.id !== orgId) return;
        dispatch(setContextWorkspaces((page?.items ?? []).map(toEntity)));
        dispatch(setContextWorkspacesStatus('ready'));
        onChange();
      } catch (error) {
        if (context().org?.id !== orgId) return;
        console.warn('Failed to list workspaces:', message(error));
        dispatch(setContextWorkspacesStatus('failed'));
        onChange();
        // Once: the retry is for an aborted duplicate, not for a gear that is down.
        if (!isRetry) eventBus.emit('app/context/workspaces/failed');
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
      console.warn('Failed to resolve organizations:', message(error));
      // A failed resolve is not the same as having no access: leave the access
      // state alone so a transient failure does not show an onboarding screen
      // to somebody who has an organization.
    } finally {
      dispatch(setContextLoading(false));
    }
  };

  const loadProjects = (workspaceId: string): void => {
    if (!apiRegistry.has(AccountsApiService) || projectsInFlightFor.has(workspaceId)) return;
    projectsInFlightFor.add(workspaceId);
    const accounts = apiRegistry.getService(AccountsApiService);
    void (async () => {
      try {
        const page = await accounts.getProjects({ parentId: workspaceId }).fetch();
        if (context().workspace?.id !== workspaceId) return;
        dispatch(setContextProjects((page?.items ?? []).map(toEntity)));
        onChange();
      } catch (error) {
        console.warn('Failed to list projects:', message(error));
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
      console.warn(`Failed to read project ${projectId}:`, message(error));
      return isRefusal(error) ? null : 'unavailable';
    }
  };

  return { loadOrganizations, loadWorkspaces, loadProjects, resolveProject };
}
