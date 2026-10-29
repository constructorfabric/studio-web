/* A project's Deploys tab (ADR-0043): where its product runs. One table row
 * per environment the organization lets the project deploy to -- the
 * namespace it gets there, the images' registry, the profiles bound to it,
 * what was deployed last and how it went -- with Deploy a build and the
 * release's configuration under the open row; then the bindings of the
 * product's kubernetes profiles and the history, which `ProjectEnvironments`
 * already draws.
 *
 * The last step of the product's way out: Builds before it publishes a
 * build's images and chart -- in Studio, the IDE or CI -- and Deploy a build
 * names it; the server installs it with the environment's connection
 * (ADR-0048). It opens on one line saying where the project stands. */

import { useCallback, useEffect, useState } from "react";

import { ApiError, api, type DeployEnvironment, type Deployment, type ProjectTargets } from "./api";
import { ideBuildsOf, type IdeBuild } from "./builds";
import { DataTable } from "./data-table";
import { EnvironmentActions, EnvironmentConfig } from "./deploy-actions";
import { ProjectEnvironments } from "./environments-screen";
import { STATE_LABELS, shortCommit, stateTone } from "./environments";
import { errText, relTime } from "./format";
import { KUBERNETES_PROFILES } from "./kits";
import { deployableBuilds, latestByEnvironment, profilesBoundTo } from "./project-deploys";
import { deploysHint, type PipelineTab } from "./pipeline";
import { PipelineLine } from "./pipeline-line";

type Target = { environment: DeployEnvironment; namespace: string };

export function ProjectDeploys({
  token,
  projectId,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  /** Open another tab of the project: Builds, when nothing is published. */
  onOpenTab?: (tab: PipelineTab) => void;
}) {
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [builds, setBuilds] = useState<IdeBuild[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [round, setRound] = useState(0);
  // `undefined`: the first environment, until the reader opens or closes one.
  const [open, setOpen] = useState<string | null | undefined>(undefined);
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
  const shown = open === undefined ? (targets?.environments[0]?.environment.id ?? null) : open;

  return (
    <div className="project-deploys" data-project-deploys>
      <style>{DEPLOYS_CSS}</style>
      <h1>Deploys</h1>
      <p className="subtitle">
        Where this project&apos;s product runs. The organization keeps the environments (Organization › Environments); a
        deploy installs a build that published its images and chart with the environment&apos;s cluster connection.
      </p>
      {targets && (
        <PipelineLine
          hint={deploysHint({
            environments: targets.environments.length,
            bound: targets.bindings.length,
            deployable: deployableBuilds(builds).length,
            deployments,
          })}
          onOpenTab={onOpenTab}
        />
      )}
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
        <section className="card" data-deploy-environments>
          <DataTable<Target>
            list="project-deploy-environments"
            title="Where it runs"
            rows={targets.environments}
            rowKey={(t) => t.environment.id}
            rowLabel={(t) => t.environment.name}
            onOpen={(t) => setOpen(shown === t.environment.id ? null : t.environment.id)}
            defaultView="table"
            empty={{ title: "No environment yet." }}
            columns={[
              {
                id: "environment",
                header: "Environment",
                compare: (x, y) => x.environment.name.localeCompare(y.environment.name),
                cell: ({ environment: e }) => (
                  <div data-deploy-environment={e.name}>
                    <div className="deploy-env-head">
                      <b>{e.name}</b>
                      {e.protected && <span className="badge">needs approval</span>}
                    </div>
                    {e.description && <div className="sub">{e.description}</div>}
                    {e.promote_from && <div className="sub">takes from {envName(e.promote_from)}</div>}
                  </div>
                ),
              },
              { id: "namespace", header: "Namespace", cell: (t) => <code>{t.namespace}</code> },
              {
                id: "images",
                header: "Images from",
                cell: ({ environment: e }) =>
                  e.registry ? <code>{e.registry}</code> : <span className="sub">where the chart says</span>,
              },
              {
                id: "profiles",
                header: "Profiles",
                cell: ({ environment: e }) => {
                  const profiles = profilesBoundTo(targets.bindings, e.id);
                  return profiles.length ? (
                    profiles.map((p) => <code key={p}>{p} </code>)
                  ) : (
                    <span className="sub">none bound yet</span>
                  );
                },
              },
              {
                id: "last",
                header: "Last deploy",
                cell: ({ environment: e }) => {
                  const d = latest.get(e.id);
                  return d ? (
                    <>
                      <span className={`badge deploy-${stateTone(d.state)}`}>{STATE_LABELS[d.state] ?? d.state}</span>{" "}
                      {d.commit && <code>{shortCommit(d.commit)}</code>} <span className="sub">{relTime(d.requested_at)}</span>
                    </>
                  ) : (
                    <span className="sub">nothing deployed yet</span>
                  );
                },
              },
            ]}
            detail={({ environment: e }) =>
              e.id === shown ? (
                <div className="deploy-env">
                  <EnvironmentActions
                    token={token}
                    projectId={projectId}
                    env={e}
                    latest={latest.get(e.id)}
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
                </div>
              ) : null
            }
          />
        </section>
      )}
      {!unavailable && (
        <div className="card">
          <ProjectEnvironments token={token} projectId={projectId} profiles={KUBERNETES_PROFILES} title="Which environment each profile deploys to" />
        </div>
      )}
    </div>
  );
}

const DEPLOYS_CSS = `
.project-deploys .deploy-env { margin:0; }
.project-deploys .deploy-env-head { display:flex; gap:8px; align-items:baseline; }
.project-deploys .deploy-actions { margin-top:10px; }
.project-deploys .deploy-actions .row { gap:6px; flex-wrap:wrap; }
.project-deploys .deploy-pick { margin-top:8px; }
.project-deploys .deploy-config { margin-top:10px; font-size:13px; }
.project-deploys .deploy-config textarea { width:100%; font-family:var(--font-mono, monospace); font-size:12px; }
.project-deploys .warn { color:var(--warning, #b45309); }
.project-deploys .sub { color:var(--muted-foreground); font-size:12px; }
.project-deploys .deploy-ok { background:color-mix(in srgb, #16a34a 18%, transparent); }
.project-deploys .deploy-warn { background:color-mix(in srgb, #d97706 18%, transparent); }
.project-deploys .deploy-bad { background:color-mix(in srgb, #dc2626 18%, transparent); }
`;
