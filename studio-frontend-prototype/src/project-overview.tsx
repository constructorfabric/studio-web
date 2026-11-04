/* ── Project Overview — the project's dashboard ───────────────────────────────
 *
 * The one screen that answers "what is in this project, and what state is it
 * in", from the systems that actually hold the answer:
 *
 *   documents   studio-documents — the effective type catalogue as the spec
 *               pipeline, plus every project document's status and whether it
 *               conforms to its type. "Validate all" re-runs the checks here.
 *   sources     workspace settings (the repositories attached to the project)
 *               crossed with the artifact graph's repo nodes, which carry the
 *               last sync and what it pulled. Sync runs from this screen.
 *   artifacts   what the builds produced: the CI artifacts and releases the
 *               sync keeps (studio-artifact-ingest), scoped to this project.
 *   quality     spec_finding nodes the Spec Quality tab wrote back.
 *   pull requests  who each open one is waiting on, from
 *               studio-artifact-ingest's /open-pull-requests
 *               (pull-requests-waiting.tsx).
 *   kits/team   kit installations, tenant users.
 *   studio      the IDE session for this project — launched from here.
 *
 * Nothing on this screen is decoration: every number is a live read, and a
 * gear that does not answer is named rather than shown as a confident zero.
 */

import { LevelBadge } from "./level-marks";
import { HeaderIcon } from "./tenant-icon-view";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type {
  ArtifactNode,
  Doc,
  PipelineRow,
  JourneyStage,
  DocType,
  DocValidation,
  KitInstallation,
  Me,
  ProjectConfig,
  RepoEntry,
  StudioSession,
  User,
} from "./api";
import { findRepoNode } from "./artifact-sync";
import { projectRepoRows } from "./project-sources";
import { errText, relTime } from "./format";
import { OpenInDesktop } from "./open-in-desktop";
import { PullRequestsWaiting } from "./pull-requests-waiting";
import { ProjectPath } from "./project-path-view";
import { InfoPopover, KpiTile, PageHeader, StatusChip } from "./ui-standard";

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
  | "people";

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
 *  outside a self-managed subtree). Record which one, hand back the fallback,
 *  and let the dashboard say so — a missing gear is not "zero of them". */
async function optional<T>(label: string, p: Promise<T>, fallback: T, misses: string[]): Promise<T> {
  try {
    return await p;
  } catch {
    misses.push(label);
    return fallback;
  }
}

/** `total` from a one-row page — the cheapest way to count a node type. */
async function countNodes(token: string, type: string, scope: string): Promise<number> {
  const page = await api.listArtifactNodes(token, type, scope, undefined, 1);
  return page.total ?? 0;
}

/* ── Small presentational pieces ── */

/** Percentage + slim bar + count — the conformance and sync meters. */
function Meter({ done, total, unit }: { done: number; total: number; unit: string }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="coverage">
      <span className="pct">{total === 0 ? "—" : `${pct}%`}</span>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="count">
        {done}/{total} {unit}
      </span>
    </div>
  );
}

const STATUS_TONE: Record<Doc["status"], string> = {
  draft: "draft",
  review: "review",
  approved: "ok",
};

/* ── The dashboard ── */

