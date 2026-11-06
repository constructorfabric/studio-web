/* A project's Releases tab (ADR-0056 §4): how its product goes out. It was
 * two tabs, Builds and Deploys, with nothing leading from one to the next.
 *
 *   - The header (ui-standard.tsx) says where the product stands, read from
 *     the ladder (releaseStatus); the explanation is behind its "?".
 *   - Then the steps, as tabs: Build (builds-tab.tsx), Deploy, Images
 *     (project-images.tsx) and History. It opens on the step that is next --
 *     Build until something is published, then Deploy -- unless the member
 *     picked another for the project before.
 *   - In Deploy, the ladder: the environments the project may deploy to in
 *     `promote_from` order (releases.ts), a row each with what runs there,
 *     how its newest deploy went, whether one waits for approval, and the
 *     action that applies -- Promote what the environment before it runs, or
 *     Deploy a published build. A row opens on its newest deploy's outcome;
 *     Deploy… opens under it the rest of what the Deploys tab had on an
 *     environment's row: roll back, uninstall, previews, the release's
 *     values and secrets.
 *   - Folded under it, Environments of this project: the bindings of
 *     the product's profiles and the project's own environments (ADR-0054).
 *     It is the only place a project adds one.
 *
 * A build is published in Studio, the IDE or CI; a deploy names it and the
 * server installs it with the environment's connection (ADR-0048). */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  ApiError,
  api,
  type Connection,
  type DeployEnvironment,
  type Deployment,
  type DeploymentStatus,
  type ProjectTargets,
  type TaskRun,
} from "./api";
import { ideBuildsOf, type IdeBuild } from "./builds";
import { ProjectBuilds } from "./builds-tab";
import { DataTable, When } from "./data-table";
import { EnvironmentActions, EnvironmentConfig, EnvironmentPreviews, RungPlace, useDeployRequest } from "./deploy-actions";
import { EnvironmentForm, ProjectEnvironments } from "./environments-screen";
import { clusterConnections, registryConnections, researchConnections } from "./environments";
import { errText, relTime } from "./format";
import { deployableBuilds, productUrls, profilesBoundTo } from "./project-deploys";
import { deploysHint, type PipelineTab } from "./pipeline";
import { personLabel, usePeople } from "./user-names";
import { PipelineLine } from "./pipeline-line";
import { ladderSteps, newestRelease, releaseStatus, stepStatus, versionOf, type LadderStep } from "./releases";
import { ProjectImages, SHOW_IMAGE_EVENT } from "./project-images";
import { ProductSources } from "./source-roles-view";
import { PageHeader, StatusChip, type Tone } from "./ui-standard";

/** The steps of a release, as Releases' tabs. */
type ReleaseTab = "build" | "deploy" | "images" | "history";
const TAB_LABEL: Record<ReleaseTab, string> = { build: "Build", deploy: "Deploy", images: "Images", history: "History" };

/** The tab this member last picked for the project; storage may be missing
 *  or refuse, which is only a convenience lost. */
