/* ── Rollups: what a workspace or a project CONTAINS ─────────────────────────
 *
 * The portfolio and the projects table named their rows and then said almost
 * nothing about them. These counts answer, in the row itself, which of them has
 * anything in it — so choosing where to go does not require opening three of
 * them to find out.
 *
 * ── This file used to compute them, and no longer does ───────────────────────
 *
 * It composed every row here: `tenantChildren` for a workspace, then
 * `docBindings` + `listArtifactNodes` + `workspaceSettings` for each project.
 * Three requests per row, from the browser. One of the three was the artifact
 * listing, which cannot narrow by payload and so walks the tenant's whole typed
 * node set on every call — 28,717 nodes and a p95 of 8.06 s on studio-dev. A
 * ten-project table asked for that ten times, and `limit=1` saved none of it.
 *
 * The composition moved to `GET /studio-organizations/v1/rollups`, which walks
 * the same sources once, on the server, beside them. What is left here is the
 * shape this portal wants and the two lines that render a count.
 *
 * The rules did not move because they were UI rules — they moved because they
 * are rules about the data, and the next portal inherits them now instead of
 * rewriting them:
 *
 *   * a count that is not known is `null`, never 0 — a zero that really means
 *     "the gear did not answer" tells somebody a project is empty;
 *   * one failure costs one number, not the row;
 *   * counts come from the store's `total`, never from `length`.
 */
import { api, type RollupRow } from "./api";

/** What one workspace contains. */
export interface WorkspaceRollup {
  /** Child tenants of type `project`. */
  projects: number | null;
}

/** What one project contains. */
export interface ProjectRollup {
  /** Files the scan has bound to a document type, or is still deciding about. */
  documents: number | null;
  /** Open detector verdicts across those documents. */
  findings: number | null;
  /** Repositories attached in the project's settings. */
  repos: number | null;
}

/** A project as the portfolio answer carries it: the three counts every screen
 *  reads, and the whole row for the projects table, which reads the rest. */
export type PortfolioProject = ProjectRollup & {
  name: string;
  parentId: string | null;
  row: RollupRow;
};

/** Every workspace and project the caller can see, counted, in ONE request.
 *
 *  Returns the rows as the server groups them: workspaces carry `projects`,
 *  projects carry the rest and name their parent. A caller that wants a tree
 *  builds it from `parentId` rather than asking again for parentage this call
 *  already walked. */
export async function portfolioRollups(
  token: string,
  /** Only this workspace and its projects — what one workspace's table needs. */
  workspaceId?: string,
): Promise<{
  workspaces: Map<string, WorkspaceRollup & { name: string }>;
  projects: Map<string, PortfolioProject>;
}> {
  const workspaces = new Map<string, WorkspaceRollup & { name: string }>();
  const projects = new Map<string, PortfolioProject>();
  const page = await api.rollups(token, undefined, workspaceId);
  for (const row of page.items ?? []) {
    if (row.kind === "workspace") {
      workspaces.set(row.id, { name: row.name, projects: row.projects ?? null });
    } else {
      projects.set(row.id, {
        name: row.name,
        parentId: row.parent_id ?? null,
        documents: row.documents ?? null,
        findings: row.findings ?? null,
        repos: row.repos ?? null,
        row,
      });
    }
  }
  return { workspaces, projects };
}

/** One project's counts, for a screen that shows a project rather than a list. */
export async function projectRollup(token: string, projectId: string): Promise<ProjectRollup> {
  const page = await api.rollups(token, projectId).catch(() => null);
  const row = page?.items?.[0];
  // No row is not an empty project: it is a project whose counts could not be
  // read, and every column says so.
  if (!row) return { documents: null, findings: null, repos: null };
  return {
    documents: row.documents ?? null,
    findings: row.findings ?? null,
    repos: row.repos ?? null,
  };
}

/** Render a rollup count. `—` for unknown, the number otherwise — including a
 *  real 0, which is a fact worth stating. */
export function rollupText(n: number | null): string {
  return n == null ? "—" : String(n);
}
