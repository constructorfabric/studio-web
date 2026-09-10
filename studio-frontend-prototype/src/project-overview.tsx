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
 *   artifacts   studio-artifact-ingest node counts, scoped to this project.
 *   quality     spec_finding nodes the Spec Quality tab wrote back.
 *   kits/team/automation — kit installations, tenant users, the trust ramp.
 *   studio      the IDE session for this project — launched from here.
 *
 * Nothing on this screen is decoration: every number is a live read, and a
 * gear that does not answer is named rather than shown as a confident zero.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type {
  ArtifactNode,
  Doc,
  JourneyStage,
  DocType,
  DocValidation,
  KitInstallation,
  ProjectConfig,
  RepoEntry,
  StudioSession,
  User,
  WorkspaceSettings,
} from "./api";
import { runRepoSync, parseRepoSource, type SyncProgress } from "./artifact-sync";
import { errText, initials, relTime } from "./format";

/** The sections of an open project. Lives here because Overview is the screen
 *  that links to all of them; the shell's sidebar renders the list. */
export type ProjTab =
  | "overview"
  | "artifacts"
  | "documents"
  | "kits"
  | "analyze"
  | "automation"
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

/** A dashboard number: big count, what it counts, one line of detail. Clicking
 *  it goes to the tab that owns the thing. */
