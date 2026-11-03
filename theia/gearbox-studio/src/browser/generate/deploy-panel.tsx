// Constructor Studio: Deploy, under Generate's Apply, for a kubernetes
// profile -- in place of Build and Run, which start a process on this
// machine. Drawn from plain props, like the Run panel; the rules are in
// `common/deploy-product.ts`.
//
// Two kinds of target, in one list. The organization's environments come
// first (ADR-0043): Deploy there asks the Studio server, which installs the
// chart with the environment's connection, so no cluster credential is
// needed here. Below them, the kube contexts of this machine -- a member's
// own cluster -- where every step is a command typed into the Deploy terminal
// and the one that reaches the cluster asks first.

import React from "@theia/core/shared/react";

import {
  logHeading,
  BUILD_STAGES,
  buildStages,
  deploymentStateLabel,
  firstLineOf,
  isDeployable,
  parseTarget,
  targetValue,
  validSecretKey,
  type BuildWorkflow,
  type ContainerLog,
  type DeployImage,
  type DeploymentStatus,
  type DeployTarget,
  type NextStep,
  type ProductBuild,
  type ProductDeployment,
  type StudioEnvironment,
} from "../../common/deploy-product";

/**
 * Constructor Studio: the project's builds and deploys as the Studio server
 * records them -- the portal's Builds and Deploys tabs, beside the buttons that
 * make them. Absent where the IDE cannot ask Studio.
 */
export interface DeployFlow {
  readonly next: NextStep;
  /** Newest first. */
  readonly builds: readonly ProductBuild[];
  /** Newest first. */
  readonly deployments: readonly ProductDeployment[];
  /** Why the server could not be asked, when it could not. */
  readonly error?: string;
  /** The open profile, when it is bound to no environment: Bind offers one. */
  readonly unbound?: string;
  readonly binding?: boolean;
}

/** How many of each the panel lists; the portal's tabs hold the rest. */
const SHOWN = 5;

export interface DeployPanelProps {
  /** Whether the generated tree is on disk (applied, or nothing left to write). */
  readonly generated: boolean;
  /** `undefined` while the backend is being asked. */
  readonly ready: boolean | undefined;
  readonly images: readonly DeployImage[];
  readonly chart: string | undefined;
  /** The registry and namespace of the chosen target: the environment's, or the profile's. */
  readonly registry: string | undefined;
  readonly namespace: string | undefined;
  readonly docker: boolean;
  readonly helm: string | undefined;
  /** The organization's environments the project may deploy to. */
  readonly environments: readonly StudioEnvironment[];
  readonly contexts: readonly string[];
  readonly target: DeployTarget | undefined;
  readonly onTarget: (target: DeployTarget) => void;
  /** A deploy request is on its way to the server. */
  readonly requesting?: boolean;
  /** Publish is asking the server for a push token (ADR-0048). */
  readonly publishing?: boolean;
  /** A build was published to the chosen environment: Deploy names it. */
  readonly published?: boolean;
  /** Studio is asked to build in the chosen environment's cluster (ADR-0048 §9). */
  readonly startingBuild?: boolean;
  /** A build Studio runs for the chosen environment: Deploy names it. */
  readonly studioBuild?: boolean;
  /** Build in Studio; absent where the IDE cannot ask Studio. */
  readonly onBuildInStudio?: () => void;
  /** What the server said about the last deploy asked of it. */
  readonly note?: string;
  readonly onBuildImages: () => void;
  readonly onPush: () => void;
  readonly onTemplate: () => void;
  readonly onDeploy: () => void;
  readonly flow?: DeployFlow;
  /** Deploy a build the server recorded, by its id, into the chosen environment. */
  readonly onDeployBuild?: (buildId: string) => void;
  readonly onBind?: (environmentId: string) => void;
  /** A deploy's live status, by deployment id, once asked for. */
  readonly statuses?: Readonly<Record<string, DeployStatusView>>;
  /** Read a deploy's live status from its cluster; absent where Studio cannot be asked. */
  readonly onStatus?: (deploymentId: string) => void;
  /** Open a release's host, or a pull request, in the browser. */
  readonly onOpen?: (url: string) => void;
  /** The CI build workflow proposed for the chosen environment, once proposed. */
  readonly workflow?: BuildWorkflow;
  readonly proposingWorkflow?: boolean;
  /** Propose the CI build workflow to the project's repository; absent where Studio cannot. */
  readonly onProposeWorkflow?: () => void;
  /** The chosen environment's configuration secret keys; the values never come back. */
  readonly secrets?: readonly string[];
  readonly savingSecret?: boolean;
  /** Set (`value`) or remove (`undefined`) a configuration secret in the chosen environment. */
  readonly onSecret?: (key: string, value: string | undefined) => void;
  /** Open the Generate stage, where Apply writes the tree a build on this machine needs. */
  readonly onShowGenerate?: () => void;
  /** A deploy's container logs, by deployment id, once asked for. */
  readonly logs?: Readonly<Record<string, DeployLogsView>>;
  /** Read (or hide) a deploy's container logs; absent where Studio cannot be asked. */
  readonly onLogs?: (deploymentId: string) => void;
}

