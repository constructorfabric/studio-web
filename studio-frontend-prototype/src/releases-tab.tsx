/* A project's Releases tab (ADR-0056 §4): how its product goes out. It was
 * two tabs, Builds and Deploys, with nothing leading from one to the next.
 *
 *   - The header (ui-standard.tsx) says where the product stands, read from
 *     the ladder (releaseStatus); the explanation is behind its "?".
 *   - Then the steps, as a StepFlow of cards: 1 Build (builds-tab.tsx),
 *     2 Deploy, 3 Images (project-images.tsx) and 4 History, the last two
 *     folded until opened.
 *   - In Deploy, the ladder: the environments the project may deploy to in
 *     `promote_from` order (releases.ts), each with what runs there, how its
 *     newest deploy went, whether one waits for approval, and the action that
 *     applies -- Promote what the environment before it runs, or Deploy a
 *     published build. A step opened below the ladder has the rest of what
 *     the Deploys tab had on an environment's row: roll back, uninstall,
 *     previews, the release's values and secrets.
 *   - Folded under it, Environments of this project: the bindings of
 *     the product's profiles and the project's own environments (ADR-0054).
 *     It is the only place a project adds one.
 *
 * A build is published in Studio, the IDE or CI; a deploy names it and the
 * server installs it with the environment's connection (ADR-0048). */

import { useCallback, useEffect, useState } from "react";

import { ApiError, api, type Connection, type DeployEnvironment, type Deployment, type ProjectTargets } from "./api";
import { ideBuildsOf, type IdeBuild } from "./builds";
import { ProjectBuilds } from "./builds-tab";
import { EnvironmentActions, EnvironmentConfig, EnvironmentPreviews, RungPlace, useDeployRequest } from "./deploy-actions";
import { EnvironmentForm, ProjectEnvironments } from "./environments-screen";
import { clusterConnections, registryConnections, researchConnections } from "./environments";
import { errText, relTime } from "./format";
import { KUBERNETES_PROFILES } from "./product";
import { deployableBuilds, productUrls, profilesBoundTo } from "./project-deploys";
import { deploysHint, type PipelineTab } from "./pipeline";
import { PipelineLine } from "./pipeline-line";
import { ladderSteps, newestRelease, releaseStatus, stepStatus, versionOf, type LadderStep } from "./releases";
import { ProjectImages } from "./project-images";
import { ProductSources } from "./source-roles-view";
import { PageHeader, StatusChip, StepFlow, type Tone } from "./ui-standard";

