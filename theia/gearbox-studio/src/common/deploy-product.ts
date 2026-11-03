// Constructor Studio: deploying a generated `kubernetes` product from the
// desktop -- the rules, shared by the Generate view and the IDE backend.
//
// Generate writes, for a kubernetes profile, a Dockerfile per application
// under `docker/<app>/`, `docker/build.sh` that builds them, and a Helm chart
// under `helm/<product>/` with a subchart per application. What it leaves to
// the person is getting the images where the cluster can pull them and
// installing the chart. Deploy does that in a terminal, a step at a time, so
// every command is visible and nothing reaches a cluster without a click:
//
//   1. Build images: `docker build` per application, as `build.sh` would --
//      run directly rather than through `sh`, which a Windows desktop lacks.
//   2. Push: only with the profile's `image_registry`; without one the images
//      stay in the local Docker, which a cluster sharing it can use.
//   3. Preview manifests: `helm template`, no cluster needed.
//   4. Deploy: `helm upgrade --install` into the chosen kube context.
//
// The image names, tags and build context are read from `build.sh`, the
// engine's own answer, not re-derived here.

/** One application's image, as `docker/build.sh` builds it. */
export interface DeployImage {
  readonly app: string;
  /** `repository:tag`, as generated (no registry). */
  readonly image: string;
}

/** What `docker/build.sh` says: the build context and the images. */
export interface BuildScript {
  /** The context, relative to the `docker/` folder. */
  readonly contextFromDocker: string;
  readonly images: readonly DeployImage[];
}

/**
 * Read `docker/build.sh`: the `CONTEXT=...` line and the `build_one <app>
 * '<image>'` calls of its build-everything branch. `undefined` when the script
 * is not the shape the engine writes.
 */
export function parseBuildScript(text: string): BuildScript | undefined {
  const context = /CONTEXT=\$\(CDPATH= cd -- "\$SCRIPT_DIR\/"'([^']*)' && pwd\)/.exec(text)?.[1];
  if (context === undefined) return undefined;
  const all = /if \[ "\$#" -eq 0 \]; then([\s\S]*?)exit 0/.exec(text)?.[1] ?? "";
  const images = [...all.matchAll(/build_one\s+([A-Za-z0-9_-]+)\s+'([^']+)'/g)].map((m) => ({
    app: m[1] as string,
    image: m[2] as string,
  }));
  return images.length === 0 ? undefined : { contextFromDocker: context, images };
}

/** `repository:tag` split at the tag's colon, not a registry's port. */
export function splitImage(image: string): { repository: string; tag: string | undefined } {
  const at = image.lastIndexOf(":");
  if (at < 0 || image.indexOf("/", at) >= 0) return { repository: image, tag: undefined };
  return { repository: image.slice(0, at), tag: image.slice(at + 1) };
}

/** The image under the profile's registry, or as generated when there is none. */
export function registryImage(image: string, registry: string | undefined | null): string {
  const prefix = (registry ?? "").trim().replace(/\/+$/, "");
  return prefix === "" ? image : `${prefix}/${image}`;
}

/** What Deploy can use here, and the generated tree's plan. */
export interface DeployInfo {
  readonly docker: boolean;
  /** `helm version --short`, when helm answers. */
  readonly helm?: string;
  readonly kubectl: boolean;
  /** The kube contexts kubectl knows, and the current one. */
  readonly contexts: readonly string[];
  readonly currentContext?: string;
  /** From `docker/build.sh`; `undefined` when the tree has none (not a kubernetes profile, or not generated). */
  readonly script?: BuildScript;
  /** The chart, relative to the tree (`helm/<product>`). */
  readonly chart?: string;
}

export interface DeployInput {
  /** Absolute: the generated tree. */
  readonly outRoot: string;
  readonly script: BuildScript;
  /** The chart, relative to `outRoot` (`helm/<product>`). */
  readonly chart: string;
  /** The Helm release name: the product id. */
  readonly release: string;
  readonly namespace: string | undefined;
  readonly registry: string | undefined | null;
  /** The kube context; `undefined` for `helm template`. */
  readonly kubeContext?: string;
}

