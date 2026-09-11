import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MfeRegistry, ScreenExtension } from '@gears-frontx/react';

const { SCREEN_DOMAIN, mockEmit } = vi.hoisted(() => ({
  SCREEN_DOMAIN: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
  mockEmit: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: { on: vi.fn(), emit: mockEmit },
  screenDomain: { id: SCREEN_DOMAIN },
}));

import { isMountingScreen, mountScreen, releaseMountLock } from './mountScreen';

const artifacts = {
  id: 'ext.project.artifacts',
  entry: 'entry.projects',
  presentation: { label: 'Artifacts', level: 'project', section: 'artifacts' },
} as unknown as ScreenExtension;

const timeline = {
  id: 'ext.project.timeline',
  entry: 'entry.projects',
  presentation: { label: 'Timeline', level: 'project', section: 'timeline' },
} as unknown as ScreenExtension;

const people = {
  id: 'ext.people',
  entry: 'entry.people',
  presentation: { label: 'People', level: 'organization' },
} as unknown as ScreenExtension;

/**
 * A registry that keeps a mount set, because the race is about who ends up in
 * it: `ExclusiveMountStrategy` evicts the sibling and mounts the subject at the
 * end of its own chain, so whichever chain finishes last owns the domain.
 */
function registryThat(chain: () => Promise<void>): MfeRegistry {
  const mounted: string[] = [];
  return {
    getMountedExtensions: () => mounted,
    executeActionsChain: vi.fn(async ({ action }: MountAction) => {
      await chain();
      mounted.splice(0, mounted.length, action.payload.subject);
    }),
  } as unknown as MfeRegistry;
}

interface MountAction {
  action: { payload: { subject: string } };
}

afterEach(() => vi.clearAllMocks());

