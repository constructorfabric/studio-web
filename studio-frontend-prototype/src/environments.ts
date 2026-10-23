/* Where an organization's products run (ADR-0043): the rules behind the
 * Environments screen and the product card's Deploy section, kept apart
 * from the React for their tests. The server checks all of these again;
 * here they say what is wrong before the form is sent. */

import type { Connection, DeployEnvironment, DeployEnvironmentInput, Deployment, DeploymentState } from "./api";

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
    connection_id: "",
    registry: "",
    registry_connection_id: null,
    namespace_pattern: DEFAULT_NAMESPACE_PATTERN,
    database: "none",
    database_image: null,
    protected: false,
    promote_from: null,
    projects: null,
  };
}

/** What a stored environment looks like as a form. */
export function environmentInput(e: DeployEnvironment): DeployEnvironmentInput {
  return {
    name: e.name,
    description: e.description,
    connection_id: e.connection_id,
    registry: e.registry,
    registry_connection_id: e.registry_connection_id ?? null,
    namespace_pattern: e.namespace_pattern,
    database: e.database,
    database_image: e.database_image ?? null,
    protected: e.protected,
    promote_from: e.promote_from ?? null,
    projects: e.projects ?? null,
  };
}

/** The fields of the environment form a problem can belong to. */
export type EnvironmentField = "name" | "connection_id" | "registry" | "registry_connection_id" | "namespace_pattern" | "projects";

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
    if (d.state !== "succeeded") continue;
    const key = `${d.project_id}/${d.environment_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
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
