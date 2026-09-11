/**
 * Opening the shell's overlays from this screen.
 *
 * The workspace form is projects-mfe's extension and stays there; what moved is
 * which screen opens it — a workspace is created in an organization, and the
 * projects list is a screen of one workspace already. Mounting names the
 * extension id, so no MFE boundary is crossed in code: the shell's overlay
 * domain is what both talk to.
 */

import {
  FRONTX_ACTION_MOUNT_EXT,
  FRONTX_OVERLAY_DOMAIN,
  type ChildMfeBridge,
} from '@gears-frontx/react';
import { STUDIO_EXTENSION_WORKSPACE_CREATE, sendAndForget } from '@constructor-studio/mfe-shared';

export function openWorkspaceForm(bridge: ChildMfeBridge | null): void {
  sendAndForget(
    bridge,
    {
      type: FRONTX_ACTION_MOUNT_EXT,
      target: FRONTX_OVERLAY_DOMAIN,
      payload: { subject: STUDIO_EXTENSION_WORKSPACE_CREATE },
    },
    'organization'
  );
}
