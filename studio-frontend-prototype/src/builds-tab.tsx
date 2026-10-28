// A project's Builds tab (ADR-0045, ADR-0048 §9): the second step of the
// product's way out, after Product composed it and before Deploys installs it.
// One line says where it stands; then Build the product, one scenario at a
// time -- in Studio, as a Job in the organization's cluster; on my machine, in
// the desktop IDE; or in CI, by the repository's workflow, whose runs show
// only there -- then the product's builds, the newest open with how far it got
// (prepare, images, publish) and, once it published its chart, Deploy.

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type BuildLog, type Deployment, type DeployEnvironment, type ProjectConfig } from "./api";
import {
  BUILD_STAGES,
  type BuildRun,
  type BuildScenario,
  type BuildStage,
  type BuildWorkflow,
  type IdeBuild,
  type StageState,
  anyRunning,
  buildDuration,
  buildStages,
  buildWorkflowOf,
  buildsHeadline,
  buildsOf,
  ciReadFailures,
  ideBuildDuration,
  ideBuildsOf,
  isBuildWorkflow,
  isLost,
  openingScenario,
  repoPathsOf,
  statusTone,
  stepToShow,
  workflowsOf,
} from "./builds";
import {
  BuildInStudio,
  DeployBuildTo,
  ProposeBuildWorkflow,
  type SavedProduct,
  buildableEnvironments,
} from "./deploy-actions";
import { errText } from "./format";
import { DesktopMissingHint, desktopLink, useDesktopLauncher } from "./open-in-desktop";
import { buildsHint, type PipelineTab } from "./pipeline";
import { PipelineLine } from "./pipeline-line";

/** At most this many runs are read: the sync keeps the newest few hundred
 *  per repository. */
const LIMIT = 200;

/** How often the product's builds are read again while one runs. */
const FOLLOW_MS = 10_000;

/** CI runs shown before Show all: the newest of the chosen workflow. */
const RUNS_SHOWN = 10;

const SCENARIO_LABEL: Record<BuildScenario, string> = {
  studio: "In Studio",
  desktop: "On my machine",
  ci: "In CI",
};

/** The scenario this member last chose for the project; storage may be
 *  missing or refuse, which is only a convenience lost. */
const scenarioKey = (projectId: string) => `studio.builds.scenario.${projectId}`;
function storedScenario(projectId: string): string | null {
  try {
    return window.localStorage.getItem(scenarioKey(projectId));
  } catch {
    return null;
  }
}
function storeScenario(projectId: string, s: BuildScenario) {
  try {
    window.localStorage.setItem(scenarioKey(projectId), s);
  } catch {
    // Not remembered; the tab still works.
  }
}

