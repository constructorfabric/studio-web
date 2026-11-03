import { describe, expect, it } from 'vitest';
import { entryPointOf, placementOf, resolveLevelMenu, type StudioScreenExtension } from './screenLevels';

function screen(
  id: string,
  presentation: { level?: string; placement?: string; order?: number }
): StudioScreenExtension {
  return { id, entry: `entry.${id}`, presentation: { label: id, ...presentation } } as unknown as StudioScreenExtension;
}

const overview = screen('overview', { level: 'project', order: 10 });
const settings = screen('settings', { level: 'project', placement: 'settings', order: 1 });
// Lowest order of the level on purpose: if anything picked the entry point by
// order rather than from the menu, this is what it would pick.
const editor = screen('editor', { level: 'project', placement: 'hidden', order: 0 });
const people = screen('people', { level: 'organization', order: 10 });

describe('placementOf', () => {
  it('reads hidden as hidden', () => {
    expect(placementOf(editor)).toBe('hidden');
  });

  it('reads anything it does not know as main', () => {
    expect(placementOf(screen('odd', { placement: 'sidebar' }))).toBe('main');
  });
});

describe('resolveLevelMenu', () => {
  it('lists main items by order, then settings', () => {
    expect(resolveLevelMenu([settings, overview], 'project').map((ext) => ext.id)).toEqual([
      'overview',
      'settings',
    ]);
  });

  it('leaves a hidden screen out of every level', () => {
    const all = [overview, settings, editor, people];
    for (const level of ['organization', 'workspace', 'project'] as const) {
      expect(resolveLevelMenu(all, level)).not.toContain(editor);
    }
  });
});

describe('entryPointOf', () => {
  it('never opens a level on a hidden screen', () => {
    expect(entryPointOf([editor, settings, overview], 'project')).toBe(overview);
  });

  it('has no entry point for a level whose only screen is hidden', () => {
    expect(entryPointOf([editor], 'project')).toBeUndefined();
  });
});
