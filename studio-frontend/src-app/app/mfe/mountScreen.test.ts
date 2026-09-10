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

const people = {
  id: 'ext.people',
  entry: 'entry.people',
  presentation: { label: 'People', level: 'organization' },
} as unknown as ScreenExtension;

function registryThat(chain: () => Promise<void>): MfeRegistry {
  return { executeActionsChain: vi.fn(chain) } as unknown as MfeRegistry;
}

afterEach(() => vi.clearAllMocks());

describe('mountScreen', () => {
  it('mounts the extension into the screen domain and names its section', async () => {
    const registry = registryThat(() => Promise.resolve());

    await mountScreen(registry, artifacts);

    expect(registry.executeActionsChain).toHaveBeenCalledWith({
      action: expect.objectContaining({
        target: SCREEN_DOMAIN,
        payload: { subject: 'ext.project.artifacts' },
      }),
    });
    expect(mockEmit).toHaveBeenCalledWith('app/context/project/section', {
      section: 'artifacts',
    });
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

  it('is ready again after a mount fails, and lets the failure through', async () => {
    const registry = registryThat(() => Promise.reject(new Error('no such entry')));

    await expect(mountScreen(registry, artifacts)).rejects.toThrow('no such entry');

    expect(isMountingScreen(registry)).toBe(false);
    // A failed mount names no section: the screen it would have named is not on.
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
