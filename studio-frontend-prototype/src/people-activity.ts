/* ── People in the organization's context: where each person works ─────────
 *
 * The organization's People page answers two different questions about a
 * person and a project, and keeps them apart:
 *
 *   CAN ACCESS — what the access config says. Under "roles" access it is the
 *     member's grants: a project-scoped grant names one project, an
 *     organization-wide grant reaches every project. Under "tenant" access
 *     every member reaches every project with their membership role, so
 *     "can access" says nothing about where somebody works.
 *
 *   ACTIVE IN — what was seen. Sources, each attributed to a person only
 *     through something that names them:
 *       - open pull requests a project's sync holds: the author and the
 *         reviewers, by the member the account is confirmed as (`user_id`)
 *         or by an account the person claimed (their aliases);
 *       - the project's Activity feed (checks and comments), whose `by` is an
 *         account login, matched the same way;
 *       - desktop sessions open on the project, by the sign-in subject;
 *       - Insight's pull requests authored and reviews given over the last
 *         90 days, per repository, for the person's git handles, mapped to
 *         the projects whose sources include that repository.
 *
 *     Studio IDE sessions are NOT a source: the session list carries no
 *     owner. Presence says who is online and where in the shell, which is a
 *     workspace name rather than a project, so it feeds "last seen" only.
 *
 * Pure: everything here is tested without a backend (people-activity.test.ts).
 */

import type { ActivityEvent, DesktopSession, OpenPullRequest, PersonAlias, PresenceEntry } from "./api";
import type { AccessConfig, AccessModel } from "./access";

/* ── Projects ───────────────────────────────────────────────────────────── */

export interface OrgProject {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  /** `new_gears` | `product` | `existing`, when the rollup said. */
  kind: string | null;
}

export interface WorkspaceColumns {
  id: string;
  name: string;
  projects: OrgProject[];
}

/** The matrix's columns: projects grouped by workspace, both by name. A
 *  workspace with no project has no column. */
export function matrixColumns(projects: readonly OrgProject[]): WorkspaceColumns[] {
  const by = new Map<string, WorkspaceColumns>();
  for (const p of projects) {
    const ws = by.get(p.workspaceId) ?? { id: p.workspaceId, name: p.workspaceName, projects: [] };
    ws.projects.push(p);
    by.set(p.workspaceId, ws);
  }
  const out = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const ws of out) ws.projects.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The address of a project's Team tab, which the portal's router follows. */
export function teamPath(project: Pick<OrgProject, "id" | "workspaceId">, orgId: string | null): string {
  const path = `/workspaces/${encodeURIComponent(project.workspaceId)}/projects/${encodeURIComponent(project.id)}/people`;
  return orgId ? `${path}?org=${encodeURIComponent(orgId)}` : path;
}

/* ── Can access ─────────────────────────────────────────────────────────── */

export interface ProjectAccess {
  projectId: string;
  roleKey: string;
  roleName: string;
  /** `project`: a grant on this project; `org`: an organization-wide grant;
   *  `tenant`: tenant access, where membership reaches everything. */
  via: "project" | "org" | "tenant";
}

const MEMBERSHIP_ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** What each project lets a person do, by project id. A project grant wins
 *  over an organization-wide one; with no access config the model is
 *  "tenant", as the access screen defaults it. */
export function accessOf(
  personId: string,
  membershipRole: string,
  cfg: Pick<AccessConfig, "model" | "roles" | "grants"> | null,
  projects: readonly Pick<OrgProject, "id">[],
): Map<string, ProjectAccess> {
  const out = new Map<string, ProjectAccess>();
  const model: AccessModel = cfg?.model ?? "tenant";
  if (model !== "roles") {
    const roleName = MEMBERSHIP_ROLE[membershipRole] ?? membershipRole;
    for (const p of projects)
      out.set(p.id, { projectId: p.id, roleKey: membershipRole, roleName, via: "tenant" });
    return out;
  }
  const roleName = (key: string) => cfg?.roles.find((r) => r.key === key)?.name ?? key;
  const mine = (cfg?.grants ?? []).filter((g) => g.subjectType === "member" && g.subjectId === personId);
  for (const g of mine.filter((g) => g.scopeType === "org"))
    for (const p of projects)
      out.set(p.id, { projectId: p.id, roleKey: g.roleKey, roleName: roleName(g.roleKey), via: "org" });
  const known = new Set(projects.map((p) => p.id));
  for (const g of mine.filter((g) => g.scopeType === "project"))
    if (known.has(g.scopeId))
      out.set(g.scopeId, { projectId: g.scopeId, roleKey: g.roleKey, roleName: roleName(g.roleKey), via: "project" });
  return out;
}

