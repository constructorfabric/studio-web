/* ── Repository → artifact-graph sync, as a reusable runner ───────────────────
 *
 * Pulling a repository's issues, pull requests and files into the graph is a
 * background job: the caller enqueues it and polls the task to completion. Two
 * surfaces start that job — the Artifacts tab (next to the sources list) and
 * the project Overview (next to the sync status it reports) — so the enqueue,
 * the poll loop and the wording of the progress line live here once, and both
 * report exactly the same thing.
 */

import { api, type RepoEntry } from "./api";
import { errText } from "./format";
import { currentCursor, followRun, type RunEventPayload } from "./studio-events";

/** Where a sync's nodes are tagged: the parent workspace (so a workspace-level
 *  graph sees every project) and the project itself (so a project-level graph
 *  sees only its own). `projectId` also locates the IDE's shared checkout. */
export interface SyncScope {
  workspaceId: string;
  projectId: string;
}

/** How far a sync got, as the caller wants to show it. `running` keeps a Sync
 *  button disabled; `line` is ready to render. */
export interface SyncProgress {
  line: string;
  running: boolean;
  /** Nodes the backend reports as already stored in the graph. */
  stored: number;
}

/** The connector coordinates behind a clone URL — which driver to use, which
 *  repository, and (for GHE / self-hosted GitLab) which API root. */
export function parseRepoSource(
  url?: string,
): { provider: string; full_path: string; base_url?: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const provider = host.includes("github")
      ? "github"
      : host.includes("gitlab")
        ? "gitlab"
        : host.includes("bitbucket")
          ? "bitbucket"
          : "";
    if (!provider) return null;
    const full_path = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    // github.com uses api.github.com (the driver default); GHE and self-hosted
    // GitLab need their own API root.
    const base_url =
      host === "github.com"
        ? undefined
        : provider === "github"
          ? `${u.protocol}//${host}/api/v3`
          : `${u.protocol}//${host}`;
    return { provider, full_path, base_url };
  } catch {
    return null;
  }
}

/** Compact "what's been pulled so far", hiding zero counts. */
function counts(t: {
  issues: number;
  pull_requests: number;
  files: number;
  comments: number;
  commits: number;
}): string {
  return [
    t.issues ? `${t.issues} issues` : "",
    t.pull_requests ? `${t.pull_requests} PRs` : "",
    t.files ? `${t.files} files` : "",
    t.comments ? `${t.comments} comments` : "",
    t.commits ? `${t.commits} commits` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const DEADLINE_MS = 5 * 60 * 1000;

/** The counts an `artifact.ingest` run reports, as they arrive on an event. */
function countsOf(result: RunEventPayload["result"]): Parameters<typeof counts>[0] & {
  stored: number;
} {
  const n = (key: string) => Number((result as Record<string, unknown> | null)?.[key] ?? 0) || 0;
  return {
    issues: n("issues"),
    pull_requests: n("pull_requests"),
    files: n("files"),
    comments: n("comments"),
    commits: n("commits"),
    stored: n("stored"),
  };
}

/**
 * Sync one attached repository into the artifact graph and follow the job to
 * the end, reporting progress as it runs.
 *
 * `onProgress` is called for every state change — including the terminal one,
 * where `running` goes false. Rejected preconditions (an unsupported URL, a
 * source with no credential) are reported the same way rather than thrown:
 * they are things the user fixes on the sources list, not exceptions.
 */
export async function runRepoSync(
  token: string,
  repo: RepoEntry,
  scope: SyncScope,
  onProgress: (p: SyncProgress) => void,
): Promise<void> {
  const done = (line: string) => onProgress({ line, running: false, stored: 0 });

  const parsed = parseRepoSource(repo.url ?? undefined);
  if (!parsed) return done("unsupported source URL");
  if (!repo.token_ref) return done("no token — attach it from a connector");

  onProgress({ line: "queued…", running: true, stored: 0 });
  try {
    // The cursor is read BEFORE the enqueue: a run that fails in milliseconds
    // (a rejected credential, say) would otherwise be over before the stream is
    // open, and this is what replays those events.
    const cursor = await currentCursor(token);
    const { task_id } = await api.syncArtifacts(token, {
      provider: parsed.provider,
      secret_ref: repo.token_ref,
      repo_full_path: parsed.full_path,
      base_url: parsed.base_url,
      workspace_id: scope.workspaceId,
      project_id: scope.projectId,
      repo_dir: repo.target || repo.name,
    });
    // studio-tasks announces every transition of this run on studio-events, so
    // there is nothing to poll: the line below moves when the backend says so.
    const end = await followRun(
      token,
      task_id,
      (e) => {
        const c = countsOf(e.result);
        const phase = (e.phase || e.state).replace(/…$/, "");
        const line = counts(c);
        onProgress({
          line: `${phase}${line ? ` — ${line}` : ""}${c.stored ? ` · ${c.stored} in graph` : ""}…`,
          running: true,
          stored: c.stored,
        });
      },
      { fromSeq: cursor, timeoutMs: DEADLINE_MS },
    );
    const c = countsOf(end.result);
    if (end.state === "succeeded") {
      onProgress({ line: counts(c) || "done", running: false, stored: c.stored });
      return;
    }
    // `cancelled` too: somebody stopped the run from Background work, and
    // waiting for a state it will never leave is how you hang a UI.
    return done(end.error || end.summary || `sync ${end.state}`);
  } catch (e) {
    return done(errText(e));
  }
}
