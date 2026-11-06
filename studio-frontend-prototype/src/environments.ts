/* Where an organization's products run (ADR-0043): the rules behind the
 * Environments screen and the product card's Deploy section, kept apart
 * from the React for their tests. The server checks all of these again;
 * here they say what is wrong before the form is sent. */

import type {
  Connection,
  DeployEnvironment,
  DeployEnvironmentInput,
  Deployment,
  DeploymentState,
  EnvironmentReadiness,
} from "./api";

/** Whether a deploy's release is worth reading from its cluster: one that
 *  installed, or one that failed -- whose pods say why -- or is installing. */
export function canReadStatus(d: Pick<Deployment, "state" | "action">): boolean {
  return d.action !== "uninstall" && (d.state === "succeeded" || d.state === "failed" || d.state === "running");
}

/** One namespace per project and environment, unless the environment says otherwise. */
export const DEFAULT_NAMESPACE_PATTERN = "{project}-{environment}";

/** A name made fit for a namespace, as the server makes it: lowercased, every
 *  run of other characters one `-`, trimmed of `-`. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A Kubernetes namespace (DNS-1123 label). */
export function isDnsLabel(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
}

/** The namespace `pattern` gives `project` in `environment`. */
export function namespaceFor(pattern: string, project: string, environment: string): string {
  return (pattern.trim() || DEFAULT_NAMESPACE_PATTERN)
    .split("{project}")
    .join(slug(project))
    .split("{environment}")
    .join(slug(environment));
}

/** A form with nothing in it yet. */
export function emptyEnvironment(): DeployEnvironmentInput {
  return {
    name: "",
    description: "",
    kind: "kubernetes",
    connection_id: "",
    research_project: null,
    research_hardware: null,
    registry: "",
    registry_connection_id: null,
    namespace_pattern: DEFAULT_NAMESPACE_PATTERN,
    database: "none",
    database_image: null,
    protected: false,
    promote_from: null,
    projects: null,
    previews: null,
    builder_image: null,
    builder_registry_connection_id: null,
    registry_pull_connection_id: null,
    build_namespace: null,
    namespaces: null,
    allow_broad_registry_token: false,
    infra: null,
    strictness: null,
  };
}

/** What a stored environment looks like as a form. */
export function environmentInput(e: DeployEnvironment): DeployEnvironmentInput {
  return {
    name: e.name,
    description: e.description,
    kind: e.kind ?? "kubernetes",
    connection_id: e.connection_id,
    research_project: e.research_project ?? null,
    research_hardware: e.research_hardware ?? null,
    registry: e.registry,
    registry_connection_id: e.registry_connection_id ?? null,
    namespace_pattern: e.namespace_pattern,
    database: e.database,
    database_image: e.database_image ?? null,
    protected: e.protected,
    promote_from: e.promote_from ?? null,
    projects: e.projects ?? null,
    previews: e.previews ?? null,
    // Kept as stored: a form that left them out would clear them on save.
    builder_image: e.builder_image ?? null,
    builder_registry_connection_id: e.builder_registry_connection_id ?? null,
    registry_pull_connection_id: e.registry_pull_connection_id ?? null,
    build_namespace: e.build_namespace ?? null,
    namespaces: e.namespaces ?? null,
    allow_broad_registry_token: e.allow_broad_registry_token ?? false,
    infra: e.infra ?? null,
    // Kept as stored, so a save does not fall back to what `protected` implies.
    strictness: e.strictness ?? null,
  };
}

/** What an environment checks a product as, said: its own strictness, else
 *  what being protected or not implies (ADR-0060 §5). */
export function strictnessOf(e: { strictness?: "dev" | "prod" | null; protected: boolean }): "dev" | "prod" {
  return e.strictness ?? (e.protected ? "prod" : "dev");
}

/** The fields of the environment form a problem can belong to. */
export type EnvironmentField =
  | "name"
  | "connection_id"
  | "registry"
  | "registry_connection_id"
  | "namespace_pattern"
  | "projects"
  | "research_project"
  | "previews"
  | "builder_image"
  | "build_namespace"
  | "namespaces";

