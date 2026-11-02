import { describe, expect, it, vi } from 'vitest';
import { screenDomain, FRONTX_ACTION_MOUNT_EXT, type ActionsChain, type MfeRegistry } from '@gears-frontx/react';
import { mountScreen } from './mountScreen';
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

/**
 * A registry that answers like the runtime, through the chain's `next` or its
 * `fallback`. How a real one orders and records mounts is in
 * `domainRegistration.test.ts`.
 */
function registryThat(outcome: 'next' | 'fallback'): MfeRegistry {
  const registry = {
    executeActionsChain: vi.fn(async ({ next, fallback }: ActionsChain) => {
      const outcomes = outcomesOf(registry);
      if (outcome === 'next') await outcomes.done.handleAction(next!.action.type, next!.action.payload);
      else await outcomes.failed.handleAction(fallback!.action.type, fallback!.action.payload);
    }),
  } as unknown as MfeRegistry;
  return registry;
}

describe('mountScreen', () => {
  it.each([
    ['a section', artifacts],
    ['a screen hidden from the tabs', editor],
  ])('asks the screen domain to mount %s', async (_kind, extension) => {
    const registry = registryThat('next');

    await expect(mountScreen(registry, extension)).resolves.toBeUndefined();
    expect(registry.executeActionsChain).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { type: FRONTX_ACTION_MOUNT_EXT, target: screenDomain.id, payload: { subject: extension.id } },
      })
    );
  });

  it('rejects when the chain takes its fallback', async () => {
    const registry = registryThat('fallback');

    // The runtime keeps the reason to itself: the failed reply says only that it failed.
    await expect(mountScreen(registry, artifacts)).rejects.toThrow();
  });
});