const tabKey = (projectId: string) => `studio.releases.tab.${projectId}`;
function storedTab(projectId: string): ReleaseTab | null {
  try {
    const t = window.localStorage.getItem(tabKey(projectId));
    return t && t in TAB_LABEL ? (t as ReleaseTab) : null;
  } catch {
    return null;
  }
}
function storeTab(projectId: string, t: ReleaseTab) {
  try {
    window.localStorage.setItem(tabKey(projectId), t);
  } catch {
    // Not remembered; the tabs still work.
  }
}

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
  // The tab the member picked; none until they pick one, and the step that
  // is next shows.
  const [picked, setPicked] = useState<ReleaseTab | null>(() => storedTab(projectId));
  useEffect(() => setPicked(storedTab(projectId)), [projectId]);
  const pick = (t: ReleaseTab) => {
    setPicked(t);
    storeTab(projectId, t);
  };
  // An image asked for from elsewhere on Releases (a build's row) opens the
  // Images tab; the list there finds it.
  useEffect(() => {
    const show = () => setPicked("images");
    window.addEventListener(SHOW_IMAGE_EVENT, show);
    return () => window.removeEventListener(SHOW_IMAGE_EVENT, show);
  }, []);
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
  const ownEnvironments = targets?.environments.filter((t) => !!t.environment.project_id).map((t) => t.environment) ?? [];
  const noEnvironment = !!targets && targets.environments.length === 0;

  const published = deployableBuilds(builds).length;
  const status = targets ? releaseStatus(steps, published) : null;

  const tabs: ReleaseTab[] = unavailable ? ["build", "deploy"] : ["build", "deploy", "images", "history"];
  // What is next: build until something is published, then deploy it.
  const next: ReleaseTab | null = targets || unavailable || error ? (published === 0 ? "build" : "deploy") : null;
  const tab = picked && tabs.includes(picked) ? picked : next;

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
      <div className="doc-views" role="tablist" aria-label="How the product goes out" data-release-tabs>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`release-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="release-tab-panel"
            className={`doc-view${tab === t ? " on" : ""}`}
            onClick={() => pick(t)}
            data-release-tab={t}
            data-release-tab-next={t === next || undefined}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab && (
        <div role="tabpanel" id="release-tab-panel" aria-labelledby={`release-tab-${tab}`} data-step={tab}>
          <p className="hint" data-release-tab-status>
            {tabStatus(tab)}
          </p>
          {tab === "build" && (
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
          )}
          {tab === "deploy" && deployBody()}
          {tab === "images" && (
            <ProjectImages
              token={token}
              projectId={projectId}
              projectName={targets?.project_name ?? projectName ?? "project"}
              environments={targets?.environments.map((t) => t.environment) ?? []}
              round={round}
            />
          )}
          {tab === "history" && (
            <div data-deploy-history>
              <ProjectEnvironments
                key={round}
                token={token}
                projectId={projectId}
                title="Deploy history"
                show="history"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );

  /** Where a step stands, in a line under the tabs. */
  function tabStatus(t: ReleaseTab): string {
    if (t === "build")
      return published > 0
        ? `${published} published build${published === 1 ? "" : "s"}; the newest is ready to deploy.`
        : "Nothing published yet: build the product first.";
    if (t === "deploy")
      return noEnvironment
        ? "No environment to deploy to yet."
        : steps.some((s) => !!s.runs)
          ? "Running; a release climbs the environments in order."
          : published === 0
            ? "Once a build is published, deploy it to the first environment."
            : "Deploy the newest build to the first environment.";
    if (t === "images") return "What the builds pushed, where each runs, and how long they are kept.";
    return deployments.length ? `${deployments.length} deploy${deployments.length === 1 ? "" : "s"} so far.` : "Nothing deployed yet.";
  }

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
          organizationId={targets.organization_id}
          steps={steps}
          bindings={targets.bindings}
          open={open}
          onOpen={(id) => setOpen(open === id ? null : id)}
          onChanged={changed}
          panel={(s) => (
            <section className="deploy-env" data-release-step={s.environment.name}>
              <div className="card-head">
                <h3>{s.environment.name}</h3>
                <button type="button" className="ghost" onClick={() => setOpen(null)}>
                  Close
                </button>
              </div>
              <EnvironmentActions
                token={token}
                projectId={projectId}
                env={s.environment}
                latest={s.latest ?? undefined}
                deployments={deployments}
                builds={builds}
                envName={envName}
                organizationId={targets.organization_id}
                onChanged={changed}
              />
              <EnvironmentPreviews
                token={token}
                projectId={projectId}
                env={s.environment}
                deployments={deployments}
                onChanged={changed}
              />
              <EnvironmentConfig
                key={`${s.environment.id}-${round}`}
                token={token}
                projectId={projectId}
                env={s.environment}
                bindings={targets.bindings}
                secrets={targets.secrets ?? []}
                onChanged={changed}
              />
            </section>
          )}
        />
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

/** Where a deploy that is under way is: waiting for a runner, the phase its
 *  run reported, and how many of the release's pods are ready. Read again
 *  every few seconds; the tab reads again once the deploy ends. */
function DeployProgress({
  token,
  organizationId,
  deployment,
  onEnded,
}: {
  token: string;
  organizationId: string;
  deployment: Deployment;
  onEnded: (message: string) => void;
}) {
  const [run, setRun] = useState<TaskRun | null>(null);
  const [rollout, setRollout] = useState<DeploymentStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const look = async () => {
      setNow(Date.now());
      const [r, st] = await Promise.all([
        deployment.run_id ? api.taskRun(token, deployment.run_id, organizationId).catch(() => null) : null,
        api.deploymentStatus(token, organizationId, deployment.id).catch(() => null),
      ]);
      if (!live) return;
      setRun(r);
      setRollout(st);
      const ended = st?.deployment.state ?? (r && ["succeeded", "failed", "cancelled"].includes(r.state) ? r.state : null);
      if (ended && ended !== "queued" && ended !== "running") {
        live = false;
        onEnded(`The deploy of ${versionOf(deployment) ?? deployment.product} to ${deployment.environment_name} ended: ${ended}.`);
      }
    };
    void look();
    const t = window.setInterval(() => void look(), 4000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [token, organizationId, deployment, onEnded]);
  const workloads = rollout?.workloads ?? [];
  const desired = workloads.reduce((n, w) => n + Math.max(w.desired, 0), 0);
  const ready = workloads.reduce((n, w) => n + Math.max(Math.min(w.ready, w.desired), 0), 0);
  const since = run?.started_at ?? deployment.decided_at ?? deployment.requested_at;
  const seconds = since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : null;
  const phase = !run || run.state === "queued" ? "waiting for a runner" : (run.progress ?? "starting");
  return (
    <div className="deploy-progress" data-deploy-progress>
      {desired > 0 ? (
        <progress max={desired} value={ready} aria-label="Pods ready" />
      ) : (
        <progress aria-label="Deploy under way" />
      )}
      <div className="sub">
        {phase}
        {desired > 0 && (
          <>
            {" "}
            · {ready} of {desired} pods ready
          </>
        )}
        {seconds !== null && <> · {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</>}
      </div>
      {(rollout?.problems ?? []).slice(0, 3).map((p) => (
        <div key={p} className="sub warn">
          {p}
        </div>
      ))}
    </div>
  );
}

/** The ladder: the newest published build, then a row per environment in
 *  the order a release climbs them. A row opens on its newest deploy -- how
 *  it went, in the deploy's own words -- and Deploy… opens `panel` under it. */
function ReleaseLadder({
  token,
  projectId,
  organizationId,
  steps,
  bindings,
  open,
  onOpen,
  onChanged,
  panel,
}: {
  token: string;
  projectId: string;
  organizationId: string;
  steps: LadderStep[];
  bindings: ProjectTargets["bindings"];
  open: string | null;
  onOpen: (environment: string) => void;
  onChanged: (message: string) => void;
  /** What Deploy… opens under an environment's row. */
  panel: (step: LadderStep) => ReactNode;
}) {
  const newest = newestRelease(steps);
  return (
    <section className="card" data-release-ladder>
      <div className="sub" data-ladder-build>
        newest build:{" "}
        {newest ? (
          <>
            <b>{newest.chartVersion ?? newest.buildId}</b> · {newest.where} ·{" "}
            {relTime(newest.finishedAt ?? newest.startedAt ?? "")}
          </>
        ) : (
          "nothing published yet"
        )}
      </div>
      <DataTable<LadderStep>
        list="release-ladder"
        urlPrefix="ladder."
        rows={steps}
        rowKey={(s) => s.environment.id}
        rowLabel={(s) => s.environment.name}
        expand={(s) => (
          <StepDetail step={s} token={token} projectId={projectId} organizationId={organizationId} bindings={bindings} onChanged={onChanged} />
        )}
        expandOnClick
        detail={(s) => (s.environment.id === open ? panel(s) : null)}
        empty={{ title: "No environment to deploy to yet." }}
        columns={[
          {
            id: "environment",
            header: "Environment",
            cell: (s) => (
              <span className="deploy-env-head" data-ladder-step={s.environment.name} data-ladder-state={s.state}>
                <b>{s.environment.name}</b>
                {s.environment.protected && <StatusChip tone="info">needs approval</StatusChip>}
                {s.environment.project_id && (
                  <StatusChip tone="neutral" data-own-environment>
                    the project&apos;s own
                  </StatusChip>
                )}
              </span>
            ),
          },
          {
            id: "status",
            header: "Status",
            cell: (s) => {
              const status = stepStatus(s);
              return (
                <>
                  <StatusChip tone={s.state === "deploying" ? "running" : LADDER_TONE[status.tone]} data-ladder-status>
                    {status.text}
                  </StatusChip>
                  {s.state === "deploying" && s.latest && (
                    <DeployProgress token={token} organizationId={organizationId} deployment={s.latest} onEnded={onChanged} />
                  )}
                </>
              );
            },
          },
          {
            id: "runs",
            header: "Runs",
            cell: (s) =>
              s.runs ? (
                <>
                  <code>{versionOf(s.runs) ?? s.runs.product}</code>
                  {productUrls(s.runs.outcome).map((u) => (
                    <div key={u}>
                      <a href={u} target="_blank" rel="noreferrer" data-product-url>
                        Open the product ↗
                      </a>
                    </div>
                  ))}
                </>
              ) : (
                <span className="sub">nothing</span>
              ),
          },
          { id: "from", header: "Takes from", cell: (s) => s.from ?? <span className="sub">a build</span> },
          { id: "when", header: "Last deploy", cell: (s) => <When iso={s.latest?.requested_at} /> },
        ]}
        inline={(s) => (
          <span className="row ladder-actions">
            {s.promote && <PromoteBuild token={token} projectId={projectId} step={s} build={s.promote} onChanged={onChanged} />}
            <button
              type="button"
              className={s.promote ? "ghost" : "primary"}
              aria-expanded={open === s.environment.id}
              title="Deploy a published build, roll back, uninstall, preview; the release's values and secrets"
              onClick={() => onOpen(s.environment.id)}
              data-ladder-deploy
            >
              Deploy…
            </button>
          </span>
        )}
      />
    </section>
  );
}

/** An environment's row, opened: where it is, which profile it runs, and its
 *  newest deploy as that deploy tells it -- the reason it was asked for and
 *  its outcome, a crashed container's error first. */
function StepDetail({
  step: s,
  token,
  projectId,
  organizationId,
  bindings,
  onChanged,
}: {
  step: LadderStep;
  token: string;
  projectId: string;
  organizationId: string;
  bindings: ProjectTargets["bindings"];
  onChanged: (message: string) => void;
}) {
  const e = s.environment;
  const profiles = profilesBoundTo(bindings, e.id);
  const people = usePeople(token, [organizationId, projectId]);
  return (
    <div className="ladder-detail" data-ladder-detail={e.name}>
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
        {" · "}
        {profiles.length ? `profile ${profiles.join(", ")}` : "no profile bound yet"}
      </div>
      {s.latest ? (
        <div data-ladder-latest={s.latest.state}>
          <div className="sub">
            newest deploy: <b>{versionOf(s.latest) ?? s.latest.product}</b> · {s.latest.state} ·{" "}
            {personLabel(s.latest.requested_by, s.latest.requested_by_name, people)} · {relTime(s.latest.requested_at)}
          </div>
          {s.latest.reason && <div className="sub">“{s.latest.reason}”</div>}
          {s.latest.outcome && <pre className="ladder-outcome">{s.latest.outcome}</pre>}
        </div>
      ) : (
        <div className="sub">Nothing deployed here yet.</div>
      )}
    </div>
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
.deploy-progress { display: grid; gap: 2px; margin: 4px 0; }
.deploy-progress progress { width: 100%; height: 6px; accent-color: var(--primary); }
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
.project-deploys .ladder-actions { gap:6px; flex-wrap:nowrap; justify-content:flex-end; }
.project-deploys [data-ladder-build] { margin:0 0 8px; }
.project-deploys .ladder-detail { display:grid; gap:4px; }
.project-deploys .ladder-outcome { margin:4px 0 0; max-height:320px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
.project-deploys .release-own summary { cursor:pointer; }
.project-deploys .release-own[open] summary { margin-bottom:10px; }
.project-deploys .release-own-head { margin:16px 0 4px; }
`;