function Stat({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "ok" | "warn" | "danger";
  onClick?: () => void;
}) {
  return (
    <button type="button" className={`stat${tone ? ` ${tone}` : ""}`} onClick={onClick} disabled={!onClick}>
      <span className="stat-k">{label}</span>
      <span className="stat-n">{value}</span>
      <span className="stat-sub">{sub ?? " "}</span>
    </button>
  );
}

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
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [types, setTypes] = useState<DocType[]>([]);
  // The workspace's effective stage catalogue: names, order and which are
  // required. It used to be a constant in api.ts; an organization can change
  // it now, so the dashboard asks instead of assuming (ADR-0014 s7).
  const [stageCatalogue, setStageCatalogue] = useState<JourneyStage[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [repoNodes, setRepoNodes] = useState<ArtifactNode[]>([]);
  const [counts, setCounts] = useState<{ issue: number; pull_request: number; file: number }>({
    issue: 0,
    pull_request: 0,
    file: 0,
  });
  const [findings, setFindings] = useState<ArtifactNode[]>([]);
  const [findingTotal, setFindingTotal] = useState(0);
  const [kits, setKits] = useState<KitInstallation[]>([]);
  const [team, setTeam] = useState<User[]>([]);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Per-repository sync progress, keyed by the source's directory name.
  const [sync, setSync] = useState<Record<string, SyncProgress>>({});
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
        s,
        cfg,
        typePage,
        stagePage,
        docPage,
        repoPage,
        issue,
        prs,
        files,
        findingPage,
        kitPage,
        users,
        sessionPage,
      ] =
        await Promise.all([
          optional("workspace settings", api.workspaceSettings(token, project.id), null, misses),
          optional("project config", api.projectConfig(token, project.id), null, misses),
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
          optional(
            "artifact graph",
            api.listArtifactNodes(token, "repo", project.id, undefined, 200),
            { nodes: [] as ArtifactNode[], total: 0 },
            misses,
          ),
          optional("issues", countNodes(token, "issue", project.id), 0, misses),
          optional("pull requests", countNodes(token, "pull_request", project.id), 0, misses),
          optional("files", countNodes(token, "file", project.id), 0, misses),
          optional(
            "spec-quality findings",
            api.listArtifactNodes(token, "spec_finding", project.id, undefined, 200),
            { nodes: [] as ArtifactNode[], total: 0 },
            misses,
          ),
          optional("kit registry", api.kitInstallations(token, project.id), { items: [] as KitInstallation[] }, misses),
          optional("team", api.tenantUsers(token, project.id), { items: [] as User[] }, misses),
          optional("IDE sessions", api.studioSessions(token), { items: [] as StudioSession[] }, misses),
        ]);

      setSettings(s);
      setConfig(cfg);
      setTypes(typePage.items ?? []);
      setStageCatalogue(stagePage.items ?? []);
      setDocs(docPage.items ?? []);
      setRepoNodes(repoPage.nodes ?? []);
      setCounts({ issue, pull_request: prs, file: files });
      setFindings(findingPage.nodes ?? []);
      setFindingTotal(findingPage.total ?? (findingPage.nodes ?? []).length);
      setKits(kitPage.items ?? []);
      setTeam(users.items ?? []);
      // A session is keyed by the tenant it was launched for, so the project's
      // own sessions are the ones carrying its id.
      setSessions((sessionPage.items ?? []).filter((x) => x.workspace_id === project.id));
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

  const repos = settings?.repos ?? [];

  /** The graph's record of an attached source: present once it has been synced
   *  at least once, and carrying when that was and what came in. */
  const graphRepo = useCallback(
    (r: RepoEntry): ArtifactNode | undefined => {
      const fullPath = parseRepoSource(r.url ?? undefined)?.full_path;
      if (!fullPath) return undefined;
      return repoNodes.find((n) => n.value.full_path === fullPath);
    },
    [repoNodes],
  );

  const syncedRepos = repos.filter((r) => graphRepo(r) !== undefined).length;
  const artifactTotal = counts.issue + counts.pull_request + counts.file;
  const artifactsKnown = !["issues", "pull requests", "files"].some(missed);

  /** Documents grouped under their type — the pipeline's rows. */
  const byType = useMemo(() => {
    const m = new Map<string, Doc[]>();
    for (const d of docs) {
      const list = m.get(d.type_key) ?? [];
      list.push(d);
      m.set(d.type_key, list);
    }
    return m;
  }, [docs]);

  const started = types.filter((t) => (byType.get(t.key)?.length ?? 0) > 0);
  const notStarted = types.filter((t) => (byType.get(t.key)?.length ?? 0) === 0);
  /** `conforms` on the record is the verdict from the document's last save; a
   *  validation run on this screen supersedes it with a fresh one. */
  const conformsOf = (d: Doc) => checks[d.id]?.conforms ?? d.conforms;
  const conforming = docs.filter(conformsOf).length;
  const approved = docs.filter((d) => d.status === "approved").length;

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
  const highFindings = (bySeverity.get("high") ?? 0) + (bySeverity.get("critical") ?? 0);

  // Catalogue order, filtered to what this project carries. Never re-sorted:
  // the order is the catalogue's, and the catalogue is the workspace's.
  const stages = (config?.stages ?? []).length
    ? stageCatalogue.filter((s) => config?.stages?.includes(s.key))
    : [];

  const liveSession = sessions.find((s) => s.state === "running") ?? sessions[0];
  const installedKits = kits.filter((k) => k.status === "installed").length;

  /* ── Actions ── */

  const syncOne = async (r: RepoEntry) => {
    await runRepoSync(
      token,
      r,
      { workspaceId: parentWorkspaceId, projectId: project.id },
      (p) => {
        setSync((prev) => ({ ...prev, [r.name]: p }));
        // When the job ends, re-read the counts and the repo node so the card
        // shows the sync it just did rather than the one before it.
        if (!p.running) void load(true);
      },
    );
  };

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
      {/* Where this project sits and how it is set up — one line, not a card. */}
      <div className="dash-context">
        <span className="badge neutral" title={project.id}>
          <code>{project.id.slice(0, 8)}…</code>
        </span>
        <span className="sub">{project.orgName}</span>
        {config?.kind && <span className="badge info">{config.kind.replace("_", " ")}</span>}
        {config?.status && (
          <span
            className={`badge ${config.status === "active" ? "ok" : config.status === "archived" ? "neutral" : "draft"}`}
          >
            {config.status}
          </span>
        )}
        {project.self_managed && <span className="badge selfmanaged">self-managed</span>}
        {settings?.automation_level && <span className="badge">{settings.automation_level}</span>}
        <button className="ghost" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {missing.length > 0 && (
        <p className="hint">
          No answer from: {missing.join(", ")} — what they hold is shown as “—”, not as zero.
        </p>
      )}

      {/* The project in six numbers. Each one opens the tab that owns it. */}
      <div className="dash-stats">
        <Stat
          label="Documents"
          value={missed("documents") ? "—" : docs.length}
          sub={docs.length ? `${conforming} valid · ${approved} approved` : "none yet"}
          tone={docs.length > 0 && conforming < docs.length ? "warn" : undefined}
          onClick={() => onOpenTab("documents")}
        />
        <Stat
          label="Pipeline"
          value={missed("document types") ? "—" : `${started.length}/${types.length}`}
          sub={notStarted.length ? `${notStarted.length} type${notStarted.length === 1 ? "" : "s"} not started` : "every type covered"}
          onClick={() => onOpenTab("documents")}
        />
        <Stat
          label="Repositories"
          value={missed("workspace settings") ? "—" : repos.length}
          sub={repos.length ? `${syncedRepos} synced` : "none attached"}
          tone={repos.length > 0 && syncedRepos < repos.length ? "warn" : undefined}
          onClick={() => onOpenTab("artifacts")}
        />
        <Stat
          label="Artifacts"
          value={artifactsKnown ? artifactTotal : "—"}
          sub={`${counts.issue} issues · ${counts.pull_request} PRs · ${counts.file} files`}
          onClick={() => onOpenTab("artifacts")}
        />
        <Stat
          label="Findings"
          value={missed("spec-quality findings") ? "—" : findingTotal}
          sub={highFindings ? `${highFindings} high severity` : findingTotal ? "none high" : "not analysed"}
          tone={highFindings ? "danger" : undefined}
          onClick={() => onOpenTab("analyze")}
        />
        <Stat
          label="Team"
          value={missed("team") ? "—" : team.length}
          sub={`${installedKits} kit${installedKits === 1 ? "" : "s"} installed`}
          onClick={() => onOpenTab("people")}
        />
      </div>

      <div className="dash-grid">
        <div className="dash-col">
          {/* ── Spec pipeline: which document types this project has produced,
                and whether what it produced passes its own type's checks. ── */}
          <div className="card">
            <div className="card-head">
              <h2>Spec pipeline</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ghost" disabled={validating || docs.length === 0} onClick={() => void validateAll()}>
                  {validating ? "Validating…" : "Validate all"}
                </button>
                <button className="ghost" onClick={() => onOpenTab("documents")}>
                  Documents →
                </button>
              </div>
            </div>
            <p className="hint">
              One row per document type the workspace defines. A type with documents shows how they
              stand and how many satisfy the type's required sections; the rest is what this project
              has not written yet. “Validate all” re-checks every document and lists what the
              checker objects to.
            </p>

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
                  {started.map((t) => {
                    const list = byType.get(t.key) ?? [];
                    const ok = list.filter(conformsOf).length;
                    return (
                      <tr key={t.key} className="prow root">
                        <td>
                          <div className="pcell">
                            <div>
                              <div className="name">{t.name}</div>
                              <div className="sub">
                                {list
                                  .slice(0, 3)
                                  .map((d) => d.title)
                                  .join(", ")}
                                {list.length > 3 ? ` +${list.length - 3}` : ""}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="dash-mix">
                            {(["approved", "review", "draft"] as Doc["status"][]).map((st) => {
                              const n = list.filter((d) => d.status === st).length;
                              return n > 0 ? (
                                <span key={st} className={`badge ${STATUS_TONE[st]}`}>
                                  {n} {st}
                                </span>
                              ) : null;
                            })}
                          </div>
                        </td>
                        <td>
                          <Meter done={ok} total={list.length} unit="docs" />
                        </td>
                      </tr>
                    );
                  })}
                  {notStarted.map((t) => (
                    <tr key={t.key} className="prow nested">
                      <td>
                        <div className="pcell">
                          <div>
                            <div className="name" style={{ fontWeight: 500 }}>
                              {t.name}
                            </div>
                            <div className="sub">{t.description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="sub">not started</td>
                      <td className="pactions">
                        <button className="ghost" onClick={() => onOpenTab("documents")}>
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

          {/* ── Sources: what is attached, when it was last pulled into the
                graph, and what came in. Sync runs from right here. ── */}
          <div className="card">
            <div className="card-head">
              <h2>Repositories{repos.length ? ` · ${repos.length}` : ""}</h2>
              <button className="ghost" onClick={() => onOpenTab("artifacts")}>
                Artifacts →
              </button>
            </div>
            <p className="hint">
              The sources a session clones on launch. Sync pulls their issues, pull requests and
              files into the project's artifact graph — that is where every artifact number on this
              screen comes from.
            </p>
            {repos.length === 0 ? (
              <p className="empty">
                No repositories attached yet — pick one from a connector on the Artifacts tab.
              </p>
            ) : (
              <ul className="rows">
                {repos.map((r) => {
                  const node = graphRepo(r);
                  const live = sync[r.name];
                  const syncedAt = node?.value.synced_at as string | undefined;
                  const pulled = node
                    ? [
                        node.value.issues ? `${node.value.issues} issues` : "",
                        node.value.pull_requests ? `${node.value.pull_requests} PRs` : "",
                        node.value.files ? `${node.value.files} files` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "";
                  return (
                    <li key={r.name}>
                      <div className="grow">
                        <div className="name">{r.name}</div>
                        <div className="sub">
                          {r.source}
                          {r.branch ? ` · ${r.branch}` : ""}
                          {r.url ? ` · ${r.url}` : ""}
                        </div>
                        <div className="sub">
                          {live ? (
                            live.line
                          ) : node ? (
                            <>
                              {syncedAt ? `synced ${relTime(syncedAt)}` : "synced"}
                              {pulled ? ` — ${pulled}` : ""}
                            </>
                          ) : (
                            "never synced"
                          )}
                        </div>
                      </div>
                      <span className={`badge ${live?.running ? "syncing" : node ? "ok" : "warn"}`}>
                        {live?.running ? "syncing" : node ? "synced" : "not synced"}
                      </span>
                      <button
                        className="ghost"
                        disabled={!!live?.running}
                        title="Pull this repository's issues, pull requests and files into the graph"
                        onClick={() => void syncOne(r)}
                      >
                        {live?.running ? "…" : node ? "Re-sync" : "Sync"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="dash-col">
          {/* ── Studio: the IDE session for this project. ── */}
          <div className="card launcher">
            <div className="card-head">
              <h2>Studio</h2>
              {liveSession && <span className={`badge ${liveSession.state === "running" ? "ok" : "info"}`}>{liveSession.state}</span>}
            </div>
            {liveSession ? (
              <>
                <p className="hint">
                  A session is up for this project
                  {liveSession.sources.length
                    ? ` with ${liveSession.sources.length} source${liveSession.sources.length === 1 ? "" : "s"} mounted`
                    : " with an empty workspace"}
                  . Opening it brings the IDE into this window; the Spaces list in the sidebar is
                  where you stop it.
                </p>
                <button className="primary" onClick={onOpenStudio}>
                  Open in IDE
                </button>
              </>
            ) : (
              <>
                <p className="hint">
                  Start a Studio for this project: a dedicated IDE that clones{" "}
                  {repos.length === 0
                    ? "an empty workspace — attach a repository first to have it check something out"
                    : `${repos.length} attached repositor${repos.length === 1 ? "y" : "ies"} and opens them together`}
                  .
                </p>
                <button className="primary" onClick={onOpenStudio}>
                  Launch Studio
                </button>
              </>
            )}
          </div>

          {/* ── Spec quality: what the detectors found, written back to the
                graph as findings on the documents they are about. ── */}
          <div className="card">
            <div className="card-head">
              <h2>Spec quality</h2>
              <button className="ghost" onClick={() => onOpenTab("analyze")}>
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
              <button className="ghost" onClick={() => onOpenTab("kits")}>
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

          {/* ── Automation & team: how much the project lets workers do, and
                who is on it. ── */}
          <div className="card">
            <div className="card-head">
              <h2>Automation</h2>
              <button className="ghost" onClick={() => onOpenTab("automation")}>
                Settings →
              </button>
            </div>
            <ul className="rows">
              <li>
                <div className="grow">
                  <div className="name">{settings?.automation_level ?? "not set"}</div>
                  <div className="sub">
                    {(settings?.approved_worker_categories ?? []).length
                      ? `approved: ${(settings?.approved_worker_categories ?? []).join(", ")}`
                      : "no worker category approved yet"}
                  </div>
                </div>
              </li>
              <li>
                <div className="grow">
                  <div className="name">
                    Team · {team.length} member{team.length === 1 ? "" : "s"}
                  </div>
                  <div className="sub">
                    {team.length === 0
                      ? "nobody assigned to this project tenant"
                      : team
                          .slice(0, 4)
                          .map((u) => u.display_name || u.username)
                          .join(", ")}
                    {team.length > 4 ? ` +${team.length - 4}` : ""}
                  </div>
                </div>
                <span className="avatars">
                  {team.slice(0, 3).map((u) => (
                    <span key={u.id} className="avatar" title={u.display_name || u.username}>
                      {initials(u.display_name || u.username)}
                    </span>
                  ))}
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