/** Where a build's Job runs unless the environment says otherwise. */
export const DEFAULT_BUILD_NAMESPACE = "{project}-build";

/** Everything wrong with a form, by field, in the words the person reads:
 *  shown together at their fields, so one fix does not uncover the next. */
export function environmentProblems(
  input: DeployEnvironmentInput,
  others: readonly DeployEnvironment[],
  editing?: string,
  registries: readonly Connection[] = [],
): Partial<Record<EnvironmentField, string>> {
  const out: Partial<Record<EnvironmentField, string>> = {};
  const name = input.name.trim();
  if (!isDnsLabel(name)) out.name = "Only lowercase letters, digits and '-', like dev, stage or prod.";
  else if (others.some((e) => e.name === name && e.id !== editing)) out.name = `The organization already has an environment '${name}'.`;
  if (input.kind === "research") {
    // Research keeps the registry, the namespace and the address (ADR-0049 §2).
    if (!input.connection_id) out.connection_id = "Choose your Constructor Research sign-in: it lists the projects to pick from.";
    if (!(input.research_project ?? "").trim()) out.research_project = "Choose the Research project the products run in.";
    if (input.projects && input.projects.length === 0) out.projects = "Choose at least one project, or let every project deploy here.";
    return out;
  }
  if (!input.connection_id) out.connection_id = "Choose the cluster: a Kubernetes connection of the organization.";
  const pattern = (input.namespace_pattern ?? "").trim() || DEFAULT_NAMESPACE_PATTERN;
  if (!pattern.includes("{project}"))
    out.namespace_pattern = "Keep {project} in it: each project gets its own namespace, so one product never overwrites another.";
  else if (!isDnsLabel(namespaceFor(pattern, "a-project", name || "env")))
    out.namespace_pattern = `That does not make a namespace: '${namespaceFor(pattern, "a-project", name || "env")}'.`;
  const registry = input.registry.trim();
  if (registry.includes("://")) out.registry = "Write the registry without a scheme, e.g. ghcr.io/acme.";
  else if (registry !== "" && !/^[A-Za-z0-9._\-/:]+$/.test(registry)) out.registry = "That is not an image registry prefix, e.g. ghcr.io/acme.";
  const login = input.registry_connection_id ? registries.find((c) => c.id === input.registry_connection_id) : undefined;
  if (input.registry_connection_id && !out.registry) {
    const host = login ? registryHost(login.base_url) : "";
    if (registry === "") out.registry = "Say where in the registry the images go, e.g. ghcr.io/acme.";
    else if (host && registry !== host && !registry.startsWith(`${host}/`))
      out.registry = `The prefix is not on ${host}, the registry this login is for.`;
  }
  if (input.projects && input.projects.length === 0) out.projects = "Choose at least one project, or let every project deploy here.";
  const builder = (input.builder_image ?? "").trim();
  // A builder named by tag is whatever the tag points at on the day: the
  // build that passed yesterday is not the one that runs today.
  if (builder && !/^[A-Za-z0-9._\-/:]+@sha256:[a-f0-9]{64}$/.test(builder))
    out.builder_image = "Name it by digest from the organization's mirror, e.g. ghcr.io/acme/mirror/builder@sha256:….";
  const buildNs = (input.build_namespace ?? "").trim();
  if (buildNs && !isDnsLabel(namespaceFor(buildNs, "a-project", name || "env")))
    out.build_namespace = `That does not make a namespace: '${namespaceFor(buildNs, "a-project", name || "env")}'.`;
  const given = input.namespaces ?? [];
  const notLabel = given.find((n) => !isDnsLabel(n));
  if (notLabel !== undefined) out.namespaces = `'${notLabel}' is not a namespace.`;
  const previews = input.previews;
  if (previews) {
    const domain = previews.domain.trim().replace(/^\.+|\.+$/g, "");
    const ttl = previews.ttl_hours ?? 72;
    const most = previews.max_live ?? 3;
    if (input.protected) out.previews = "A protected environment takes no previews: its deploys wait for approval.";
    else if (domain && !domain.split(".").every((l) => isDnsLabel(l.toLowerCase())))
      out.previews = "That is not a domain, e.g. preview.example.com.";
    else if (!Number.isInteger(ttl) || ttl < 1 || ttl > 336) out.previews = "A preview lives from 1 to 336 hours.";
    else if (!Number.isInteger(most) || most < 1 || most > 20) out.previews = "A project keeps from 1 to 20 previews at once.";
  }
  return out;
}

