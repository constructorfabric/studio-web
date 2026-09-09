/**
 * The MFE -> shell crossing for a workspace picked on this screen.
 *
 * The shell owns the levels, so the screen does not mount anything: it names
 * the workspace and the shell moves the session into that level. See
 * `cpt-studiofrontend-dod-workspaces-screen-row-opens`.
 */

import { FRONTX_SCREEN_DOMAIN, type ChildMfeBridge } from '@gears-frontx/react';
import {
  STUDIO_ACTION_WORKSPACES_PUBLISH,
  sendAndForget,
  type WorkspaceRef,
} from '@constructor-studio/mfe-shared';

export function requestWorkspace(bridge: ChildMfeBridge | null, workspace: WorkspaceRef): void {
  sendAndForget(
    bridge,
    {
      type: STUDIO_ACTION_WORKSPACES_PUBLISH,
      target: FRONTX_SCREEN_DOMAIN,
      payload: { kind: 'selected', workspace },
    },
    'organization'
  );
}
