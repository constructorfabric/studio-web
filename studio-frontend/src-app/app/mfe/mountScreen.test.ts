import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionsChain, MfeRegistry } from '@gears-frontx/react';

const { SCREEN_DOMAIN, mockEmit } = vi.hoisted(() => ({
  SCREEN_DOMAIN: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
  mockEmit: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: { on: vi.fn(), emit: mockEmit },
  screenDomain: { id: SCREEN_DOMAIN },
}));

import { mountScreen } from './mountScreen';
import { occupancyOf } from './domainOccupancy';
import { outcomesOf } from './shellOutcomes';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';

const artifacts = {
  id: 'ext.project.artifacts',
  entry: 'entry.projects',
  presentation: { label: 'Artifacts', level: 'project', section: 'artifacts' },
} as unknown as StudioScreenExtension;

const editor = {
  id: 'ext.project.editor',
  entry: 'entry.editor',
  presentation: { label: 'Editor', level: 'project', placement: 'hidden' },
} as unknown as StudioScreenExtension;

/** A registry that mounts into the screen domain's occupancy and, like the runtime, answers through `next` or `fallback`. */
function registryThat(chain: () => Promise<void>): MfeRegistry {
  const registry = {
    executeActionsChain: vi.fn(async ({ action, next, fallback }: ActionsChain) => {
      const outcomes = outcomesOf(registry);
      try {
        await chain();
      } catch {
        await outcomes.failed.handleAction(fallback!.action.type, fallback!.action.payload);
        return;
      }
      const occupancy = occupancyOf(registry);
      for (const id of occupancy.mounted(SCREEN_DOMAIN)) occupancy.destroyed(SCREEN_DOMAIN, id);
      occupancy.created(SCREEN_DOMAIN, action.payload?.subject as string);
      await outcomes.done.handleAction(next!.action.type, next!.action.payload);
    }),
  } as unknown as MfeRegistry;
  return registry;
}

afterEach(() => vi.clearAllMocks());

describe('mountScreen', () => {
  it('mounts the extension into the screen domain, and says nothing else', async () => {
    const registry = registryThat(() => Promise.resolve());

    await mountScreen(registry, artifacts);

    expect(registry.executeActionsChain).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          target: SCREEN_DOMAIN,
          payload: { subject: 'ext.project.artifacts' },
        }),
      })
    );
    // The section belongs to the click that asked for this mount, and was
    // written before it began. Naming it here would name it on the far side of
    // an await, where a later click can no longer overrule it.
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('mounts a screen hidden from the tabs like any other', async () => {
    const registry = registryThat(() => Promise.resolve());

    await mountScreen(registry, editor);

    expect(occupancyOf(registry).mounted(SCREEN_DOMAIN)).toEqual([editor.id]);
  });

  it('lets the failure through, and names no section', async () => {
    const registry = registryThat(() => Promise.reject(new Error('no such entry')));

    // The runtime keeps the reason to itself: the failed reply says only that it failed.
    await expect(mountScreen(registry, artifacts)).rejects.toThrow();

    // A failed mount names no section: the screen it would have named is not on.
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
