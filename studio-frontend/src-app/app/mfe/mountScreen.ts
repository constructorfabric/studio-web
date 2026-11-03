/** Mounting a screen, in one place. */

import { screenDomain, FRONTX_ACTION_MOUNT_EXT, type MfeRegistry } from '@gears-frontx/react';
import { executeAndSettle } from '@/app/mfe/shellOutcomes';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';

/**
 * Mounts an extension into the screen domain, and nothing else. The runtime
 * orders the mounts: one runs, one waits, and the one a newer request
 * replaces rejects.
 */
export function mountScreen(registry: MfeRegistry, extension: StudioScreenExtension): Promise<void> {
  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-5
  return executeAndSettle(registry, {
    type: FRONTX_ACTION_MOUNT_EXT,
    target: screenDomain.id,
    payload: { subject: extension.id },
  });
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-5
}
