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

import { ApiError, api, type Connection, type DeployEnvironment, type Deployment, type ProjectTargets } from "./api";
import { ideBuildsOf, type IdeBuild } from "./builds";
import { DataTable } from "./data-table";
import { EnvironmentActions, EnvironmentConfig, EnvironmentPreviews } from "./deploy-actions";
import { EnvironmentForm, ProjectEnvironments } from "./environments-screen";
import {
  STATE_LABELS,
  clusterConnections,
  registryConnections,
  researchConnections,
  shortCommit,
  stateTone,
} from "./environments";
import { errText, relTime } from "./format";
import { KUBERNETES_PROFILES } from "./kits";
import { deployableBuilds, latestByEnvironment, productUrls, profilesBoundTo } from "./project-deploys";
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
  // An environment of the project's own being added or changed (ADR-0054).
  const [own, setOwn] = useState<DeployEnvironment | "new" | null>(null);
  const [places, setPlaces] = useState<{ connections: Connection[]; open: string[] } | null>(null);
  useEffect(() => {
    if (own === null || places !== null) return;
    let live = true;
    Promise.all([
      api.connections(token, projectId).catch(() => ({ items: [] as Connection[] })),
      api.projectEnvironments(token, projectId).catch(() => ({ open_clusters: { connection_ids: [] as string[] } })),
    ]).then(([c, p]) => live && setPlaces({ connections: c.items, open: p.open_clusters.connection_ids }));
    return () => {
      live = false;
    };
  }, [own, places, token, projectId]);
  const removeOwn = async (e: DeployEnvironment) => {
    if (!window.confirm(`Remove ${e.name}? What runs there stays, and its deploys stay in the history.`)) return;
    try {
      await api.deleteProjectEnvironment(token, projectId, e.id);
      changed(`${e.name} is removed.`);
    } catch (err) {
      setError(errText(err));
    }
  };
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
        Where this project&apos;s product runs: the organization&apos;s environments (Organization › Environments) and the
        project&apos;s own, each a cluster, where a deploy installs a build&apos;s published chart, or Constructor Research,
        where it runs a build made there as the project&apos;s application.
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
            No environment yet. Add one of the project&apos;s own below, or ask an organization administrator for one under
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
                      {e.project_id && (
                        <span className="badge" data-own-environment>
                          the project&apos;s own
                        </span>
                      )}
                    </div>
                    {e.description && <div className="sub">{e.description}</div>}
                    {e.promote_from && <div className="sub">takes from {envName(e.promote_from)}</div>}
                  </div>
                ),
              },
              {
                id: "namespace",
                header: "Runs as",
                cell: ({ environment: e, namespace }) =>
                  e.kind === "research" ? (
                    <span data-deploy-research>
                      application <code>{namespace}</code> <span className="sub">in Research project</span>{" "}
                      <code>{e.research_project}</code>
                    </span>
                  ) : (
                    <>
                      <span className="sub">namespace</span> <code>{namespace}</code>
                    </>
                  ),
              },
              {
                id: "images",
                header: "Images from",
                cell: ({ environment: e }) =>
                  e.kind === "research" ? (
                    <span className="sub">built in Constructor Research</span>
                  ) : e.registry ? (
                    <code>{e.registry}</code>
                  ) : (
                    <span className="sub">where the chart says</span>
                  ),
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
                      {d.state === "succeeded" &&
                        productUrls(d.outcome).map((u) => (
                          <div key={u}>
                            <a href={u} target="_blank" rel="noreferrer" data-product-url>
                              Open the product ↗
                            </a>
                          </div>
                        ))}
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
                  {e.project_id && (
                    <div className="row deploy-own-actions">
                      <button type="button" onClick={() => setOwn(e)}>
                        Change {e.name}
                      </button>
                      <button type="button" onClick={() => void removeOwn(e)}>
                        Remove
                      </button>
                    </div>
                  )}
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
                  <EnvironmentPreviews
                    token={token}
                    projectId={projectId}
                    env={e}
                    deployments={deployments}
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
      {targets && !unavailable && own === null && (
        <div className="row">
          <button type="button" onClick={() => setOwn("new")} data-add-own-environment>
            + Add an environment of the project&apos;s own
          </button>
        </div>
      )}
      {targets && own !== null && places === null && <p className="hint">Loading the project&apos;s connections…</p>}
      {targets && own !== null && places !== null && (
        <EnvironmentForm
          token={token}
          org={targets.organization_id}
          ownedBy={{ projectId, projectName: targets.project_name }}
          editing={own === "new" ? null : own}
          others={targets.environments.map((t) => t.environment)}
          clusters={clusterConnections(places.connections).filter(
            (c) => c.owner_tenant_id === projectId || places.open.includes(c.id),
          )}
          registries={registryConnections(places.connections)}
          researches={researchConnections(places.connections)}
          projects={[]}
          onDone={() => {
            const name = own === "new" ? "The environment" : own.name;
            setOwn(null);
            setPlaces(null);
            changed(`${name} is saved.`);
          }}
          onCancel={() => setOwn(null)}
          onClusterAdded={(c) => setPlaces((p) => (p ? { ...p, connections: [...p.connections, c] } : p))}
        />
      )}
      {!unavailable && (
        <div className="card">
          {/* Read again after every change on the tab: chart values saved on
              an environment's row are in the same bindings, and a stale copy
              saved here would put the old ones back. */}
          <ProjectEnvironments
            key={round}
            token={token}
            projectId={projectId}
            profiles={KUBERNETES_PROFILES}
            title="Which environment each profile deploys to"
            onSaved={() => changed("Bindings saved.")}
          />
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
.project-deploys .deploy-previews { margin-top:10px; font-size:13px; }
.project-deploys .deploy-config textarea { width:100%; font-family:var(--font-mono, monospace); font-size:12px; }
.project-deploys .warn { color:var(--warning, #b45309); }
.project-deploys .sub { color:var(--muted-foreground); font-size:12px; }
.project-deploys .deploy-ok { background:color-mix(in srgb, #16a34a 18%, transparent); }
.project-deploys .deploy-warn { background:color-mix(in srgb, #d97706 18%, transparent); }
.project-deploys .deploy-bad { background:color-mix(in srgb, #dc2626 18%, transparent); }
`;
