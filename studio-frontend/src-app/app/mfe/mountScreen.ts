/**
 * Mounting a screen, in one place.
 *
 * Two things always go together and were drifting apart: the mount itself, and
 * the section that names which of the entry's rail items was chosen. A mount
 * without it left the MFE on whatever section it had last — the Workspaces item
 * mounted and the settings screen showed.
 */

import {
  eventBus,
  screenDomain,
  FRONTX_ACTION_MOUNT_EXT,
  type MfeRegistry,
  type ScreenExtension,
} from '@gears-frontx/react';
import '@/app/events/bootstrapEvents';
import { sectionOf } from '@/app/mfe/screenLevels';

export async function mountScreen(
  registry: MfeRegistry,
  extension: ScreenExtension
): Promise<void> {
  await registry.executeActionsChain({
    action: {
      type: FRONTX_ACTION_MOUNT_EXT,
      target: screenDomain.id,
      payload: { subject: extension.id },
    },
  });
  eventBus.emit('app/context/project/section', { section: sectionOf(extension) ?? null });
}
