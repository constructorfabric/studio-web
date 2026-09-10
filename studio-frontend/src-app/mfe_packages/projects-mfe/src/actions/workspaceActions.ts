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
  FRONTX_ACTION_UNMOUNT_EXT,
  FRONTX_OVERLAY_DOMAIN,
  FRONTX_SCREEN_DOMAIN,
  type ChildMfeBridge,
} from '@gears-frontx/react';
import {
  STUDIO_ACTION_WORKSPACES_PUBLISH,
  STUDIO_EXTENSION_WORKSPACE_CREATE,
  sendAndForget,
  sendToHost,
} from '@constructor-studio/mfe-shared';
import './../events/workspaceEvents';

/**
 * Awaited by the form: it may only close once the shell has the workspace.
 *
 * A refusal is reported and not raised. By the time this runs the shell has
 * been told, and neither call site has anything to offer the member about an
 * overlay that will not unmount.
 */
export function closeWorkspaceForm(bridge: ChildMfeBridge | null): Promise<void> {
  return sendToHost(bridge, {
    type: FRONTX_ACTION_UNMOUNT_EXT,
    target: FRONTX_OVERLAY_DOMAIN,
    payload: { subject: STUDIO_EXTENSION_WORKSPACE_CREATE },
  }).catch((error: unknown) => {
    console.error('[projects] closing the workspace form failed', error);
  });
}

/**
 * The announcement itself. The tenant is already written when this runs, so its
 * failure is the caller's to handle — never fire-and-forget.
 */
export function publishCreatedWorkspace(
  bridge: ChildMfeBridge | null,
  workspace: { id: string; name: string },
  organizationId: string | null
): Promise<void> {
  return sendToHost(bridge, {
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
  sendAndForget(
    bridge,
    {
      type: STUDIO_ACTION_WORKSPACES_PUBLISH,
      target: FRONTX_SCREEN_DOMAIN,
      payload: { kind: 'scoped' },
    },
    'projects'
  );
}

export function requestWorkspaceCreate(orgId: string, name: string): void {
  eventBus.emit('mfe/workspaces/create-requested', { orgId, name });
}