const q = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

function join(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function setImages(input: DeployInput): string[] {
  if ((input.registry ?? "").trim() === "") return [];
  return input.script.images.map(
    (image) => `--set ${image.app}.image.repository=${splitImage(registryImage(image.image, input.registry)).repository}`,
  );
}

/** The commands, in the order Deploy runs them, each one line for a terminal. */
export function deployCommands(input: DeployInput): {
  readonly build: readonly string[];
  readonly push: readonly string[];
  readonly template: string;
  readonly install: string | undefined;
} {
  const docker = join(input.outRoot, "docker");
  const context = join(docker, input.script.contextFromDocker);
  // No `--ignorefile`, which build.sh passes and no docker build takes: the
  // IDE backend gives each Dockerfile its own `Dockerfile.dockerignore`
  // first (`prepareImageBuild`), which BuildKit reads instead.
  const build = input.script.images.map((image) =>
    [
      "docker build",
      `-f ${q(join(docker, image.app, "Dockerfile"))}`,
      `-t ${registryImage(image.image, input.registry)}`,
      q(context),
    ].join(" "),
  );
  const push =
    (input.registry ?? "").trim() === "" ? [] : input.script.images.map((image) => `docker push ${registryImage(image.image, input.registry)}`);
  const chart = q(join(input.outRoot, input.chart));
  const namespace = input.namespace?.trim() ? [`--namespace ${input.namespace.trim()}`] : [];
  const template = ["helm template", input.release, chart, ...namespace, ...setImages(input)].join(" ");
  const install =
    input.kubeContext === undefined
      ? undefined
      : [
          "helm upgrade --install",
          input.release,
          chart,
          ...namespace,
          ...(namespace.length > 0 ? ["--create-namespace"] : []),
          `--kube-context ${input.kubeContext}`,
          ...setImages(input),
        ].join(" ");
  return { build, push, template, install };
}

// ---------------------------------------------------------------------------
// The organization's environments (ADR-0043)
//
// Deploy lists the environments the product's project may deploy to above
// the member's own kube contexts. Choosing one takes its namespace and image
// registry instead of the profile's, and Deploy then asks the Studio server
// to install the chart with the environment's connection: no cluster
// credential is needed, or used, on this machine.
// ---------------------------------------------------------------------------

/** One environment the project may deploy to, as Deploy needs it. */
export interface StudioEnvironment {
  readonly id: string;
  readonly name: string;
  /** The project's namespace there. */
  readonly namespace: string;
  /** Registry prefix; empty for the images as generated. */
  readonly registry: string;
  /** A deploy waits for an organization administrator's approval. */
  readonly protected: boolean;
  /**
   * The environment has a registry login (ADR-0048): Publish pushes the
   * images and the chart with a short-lived token the server gets for them,
   * and Deploy names the published build -- no `docker login` here.
   */
  readonly registryLogin?: boolean;
}

/** Where the open product can be deployed, from the Studio server. */
export interface DeployTargets {
  readonly projectId: string;
  /** The project's organization: a deploy's live status is read in it. */
  readonly organizationId?: string;
  readonly environments: readonly StudioEnvironment[];
  /** profile id -> environment id, as the project bound them. */
  readonly bound: Readonly<Record<string, string>>;
  /** The secret keys of the release's configuration, per environment; the values never come back. */
  readonly secrets?: readonly ConfigSecret[];
}

/** A secret of the release's configuration in one environment (ADR-0048 §7): its key only. */
export interface ConfigSecret {
  readonly environmentId: string;
  readonly key: string;
}

/** A deployed release as its cluster reports it now. */
export interface DeploymentStatus {
  readonly workloads: readonly { readonly name: string; readonly ready: number; readonly desired: number; readonly images: readonly string[] }[];
  /** Hosts the release's ingresses answer on. */
  readonly hosts: readonly string[];
  /** The containers that cannot start, and why: one line each. */
  readonly problems?: readonly string[];
}

/** The end of one container's log of a deployed release. */
export interface ContainerLog {
  readonly pod: string;
  readonly container: string;
  /** The run before its last restart: what a crashing container said before it died. */
  readonly previous: boolean;
  readonly text: string;
}

/** What a container's log is headed with. */
export function logHeading(log: Pick<ContainerLog, "pod" | "container" | "previous">): string {
  return `${log.pod} · ${log.container}${log.previous ? " (the run before its last restart)" : ""}`;
}

/** The CI workflow Studio proposed to the project's repository (ADR-0048 §5). */
export interface BuildWorkflow {
  /** `.github/workflows/studio-build-<product>.yml`. */
  readonly path: string;
  readonly branch: string;
  readonly prUrl: string | undefined;
}

/** A configuration secret's key: what the release reads as an environment variable. */
export function validSecretKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** What Deploy aims at: one of the organization's environments, or a kube context of this machine. */
export type DeployTarget = { readonly kind: "environment"; readonly id: string } | { readonly kind: "context"; readonly name: string };

/** The `<select>` value of a target, and back. */
export function targetValue(target: DeployTarget): string {
  return target.kind === "environment" ? `env:${target.id}` : `ctx:${target.name}`;
}
export function parseTarget(value: string): DeployTarget | undefined {
  if (value.startsWith("env:")) return { kind: "environment", id: value.slice(4) };
  if (value.startsWith("ctx:")) return { kind: "context", name: value.slice(4) };
  return undefined;
}

/**
 * The target Deploy starts on: the environment the project bound this profile
 * to, else the first environment, else the current kube context.
 */
export function defaultTarget(
  targets: DeployTargets | undefined,
  profile: string | undefined,
  contexts: readonly string[],
  currentContext: string | undefined,
): DeployTarget | undefined {
  const envs = targets?.environments ?? [];
  const bound = profile !== undefined ? targets?.bound[profile] : undefined;
  const env = envs.find((e) => e.id === bound) ?? envs[0];
  if (env !== undefined) return { kind: "environment", id: env.id };
  const context = currentContext ?? contexts[0];
  return context !== undefined ? { kind: "context", name: context } : undefined;
}

/**
 * The target after the environments were read (again): what the member chose
 * stays; a local context picked only because no environment was known yet --
 * the project was not resolved, or the sign-in came later -- gives way to the
 * project's environment, so a deploy does not go to whatever cluster the
 * machine's kubeconfig happens to point at.
 */
export function nextTarget(
  current: DeployTarget | undefined,
  chosen: boolean,
  targets: DeployTargets | undefined,
  profile: string | undefined,
  contexts: readonly string[],
  currentContext: string | undefined,
): DeployTarget | undefined {
  if (current !== undefined && (chosen || current.kind === "environment")) return current;
  return defaultTarget(targets, profile, contexts, currentContext) ?? current;
}

/** How long the Run & Deploy view waits before asking again for a project it could not place. */
export const TARGETS_RETRY_MS = 15_000;

/**
 * Whether to read the project's environments and builds for `file` now. Once
 * per product file -- unless the project could not be placed (signed out, the
 * sign-in still resuming, the server away), which is asked again after a while
 * instead of never.
 */
export function shouldAskFlow(asked: { readonly file?: string; readonly at?: number; readonly placed: boolean }, file: string, now: number): boolean {
  if (asked.file !== file) return true;
  return !asked.placed && (asked.at === undefined || now - asked.at >= TARGETS_RETRY_MS);
}

/** The environment a target names, when it names one. */
export function targetEnvironment(targets: DeployTargets | undefined, target: DeployTarget | undefined): StudioEnvironment | undefined {
  return target?.kind === "environment" ? targets?.environments.find((e) => e.id === target.id) : undefined;
}

/** What the server is asked: `POST /studio-environments/v1/deployments?project_id=`. */
export interface DeployRequestBody {
  readonly environment_id: string;
  readonly profile: string;
  readonly product: string;
  readonly commit?: string;
  /** The build it came from (ADR-0045 §4): the id Build reported it under. */
  readonly build?: string;
  readonly images: readonly { readonly app: string; readonly image: string }[];
  /** The chart, packaged (`.tgz`), base64. */
  readonly chart: string;
}

export function deployRequest(input: {
  readonly environment: StudioEnvironment;
  readonly profile: string;
  readonly product: string;
  readonly commit?: string;
  readonly build?: string;
  readonly script: BuildScript;
  readonly chart: string;
}): DeployRequestBody {
  return {
    environment_id: input.environment.id,
    profile: input.profile,
    product: input.product,
    ...(input.commit !== undefined && /^[0-9a-f]{7,64}$/.test(input.commit) ? { commit: input.commit } : {}),
    ...(input.build !== undefined && /^[A-Za-z0-9-]{8,64}$/.test(input.build) ? { build: input.build } : {}),
    // As generated: the server puts the environment's registry in front.
    images: input.script.images.map((i) => ({ app: i.app, image: i.image })),
    chart: input.chart,
  };
}

// ---------------------------------------------------------------------------
// Publishing a build to an environment's registry (ADR-0048)
//
// With a registry login on the environment, the images and the chart are
// published under its prefix with a token the Studio server gets from the
// registry for exactly those repositories, and Deploy then names the build
// that published them: the same request the portal makes, and the server
// pulls the chart itself.
// ---------------------------------------------------------------------------

/** The tag and chart version a desktop publish uses: the commit, else the time. */
export function publishStamp(commit: string | undefined, now: Date = new Date()): { tag: string; chartVersion: string } {
  const id =
    commit !== undefined && /^[0-9a-f]{12,}$/.test(commit)
      ? commit.slice(0, 12)
      : now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return { tag: `desktop-${id}`, chartVersion: `0.0.0-desktop.${id}` };
}

/** What Publish runs, and what the build it makes published. */
export interface PublishPlan {
  /** Repositories under the prefix the token must reach: `gbx-api`, `charts/shop`. */
  readonly repositories: readonly string[];
  /** The commands, each one line for the Deploy terminal. */
  readonly commands: readonly string[];
  readonly images: readonly { readonly app: string; readonly image: string }[];
  readonly chartRef: string;
  readonly chartVersion: string;
}

export function publishPlan(input: {
  readonly outRoot: string;
  readonly script: BuildScript;
  /** The chart, relative to `outRoot` (`helm/<product>`). */
  readonly chart: string;
  readonly product: string;
  /** The environment's registry prefix, `ghcr.io/acme`. */
  readonly prefix: string;
  readonly tag: string;
  readonly chartVersion: string;
  /** A folder holding the `config.json` the token is written into. */
  readonly configDir: string;
}): PublishPlan {
  const prefix = input.prefix.trim().replace(/\/+$/, "");
  const config = join(input.configDir);
  const images = input.script.images.map((i) => {
    const built = registryImage(i.image, prefix);
    const name = splitImage(i.image).repository;
    return { app: i.app, built, name, published: `${prefix}/${name}:${input.tag}` };
  });
  const chartName = input.chart.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? input.product;
  const commands = [
    ...images.flatMap((i) => [`docker tag ${i.built} ${i.published}`, `docker --config ${q(config)} push ${i.published}`]),
    `helm package ${q(join(input.outRoot, input.chart))} --version ${input.chartVersion} --destination ${q(config)}`,
    `helm push ${q(join(config, `${chartName}-${input.chartVersion}.tgz`))} oci://${prefix}/charts --registry-config ${q(join(config, "config.json"))}`,
  ];
  return {
    repositories: [...new Set(images.map((i) => i.name)), `charts/${chartName}`],
    commands,
    images: images.map((i) => ({ app: i.app, image: i.published })),
    chartRef: `oci://${prefix}/charts/${chartName}`,
    chartVersion: input.chartVersion,
  };
}

/** Deploy a published build: the server takes its chart and images from its record. */
export function deployBuildRequest(input: {
  readonly environment: StudioEnvironment;
  readonly profile: string;
  readonly product: string;
  readonly build: string;
}): { readonly environment_id: string; readonly profile: string; readonly product: string; readonly build: string } {
  return { environment_id: input.environment.id, profile: input.profile, product: input.product, build: input.build };
}

/** The line a generated Dockerfile's build stage lacks: protoc and the
 *  well-known types for the gRPC gears, cmake for zlib (`libz-ng-sys`).
 *  Inserted after its `FROM rust:… AS build` until the engine writes it
 *  (constructorfabric/gearbox#12). */
export const BUILD_STAGE_TOOLS =
  "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends protobuf-compiler libprotobuf-dev cmake && rm -rf /var/lib/apt/lists/*";

/** A generated Dockerfile with the build stage's tools; unchanged when it has them. */
export function withBuildTools(dockerfile: string): string {
  if (dockerfile.includes("protobuf-compiler")) return dockerfile;
  return dockerfile.replace(/^(FROM rust:\S+ AS build)\s*$/m, `$1\n${BUILD_STAGE_TOOLS}`);
}

/** What the server answered, as Deploy says it. */
export function deployAnswer(state: string, environment: string, namespace: string): string {
  return state === "awaiting_approval"
    ? `The deploy to ${environment} waits for an organization administrator's approval (Studio, organization → Environments).`
    : `The Studio server is deploying into ${environment} (namespace ${namespace}); the organization's Environments page shows how it went.`;
}

// ---------------------------------------------------------------------------
// The way a product goes out, as the portal shows it (product, build, publish,
// deploy): the project's builds and deploys, read from the Studio server so the
// IDE and the project's Builds and Deploys tabs say the same thing about the
// same records. A build here is any the server knows of -- one Studio ran in an
// environment's cluster, or one an IDE reported -- and what it published is
// what is in the environment's registry to deploy.
// ---------------------------------------------------------------------------

export type ProductBuildStatus = "running" | "passed" | "failed" | "cancelled" | "unknown";

/** One build of the project's product (`build` artifact nodes, ADR-0045 / ADR-0048 §9). */
export interface ProductBuild {
  readonly buildId: string;
  /** `studio` (a Job in an environment's cluster), `desktop` or `session`. */
  readonly where: string;
  readonly status: ProductBuildStatus;
  readonly product: string | undefined;
  readonly profile: string | undefined;
  readonly shortSha: string | undefined;
  /** The product description revision it was built with (ADR-0053 §2). */
  readonly descriptionRevision?: number;
  readonly branch: string | undefined;
  readonly startedAt: string | undefined;
  readonly failure: string | undefined;
  readonly failureStep: string | undefined;
  /** The Job's container a running Studio build is in: `prepare`, `build` or `publish`. */
  readonly step: string | undefined;
  /** The chart it published (ADR-0048), when it published one. */
  readonly chartRef: string | undefined;
  readonly chartVersion: string | undefined;
  /** The images it published, by application. */
  readonly images: readonly { readonly app: string; readonly image: string }[];
}

export type DeploymentState = "awaiting_approval" | "declined" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** One deploy the server recorded (`GET /studio-environments/v1/deployments`). */
export interface ProductDeployment {
  readonly id: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly namespace: string;
  readonly profile: string;
  readonly product: string;
  /** `install` | `uninstall`. */
  readonly action: string;
  readonly build: string | undefined;
  readonly chartVersion: string | undefined;
  readonly state: string;
  readonly reason: string | undefined;
  /** What the run said: its summary, or why it failed. */
  readonly outcome?: string;
  readonly requestedAt: string;
  readonly requestedBy: string | undefined;
}

/** The portal's words for a deploy's state, so both say it the same way. */
export const DEPLOYMENT_STATE_LABELS: Readonly<Record<DeploymentState, string>> = {
  awaiting_approval: "Waiting for approval",
  declined: "Declined",
  queued: "Queued",
  running: "Deploying",
  succeeded: "Deployed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function deploymentStateLabel(state: string): string {
  return DEPLOYMENT_STATE_LABELS[state as DeploymentState] ?? state;
}

/** A deploy the server has not finished: its release may change any moment. */
export function deployInFlight(state: string): boolean {
  return state === "queued" || state === "running";
}

/**
 * What the Run & Deploy view follows on its next look: whether to look again
 * in a few seconds (a build or a deploy is still going), and the deploys whose
 * release to read from the cluster each time -- the installing ones, so a pod
 * that cannot start shows while helm still waits for it.
 */
export function flowToFollow(
  builds: readonly Pick<ProductBuild, "status">[],
  deployments: readonly Pick<ProductDeployment, "id" | "state" | "action">[],
): { readonly again: boolean; readonly statuses: readonly string[] } {
  const going = deployments.filter((d) => deployInFlight(d.state));
  return {
    again: builds.some((b) => b.status === "running") || going.length > 0,
    statuses: going.filter((d) => d.action !== "uninstall" && d.state === "running").map((d) => d.id),
  };
}

/** A build's stages: the generated tree, the images, and their publishing. */
export const BUILD_STAGES = ["prepare", "images", "publish"] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];
export type StageState = "done" | "running" | "failed" | "waiting";