/* ── Who an account is ──────────────────────────────────────────────────── */

/** Kinds of alias that name a git account. */
const GIT_KINDS = new Set(["github", "gitlab", "bitbucket"]);

/** A git login as the sources spell it, folded for matching. Bots are not
 *  people, so they fold to nothing. */
export function foldLogin(login: string | null | undefined): string | null {
  const l = login?.trim().toLowerCase();
  if (!l || l.endsWith("[bot]")) return null;
  return l;
}

/** The git handles a person's aliases name: confirmed and claimed, not the
 *  ones Studio only suggested. */
export function gitHandles(aliases: readonly PersonAlias[]): { handle: string; kind: string; confirmed: boolean }[] {
  const out: { handle: string; kind: string; confirmed: boolean }[] = [];
  for (const a of aliases) {
    if (!GIT_KINDS.has(a.kind) || (a.confidence !== "confirmed" && a.confidence !== "claimed")) continue;
    const handle = foldLogin(a.external_id);
    if (handle && !out.some((h) => h.handle === handle))
      out.push({ handle, kind: a.kind, confirmed: a.confidence === "confirmed" });
  }
  return out;
}

/** Who an account or a sign-in is, across the organization. Built once. */
export interface Directory {
  /** Folded login → person id. A login two people claim is left out. */
  byLogin: Map<string, string>;
  /** Sign-in subject → person id. */
  bySubject: Map<string, string>;
}

export function directoryOf(
  people: readonly { id: string; aliases: readonly PersonAlias[]; subjects: readonly string[] }[],
): Directory {
  const byLogin = new Map<string, string>();
  const shared = new Set<string>();
  const bySubject = new Map<string, string>();
  for (const p of people) {
    for (const h of gitHandles(p.aliases)) {
      const held = byLogin.get(h.handle);
      if (held && held !== p.id) shared.add(h.handle);
      else byLogin.set(h.handle, p.id);
    }
    for (const s of p.subjects) bySubject.set(s, p.id);
  }
  for (const h of shared) byLogin.delete(h);
  return { byLogin, bySubject };
}

/** The person an account names: the member the server confirmed it as,
 *  else the one who claimed the login. */
export function personOf(dir: Directory, login: string | null | undefined, userId?: string | null): string | null {
  if (userId) return userId;
  const l = foldLogin(login);
  return l ? (dir.byLogin.get(l) ?? null) : null;
}

/* ── Active in ──────────────────────────────────────────────────────────── */

/** What one person did in one project. Every count is a fact seen; a project
 *  with no entry was not seen, which is not the same as "did nothing". */
export interface Activity {
  /** Open pull requests they authored. */
  pullsAuthored: number;
  /** Open pull requests they are a reviewer on. */
  pullsReviewing: number;
  /** Of those, the ones waiting on them now. */
  waitingOnThem: number;
  /** Activity-feed events (checks, comments) by their account. */
  events: number;
  /** Desktop sessions open on the project. */
  desktop: number;
  /** Insight, last 90 days: pull requests authored, merged, reviews given. */
  insightPrs: number;
  insightMerged: number;
  insightReviews: number;
  /** The newest moment any source dated, ISO. */
  lastAt: string | null;
}

export const NO_ACTIVITY: Activity = {
  pullsAuthored: 0,
  pullsReviewing: 0,
  waitingOnThem: 0,
  events: 0,
  desktop: 0,
  insightPrs: 0,
  insightMerged: 0,
  insightReviews: 0,
  lastAt: null,
};

/** person id → project id → activity. */
export type ActivityIndex = Map<string, Map<string, Activity>>;

const later = (a: string | null, b: string | null | undefined): string | null => {
  if (!b || Number.isNaN(Date.parse(b))) return a;
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
};

function bump(
  index: ActivityIndex,
  personId: string,
  projectId: string,
  add: Partial<Omit<Activity, "lastAt">>,
  at?: string | null,
) {
  const projects = index.get(personId) ?? new Map<string, Activity>();
  const cur = projects.get(projectId) ?? { ...NO_ACTIVITY };
  const next: Activity = { ...cur };
  for (const [k, v] of Object.entries(add) as [keyof Omit<Activity, "lastAt">, number][]) next[k] += v;
  next.lastAt = later(cur.lastAt, at);
  projects.set(projectId, next);
  index.set(personId, projects);
}

