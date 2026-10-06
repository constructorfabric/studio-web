/* ── A project's repositories ────────────────────────────────────────────────
 *
 * One record, the project config's `sources[]`, in the shape the FrontX portal
 * writes and the backend reads (`studio-backend/src/project_sources.rs`):
 *
 *   { connection_id, full_path, clone_url, branch?, share_mode? }
 *
 * The prototype used to keep its own list in the workspace settings'
 * `repos[]`, which nothing else read: a project attached here had no code in
 * an IDE the other portal launched. Settings still hold what describes a
 * working copy rather than the project — `root_*`, `local` folders — and
 * nothing about its repositories.
 *
 * The screens still think in rows (`RepoEntry`: a name, a URL, a token
 * reference), so `asRows` derives those from the sources and the connections
 * they name. The name is the checkout directory, derived exactly as the
 * backend and the FrontX portal derive it, so a row, its clone and "open in
 * editor" agree on where its files are.
 */

import { api } from "./api";
import type { Connection, RemoteRepo, RepoEntry } from "./api";

/** How the IDE's "Share with the team" lands edits: straight onto the
 *  project's branch, or on a per-person branch through a pull request. */
export type ShareMode = "branch" | "pull_request";

export interface ProjectSource {
  connection_id: string;
  /** `owner/repo` on the provider. */
  full_path: string;
  clone_url: string;
  /** The branch to check out; the repository's default when absent. */
  branch?: string;
  /** How shared edits reach this repository; `branch` when absent. */
  share_mode?: ShareMode;
}

/** Whether shares through `connection` can open a pull request — GitHub only
 *  for now, so anything else is offered the branch alone. */
export function supportsPullRequests(connection: Pick<Connection, "provider"> | null | undefined): boolean {
  return connection?.provider === "github";
}

const FALLBACK_DIR = "source";

/** `acme/Studio.Web` → `studio-web`: the last segment, as a directory name. */
export function checkoutDir(fullPath: string): string {
  const last = fullPath.split("/").filter(Boolean).pop() ?? "";
  return last.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || FALLBACK_DIR;
}

/** The sources that clone, in order, each with its directory; a second
 *  source with the same last segment is `-2`, `-3`… */
export function named(sources: readonly ProjectSource[] | undefined): { source: ProjectSource; dir: string }[] {
  const taken = new Set<string>();
  return (sources ?? [])
    .filter((s) => s?.clone_url?.trim())
    .map((source) => {
      const base = checkoutDir(source.full_path ?? "");
      let dir = base;
      for (let n = 2; taken.has(dir); n += 1) dir = `${base}-${n}`;
      taken.add(dir);
      return { source, dir };
    });
}

/** What names a repository: host and path, case and `.git` aside. */
export function repoKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
    return path ? `${u.hostname}/${path}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Whether the config already lists the repository at `url`. */
export function hasRepository(sources: readonly ProjectSource[] | undefined, url: string): boolean {
  const key = repoKey(url);
  return !!key && (sources ?? []).some((s) => repoKey(s.clone_url) === key);
}

/** `sources` with the picked repositories added through `connection`, each
 *  shared as `shareMode`; one the config already lists is not added twice
 *  (and keeps the mode it has). */
export function withPicked(
  sources: readonly ProjectSource[] | undefined,
  connection: Pick<Connection, "id">,
  picks: readonly RemoteRepo[],
  shareMode: ShareMode = "branch",
): { sources: ProjectSource[]; added: number } {
  const out = [...(sources ?? [])];
  let added = 0;
  for (const r of picks) {
    if (hasRepository(out, r.clone_url)) continue;
    out.push({
      connection_id: connection.id,
      full_path: r.full_path,
      clone_url: r.clone_url,
      ...(r.default_branch ? { branch: r.default_branch } : {}),
      share_mode: shareMode,
    });
    added += 1;
  }
  return { sources: out, added };
}

/** `sources` without the one checked out into `dir`. */
export function without(sources: readonly ProjectSource[] | undefined, dir: string): ProjectSource[] {
  const gone = named(sources).find((n) => n.dir === dir)?.source;
  return (sources ?? []).filter((s) => s !== gone);
}

/** The provider a row says it comes from, by its connection. */
function providerOf(connection: Connection | undefined): RepoEntry["source"] {
  return connection?.provider === "github" ? "github" : connection?.provider === "gitlab" ? "gitlab" : "git";
}

/** The sources as the screens' rows: named by directory, with the
 *  connection's token reference where the connection is visible from here. */
export function asRows(
  sources: readonly ProjectSource[] | undefined,
  connections: readonly Connection[],
): RepoEntry[] {
  const byId = new Map(connections.map((c) => [c.id, c]));
  return named(sources).map(({ source, dir }) => {
    const connection = byId.get(source.connection_id);
    return {
      name: dir,
      source: providerOf(connection),
      url: source.clone_url,
      ...(source.branch ? { branch: source.branch } : {}),
      ...(source.share_mode ? { share_mode: source.share_mode } : {}),
      ...(connection ? { token_ref: connection.secret_ref } : {}),
    };
  });
}

/** A project's repositories as rows, from its config and the connections
 *  visible from it. A connection list that cannot be read leaves the rows
 *  without token references rather than without rows. */
export async function projectRepoRows(token: string, tenantId: string): Promise<RepoEntry[]> {
  const [config, connections] = await Promise.all([
    api.projectConfig(token, tenantId),
    api
      .connections(token, tenantId)
      .then((p) => p.items)
      .catch((): Connection[] => []),
  ]);
  return asRows(config?.sources, connections);
}
