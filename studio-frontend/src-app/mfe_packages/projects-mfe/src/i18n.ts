/**
 * This MFE's translations, on the framework's own screen-level i18n.
 * This module adds one thing on top: the namespace. Call sites keep writing
 * `t('title')` while the binding asks the registry for
 * `screen.projects.list:title`, so all 72 locale files and every call site stay
 * as they are.
 */

import {
  useScreenTranslations,
  type UseScreenTranslationsReturn,
} from '@gears-frontx/react';
import { createText, loadScreenTranslations, type TranslationModules } from '@constructor-studio/mfe-shared';


const SCREENSET = 'projects';
const LIST_SCREEN = 'list';
const PROJECT_SCREEN = 'project';
const CREATE_SCREEN = 'create';
const WORKSPACE_SCREEN = 'workspace';
const SPECS_SCREEN = 'specs';
const SOURCES_SCREEN = 'sources';
const CONNECT_SCREEN = 'connect';
const UPLOAD_SCREEN = 'upload';

export const PROJECT_LIST_NAMESPACE = `screen.${SCREENSET}.${LIST_SCREEN}`;
export const PROJECT_NAMESPACE = `screen.${SCREENSET}.${PROJECT_SCREEN}`;
export const PROJECT_CREATE_NAMESPACE = `screen.${SCREENSET}.${CREATE_SCREEN}`;
export const WORKSPACE_CREATE_NAMESPACE = `screen.${SCREENSET}.${WORKSPACE_SCREEN}`;
export const SPECS_NAMESPACE = `screen.${SCREENSET}.${SPECS_SCREEN}`;
export const SOURCES_NAMESPACE = `screen.${SCREENSET}.${SOURCES_SCREEN}`;
export const SOURCES_CONNECT_NAMESPACE = `screen.${SCREENSET}.${CONNECT_SCREEN}`;
export const UPLOAD_NAMESPACE = `screen.${SCREENSET}.${UPLOAD_SCREEN}`;

type ModuleMap = TranslationModules;


const listModules = import.meta.glob('./screens/project-list/i18n/*.json') as ModuleMap;
const projectModules = import.meta.glob('./screens/project/i18n/*.json') as ModuleMap;
const createModules = import.meta.glob('./screens/project-create/i18n/*.json') as ModuleMap;
const workspaceModules = import.meta.glob('./screens/workspace-create/i18n/*.json') as ModuleMap;
const specsModules = import.meta.glob('./screens/project/sections/specs/i18n/*.json') as ModuleMap;
const sourcesModules = import.meta.glob('./screens/project/sections/sources/i18n/*.json') as ModuleMap;
const connectModules = import.meta.glob('./screens/sources-connect/i18n/*.json') as ModuleMap;
const uploadModules = import.meta.glob('./screens/project/upload/i18n/*.json') as ModuleMap;


const loadListTranslations = loadScreenTranslations(listModules, './screens/project-list/i18n');
const loadProjectTranslations = loadScreenTranslations(projectModules, './screens/project/i18n');
const loadCreateTranslations = loadScreenTranslations(createModules, './screens/project-create/i18n');
const loadWorkspaceTranslations = loadScreenTranslations(workspaceModules, './screens/workspace-create/i18n');
const loadSpecsTranslations = loadScreenTranslations(specsModules, './screens/project/sections/specs/i18n');
const loadSourcesTranslations = loadScreenTranslations(sourcesModules, './screens/project/sections/sources/i18n');
const loadConnectTranslations = loadScreenTranslations(connectModules, './screens/sources-connect/i18n');
const loadUploadTranslations = loadScreenTranslations(uploadModules, './screens/project/upload/i18n');

/** Loads the list screen's dictionary. One call, in `ProjectListScreen`. */
export function useProjectListScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, LIST_SCREEN, loadListTranslations);
}

/** Loads the project screen's dictionary. One call, in `ProjectScreen`. */
export function useProjectScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, PROJECT_SCREEN, loadProjectTranslations);
}

/**
 * Loads the New project wizard's dictionary. One call per root: `NewProjectWizard`,
 * and `SourcesConnectDialog`, which shares the wizard's repository picker.
 * The wizard is a second mounted root with its own shadow root, but the i18n
 * registry is the MFE app's and `init.ts` builds that once for any entry — so
 * this is the same registry the screens use, not a second one.
 */
export function useProjectCreateScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, CREATE_SCREEN, loadCreateTranslations);
}

/** Loads the New workspace form's dictionary. One call, in `NewWorkspaceForm`. */
export function useWorkspaceCreateScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, WORKSPACE_SCREEN, loadWorkspaceTranslations);
}

/** Loads the Specs section's dictionary. One call, in `SpecsSection`. */
export function useSpecsSectionTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, SPECS_SCREEN, loadSpecsTranslations);
}

/** Loads the Sources section's dictionary, in `SourcesSection` and its header actions. */
export function useSourcesSectionTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, SOURCES_SCREEN, loadSourcesTranslations);
}

/** Loads Connect source's own dictionary. One call, in `SourcesConnectDialog`. */
export function useSourcesConnectScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, CONNECT_SCREEN, loadConnectTranslations);
}

/** Loads Upload documents' dictionary, in its button and its panel. */
export function useUploadTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, UPLOAD_SCREEN, loadUploadTranslations);
}

export const useProjectListText = createText(PROJECT_LIST_NAMESPACE);
export const useProjectText = createText(PROJECT_NAMESPACE);
export const useProjectCreateText = createText(PROJECT_CREATE_NAMESPACE);
export const useWorkspaceCreateText = createText(WORKSPACE_CREATE_NAMESPACE);
export const useSpecsText = createText(SPECS_NAMESPACE);
export const useSourcesText = createText(SOURCES_NAMESPACE);
export const useSourcesConnectText = createText(SOURCES_CONNECT_NAMESPACE);
export const useUploadText = createText(UPLOAD_NAMESPACE);
