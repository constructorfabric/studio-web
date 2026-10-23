/* A project's Deploys tab (ADR-0043): where its product runs. One card per
 * environment the organization lets the project deploy to -- the namespace it
 * gets there, the images' registry, what was deployed last and how it went --
 * then the bindings of the product's kubernetes profiles and the history,
 * which `ProjectEnvironments` already draws.
 *
 * Builds before it, because a deploy takes what a build made. The portal
 * never builds: a pipeline (the workflow proposed here) or the IDE publishes a
 * build's images and chart, and Deploy a build names it; the server installs
 * it with the environment's connection (ADR-0048). */

import { useCallback, useEffect, useState } from "react";

import { ApiError, api, type Deployment, type ProjectTargets } from "./api";
import { ideBuildsOf, type IdeBuild } from "./builds";
import { BuildWorkflowProposal, EnvironmentActions, EnvironmentConfig } from "./deploy-actions";
import { ProjectEnvironments } from "./environments-screen";
import { STATE_LABELS, shortCommit, stateTone } from "./environments";
import { errText, relTime } from "./format";
import { KUBERNETES_PROFILES } from "./kits";
import { latestByEnvironment, profilesBoundTo } from "./project-deploys";

export function ProjectDeploys({
  token,
  projectId,
  onOpenStudio,
}: {
  token: string;
  projectId: string;
  onOpenStudio: () => void;
}) {
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [builds, setBuilds] = useState<IdeBuild[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [round, setRound] = useState(0);
  const changed = useCallback((message: string) => {
    setNotice(message);
    setRound((r) => r + 1);
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.projectTargets(token, projectId),
      api.deployments(token, { project: projectId }).catch(() => ({ items: [] as Deployment[], total: 0 })),
      api
        .listArtifactNodes(token, "build", projectId, undefined, 200, { sort: "updated" })
        .then((p) => ideBuildsOf(p.nodes ?? []))
        .catch(() => [] as IdeBuild[]),
    ])
      .then(([t, d, b]) => {
        if (!live) return;
        setTargets(t);
        setDeployments(d.items);
        setBuilds(b);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
        else setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, projectId, round]);
  const envName = (id: string) => targets?.environments.find((t) => t.environment.id === id)?.environment.name ?? id;

  const latest = latestByEnvironment(deployments);

  return (
    <div className="project-deploys" data-project-deploys>
      <style>{DEPLOYS_CSS}</style>
      <h1>Deploys</h1>
      <p className="subtitle">
        Where this project&apos;s product runs. The organization keeps the environments (Organization › Environments); the
        project picks which of them its product goes to. A deploy names a build that published its images and chart -- from
        the workflow below or the IDE -- and the server installs it with the environment&apos;s cluster connection.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && (
        <div className="notice" data-deploy-notice>
          {notice}
        </div>
      )}
      {unavailable ? (
        <p className="empty">This Studio has no environments yet (the backend predates them).</p>
      ) : targets === null ? (
        !error && <p className="hint">Loading…</p>
      ) : targets.environments.length === 0 ? (
        <div className="card">
          <p className="empty">
            The organization has no environment this project may deploy to yet. An organization administrator adds them under
            Organization › Environments.
          </p>
        </div>
      ) : (
        <div className="deploy-envs">
          {targets.environments.map(({ environment: e, namespace }) => {
            const d = latest.get(e.id);
            const profiles = profilesBoundTo(targets.bindings, e.id);
            return (
              <section key={e.id} className="card deploy-env" data-deploy-environment={e.name}>
                <div className="deploy-env-head">
                  <b>{e.name}</b>
                  {e.protected && <span className="badge">needs approval</span>}
                </div>
                {e.description && <div className="sub">{e.description}</div>}
                <dl>
                  <dt>Namespace</dt>
                  <dd>
                    <code>{namespace}</code>
                  </dd>
                  <dt>Images from</dt>
                  <dd>{e.registry ? <code>{e.registry}</code> : <span className="sub">where the chart says</span>}</dd>
                  <dt>Profiles</dt>
                  <dd>
                    {profiles.length ? profiles.map((p) => <code key={p}>{p} </code>) : <span className="sub">none bound yet</span>}
                  </dd>
                  <dt>Last deploy</dt>
                  <dd>
                    {d ? (
                      <>
                        <span className={`badge deploy-${stateTone(d.state)}`}>{STATE_LABELS[d.state] ?? d.state}</span>{" "}
                        {d.commit && <code>{shortCommit(d.commit)}</code>} <span className="sub">{relTime(d.requested_at)}</span>
                      </>
                    ) : (
                      <span className="sub">nothing deployed yet</span>
                    )}
                  </dd>
                  {e.promote_from && (
                    <>
                      <dt>Takes from</dt>
                      <dd>{envName(e.promote_from)}</dd>
                    </>
                  )}
                </dl>
                <EnvironmentActions
                  token={token}
                  projectId={projectId}
                  env={e}
                  latest={d}
                  deployments={deployments}
                  builds={builds}
                  envName={envName}
                  onChanged={changed}
                />
                <EnvironmentConfig
                  key={`${e.id}-${round}`}
                  token={token}
                  projectId={projectId}
                  env={e}
                  bindings={targets.bindings}
                  secrets={targets.secrets ?? []}
                  onChanged={changed}
                />
              </section>
            );
          })}
        </div>
      )}
      {targets && targets.environments.length > 0 && (
        <BuildWorkflowProposal
          token={token}
          projectId={projectId}
          environments={targets.environments.map((t) => t.environment)}
          profiles={[...new Set(targets.bindings.map((b) => b.profile))]}
          onChanged={changed}
        />
      )}
      {targets && targets.environments.length > 0 && (
        <div className="row deploy-how">
          <span className="grow hint">Or from the desktop: open the project in the IDE, Generate, then Deploy to a bound environment.</span>
          <button type="button" onClick={onOpenStudio}>
            Open in IDE
          </button>
        </div>
      )}
      {!unavailable && (
        <div className="card">
          <ProjectEnvironments token={token} projectId={projectId} profiles={KUBERNETES_PROFILES} />
        </div>
      )}
    </div>
  );
}

const DEPLOYS_CSS = `
.project-deploys .deploy-envs { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; margin:12px 0; }
.project-deploys .deploy-env { margin:0; }
.project-deploys .deploy-env-head { display:flex; gap:8px; align-items:baseline; }
.project-deploys .deploy-env dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:10px 0 0; font-size:13px; }
.project-deploys .deploy-env dt { color:var(--muted-foreground); }
.project-deploys .deploy-actions { margin-top:10px; }
.project-deploys .deploy-actions .row { gap:6px; flex-wrap:wrap; }
.project-deploys .deploy-pick { margin-top:8px; }
.project-deploys .deploy-config { margin-top:10px; font-size:13px; }
.project-deploys .deploy-config textarea { width:100%; font-family:var(--font-mono, monospace); font-size:12px; }
.project-deploys .warn { color:var(--warning, #b45309); }
.project-deploys .deploy-env dd { margin:0; overflow-wrap:anywhere; }
.project-deploys .sub { color:var(--muted-foreground); font-size:12px; }
.project-deploys .deploy-ok { background:color-mix(in srgb, #16a34a 18%, transparent); }
.project-deploys .deploy-warn { background:color-mix(in srgb, #d97706 18%, transparent); }
.project-deploys .deploy-bad { background:color-mix(in srgb, #dc2626 18%, transparent); }
.project-deploys .deploy-how { margin:0 0 12px; align-items:center; }
`;
