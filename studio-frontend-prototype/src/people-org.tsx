/* ── The organization's People, in the organization's context ──────────────
 *
 * What people.tsx's `mode="org"` shows beside each person: the projects they
 * can access and the ones they were active in (people-activity.ts says which
 * is which and where each comes from), a person × project matrix, and a side
 * panel that drills into one person.
 *
 * Everything here is read-only and best-effort: each source that cannot be
 * read costs its own figures, and the screen says so rather than showing a
 * zero. Nothing is written — not the access config, not anyone's aliases.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  type ActivityEvent,
  type DesktopSession,
  type MemberIdentities,
  type OpenPullRequest,
  type PresenceEntry,
} from "./api";
import type { AccessModel } from "./access";
import { When } from "./data-table";
import { Modal } from "./modal";
import { portfolioRollups } from "./rollups";
import { TenantMark } from "./tenant-icon-view";
import { EmptyState, InfoPopover, KpiTile, StatusChip } from "./ui-standard";
import type { PersonRow } from "./org-people";
import { PersonPhoto, aliasKindLabel } from "./people-profile";
import {
  INSIGHT_DAYS,
  addDesktops,
  addEvents,
  addInsight,
  addOpenPulls,
  configRepos,
  directoryOf,
  gitHandles,
  insightFigures,
  insightStatements,
  insightTotals,
  matrixColumns,
  personOf,
  recentFor,
  repoProjects,
  teamPath,
  totals,
  type Activity,
  type ActivityIndex,
  type Directory,
  type InsightFigure,
  type Intensity,
  type OrgProject,
  type PersonProject,
} from "./people-activity";

/* ── Loading ────────────────────────────────────────────────────────────── */

/** How far back the Activity feed counts. */
const FEED_DAYS = 90;

/** What Insight answered, in one word, and why when it did not. */
export type InsightState =
  | { state: "loading" }
  | { state: "ok"; figures: InsightFigure[]; truncated: boolean }
  | { state: "no_handles" }
  | { state: "failed"; detail: string };

export interface OrgActivity {
  /** Null until the rollups answered; [] when they could not be read. */
  projects: OrgProject[] | null;
  /** Still reading the per-project and per-person sources. */
  loading: boolean;
  /** Identities by person id; a person missing could not be read. */
  identities: Map<string, MemberIdentities>;
  /** Whether identities could be read at all (`people.view`). */
  identitiesReadable: boolean;
  dir: Directory;
  index: ActivityIndex;
  feeds: { projectId: string; events: ActivityEvent[] }[];
  pulls: { projectId: string; items: OpenPullRequest[] }[];
  presence: PresenceEntry[];
  desktops: DesktopSession[];
  insight: InsightState;
  /** Sources that could not be read, in words. */
  missing: string[];
}

const EMPTY_DIR: Directory = { byLogin: new Map(), bySubject: new Map() };

