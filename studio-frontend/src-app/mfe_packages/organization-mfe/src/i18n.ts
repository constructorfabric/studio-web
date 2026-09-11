/**
 * This MFE's translations, on the framework's own screen-level i18n — the same
 * shape projects-mfe uses, so that both MFEs' screens are read the same way.
 * What this module adds is the namespace: call sites write `t('col_projects')`
 * while the binding asks the registry for
 * `screen.organization.workspaces:col_projects`.
 *
 * `HomeScreen` is deliberately not moved here: it still uses the scaffold's own
 * `shared/useScreenTranslations`, and rewriting the template's demo screen is
 * not part of this level's work.
 */

import { useCallback } from 'react';
import {
  useScreenTranslations,
  useTranslation,
  type UseScreenTranslationsReturn,
} from '@gears-frontx/react';

const SCREENSET = 'organization';
const OVERVIEW_SCREEN = 'overview';
const WORKSPACES_SCREEN = 'workspaces';

export const OVERVIEW_NAMESPACE = `screen.${SCREENSET}.${OVERVIEW_SCREEN}`;
export const WORKSPACES_NAMESPACE = `screen.${SCREENSET}.${WORKSPACES_SCREEN}`;

type JsonModule = { default: Record<string, string> };
type ModuleMap = Record<string, () => Promise<JsonModule>>;

const overviewModules = import.meta.glob('./screens/overview/i18n/*.json') as ModuleMap;
const workspacesModules = import.meta.glob('./screens/workspaces/i18n/*.json') as ModuleMap;

/**
 * A language with no file resolves to an empty dictionary rather than to
 * English — `t()` then falls through to the registry's own English fallback,
 * one fallback instead of a second one open-coded here.
 */
function loadFrom(modules: ModuleMap, directory: string) {
  return async (language: string): Promise<Record<string, string>> => {
    const importer = modules[`${directory}/${language}.json`];
    if (!importer) return {};
    return (await importer()).default;
  };
}

const loadOverviewTranslations = loadFrom(overviewModules, './screens/overview/i18n');
const loadWorkspacesTranslations = loadFrom(workspacesModules, './screens/workspaces/i18n');

/** Loads the overview's dictionary. One call, in `OverviewScreen`. */
export function useOverviewScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, OVERVIEW_SCREEN, loadOverviewTranslations);
}

/** Loads the workspaces list's dictionary. One call, in `WorkspacesScreen`. */
export function useWorkspacesScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, WORKSPACES_SCREEN, loadWorkspacesTranslations);
}

export type ScreenText = (
  key: string,
  params?: Record<string, string | number | boolean>
) => string;

function createText(namespace: string): () => ScreenText {
  return function useScreenText(): ScreenText {
    const { t } = useTranslation();
    return useCallback<ScreenText>((key, params) => t(`${namespace}:${key}`, params), [t]);
  };
}

export const useOverviewText = createText(OVERVIEW_NAMESPACE);
export const useWorkspacesText = createText(WORKSPACES_NAMESPACE);