/** The first thing wrong with a form; `null` when nothing. */
export function environmentProblem(input: DeployEnvironmentInput, others: readonly DeployEnvironment[], editing?: string): string | null {
  return Object.values(environmentProblems(input, others, editing))[0] ?? null;
}

/** The environments that deploy with each connection, by connection id. */
export function environmentsByConnection(environments: readonly DeployEnvironment[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of environments) {
    out.set(e.connection_id, [...(out.get(e.connection_id) ?? []), e.name]);
    if (e.registry_connection_id) out.set(e.registry_connection_id, [...(out.get(e.registry_connection_id) ?? []), e.name]);
  }
  return out;
}

/** The registries an environment can name: the organization's `registry`
 *  connections, not a personal one (ADR-0048). */
export function registryConnections(connections: readonly Connection[]): Connection[] {
  return connections.filter((c) => c.provider === "registry" && c.scope !== "personal");
}

/** `ghcr.io`, `harbor.acme.example:8443`: what an image reference on a
 *  registry starts with, from the connection's address. */
export function registryHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** The connections an environment can name: the organization's clusters,
 *  not a personal one -- a deploy runs as the server, which cannot read it. */
export function clusterConnections(connections: readonly Connection[]): Connection[] {
  return connections.filter((c) => c.provider === "kubernetes" && c.scope !== "personal");
}

/** The Constructor Research connections an environment can run on: a
 *  member's own sign-in, which its builds and deploys use for the member who
 *  asks (ADR-0049 §5). */
export function researchConnections(connections: readonly Connection[]): Connection[] {
  return connections.filter((c) => c.provider === "research");
}

