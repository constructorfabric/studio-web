/**
 * Opening and closing the New project wizard.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-overlay:p1
import { eventBus, type ChildMfeBridge } from '@gears-frontx/react';
import { closeOverlay, openOverlay } from '@constructor-studio/mfe-shared';
import type { ProjectDraft } from '../model/projectDraft';
import './../events/wizardEvents';

/** This MFE's second extension. Must match `mfe.json`. */
export const WIZARD_EXTENSION_ID =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.project_create.main.v1';

export function openProjectWizard(bridge: ChildMfeBridge | null): void {
  openOverlay(bridge, WIZARD_EXTENSION_ID);
}

export function closeProjectWizard(bridge: ChildMfeBridge | null): void {
  closeOverlay(bridge, WIZARD_EXTENSION_ID);
}

export function requestProjectCreate(workspaceId: string, draft: ProjectDraft): void {
  eventBus.emit('mfe/projects/create-requested', { workspaceId, draft });
}
