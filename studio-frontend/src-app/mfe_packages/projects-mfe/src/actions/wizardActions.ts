/**
 * Opening and closing the New project wizard.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-overlay:p1
import { eventBus, type ChildMfeBridge } from '@gears-frontx/react';
import type { ProjectDraft } from '../model/projectDraft';
import './../events/wizardEvents';

/** Infrastructure actions of the extension lifecycle; `mount` auto-loads. */
const MOUNT_EXT = 'gts.frontx.mfes.comm.action.v1~frontx.mfes.ext.mount_ext.v1~';
const UNMOUNT_EXT = 'gts.frontx.mfes.comm.action.v1~frontx.mfes.ext.unmount_ext.v1~';

const OVERLAY_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.overlay.v1';

/** This MFE's second extension. Must match `mfe.json`. */
export const WIZARD_EXTENSION_ID =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.project_create.main.v1';

function send(
  bridge: ChildMfeBridge | null,
  type: string,
  target: string,
  subject: string
): void {
  if (!bridge) return;
  void bridge
    .executeActionsChain({ action: { type, target, payload: { subject } } })
    .catch((error: unknown) => {
      console.error('[projects] extension action failed', type, subject, error);
    });
}

export function openProjectWizard(bridge: ChildMfeBridge | null): void {
  send(bridge, MOUNT_EXT, OVERLAY_DOMAIN, WIZARD_EXTENSION_ID);
}

export function closeProjectWizard(bridge: ChildMfeBridge | null): void {
  send(bridge, UNMOUNT_EXT, OVERLAY_DOMAIN, WIZARD_EXTENSION_ID);
}

export function requestProjectCreate(orgId: string, draft: ProjectDraft): void {
  eventBus.emit('mfe/projects/create-requested', { orgId, draft });
}