export function ProjectBuilds({
  token,
  projectId,
  projectName,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  /** What the desktop app calls the project it opens. */
  projectName?: string;
  /** Open another tab of the project: Deploys, once a build is published. */
  onOpenTab?: (tab: PipelineTab) => void;
}) {
  const [ideBuilds, setIdeBuilds] = useState<IdeBuild[]>([]);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Where the product can be built and deployed: the organization's
  // environments this project may use, its bindings, its deploys.
  const [environments, setEnvironments] = useState<DeployEnvironment[]>([]);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [saved, setSaved] = useState<SavedProduct | null>(null);
  const [chosen, setChosen] = useState<BuildScenario | null>(null);
  const [round, setRound] = useState(0);
  const changed = useCallback((message: string) => {
    setNote(message);
    setRound((r) => r + 1);
  }, []);

  useEffect(() => {
    let live = true;
    api
      .projectConfig(token, projectId)
      .then((c) => live && setConfig(c))
      .catch(() => live && setConfig(null));
    api
      .projectTargets(token, projectId)
      .then((t) => {
        if (!live) return;
        setEnvironments(t.environments.map((e) => e.environment));
        setProfiles([...new Set(t.bindings.map((b) => b.profile))]);
      })
      .catch(() => live && setEnvironments([]));
    // What to build is the Product step's answer: where it last committed
    // product.gdl, on which branch, for which profile.
    api
      .projectProduct(token, projectId)
      .then((p) => {
        if (!live || !p?.written) return;
        setSaved({
          path: p.written.path ?? "product.gdl",
          branch: p.written.branch || null,
          prUrl: p.written.pr_url ?? null,
          profile: p.profile ?? null,
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token, projectId]);

  // The product's builds and the deploys of them, again after an action and,
  // while a build runs, every FOLLOW_MS -- a Studio build reports its stages
  // as it goes.
  useEffect(() => {
    let live = true;
    api
      .listArtifactNodes(token, "build", projectId, undefined, LIMIT, { sort: "updated" })
      .then((page) => live && setIdeBuilds(ideBuildsOf(page.nodes ?? [])))
      .catch(() => live && setIdeBuilds([]));
    api
      .deployments(token, { project: projectId })
      .then((d) => live && setDeployments(d.items))
      .catch(() => live && setDeployments([]));
    return () => {
      live = false;
    };
  }, [token, projectId, round]);
  const running = anyRunning(ideBuilds);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setRound((r) => r + 1), FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  const canBuildInStudio = buildableEnvironments(environments).length > 0;
  const scenario = chosen ?? openingScenario(storedScenario(projectId), canBuildInStudio);
  const pick = (s: BuildScenario) => {
    setChosen(s);
    storeScenario(projectId, s);
  };

  return (
    <>
      <h1>Builds</h1>
      <PipelineLine hint={buildsHint(ideBuilds, canBuildInStudio)} onOpenTab={onOpenTab} />
      {note && (
        <div className="hint" data-builds-note>
          {note}
        </div>
      )}
      <section className="card" data-build-the-product>
        <h2>Build the product</h2>
        <div className="doc-views" role="tablist" aria-label="How to build" data-build-scenarios>
          {(Object.keys(SCENARIO_LABEL) as BuildScenario[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scenario === s}
              className={`doc-view${scenario === s ? " on" : ""}`}
              onClick={() => pick(s)}
              data-build-scenario={s}
            >
              {SCENARIO_LABEL[s]}
            </button>
          ))}
        </div>
        {scenario === "studio" && (
          <BuildInStudio
            token={token}
            projectId={projectId}
            environments={environments}
            profiles={profiles}
            saved={saved}
            onChanged={changed}
          />
        )}
        {scenario === "desktop" && <OnMyMachine projectId={projectId} projectName={projectName} saved={saved} />}
        {scenario === "ci" && (
          <InCi
            token={token}
            projectId={projectId}
            environments={environments}
            profiles={profiles}
            saved={saved}
            config={config}
            setConfig={setConfig}
          />
        )}
      </section>
      <ProductBuilds
        token={token}
        projectId={projectId}
        builds={ideBuilds}
        environments={environments}
        deployments={deployments}
        onChanged={changed}
      />
    </>
  );
}

/** The desktop builds on the member's machine: Generate, Build, then Publish
 *  with a push-only token Studio gives for the environment's registry. Each
 *  build reports itself, so it shows below as `desktop`. Open in the IDE
 *  hands the project to the desktop app, with the product the Product step
 *  saved and its branch, so it opens where Generate starts. */
function OnMyMachine({
  projectId,
  projectName,
  saved,
}: {
  projectId: string;
  projectName?: string;
  saved: SavedProduct | null;
}) {
  const { launch, missing } = useDesktopLauncher();
  const open = () =>
    launch(
      desktopLink({
        id: projectId,
        name: projectName,
        product: saved?.path,
        branch: saved?.branch ?? undefined,
      }),
    );
  return (
    <div data-build-on-my-machine>
      <p>
        The desktop IDE builds on your machine: open the project, <b>Generate</b> the product, <b>Build</b> its images,
        then <b>Publish</b> them and the chart to an environment&apos;s registry with a push-only token Studio gives for
        it. Each build reports itself and shows below, where it says <code>desktop</code>.
      </p>
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="primary"
          onClick={open}
          title="Open this project in the Constructor Studio app on your machine"
          data-builds-open-ide
        >
          Open in the IDE
        </button>
        {missing && <DesktopMissingHint />}
      </div>
    </div>
  );
}

/** The repository's CI builds the product: propose the workflow that does it,
 *  and -- here only -- the CI runs of the project's repositories, the chosen
 *  workflow's newest first, with Build in CI. */
function InCi({
  token,
  projectId,
  environments,
  profiles,
  saved,
  config,
  setConfig,
}: {
  token: string;
  projectId: string;
  environments: DeployEnvironment[];
  profiles: string[];
  saved: SavedProduct | null;
  config: ProjectConfig | null;
  setConfig: (c: ProjectConfig) => void;
}) {
  const [runs, setRuns] = useState<BuildRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ repo: string; error: string }[]>([]);
  const [repoPaths, setRepoPaths] = useState<Map<string, string>>(new Map());
  const [workflow, setWorkflow] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The repositories say whether their CI could be read at all: no runs and
  // "could not read the runs" are different answers. They also name the
  // repository a run belongs to, which Build in CI needs.
  useEffect(() => {
    let live = true;
    api
      .listArtifactNodes(token, "repo", projectId, undefined, 200)
      .then((page) => {
        if (!live) return;
        setFailures(ciReadFailures(page.nodes ?? []));
        setRepoPaths(repoPathsOf(page.nodes ?? []));
      })
      .catch(() => live && setFailures([]));
    api
      .listArtifactNodes(token, "workflow_run", projectId, undefined, LIMIT, { sort: "updated" })
      .then((page) => live && setRuns(buildsOf(page.nodes ?? [])))
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  const workflows = useMemo(() => workflowsOf(runs ?? []), [runs]);
  const setting = config?.build ?? null;
  // The project's build workflow first; else the workflow that runs most,
  // which is usually the one that builds, until a member picks another.
  const settingName = useMemo(
    () =>
      workflows.find((w) => isBuildWorkflow(setting, buildWorkflowOf(runs ?? [], w.name, repoPaths)))?.name ?? "",
    [workflows, setting, runs, repoPaths],
  );
  const chosen = workflow || settingName || workflows[0]?.name || "";
  const candidate = useMemo(() => buildWorkflowOf(runs ?? [], chosen, repoPaths), [runs, chosen, repoPaths]);
  const chosenIsTheBuild = isBuildWorkflow(setting, candidate);
  const branches = useMemo(
    () => [...new Set((runs ?? []).filter((r) => r.workflow === chosen).map((r) => r.branch).filter(Boolean))] as string[],
    [runs, chosen],
  );
  const matching = (runs ?? []).filter((r) => r.workflow === chosen && (!branch || r.branch === branch));
  const shown = all ? matching : matching.slice(0, RUNS_SHOWN);

  const act = async (what: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    setActionError(null);
    try {
      setNote(await what());
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const makeTheBuild = (picked: BuildWorkflow) =>
    act(async () => {
      const current = (await api.projectConfig(token, projectId).catch(() => null)) ?? {};
      const next = { ...current, build: picked };
      await api.putProjectConfig(token, projectId, next);
      setConfig(next);
      return `${picked.workflow} in ${picked.repo} is the project's build workflow now.`;
    });

  const startBuild = (picked: BuildWorkflow) =>
    act(async () => {
      const r = await api.dispatchBuild(token, projectId, {
        repo: picked.repo,
        workflow: picked.workflow,
        ...(branch ? { ref: branch } : {}),
      });
      return `Started ${r.workflow} on ${r.ref} in ${r.repo}. The run shows here after the next sync of the project's sources.`;
    });

  return (
    <div data-build-in-ci>
      <ProposeBuildWorkflow
        token={token}
        projectId={projectId}
        environments={environments}
        profiles={profiles}
        saved={saved}
      />
      {failures.map((f) => (
        <div key={f.repo} className="error" data-builds-ci-error>
          Studio could not read the CI runs of {f.repo}: {f.error}. The connection may lack read access to the
          repository&apos;s Actions.
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      {actionError && (
        <div className="error" data-builds-action-error>
          {actionError}
        </div>
      )}
      {note && (
        <div className="hint" data-builds-ci-note>
          {note}
        </div>
      )}
      {!error && runs === null && <div className="empty">Loading the CI runs…</div>}
      {runs && runs.length === 0 && (
        <div className="empty" data-builds-empty>
          No CI runs yet: they arrive with the next sync of the project&apos;s sources, if the connection can read the
          repository&apos;s Actions.
        </div>
      )}
      {runs && runs.length > 0 && (
        <>
          <div className="card-head" style={{ flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            <div>
              <h3 data-builds-headline>{buildsHeadline(runs, chosen || null, branch || null)}</h3>
              <p className="subtitle">
                {chosenIsTheBuild
                  ? "The project's build workflow; Build in CI starts it."
                  : setting
                    ? `The project's build workflow is ${setting.workflow} in ${setting.repo}.`
                    : "Which workflow builds the product is not set yet; pick it and use it as the build workflow."}
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                aria-label="Workflow"
                value={chosen}
                onChange={(e) => {
                  setWorkflow(e.target.value);
                  // The branch picked may not exist in the other workflow.
                  setBranch("");
                }}
              >
                {workflows.map((w) => (
                  <option key={w.name} value={w.name}>
                    {w.name} ({w.runs})
                  </option>
                ))}
              </select>
              <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">every branch</option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              {candidate && !chosenIsTheBuild && (
                <button type="button" disabled={busy} onClick={() => void makeTheBuild(candidate)} data-builds-set>
                  Use as the build workflow
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={busy || !candidate}
                title={
                  candidate
                    ? `Start ${candidate.workflow} on ${branch || "the repository's branch"} in CI`
                    : "Its runs name no workflow file this connection can start"
                }
                onClick={() => candidate && void startBuild(candidate)}
                data-builds-start
              >
                {busy ? "Starting…" : "Build in CI"}
              </button>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table" data-builds-table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Commit</th>
                  <th>Branch</th>
                  <th>Started by</th>
                  <th>When</th>
                  <th>Took</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} data-build-status={r.status}>
                    <td>
                      <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <code>{r.shortSha}</code>{" "}
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.title || `run ${r.number ?? ""}`}
                        </a>
                      ) : (
                        r.title
                      )}
                      {r.attempt && r.attempt > 1 ? <span className="sub"> · attempt {r.attempt}</span> : null}
                    </td>
                    <td>{r.branch ?? "—"}</td>
                    <td>
                      {r.author ?? "—"}
                      {r.event ? <span className="sub"> · {r.event}</span> : null}
                    </td>
                    <td>{r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}</td>
                    <td>{buildDuration(r) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matching.length > RUNS_SHOWN && (
            <button type="button" className="linklike" onClick={() => setAll((v) => !v)} data-builds-show-all>
              {all ? `Show the newest ${RUNS_SHOWN}` : `Show all ${matching.length} runs`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The product's builds, newest first -- run by Studio, the IDE or CI. The
 *  newest is open: its stages, what failed or what it published, and Deploy;
 *  an older one opens on a click. A Studio build whose Job's hour is long past
 *  without word is lost, not running. */
function ProductBuilds({
  token,
  projectId,
  builds,
  environments,
  deployments,
  onChanged,
}: {
  token: string;
  projectId: string;
  builds: IdeBuild[];
  environments: DeployEnvironment[];
  deployments: Deployment[];
  onChanged: (message: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const product = builds.filter((b) => b.action !== "run");
  if (product.length === 0) return null;
  const [newest, ...older] = product;
  return (
    <section className="card" data-product-builds>
      <h2>Builds</h2>
      <BuildCard
        build={newest}
        token={token}
        projectId={projectId}
        environments={environments}
        deployments={deployments}
        onChanged={onChanged}
      />
      {older.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="table" data-ide-builds-table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Stages</th>
                <th>Where</th>
                <th>Commit</th>
                <th>When</th>
                <th>Took</th>
              </tr>
            </thead>
            <tbody>
              {older.map((b) =>
                open === b.id ? (
                  <tr key={b.id} data-ide-build-status={b.status}>
                    <td colSpan={6}>
                      <BuildCard
                        build={b}
                        token={token}
                        projectId={projectId}
                        environments={environments}
                        deployments={deployments}
                        onChanged={onChanged}
                        onClose={() => setOpen(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={b.id}
                    data-ide-build-status={b.status}
                    style={{ cursor: "pointer" }}
                    onClick={() => setOpen(b.id)}
                    title="Open this build"
                  >
                    <td>
                      <StatusBadge build={b} />
                    </td>
                    <td>
                      <StageLane build={b} />
                    </td>
                    <td>{b.where}</td>
                    <td>{b.shortSha ? <code>{b.shortSha}</code> : (b.branch ?? "—")}</td>
                    <td>{b.startedAt ? new Date(b.startedAt).toLocaleString() : "—"}</td>
                    <td>{isLost(b) ? "—" : (ideBuildDuration(b) ?? "—")}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One build, open: what and where, its stages, what failed or what it
 *  published, and Deploy once it published a chart. */
function BuildCard({
  build: b,
  token,
  projectId,
  environments,
  deployments,
  onChanged,
  onClose,
}: {
  build: IdeBuild;
  token: string;
  projectId: string;
  environments: DeployEnvironment[];
  deployments: Deployment[];
  onChanged: (message: string) => void;
  onClose?: () => void;
}) {
  const lost = isLost(b);
  return (
    <div data-build-card={b.buildId} data-build-card-status={lost ? "lost" : b.status}>
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusBadge build={b} />
        <b>
          {b.product ?? "The product"}
          {b.profile ? <span className="sub"> · {b.profile}</span> : null}
        </b>
        <StageLane build={b} />
        <span className="grow sub">
          {b.where}
          {b.branch ? <> · {b.branch}</> : null}
          {b.shortSha ? (
            <>
              {" "}
              · <code>{b.shortSha}</code>
            </>
          ) : null}
          {b.startedAt ? <> · {new Date(b.startedAt).toLocaleString()}</> : null}
          {!lost && ideBuildDuration(b) ? <> · {ideBuildDuration(b)}</> : null}
        </span>
        {onClose && (
          <button type="button" className="linklike" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {lost && (
        <p className="hint" data-build-lost>
          Lost: no word from its Job since {b.startedAt ? new Date(b.startedAt).toLocaleString() : "it started"}, past
          the hour a build may take. How it ended is not known; build again.
        </p>
      )}
      {b.where === "studio" && (
        <BuildLogPanel token={token} projectId={projectId} buildId={b.buildId} running={b.status === "running"} />
      )}
      {b.status === "failed" && b.failure && (
        <div className="error" style={{ marginTop: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-ide-build-failure>
          {b.failureStep ? `${b.failureStep}: ` : ""}
          {b.failure}
        </div>
      )}
      {b.images.length > 0 ? (
        <ul className="sub" style={{ margin: "8px 0 0", paddingLeft: 16 }} data-build-images>
          {b.images.map((i) => (
            <li key={i.app}>
              {i.app} → <code>{i.image}</code>
            </li>
          ))}
        </ul>
      ) : b.outputs.length > 0 ? (
        <div className="sub">{b.outputs.join(", ")}</div>
      ) : null}
      {b.chartRef ? (
        <div className="sub" data-build-chart>
          chart <code>{b.chartRef}</code>
          {b.chartVersion ? <>:{b.chartVersion}</> : null}
        </div>
      ) : null}
      {b.status === "passed" && b.chartRef && b.chartVersion && (
        <DeployBuildTo
          token={token}
          projectId={projectId}
          build={b}
          environments={environments}
          deployments={deployments}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/** A build Studio runs, step by step with the end of each step's log, read
 *  from its pod on demand and again every LOG_FOLLOW_MS while it runs. The
 *  pod is the truth here: a step that failed shows failed even before the
 *  build's record says so. */
function BuildLogPanel({
  token,
  projectId,
  buildId,
  running,
}: {
  token: string;
  projectId: string;
  buildId: string;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<BuildLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const live = !log || log.steps.some((s) => s.state === "running" || (running && s.state === "waiting"));

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer: number | undefined;
    const read = () =>
      api
        .buildLog(token, projectId, buildId)
        .then((l) => {
          if (!alive) return;
          setLog(l);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(errText(e)))
        .finally(() => {
          if (alive && live) timer = window.setTimeout(() => void read(), LOG_FOLLOW_MS);
        });
    void read();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, token, projectId, buildId, live]);

  const shown = step ?? stepToShow(log?.steps ?? []);
  const text = log?.steps.find((s) => s.step === shown)?.log ?? "";
  return (
    <div style={{ marginTop: 8 }} data-build-log={buildId}>
      <button type="button" className="linklike" onClick={() => setOpen((o) => !o)} data-build-log-toggle>
        {open ? "Hide the log" : "Show the log"}
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {error && <div className="error">{error}</div>}
          {!log && !error && <div className="hint">Reading the build&apos;s pod…</div>}
          {log && (
            <>
              <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div className="doc-views" role="tablist" aria-label="Build steps" style={{ marginBottom: 6 }}>
                  {log.steps.map((s) => (
                    <button
                      key={s.step}
                      type="button"
                      role="tab"
                      aria-selected={shown === s.step}
                      className={`doc-view${shown === s.step ? " on" : ""}`}
                      disabled={s.state === "waiting"}
                      onClick={() => setStep(s.step)}
                      data-build-log-step={s.step}
                      data-build-log-state={s.state}
                    >
                      {STAGE_MARK[STEP_STAGE[s.state] ?? "waiting"]} {s.step}
                    </button>
                  ))}
                </div>
                <span className="sub">
                  {log.environment} · <code>{log.namespace}</code>
                  {live ? " · following" : ""}
                </span>
              </div>
              {shown ? (
                <pre className="build-log" data-build-log-text>
                  {text || "(nothing written yet)"}
                </pre>
              ) : (
                <div className="hint">No step has started yet.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A pod step's state as a stage's, for its mark. */
const STEP_STAGE: Record<string, StageState> = {
  passed: "done",
  running: "running",
  failed: "failed",
  waiting: "waiting",
};

/** How often an open log is read again while its build runs. */
const LOG_FOLLOW_MS = 5_000;

/** The build's status; a lost one says so, in a warning's tone. */
function StatusBadge({ build: b }: { build: IdeBuild }) {
  return isLost(b) ? (
    <span className="badge warn" data-build-lost-badge>
      lost
    </span>
  ) : (
    <span className={`badge ${statusTone(b.status)}`}>{b.status}</span>
  );
}

const STAGE_TONE: Record<StageState, string> = { done: "ok", running: "info", failed: "danger", waiting: "neutral" };
const STAGE_MARK: Record<StageState, string> = { done: "✓", running: "…", failed: "✕", waiting: "" };

/** prepare → images → publish, each as a badge in its state. A run of the
 *  product has no stages; a lost build's are not known past what it said. */
function StageLane({ build: b }: { build: IdeBuild }) {
  if (b.action === "run") return <span className="sub">—</span>;
  const stages: Record<BuildStage, StageState> = buildStages(b);
  const lost = isLost(b);
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", whiteSpace: "nowrap" }} data-build-stages>
      {BUILD_STAGES.map((stage, i) => {
        const state: StageState = lost && stages[stage] === "running" ? "waiting" : stages[stage];
        return (
          <span key={stage} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            {i > 0 && <span className="sub">→</span>}
            <span className={`badge ${STAGE_TONE[state]}`} data-stage={stage} data-stage-state={state}>
              {STAGE_MARK[state]} {stage}
            </span>
          </span>
        );
      })}
    </span>
  );
}
