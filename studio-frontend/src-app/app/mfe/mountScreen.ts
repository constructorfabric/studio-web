/** Mounting a screen, in one place. */


import {
  screenDomain,
  FRONTX_ACTION_MOUNT_EXT,
  type MfeRegistry,
  type ScreenExtension,
} from '@gears-frontx/react';

/**
 * The registries with a mount still running — one at a time, because the
 * runtime does not do it.
 * A set of registries rather than one flag for the module
 */
const mounting = new WeakSet<MfeRegistry>();

interface Request {
  generation: number;
  extension: ScreenExtension;
}

const requests = new WeakMap<MfeRegistry, Request>();

export function isMountingScreen(registry: MfeRegistry): boolean {
  return mounting.has(registry);
}

/** Called when the screen domain attaches a root */

export function releaseMountLock(registry: MfeRegistry): void {
  mounting.delete(registry);
}

function converge(registry: MfeRegistry): void {
  const wanted = requests.get(registry)?.extension;
  if (!wanted) return;
  if (registry.getMountedExtensions(screenDomain.id).includes(wanted.id)) return;

  void mountScreen(registry, wanted).catch((error: unknown) => {
    console.warn(
      'Failed to restore the screen last asked for:',
      error instanceof Error ? error.message : String(error)
    );
  });
}

/** Mounts an extension into the screen domain, and nothing else. */

export async function mountScreen(
  registry: MfeRegistry,
  extension: ScreenExtension
): Promise<void> {
  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-5
  if (mounting.has(registry)) return;

  const generation = (requests.get(registry)?.generation ?? 0) + 1;
  requests.set(registry, { generation, extension });
  mounting.add(registry);

  const superseded = (): boolean => requests.get(registry)?.generation !== generation;

  try {
    await registry.executeActionsChain({
      action: {
        type: FRONTX_ACTION_MOUNT_EXT,
        target: screenDomain.id,
        payload: { subject: extension.id },
      },
    });
  } catch (error) {
    if (!superseded()) throw error;
  } finally {
    if (!superseded()) mounting.delete(registry);
  }
  if (superseded()) converge(registry);
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-5
}