export function ProjectReleases({
  token,
  projectId,
  projectName,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  /** What the desktop app calls the project it opens. */
  projectName?: string;
  /** Open another tab of the project: Product, when a line says so. */
  onOpenTab?: (tab: PipelineTab) => void;
}) {
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [builds, setBuilds] = useState<IdeBuild[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // `round`: this tab reads again. `shared`: so do the builds below, which
  // read on their own -- not bumped by a change they made themselves.
  const [round, setRound] = useState(0);
  const [shared, setShared] = useState(0);
  // The step opened under the ladder; none until the reader opens one.
  const [open, setOpen] = useState<string | null>(null);
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
  const changed = useCallback((message: string) => {
    setNotice(message);
    setRound((r) => r + 1);
    setShared((r) => r + 1);
  }, []);
  const buildsChanged = useCallback(() => setRound((r) => r + 1), []);
  const removeOwn = async (e: DeployEnvironment) => {
    if (!window.confirm(`Remove ${e.name}? What runs there stays, and its deploys stay in the history.`)) return;
    try {
      await api.deleteProjectEnvironment(token, projectId, e.id);
      if (open === e.id) setOpen(null);
      changed(`${e.name} is removed.`);
    } catch (err) {
      setError(errText(err));
    }
  };

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

  const steps = targets ? ladderSteps(targets.environments, deployments, builds) : [];
  const step = steps.find((s) => s.environment.id === open) ?? null;
  const ownEnvironments = targets?.environments.filter((t) => !!t.environment.project_id).map((t) => t.environment) ?? [];
  const noEnvironment = !!targets && targets.environments.length === 0;

  const published = deployableBuilds(builds).length;
  const status = targets ? releaseStatus(steps, published) : null;

  return (
    <div className="project-deploys" data-project-releases>
      <style>{RELEASES_CSS}</style>
      <PageHeader
        title="Releases"
        status={
          status ? (
            status.map((c) => (
              <StatusChip key={c.text} tone={c.tone}>
                {c.text}
              </StatusChip>
            ))
          ) : unavailable ? (
            <StatusChip tone="neutral">no environments in this Studio</StatusChip>
          ) : (
            !error && <span>Reading…</span>
          )
        }
        info={
          <>
            <p>
              Build the product, deploy it to the first environment, then let the release climb the environments in
              order: each environment takes from the one before it.
            </p>
            <p>
              A build is published in Studio, the IDE or CI; a deploy names it and the server installs it with the
              environment&apos;s connection. A protected environment waits for an administrator to approve.
            </p>
          </>
        }
      />
      {targets && published > 0 && (
        <PipelineLine
          hint={deploysHint({
            environments: targets.environments.length,
            bound: targets.bindings.length,
            deployable: published,
            deployments,
          })}
          onOpenTab={onOpenTab}
          here="releases"
        />
      )}
      {error && <div className="error">{error}</div>}
      {notice && (
        <div className="notice" data-deploy-notice>
          {notice}
        </div>
      )}
      <StepFlow
        label="How the product goes out"
        steps={[
          {
            id: "build",
            title: "Build",
            state: published > 0 ? "done" : "current",
            status:
              published > 0
                ? `${published} published build${published === 1 ? "" : "s"}; the newest is ready to deploy.`
                : "Nothing published yet: build the product first.",
            body: (
              <>
                <ProductSources key={shared} token={token} projectId={projectId} />
                <ProjectBuilds
                  token={token}
                  projectId={projectId}
                  projectName={projectName}
                  onOpenTab={onOpenTab}
                  round={shared}
                  onChanged={buildsChanged}
                  embedded
                />
              </>
            ),
          },
          {
            id: "deploy",
            title: "Deploy",
            state: steps.some((s) => !!s.runs) ? "done" : published === 0 ? "later" : "current",
            keepOpen: true,
            status: noEnvironment
              ? "No environment to deploy to yet."
              : steps.some((s) => !!s.runs)
                ? "Running; a release climbs the environments in order."
                : published === 0
                  ? "Once a build is published, deploy it to the first environment."
                  : "Deploy the newest build to the first environment.",
            body: deployBody(),
          },
          ...(unavailable
            ? []
            : [
                {
                  id: "images",
                  title: "Images",
                  state: "todo" as const,
                  quiet: true,
                  status: "What the builds pushed, where each runs, and how long they are kept.",
                  body: (
                    <ProjectImages
                      token={token}
                      projectId={projectId}
                      projectName={targets?.project_name ?? projectName ?? "project"}
                      environments={targets?.environments.map((t) => t.environment) ?? []}
                      round={round}
                    />
                  ),
                },
                {
                  id: "history",
                  title: "History",
                  state: "todo" as const,
                  quiet: true,
                  status: deployments.length
                    ? `${deployments.length} deploy${deployments.length === 1 ? "" : "s"} so far.`
                    : "Nothing deployed yet.",
                  body: (
                    <div data-deploy-history>
                      <ProjectEnvironments
                        key={round}
                        token={token}
                        projectId={projectId}
                        profiles={KUBERNETES_PROFILES}
                        title="Deploy history"
                        show="history"
                      />
                    </div>
                  ),
                },
              ]),
        ]}
      />
    </div>
  );

  /** Step 2: the ladder, the environment opened under it, and the
   *  environments of this project, folded. */
  function deployBody() {
    return (
      <>
      {unavailable ? (
        <p className="empty">This Studio has no environments yet (the backend predates them).</p>
      ) : targets === null ? (
        !error && <p className="hint">Loading…</p>
      ) : noEnvironment ? (
        <div className="card">
          <p className="empty">
            No environment yet. Add one of the project&apos;s own under Environments of this project below, or ask an
            organization administrator for one under Organization › Infrastructure.
          </p>
        </div>
      ) : (
        <ReleaseLadder
          token={token}
          projectId={projectId}
          steps={steps}
          bindings={targets.bindings}
          open={open}
          onOpen={(id) => setOpen(open === id ? null : id)}
          onChanged={changed}
        />
      )}
      {targets && step && (
        <section className="card deploy-env" data-release-step={step.environment.name}>
          <div className="card-head">
            <h3>{step.environment.name}</h3>
            <button type="button" className="ghost" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <EnvironmentActions
            token={token}
            projectId={projectId}
            env={step.environment}
            latest={step.latest ?? undefined}
            deployments={deployments}
            builds={builds}
            envName={envName}
            organizationId={targets.organization_id}
            onChanged={changed}
          />
          <EnvironmentPreviews
            token={token}
            projectId={projectId}
            env={step.environment}
            deployments={deployments}
            onChanged={changed}
          />
          <EnvironmentConfig
            key={`${step.environment.id}-${round}`}
            token={token}
            projectId={projectId}
            env={step.environment}
            bindings={targets.bindings}
            secrets={targets.secrets ?? []}
            onChanged={changed}
          />
        </section>
      )}

      {targets && !unavailable && (
        // Folded: the exception, not the way a release goes (ADR-0056 §1).
        // Open when there is nothing else to deploy to, or a form is open.
        <details className="card release-own" open={noEnvironment || own !== null} data-project-own-environments>
          <summary>
            <b>Environments of this project</b>{" "}
            <span className="sub">
              which profile each environment runs, and the project&apos;s own environments
              {ownEnvironments.length > 0 ? ` (${ownEnvironments.length})` : ""}
            </span>
          </summary>
          {/* Read again after every change on the tab: chart values saved on
              a step are in the same bindings, and a stale copy saved here
              would put the old ones back. */}
          <ProjectEnvironments
            key={round}
            token={token}
            projectId={projectId}
            profiles={KUBERNETES_PROFILES}
            title="Which profile each environment runs"
            show="bindings"
            onSaved={() => changed("Bindings saved.")}
          />
          <h3 className="release-own-head">The project&apos;s own environments</h3>
          <p className="hint">
            On a cluster the project holds, or one the organization opens to its projects (ADR-0054). The
            organization&apos;s own environments are under Organization › Infrastructure.
          </p>
          {ownEnvironments.length > 0 && (
            <ul className="rows" data-own-environments>
              {ownEnvironments.map((e) => (
                <li key={e.id} data-own-environment={e.name}>
                  <div className="grow">
                    <b>{e.name}</b>
                    {e.description && <span className="sub"> {e.description}</span>}
                    {e.promote_from && <div className="sub">takes from {envName(e.promote_from)}</div>}
                  </div>
                  <button type="button" onClick={() => setOwn(e)}>
                    Change
                  </button>
                  <button type="button" onClick={() => void removeOwn(e)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {own === null && (
            <div className="row">
              <button type="button" onClick={() => setOwn("new")} data-add-own-environment>
                + Add an environment of the project&apos;s own
              </button>
            </div>
          )}
          {own !== null && places === null && <p className="hint">Loading the project&apos;s connections…</p>}
          {own !== null && places !== null && (
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
        </details>
      )}
      </>
    );
  }
}

/** The ladder: the newest published build, then each environment in the
 *  order a release climbs them. */
function ReleaseLadder({
  token,
  projectId,
  steps,
  bindings,
  open,
  onOpen,
  onChanged,
}: {
  token: string;
  projectId: string;
  steps: LadderStep[];
  bindings: ProjectTargets["bindings"];
  open: string | null;
  onOpen: (environment: string) => void;
  onChanged: (message: string) => void;
}) {
  const newest = newestRelease(steps);
  return (
    <section className="card" data-release-ladder>
      <ol className="ladder">
        <li className="ladder-build" data-ladder-build>
          <div className="sub">newest build</div>
          {newest ? (
            <>
              <b>{newest.chartVersion ?? newest.buildId}</b>
              <div className="sub">
                {newest.where} · {relTime(newest.finishedAt ?? newest.startedAt ?? "")}
              </div>
            </>
          ) : (
            <span className="sub">nothing published yet</span>
          )}
        </li>
        {steps.map((s) => {
          const e = s.environment;
          const status = stepStatus(s);
          const profiles = profilesBoundTo(bindings, e.id);
          return (
            <li
              key={e.id}
              className={`ladder-step${open === e.id ? " on" : ""}`}
              data-ladder-step={e.name}
              data-ladder-state={s.state}
            >
              <div className="deploy-env-head">
                <b>{e.name}</b>
                {e.protected && <StatusChip tone="info">needs approval</StatusChip>}
                {e.project_id && (
                  <StatusChip tone="neutral" data-own-environment>
                    the project&apos;s own
                  </StatusChip>
                )}
              </div>
              <div>
                <StatusChip tone={s.state === "deploying" ? "running" : LADDER_TONE[status.tone]} data-ladder-status>
                  {status.text}
                </StatusChip>
              </div>
              <RungPlace token={token} projectId={projectId} step={s} onChanged={onChanged} />
              <div className="sub">
                {e.kind === "research" ? (
                  <>
                    application <code>{s.namespace}</code> in Research project <code>{e.research_project}</code>
                  </>
                ) : (
                  <>
                    namespace <code>{s.namespace}</code>
                  </>
                )}
                {s.from && <> · takes from {s.from}</>}
              </div>
              <div className="sub">
                {profiles.length ? `profile ${profiles.join(", ")}` : "no profile bound yet"}
                {s.latest && <> · {relTime(s.latest.requested_at)}</>}
              </div>
              {s.runs &&
                productUrls(s.runs.outcome).map((u) => (
                  <div key={u}>
                    <a href={u} target="_blank" rel="noreferrer" data-product-url>
                      Open the product ↗
                    </a>
                  </div>
                ))}
              <div className="row ladder-actions">
                {s.promote && (
                  <PromoteBuild token={token} projectId={projectId} step={s} build={s.promote} onChanged={onChanged} />
                )}
                <button
                  type="button"
                  className={s.promote ? "ghost" : "primary"}
                  aria-expanded={open === e.id}
                  title="Deploy a published build, roll back, uninstall, preview; the release's values and secrets"
                  onClick={() => onOpen(e.id)}
                  data-ladder-deploy
                >
                  Deploy…
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A ladder step's tone (releases.ts) as a StatusChip's. */
const LADDER_TONE: Record<ReturnType<typeof stepStatus>["tone"], Tone> = { ok: "ok", warn: "warn", bad: "danger", idle: "neutral" };

/** Promote: deploy here the build the environment before it runs. */
function PromoteBuild({
  token,
  projectId,
  step,
  build,
  onChanged,
}: {
  token: string;
  projectId: string;
  step: LadderStep;
  build: IdeBuild;
  onChanged: (message: string) => void;
}) {
  const { busy, error, ask } = useDeployRequest(token, projectId, onChanged);
  const version = build.chartVersion ?? build.buildId;
  const replaces = step.runs ? versionOf(step.runs) : null;
  return (
    <>
      <button
        type="button"
        className="primary"
        disabled={busy}
        title={`Deploy ${version}, which runs in ${step.from}, to ${step.environment.name}${replaces ? ` in place of ${replaces}` : ""}`}
        onClick={() =>
          void ask({ environment_id: step.environment.id, build: build.buildId }, `Promote ${version} to ${step.environment.name}`)
        }
        data-ladder-promote
      >
        Promote {version}
      </button>
      {error && <span className="error">{error}</span>}
    </>
  );
}

const RELEASES_CSS = `
.project-deploys .deploy-env { margin:0 0 12px; }
.project-deploys .deploy-env .card-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }
.project-deploys .deploy-env-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
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
.project-deploys .ladder { list-style:none; padding:0; margin:0; display:flex; flex-wrap:wrap; gap:10px 28px; align-items:stretch; }
.project-deploys .ladder > li { position:relative; flex:1 1 200px; min-width:0; display:flex; flex-direction:column; gap:4px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md, 8px); }
.project-deploys .ladder > li + li::before { content:"→"; position:absolute; left:-20px; top:50%; transform:translateY(-50%); color:var(--muted-foreground); }
.project-deploys .ladder > li.on { border-color:var(--primary); box-shadow:0 0 0 1px var(--primary) inset; }
.project-deploys .ladder-build { flex:0 1 140px; background:var(--accent); }
.project-deploys .ladder-actions { gap:6px; flex-wrap:wrap; margin-top:auto; padding-top:6px; }
.project-deploys .ladder > li.ladder-build { flex:0 1 160px; }
.project-deploys .release-own summary { cursor:pointer; }
.project-deploys .release-own[open] summary { margin-bottom:10px; }
.project-deploys .release-own-head { margin:16px 0 4px; }
`;
