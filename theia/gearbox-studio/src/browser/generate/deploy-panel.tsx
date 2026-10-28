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
  BUILD_STAGES,
  buildStages,
  deploymentStateLabel,
  isDeployable,
  parseTarget,
  targetValue,
  type DeployImage,
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
}

export function DeployPanel(props: DeployPanelProps): React.ReactElement {
  const { images, target } = props;
  const environment = target?.kind === "environment" ? props.environments.find((e) => e.id === target.id) : undefined;
  const nothing = props.environments.length === 0 && props.contexts.length === 0;
  // The server packs nothing and needs no helm here; a kube context does.
  const canDeploy = environment !== undefined ? props.requesting !== true : target?.kind === "context" && props.helm !== undefined;
  return (
    <div className="gbx-generate-run" data-generate-deploy>
      <div className="gbx-group-label">Deploy</div>
      {!props.generated ? (
        <p className="gbx-waiting" data-deploy-state="not-generated">
          Apply writes the images&apos; Dockerfiles and the chart; Deploy works on them once they are on disk.
        </p>
      ) : props.ready === undefined ? (
        <p className="gbx-waiting" data-deploy-state="checking">
          Checking for docker, helm and kubectl…
        </p>
      ) : images.length === 0 || props.chart === undefined ? (
        <p className="gbx-inline-error" data-deploy-state="no-plan">
          The generated tree has no docker/build.sh or Helm chart to deploy: generate this kubernetes profile again.
        </p>
      ) : (
        <>
          <div className="gbx-generate-actions">
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
          </div>
          <p data-deploy-images>
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
          {environment !== undefined && (
            <p className="gbx-waiting" data-deploy-environment={environment.name}>
              {environment.registryLogin === true
                ? `Build the images here, then Publish pushes them and the chart to ${environment.registry} with a token the Studio server gets for them -- no registry login on this machine -- and Deploy asks the server to install that build into ${environment.name}.`
                : `Build and push the images here, then Deploy asks the Studio server to install the chart into ${environment.name} with the organization's connection -- no cluster credentials are needed on this machine.`}
              {environment.protected ? " An organization administrator approves it first." : ""}
            </p>
          )}
          {!props.docker && (
            <p className="gbx-inline-error" data-deploy-missing="docker">
              docker does not answer on this machine: the images cannot be built here.
            </p>
          )}
          {props.helm === undefined && environment === undefined && (
            <p className="gbx-inline-error" data-deploy-missing="helm">
              helm is not on this machine: install Helm to preview the manifests and deploy to a kube context.{" "}
              <a href="https://helm.sh/docs/intro/install/" target="_blank" rel="noreferrer">
                helm.sh
              </a>
            </p>
          )}
          <div className="gbx-generate-actions" data-deploy-state="ready">
            <button type="button" className="gbx-start-primary" data-deploy-build disabled={!props.docker} onClick={props.onBuildImages}>
              Build images
            </button>
            <button
              type="button"
              className="gbx-choice"
              data-deploy-push
              disabled={!props.docker || !props.registry || props.publishing === true}
              onClick={props.onPush}
              title={
                environment?.registryLogin === true
                  ? `Push the images and the chart to ${props.registry} with a token the Studio server gets for them`
                  : props.registry
                    ? `docker push to ${props.registry}`
                    : "No image registry: set one on the environment or the profile to push"
              }
            >
              {environment?.registryLogin === true ? (props.publishing === true ? "Getting a token…" : "Publish") : "Push"}
            </button>
            {environment?.registryLogin === true && props.onBuildInStudio !== undefined && (
              <button
                type="button"
                className="gbx-choice"
                data-deploy-studio-build
                disabled={props.startingBuild === true}
                onClick={props.onBuildInStudio}
                title={`Studio builds what is pushed, in ${environment.name}'s cluster, and pushes to ${environment.registry}: nothing is built on this machine`}
              >
                {props.startingBuild === true ? "Starting…" : "Build in Studio"}
              </button>
            )}
            <button type="button" className="gbx-choice" data-deploy-template disabled={props.helm === undefined} onClick={props.onTemplate}>
              Preview manifests
            </button>
            <button type="button" className="gbx-start-primary" data-deploy-install disabled={!canDeploy} onClick={props.onDeploy}
              title={environment !== undefined ? "Ask the Studio server to deploy; asks first" : "helm upgrade --install into the chosen cluster; asks first"}>
              {props.requesting === true
                ? "Asking the server…"
                : props.studioBuild === true
                  ? "Deploy Studio's build"
                  : props.published === true
                    ? "Deploy the published build"
                    : "Deploy"}
            </button>
          </div>
          {props.note !== undefined && (
            <p className="gbx-waiting" data-deploy-note>
              {props.note}
            </p>
          )}
        </>
      )}
      {props.flow !== undefined && <FlowSection {...props} flow={props.flow} environment={environment} />}
    </div>
  );
}