/** A project's open pull requests: who wrote them, who reviews them, and
 *  whom they wait on. */
export function addOpenPulls(index: ActivityIndex, dir: Directory, projectId: string, pulls: readonly OpenPullRequest[]) {
  for (const pr of pulls) {
    const author = pr.author ? personOf(dir, pr.author.login, pr.author.user_id) : null;
    if (author) bump(index, author, projectId, { pullsAuthored: 1 }, pr.updated_at ?? pr.created_at);
    const reviewing = new Set<string>();
    for (const r of pr.reviewers) {
      const who = personOf(dir, r.person.login, r.person.user_id);
      if (who && who !== author) reviewing.add(who);
    }
    for (const who of reviewing) bump(index, who, projectId, { pullsReviewing: 1 });
    const waiting = new Set<string>();
    if (pr.waiting === "review")
      for (const p of pr.waiting_on) {
        const who = personOf(dir, p.login, p.user_id);
        if (who) waiting.add(who);
      }
    for (const who of waiting) bump(index, who, projectId, { waitingOnThem: 1 });
  }
}

/** A project's Activity feed, from `since` on (ISO; null: all of it). */
export function addEvents(
  index: ActivityIndex,
  dir: Directory,
  projectId: string,
  events: readonly ActivityEvent[],
  since: string | null,
) {
  const from = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const at = e.recorded ? Date.parse(e.recorded) : Number.NaN;
    if (since && !(at >= from)) continue;
    const who = personOf(dir, e.by);
    if (who) bump(index, who, projectId, { events: 1 }, e.recorded);
  }
}

/** Desktops open on a project, by whoever's sign-in holds them. */
export function addDesktops(index: ActivityIndex, dir: Directory, projectId: string, sessions: readonly DesktopSession[]) {
  for (const s of sessions) {
    const who = dir.bySubject.get(s.member_id);
    if (who) bump(index, who, projectId, { desktop: 1 }, new Date(s.last_seen_epoch_secs * 1000).toISOString());
  }
}

/** Insight's per-handle, per-repository figures. */
export interface InsightFigure {
  login: string;
  /** `owner/name`, lower-case. */
  repo: string;
  prs: number;
  merged: number;
  reviews: number;
  last: string | null;
}

/** Repositories (`owner/name`, any case) → the projects whose sources hold them. */
export type RepoProjects = Map<string, string[]>;

export function repoProjects(projects: readonly { id: string; repos: readonly string[] }[]): RepoProjects {
  const out: RepoProjects = new Map();
  for (const p of projects)
    for (const raw of p.repos) {
      const r = raw.trim().replace(/\.git$/, "").toLowerCase();
      if (!r) continue;
      const list = out.get(r) ?? [];
      if (!list.includes(p.id)) list.push(p.id);
      out.set(r, list);
    }
  return out;
}

/** The repositories a project's config names, as `owner/name`: its sources,
 *  the git url it was seeded from, and the repository its build runs in. */
export function configRepos(config: {
  sources?: readonly { full_path?: string; clone_url?: string }[];
  source_git_url?: string;
  build?: { repo?: string };
} | null): string[] {
  if (!config) return [];
  const fromUrl = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      const path = new URL(url.trim()).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      return path.includes("/") ? path : null;
    } catch {
      return null;
    }
  };
  const out = [
    ...(config.sources ?? []).flatMap((s) => [s.full_path ?? null, fromUrl(s.clone_url)]),
    fromUrl(config.source_git_url),
    config.build?.repo ?? null,
  ]
    .filter((r): r is string => !!r && r.includes("/"))
    .map((r) => r.toLowerCase());
  return [...new Set(out)];
}

/** Insight's figures, on the projects their repositories belong to. A
 *  repository no project holds is not a project's activity, and is left to
 *  the person's totals. */
export function addInsight(index: ActivityIndex, dir: Directory, figures: readonly InsightFigure[], repos: RepoProjects) {
  for (const f of figures) {
    const who = personOf(dir, f.login);
    if (!who) continue;
    for (const projectId of repos.get(f.repo) ?? [])
      bump(index, who, projectId, { insightPrs: f.prs, insightMerged: f.merged, insightReviews: f.reviews }, f.last);
  }
}

/** How much a person did in a project, as one weight. Reviews and authored
 *  work count more than a comment; a desktop open on it counts like a pull
 *  request. Insight's 90 days are scaled down so a busy repository does not
 *  drown what the project's own sync saw. */
