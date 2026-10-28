// A project's Builds tab (ADR-0045, ADR-0048 §9): the second step of the
// product's way out, after Product composed it and before Deploys installs it.
// Build first -- in Studio, as a Job in the organization's cluster; in the
// IDE; or by a CI workflow -- then the product's builds with how far each got
// (prepare, images, publish) and, once one published its chart, Deploy; then
// the CI runs of the project's repositories, as the artifact sync reads them.

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type Deployment, type DeployEnvironment, type ProjectConfig } from "./api";
import {
  BUILD_STAGES,
  type BuildRun,
  type BuildStage,
  type BuildWorkflow,
  type IdeBuild,
  type StageState,
  buildDuration,
  buildStages,
  buildWorkflowOf,
  buildsHeadline,
  buildsOf,
  ciReadFailures,
  ideBuildDuration,
  ideBuildsOf,
  isBuildWorkflow,
  repoPathsOf,
  statusTone,
  workflowsOf,
} from "./builds";
import { BuildWorkflowProposal, DeployBuildTo } from "./deploy-actions";
import { errText } from "./format";
import { buildsHint, type PipelineTab } from "./pipeline";
import { PipelineLine } from "./pipeline-line";

/** At most this many runs are read: the sync keeps the newest few hundred
 *  per repository. */
const LIMIT = 200;

/** How often the product's builds are read again while one runs. */
const FOLLOW_MS = 10_000;