/** A deployment's state, as a person reads it. */
export const STATE_LABELS: Record<DeploymentState, string> = {
  awaiting_approval: "Waiting for approval",
  declined: "Declined",
  queued: "Queued",
  running: "Deploying",
  succeeded: "Deployed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The badge class a state is drawn with. */
export function stateTone(state: DeploymentState): "ok" | "warn" | "bad" | "idle" {
  switch (state) {
    case "succeeded":
      return "ok";
    case "awaiting_approval":
    case "queued":
    case "running":
      return "warn";
    case "failed":
    case "declined":
      return "bad";
    default:
      return "idle";
  }
}

/** What runs where: the latest succeeded deployment of each project in each
 *  environment, newest first as the server lists them. */
export function runningNow(deployments: readonly Deployment[]): Deployment[] {
  const seen = new Set<string>();
  const out: Deployment[] = [];
  for (const d of deployments) {
    // A preview runs beside the environment, not in it (ADR-0055 §2).
    if (d.state !== "succeeded" || d.preview) continue;
    const key = `${d.project_id}/${d.environment_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Taken out: nothing of the project runs there now.
    if ((d.action ?? "install") === "install") out.push(d);
  }
  return out;
}

/** The deploys an administrator has to decide about. */
export function awaitingDecision(deployments: readonly Deployment[]): Deployment[] {
  return deployments.filter((d) => d.state === "awaiting_approval");
}

/** A short commit, as people quote one. */
export function shortCommit(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 8) : "";
}

/** One cluster as the Environments page shows it: what is on it, what runs
 *  there, and when it last took a deploy. */
export interface ClusterCard {
  /** The connection's id; "" for environments whose cluster this page
   *  cannot see (a connection out of reach, or removed). */
  id: string;
  label: string;
  baseUrl: string;
  environments: DeployEnvironment[];
  /** The newest deploy per project and environment that succeeded here. */
  running: Deployment[];
  deployments: Deployment[];
  lastDeploy: string | null;
}

/** The organization's clusters, each with its environments and deploys, in
 *  the order they were connected; environments on a cluster the page cannot
 *  see come last, under one card, so nothing disappears. */
export function clusterCards(
  clusters: readonly Connection[],
  environments: readonly DeployEnvironment[],
  deployments: readonly Deployment[],
): ClusterCard[] {
  const card = (id: string, label: string, baseUrl: string, envs: DeployEnvironment[]): ClusterCard => {
    const ids = new Set(envs.map((e) => e.id));
    const deps = deployments.filter((d) => ids.has(d.environment_id));
    const last = deps.map((d) => d.requested_at).sort().pop() ?? null;
    return { id, label, baseUrl, environments: envs, running: runningNow(deps), deployments: deps, lastDeploy: last };
  };
  const known = new Set(clusters.map((c) => c.id));
  const out = clusters.map((c) => card(c.id, c.label, c.base_url ?? "", environments.filter((e) => e.connection_id === c.id)));
  const orphans = environments.filter((e) => !known.has(e.connection_id));
  if (orphans.length) out.push(card("", "A cluster this page cannot see", "", orphans));
  return out;
}

/** A cluster's readiness as a badge: its words, its tone, and the detail
 *  behind it. "Namespaces given": Studio may not make its own, and uses the
 *  ones the cluster's administrators gave. */
export function readinessBadge(r: EnvironmentReadiness): { label: string; tone: "ok" | "info" | "warn" | "danger"; title: string } {
  const base = clusterBadge(r);
  const warnings = codedWarnings(r.warnings, r.warning_codes);
  if (warnings.length === 0 || base.tone === "danger") return base;
  const pullsWithPush = warnings.some((w) => w.code === PULL_USES_PUSH_LOGIN);
  return {
    label: pullsWithPush
      ? `${base.label} · pulls with the push login`
      : `${base.label} · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
    tone: "warn",
    title: [base.title, ...warnings.map(warningText)].join(" "),
  };
}

/** The environment warning the server gives while the cluster pulls with the
 *  login builds push with: it names no read-only pull connection. */
export const PULL_USES_PUSH_LOGIN = "PULL_USES_PUSH_LOGIN";

/** A warning the server said, with its code when it gave one. */
export interface CodedWarning {
  code: string | null;
  text: string;
}

/** `warnings` beside `codes`, matched by position: the server lists an
 *  environment's coded warnings first, so a plan's later, uncoded ones get
 *  none. */
export function codedWarnings(warnings: string[] | undefined, codes: string[] | undefined): CodedWarning[] {
  return (warnings ?? []).map((text, i) => ({ code: codes?.[i] ?? null, text }));
}

/** A coded warning as one line: `CODE: text`. */
export function warningText(w: CodedWarning): string {
  return w.code ? `${w.code}: ${w.text}` : w.text;
}

/** The cluster's own readiness, before the environment's warnings. */
function clusterBadge(r: EnvironmentReadiness): { label: string; tone: "ok" | "info" | "warn" | "danger"; title: string } {
  const detail = r.detail?.trim() ?? "";
  switch (r.level) {
    case "bootstrapped":
      return {
        label: "Bootstrapped",
        tone: "ok",
        title: [
          `The cluster has Studio's bootstrap${r.bootstrap_version ? ` ${r.bootstrap_version}` : ""}.`,
          r.policy_enforced ? "Its policy is enforced." : "Its policy is not enforced.",
          detail,
        ]
          .filter(Boolean)
          .join(" "),
      };
    case "namespace_limited":
      return {
        label: "Namespaces given",
        tone: "info",
        title: [
          r.namespaces.length
            ? `Studio may use only ${r.namespaces.join(", ")}, the namespaces the cluster gives.`
            : "Studio may not create namespaces, and the cluster gives none yet.",
          detail,
        ]
          .filter(Boolean)
          .join(" "),
      };
    case "partial":
      return {
        label: r.missing.length ? `Partial: lacks ${r.missing.join(", ")}` : "Partial",
        tone: "warn",
        title: [
          "Part of what Studio's bootstrap gives is missing: a cluster administrator applies deploy/k8s/studio-environments/bootstrap.yaml.",
          detail,
        ]
          .filter(Boolean)
          .join(" "),
      };
    default:
      return { label: "Unreachable", tone: "danger", title: detail || "The cluster did not answer." };
  }
}
