/**
 * Closing the New workspace form, handing the created workspace to the shell,
 * and telling it that this MFE works in a workspace at all. Opening the form
 * moved to organization-mfe with the Workspaces screen.
 */

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-overlay:p1
// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-announce:p1
// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-slot:p1
import {
  eventBus,
  FRONTX_OVERLAY_DOMAIN,
  FRONTX_SCREEN_DOMAIN,
  type ChildMfeBridge,
} from '@gears-frontx/react';
import {
  STUDIO_ACTION_WORKSPACES_PUBLISH,
  STUDIO_EXTENSION_WORKSPACE_CREATE,
  closeOverlay,
  requestFromHost,
  sendToHost,
} from '@constructor-studio/mfe-shared';
import './../events/workspaceEvents';

/**
 * Fire-and-forget: neither call site has anything to offer the member about an
 * overlay that will not unmount, and mfes 0.4.0 does not report a refusal anyway.
 */
export function closeWorkspaceForm(bridge: ChildMfeBridge | null): void {
  closeOverlay(bridge, STUDIO_EXTENSION_WORKSPACE_CREATE);
}

/**
 * The announcement itself. The tenant is already written when this runs, so its
 * failure is the caller's to show: it waits on the shell's reply.
 */
export function publishCreatedWorkspace(
  bridge: ChildMfeBridge | null,
  workspace: { id: string; name: string },
  organizationId: string | null
): Promise<void> {
  return requestFromHost(bridge, {
    type: STUDIO_ACTION_WORKSPACES_PUBLISH,
    target: FRONTX_OVERLAY_DOMAIN,
    payload: { kind: 'created', workspace, ...(organizationId ? { organizationId } : {}) },
  });
}

/**
 * Nothing waits on this, and a missing bridge is ordinary here: `ProjectsRoot`
 * publishes its scope from an effect that runs once before the bridge is handed
 * over.
 */
export function publishWorkspaceScope(bridge: ChildMfeBridge | null): void {
  sendToHost(bridge, {
    type: STUDIO_ACTION_WORKSPACES_PUBLISH,
    target: FRONTX_SCREEN_DOMAIN,
    payload: { kind: 'scoped' },
  });
}

export function requestWorkspaceCreate(orgId: string, name: string): void {
  eventBus.emit('mfe/workspaces/create-requested', { orgId, name });
}
