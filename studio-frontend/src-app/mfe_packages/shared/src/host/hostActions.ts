/** The MFE -> shell channel */

import type { ChildMfeBridge } from '@gears-frontx/react';

/** Screen domain: `kind: opened | closed | section`. */
export const STUDIO_ACTION_CONTEXT_PUBLISH =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.context.projects.publish.v1~';

/** Screen or overlay domain: `kind: created | selected | scoped`. */
export const STUDIO_ACTION_WORKSPACES_PUBLISH =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.context.workspaces.publish.v1~';

/** projects-mfe's New workspace overlay, opened from organization-mfe as well. */
export const STUDIO_EXTENSION_WORKSPACE_CREATE =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.workspace_create.main.v1';

export interface HostAction {
  type: string;
  target: string;
  payload: Record<string, unknown>;
}

export function sendToHost(bridge: ChildMfeBridge | null, action: HostAction): Promise<void> {
  if (!bridge) return Promise.reject(new Error(`no MFE bridge for ${action.type}`));
  return bridge.executeActionsChain({ action }).then(() => undefined);
}

export function sendAndForget(bridge: ChildMfeBridge | null, action: HostAction, tag: string): void {
  if (!bridge) return;
  void sendToHost(bridge, action).catch((error: unknown) => {
    console.error(`[${tag}] host action failed`, action.type, error);
  });
}
