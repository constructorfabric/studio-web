/** App Context Effects */

import {
  eventBus,
  apiRegistry,
  screenDomain,
  type FrontXApp,
  type ScreenExtension,
} from '@gears-frontx/react';
import {
  AccountsApiService,
  IdentityApiService,
  PLATFORM_ROOT_TENANT_ID,
  TENANT_TYPES,
  type Tenant,
} from '@/app/api';
import { entryPointOf, sectionOf, type ScreenLevel } from '@/app/mfe/screenLevels';
import { mountScreen } from '@/app/mfe/mountScreen';
import {
  publishSelectedOrganization,
  publishSelectedProject,
  publishSelectedSection,
  publishSelectedWorkspace,
} from '@/app/mfe/sharedContext';
import {
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  setContextWorkspace,
  addContextWorkspace,
  setContextProjects,
  openContextProject,
  closeContextProject,
  setContextSection,
  type ContextEntity,
  type WorkspacesStatus,
} from '@/app/slices/appContextSlice';

/** Tenants Studio calls organizations; workspaces are their children. */
function isOrganization(tenant: Tenant): boolean {
  return tenant.tenant_type === TENANT_TYPES.organization;
}

/** Account-management's own listing ceiling, so one page is enough. */
const WORKSPACE_PAGE_LIMIT = 200;

/** Long enough for an aborted duplicate to have settled. */
const WORKSPACE_RETRY_DELAY_MS = 400;

function toEntity(tenant: Tenant): ContextEntity {
  return {
    id: tenant.id,
    name: tenant.name,
    ...(tenant.child_count !== undefined && { count: tenant.child_count }),
  };
}

interface ContextSliceShape {
  org?: ContextEntity | null;
  project?: ContextEntity | null;
  workspacesStatus?: WorkspacesStatus;
}

function contextSlice(app: FrontXApp): ContextSliceShape {
  const state = app.store.getState() as Record<string, unknown>;
  return (state['app/context'] as ContextSliceShape | undefined) ?? {};
}

/** The section of a level's entry item, or `null` when it declares none. */
function entrySectionOf(app: FrontXApp, level: ScreenLevel): string | null {
  const registry = app.mfeRegistry;
  if (!registry) return null;
  const screens = registry.getExtensionsForDomain(screenDomain.id) as ScreenExtension[];
  const entry = entryPointOf(screens, level);
  return entry ? (sectionOf(entry) ?? null) : null;
}

function currentOrgId(app: FrontXApp): string | null {
  return contextSlice(app).org?.id ?? null;
}

/**
 * Register context effects.
 *
 * Called once during app initialization, alongside the bootstrap effects.
 */
