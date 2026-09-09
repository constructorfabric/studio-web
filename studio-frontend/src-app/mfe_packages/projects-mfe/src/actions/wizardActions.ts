/**
 * Opening and closing the New project wizard.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-overlay:p1
import {
  eventBus,
  FRONTX_ACTION_MOUNT_EXT,
  FRONTX_ACTION_UNMOUNT_EXT,
  FRONTX_OVERLAY_DOMAIN,
  type ChildMfeBridge,
} from '@gears-frontx/react';
import { sendAndForget } from '@constructor-studio/mfe-shared';
import type { ProjectDraft } from '../model/projectDraft';
import './../events/wizardEvents';

/** This MFE's second extension. Must match `mfe.json`. */
export const WIZARD_EXTENSION_ID =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.project_create.main.v1';

function send(bridge: ChildMfeBridge | null, type: string): void {
  sendAndForget(
    bridge,
    { type, target: FRONTX_OVERLAY_DOMAIN, payload: { subject: WIZARD_EXTENSION_ID } },
    'projects'
  );
}

export function openProjectWizard(bridge: ChildMfeBridge | null): void {
  send(bridge, FRONTX_ACTION_MOUNT_EXT);
}

export function closeProjectWizard(bridge: ChildMfeBridge | null): void {
  send(bridge, FRONTX_ACTION_UNMOUNT_EXT);
}

export function requestProjectCreate(workspaceId: string, draft: ProjectDraft): void {
  eventBus.emit('mfe/projects/create-requested', { workspaceId, draft });
}
