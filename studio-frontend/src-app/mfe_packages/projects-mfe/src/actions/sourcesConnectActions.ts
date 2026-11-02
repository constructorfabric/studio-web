/**
 * Opening and closing Connect source, and what it asks for.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-sources-connect-overlay:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-no-connection:p1
import { eventBus, type ChildMfeBridge } from '@gears-frontx/react';
import {
  STUDIO_EXTENSION_CONNECTION_CREATE,
  closeOverlay,
  openOverlay,
} from '@constructor-studio/mfe-shared';
import type { RepositoryPick } from '../model/projectDraft';
import '../events/sourcesConnectEvents';

/** This MFE's fourth extension. Must match `mfe.json`. */
export const SOURCES_CONNECT_EXTENSION_ID =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.project_sources_connect.main.v1';

export function openSourcesConnect(bridge: ChildMfeBridge | null): void {
  openOverlay(bridge, SOURCES_CONNECT_EXTENSION_ID);
}

export function closeSourcesConnect(bridge: ChildMfeBridge | null): void {
  closeOverlay(bridge, SOURCES_CONNECT_EXTENSION_ID);
}

export function openConnectionForm(bridge: ChildMfeBridge | null): void {
  openOverlay(bridge, STUDIO_EXTENSION_CONNECTION_CREATE);
}

export function requestSourcesConnect(projectId: string, picks: RepositoryPick[]): void {
  eventBus.emit('mfe/projects/sources-connect-requested', { projectId, picks });
}
