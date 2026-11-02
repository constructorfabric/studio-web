/**
 * Opening and closing the Connect source form.
 */

// @cpt-dod:cpt-studiofrontend-dod-connection-create-overlay:p1
import { eventBus, type ChildMfeBridge } from '@gears-frontx/react';
import {
  STUDIO_EXTENSION_CONNECTION_CREATE,
  closeOverlay,
  openOverlay,
} from '@constructor-studio/mfe-shared';
import type { ConnectionDraft } from '../model/connectionDraft';
import './../events/connectEvents';

export function openConnectDialog(bridge: ChildMfeBridge | null): void {
  openOverlay(bridge, STUDIO_EXTENSION_CONNECTION_CREATE);
}

export function closeConnectDialog(bridge: ChildMfeBridge | null): void {
  closeOverlay(bridge, STUDIO_EXTENSION_CONNECTION_CREATE);
}

export function requestConnectionCreate(orgId: string, draft: ConnectionDraft): void {
  eventBus.emit('mfe/connections/create-requested', { orgId, draft });
}
