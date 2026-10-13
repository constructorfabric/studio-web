/**
 * A project's repositories, `sources[]` of its config: which entries a change
 * adds or removes. Writing them is `effects/projectSourcesEffects.ts`.
 */

import type { ProjectSource } from '@constructor-studio/mfe-shared';

/**
 * A clone URL reduced to what names the repository: host and path, without
 * the scheme, credentials, a trailing slash or `.git`, in lower case. `null`
 * for anything without a scheme.
 *
 * The backend's `repository_key` (`studio-backend/src/project_sources.rs`)
 * gives the same key for a provider's clone URL. They part on what a provider
 * does not answer with: an explicit default port, a query or a fragment, which
 * the backend keeps in the key and `URL` drops. Change both together.
 */
export function repositoryKey(cloneUrl: string): string | null {
  try {
    const url = new URL(cloneUrl.trim());
    const path = url.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    return url.host && path ? `${url.host}/${path}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function sameRepository(a: string, b: string): boolean {
  const key = repositoryKey(a);
  return key !== null && key === repositoryKey(b);
}

/**
 * `sources` with `entries` appended. A repository already attached — through
 * any connection — is not attached twice: a second connection would sync a
 * second copy of it into the graph. `added` is what was actually appended.
 */
export function withSources(
  sources: readonly ProjectSource[],
  entries: readonly ProjectSource[]
): { sources: ProjectSource[]; added: ProjectSource[] } {
  const next = [...sources];
  const added: ProjectSource[] = [];
  for (const entry of entries) {
    if (next.some((source) => sameRepository(source.clone_url, entry.clone_url))) continue;
    next.push(entry);
    added.push(entry);
  }
  return { sources: next, added };
}

/** `sources` without the entry attached through that connection at that path. */
export function withoutSource(
  sources: readonly ProjectSource[],
  entry: Pick<ProjectSource, 'connection_id' | 'full_path'>
): ProjectSource[] {
  return sources.filter(
    (source) =>
      source.connection_id !== entry.connection_id || source.full_path !== entry.full_path
  );
}