describe('mountScreen', () => {
  it('mounts the extension into the screen domain, and says nothing else', async () => {
    const registry = registryThat(() => Promise.resolve());

    await mountScreen(registry, artifacts);

    expect(registry.executeActionsChain).toHaveBeenCalledWith({
      action: expect.objectContaining({
        target: SCREEN_DOMAIN,
        payload: { subject: 'ext.project.artifacts' },
      }),
    });
    // The section belongs to the click that asked for this mount, and was
    // written before it began. Naming it here would name it on the far side of
    // an await, where a later click can no longer overrule it.
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // `ExclusiveMountStrategy` reads the mounted list once and then awaits, so two
  // overlapping mounts unmount the same sibling and both mount. The name says
  // exclusive; the code does not serialize. This is where that is made true.
  it('drops a mount that overlaps one already running', async () => {
    let release = (): void => undefined;
    const registry = registryThat(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = mountScreen(registry, artifacts);
    expect(isMountingScreen(registry)).toBe(true);

    await mountScreen(registry, people);

    expect(registry.executeActionsChain).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('is ready again once the running mount settles', async () => {
    const registry = registryThat(() => Promise.resolve());

    await mountScreen(registry, artifacts);

    expect(isMountingScreen(registry)).toBe(false);
    await mountScreen(registry, people);
    expect(registry.executeActionsChain).toHaveBeenCalledTimes(2);
  });

  // The state is the registry's, not the module's: one registry mounting must
  // not make another look busy.
  it('does not let one registry block another', async () => {
    const busy = registryThat(() => new Promise<void>(() => undefined));
    const other = registryThat(() => Promise.resolve());

    void mountScreen(busy, artifacts);

    expect(isMountingScreen(busy)).toBe(true);
    expect(isMountingScreen(other)).toBe(false);
    await mountScreen(other, people);
    expect(other.executeActionsChain).toHaveBeenCalledTimes(1);
  });

  // What the shell calls when the screen domain attaches a root. The mount that
  // was going into the old one is doomed, and must not keep the new one out —
  // in development StrictMode makes attach/detach/attach the normal path.
  it('lets a fresh root mount even while the doomed one is still in flight', async () => {
    let release = (): void => undefined;
    const registry = registryThat(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    void mountScreen(registry, artifacts);
    expect(isMountingScreen(registry)).toBe(true);

    releaseMountLock(registry);
    void mountScreen(registry, people);

    expect(registry.executeActionsChain).toHaveBeenCalledTimes(2);
    release();
  });

  // The mount that was replaced cannot be called off, so it reaches the domain
  // last and takes it. What it cannot do is keep it.
  it('puts back the screen asked for last when an abandoned mount takes the domain', async () => {
    const releases: Array<() => void> = [];
    const registry = registryThat(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );

    const doomed = mountScreen(registry, artifacts);
    releaseMountLock(registry);
    const current = mountScreen(registry, people);

    releases[1]();
    await current;
    expect(registry.getMountedExtensions('any')).toEqual([people.id]);

    // The abandoned one lands afterwards and takes the domain with it.
    releases[0]();
    await doomed;
    expect(registry.executeActionsChain).toHaveBeenCalledTimes(3);

    releases[2]();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.getMountedExtensions('any')).toEqual([people.id]);
  });

  it('asks for nothing more when the domain already holds what was asked for', async () => {
    const releases: Array<() => void> = [];
    const registry = registryThat(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );

    const doomed = mountScreen(registry, artifacts);
    releaseMountLock(registry);
    const current = mountScreen(registry, people);

    // This time the abandoned mount lands first, so the one that replaced it
    // has the last word on its own.
    releases[0]();
    await doomed;
    releases[1]();
    await current;

    expect(registry.executeActionsChain).toHaveBeenCalledTimes(2);
    expect(registry.getMountedExtensions('any')).toEqual([people.id]);
  });

  // Three deep, landing newest-first so every earlier mount reaches the domain
  // after the one that replaced it. Whatever the order, the domain is left
  // holding the screen asked for last.
  it('settles on the screen asked for last, however the overlaps land', async () => {
    const releases: Array<() => void> = [];
    const registry = registryThat(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );

    const first = mountScreen(registry, artifacts);
    releaseMountLock(registry);
    const second = mountScreen(registry, people);
    releaseMountLock(registry);
    const third = mountScreen(registry, timeline);

    releases[2]();
    await third;
    releases[1]();
    await second;
    releases[0]();
    await first;

    // Let every mount those landings asked for run to the end as well.
    let settled = 3;
    for (let round = 0; round < 20 && settled < releases.length; round += 1) {
      while (settled < releases.length) releases[settled++]();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(registry.getMountedExtensions('any')).toEqual([timeline.id]);
    expect(isMountingScreen(registry)).toBe(false);
  });

  it('leaves the lock with the mount that took over', async () => {
    const releases: Array<() => void> = [];
    const registry = registryThat(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );

    const doomed = mountScreen(registry, artifacts);
    releaseMountLock(registry);
    void mountScreen(registry, people);

    releases[0]();
    await doomed;

    expect(isMountingScreen(registry)).toBe(true);
  });

  // And a failure it is too late to act on is not the caller's to handle:
  // `enterScreen` rolls the project context back on a rejection, which would
  // land on the navigation that replaced this one.
  it('keeps the failure of a superseded mount from its caller', async () => {
    const settlers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const registry = registryThat(
      () =>
        new Promise<void>((resolve, reject) => {
          settlers.push({ resolve, reject });
        })
    );

    const doomed = mountScreen(registry, artifacts);
    releaseMountLock(registry);
    const current = mountScreen(registry, people);

    settlers[1].resolve();
    await current;

    settlers[0].reject(new Error('no such entry'));
    await expect(doomed).resolves.toBeUndefined();
  });

  it('is ready again after a mount fails, and lets the failure through', async () => {
    const registry = registryThat(() => Promise.reject(new Error('no such entry')));

    await expect(mountScreen(registry, artifacts)).rejects.toThrow('no such entry');

    expect(isMountingScreen(registry)).toBe(false);
    // A failed mount names no section: the screen it would have named is not on.
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
