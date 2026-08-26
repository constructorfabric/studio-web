/**
 * App Context Effects
 *
 * Fills the top bar's context slot and reacts to selections in it.
 *
 * Organizations are resolved here because account-management is a service the
 * shell already owns. Projects are not resolved here at all — the studio-project
 * gear belongs to projects-mfe, so those events only carry state the MFE has
 * already loaded for its own screen.
 *
 * Selections made IN the slot also have to reach that MFE, and this is where
 * they leave the shell: `publishSelectedProject` mirrors every project
 * transition onto a shared property, the only host -> child channel that
 * survives an MFE's module realm.
 */

import {
  eventBus,
  apiRegistry,
  type FrontXApp,
} from '@gears-frontx/react';
import { AccountsApiService, TENANT_TYPES, type Tenant } from '@/app/api';
import {
  publishSelectedOrganization,
  publishSelectedProject,
} from '@/app/mfe/sharedContext';
import {
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextProjects,
  openContextProject,
  closeContextProject,
  type ContextEntity,
} from '@/app/slices/appContextSlice';

/** Tenants Studio calls organizations. Workspaces are a level the shell does not surface. */
function isOrganization(tenant: Tenant): boolean {
  return tenant.tenant_type === TENANT_TYPES.organization;
}

function toEntity(tenant: Tenant): ContextEntity {
  return { id: tenant.id, name: tenant.name };
}

/**
 * Register context effects.
 *
 * Called once during app initialization, alongside the bootstrap effects.
 */
export function registerAppContextEffects(app: FrontXApp): void {
  const dispatch = app.store.dispatch;

  eventBus.on('app/context/fetch', async () => {
    if (!apiRegistry.has(AccountsApiService)) return;

    const accounts = apiRegistry.getService(AccountsApiService);
    dispatch(setContextLoading(true));
    try {
      const me = await accounts.me.fetch();
      const homeTenantId = me?.subject_tenant_id;
      if (!homeTenantId) return;

      const home = await accounts.tenant({ tenantId: homeTenantId }).fetch();
      let children: Tenant[] = [];
      try {
        children = (await accounts.tenantChildren({ tenantId: homeTenantId }).fetch())?.items ?? [];
      } catch (error) {
        console.warn(
          'Failed to list child tenants:',
          error instanceof Error ? error.message : String(error)
        );
      }

      const items = [...(isOrganization(home) ? [home] : []), ...children.filter(isOrganization)].map(
        toEntity
      );
      const current = items.find((item) => item.id === home.id) ?? items[0] ?? null;
      dispatch(setContextOrganizations({ current, items }));
      publishSelectedOrganization(app);
    } catch (error) {
      console.warn(
        'Failed to resolve organizations:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      dispatch(setContextLoading(false));
    }
  });

  eventBus.on('app/context/org/changed', ({ orgId }) => {
    dispatch(setContextOrg(orgId));
    publishSelectedOrganization(app);
    publishSelectedProject(app);
  });

  //  Published by whoever owns projects (projects-mfe)

  eventBus.on('app/context/project/opened', ({ id, name }) => {
    dispatch(openContextProject({ id, name }));
    publishSelectedProject(app);
  });

  eventBus.on('app/context/projects', ({ items }) => {
    dispatch(setContextProjects(items));
  });

  eventBus.on('app/context/project/closed', () => {
    dispatch(closeContextProject());
    publishSelectedProject(app);
  });

  eventBus.on('app/context/project/changed', ({ projectId }) => {
    const state = app.store.getState() as Record<string, unknown>;
    const context = state['app/context'] as { projects?: ContextEntity[] } | undefined;
    const picked = context?.projects?.find((project) => project.id === projectId);
    if (!picked) return;
    dispatch(openContextProject(picked));
    publishSelectedProject(app);
  });
}
