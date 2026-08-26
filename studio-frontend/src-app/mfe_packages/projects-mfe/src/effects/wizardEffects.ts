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
// @cpt-dod:cpt-studiofrontend-dod-project-create-announce:p1
// @cpt-algo:cpt-studiofrontend-algo-project-create-write:p2
// @cpt-flow:cpt-studiofrontend-flow-project-create-greenfield:p1
// @cpt-flow:cpt-studiofrontend-flow-project-create-modernize:p1
import { apiRegistry, eventBus, type AppDispatch } from '@gears-frontx/react';
import { AccountsApiService } from '../api/AccountsApiService';
import { PROJECT_CONFIG_TYPE, TENANT_TYPES, type ProjectConfig } from '../api/types';
import {
  DEFAULT_STAGES,
  INITIAL_STATUS,
  MAX_SOURCES,
  type ProjectDraft,
} from '../model/projectDraft';
import { submitFailed, submitStarted } from '../slices/createSlice';
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

/**
 * AM's refusals arrive as an axios error whose useful part is buried. Anything
 * we cannot read becomes the generic message rather than `[object Object]`.
 */
function refusalText(error: unknown): string | null {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: { data?: unknown } }).response;
    const data = response?.data;
    if (typeof data === 'string' && data.trim()) return data;
    if (typeof data === 'object' && data !== null) {
      const message = (data as { message?: unknown; detail?: unknown }).message
        ?? (data as { detail?: unknown }).detail;
      if (typeof message === 'string' && message.trim()) return message;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return null;
}

export function initWizardEffects(dispatch: AppDispatch): void {
  eventBus.on('mfe/projects/create-requested', ({ orgId, draft }) => {
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
          parent_id: orgId,
          tenant_type: TENANT_TYPES.project,
        });
        tenantId = tenant.id;
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-2
      } catch (error) {
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-3
        // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-4
        dispatch(submitFailed(refusalText(error) ?? 'create-failed'));
        return;
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-3
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-4
      }

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
        eventBus.emit('mfe/projects/created', { id: tenantId, name });
        dispatch(submitFailed(refusalText(error) ?? 'attributes-failed'));
        return;
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-6
        // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-7
      }

      // @cpt-begin:cpt-studiofrontend-algo-project-create-write:p2:inst-8
      eventBus.emit('mfe/projects/created', { id: tenantId, name });
      // @cpt-end:cpt-studiofrontend-algo-project-create-write:p2:inst-8
    })();
  });
}