/**
 * The stage a step names. The Job's `build` container makes the images, and
 * any step this does not know -- an IDE's `protoc` or `compile` -- is the
 * images too.
 */
export function stageOf(step: string | undefined): BuildStage | undefined {
  if (step === undefined || step === "") return undefined;
  return step === "prepare" || step === "publish" ? step : "images";
}

/**
 * How far a build got, stage by stage: a passed build did all three; a failed
 * one those before the one it failed in; a running one those before the one it
 * is in (the first, when it does not say).
 */
export function buildStages(build: Pick<ProductBuild, "status" | "step" | "failureStep">): Record<BuildStage, StageState> {
  const at = (stage: BuildStage | undefined): number => (stage !== undefined ? BUILD_STAGES.indexOf(stage) : 0);
  const out = {} as Record<BuildStage, StageState>;
  BUILD_STAGES.forEach((stage, i) => {
    if (build.status === "passed") out[stage] = "done";
    else if (build.status === "failed") {
      const failed = at(stageOf(build.failureStep));
      out[stage] = i < failed ? "done" : i === failed ? "failed" : "waiting";
    } else if (build.status === "running") {
      const now = at(stageOf(build.step));
      out[stage] = i < now ? "done" : i === now ? "running" : "waiting";
    } else out[stage] = "waiting";
  });
  return out;
}

