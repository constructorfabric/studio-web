/**
 * A screen's dictionary for one language, with English under it.
 *
 * `useScreenTranslations` registers only the current language, and `t()`
 * returns the raw key when that language lacks it — the registry's English
 * fallback never has an English dictionary to fall back to. Merging here puts
 * English under every key a locale file is missing, and under a language that
 * has no file at all.
 */

import { useState } from 'react';

export type TranslationModule = { default: Record<string, string> };
export type TranslationModules = Record<string, () => Promise<TranslationModule>>;

// TODO: next PR — delete the locale files that are English copies (every locale but en/ru outside connections-mfe); this merge already serves English.

export function loadScreenTranslations(modules: TranslationModules, directory: string) {
  return async (language: string): Promise<Record<string, string>> => {
    const english = modules[`${directory}/en.json`];
    const own = language === 'en' ? undefined : modules[`${directory}/${language}.json`];
    const [base, local] = await Promise.all([
      english?.(),
      own?.().catch((error) => {
        console.warn(`[screenTranslations] ${directory}/${language}.json failed to load`, error);
        return undefined;
      }),
    ]);
    return { ...base?.default, ...local?.default };
  };
}

/**
 * Whether the screen's dictionary has loaded at least once. A language change
 * loads it again and `isLoaded` is false meanwhile; this stays true, so a
 * first-load skeleton does not come back.
 */
export function useEverLoaded(isLoaded: boolean): boolean {
  const [everLoaded, setEverLoaded] = useState(isLoaded);
  if (isLoaded && !everLoaded) setEverLoaded(true);
  return everLoaded;
}
