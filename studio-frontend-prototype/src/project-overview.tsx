/* ── Project Overview — the project manager's home ───────────────────────────
 *
 * The one screen that answers "how is this project doing?", top to bottom:
 *
 *   1. A header with ONE verdict -- On track, At risk or Blocked -- its main
 *      reason in a phrase, and ONE primary action: the next step of the path
 *      (Open IDE once the path is done). The rules are
 *      `project-overview-model.ts` (projectSignals, projectVerdict).
 *   2. The path as a strip, one row (project-path-view.tsx): the current step
 *      outlined, each step's line on hover or click.
 *   3. Metrics: "This project now" (releases and where each environment's
 *      version sits, spec health, the team), then the shared metrics board
 *      (metrics-board.tsx) scoped to the project, without the panels only an
 *      organization's overview fills.
 *   4. Needs attention, beside it: what waits on the PM or the team, one
 *      sentence and one action a row. Stuck pull requests open their list
 *      (pull-requests-waiting.tsx) in place.
 *   5. Recent activity: the newest five rows of the Activity feed.
 *
 * Detail lives on its own tab: the spec pipeline by type and the findings are
 * on Specs, kits on Components, artifacts on Artifacts.
 *
 * Reads, each on its own so a slow one never holds the screen:
 *   sources       project-sources.ts (the repositories) and the artifact
 *                 graph's repo nodes (synced or not; comment threads waiting)
 *   path          project-path-view.tsx readPathFacts
 *   rollup        studio-organizations /rollups (spec health, open threads)
 *   health        studio-organizations /overview, this project's line
 *                 (a refused connection, stuck pull requests, a quiet project)
 *   pull requests studio-artifact-ingest /open-pull-requests
 *   deployments   studio-environments /deployments
 *   activity      studio-artifact-ingest's Activity feed
 *   team          the organization's members the project's access reaches (org-people.ts)
 *   studio        the IDE session for this project, launched from here
 *
 * A source that does not answer is named under Needs attention, never shown
 * as a confident zero. */

import { HeaderIcon } from "./tenant-icon-view";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { projectTeam } from "./org-people";
import type {
  ActivityEvent,
  ArtifactNode,
  Deployment,
  Me,
  OpenPullRequest,
  OrgProjectHealth,
  ProjectConfig,
  RepoEntry,
  RollupRow,
  StudioSession,
  User,
} from "./api";
import { findRepoNode } from "./artifact-sync";
import { projectRepoRows } from "./project-sources";
import { relTime } from "./format";
import { MetricsBoard } from "./metrics-board";
import type { PanelTarget } from "./metrics-model";
import { MetricPanel, type TargetLabels } from "./metrics-panels";
import { OpenInDesktop } from "./open-in-desktop";
import {
  lastDeploy,
  nextStep,
  projectSignals,
  projectVerdict,
  recentActivity,
  specHealthPanel,
  teamPanel,
  versionsByEnvironment,
  type Signal,
  type SignalTarget,
} from "./project-overview-model";
import { projectPath, type PathFacts } from "./project-path";
import { ProjectPath, readPathFacts } from "./project-path-view";
import { PullRequestsWaiting } from "./pull-requests-waiting";
import { EmptyState, InfoPopover, PageHeader, StatusChip, type Tone } from "./ui-standard";

/** The sections of an open project. Lives here because Overview is the screen
 *  that links to all of them; the shell's rail renders the list.
 *
 * The names and the order are the product's, not ours. Read off the shipped
 * project-sidebar on 2026-09-17, which lists:
 *
 *     Overview · Components · Artifacts · Specs · Sources · Findings ·
 *     Activity · Timeline · Team · Project settings
 *
 * A prototype that calls the same screen "Spec Quality", or "Documents" where
 * the product says "Specs", is a prototype of a different product.
 *
 * Renamed rather than rebuilt, screens unchanged: "kits" is Components,
 * "people" is Team, "documents" is Specs. Timeline had no screen behind it
 * and Automation stored a trust ramp nothing read, so both were removed
 * (2026-11-03): a tab is in the list when it does something. Builds and
 * Deploys became one Releases tab (ADR-0056 §4); their old ids still open it
 * (MOVED_PROJECT_TABS).
 *
 * SOURCES was ours first and the product has since grown it, in the same place
 * and under the same name — worth knowing before anyone "aligns" it away.
 *
 * FINDINGS IS NOT A SECTION HERE, and that is the one deliberate departure.
 * Every finding is about a document, carries that document's node id as its
 * subject, and is unreadable without it — the product's own Findings table
 * spends a whole column re-stating which document each row belongs to. So the
 * Specs list carries the count and the document carries its findings.
 * Reintroducing it as a section means reintroducing that column. */