export function ProjectBuilds({
  token,
  projectId,
  onOpenStudio,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  /** Open the project in the IDE, where Build, Run and Deploy run. */
  onOpenStudio?: () => void;
  /** Open another tab of the project: Deploys, once a build is published. */
  onOpenTab?: (tab: PipelineTab) => void;
}) {
  const [runs, setRuns] = useState<BuildRun[] | null>(null);
  const [ideBuilds, setIdeBuilds] = useState<IdeBuild[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [failures, setFailures] = useState<{ repo: string; error: string }[]>([]);
  const [repoPaths, setRepoPaths] = useState<Map<string, string>>(new Map());
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Where the product can be built and deployed: the organization's
  // environments this project may use, its bindings, its deploys.
  const [environments, setEnvironments] = useState<DeployEnvironment[]>([]);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [round, setRound] = useState(0);
  const changed = useCallback((message: string) => {
    setNote(message);
    setRound((r) => r + 1);
  }, []);

  // The repositories say whether their CI could be read at all: no runs and
  // "could not read the runs" are different answers. They also name the
  // repository a run belongs to, which Build needs.
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
  const running = ideBuilds.some((b) => b.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setRound((r) => r + 1), FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setError(null);
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
  const shown = (runs ?? []).filter((r) => r.workflow === chosen && (!branch || r.branch === branch));

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
    <>
      <h1>Builds</h1>
      <p className="subtitle">
        The product Product composed, built into images and published with its chart to an environment&apos;s
        registry, ready for Deploys. Studio builds it as a Job in the organization&apos;s cluster; the IDE builds it on
        a member&apos;s machine; CI builds it on every push. Below: each build&apos;s stages as it goes, then the CI runs
        of the project&apos;s repositories on every sync.
      </p>
      <PipelineLine
        hint={buildsHint(ideBuilds, environments.some((e) => !!e.registry_connection_id))}
        onOpenTab={onOpenTab}
      />
      {error && <div className="error">{error}</div>}
      {failures.map((f) => (
        <div key={f.repo} className="error" data-builds-ci-error>
          Studio could not read the CI runs of {f.repo}: {f.error}. The connection may lack read access to the
          repository&apos;s Actions.
        </div>
      ))}
      {actionError && (
        <div className="error" data-builds-action-error>
          {actionError}
        </div>
      )}
      {note && (
        <div className="hint" data-builds-note>
          {note}
        </div>
      )}
      {environments.length > 0 ? (
        <BuildWorkflowProposal
          token={token}
          projectId={projectId}
          environments={environments}
          profiles={profiles}
          onChanged={changed}
          onOpenStudio={onOpenStudio}
        />
      ) : (
        <div className="card row" data-build-without-environment>
          <span className="grow hint">
            Building in Studio or by a CI workflow publishes to an environment&apos;s registry, and this project has no
            environment yet (Organization › Environments). The IDE builds without one.
          </span>
          {onOpenStudio && (
            <button type="button" onClick={onOpenStudio}>
              Open in the IDE
            </button>
          )}
        </div>
      )}
      <ProductBuilds
        token={token}
        projectId={projectId}
        builds={ideBuilds}
        environments={environments}
        deployments={deployments}
        onChanged={changed}
      />
      {!error && runs === null && <div className="empty">Loading…</div>}
      {runs && runs.length === 0 && (
        <div className="empty" data-builds-empty>
          No CI runs yet. Next: push the composed product to a repository with a CI workflow, then sync it on
          Sources; runs arrive if the connection can read the repository&apos;s Actions.
        </div>
      )}
      {runs && runs.length > 0 && (
        <section className="card">
          <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
            <div>
              <h2 data-builds-headline>{buildsHeadline(runs, chosen || null, branch || null)}</h2>
              <p className="subtitle">
                Newest first. A run links to its page in CI.{" "}
                {chosenIsTheBuild
                  ? "This is the project's build workflow: Build starts it."
                  : setting
                    ? `The project's build workflow is ${setting.workflow} in ${setting.repo}.`
                    : "Which workflow builds the product is not set yet, so this speaks of the one you pick."}
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
              {onOpenStudio && (
                <button type="button" onClick={onOpenStudio} data-builds-open-ide>
                  Open in the IDE
                </button>
              )}
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
        </section>
      )}
    </>
  );
}

/** The product's builds, newest first -- run by Studio, the IDE or CI -- each
 *  with how far it got: a failed one with its first error, so the next member
 *  does not rebuild to find it; a published one with its images and chart, and
 *  Deploy. */
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
  if (builds.length === 0) return null;
  return (
    <section className="card" data-product-builds>
      <div className="card-head">
        <div>
          <h2>Product builds</h2>
          <p className="subtitle">
            In Studio, in a member&apos;s desktop or a session, or in CI, as each reported itself. A build prepares the
            product&apos;s tree, builds its images, then publishes them and the chart; a published one deploys from
            here or from Deploys.
          </p>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="table" data-ide-builds-table>
          <thead>
            <tr>
              <th>Status</th>
              <th>What</th>
              <th>Stages</th>
              <th>Commit</th>
              <th>Where</th>
              <th>When</th>
              <th>Took</th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr key={b.id} data-ide-build-status={b.status}>
                <td>
                  <span className={`badge ${statusTone(b.status)}`}>{b.status}</span>
                </td>
                <td style={{ minWidth: 260 }}>
                  {b.action === "run" ? "Run" : "Build"} {b.product ?? "the product"}
                  {b.profile ? <span className="sub"> · {b.profile}</span> : null}
                  {b.status === "failed" && b.failure ? (
                    <div className="error" style={{ marginTop: 4, whiteSpace: "pre-wrap" }} data-ide-build-failure>
                      {b.failureStep ? `${b.failureStep}: ` : ""}
                      {b.failure}
                    </div>
                  ) : null}
                  {b.images.length > 0 ? (
                    <ul className="sub" style={{ margin: "4px 0 0", paddingLeft: 16 }} data-build-images>
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
                </td>
                <td>{b.action === "run" ? "—" : <StageLane stages={buildStages(b)} />}</td>
                <td>
                  {b.shortSha ? <code>{b.shortSha}</code> : "—"}
                  {b.branch ? <span className="sub"> · {b.branch}</span> : null}
                </td>
                <td>{b.where}</td>
                <td>{b.startedAt ? new Date(b.startedAt).toLocaleString() : "—"}</td>
                <td>{ideBuildDuration(b) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const STAGE_TONE: Record<StageState, string> = { done: "ok", running: "info", failed: "danger", waiting: "neutral" };
const STAGE_MARK: Record<StageState, string> = { done: "✓", running: "…", failed: "✕", waiting: "" };

/** prepare → images → publish, each as a badge in its state. */
function StageLane({ stages }: { stages: Record<BuildStage, StageState> }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", whiteSpace: "nowrap" }} data-build-stages>
      {BUILD_STAGES.map((stage, i) => (
        <span key={stage} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {i > 0 && <span className="sub">→</span>}
          <span className={`badge ${STAGE_TONE[stages[stage]]}`} data-stage={stage} data-stage-state={stages[stage]}>
            {STAGE_MARK[stages[stage]]} {stage}
          </span>
        </span>
      ))}
    </span>
  );
}