export function registerAppContextEffects(app: FrontXApp): void {
  const dispatch = app.store.dispatch;

  const resolveWorkspaces = async (orgId: string | null, isRetry = false): Promise<void> => {
    if (!orgId || !apiRegistry.has(AccountsApiService)) {
      dispatch(setContextWorkspaces([]));
      dispatch(setContextWorkspacesStatus('ready'));
      publishSelectedWorkspace(app);
      return;
    }
    const accounts = apiRegistry.getService(AccountsApiService);
    dispatch(setContextWorkspacesStatus('pending'));
    try {
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-1
      const page = await accounts
        .tenantChildrenOfType({
          tenantId: orgId,
          tenantType: TENANT_TYPES.workspace,
          limit: WORKSPACE_PAGE_LIMIT,
        })
        .fetch();
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-1
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-2
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-3
      if (currentOrgId(app) !== orgId) return;
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-2
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-3
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-7
      dispatch(setContextWorkspaces((page?.items ?? []).map(toEntity)));
      dispatch(setContextWorkspacesStatus('ready'));
      publishSelectedWorkspace(app);
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-7
    } catch (error) {
      if (currentOrgId(app) !== orgId) return;
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-4
      console.warn(
        'Failed to list workspaces:',
        error instanceof Error ? error.message : String(error)
      );
      dispatch(setContextWorkspacesStatus('failed'));
      // Once: the retry is for an aborted duplicate, not for a gear that is down.
      if (!isRetry) eventBus.emit('app/context/workspaces/failed');
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-4
    }
  };

  /**
   * The organizations a platform administrator switches between.
   *
   * A platform administrator reaches every organization by virtue of the role,
   * not by membership, so this stays a walk of the tenant tree: the root's
   * organization children. Making the root's own membership stand for "member of
   * everything" would be exactly the conflation ADR-0011 §1 forbids — and the
   * root is not of the organization type, so it never appears in the switcher
   * itself.
   */
  const platformOrganizations = async (rootId: string): Promise<Tenant[]> => {
    const accounts = apiRegistry.getService(AccountsApiService);
    try {
      const children = (await accounts.tenantChildren({ tenantId: rootId }).fetch())?.items ?? [];
      return children.filter(isOrganization);
    } catch (error) {
      console.warn(
        'Failed to list organizations under the platform root:',
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  };

  /**
   * The organizations an ordinary person is a member of.
   *
   * Membership is the authority (ADR-0011 §2), so the list comes from
   * `studio-user` and the names are resolved per organization — `studio-user`
   * stores ids and roles, not tenant names. An organization whose tenant cannot
   * be read is dropped rather than shown nameless: from outside a self-managed
   * organization's subtree the backend answers 404 by design, and that is
   * isolation working, not an error.
   */
  const memberOrganizations = async (): Promise<Tenant[]> => {
    if (!apiRegistry.has(IdentityApiService)) return [];
    const identity = apiRegistry.getService(IdentityApiService);
    const accounts = apiRegistry.getService(AccountsApiService);
    const memberships = (await identity.myMemberships.fetch())?.items ?? [];
    const resolved = await Promise.all(
      memberships.map(async (membership) => {
        try {
          return await accounts.tenant({ tenantId: membership.org_id }).fetch();
        } catch {
          return null;
        }
      })
    );
    return resolved.filter((tenant): tenant is Tenant => tenant !== null).filter(isOrganization);
  };

  eventBus.on('app/context/fetch', async () => {
    if (!apiRegistry.has(AccountsApiService)) return;

    const accounts = apiRegistry.getService(AccountsApiService);
    dispatch(setContextLoading(true));
    try {
      const me = await accounts.me.fetch();
      const homeTenantId = me?.subject_tenant_id;

      // The home tenant no longer decides WHICH organizations are on offer —
      // only whether this caller is the platform administrator, which is a fact
      // about the token and not a membership.
      const organizations =
        homeTenantId === PLATFORM_ROOT_TENANT_ID
          ? await platformOrganizations(homeTenantId)
          : await memberOrganizations();

      const items = organizations.map(toEntity);
      const current = items[0] ?? null;
      dispatch(setContextOrganizations({ current, items }));
      // An authenticated person with no organization is a supported state, and
      // the shell has to say so rather than render an empty switcher.
      dispatch(setContextAccess(items.length > 0 ? 'ready' : 'unassigned'));
      publishSelectedOrganization(app);
      await resolveWorkspaces(current?.id ?? null);
    } catch (error) {
      console.warn(
        'Failed to resolve organizations:',
        error instanceof Error ? error.message : String(error)
      );
      // A failed resolve is not the same as having no access: leave the access
      // state alone so a transient failure does not show an onboarding screen to
      // somebody who has an organization.
    } finally {
      dispatch(setContextLoading(false));
    }
  });

  eventBus.on('app/context/org/changed', ({ orgId }) => {
    if (currentOrgId(app) === orgId) {
      if (contextSlice(app).workspacesStatus === 'failed') void resolveWorkspaces(orgId);
      return;
    }
    dispatch(setContextOrg(orgId));
    publishSelectedOrganization(app);
    publishSelectedWorkspace(app);
    publishSelectedProject(app);
    void resolveWorkspaces(currentOrgId(app));
  });

  eventBus.on('app/context/level/requested', ({ level }) => {
    const registry = app.mfeRegistry;
    if (!registry) return;
    if (level !== 'project' && contextSlice(app).project) {
      dispatch(closeContextProject());
      publishSelectedProject(app);
      publishSelectedSection(app);
    }
    const screens = registry.getExtensionsForDomain(screenDomain.id) as ScreenExtension[];
    const target = entryPointOf(screens, level);
    if (!target) return;
    mountScreen(registry, target)
      .catch((error) => {
        console.warn(
          `Failed to enter the ${level} level:`,
          error instanceof Error ? error.message : String(error)
        );
      });
  });

  eventBus.on('app/context/workspace/changed', ({ workspaceId, name }) => {
    // A name means the sender read the workspace itself; it may not be in the
    // shell's list yet, and ignoring it would open the previous workspace.
    dispatch(
      name === undefined
        ? setContextWorkspace(workspaceId)
        : addContextWorkspace({ id: workspaceId, name })
    );
    publishSelectedWorkspace(app);
    publishSelectedProject(app);
  });

  /** Created by an MFE and handed over as an action chain — see contextActions. */
  eventBus.on('app/context/workspace/created', ({ id, name }) => {
    dispatch(addContextWorkspace({ id, name }));
    publishSelectedWorkspace(app);
    publishSelectedProject(app);
  });
  eventBus.on('app/context/workspace/scoped', () => {
    if (contextSlice(app).workspacesStatus === 'failed') {
      void resolveWorkspaces(currentOrgId(app));
    }
  });

  eventBus.on('app/context/workspaces/failed', () => {
    window.setTimeout(() => {
      if (contextSlice(app).workspacesStatus !== 'failed') return;
      void resolveWorkspaces(currentOrgId(app), true);
    }, WORKSPACE_RETRY_DELAY_MS);
  });

  //  Published by whoever owns projects (projects-mfe)

  eventBus.on('app/context/project/opened', ({ id, name }) => {
    dispatch(openContextProject({ id, name }));
    dispatch(setContextSection(entrySectionOf(app, 'project')));
    publishSelectedProject(app);
    publishSelectedSection(app);
  });

  eventBus.on('app/context/project/section', ({ section }) => {
    dispatch(setContextSection(section));
    publishSelectedSection(app);
  });

  eventBus.on('app/context/projects', ({ items }) => {
    dispatch(setContextProjects(items));
  });

  eventBus.on('app/context/project/closed', () => {
    dispatch(closeContextProject());
    publishSelectedProject(app);
    publishSelectedSection(app);
  });

  eventBus.on('app/context/project/changed', ({ projectId }) => {
    const state = app.store.getState() as Record<string, unknown>;
    const context = state['app/context'] as { projects?: ContextEntity[] } | undefined;
    const picked = context?.projects?.find((project) => project.id === projectId);
    if (!picked) return;
    dispatch(openContextProject(picked));
    dispatch(setContextSection(entrySectionOf(app, 'project')));
    publishSelectedProject(app);
    publishSelectedSection(app);
  });
}