export function activityScore(a: Activity): number {
  return (
    a.pullsAuthored * 3 +
    a.pullsReviewing * 2 +
    a.events +
    a.desktop * 3 +
    Math.ceil(a.insightPrs / 2) +
    Math.ceil(a.insightReviews / 4)
  );
}

/** 0 (nothing seen) to 4, for a cell's shade. */
export type Intensity = 0 | 1 | 2 | 3 | 4;

export function intensityOf(a: Activity | null | undefined): Intensity {
  const s = a ? activityScore(a) : 0;
  if (s <= 0) return 0;
  if (s < 3) return 1;
  if (s < 10) return 2;
  if (s < 30) return 3;
  return 4;
}

/* ── One person on one project, and a row of them ───────────────────────── */

export interface PersonProject {
  project: OrgProject;
  access: ProjectAccess | null;
  activity: Activity | null;
  intensity: Intensity;
}

/** Every project for one person, each with what they may do and what they did. */
export function personProjects(
  projects: readonly OrgProject[],
  access: Map<string, ProjectAccess>,
  activity: Map<string, Activity> | undefined,
): PersonProject[] {
  return projects.map((project) => {
    const a = activity?.get(project.id) ?? null;
    return { project, access: access.get(project.id) ?? null, activity: a, intensity: intensityOf(a) };
  });
}

/** What the "Projects" cell shows: the projects that matter for this person,
 *  most active first, at most `max`, and how many more there are.
 *
 *  Under role-based access that is every project they can access (active or
 *  not) plus any they were active in without a grant. Under tenant access
 *  everyone can access everything, so it is the projects they were active in. */
export function projectStack(
  rows: readonly PersonProject[],
  model: AccessModel,
  max: number,
): { shown: PersonProject[]; more: number; total: number } {
  const relevant = rows.filter((r) => r.intensity > 0 || (model === "roles" && r.access !== null));
  const ordered = [...relevant].sort(
    (a, b) =>
      b.intensity - a.intensity ||
      (b.activity ? activityScore(b.activity) : 0) - (a.activity ? activityScore(a.activity) : 0) ||
      a.project.name.localeCompare(b.project.name),
  );
  return { shown: ordered.slice(0, max), more: Math.max(0, ordered.length - max), total: ordered.length };
}

/** A person's totals across projects, for the side panel. */
export function totals(activity: Map<string, Activity> | undefined): Activity {
  const out: Activity = { ...NO_ACTIVITY };
  for (const a of activity?.values() ?? []) {
    out.pullsAuthored += a.pullsAuthored;
    out.pullsReviewing += a.pullsReviewing;
    out.waitingOnThem += a.waitingOnThem;
    out.events += a.events;
    out.desktop += a.desktop;
    out.insightPrs += a.insightPrs;
    out.insightMerged += a.insightMerged;
    out.insightReviews += a.insightReviews;
    out.lastAt = later(out.lastAt, a.lastAt);
  }
  return out;
}

/* ── Last seen ──────────────────────────────────────────────────────────── */

/** When a person was last seen, in ms: the newest of what studio-user
 *  recorded, presence and their desktops. Undefined when nothing says. */
export function lastSeenOf(
  personId: string,
  recorded: number | null | undefined,
  dir: Directory,
  presence: readonly PresenceEntry[],
  desktops: readonly DesktopSession[],
): number | undefined {
  let best = recorded ?? undefined;
  const take = (ms: number) => {
    if (Number.isFinite(ms) && (best === undefined || ms > best)) best = ms;
  };
  for (const p of presence) if (p.user_id === personId || dir.bySubject.get(p.user_id) === personId) take(p.last_seen_ms);
  for (const d of desktops) if (dir.bySubject.get(d.member_id) === personId) take(d.last_seen_epoch_secs * 1000);
  return best;
}

/** Who is online now, by person id. */
export function onlineNow(dir: Directory, presence: readonly PresenceEntry[]): Set<string> {
  const out = new Set<string>();
  for (const p of presence) out.add(dir.bySubject.get(p.user_id) ?? p.user_id);
  return out;
}

/* ── Insight ────────────────────────────────────────────────────────────── */

/** A git login the statement may name: letters, digits, `-`, `_`, `.`.
 *  Anything else is left out rather than escaped. */
const SAFE_LOGIN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** The window Insight is asked about, in days. */
export const INSIGHT_DAYS = 90;