export type ProjTab =
  | "overview"
  | "issues"
  | "specs"
  | "model"
  | "components"
  | "parts"
  | "releases"
  | "tests"
  | "kits"
  | "artifacts"
  | "sources"
  | "connections"
  | "activity"
  | "people"
  /** A tab the domain model adds (level-tabs.ts). */
  | `type:${string}`;

/** What the dashboard needs to know about the project it is showing — the
 *  project tenant, plus the organization it hangs under. */
export interface OverviewProject {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  self_managed?: boolean;
}

/** A read that may fail because its gear is not deployed (or answers 404 from
 *  outside a self-managed subtree): null, and the label named on screen -- a
 *  missing gear is not "zero of them". */
async function soft<T>(label: string, p: Promise<T>, misses: Set<string>): Promise<T | null> {
  try {
    return await p;
  } catch {
    misses.add(label);
    return null;
  }
}

/** The organization board's panels that only the organization's overview
 *  fills, or that rank workspaces: not a project's. */
const ORG_ONLY = ["waiting-on-nobody", "spec-health", "idle", "spend-by-workspace"];

/** Where a panel opens, in a project's words. Spend has no project tab. */
const LABELS: TargetLabels = {
  projects: "Sources",
  people: "Team",
  environments: "Releases",
  releases: "Releases",
  reports: "Activity",
  specs: "Specs",
  costs: null,
  tasks: null,
};
const PANEL_TAB: Partial<Record<PanelTarget, ProjTab>> = {
  projects: "sources",
  people: "people",
  environments: "releases",
  releases: "releases",
  reports: "activity",
  specs: "specs",
};

const LEVEL_TONE: Record<Signal["level"], string> = { blocked: "danger", risk: "warn", info: "info" };
const BUILD_TONE: Record<string, Tone> = { passed: "ok", failed: "danger", running: "running", queued: "neutral" };

/* ── The dashboard ── */

