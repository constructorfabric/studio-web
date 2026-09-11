/**
 * Screen levels
 *
 * Constructor Studio has three levels — organization, workspace, project — and
 * the rail shows the items of the level in scope and nothing else. This module
 * is the whole of what the shell knows about that: how a screen extension
 * declares its level, and how the items of one level are ordered.
 */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-declared:p1
import type { ScreenExtension } from '@gears-frontx/react';

export const SCREEN_LEVELS = ['organization', 'workspace', 'project'] as const;

export type ScreenLevel = (typeof SCREEN_LEVELS)[number];

export type ScreenPlacement = 'main' | 'settings';

export interface LeveledPresentation {
  level?: string;
  placement?: string;
  section?: string;
}

export type LeveledScreenExtension = ScreenExtension & {
  presentation: ScreenExtension['presentation'] & LeveledPresentation;
};

const DEFAULT_LEVEL: ScreenLevel = 'organization';

function isScreenLevel(value: unknown): value is ScreenLevel {
  return typeof value === 'string' && (SCREEN_LEVELS as readonly string[]).includes(value);
}

// @cpt-begin:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-2
// @cpt-begin:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-3
export function levelOf(extension: ScreenExtension): ScreenLevel {
  const declared = (extension as LeveledScreenExtension).presentation.level;
  return isScreenLevel(declared) ? declared : DEFAULT_LEVEL;
}
// @cpt-end:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-3
// @cpt-end:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-2

export function levelAtLeast(level: ScreenLevel, minimum: ScreenLevel): boolean {
  return SCREEN_LEVELS.indexOf(level) >= SCREEN_LEVELS.indexOf(minimum);
}

// The MFE's own token for this item, when the item is a section of a screen.
export function sectionOf(extension: ScreenExtension): string | undefined {
  return (extension as LeveledScreenExtension).presentation.section;
}

export function placementOf(extension: ScreenExtension): ScreenPlacement {
  return (extension as LeveledScreenExtension).presentation.placement === 'settings'
    ? 'settings'
    : 'main';
}

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-entry-point:p1
export function entryPointOf(
  extensions: readonly ScreenExtension[],
  level: ScreenLevel,
): ScreenExtension | undefined {
  return resolveLevelMenu(extensions, level)[0];
}

export function resolveLevelMenu(
  extensions: readonly ScreenExtension[],
  level: ScreenLevel,
): ScreenExtension[] {
  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-1
  const ofLevel = extensions.filter((extension) => levelOf(extension) === level);
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-1

  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-4
  const byOrder = [...ofLevel].sort(
    (a, b) => (a.presentation.order ?? 999) - (b.presentation.order ?? 999),
  );
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-4

  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-5
  const main = byOrder.filter((extension) => placementOf(extension) === 'main');
  const settings = byOrder.filter((extension) => placementOf(extension) === 'settings');
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-5

  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-6
  return [...main, ...settings];
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-menu:p1:inst-6
}
