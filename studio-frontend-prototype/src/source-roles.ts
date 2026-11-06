/* ── What each of a project's sources is for (ADR-0060) ──────────────────────
 *
 * A project has one list of source repositories (`project.config`
 * `sources[]`, project-sources.ts) and no hidden main one. Two flags say
 * what a source is for besides being cloned, one source each:
 *
 *   - `gears_here`: "Create a gear" puts new gears here. It is what the
 *     separate project gear repository used to be; the backend folds an old
 *     one into the list.
 *   - `publish_here`: a published product.gdl goes here. Without one, Studio
 *     keeps the description's revisions only (ADR-0053).
 *
 * The description travels with its *home* source -- the one marked
 * `publish_here`, else the first read through a connection -- where its
 * `path(...)` sources resolve. Each revision pins every source the
 * description uses at a commit (its lock): a dev environment builds each
 * source's branch, a protected one only what the lock pins.
 *
 * Mirrors `studio-backend/src/project_sources.rs` (`description_home`,
 * `mark_only`) and `product/sources_lock.rs`: change them together. */

import { named, repoKey, type ProjectSource } from "./project-sources";

export type SourceFlag = "gears_here" | "publish_here";

/** One source of a revision as its lock pins it (`LockedSourceDto`). */
export interface LockedSource {
  id: string;
  /** `path` or `git`. */
  kind: string;
  /** `owner/name` of the project source it is; absent for another repository. */
  repository?: string | null;
  url: string;
  branch?: string | null;
  commit?: string | null;
}

/** `sources` with `flag` on the one checked out into `dir` and off on every
 *  other: a flag marks one source. `on: false` clears it there. */
export function withFlag(
  sources: readonly ProjectSource[] | undefined,
  dir: string,
  flag: SourceFlag,
  on: boolean,
): ProjectSource[] {
  const target = named(sources).find((n) => n.dir === dir)?.source;
  return (sources ?? []).map((s) => {
    const next: ProjectSource = { ...s };
    if (s === target && on) next[flag] = true;
    else delete next[flag];
    return next;
  });
}

/** The directory of the source the description travels with. */
export function descriptionHome(
  sources: readonly ProjectSource[] | undefined,
): string | null {
  const all = named(sources);
  const home =
    all.find((n) => n.source.publish_here) ??
    all.find((n) => !!n.source.connection_id) ??
    all[0];
  return home?.dir ?? null;
}

/** The lock's entries that are `source`'s repository. */
export function lockedFor(
  lock: readonly LockedSource[] | undefined,
  source: ProjectSource,
): LockedSource[] {
  const key = repoKey(source.clone_url);
  return (lock ?? []).filter((l) => !!key && repoKey(l.url) === key);
}

/** The commit the latest revision pins for `source`; `undefined` when the
 *  description does not use it, `null` when it does and pins nothing. */
export function pinnedCommit(
  lock: readonly LockedSource[] | undefined,
  source: ProjectSource,
): string | null | undefined {
  const found = lockedFor(lock, source);
  if (found.length === 0) return undefined;
  return found.find((l) => l.commit)?.commit ?? null;
}

/** How many components the catalogue found in `source`. */
export function componentsIn(
  components: readonly { repo: string }[] | null,
  source: ProjectSource,
): number | null {
  if (!components) return null;
  const want = source.full_path.trim().toLowerCase();
  return components.filter((c) => c.repo.trim().toLowerCase() === want).length;
}

/** One line of the Release step: a source the product uses, the branch a dev
 *  build takes and the commit a protected environment takes. */
export interface ReleaseSource {
  id: string;
  repository: string;
  kind: string;
  branch: string | null;
  pinned: string | null;
  /** Another repository than the project's: pinned by the description itself. */
  external: boolean;
}

/** The latest revision's lock as Release lines, the project's own sources
 *  first. One line per repository: several `path(...)` sources of the home
 *  repository are one. */
export function releaseSources(
  lock: readonly LockedSource[] | undefined,
): ReleaseSource[] {
  const out: ReleaseSource[] = [];
  for (const l of lock ?? []) {
    const repository =
      l.repository ??
      l.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
    if (
      out.some((o) => o.repository.toLowerCase() === repository.toLowerCase())
    )
      continue;
    out.push({
      id: l.id,
      repository,
      kind: l.kind,
      branch: l.branch ?? null,
      pinned: l.commit ?? null,
      external: !l.repository,
    });
  }
  return out.sort((a, b) => Number(a.external) - Number(b.external));
}

/** Whether a protected environment can build the revision: every project
 *  source it uses is pinned. */
export function protectedReady(lines: readonly ReleaseSource[]): boolean {
  return (
    lines.length > 0 &&
    lines.filter((l) => !l.external).every((l) => !!l.pinned)
  );
}

/** A commit as people read it. */
export function shortCommit(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "—";
}

/** What the server said it could not read (`UnreadableSource` in api.ts):
 *  `owner/repo`, or `project config` for the list of sources itself. */
export interface SourceUnreadable {
  source: string;
  reason: string;
}

/** What the server names when the project's config itself was not read. */
export const PROJECT_CONFIG_SOURCE = "project config";

/** Why `source` cannot be read, as a warning on its row; null when nothing
 *  is wrong that is known. The server's reason first ("source X unreadable:
 *  why"); else a connection the source names that the caller's list of
 *  connections no longer has -- deleted, or another person's own -- when
 *  that list was read (`connections` null: not read, so not judged). */
export function sourceWarning(
  source: ProjectSource | undefined,
  unreadable: readonly SourceUnreadable[] | null,
  connections: ReadonlySet<string> | null,
): string | null {
  if (!source) return null;
  const path = source.full_path.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  const said =
    unreadable?.find((u) => u.source.trim().replace(/^\/+|\/+$/g, "").toLowerCase() === path) ??
    unreadable?.find((u) => u.source === PROJECT_CONFIG_SOURCE);
  if (said) {
    return said.source === PROJECT_CONFIG_SOURCE
      ? `the project's sources could not be read: ${said.reason}`
      : `source ${source.full_path} unreadable: ${said.reason}`;
  }
  if (source.connection_id && connections && !connections.has(source.connection_id)) {
    return `source ${source.full_path} unreadable: its connection was deleted, or belongs to another user`;
  }
  return null;
}
