import { AccountsApiService } from '@constructor-studio/mfe-shared';
/** Creating the workspace. */


// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-overlay:p1
// @cpt-algo:cpt-studiofrontend-algo-workspace-scope-write:p2
// @cpt-flow:cpt-studiofrontend-flow-workspace-scope-create:p1
import { apiRegistry, eventBus, type AppDispatch } from '@gears-frontx/react';
import { refusalFrom } from '@constructor-studio/mfe-shared';
import { workspaceSubmitFailed, workspaceSubmitStarted } from '../slices/workspaceSlice';
import '../events/workspaceEvents';

export function initWorkspaceEffects(dispatch: AppDispatch): void {
  eventBus.on('mfe/workspaces/create-requested', ({ orgId, name: raw }) => {
    const accounts = apiRegistry.getService(AccountsApiService);

    // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-1
    const name = raw.trim();
    if (!name) return;
    // @cpt-end:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-1

    dispatch(workspaceSubmitStarted());

    void (async () => {
      try {
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-2
        const tenant = await accounts.createWorkspace({ name, parentId: orgId });
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-2
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-5
        eventBus.emit('mfe/workspaces/created', { id: tenant.id, name, orgId });
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-5
      } catch (error) {
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-3
        // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-4
        dispatch(workspaceSubmitFailed(refusalFrom(error, 'error_create')));
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-3
        // @cpt-end:cpt-studiofrontend-algo-workspace-scope-write:p1:inst-4
      }
    })();
  });
}
