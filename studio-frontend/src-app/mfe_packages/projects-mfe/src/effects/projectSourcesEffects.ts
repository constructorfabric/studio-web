/**
 * A project's repositories, `sources[]` of its config, written after creation.
 *
 * The config is one AM metadata value written whole, so a change reads it,
 * replaces `sources` and writes everything else back as it was — the wizard
 * wrote it at creation (`wizardEffects.ts`), and the shell, the IDE session
 * and the backend read fields this module knows nothing about.
 */

import {
  AccountsApiService,
  PROJECT_CONFIG_TYPE,
  type ProjectConfig,
  type ProjectSource,
} from '@constructor-studio/mfe-shared';
import { apiRegistry, invalidateQueryCacheForApp, type FrontXApp } from '@gears-frontx/react';
import { sameRepository } from '../model/projectSources';

/**
 * Reads the project's config fresh, applies `change` to its sources and
 * writes the config back, with `source_git_url` dropped once it names no
 * attached repository. Resolves to the sources as written; a failed read or
 * write rejects, and the config is as it was.
 *
 * Last write wins. AM's metadata carries no version to send back, so two
 * people changing one project's sources at once lose one change; the fresh
 * read narrows that window, If-Match on AM metadata would close it.
 */
export async function writeProjectSources(
  app: FrontXApp,
  projectId: string,
  change: (sources: ProjectSource[]) => ProjectSource[]
): Promise<ProjectSource[]> {
  const accounts = apiRegistry.getService(AccountsApiService);
  const read = accounts.getTenantMetadata<ProjectConfig>({
    tenantId: projectId,
    metadataType: PROJECT_CONFIG_TYPE,
  });
  // `null`: never written. What is written then is the sources alone.
  const config = (await read.fetch({ staleTime: 0 }))?.value ?? {};
  const sources = change([...(config.sources ?? [])]);
  const next: ProjectConfig = { ...config, sources };
  // The project list shows `source_git_url` ahead of `sources[0]`
  // (`projectSubtitle`), so one naming a repository that is gone would keep
  // showing it.
  const gitUrl = next.source_git_url;
  if (gitUrl && !sources.some((source) => sameRepository(source.clone_url, gitUrl))) {
    delete next.source_git_url;
  }
  await accounts.putTenantMetadata<ProjectConfig>(projectId, PROJECT_CONFIG_TYPE).fetch(next);
  void invalidateQueryCacheForApp(app, read).catch((error: unknown) => {
    console.warn('[projects] sources written, the config not invalidated', error);
  });
  return sources;
}
