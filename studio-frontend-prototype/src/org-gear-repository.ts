/* The organization's gear repository (ADR-0042 §2), as the Components page
 * and "Create a gear" read it. Pure rules behind `org-gear-repository-card.tsx`
 * and the scaffold modal, kept here for their tests. */

import type { Connection, RegistryOccurrence, RegistryProjectWalk } from "./api";

/** The connections that can hold the organization's gear repository, best
 *  first: GitHub ones (the only provider a scaffold writes through), the
 *  organization-scoped before the rest, which the server refuses. Only the
 *  organization's own (`orgId`, when known): one it inherits from the
 *  platform carries the platform's token, and the server refuses it
 *  (`CONNECTION_NOT_OWNED`). */
export function gearRepoConnections(connections: readonly Connection[], orgId?: string | null): Connection[] {
  const rank = (c: Connection) => (isOrganizationScope(c.scope) ? 0 : 1);
  return connections
    .filter((c) => c.provider === "github")
    .filter((c) => !orgId || !c.owner_tenant_id || c.owner_tenant_id === orgId)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

export function isOrganizationScope(scope: string | undefined | null): boolean {
  const s = (scope ?? "").trim().toLowerCase();
  return s === "organization" || s === "org" || s === "shared";
}

/** Why a connection will not do for the organization's gear repository, in
 *  the words the server refuses it with; null for one that will. */
export function connectionScopeWarning(c: Pick<Connection, "scope" | "label"> | undefined | null): string | null {
  if (!c) return null;
  if (isOrganizationScope(c.scope)) return null;
  if ((c.scope ?? "").trim().toLowerCase() === "personal") {
    return `“${c.label}” is a personal connection: its token is readable only by the person who added it, and the registry's background read cannot use it. Connect the repository on the organization with organization scope.`;
  }
  return `“${c.label}” is a workspace connection: readable only in that workspace, while the organization's gear repository is read by the background walk and written from every project. Connect the repository on the organization with organization scope.`;
}

/** `owner/name` from what a person typed (a URL, a `.git` suffix, slashes),
 *  or null when it is not one. The server normalizes the same way. */
export function normalizeRepo(input: string): string | null {
  const repo = input
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((p) => !p.trim()) || /\s/.test(repo)) return null;
  return repo;
}

/** The repository's page, for a link: the connection's host when it is a
 *  GitHub Enterprise one, else github.com. */
export function repoUrl(repo: string, connection?: Pick<Connection, "base_url"> | null): string {
  const base = (connection?.base_url ?? "").trim();
  // An API base (`https://api.github.com`, `https://ghe/api/v3`) is not the
  // site; only a plain host is used as is.
  const host =
    !base || /api\.github\.com/i.test(base)
      ? "https://github.com"
      : base.replace(/\/api\/v3\/?$/i, "").replace(/\/+$/, "");
  return `${host}/${repo}`;
}

/** Where a scaffold writes, as a person reads it: the sentence the modal
 *  states before anything is pushed. `target` is the server's answer
 *  (`project`, `organization`, `sources`), `repo` the repository. */
export function scaffoldTargetLine(target: string | null | undefined, repo: string | null | undefined): string {
  if (!repo) {
    return "Nowhere to write yet: connect a gear repository to this project, or set the organization's on its Components page.";
  }
  switch (target) {
    case "organization":
      return `Into the organization's gear repository ${repo}.`;
    case "project":
      return `Into this project's gear repository ${repo}.`;
    case "sources":
      return `Into this project's repository ${repo} (from its sources): it has no gear repository, and the organization has none set.`;
    default:
      return `Into ${repo}.`;
  }
}

/** Where an occurrence was found, for the registry's "Found in" line. */
export function occurrencePlace(o: Pick<RegistryOccurrence, "scope" | "project_name" | "project_id">): string {
  if (o.scope === "organization") {
    return `${o.project_name ? `${o.project_name} · ` : ""}organization gear repository`;
  }
  return o.project_name ?? o.project_id ?? "—";
}

/** What the last walk said of the organization's gear repository: its row
 *  among the projects' is keyed by the organization. */
export function gearRepoWalkLine(
  walks: readonly RegistryProjectWalk[],
  orgId: string | undefined,
): { text: string; failed: boolean; hint: string | null } | null {
  if (!orgId) return null;
  const w = walks.find((p) => p.project_id === orgId);
  if (!w) return null;
  const repo = w.repos[0];
  if (w.error || !repo) return { text: `not read: ${w.error ?? "no repository"}`, failed: true, hint: null };
  const when = w.at ? ` · ${new Date(w.at).toLocaleString()}` : "";
  if (repo.status === "failed") {
    return { text: `could not be read${when}: ${repo.error ?? "unknown error"}`, failed: true, hint: repo.hint ?? null };
  }
  const n = `${repo.components} component${repo.components === 1 ? "" : "s"}`;
  return { text: `${repo.status === "unchanged" ? "unchanged" : "read"}${when} · ${n}`, failed: false, hint: null };
}