export function ProjectOverview({
  token,
  project,
  onOpenTab,
  onOpenStudio,
}: {
  token: string;
  project: OverviewProject;
  onOpenTab: (tab: ProjTab) => void;
  /** Launch (or attach to) this project's IDE session and open it as a space. */
  onOpenStudio: () => void;
}) {
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [repoNodes, setRepoNodes] = useState<ArtifactNode[]>([]);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  /* The CANONICAL person id (`GET /me`), not the token subject: the IDE signs
     its comments with this one, and the sync credits threads to it. */
  const [meSubject, setMeSubject] = useState<string | null>(null);
  // undefined: reading; null: could not be read.
  const [path, setPath] = useState<PathFacts | null | undefined>(undefined);
  const [rollup, setRollup] = useState<RollupRow | null | undefined>(undefined);
  const [health, setHealth] = useState<OrgProjectHealth | null | undefined>(undefined);
  const [pulls, setPulls] = useState<OpenPullRequest[] | null | undefined>(undefined);
  const [deployments, setDeployments] = useState<Deployment[] | null | undefined>(undefined);
  const [events, setEvents] = useState<ActivityEvent[] | null | undefined>(undefined);
  const [team, setTeam] = useState<User[] | null | undefined>(undefined);
  const [repoCount, setRepoCount] = useState<{ repos: number; synced: number | null } | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showPulls, setShowPulls] = useState(false);

  const load = useCallback(async () => {
    const misses = new Set<string>();
    const settle = () => setMissing([...misses]);
    const id = project.id;
    const jobs: Promise<unknown>[] = [];
    // The sources first: the path counts them.
    jobs.push(
      (async () => {
        const [repos, nodes] = await Promise.all([
          soft("repositories", projectRepoRows(token, id), misses),
          soft("artifact graph", api.listArtifactNodes(token, "repo", id, undefined, 200), misses),
        ]);
        const repoList: RepoEntry[] | null = repos;
        const nodeList = nodes?.nodes ?? null;
        setRepoNodes(nodeList ?? []);
        const synced = repoList && nodeList ? repoList.filter((r) => findRepoNode(nodeList, r) !== undefined).length : null;
        setRepoCount(repoList ? { repos: repoList.length, synced } : null);
        setPath(await readPathFacts(token, id, repoList ? repoList.length : null, synced));
      })(),
    );
    jobs.push(soft("project config", api.projectConfig(token, id), misses).then(setConfig));
    jobs.push(
      soft("rollup", api.rollups(token, id), misses).then((r) => setRollup(r ? (r.items.find((x) => x.id === id) ?? null) : null)),
    );
    jobs.push(
      project.orgId
        ? soft("organization overview", api.orgOverview(token, project.orgId), misses).then((o) =>
            setHealth(o ? (o.workspaces.flatMap((w) => w.projects).find((p) => p.id === id) ?? null) : null),
          )
        : Promise.resolve(setHealth(null)),
    );
    jobs.push(soft("pull requests", api.openPullRequests(token, id), misses).then((r) => setPulls(r ? r.items : null)));
    jobs.push(soft("deployments", api.deployments(token, { project: id }), misses).then((r) => setDeployments(r ? r.items : null)));
    jobs.push(soft("activity", api.activityFeed(token, id), misses).then((r) => setEvents(r ? r.items : null)));
    jobs.push(
      project.orgId
        ? soft("team", projectTeam(token, project.orgId, id), misses).then((r) => setTeam(r))
        : Promise.resolve(setTeam(null)),
    );
    jobs.push(
      soft("IDE sessions", api.studioSessions(token), misses).then((r) =>
        // A session is keyed by the tenant it was launched for.
        setSessions((r?.items ?? []).filter((x) => x.workspace_id === id)),
      ),
    );
    jobs.push(soft("who you are", api.me(token), misses).then((who: Me | null) => setMeSubject(who?.subject_id || null)));
    await Promise.all(jobs.map((j) => j.finally(settle)));
  }, [token, project.id, project.orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Re-read everything without blanking the screen: a stale number beats a
   *  dashboard that flashes "Loading…" on every refresh. */
  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  /* ── Derived ── */

  const steps = useMemo(() => (path ? projectPath(path) : path === null ? null : undefined), [path]);

  /* Open comment threads waiting on the reader, summed across the project's
     repositories: the sync writes `waiting_on` onto each repo node, crediting
     everybody in an open thread except whoever spoke last, as `oidc:<subject>`.
     Undefined when no repository carries the key: no answer is not zero. */
  const waitingOnMe = useMemo(() => {
    if (!meSubject) return undefined;
    const mine = `oidc:${meSubject}`;
    let total: number | undefined;
    for (const node of repoNodes) {
      const rows = node.value.waiting_on as { id?: string; threads?: number }[] | undefined;
      if (!rows) continue;
      total = (total ?? 0) + (rows.find((row) => row.id === mine)?.threads ?? 0);
    }
    return total;
  }, [repoNodes, meSubject]);

  const signals = useMemo(
    () => projectSignals({ path, rollup, pulls, deployments, health, waitingOnMe }),
    [path, rollup, pulls, deployments, health, waitingOnMe],
  );
  const verdict = projectVerdict(signals, steps);
  const next = nextStep(steps);
  const liveSession = sessions.find((s) => s.state === "running") ?? sessions[0];

  const act = (target: SignalTarget) => {
    if (target === "ide") onOpenStudio();
    else if (target === "pulls") setShowPulls(true);
    else onOpenTab(target);
  };
  const openPanel = (t: PanelTarget) => {
    const tab = PANEL_TAB[t];
    if (tab) onOpenTab(tab);
  };

  const openIde = (primary: boolean) => (
    <button
      className={primary ? "primary" : "ghost"}
      onClick={onOpenStudio}
      title={liveSession ? `The IDE is ${liveSession.state}: open it in this window` : "Start a session for this project and open it in this window"}
      data-open-ide
      data-ide-state={liveSession?.state}
    >
      Open IDE
    </button>
  );

  return (
    <div className="dash proj-dash" data-project-overview>
      <style>{PROJ_DASH_CSS}</style>
      <PageHeader
        icon={<HeaderIcon token={token} level="project" id={project.id} name={project.name} kind={config?.kind} />}
        title={project.name}
        info={
          <>
            <p>
              How the project is doing: one verdict, the path from its sources to a running product, its numbers, and
              what waits on you or the team.
            </p>
            <p>
              <b>Blocked</b>: the repository connection is refused, the product does not resolve, the last build or
              deploy failed, or a high finding is open. <b>At risk</b>: specs fail their checks, or pull requests have
              waited over a week or have nobody asked to review them. <b>On track</b>: none of those. The button is
              the next step of the path; the rest is under Needs attention.
            </p>
          </>
        }
        status={
          <>
            <StatusChip tone={verdict.tone} data-verdict={verdict.state}>
              {verdict.label}
            </StatusChip>
            {verdict.reason && (
              <span className="pov-reason" data-verdict-reason>
                {verdict.reason}
              </span>
            )}
            {verdict.more > 0 && <span className="sub">+{verdict.more} more below</span>}
          </>
        }
        actions={
          <>
            {next ? (
              <button className="primary" onClick={() => onOpenTab(next.tab)} title={next.status} data-next-step={next.id}>
                {next.action}
              </button>
            ) : (
              openIde(true)
            )}
            {next && openIde(false)}
            <OpenInDesktop token={token} project={project} />
            <button
              className="ghost pov-refresh"
              disabled={refreshing}
              onClick={() => void refresh()}
              title="Read everything again"
              aria-label="Refresh"
            >
              {refreshing ? "…" : "↻"}
            </button>
          </>
        }
      />

      <ProjectPath steps={steps ?? null} facts={path} onOpenTab={onOpenTab} />

      <div className="pov-layout">
        <div className="pov-main">
          {showPulls && (
            <div className="pov-pulls" data-pulls-open>
              <button className="ghost pov-pulls-close" onClick={() => setShowPulls(false)}>
                Hide pull requests
              </button>
              <PullRequestsWaiting
                token={token}
                projectId={project.id}
                repositories={repoCount?.repos ?? 0}
                synced={(repoCount?.synced ?? 0) > 0}
              />
            </div>
          )}

          <section className="mb-row" data-board-row="project" aria-label="This project now">
            <h3 className="mb-row-title">This project now</h3>
            <div className="mb-grid">
              <ReleasesPanel path={path} deployments={deployments} onOpen={() => onOpenTab("releases")} />
              <MetricPanel panel={specHealthPanel(rollup)} against="" onOpen={openPanel} labels={LABELS} />
              <MetricPanel panel={teamPanel(team, rollup?.team, events, pulls)} against="" onOpen={openPanel} labels={LABELS} />
            </div>
          </section>

          <MetricsBoard
            token={token}
            org={project.orgId}
            scope={{ kind: "project", id: project.id }}
            overview={null}
            exclude={ORG_ONLY}
            onOpen={openPanel}
            labels={LABELS}
          />
        </div>

        <aside className="pov-side">
          <section className="card pov-needs" data-project-needs>
            <div className="card-head">
              <h3>Needs attention</h3>
              {signals.length > 0 && <span className="att-count">{signals.length}</span>}
            </div>
            {signals.length === 0 ? (
              <EmptyState
                title={path === undefined ? "Reading the project…" : "Nothing waits on you or the team."}
                body={path === undefined ? undefined : "No failing gate, stuck pull request or refused connection."}
              />
            ) : (
              <ul className="att-list">
                {signals.map((s) => (
                  <li key={s.key} className={`att-row tone-${LEVEL_TONE[s.level]}`} data-attention={s.key} data-level={s.level}>
                    <span className="att-text">
                      <b>{s.phrase}</b>
                      {s.detail && <span className="sub">{s.detail}</span>}
                    </span>
                    <button type="button" className="ghost att-action" onClick={() => act(s.action.target)}>
                      {s.action.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {missing.length > 0 && (
              <p className="sub pov-missing" data-no-answer title="What they hold is unknown, which is not zero.">
                Not read: {missing.join(", ")}.
              </p>
            )}
          </section>

          <section className="card pov-activity" data-project-activity>
            <div className="card-head">
              <h3>Recent activity</h3>
              <button className="linklike" onClick={() => onOpenTab("activity")}>
                Activity →
              </button>
            </div>
            {events === undefined ? (
              <p className="sub">Reading…</p>
            ) : events === null ? (
              <EmptyState title="The Activity feed could not be read." />
            ) : events.length === 0 ? (
              <EmptyState title="Nothing has happened here yet." body="Checks and comments appear once a sync reads the documents." />
            ) : (
              <ul className="pov-events">
                {recentActivity(events).map((e) => (
                  <li key={e.id} data-activity-row>
                    <span className="pov-ev-what">
                      <b>{e.event}</b>{" "}
                      <span className="pov-ev-subject">{e.items ? `${e.items.length} documents` : e.subject}</span>
                    </span>
                    <span className="sub">
                      {e.by} · {relTime(e.recorded)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ── Releases: the last build and deploy, and what runs where ── */

function ReleasesPanel({
  path,
  deployments,
  onOpen,
}: {
  path: PathFacts | null | undefined;
  deployments: Deployment[] | null | undefined;
  onOpen: () => void;
}) {
  const build = path?.build;
  const last = deployments ? lastDeploy(deployments) : null;
  const envs = deployments ? versionsByEnvironment(deployments) : [];
  const reading = path === undefined || deployments === undefined;
  return (
    <section className="card mb-panel pov-releases" data-panel="project-releases" data-source="Studio" data-panel-state={reading ? "loading" : "ok"}>
      <header className="mb-panel-head">
        <h4 className="mb-panel-title">Releases</h4>
        <InfoPopover label="About Releases">
          The newest finished build on the main branch (its CI runs), the newest deploy that ran, and the version each
          environment runs: its newest successful install, by chart version, else build, else commit. A deploy that
          failed after it is marked. It is now, not a range.
          <br />
          <br />
          <b>Source:</b> Studio (its CI runs and deployments).
        </InfoPopover>
      </header>
      {reading ? (
        <div className="mb-loading" aria-busy="true">
          <StatusChip tone="running">reading…</StatusChip>
        </div>
      ) : (
        <dl className="pov-rel">
          <dt>Last build</dt>
          <dd data-last-build>
            {build === null || build === undefined ? (
              <span className="sub">CI runs not readable</span>
            ) : build === "none" ? (
              <span className="sub">no CI run yet</span>
            ) : (
              <>
                <StatusChip tone={BUILD_TONE[build.status] ?? "neutral"}>{build.status}</StatusChip>
                {build.sha && <code>{build.sha}</code>}
              </>
            )}
          </dd>
          <dt>Last deploy</dt>
          <dd data-last-deploy>
            {deployments === null ? (
              <span className="sub">deployments not readable</span>
            ) : !last ? (
              <span className="sub">never deployed</span>
            ) : (
              <>
                <StatusChip tone={last.state === "succeeded" ? "ok" : "danger"}>{last.state}</StatusChip>
                <span>
                  {last.environment_name} · {relTime(last.decided_at ?? last.requested_at)}
                </span>
              </>
            )}
          </dd>
        </dl>
      )}
      {!reading && envs.length > 0 && (
        <ul className="pov-envs" aria-label="What runs in each environment">
          {envs.map((e) => (
            <li key={e.environment} data-env={e.environment}>
              <span className="pov-env-name">{e.environment}</span>
              <code className="pov-env-ver" title={e.version}>
                {e.version}
              </code>
              <span className="sub">{relTime(e.at)}</span>
              {e.failedAfter && <StatusChip tone="warn">later deploy failed</StatusChip>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="linklike mb-open" onClick={onOpen}>
        Releases →
      </button>
    </section>
  );
}

const PROJ_DASH_CSS = `
.proj-dash .card-head { display:flex; align-items:center; gap:8px; }
.proj-dash .card-head h3 { margin:0; font-size:14px; }
.proj-dash .card-head .linklike { margin-left:auto; font-size:12px; }
.proj-dash .sub { color:var(--muted-foreground); font-size:12px; overflow-wrap:anywhere; }
.proj-dash .pov-reason { font-size:13px; }
.proj-dash .pov-refresh { min-width:32px; padding-inline:8px; }
.proj-dash .ppath-strip { margin:0 0 16px; padding:10px 14px; display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; }
.proj-dash .ppath-head { display:flex; align-items:center; gap:8px; flex:none; min-height:28px; }
.proj-dash .ppath-head h2 { margin:0; font-size:14px; display:inline-flex; align-items:center; gap:4px; }
.proj-dash .ppath-strip .ui-steps { flex:1; min-width:0; }
.proj-dash .ppath-strip .fc-step-detail { margin-top:8px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-size:13px; }
.proj-dash .ppath-reading { margin:6px 0 0; }
.proj-dash .pov-layout { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:16px; align-items:start; }
.proj-dash .pov-main { display:grid; gap:18px; min-width:0; }
.proj-dash .pov-side { display:grid; gap:12px; position:sticky; top:12px; }
@media (max-width: 1180px) {
  .proj-dash .pov-layout { grid-template-columns:minmax(0,1fr); }
  .proj-dash .pov-side { position:static; }
}
.proj-dash .pov-pulls { display:grid; gap:6px; }
.proj-dash .pov-pulls-close { justify-self:end; font-size:12px; }
.proj-dash .att-count { font-size:11px; padding:0 6px; border-radius:999px; background:var(--accent); color:var(--foreground); }
.proj-dash .att-list { list-style:none; margin:0; padding:0; display:grid; gap:4px; }
.proj-dash .att-row { display:flex; align-items:center; gap:10px; padding:4px 10px; min-height:34px; border-radius:8px; border:1px solid var(--border); border-left:3px solid var(--border); }
.proj-dash .att-row.tone-danger { border-left-color:var(--destructive); }
.proj-dash .att-row.tone-warn { border-left-color:var(--warning); }
.proj-dash .att-row.tone-info { border-left-color:var(--primary); }
.proj-dash .att-text { flex:1; min-width:0; font-size:13px; display:flex; flex-direction:column; gap:1px; }
.proj-dash .att-text b { font-weight:600; }
.proj-dash .att-action { flex:none; font-size:12px; white-space:nowrap; padding:2px 8px; min-height:0; }
.proj-dash .pov-needs .dt-empty, .proj-dash .pov-activity .dt-empty { padding:6px 0; text-align:left; align-items:flex-start; }
.proj-dash .pov-missing { margin:8px 0 0; }
.proj-dash .pov-events { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.proj-dash .pov-events li { display:grid; gap:1px; font-size:13px; min-width:0; }
.proj-dash .pov-ev-what { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.proj-dash .pov-ev-what b { font-weight:600; }
.proj-dash .pov-ev-subject { color:var(--muted-foreground); }
.proj-dash .pov-rel { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 10px; margin:6px 0 0; font-size:13px; align-items:center; }
.proj-dash .pov-rel dt { color:var(--muted-foreground); font-size:12px; }
.proj-dash .pov-rel dd { margin:0; display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
.proj-dash .pov-envs { list-style:none; margin:8px 0 0; padding:8px 0 0; border-top:1px solid var(--border); display:grid; gap:4px; }
.proj-dash .pov-envs li { display:grid; grid-template-columns:minmax(0,6em) minmax(0,1fr) auto; gap:6px; align-items:center; font-size:12px; }
.proj-dash .pov-envs li > .badge { grid-column:1 / -1; justify-self:start; }
.proj-dash .pov-env-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.proj-dash .pov-env-ver { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`;
