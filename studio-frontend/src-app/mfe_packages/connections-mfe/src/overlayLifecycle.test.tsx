/**
 * The overlay entry has to hand the re-anchored ui-kit theme to the base class
 * exactly the way the screenset entry does (`lifecycle.tsx`) and the sibling
 * overlay in projects-mfe does (`overlayLifecycle.tsx`).
 */
import { describe, expect, it, vi } from 'vitest';
import { anchorKitThemeOnShadowHost } from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';

const constructed = vi.hoisted(() => [] as unknown[][]);

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  StudioMfeLifecycle: class StudioMfeLifecycle {
    constructor(...args: unknown[]) {
      constructed.push(args);
    }
  },
}));

describe('connections-mfe dialog lifecycle', () => {
  it('hands the re-anchored kit theme to StudioMfeLifecycle', async () => {
    await import('./overlayLifecycle');

    expect(constructed).toHaveLength(1);
    expect(constructed[0][1]).toBe(anchorKitThemeOnShadowHost(kitTheme));
  });
});
