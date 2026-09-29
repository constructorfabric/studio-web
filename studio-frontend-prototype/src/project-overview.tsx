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
  WorkspaceSettings,
} from "./api";
import { parseRepoSource } from "./artifact-sync";
import { errText, initials, relTime } from "./format";
import { OpenInDesktop } from "./open-in-desktop";

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
 * "people" is Team, "documents" is Specs. Two — activity and timeline — have
 * NO screen behind them yet and say so on the page; they are in the list
 * because the list is the thing being matched, and quietly omitting them would
 * make the nav wrong in the one way that is being checked. "automation" has no
 * counterpart in the product's list and is kept after Team rather than dropped,
 * because dropping it would delete a working screen to win a screenshot
 * comparison.
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
  | "specs"
  | "components"
  | "kits"
  | "artifacts"
  | "sources"
  | "activity"
  | "timeline"
  | "people"
  | "automation";

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
  /** Repository files joined to a document type. */
  /** One row per declared type, folded by studio-documents. */
  const [rows, setRows] = useState<PipelineRow[]>([]);
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
        s,
        cfg,
        typePage,
        stagePage,
        docPage,
        pipelinePage,
        repoPage,
        issue,
        prs,
        files,
        findingPage,
        kitPage,
        users,
        sessionPage,
        who,
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

      setSettings(s);
      setConfig(cfg);
      setTypes(typePage.items ?? []);
      setStageCatalogue(stagePage.items ?? []);
      setDocs(docPage.items ?? []);
      setRows(pipelinePage.items ?? []);
      setRepoNodes(repoPage.nodes ?? []);
      setCounts({ issue, pull_request: prs, file: files });
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

  const started = rows.filter((r) => !r.untouched);
  const notStarted = rows.filter((r) => r.untouched);
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
  //
  // No selection means the whole catalogue, not an empty row. It used to mean
  // an empty row, which was right while the New project card asked for a
  // subset and wrong the moment it stopped: `stage_status` has always computed
  // against every stage the workspace has, so showing none of them hid an
  // answer the server had already worked out. A project that carries a subset
  // -- one created before, or one that gets a stage setting later -- still
  // gets exactly that subset.
  const stages = (config?.stages ?? []).length
    ? stageCatalogue.filter((s) => config?.stages?.includes(s.key))
    : stageCatalogue;

  const liveSession = sessions.find((s) => s.state === "running") ?? sessions[0];
  const installedKits = kits.filter((k) => k.status === "installed").length;

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
      {/* How this project is SET UP — one line, not a card.
          Where it sits is no longer repeated here. The id was already under the
          title two lines above ("project · d5e76267…") and the organization is
          the first segment of the bar's PathBar, so this row opened by telling
          the reader twice what they could already see, and buried the part only
          it knows — kind, status, automation level — behind that. */}
      <div className="dash-context">
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
          label="Specs"
          value={missed("documents") ? "—" : docs.length}
          sub={docs.length ? `${conforming} valid · ${approved} approved` : "none yet"}
          tone={docs.length > 0 && conforming < docs.length ? "warn" : undefined}
          onClick={() => onOpenTab("specs")}
        />
        <Stat
          label="Pipeline"
          value={missed("document types") ? "—" : `${started.length}/${types.length}`}
          sub={notStarted.length ? `${notStarted.length} type${notStarted.length === 1 ? "" : "s"} not started` : "every type covered"}
          onClick={() => onOpenTab("specs")}
        />
        <Stat
          label="Repositories"
          value={missed("workspace settings") ? "—" : repos.length}
          sub={repos.length ? `${syncedRepos} synced` : "none attached"}
          tone={repos.length > 0 && syncedRepos < repos.length ? "warn" : undefined}
          /* Sources, not Artifacts. The stat counts sources and the tone warns
             about unsynced ones, so the place it opens should be the one where
             a sync is run — not the list of what a sync produced. */
          onClick={() => onOpenTab("sources")}
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
          onClick={() => onOpenTab("specs")}
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
                <button className="ghost" onClick={() => onOpenTab("specs")}>
                  Documents →
                </button>
              </div>
            </div>
            <p className="hint">
              One row per document type the workspace defines, counting documents written here and
              repository files bound to that type alike. A type with documents shows how they stand
              and how many satisfy the type's required sections; the rest is what this project has
              neither written nor found. A file a scan only guessed at is shown as unconfirmed and
              left out of the count — a guess is not coverage. “Validate all” re-checks every
              document and lists what the checker objects to.
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

        </div>

        <div className="dash-col">
          {/* ── IDE: this project in the browser (a session) or in the desktop app. ── */}
          <div className="card launcher">
            <div className="card-head">
              <h2>IDE</h2>
              {liveSession && <span className={`badge ${liveSession.state === "running" ? "ok" : "info"}`}>{liveSession.state}</span>}
            </div>
            {/* The one line on this screen that is about the reader. Above the
                session state on purpose: it is the reason to open the IDE, and
                a reason belongs before the door. Silent at zero — a dashboard
                that reports nothing owed on every project teaches people to
                stop reading it — and silent when the sync never read a
                checkout, which is not the same as nothing owed. */}
            {waitingOnMe ? (
              <p className="hint waiting">
                <b>
                  {waitingOnMe} comment {waitingOnMe === 1 ? "thread is" : "threads are"} waiting on
                  you
                </b>{" "}
                in this project. They are answered in the IDE, where the thread sits on the text it
                is about.
              </p>
            ) : null}
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
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <button className="primary" onClick={onOpenStudio} title="Open the running session in this window">
                    Web IDE
                  </button>
                  <OpenInDesktop token={token} project={project} />
                </div>
              </>
            ) : (
              <>
                <p className="hint">
                  Open this project in an IDE. The Web IDE is a session in your browser that clones{" "}
                  {repos.length === 0
                    ? "an empty workspace — attach a repository first to have it check something out"
                    : `${repos.length} attached repositor${repos.length === 1 ? "y" : "ies"} and opens them together`}
                  ; the Desktop IDE does the same in the Constructor Studio app on your machine.
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <button className="primary" onClick={onOpenStudio} title="Start a session for this project and open it in this window">
                    Web IDE
                  </button>
                  <OpenInDesktop token={token} project={project} />
                </div>
              </>
            )}
          </div>

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