/** The two statements that read what these handles did: pull requests
 *  authored, and reviews given, per repository. Null when no handle is one
 *  the statement may name. */
export function insightStatements(handles: readonly string[], days = INSIGHT_DAYS): { authored: string; reviewed: string } | null {
  const safe = [...new Set(handles.map((h) => h.toLowerCase()).filter((h) => SAFE_LOGIN.test(h)))].sort();
  if (!safe.length) return null;
  const list = safe.map((h) => `'${h}'`).join(", ");
  const window = Math.max(1, Math.floor(days));
  return {
    authored:
      "SELECT lower(author_name) AS login, lower(concat(project_key, '/', repo_slug)) AS repo, " +
      "count() AS prs, countIf(state_norm = 'merged') AS merged, toString(max(created_on)) AS last " +
      `FROM silver.fct_git_pr WHERE lower(author_name) IN (${list}) ` +
      `AND created_on >= now() - INTERVAL ${window} DAY GROUP BY login, repo`,
    reviewed:
      "SELECT lower(reviewer_name) AS login, lower(concat(project_key, '/', repo_slug)) AS repo, " +
      "count() AS reviews, toString(max(reviewed_at)) AS last " +
      `FROM silver.fct_git_review WHERE lower(reviewer_name) IN (${list}) ` +
      `AND reviewed_at >= now() - INTERVAL ${window} DAY GROUP BY login, repo`,
  };
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Insight's warehouse writes `YYYY-MM-DD hh:mm:ss` in UTC. */
const isoOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = v.includes("T") ? v : `${v.replace(" ", "T")}Z`;
  return Number.isNaN(Date.parse(t)) ? null : new Date(t).toISOString();
};

/** The two answers, folded into one figure per login and repository. */
export function insightFigures(
  authored: readonly Record<string, unknown>[],
  reviewed: readonly Record<string, unknown>[],
): InsightFigure[] {
  const by = new Map<string, InsightFigure>();
  const at = (row: Record<string, unknown>) => {
    const login = String(row.login ?? "").toLowerCase();
    const repo = String(row.repo ?? "").toLowerCase();
    const key = `${login}\u0000${repo}`;
    const f = by.get(key) ?? { login, repo, prs: 0, merged: 0, reviews: 0, last: null };
    by.set(key, f);
    return f;
  };
  for (const r of authored) {
    const f = at(r);
    f.prs += num(r.prs);
    f.merged += num(r.merged);
    f.last = later(f.last, isoOf(r.last));
  }
  for (const r of reviewed) {
    const f = at(r);
    f.reviews += num(r.reviews);
    f.last = later(f.last, isoOf(r.last));
  }
  return [...by.values()].filter((f) => f.login && f.repo);
}

/** One person's Insight figures, summed over repositories, with the
 *  repositories they were in, busiest first. */
export function insightTotals(
  figures: readonly InsightFigure[],
  handles: readonly string[],
): { prs: number; merged: number; reviews: number; repos: { repo: string; prs: number; reviews: number }[] } {
  const mine = new Set(handles.map((h) => h.toLowerCase()));
  const repos = new Map<string, { repo: string; prs: number; reviews: number }>();
  let prs = 0;
  let merged = 0;
  let reviews = 0;
  for (const f of figures) {
    if (!mine.has(f.login)) continue;
    prs += f.prs;
    merged += f.merged;
    reviews += f.reviews;
    const r = repos.get(f.repo) ?? { repo: f.repo, prs: 0, reviews: 0 };
    r.prs += f.prs;
    r.reviews += f.reviews;
    repos.set(f.repo, r);
  }
  return {
    prs,
    merged,
    reviews,
    repos: [...repos.values()].sort((a, b) => b.prs + b.reviews - (a.prs + a.reviews) || a.repo.localeCompare(b.repo)),
  };
}

/* ── Recent activity ────────────────────────────────────────────────────── */

export interface RecentItem {
  projectId: string;
  what: string;
  subject: string;
  at: string | null;
}

/** The newest things a person did across projects' Activity feeds. */
export function recentFor(
  personId: string,
  dir: Directory,
  feeds: readonly { projectId: string; events: readonly ActivityEvent[] }[],
  max = 8,
): RecentItem[] {
  const out: RecentItem[] = [];
  for (const f of feeds)
    for (const e of f.events)
      if (personOf(dir, e.by) === personId)
        out.push({ projectId: f.projectId, what: e.event, subject: e.subject, at: e.recorded ?? null });
  return out
    .sort((a, b) => (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0))
    .slice(0, max);
}