/** Run `work` over `items`, at most `limit` at once. */
async function pool<T, R>(items: readonly T[], limit: number, work: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Everything the org People page needs to place people on projects. */
export function useOrgActivity(
  token: string,
  orgId: string | null,
  /** The organization's workspaces: its projects are theirs. */
  workspaces: readonly { id: string; name: string }[],
  people: readonly PersonRow[] | null,
): OrgActivity {
  const [state, setState] = useState<OrgActivity>(() => blank());
  const ids = useMemo(() => (people ?? []).map((p) => p.id).join(","), [people]);
  const wsKey = useMemo(() => workspaces.map((w) => `${w.id}=${w.name}`).join(","), [workspaces]);

  useEffect(() => {
    if (!orgId || people === null) return;
    let live = true;
    const since = new Date(Date.now() - FEED_DAYS * 86_400_000).toISOString();
    const missing: string[] = [];
    (async () => {
      // The caller's portfolio in one request; a workspace of this
      // organization it does not reach is asked for on its own.
      const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
      const projects: OrgProject[] = [];
      const take = (roll: Awaited<ReturnType<typeof portfolioRollups>>) => {
        for (const [id, p] of roll.projects)
          if (p.parentId && wsName.has(p.parentId) && !projects.some((x) => x.id === id))
            projects.push({
              id,
              name: p.name,
              workspaceId: p.parentId,
              workspaceName: wsName.get(p.parentId) ?? roll.workspaces.get(p.parentId)?.name ?? "Workspace",
              kind: p.row.project_kind ?? null,
            });
        return new Set(roll.workspaces.keys());
      };
      const all = await portfolioRollups(token).catch(() => null);
      const seenWs = all ? take(all) : new Set<string>();
      const rest = workspaces.filter((w) => !seenWs.has(w.id));
      let unread = 0;
      for (const one of await Promise.all(rest.map((w) => portfolioRollups(token, w.id).catch(() => null))))
        if (one) take(one);
        else unread++;
      if (unread) missing.push(`projects of ${unread} workspace(s)`);
      if (!live) return;
      setState((s) => ({ ...s, projects, loading: true }));

      // Who each person is elsewhere: their sign-ins and git accounts.
      let readable = true;
      const idents = await pool(people, 6, (p) =>
        api.memberIdentities(token, orgId, p.id).catch(() => {
          readable = false;
          return null;
        }),
      );
      const identities = new Map<string, MemberIdentities>();
      idents.forEach((i, n) => i && identities.set(people[n].id, i));
      if (!readable) missing.push("accounts of some people");
      const dir = directoryOf(
        people.map((p) => ({
          id: p.id,
          aliases: identities.get(p.id)?.aliases ?? [],
          subjects: (identities.get(p.id)?.logins ?? []).map((l) => l.subject),
        })),
      );

      // Per project: its repositories, open pull requests, feed and desktops.
      const per = await pool(projects, 4, async (p) => {
        const [config, pulls, feed, desk] = await Promise.all([
          api.projectConfig(token, p.id).catch(() => null),
          api.openPullRequests(token, p.id).then((r) => r.items, () => null),
          api.activityFeed(token, p.id).then((r) => r.items, () => null),
          api.desktopSessions(token, p.id).catch(() => null),
        ]);
        return { p, config, pulls, feed, desk };
      });
      const index: ActivityIndex = new Map();
      const feeds: OrgActivity["feeds"] = [];
      const pullsAll: OrgActivity["pulls"] = [];
      const desktops: DesktopSession[] = [];
      let lostPulls = 0;
      let lostFeeds = 0;
      for (const { p, pulls, feed, desk } of per) {
        if (pulls) {
          addOpenPulls(index, dir, p.id, pulls);
          pullsAll.push({ projectId: p.id, items: pulls });
        } else lostPulls++;
        if (feed) {
          addEvents(index, dir, p.id, feed, since);
          feeds.push({ projectId: p.id, events: feed.filter((e) => !e.recorded || e.recorded >= since) });
        } else lostFeeds++;
        if (desk) {
          addDesktops(index, dir, p.id, desk);
          desktops.push(...desk);
        }
      }
      if (lostPulls) missing.push(`open pull requests of ${lostPulls} project(s)`);
      if (lostFeeds) missing.push(`activity of ${lostFeeds} project(s)`);
      const repos = repoProjects(
        per.map(({ p, config, pulls }) => ({
          id: p.id,
          repos: [
            ...configRepos(config),
            ...(pulls ?? []).map((pr) => pr.repo ?? "").filter(Boolean),
          ],
        })),
      );

      const presence = await api.presenceOnline(token).then(
        (r) => r.items,
        () => {
          missing.push("presence");
          return [] as PresenceEntry[];
        },
      );
      if (!live) return;
      setState({
        projects,
        loading: true,
        identities,
        identitiesReadable: readable,
        dir,
        index,
        feeds,
        pulls: pullsAll,
        presence,
        desktops,
        insight: { state: "loading" },
        missing: [...missing],
      });

      // Insight last: the slowest, and only for people with a git account.
      const handles = [...dir.byLogin.keys()];
      const sql = insightStatements(handles);
      let insight: InsightState;
      if (!sql) insight = { state: "no_handles" };
      else {
        try {
          const [a, r] = await Promise.all([api.insightQuery(token, sql.authored), api.insightQuery(token, sql.reviewed)]);
          const figures = insightFigures(a.rows, r.rows);
          addInsight(index, dir, figures, repos);
          insight = { state: "ok", figures, truncated: a.truncated || r.truncated };
        } catch (e) {
          insight = { state: "failed", detail: e instanceof Error ? e.message : String(e) };
        }
      }
      if (!live) return;
      setState((s) => ({ ...s, index: new Map(index), insight, loading: false }));
    })();
    return () => {
      live = false;
    };
    // `ids` stands for `people`: a new array with the same people is the same load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, orgId, ids, wsKey]);

  return state;
}

function blank(): OrgActivity {
  return {
    projects: null,
    loading: true,
    identities: new Map(),
    identitiesReadable: true,
    dir: EMPTY_DIR,
    index: new Map(),
    feeds: [],
    pulls: [],
    presence: [],
    desktops: [],
    insight: { state: "loading" },
    missing: [],
  };
}

/* ── Words ──────────────────────────────────────────────────────────────── */

/** What a person did in a project, in a few words. Empty when nothing was seen. */
export function activityWords(a: Activity | null | undefined): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.pullsAuthored) parts.push(`${a.pullsAuthored} open PR${a.pullsAuthored === 1 ? "" : "s"}`);
  if (a.pullsReviewing) parts.push(`reviewing ${a.pullsReviewing}`);
  if (a.events) parts.push(`${a.events} event${a.events === 1 ? "" : "s"}`);
  if (a.desktop) parts.push("desktop open");
  if (a.insightPrs) parts.push(`${a.insightPrs} PR${a.insightPrs === 1 ? "" : "s"} in ${INSIGHT_DAYS}d`);
  if (a.insightReviews) parts.push(`${a.insightReviews} review${a.insightReviews === 1 ? "" : "s"} in ${INSIGHT_DAYS}d`);
  return parts.join(" · ");
}

const INTENSITY_WORD = ["not seen", "a little", "some", "a lot", "very active"] as const;

/** A role, as the few letters a matrix cell has room for. */
export function roleAbbr(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return name.slice(0, 3);
}

/** Open a project's Team tab: the portal's router follows the address. */
export function openTeam(project: OrgProject, orgId: string | null) {
  window.history.pushState(null, "", teamPath(project, orgId));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/* ── A project's mark, with the person's role on it ─────────────────────── */

function ProjectChip({
  token,
  row,
  model,
  onOpen,
}: {
  token: string;
  row: PersonProject;
  model: AccessModel;
  onOpen: () => void;
}) {
  const active = row.intensity > 0;
  const role = row.access?.roleName ?? "no role";
  const what = activityWords(row.activity);
  const title = [
    row.project.name,
    `${row.project.workspaceName}`,
    model === "roles" ? (row.access ? `can access as ${role}` : "no grant") : `${role} (tenant access)`,
    active ? `active in: ${what}` : "no activity seen",
  ].join("\n");
  return (
    <button
      type="button"
      className={`pp-proj ${active ? "active" : "access"} i${row.intensity}`}
      title={title}
      aria-label={`${row.project.name}: ${active ? `active, ${what}` : "can access"}; role ${role}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      data-person-project={row.project.id}
    >
      <TenantMark token={token} level="project" id={row.project.id} name={row.project.name} kind={row.project.kind} className="pp-proj-mark" />
      <span className="pp-proj-name">{row.project.name}</span>
      {row.access && <span className="pp-proj-role">{row.access.roleName}</span>}
    </button>
  );
}

/** The "Projects" cell: the projects that matter for this person, then "+N". */
export function ProjectStackCell({
  token,
  stack,
  model,
  projectCount,
  hasHandle,
  loading,
  onOpen,
  onMore,
}: {
  token: string;
  stack: { shown: PersonProject[]; more: number; total: number };
  model: AccessModel;
  projectCount: number;
  hasHandle: boolean;
  loading: boolean;
  onOpen: (p: PersonProject) => void;
  onMore: () => void;
}) {
  if (stack.total === 0) {
    if (loading) return <span className="sub">Reading activity…</span>;
    return (
      <span className="sub pp-none">
        {model === "roles" ? "not on a project" : `can access all ${projectCount} · no activity seen`}
        {!hasHandle && <span className="pp-nohandle"> · no git account linked</span>}
      </span>
    );
  }
  return (
    <div className="pp-stack">
      {stack.shown.map((r) => (
        <ProjectChip key={r.project.id} token={token} row={r} model={model} onOpen={() => onOpen(r)} />
      ))}
      {stack.more > 0 && (
        <button
          type="button"
          className="pp-more"
          onClick={(e) => {
            e.stopPropagation();
            onMore();
          }}
          title="Show every project"
        >
          +{stack.more}
        </button>
      )}
      {model === "tenant" && (
        <span className="sub pp-of" title="Under tenant access everyone can access every project">
          of {projectCount}
        </span>
      )}
    </div>
  );
}

/** What the marks mean: "can access" against "active in". */
export function ProjectLegend({ model }: { model: AccessModel }) {
  return (
    <div className="pp-legend" data-people-legend>
      {model === "roles" ? (
        <>
          <span className="pp-legend-item">
            <span className="pp-swatch access" /> can access (a role grant)
          </span>
          <span className="pp-legend-item">
            <span className="pp-swatch active" /> active in (seen working there)
          </span>
        </>
      ) : (
        <span className="pp-legend-item">
          <span className="pp-swatch active" /> active in — tenant access lets everyone into every project, so only
          where somebody was seen working is shown
        </span>
      )}
      <span className="pp-legend-item pp-legend-scale" aria-label="Activity intensity">
        less
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`pp-cellswatch i${i}`} />
        ))}
        more
      </span>
      <InfoPopover label="Where activity comes from">
        <p>
          <b>Can access</b> is the access config: role grants on a project or on the whole organization. Under tenant
          access every member can access every project.
        </p>
        <p>
          <b>Active in</b> is what was seen: open pull requests authored or reviewed, the project&apos;s Activity feed
          over the last {FEED_DAYS} days, desktops open on it, and Insight&apos;s pull requests and reviews over the last{" "}
          {INSIGHT_DAYS} days in the project&apos;s repositories. Git activity counts only for a git account the person
          claimed or confirmed on their Profile.
        </p>
      </InfoPopover>
    </div>
  );
}

/* ── Matrix ─────────────────────────────────────────────────────────────── */

export function PeopleMatrix({
  token,
  people,
  projects,
  model,
  rowsOf,
  onCell,
  onPerson,
}: {
  token: string;
  people: readonly PersonRow[];
  projects: readonly OrgProject[];
  model: AccessModel;
  rowsOf: (personId: string) => PersonProject[];
  onCell: (project: OrgProject) => void;
  onPerson: (p: PersonRow) => void;
}) {
  const groups = matrixColumns(projects);
  if (!projects.length)
    return <EmptyState title="No projects in this organization yet." body="People are placed on projects once there are some." />;
  return (
    <div className="pp-matrix-wrap" data-people-matrix>
      <table className="pp-matrix">
        <thead>
          <tr>
            <th rowSpan={2} className="pp-mx-corner">
              Person
            </th>
            {groups.map((g) => (
              <th key={g.id} colSpan={g.projects.length} className="pp-mx-ws" scope="colgroup">
                <span className="pp-mx-ws-name">
                  <TenantMark token={token} level="workspace" id={g.id} name={g.name} className="pp-mx-ws-mark" />
                  {g.name}
                </span>
              </th>
            ))}
          </tr>
          <tr>
            {groups.flatMap((g) =>
              g.projects.map((p, i) => (
                <th key={p.id} scope="col" className={`pp-mx-proj${i === 0 ? " ws-first" : ""}`} title={p.name}>
                  <TenantMark token={token} level="project" id={p.id} name={p.name} kind={p.kind} className="pp-mx-proj-mark" />
                  <span className="pp-mx-proj-name">{p.name}</span>
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {people.map((person) => {
            const byProject = new Map(rowsOf(person.id).map((r) => [r.project.id, r]));
            return (
              <tr key={person.id}>
                <th scope="row" className="pp-mx-person">
                  <button type="button" className="pp-mx-person-btn" onClick={() => onPerson(person)}>
                    <PersonPhoto name={person.name} url={person.avatarUrl} />
                    <span className="pp-mx-person-name">{person.name}</span>
                  </button>
                </th>
                {groups.flatMap((g) =>
                  g.projects.map((p, i) => {
                    const r = byProject.get(p.id);
                    const intensity: Intensity = r?.intensity ?? 0;
                    const granted = model === "roles" ? !!r?.access : true;
                    const role = r?.access?.roleName ?? "";
                    const what = activityWords(r?.activity);
                    const label = `${person.name} on ${p.name}: ${
                      granted ? (model === "roles" ? role : `${role}, tenant access`) : "no role"
                    }; ${intensity ? what : "no activity seen"}`;
                    return (
                      <td key={p.id} className={i === 0 ? "ws-first" : undefined}>
                        <button
                          type="button"
                          className={`pp-mx-cell i${intensity}${granted && model === "roles" ? " granted" : ""}`}
                          title={`${label}\nOpen ${p.name}'s Team`}
                          aria-label={label}
                          onClick={() => onCell(p)}
                          data-matrix-cell={`${person.id}:${p.id}`}
                        >
                          {model === "roles" ? (granted ? roleAbbr(role) : "") : intensity ? roleAbbr(role) : ""}
                          <span className="pp-mx-int" aria-hidden>
                            {INTENSITY_WORD[intensity]}
                          </span>
                        </button>
                      </td>
                    );
                  }),
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── One person ─────────────────────────────────────────────────────────── */

const STATE_WORD: Record<string, string> = {
  review: "waiting on review",
  author: "waiting on the author",
  merge: "ready to merge",
  draft: "draft",
  nobody: "no reviewer asked",
};

export function PersonPanel({
  token,
  person,
  describe,
  membershipLabel,
  model,
  rows,
  activity,
  lastSeenMs,
  online,
  onOpenProject,
  onClose,
}: {
  token: string;
  person: PersonRow;
  describe: string;
  membershipLabel: string;
  model: AccessModel;
  rows: PersonProject[];
  activity: OrgActivity;
  lastSeenMs: number | undefined;
  online: boolean;
  onOpenProject: (p: OrgProject) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const ident = activity.identities.get(person.id);
  const handles = gitHandles(ident?.aliases ?? []);
  const sum = totals(activity.index.get(person.id));
  const insight = activity.insight.state === "ok" ? insightTotals(activity.insight.figures, handles.map((h) => h.handle)) : null;
  const recent = recentFor(person.id, activity.dir, activity.feeds);
  const projectName = (id: string) => rows.find((r) => r.project.id === id)?.project.name ?? id.slice(0, 8);
  const open = (p: PersonProject) => onOpenProject(p.project);
  const relevant = rows
    .filter((r) => r.intensity > 0 || (model === "roles" && r.access))
    .sort((a, b) => b.intensity - a.intensity || a.project.name.localeCompare(b.project.name));
  const others = model === "tenant" ? rows.length - relevant.length : 0;
  // Open pull requests that wait on this person's review, oldest first.
  const waiting = activity.pulls
    .flatMap((p) =>
      p.items
        .filter(
          (pr) =>
            pr.waiting === "review" &&
            pr.waiting_on.some((w) => personOf(activity.dir, w.login, w.user_id) === person.id),
        )
        .map((pr) => ({ projectId: p.projectId, pr })),
    )
    .sort((a, b) => (b.pr.days_open ?? 0) - (a.pr.days_open ?? 0))
    .slice(0, 6);

  // On the body: the page's own stacking would put the shell's bar over it.
  return createPortal(
    <Modal label={`${person.name}`} onClose={onClose} backdropClassName="pp-panel-backdrop" cardClassName="pp-panel">
      <div className="pp-panel-head">
        <PersonPhoto name={person.name} url={person.avatarUrl} size="large" />
        <div className="grow">
          <h2 style={{ margin: 0 }}>{person.name}</h2>
          <div className="sub">{[membershipLabel, describe].filter(Boolean).join(" · ")}</div>
          <div className="pp-panel-status">
            {online ? (
              <StatusChip tone="ok">online now</StatusChip>
            ) : lastSeenMs != null ? (
              <span className="sub">
                Last seen <When iso={new Date(lastSeenMs).toISOString()} />
              </span>
            ) : (
              <span className="sub">Not seen yet</span>
            )}
            {handles.map((h) => (
              <StatusChip key={`${h.kind}:${h.handle}`} tone={h.confirmed ? "info" : "neutral"} title={h.confirmed ? "Confirmed" : "Claimed, not yet confirmed"}>
                {aliasKindLabel(h.kind)} · {h.handle}
              </StatusChip>
            ))}
          </div>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <section className="pp-panel-sec">
        <h3>Contact</h3>
        {person.email ? (
          <div>
            <a href={`mailto:${person.email}`}>{person.email}</a>{" "}
            <button
              type="button"
              className="ghost"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(person.email!)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <span className="sub">Only administrators see addresses.</span>
        )}
      </section>

      <section className="pp-panel-sec" data-person-projects>
        <h3>
          Projects and roles{" "}
          <span className="sub">
            {model === "roles" ? "role-based access" : `tenant access: can access all ${rows.length}`}
          </span>
        </h3>
        {relevant.length === 0 ? (
          <p className="sub">
            {activity.loading
              ? "Reading activity…"
              : model === "roles"
                ? "No role on any project."
                : "No activity seen in any project."}
          </p>
        ) : (
          <ul className="pp-panel-projects">
            {relevant.map((r) => (
              <li key={r.project.id}>
                <button type="button" className="pp-panel-proj" onClick={() => open(r)} title={`Open ${r.project.name}'s Team`}>
                  <TenantMark token={token} level="project" id={r.project.id} name={r.project.name} kind={r.project.kind} />
                  <span className="grow">
                    <span className="pp-panel-proj-name">{r.project.name}</span>
                    <span className="sub"> · {r.project.workspaceName}</span>
                    <span className="sub pp-panel-proj-what">{activityWords(r.activity) || "no activity seen"}</span>
                  </span>
                  {r.access && (
                    <StatusChip tone="neutral" title={r.access.via === "org" ? "Organization-wide grant" : undefined}>
                      {r.access.roleName}
                      {r.access.via === "org" ? " · org-wide" : ""}
                    </StatusChip>
                  )}
                  <StatusChip tone={r.intensity > 0 ? "ok" : "neutral"}>{r.intensity > 0 ? "active in" : "can access"}</StatusChip>
                </button>
              </li>
            ))}
          </ul>
        )}
        {others > 0 && relevant.length > 0 && <p className="sub">…and can access {others} more without activity seen.</p>}
      </section>

      <section className="pp-panel-sec" data-person-prs>
        <h3>Pull requests and reviews</h3>
        <div className="pp-kpis">
          <KpiTile label="Open PRs authored" value={sum.pullsAuthored} sub="as synced, now" />
          <KpiTile label="Reviewing" value={sum.pullsReviewing} sub="open PRs" />
          <KpiTile
            label="Review load"
            value={sum.waitingOnThem}
            sub="waiting on them"
            tone={sum.waitingOnThem >= 5 ? "danger" : sum.waitingOnThem >= 2 ? "warn" : undefined}
          />
        </div>
        {waiting.length > 0 && (
          <ul className="pp-panel-list">
            {waiting.map(({ projectId, pr }) => (
              <li key={pr.id}>
                {pr.url ? (
                  <a href={pr.url} target="_blank" rel="noreferrer">
                    #{pr.number} {pr.title}
                  </a>
                ) : (
                  <span>
                    #{pr.number} {pr.title}
                  </span>
                )}{" "}
                <span className="sub">
                  {projectName(projectId)} · {STATE_WORD[pr.waiting] ?? pr.waiting}
                  {pr.days_open != null ? ` · ${pr.days_open}d open` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <h4>
          Insight, last {INSIGHT_DAYS} days{" "}
          <InfoPopover label="About these figures">
            Pull requests authored and reviews given, from Constructor Insight&apos;s warehouse, for the git accounts this
            person claimed or confirmed. Repositories no project here holds still count toward the totals.
          </InfoPopover>
        </h4>
        {handles.length === 0 ? (
          <EmptyState
            title="No GitHub account linked."
            body={
              activity.identitiesReadable
                ? "Pull requests and reviews count once the person claims their git account on their Profile (Identities)."
                : "Their accounts could not be read: that takes the people.view permission."
            }
          />
        ) : activity.insight.state === "loading" ? (
          <p className="sub">Asking Insight…</p>
        ) : activity.insight.state === "failed" ? (
          <p className="sub">Insight could not be asked: {activity.insight.detail}</p>
        ) : insight ? (
          <>
            <div className="pp-kpis">
              <KpiTile label="PRs authored" value={insight.prs} />
              <KpiTile label="Merged" value={insight.merged} />
              <KpiTile label="Reviews given" value={insight.reviews} />
            </div>
            {insight.repos.length > 0 ? (
              <ul className="pp-panel-list">
                {insight.repos.slice(0, 6).map((r) => (
                  <li key={r.repo}>
                    <code>{r.repo}</code>{" "}
                    <StatusChip tone="neutral">{r.prs} PRs</StatusChip> <StatusChip tone="neutral">{r.reviews} reviews</StatusChip>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sub">Nothing under {handles.map((h) => h.handle).join(", ")} in the window.</p>
            )}
          </>
        ) : null}
      </section>

      <section className="pp-panel-sec" data-person-recent>
        <h3>Recent activity</h3>
        {recent.length === 0 ? (
          <p className="sub">
            {handles.length === 0 ? "Nothing attributed: no git account linked." : `Nothing in the last ${FEED_DAYS} days.`}
          </p>
        ) : (
          <ul className="pp-panel-list">
            {recent.map((e, i) => (
              <li key={i}>
                {e.what} <b>{e.subject}</b> <span className="sub">in {projectName(e.projectId)} · </span>
                <When iso={e.at} className="sub" />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The per-person metrics panels (cycle time, throughput, review
          spread) land here once the shared metrics module has a person
          scope; until then the counts above are the figures. */}
      <section className="pp-panel-sec pp-metrics-slot" data-person-metrics-slot>
        <h3>Metrics</h3>
        <p className="sub">Trends per person arrive with the organization&apos;s metrics panels.</p>
      </section>
    </Modal>,
    document.body,
  );
}