export function ProjectOverview({
  token,
  project,
  parentWorkspaceId,
  onOpenTab,
  onOpenStudio,
}: {
  token: string;
  project: OverviewProject;
  /** The parent workspace tenant — documents and their types are stored there
   *  and inherited by the project, so every document read is scoped to it. */
  parentWorkspaceId: string;
  onOpenTab: (tab: ProjTab) => void;
  /** Launch (or attach to) this project's IDE session and open it as a space. */
  onOpenStudio: () => void;
}) {
  /** The project's repositories (`project-sources.ts`), as rows. */
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [types, setTypes] = useState<DocType[]>([]);
  // The workspace's effective stage catalogue: names, order and which are
  // required. It used to be a constant in api.ts; an organization can change
  // it now, so the dashboard asks instead of assuming (ADR-0014 s7).
  const [stageCatalogue, setStageCatalogue] = useState<JourneyStage[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  /** Repository files joined to a document type. */
  /** One row per declared type, folded by studio-documents. */
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [repoNodes, setRepoNodes] = useState<ArtifactNode[]>([]);
  const [counts, setCounts] = useState<{ build_artifact: number; release: number }>({
    build_artifact: 0,
    release: 0,
  });
  const [findings, setFindings] = useState<ArtifactNode[]>([]);
  const [findingTotal, setFindingTotal] = useState(0);
  const [kits, setKits] = useState<KitInstallation[]>([]);
  const [team, setTeam] = useState<User[]>([]);
  /* Who is reading this screen, for the one fact on it that is about them.
   *
   * Asked for here rather than handed down: the subject lives three components
   * above, and threading it through two of them that have no use for it is a
   * worse change than one more request on a screen that already makes a dozen.
   * It is the CANONICAL person id (`GET /me`), not the token subject — the two
   * are different UUIDs for the same human, and the IDE signs its comments with
   * this one. */
  const [meSubject, setMeSubject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Validation run from this screen: per document id, what the checker said.
  const [checks, setChecks] = useState<Record<string, DocValidation>>({});
  const [validating, setValidating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      const misses: string[] = [];
      const [
        cfg,
        ownRepos,
        typePage,
        stagePage,
        docPage,
        pipelinePage,
        repoPage,
        buildArtifacts,
        releases,
        findingPage,
        kitPage,
        users,
        sessionPage,
        who,
      ] =
        await Promise.all([
          optional("project config", api.projectConfig(token, project.id), null, misses),
          optional("repositories", projectRepoRows(token, project.id), [] as RepoEntry[], misses),
          optional("document types", api.docTypes(token, parentWorkspaceId), { items: [] as DocType[] }, misses),
          optional(
            "journey stages",
            api.stages(token, parentWorkspaceId),
            { items: [] as JourneyStage[] },
            misses,
          ),
          optional(
            "documents",
            api.projectDocuments(token, parentWorkspaceId, project.id),
            { items: [] as Doc[] },
            misses,
          ),
          // The repository's side of the same question. A file bound to a type
          // is a document of that type, and reading only the authored ones is
          // why this screen used to say "not started" about types the Specs
          // table was already listing fourteen documents under. Both sides are
          // folded by the server now, so the bindings themselves are no longer
          // fetched here — only the answer.
          optional(
            "spec pipeline",
            api.specPipeline(token, project.id),
            { items: [] as PipelineRow[], total: 0 },
            misses,
          ),
          optional(
            "artifact graph",
            api.listArtifactNodes(token, "repo", project.id, undefined, 200),
            { nodes: [] as ArtifactNode[], total: 0 },
            misses,
          ),
          optional("CI artifacts", countNodes(token, "build_artifact", project.id), 0, misses),
          optional("releases", countNodes(token, "release", project.id), 0, misses),
          optional(
            "spec-quality findings",
            api.listArtifactNodes(token, "spec_finding", project.id, undefined, 200),
            { nodes: [] as ArtifactNode[], total: 0 },
            misses,
          ),
          optional("kit registry", api.kitInstallations(token, project.id), { items: [] as KitInstallation[] }, misses),
          optional("team", api.tenantUsersAll(token, project.id), { items: [] as User[] }, misses),
          optional("IDE sessions", api.studioSessions(token), { items: [] as StudioSession[] }, misses),
          // The fallback is a whole Me, not a partial: `optional` types its
          // answer from it, and a screen that cannot ask who you are simply
          // has nobody to address rather than a different shape to handle.
          optional(
            "who you are",
            api.me(token),
            { subject_id: "", subject_tenant_id: "" } as Me,
            misses,
          ),
        ]);

      setRepos(ownRepos);
      setConfig(cfg);
      setTypes(typePage.items ?? []);
      setStageCatalogue(stagePage.items ?? []);
      setDocs(docPage.items ?? []);
      setRows(pipelinePage.items ?? []);
      setRepoNodes(repoPage.nodes ?? []);
      setCounts({ build_artifact: buildArtifacts, release: releases });
      setFindings(findingPage.nodes ?? []);
      setFindingTotal(findingPage.total ?? (findingPage.nodes ?? []).length);
      setKits(kitPage.items ?? []);
      setTeam(users.items ?? []);
      // A session is keyed by the tenant it was launched for, so the project's
      // own sessions are the ones carrying its id.
      setSessions((sessionPage.items ?? []).filter((x) => x.workspace_id === project.id));
      setMeSubject(who.subject_id || null);
      // De-duplicated so one unreachable gear is named once.
      setMissing([...new Set(misses)]);
      setLoading(false);
    },
    [token, project.id, parentWorkspaceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** Re-read everything without tearing the screen down: a dashboard that
   *  blanks to "Loading…" on every refresh is worse than a stale number. */
  const refresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  /* ── Derived state ── */

  /** True when the gear behind a number did not answer — the number is then
   *  unknown, which is not the same as zero. */
  const missed = (label: string) => missing.includes(label);

  /** The graph's record of an attached source: present once it has been synced
   *  at least once, and carrying when that was and what came in. */
  const graphRepo = useCallback(
    (r: RepoEntry): ArtifactNode | undefined => findRepoNode(repoNodes, r),
    [repoNodes],
  );

  const syncedRepos = repos.filter((r) => graphRepo(r) !== undefined).length;
  const artifactTotal = counts.build_artifact + counts.release;
  const artifactsKnown = !["CI artifacts", "releases"].some(missed);

  const started = rows.filter((r) => !r.untouched);
  const notStarted = rows.filter((r) => r.untouched);

  /** Findings by severity — the detectors write `high`/`medium`/`low`, and
   *  anything unlabelled counts as `info`. */
  const bySeverity = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of findings) {
      const sev = String(f.value.severity ?? "info").toLowerCase();
      m.set(sev, (m.get(sev) ?? 0) + 1);
    }
    return m;
  }, [findings]);

  // Every stage, in catalogue order. A project does not pick its stages: they
  // are a computed status of what it has (ADR-0058), and `stage_status` has
  // always answered for every one. A `stages` list an older project carries in
  // its config used to filter these chips; it no longer does.
  const stages = stageCatalogue;

  const liveSession = sessions.find((s) => s.state === "running") ?? sessions[0];

  /* ── Actions ── */

  /*
   * Open comment threads across this project that are waiting on the person
   * reading the screen.
   *
   * The sync writes this onto each repository node (`waiting_on`), crediting
   * everybody in an open thread except whoever spoke last. The id it writes is
   * the author record's — `oidc:<subject>` — and the subject is the canonical
   * person id, which is why the match is an identity rather than a name: two
   * people can share a display name, and one person can change theirs.
   *
   * Summed across repositories, because a project can have several and the
   * question is about the project. Undefined rather than zero when no
   * repository carries the key at all: a sync that never read a checkout has
   * no answer, and "nothing is waiting on you" is a different thing to say.
   */
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

  /* Running a sync moved to the Sources section along with the card that
     offered it. This screen still READS the repositories — the Repositories
     stat counts them and warns when some are unsynced — but a job that takes
     minutes should not be owned by a dashboard people leave as soon as they
     have read it. */

  /** Re-run every document's type checks and keep the reports. The stored
   *  `conforms` flag is only as fresh as each document's last save, and it
   *  says nothing about WHY — the reports give both, without having to open
   *  seven documents one at a time. */
  const validateAll = async () => {
    if (docs.length === 0) return;
    setValidating(true);
    setError(null);
    try {
      const results = await Promise.all(
        docs.map(async (d) => {
          try {
            return [d.id, await api.validateDocument(token, parentWorkspaceId, d.id)] as const;
          } catch {
            return null;
          }
        }),
      );
      setChecks(Object.fromEntries(results.filter((r): r is [string, DocValidation] => r !== null)));
    } catch (e) {
      setError(errText(e));
    } finally {
      setValidating(false);
    }
  };

  if (loading) return <p className="empty">Loading project…</p>;

  // What the last "Validate all" run objected to, each line named by the
  // document it is about — an unattributed list of complaints is unusable.
  const issues = Object.entries(checks).flatMap(([id, v]) => {
    const title = docs.find((d) => d.id === id)?.title ?? id.slice(0, 8);
    return (v.issues ?? []).map((line) => ({ id, title, line }));
  });

  return (
    <div className="dash">
      {/* One standard header: the project, how it is set up and where its IDE
          stands, in chips; the IDE is its action. What the screen is for is
          behind the "?", not a banner above every visit. */}
      <PageHeader
        icon={<HeaderIcon token={token} level="project" id={project.id} name={project.name} kind={config?.kind} />}
        title={project.name}
        info={
          <>
            <p>
              Where the project stands. Follow the path below; each step opens the tab where it is done.
            </p>
            <p>
              The Web IDE is a session in your browser that clones the project&apos;s repositories and opens them
              together; the desktop app does the same on your machine. A running session is stopped from the Spaces
              list in the sidebar.
            </p>
          </>
        }
        status={
          <>
            <LevelBadge level="project" />
            {config?.kind && <StatusChip tone="info">{config.kind.replace("_", " ")}</StatusChip>}
            {config?.status && (
              <StatusChip tone={config.status === "active" ? "ok" : "neutral"}>{config.status}</StatusChip>
            )}
            {project.self_managed && <StatusChip tone="neutral">self-managed</StatusChip>}
            {liveSession && (
              <StatusChip
                tone={liveSession.state === "running" ? "running" : "neutral"}
                title={`${liveSession.sources.length} source${liveSession.sources.length === 1 ? "" : "s"} mounted`}
                data-ide-state={liveSession.state}
              >
                IDE {liveSession.state}
              </StatusChip>
            )}
            {/* The one fact on this screen about the reader: silent at zero, and
                silent when no sync read a checkout (not the same as nothing owed). */}
            {waitingOnMe ? (
              <StatusChip tone="warn" title="Answered in the IDE, where each thread sits on the text it is about" data-waiting-on-me>
                {waitingOnMe} comment {waitingOnMe === 1 ? "thread waits" : "threads wait"} on you
              </StatusChip>
            ) : null}
            {missing.length > 0 && (
              <StatusChip tone="warn" title={`What they hold is shown as “—”, not as zero.`} data-no-answer>
                no answer from {missing.join(", ")}
              </StatusChip>
            )}
          </>
        }
        actions={
          <>
            <button
              className="primary"
              onClick={onOpenStudio}
              title={liveSession ? "Open the running session in this window" : "Start a session for this project and open it in this window"}
              data-open-ide
            >
              Open IDE
            </button>
            <OpenInDesktop token={token} project={project} />
            <button className="ghost" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </>
        }
      />

      {error && <div className="error">{error}</div>}

      {/* Where the project is on its way to a product that builds: the main
          block, with the numbers (specs typed, repositories synced, findings)
          in its rows. Loads on its own, after the tiles below, so a slow model
          read never holds the dashboard. */}
      <ProjectPath
        token={token}
        projectId={project.id}
        repositories={missed("repositories") ? null : repos.length}
        synced={missed("repositories") || missed("artifact graph") ? null : syncedRepos}
        onOpenTab={onOpenTab}
      />

      {/* What the path does not say, in three tiles. Each opens the tab that
          owns it; a "—" says why behind its "?". */}
      <div className="dash-stats" data-overview-kpis>
        <KpiTile
          label="Artifacts"
          value={artifactsKnown ? artifactTotal : "—"}
          sub={artifactsKnown ? `${counts.build_artifact} from CI · ${counts.release} releases` : undefined}
          why="The artifact graph did not answer: what the builds kept is unknown, which is not zero."
          onOpen={() => onOpenTab("artifacts")}
        />
        <KpiTile
          label="Pipeline"
          value={missed("document types") || missed("spec pipeline") ? "—" : `${started.length}/${types.length}`}
          sub={
            missed("document types") || missed("spec pipeline")
              ? undefined
              : notStarted.length
                ? `${notStarted.length} type${notStarted.length === 1 ? "" : "s"} not started`
                : "every type covered"
          }
          tone={notStarted.length > 0 ? "warn" : undefined}
          why="The document types or the spec pipeline did not answer."
          onOpen={() => onOpenTab("specs")}
        />
        <KpiTile
          label="Team"
          value={missed("team") ? "—" : team.length}
          sub={
            missed("team")
              ? undefined
              : team.length === 0
                ? "nobody assigned"
                : team
                    .slice(0, 2)
                    .map((u) => u.display_name || u.username)
                    .join(", ") + (team.length > 2 ? ` +${team.length - 2}` : "")
          }
          why="The account service did not answer for this project's members: who is on it is unknown, not nobody."
          onOpen={() => onOpenTab("people")}
        />
      </div>

      <div className="dash-grid">
        <div className="dash-col">
          {/* ── Spec pipeline: which document types this project has produced,
                and whether what it produced passes its own type's checks. ── */}
          <div className="card">
            <div className="card-head">
              <h2>
                Spec pipeline{" "}
                <InfoPopover label="About the spec pipeline">
                  One row per document type the workspace defines, counting documents written here and repository
                  files bound to that type alike. A type with documents shows how they stand and how many satisfy the
                  type&apos;s required sections; the rest is what this project has neither written nor found. A file a
                  scan only guessed at is shown as unconfirmed and left out of the count — a guess is not coverage.
                  “Validate all” re-checks every document and lists what the checker objects to.
                </InfoPopover>
              </h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ghost" disabled={validating || docs.length === 0} onClick={() => void validateAll()}>
                  {validating ? "Validating…" : "Validate all"}
                </button>
                <button className="ghost" onClick={() => onOpenTab("specs")}>
                  Documents →
                </button>
              </div>
            </div>
            {stages.length > 0 && (
              <div className="dash-stages">
                {stages.map((s) => (
                  <span key={s.key} className="chip on">
                    {s.label}
                  </span>
                ))}
              </div>
            )}

            {types.length === 0 ? (
              <p className="empty">No document types — define them on the workspace's Document types tab.</p>
            ) : (
              <table className="ptable">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Documents</th>
                    <th>Valid</th>
                  </tr>
                </thead>
                <tbody>
                  {started.map((row) => {
                    // `row.valid` is the server's count, from the verdict on
                    // each record. This screen may hold a fresher one — a
                    // "Validate all" run — so it recounts when it does, and
                    // takes the server's answer when it does not.
                    const total = row.total;
                    const counted = [...row.authored, ...row.bound];
                    const valid = counted.some((e) => checks[e.id])
                      ? counted.filter((e) => (checks[e.id]?.conforms ?? e.conforms) === true).length
                      : row.valid;
                    // Titles first, then repository paths: an authored
                    // document has a name somebody chose, a bound file has a
                    // path, and mixing them without order makes the line read
                    // as neither.
                    const names = [
                      ...row.authored.map((d) => d.name),
                      ...row.bound.map((b) => b.name),
                    ];
                    return (
                      <tr key={row.type_key} className="prow root">
                        <td>
                          <div className="pcell">
                            <div>
                              <div className="name">{row.type_name}</div>
                              <div className="sub">
                                {names.slice(0, 3).join(", ")}
                                {names.length > 3 ? ` +${names.length - 3}` : ""}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="dash-mix">
                            {(["approved", "review", "draft"] as Doc["status"][]).map((st) => {
                              const n = row.authored.filter((d) => d.status === st).length;
                              return n > 0 ? (
                                <span key={st} className={`badge ${STATUS_TONE[st]}`}>
                                  {n} {st}
                                </span>
                              ) : null;
                            })}
                            {row.bound.length > 0 && (
                              <span
                                className="badge ok"
                                title="Repository files bound to this type"
                              >
                                {row.bound.length} in repo
                              </span>
                            )}
                            {/* A guess is not coverage, so it is shown and not
                                counted — and it is shown, because it is the
                                one thing on this row somebody can act on. */}
                            {row.proposed.length > 0 && (
                              <span
                                className="badge warn"
                                title="Detected by a scan, waiting for someone to confirm the type"
                              >
                                {row.proposed.length} unconfirmed
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {total > 0 ? (
                            <Meter done={valid} total={total} unit="docs" />
                          ) : (
                            <button className="ghost" onClick={() => onOpenTab("specs")}>
                              Review →
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {notStarted.map((t) => (
                    <tr key={t.type_key} className="prow nested">
                      <td>
                        <div className="pcell">
                          <div>
                            <div className="name" style={{ fontWeight: 500 }}>
                              {t.type_name}
                            </div>
                            <div className="sub">{t.type_description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="sub">not started</td>
                      <td className="pactions">
                        <button className="ghost" onClick={() => onOpenTab("specs")}>
                          Write it
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {issues.length > 0 && (
              <>
                <p className="hint" style={{ marginTop: 12 }}>
                  From the last validation run — {issues.length} issue{issues.length === 1 ? "" : "s"}
                  {issues.length > 6 ? ", first six" : ""}:
                </p>
                <ul className="rows">
                  {issues.slice(0, 6).map((it, i) => (
                    <li key={`${it.id}-${i}`}>
                      <div className="grow">
                        <div className="name">{it.title}</div>
                        <div className="sub">{it.line}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* ── Pull requests: who each open one is waiting on. ── */}
          <PullRequestsWaiting
            token={token}
            projectId={project.id}
            repositories={repos.length}
            synced={syncedRepos > 0}
          />
        </div>

        <div className="dash-col">
          {/* ── Spec quality: what the detectors found, written back to the
                graph as findings on the documents they are about. ── */}
          <div className="card">
            <div className="card-head">
              <h2>Spec quality</h2>
              <button className="ghost" onClick={() => onOpenTab("specs")}>
                Analyse →
              </button>
            </div>
            {findingTotal === 0 ? (
              <p className="empty">
                No findings stored yet — run a detector on the Spec Quality tab and save its results.
              </p>
            ) : (
              <>
                <div className="dash-mix">
                  {[...bySeverity.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([sev, n]) => (
                      <span
                        key={sev}
                        className={`badge ${sev === "high" || sev === "critical" ? "danger" : sev === "medium" ? "warn" : "info"}`}
                      >
                        {n} {sev}
                      </span>
                    ))}
                </div>
                <ul className="rows">
                  {findings.slice(0, 5).map((f) => (
                    <li key={f.instance_id}>
                      <div className="grow">
                        <div className="name">{String(f.value.summary ?? f.value.title ?? f.value.detector)}</div>
                        <div className="sub">
                          {String(f.value.detector ?? "detector")}
                          {f.value.path ? ` · ${String(f.value.path)}` : ""}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* ── Kits: the capability bundles installed into this project. ── */}
          <div className="card">
            <div className="card-head">
              <h2>Kits{kits.length ? ` · ${kits.length}` : ""}</h2>
              <button className="ghost" onClick={() => onOpenTab("components")}>
                Kits →
              </button>
            </div>
            {kits.length === 0 ? (
              <p className="empty">No kits installed — the registry is on the Kits tab.</p>
            ) : (
              <ul className="rows">
                {kits.map((k) => (
                  <li key={k.kit_slug}>
                    <div className="grow">
                      <div className="name">{k.kit_slug}</div>
                      <div className="sub">
                        {k.version} · {k.install_mode}
                        {k.installed_at ? ` · ${relTime(k.installed_at)}` : ""}
                      </div>
                    </div>
                    <span
                      className={`badge ${k.status === "installed" ? "ok" : k.status === "failed" ? "danger" : "info"}`}
                    >
                      {k.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