/** A build that can be deployed by its id alone: it passed and published a chart. */
export function isDeployable(build: ProductBuild): boolean {
  return build.status === "passed" && build.chartRef !== undefined && build.chartVersion !== undefined;
}

/** What comes next, in one line; `failed` when what failed is the next thing to look at. */
export interface NextStep {
  readonly text: string;
  readonly tone: "todo" | "done" | "failed";
}

function stageWord(build: ProductBuild): string {
  const stages = buildStages(build);
  const at = BUILD_STAGES.find((s) => stages[s] === "running" || stages[s] === "failed");
  return at === "prepare" ? "preparing" : at === "publish" ? "publishing" : "building the images";
}

/** A deploy the server has not finished with: it still says where the product is going. */
function inFlight(state: string): boolean {
  return state === "queued" || state === "running" || state === "awaiting_approval";
}

/**
 * Where the product stands on its way out, and what to do next here -- the
 * portal's Builds and Deploys lines (`pipeline.ts`) in one, worded for this
 * panel: Build in Studio, Build images and Publish, Deploy.
 *
 * Builds first, because a deploy names a build: while the newest one runs or
 * after it failed, that is the news. Then the environment side, as the
 * Deploys tab says it.
 */
export function nextStep(input: {
  /** Newest first. */
  readonly builds: readonly ProductBuild[];
  readonly deployments: readonly ProductDeployment[];
  readonly environments: number;
  /** Whether the open profile is bound to one of them. */
  readonly bound: boolean;
  /** An environment has a registry login, so Studio can build and Publish can push. */
  readonly canBuildInStudio: boolean;
}): NextStep {
  const latest = input.builds[0];
  if (latest?.status === "running") {
    return { text: `Build ${latest.buildId} is ${stageWord(latest)}; this panel follows it.`, tone: "todo" };
  }
  if (latest?.status === "failed") {
    const why = latest.failure !== undefined ? `: ${latest.failure.split("\n")[0]}` : "";
    return { text: `The last build failed while ${stageWord(latest)}${why}. Fix it and build again.`, tone: "failed" };
  }
  if (input.environments === 0) {
    return {
      text: "No environment to deploy to yet: an organization administrator adds one in Studio (Organization › Environments). A kube context on this machine still works.",
      tone: "todo",
    };
  }
  if (!input.bound) return { text: "Bind this profile to an environment below, so a deploy knows where it goes.", tone: "todo" };
  if (latest === undefined) {
    return {
      text: input.canBuildInStudio
        ? "Nothing built yet: Build in Studio, or Build images here and Publish them."
        : "Nothing built yet. Building in Studio needs an environment with a registry connection; here, Build images and Push, then Deploy.",
      tone: "todo",
    };
  }
  if (latest.status !== "passed") return { text: `The last build ended ${latest.status}. Build again.`, tone: "todo" };
  if (!isDeployable(latest)) {
    return { text: "The last build passed and published no chart, so there is nothing to deploy: Build in Studio, or Publish from here.", tone: "todo" };
  }
  const deploy = [...input.deployments].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  // A deploy of an older build is history once a newer build is ready -- unless
  // it is still under way, which is what a person needs to hear first.
  if (deploy === undefined || (deploy.build !== latest.buildId && !inFlight(deploy.state))) {
    return { text: `${latest.chartVersion} is published. Next: Deploy this build.`, tone: "todo" };
  }
  const where = `${deploy.environmentName} (${deploy.namespace})`;
  switch (deploy.state) {
    case "succeeded":
      return deploy.action === "uninstall"
        ? { text: `Uninstalled from ${where}.`, tone: "done" }
        : { text: `Runs in ${where}${deploy.chartVersion !== undefined ? `: ${deploy.chartVersion}` : ""}.`, tone: "done" };
    case "failed":
      return {
        text: `The last deploy to ${where} failed${
          (deploy.reason ?? deploy.outcome) !== undefined ? `: ${firstLineOf(deploy.reason ?? deploy.outcome ?? "")}` : ""
        }.`,
        tone: "failed",
      };
    default:
      return { text: `${deploymentStateLabel(deploy.state)}: ${where}.`, tone: "todo" };
  }
}

/**
 * The line of `text` that says what went wrong: the first that starts with
 * `Error` (helm and docker print theirs after a line of progress, such as
 * "Release … does not exist. Installing it now."), else the first non-empty
 * one; at most 240 characters.
 */
export function firstLineOf(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const line = lines.find((l) => /^error\b/i.test(l)) ?? lines[0] ?? "";
  return line.length > 240 ? `${line.slice(0, 240).trimEnd()}…` : line;
}
