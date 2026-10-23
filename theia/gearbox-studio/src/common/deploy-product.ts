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
  readonly environments: readonly StudioEnvironment[];
  /** profile id -> environment id, as the project bound them. */
  readonly bound: Readonly<Record<string, string>>;
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