/**
 * Where the product stands on its way out: what to do next, the builds with
 * how far each got and what it published -- the images and chart in the
 * environment's registry -- and the deploys with how they went.
 */
function FlowSection(props: DeployPanelProps & { readonly flow: DeployFlow; readonly environment: StudioEnvironment | undefined }): React.ReactElement {
  const { flow, environment } = props;
  const [bindTo, setBindTo] = React.useState("");
  return (
    <section className="gbx-deploy-flow" aria-label="Builds and deploys" data-deploy-flow>
      <div className="gbx-group-label">Builds and deploys</div>
      {flow.error !== undefined ? (
        <p className="gbx-inline-error" data-deploy-flow-error>
          Studio could not be asked for the project&apos;s builds and deploys: {flow.error}
        </p>
      ) : (
        <p className={flow.next.tone === "failed" ? "gbx-inline-error" : "gbx-waiting"} data-deploy-next={flow.next.tone} role="status">
          {flow.next.text}
        </p>
      )}
      {flow.unbound !== undefined && props.environments.length > 0 && props.onBind !== undefined && (
        <div className="gbx-generate-actions" data-deploy-bind={flow.unbound}>
          <label>
            Bind {flow.unbound} to{" "}
            <select aria-label={`Environment for the ${flow.unbound} profile`} value={bindTo} onChange={(e) => setBindTo(e.target.value)}>
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
            disabled={bindTo === "" || flow.binding === true}
            onClick={() => props.onBind?.(bindTo)}
          >
            {flow.binding === true ? "Binding…" : "Bind"}
          </button>
        </div>
      )}
      {flow.builds.length > 0 && (
        <ul className="gbx-deploy-builds" aria-label="Builds">
          {flow.builds.slice(0, SHOWN).map((build) => {
            const stages = buildStages(build);
            const canDeploy = isDeployable(build) && environment !== undefined && props.onDeployBuild !== undefined;
            return (
              <li key={build.buildId} data-deploy-build-id={build.buildId} data-deploy-build-status={build.status}>
                <div>
                  <code>{build.buildId}</code> · {build.status} · {build.where}
                  {build.shortSha !== undefined ? ` · ${build.shortSha}` : ""}
                  {build.branch !== undefined ? ` on ${build.branch}` : ""}
                </div>
                <div className="gbx-deploy-stages" aria-label="Stages">
                  {BUILD_STAGES.map((stage) => (
                    <span
                      key={stage}
                      className={`gbx-badge gbx-deploy-stage-${stages[stage]}`}
                      data-deploy-stage={stage}
                      data-deploy-stage-state={stages[stage]}
                      title={`${stage}: ${stages[stage]}`}
                    >
                      {stage} · {stages[stage]}
                    </span>
                  ))}
                </div>
                {build.status === "failed" && build.failure !== undefined && (
                  <p className="gbx-inline-error" data-deploy-build-failure>
                    {firstLine(build.failure)}
                  </p>
                )}
                {(build.chartRef !== undefined || build.images.length > 0) && (
                  <p data-deploy-build-published>
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
                {canDeploy && (
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
              </li>
            );
          })}
        </ul>
      )}
      {flow.deployments.length > 0 && (
        <ul className="gbx-deploy-history" aria-label="Deploys">
          {flow.deployments.slice(0, SHOWN).map((d) => (
            <li key={d.id} data-deploy-history={d.id} data-deploy-history-state={d.state}>
              {deploymentStateLabel(d.state)} · {d.environmentName} ({d.namespace})
              {d.action === "uninstall" ? " · uninstall" : d.chartVersion !== undefined ? ` · ${d.chartVersion}` : ""}
              {d.build !== undefined ? ` · build ${d.build}` : ""}
              {d.requestedBy !== undefined ? ` · ${d.requestedBy}` : ""}
              {d.reason !== undefined && <span className={d.state === "failed" ? "gbx-inline-error" : undefined}> -- {d.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {/* The release's live workloads are on the organization's Environments
          page: that read needs the organization, which an IDE opened on a
          project does not hold. */}
    </section>
  );
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0] ?? text;
}