/** A deploy's container logs as the panel holds them: asked, answered, or refused. */
export type DeployLogsView =
  | { readonly kind: "loading" }
  | { readonly kind: "logs"; readonly logs: readonly ContainerLog[] }
  | { readonly kind: "error"; readonly error: string };

/** A deploy's live status as the panel holds it: asked, answered, or refused. */
export type DeployStatusView =
  | { readonly kind: "loading" }
  | { readonly kind: "status"; readonly status: DeploymentStatus }
  | { readonly kind: "error"; readonly error: string };

export function DeployPanel(props: DeployPanelProps): React.ReactElement {
  const { images, target, flow } = props;
  const environment = target?.kind === "environment" ? props.environments.find((e) => e.id === target.id) : undefined;
  const nothing = props.environments.length === 0 && props.contexts.length === 0;
  // What this machine can do: build, push, render and install from the
  // generated tree. Studio's own build needs none of it -- it builds from the
  // repository -- so it is offered whether or not the tree is on disk.
  const local: "not-generated" | "checking" | "no-plan" | "ready" = !props.generated
    ? "not-generated"
    : props.ready === undefined
      ? "checking"
      : images.length === 0 || props.chart === undefined
        ? "no-plan"
        : "ready";
  const studioBuild = environment?.registryLogin === true && props.onBuildInStudio !== undefined;
  const buildHere = local === "ready" && props.docker;
  // The server packs nothing and needs no helm here; a kube context does.
  const canDeploy = environment !== undefined ? props.requesting !== true : target?.kind === "context" && props.helm !== undefined && local === "ready";
  const builds = flow?.builds ?? [];
  const latestBuild = builds[0];
  // What was just published or built here comes first: the server's history
  // does not have it yet, and its newest deployable build is an older one.
  const deployable = environment !== undefined && props.published !== true && props.studioBuild !== true ? builds.find((b) => isDeployable(b)) : undefined;
  const deploys = groupDeployments(flow?.deployments ?? []);
  const latestDeploy = deploys.find((d) => environment === undefined || d.deployment.environmentId === environment.id) ?? deploys[0];
  const where = environment?.name ?? (target?.kind === "context" ? target.name : "the cluster");
  return (
    <div className="gbx-generate-run gbx-ship" data-generate-deploy data-deploy-flow={flow !== undefined ? true : undefined}>
      <div className="gbx-generate-actions gbx-ship-target">
        <label>
          Deploy to{" "}
          <select
            data-deploy-target
            value={target !== undefined ? targetValue(target) : ""}
            onChange={(e) => {
              const next = parseTarget(e.target.value);
              if (next !== undefined) props.onTarget(next);
            }}
            disabled={nothing}
          >
            {nothing && <option value="">no environment and no kube context</option>}
            {props.environments.length > 0 && (
              <optgroup label="The organization's environments">
                {props.environments.map((e) => (
                  <option key={e.id} value={targetValue({ kind: "environment", id: e.id })}>
                    {e.name}
                    {e.protected ? " (needs approval)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
            {props.contexts.length > 0 && (
              <optgroup label="Kube contexts on this machine">
                {props.contexts.map((c) => (
                  <option key={c} value={targetValue({ kind: "context", name: c })}>
                    {c}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {environment !== undefined && (
          <span className="gbx-waiting" data-deploy-environment={environment.name}>
            {environment.registry ? `images and chart in ${environment.registry}` : "images as generated"}
            {environment.protected ? " · an organization administrator approves it first" : ""}
          </span>
        )}
      </div>
      {flow !== undefined &&
        (flow.error !== undefined ? (
          <p className="gbx-inline-error" data-deploy-flow-error>
            Studio could not be asked for the project&apos;s builds and deploys: {flow.error}
          </p>
        ) : (
          <p className={`gbx-ship-next gbx-ship-next-${flow.next.tone}`} data-deploy-next={flow.next.tone} role="status">
            {flow.next.text}
          </p>
        ))}
      {flow?.unbound !== undefined && <BindRow {...props} unbound={flow.unbound} binding={flow.binding} />}

      <section className="gbx-ship-step" data-ship-step="build" aria-label="Build">
        <div className="gbx-ship-step-head">
          <span className="gbx-ship-step-num">1</span>
          <b>Build</b>
          <span className="gbx-waiting">the images and the chart{environment?.registry ? `, published to ${environment.registry}` : ""}</span>
        </div>
        {latestBuild !== undefined ? (
          <BuildRow build={latestBuild} {...props} environment={environment} latest />
        ) : (
          flow !== undefined && <p className="gbx-waiting">No build of this product yet.</p>
        )}
        <div className="gbx-generate-actions" data-deploy-state={local}>
          {/* This computer first when it can build -- the IDE is where the
              code is -- and Studio's cluster second; Studio's cluster first
              when this machine cannot (no tree yet, or no docker). */}
          {buildHere && (
            <button
              type="button"
              className="gbx-start-primary"
              data-deploy-build
              onClick={props.onBuildImages}
              title="docker build of each image, here, from the code on this computer"
            >
              Build on this computer
            </button>
          )}
          {studioBuild && environment !== undefined && (
            <button
              type="button"
              className={buildHere ? "gbx-choice" : "gbx-start-primary"}
              data-deploy-studio-build
              disabled={props.startingBuild === true}
              onClick={props.onBuildInStudio}
              title={`Studio builds what is pushed to the branch, in ${environment.name}'s cluster, and publishes to ${environment.registry}: nothing is built on this computer`}
            >
              {props.startingBuild === true ? "Starting…" : "Build in the Studio cluster"}
            </button>
          )}
          {local === "ready" && !buildHere && (
            <button type="button" className="gbx-choice" data-deploy-build disabled title="docker does not answer on this computer">
              Build on this computer
            </button>
          )}
          {local === "ready" && (
            <button
              type="button"
              className="gbx-choice"
              data-deploy-push
              disabled={!props.docker || !props.registry || props.publishing === true}
              onClick={props.onPush}
              title={
                environment?.registryLogin === true
                  ? `Push the images built on this computer, and the chart, to ${props.registry} with a token the Studio server gets for them`
                  : props.registry
                    ? `docker push to ${props.registry}`
                    : "No image registry: set one on the environment or the profile to push"
              }
            >
              {props.publishing === true
                ? "Publishing…"
                : environment?.registryLogin === true
                  ? `Publish to ${props.registry}`
                  : "Push"}
            </button>
          )}
          {local === "not-generated" && (
            <span className="gbx-waiting" data-deploy-state="not-generated">
              {studioBuild ? "To build on this machine instead, " : "To build on this machine, "}
              {props.onShowGenerate !== undefined ? (
                <button type="button" className="gbx-link" onClick={props.onShowGenerate}>
                  Apply the code in Generate
                </button>
              ) : (
                "Apply the code in Generate"
              )}{" "}
              first: it writes the images&apos; Dockerfiles and the chart.
            </span>
          )}
          {local === "checking" && (
            <span className="gbx-waiting" data-deploy-state="checking">
              Checking for docker, helm and kubectl…
            </span>
          )}
          {local === "no-plan" && (
            <span className="gbx-inline-error" data-deploy-state="no-plan">
              The generated tree has no docker/build.sh or Helm chart to deploy: generate this kubernetes profile again.
            </span>
          )}
        </div>
        {local === "ready" && (
          <p className="gbx-waiting" data-deploy-images>
            Images: {images.map((image) => <code key={image.app}>{image.image}</code>).reduce<React.ReactNode[]>((all, one, i) => (i === 0 ? [one] : [...all, ", ", one]), [])}
            {props.registry ? (
              <>
                {" "}
                pushed to <code>{props.registry}</code>
              </>
            ) : (
              <> -- no image registry, so they stay in this machine&apos;s Docker, which only a cluster sharing it can pull from</>
            )}
            . Chart <code>{props.chart}</code>
            {props.namespace ? (
              <>
                {" "}
                into namespace <code>{props.namespace}</code>
              </>
            ) : null}
            .
          </p>
        )}
        {local === "ready" && !props.docker && (
          <p className="gbx-inline-error" data-deploy-missing="docker">
            docker does not answer on this machine: the images cannot be built here.
          </p>
        )}
      </section>

      <section className="gbx-ship-step" data-ship-step="deploy" aria-label="Deploy">
        <div className="gbx-ship-step-head">
          <span className="gbx-ship-step-num">2</span>
          <b>Deploy to {where}</b>
          {props.namespace ? <span className="gbx-waiting">namespace {props.namespace}</span> : null}
        </div>
        {latestDeploy !== undefined && <DeployRow {...props} row={latestDeploy} />}
        <div className="gbx-generate-actions">
          {deployable !== undefined && environment !== undefined && props.onDeployBuild !== undefined ? (
            <button
              type="button"
              className="gbx-start-primary"
              data-deploy-this-build={deployable.buildId}
              disabled={props.requesting === true}
              aria-label={`Deploy build ${deployable.buildId} to ${environment.name}`}
              onClick={() => props.onDeployBuild?.(deployable.buildId)}
            >
              {props.requesting === true ? "Asking the server…" : `Deploy ${deployable.chartVersion ?? deployable.buildId}`}
            </button>
          ) : (
            (environment !== undefined || local === "ready") && (
              <button
                type="button"
                className="gbx-start-primary"
                data-deploy-install
                disabled={!canDeploy}
                onClick={props.onDeploy}
                title={environment !== undefined ? "Ask the Studio server to deploy; asks first" : "helm upgrade --install into the chosen cluster; asks first"}
              >
                {props.requesting === true
                  ? "Asking the server…"
                  : props.studioBuild === true
                    ? "Deploy Studio's build"
                    : props.published === true
                      ? "Deploy the published build"
                      : "Deploy"}
              </button>
            )
          )}
          {local === "ready" && (
            <button type="button" className="gbx-choice" data-deploy-template disabled={props.helm === undefined} onClick={props.onTemplate}>
              Preview manifests
            </button>
          )}
          {deployable === undefined && environment !== undefined && flow !== undefined && props.published !== true && props.studioBuild !== true && (
            <span className="gbx-waiting">Nothing published to deploy yet: build first.</span>
          )}
        </div>
        {local === "ready" && props.helm === undefined && environment === undefined && (
          <p className="gbx-inline-error" data-deploy-missing="helm">
            helm is not on this machine: install Helm to preview the manifests and deploy to a kube context.{" "}
            <a href="https://helm.sh/docs/intro/install/" target="_blank" rel="noreferrer">
              helm.sh
            </a>
          </p>
        )}
        {props.note !== undefined && (
          <p className="gbx-waiting" data-deploy-note>
            {props.note}
          </p>
        )}
      </section>

      {flow !== undefined && (builds.length > 1 || deploys.length > 1) && (
        <details className="gbx-ship-history">
          <summary>
            History: {builds.length} build{builds.length === 1 ? "" : "s"}, {flow.deployments.length} deploy
            {flow.deployments.length === 1 ? "" : "s"}
          </summary>
          <FlowSection {...props} flow={flow} environment={environment} />
        </details>
      )}
      {environment !== undefined && <EnvironmentExtras {...props} environment={environment} />}
    </div>
  );
}

/** Bind the open profile to an environment, when it is bound to none. */
function BindRow(props: DeployPanelProps & { readonly unbound: string; readonly binding?: boolean }): React.ReactElement | null {
  const [bindTo, setBindTo] = React.useState("");
  if (props.environments.length === 0 || props.onBind === undefined) return null;
  return (
    <div className="gbx-generate-actions" data-deploy-bind={props.unbound}>
      <label>
        Bind {props.unbound} to{" "}
        <select aria-label={`Environment for the ${props.unbound} profile`} value={bindTo} onChange={(e) => setBindTo(e.target.value)}>
          <option value="">choose an environment</option>
          {props.environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="gbx-choice"
        data-deploy-bind-apply
        disabled={bindTo === "" || props.binding === true}
        onClick={() => props.onBind?.(bindTo)}
      >
        {props.binding === true ? "Binding…" : "Bind"}
      </button>
    </div>
  );
}

/** One build: id, how far it got, what it published or why it failed, and Deploy. */
function BuildRow(
  props: DeployPanelProps & { readonly build: ProductBuild; readonly environment: StudioEnvironment | undefined; readonly latest?: boolean },
): React.ReactElement {
  const { build, environment } = props;
  const stages = buildStages(build);
  const canDeploy = !props.latest && isDeployable(build) && environment !== undefined && props.onDeployBuild !== undefined;
  return (
    <div className="gbx-ship-build" data-deploy-build-id={build.buildId} data-deploy-build-status={build.status}>
      <div>
        <code>{build.buildId}</code> · {build.status} · {build.where}
        {build.shortSha !== undefined ? ` · ${build.shortSha}` : ""}
        {build.descriptionRevision !== undefined ? ` · description rev ${build.descriptionRevision}` : ""}
        {build.branch !== undefined ? ` on ${build.branch}` : ""}
        <span className="gbx-deploy-stages" aria-label="Stages">
          {BUILD_STAGES.map((stage) => (
            <span
              key={stage}
              className={`gbx-deploy-stage gbx-deploy-stage-${stages[stage]}`}
              data-deploy-stage={stage}
              data-deploy-stage-state={stages[stage]}
              title={`${stage}: ${stages[stage]}`}
            >
              {stage} · {stages[stage]}
            </span>
          ))}
        </span>
      </div>
      {build.status === "failed" && build.failure !== undefined && (
        <p className="gbx-inline-error" data-deploy-build-failure title={build.failure}>
          {failureLine(build.failure)}
        </p>
      )}
      {(build.chartRef !== undefined || build.images.length > 0) && (
        <p className="gbx-waiting" data-deploy-build-published>
          Published:{" "}
          {build.images
            .map((i) => (
              <code key={i.app} title={i.app}>
                {i.image}
              </code>
            ))
            .reduce<React.ReactNode[]>((all, one, i) => (i === 0 ? [one] : [...all, ", ", one]), [])}
          {build.chartRef !== undefined && (
            <>
              {build.images.length > 0 ? "; chart " : "chart "}
              <code>
                {build.chartRef}
                {build.chartVersion !== undefined ? `:${build.chartVersion}` : ""}
              </code>
            </>
          )}
        </p>
      )}
      {canDeploy && environment !== undefined && (
        <button
          type="button"
          className="gbx-choice"
          data-deploy-this-build={build.buildId}
          disabled={props.requesting === true}
          aria-label={`Deploy build ${build.buildId} to ${environment.name}`}
          onClick={() => props.onDeployBuild?.(build.buildId)}
        >
          Deploy this build to {environment.name}
        </button>
      )}
    </div>
  );
}

/** One deploy (or a run of the same one): how it ended and why, and its live status once asked. */
function DeployRow(props: DeployPanelProps & { readonly row: { readonly deployment: ProductDeployment; readonly times: number } }): React.ReactElement {
  const { deployment: d, times } = props.row;
  const why = d.reason ?? (d.state === "failed" ? d.outcome : undefined);
  return (
    <div className="gbx-ship-deploy" data-deploy-history={d.id} data-deploy-history-state={d.state} data-deploy-history-times={times}>
      {deploymentStateLabel(d.state)}
      {times > 1 ? <span className="gbx-deploy-times"> ×{times}</span> : null} · {d.environmentName} ({d.namespace})
      {d.action === "uninstall" ? " · uninstall" : d.chartVersion !== undefined ? ` · ${d.chartVersion}` : ""}
      {d.build !== undefined ? ` · build ${d.build}` : ""}
      {d.requestedBy !== undefined ? ` · ${d.requestedBy}` : ""}
      {why !== undefined && (
        <span className={d.state === "failed" ? "gbx-inline-error" : undefined} title={why}>
          {" "}
          -- {failureLine(why)}
        </span>
      )}
      {props.onStatus !== undefined && d.action !== "uninstall" && (d.state === "succeeded" || d.state === "failed") && (
        <>
          {" "}
          <button
            type="button"
            className="gbx-choice"
            data-deploy-status={d.id}
            disabled={props.statuses?.[d.id]?.kind === "loading"}
            aria-label={`Live status of the deploy to ${d.environmentName}`}
            onClick={() => props.onStatus?.(d.id)}
          >
            {props.statuses?.[d.id]?.kind === "loading" ? "Reading…" : "Status"}
          </button>
        </>
      )}
      {props.onLogs !== undefined && d.action !== "uninstall" && (d.state === "succeeded" || d.state === "failed" || d.state === "running") && (
        <>
          {" "}
          <button
            type="button"
            className="gbx-choice"
            data-deploy-logs={d.id}
            disabled={props.logs?.[d.id]?.kind === "loading"}
            aria-label={`Logs of the deploy to ${d.environmentName}`}
            onClick={() => props.onLogs?.(d.id)}
          >
            {props.logs?.[d.id]?.kind === "loading" ? "Reading…" : props.logs?.[d.id]?.kind === "logs" ? "Hide logs" : "Logs"}
          </button>
        </>
      )}
      {renderStatus(props.statuses?.[d.id], props.onOpen)}
      {renderLogs(props.logs?.[d.id])}
    </div>
  );
}

/** The project's builds and deploys, newest first, under History. */
function FlowSection(props: DeployPanelProps & { readonly flow: DeployFlow; readonly environment: StudioEnvironment | undefined }): React.ReactElement {
  const { flow, environment } = props;
  return (
    <section className="gbx-deploy-flow" aria-label="Builds and deploys">
      {flow.builds.length > 0 && (
        <ul className="gbx-deploy-builds" aria-label="Builds">
          {flow.builds.slice(0, SHOWN).map((build) => (
            <li key={build.buildId}>
              <BuildRow {...props} build={build} environment={environment} />
            </li>
          ))}
        </ul>
      )}
      {flow.deployments.length > 0 && (
        <ul className="gbx-deploy-history" aria-label="Deploys">
          {groupDeployments(flow.deployments)
            .slice(0, SHOWN)
            .map((row) => (
              <li key={row.deployment.id}>
                <DeployRow {...props} row={row} />
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

/** The end of each container's log, one block each, scrolled to its end. */
function renderLogs(view: DeployLogsView | undefined): React.ReactNode {
  if (view === undefined || view.kind === "loading") return null;
  if (view.kind === "error") {
    return (
      <p className="gbx-inline-error" data-deploy-logs-error>
        The logs could not be read: {view.error}
      </p>
    );
  }
  if (view.logs.length === 0) {
    return (
      <p className="gbx-waiting" data-deploy-logs-view>
        No pods of this release run in the namespace.
      </p>
    );
  }
  return (
    <div className="gbx-deploy-logs" data-deploy-logs-view>
      {view.logs.map((log) => (
        <details key={`${log.pod}/${log.container}/${log.previous ? "previous" : "now"}`} open={view.logs.length === 1 || log.previous} data-deploy-log={`${log.pod}/${log.container}`}>
          <summary>{logHeading(log)}</summary>
          <pre ref={(node) => node?.scrollTo?.(0, node.scrollHeight)}>{log.text.trim() === "" ? "(empty)" : log.text}</pre>
        </details>
      ))}
    </div>
  );
}

/** What the cluster says of a release now: each workload's pods ready of desired, and where it answers. */
function renderStatus(view: DeployStatusView | undefined, open: ((url: string) => void) | undefined): React.ReactNode {
  if (view === undefined || view.kind === "loading") return null;
  if (view.kind === "error") {
    return (
      <p className="gbx-inline-error" data-deploy-status-error>
        The cluster could not be read: {view.error}
      </p>
    );
  }
  const { workloads, hosts } = view.status;
  const problems = view.status.problems ?? [];
  return (
    <div className="gbx-deploy-status" data-deploy-status-view>
      {problems.length > 0 && (
        <ul className="gbx-inline-error" aria-label="Why it does not start" data-deploy-problems>
          {problems.map((p) => (
            <li key={p} data-deploy-problem>
              {p}
            </li>
          ))}
        </ul>
      )}
      {workloads.length === 0 ? (
        <p className="gbx-waiting">No workloads of this release run in the namespace.</p>
      ) : (
        <ul aria-label="Workloads">
          {workloads.map((w) => (
            <li key={w.name} data-deploy-workload={w.name} data-deploy-workload-ready={w.ready === w.desired ? "true" : "false"}>
              <code>{w.name}</code> · {w.ready}/{w.desired} ready
              {w.images.length > 0 && <> · {w.images.map((i) => <code key={i}>{i}</code>)}</>}
            </li>
          ))}
        </ul>
      )}
      {hosts.length > 0 && (
        <p data-deploy-hosts>
          Answers on:{" "}
          {hosts.map((host) => (
            <button key={host} type="button" className="gbx-link" data-deploy-host={host} onClick={() => open?.(`https://${host}`)}>
              {host}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * What else a project keeps per environment: the CI workflow that builds and
 * publishes into its registry, and the secrets its release reads. Shown for
 * the environment chosen above.
 */
function EnvironmentExtras(props: DeployPanelProps & { readonly environment: StudioEnvironment }): React.ReactElement | null {
  const { environment } = props;
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  if (props.onProposeWorkflow === undefined && props.onSecret === undefined) return null;
  const keyOk = validSecretKey(key);
  const prUrl = props.workflow?.prUrl;
  const secrets = (props.secrets ?? []).length;
  return (
    <details className="gbx-deploy-extras" data-deploy-extras={environment.id}>
      <summary>
        More for {environment.name}: build in CI, secrets{secrets > 0 ? ` (${secrets})` : ""}
      </summary>
      {props.onProposeWorkflow !== undefined && (
        <div className="gbx-generate-actions" data-deploy-workflow>
          <button
            type="button"
            className="gbx-choice"
            data-deploy-propose-workflow
            disabled={props.proposingWorkflow === true}
            title={`A GitHub workflow in the project's repository that builds the product and publishes it to ${environment.registry || environment.name}`}
            onClick={() => props.onProposeWorkflow?.()}
          >
            {props.proposingWorkflow === true ? "Proposing…" : "Build in CI…"}
          </button>
          {props.workflow !== undefined && (
            <span data-deploy-workflow-proposed>
              Proposed <code>{props.workflow.path}</code> on <code>{props.workflow.branch}</code>
              {prUrl !== undefined && (
                <>
                  {" "}
                  <button type="button" className="gbx-link" onClick={() => props.onOpen?.(prUrl)}>
                    open the pull request
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      )}
      {props.onSecret !== undefined && (
        <section aria-label={`Configuration secrets in ${environment.name}`} data-deploy-secrets>
          <div className="gbx-group-label">Secrets in {environment.name}</div>
          {(props.secrets ?? []).length === 0 ? (
            <p className="gbx-waiting">None. A deploy writes each into the release&apos;s configuration; the values never come back.</p>
          ) : (
            <ul>
              {(props.secrets ?? []).map((k) => (
                <li key={k} data-deploy-secret={k}>
                  <code>{k}</code>{" "}
                  <button
                    type="button"
                    className="gbx-choice"
                    disabled={props.savingSecret === true}
                    aria-label={`Remove the secret ${k}`}
                    onClick={() => props.onSecret?.(k, undefined)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="gbx-generate-actions"
            onSubmit={(event) => {
              event.preventDefault();
              if (!keyOk || value === "") return;
              props.onSecret?.(key, value);
              setValue("");
            }}
          >
            <input aria-label="Secret name" placeholder="NAME" value={key} onChange={(e) => setKey(e.target.value)} />
            <input
              aria-label="Secret value"
              type="password"
              autoComplete="off"
              placeholder="value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit" className="gbx-choice" data-deploy-secret-set disabled={!keyOk || value === "" || props.savingSecret === true}>
              {props.savingSecret === true ? "Saving…" : "Set"}
            </button>
          </form>
        </section>
      )}
    </details>
  );
}

/**
 * A build's failure as one line: its first line, without what gearbox adds
 * after ` · ` (help, evidence), at most 240 characters. The whole of it is
 * the line's tooltip.
 */
export function failureLine(text: string): string {
  const first = (firstLineOf(text) || text).split(" · ")[0]?.trim() ?? "";
  return first.length > 240 ? `${first.slice(0, 240).trimEnd()}…` : first;
}

/**
 * Deploys as they are read: one row for a run of the same deploy asked again
 * and again with the same end -- five identical "Failed · dev · build X" lines
 * were five rows, and pushed everything else off the screen.
 */
export function groupDeployments(
  deployments: readonly ProductDeployment[],
): { readonly deployment: ProductDeployment; readonly times: number }[] {
  const out: { deployment: ProductDeployment; times: number }[] = [];
  for (const d of deployments) {
    const last = out[out.length - 1];
    const same =
      last !== undefined &&
      last.deployment.state === d.state &&
      last.deployment.environmentName === d.environmentName &&
      last.deployment.namespace === d.namespace &&
      last.deployment.action === d.action &&
      last.deployment.build === d.build &&
      last.deployment.chartVersion === d.chartVersion &&
      last.deployment.reason === d.reason;
    if (same) last.times += 1;
    else out.push({ deployment: d, times: 1 });
  }
  return out;
}
