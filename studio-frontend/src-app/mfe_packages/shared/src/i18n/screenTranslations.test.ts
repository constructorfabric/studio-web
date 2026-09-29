import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { loadScreenTranslations, useEverLoaded, type TranslationModules } from './screenTranslations';

const DIR = './screens/list/i18n';

function modules(files: Record<string, Record<string, string>>): TranslationModules {
  return Object.fromEntries(
    Object.entries(files).map(([language, dict]) => [
      `${DIR}/${language}.json`,
      vi.fn(async () => ({ default: dict })),
    ])
  );
}

describe('loadScreenTranslations', () => {
  it('puts English under a key the locale file is missing', async () => {
    const load = loadScreenTranslations(
      modules({ en: { title: 'Projects', load_failed: 'Could not load' }, ru: { title: 'Проекты' } }),
      DIR
    );
    expect(await load('ru')).toEqual({ title: 'Проекты', load_failed: 'Could not load' });
  });

  it('answers a language with no file in English, not with nothing', async () => {
    const load = loadScreenTranslations(modules({ en: { title: 'Projects' } }), DIR);
    expect(await load('de')).toEqual({ title: 'Projects' });
  });

  it('reads English once for English', async () => {
    const files = modules({ en: { title: 'Projects' } });
    await loadScreenTranslations(files, DIR)('en');
    expect(files[`${DIR}/en.json`]).toHaveBeenCalledTimes(1);
  });

  it('keeps the locale value where both have the key', async () => {
    const load = loadScreenTranslations(
      modules({ en: { title: 'Projects' }, ru: { title: 'Проекты' } }),
      DIR
    );
    expect((await load('ru')).title).toBe('Проекты');
  });

  it('falls back to English when the locale import fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const files = modules({ en: { title: 'Projects' } });
    files[`${DIR}/de.json`] = vi.fn(async () => {
      throw new Error('chunk load failed');
    });
    const load = loadScreenTranslations(files, DIR);
    expect(await load('de')).toEqual({ title: 'Projects' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects when the English import fails', async () => {
    const files = modules({ ru: { title: 'Проекты' } });
    files[`${DIR}/en.json`] = vi.fn(async () => {
      throw new Error('chunk load failed');
    });
    const load = loadScreenTranslations(files, DIR);
    await expect(load('ru')).rejects.toThrow('chunk load failed');
  });
});

describe('useEverLoaded', () => {
  it('turns true with the first load and stays true while a language change loads again', () => {
    const { result, rerender } = renderHook(({ isLoaded }) => useEverLoaded(isLoaded), {
      initialProps: { isLoaded: false },
    });
    expect(result.current).toBe(false);
    rerender({ isLoaded: true });
    expect(result.current).toBe(true);
    rerender({ isLoaded: false });
    expect(result.current).toBe(true);
  });
});
