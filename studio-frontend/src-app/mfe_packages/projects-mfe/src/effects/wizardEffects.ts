/**
 * Creating the project: the only place in this MFE that writes.
 *
 * It lives in an effect rather than in the wizard component because the work
 * outlives the thing that started it. The shell can unmount the wizard at any
 * moment — Escape and the scrim are its, and they arrive without a veto — and a
 * half-finished creation must not be cancelled by a React root going away. The
 * effect is registered with the slice and runs for as long as the MFE does.
 *
 * `mutation()` descriptors carry an imperative `fetch()`, so nothing here needs
 * a hook; `useApiMutation` would be unusable outside a component anyway.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-write:p1
// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-project-parent:p1
// @cpt-dod:cpt-studiofrontend-dod-project-create-announce:p1
// @cpt-algo:cpt-studiofrontend-algo-project-create-write:p2
// @cpt-flow:cpt-studiofrontend-flow-project-create-greenfield:p1
// @cpt-flow:cpt-studiofrontend-flow-project-create-modernize:p1
import {
  apiRegistry,
  eventBus,
  invalidateQueryCacheForApp,
  type AppDispatch,
  type FrontXApp,
} from '@gears-frontx/react';
import { refusalFrom } from '@constructor-studio/mfe-shared';
import { AccountsApiService, childrenPageParams } from '../api/AccountsApiService';
import { PROJECT_CONFIG_TYPE, TENANT_TYPES, type ProjectConfig } from '../api/types';
import {
  DEFAULT_STAGES,
  INITIAL_STATUS,
  MAX_SOURCES,
  type ProjectDraft,
} from '../model/projectDraft';
import { submitFailed, submitStarted } from '../slices/createSlice';
import type { ProjectRef } from '../events/wizardEvents';
import '../events/wizardEvents';


function toProjectConfig(draft: ProjectDraft): ProjectConfig {
  const config: ProjectConfig = {
    mode: draft.mode ?? 'greenfield',
    stages: [...DEFAULT_STAGES],
    status: INITIAL_STATUS,
  };
  if (draft.goal.trim()) config.brief = draft.goal.trim();
  const sources = draft.sources.slice(0, MAX_SOURCES);
  if (sources.length > 0) {
    config.sources = sources.map((pick) => ({
      connection_id: pick.connectionId,
      full_path: pick.fullPath,
      clone_url: pick.cloneUrl,
    }));
    if (sources.length === 1) config.source_git_url = sources[0]!.cloneUrl;
  }
  if (draft.ownerId) config.owner_id = draft.ownerId;
  return config;
}

export function initWizardEffects(dispatch: AppDispatch, app: FrontXApp): void {
  eventBus.on('mfe/projects/create-requested', ({ workspaceId, draft }) => {
    const accounts = apiRegistry.getService(AccountsApiService);

    // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-1
    const name = draft.name.trim();
    if (!name) return;
    // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-1

    dispatch(submitStarted());

    void (async () => {
      let tenantId: string;
      try {
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-2
        const tenant = await accounts.createTenant.fetch({
          name,
          parent_id: workspaceId,
          tenant_type: TENANT_TYPES.project,
        });
        tenantId = tenant.id;
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-2
      } catch (error) {
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-3
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-4
        dispatch(submitFailed(refusalFrom(error, 'error_create')));
        return;
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-3
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-4
      }

      /**
       * The announcement carries the switcher's whole list, so the workspace's
       * projects are read here — fresh, with the new one already in them — and
       * the cached page the list screen draws is dropped in the same breath.
       * The wizard only has the bridge; this is the last place that still has
       * the gear.
       */
      const announceCreated = async (): Promise<void> => {
        const children = accounts.children(childrenPageParams(workspaceId));
        const siblings = await children
          .fetch({ staleTime: 0 })
          .then((page) =>
            page.items.map((tenant): ProjectRef => ({ id: tenant.id, name: tenant.name }))
          )
          .catch((error: unknown) => {
            console.warn('[projects] created, siblings not read', error);
            return [] as ProjectRef[];
          });
        void invalidateQueryCacheForApp(app, children);
        eventBus.emit('mfe/projects/created', { project: { id: tenantId, name }, siblings });
      };

      try {
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-5
        await accounts
          .projectConfigWrite(tenantId, PROJECT_CONFIG_TYPE)
          .fetch(toProjectConfig(draft));
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-5
      } catch (error) {
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-6
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-7
        console.error('[projects] project created, attributes not written', error);
        await announceCreated();
        dispatch(submitFailed(refusalFrom(error, 'error_attributes')));
        return;
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-6
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-7
      }

      // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-8
      await announceCreated();
      // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-8
    })();
  });
}
