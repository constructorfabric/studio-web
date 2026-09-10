/** Mounting a screen, in one place. */


import {
  eventBus,
  screenDomain,
  FRONTX_ACTION_MOUNT_EXT,
  type MfeRegistry,
  type ScreenExtension,
} from '@gears-frontx/react';
import '@/app/events/bootstrapEvents';
import { sectionOf } from '@/app/mfe/screenLevels';

/**
 * The registries with a mount still running — one at a time, because the
 * runtime does not do it.
 * A set of registries rather than one flag for the module
 */
const mounting = new WeakSet<MfeRegistry>();

export function isMountingScreen(registry: MfeRegistry): boolean {
  return mounting.has(registry);
}

/** Called when the screen domain attaches a root */

export function releaseMountLock(registry: MfeRegistry): void {
  mounting.delete(registry);
}

export async function mountScreen(
  registry: MfeRegistry,
  extension: ScreenExtension
): Promise<void> {
  if (mounting.has(registry)) return;

  mounting.add(registry);
  try {
    await registry.executeActionsChain({
      action: {
        type: FRONTX_ACTION_MOUNT_EXT,
        target: screenDomain.id,
        payload: { subject: extension.id },
      },
    });
  } finally {
    mounting.delete(registry);
  }
  eventBus.emit('app/context/project/section', { section: sectionOf(extension) ?? null });
}
