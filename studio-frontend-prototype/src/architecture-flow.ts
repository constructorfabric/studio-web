/* ── The /architecture/ page's block diagram: from specs to a running product ──
 *
 * Where each part of Studio runs, and the path one application takes through
 * them: sign in, open a project, write and check its specs, pick its gears,
 * write the code with agents, build, deploy into a cluster, verify, monitor.
 *
 * Kept by hand, from the chart (deploy/helm/studio-web), the ADRs and the gear
 * READMEs; `architecture-flow.test.ts` holds every gear named here to the
 * domain table in `architecture.ts`, so a renamed gear fails the build instead
 * of drawing a stale box. What is not built is said so (`state`, `gap`) —
 * the page draws today's Studio, not the plan.
 *
 * Pure, so it is tested without a backend.
 */

/** Built — works today; partial — works with a stated limit; gap — Studio does not do it yet. */
export type FlowState = "built" | "partial" | "gap";

export interface FlowNode {
  id: string;
  title: string;
  /** One line: what it is and where exactly it runs. */
  detail: string;
  /** Studio gears that are this box, when it is part of the backend. */
  gears?: string[];
}

export interface FlowZone {
  id: "people" | "studio" | "repos" | "target" | "monitoring" | "outside";
  title: string;
  /** Where the zone is: a cluster and namespace, a provider, a vendor. */
  where: string;
  nodes: FlowNode[];
}

export const FLOW_ZONES: FlowZone[] = [
  {
    id: "people",
    title: "People",
    where: "a browser, or the desktop app on their machine",
    nodes: [
      {
        id: "browser",
        title: "Portal in the browser",
        detail: "two portals on their own hosts: FrontX, and this prototype",
      },
      {
        id: "desktop",
        title: "Desktop Studio",
        detail: "the same IDE as an Electron app; opened from the portal by a cfstudio:// link, no container",
      },
    ],
  },
  {
    id: "studio",
    title: "Studio",
    where: "Kubernetes cluster webstudio, namespace studio-dev (studio-test the same)",
    nodes: [
      {
        id: "ingress",
        title: "Ingress",
        detail: "one host: /cf → backend, /auth → Keycloak, / → the portal",
      },
      {
        id: "portal",
        title: "Portal servers",
        detail: "nginx serving FrontX and the prototype, two pods each on dev",
      },
      {
        id: "keycloak",
        title: "Keycloak",
        detail: "realm studio: sign-in with GitHub, Google, Microsoft; gives identity, not membership",
      },
      {
        id: "backend",
        title: "Backend",
        detail: "one Rust process: Studio's gears on the platform's (gears-rust); one replica",
      },
      {
        id: "sessions",
        title: "IDE sessions",
        detail: "one Theia pod per workspace, made by the backend; Claude Code, Codex and the gearbox CLI inside; reaped after 15 min idle",
        gears: ["studio-session", "studio-theia"],
      },
      {
        id: "postgres",
        title: "Postgres",
        detail: "one CloudNativePG cluster (PG 19 + pgvector): every gear's database, the artifact graph, Keycloak",
      },
      {
        id: "volumes",
        title: "Backend volumes",
        detail: "artifact-clones (8Gi): shallow clones the sync reads; gearbox (4Gi): the gear corpus",
      },
      {
        id: "s3",
        title: "File storage",
        detail: "S3 bucket dev-webstudio on Virtuozzo, through the file-storage sidecar: the bytes of build outputs; the graph keeps a reference",
      },
    ],
  },
  {
    id: "repos",
    title: "Git hosts & CI",
    where: "the product's own repositories: GitHub, GitLab or Bitbucket",
    nodes: [
      {
        id: "repo",
        title: "Product repository",
        detail: "specs, product.gdl and the code; listed in the project's sources",
      },
      {
        id: "ci",
        title: "CI",
        detail: "the repository's own workflows (GitHub Actions) build and test; Studio never builds",
      },
      {
        id: "registry",
        title: "Image registry",
        detail: "where CI pushes the product's images; the environment names it",
      },
    ],
  },
  {
    id: "target",
    title: "Organization's cluster",
    where: "a Kubernetes cluster the organization connects; not Studio's",
    nodes: [
      {
        id: "env",
        title: "Environment",
        detail: "a namespace {project}-{environment} and a Helm release per product; a protected one needs approval",
      },
    ],
  },
  {
    id: "monitoring",
    title: "Monitoring",
    where: "cluster webstudio, namespace studio-monitoring — watches Studio itself",
    nodes: [
      {
        id: "metrics",
        title: "VictoriaMetrics",
        detail: "metrics from the pods and the backend's OTLP, kept 30 days; no tracing yet",
      },
      {
        id: "grafana",
        title: "Grafana",
        detail: "resources, edge, Postgres and product dashboards; five alerts to Discord",
      },
    ],
  },
  {
    id: "outside",
    title: "Other services",
    where: "reached from the backend, each through a connection or a key",
    nodes: [
      {
        id: "llm",
        title: "LLM vendors",
        detail: "Anthropic, OpenAI: every call through the LLM proxy, on the person's own key",
      },
      {
        id: "detector",
        title: "Spec quality detector",
        detail: "the external API that finds problems in a specification",
      },
      {
        id: "corpus",
        title: "Gear corpus",
        detail: "gears-rust and crates.io: the catalogue Gearbox resolves a product against",
      },
      {
        id: "insight",
        title: "Constructor Insight",
        detail: "its warehouse, read for trends over a project's history",
      },
      {
        id: "chats",
        title: "Chats",
        detail: "Slack, Discord, Zulip: where notifications go",
      },
    ],
  },
];

export interface FlowStep {
  id: string;
  title: string;
  /** What happens, in one or two sentences, naming where it runs. */
  does: string;
  /** The boxes it passes through, in order. */
  nodes: string[];
  /** The Studio gears that do the work. */
  gears: string[];
  state: FlowState;
  /** What is missing, when the step is partial or a gap. */
  gap?: string;
}

export const FLOW_STEPS: FlowStep[] = [
  {
    id: "sign-in",
    title: "Sign in and pick an organization",
    does: "Keycloak says who you are; Studio's own membership says which organizations you are in and with what role.",
    nodes: ["browser", "ingress", "portal", "keycloak", "backend", "postgres"],
    gears: ["studio-user", "studio-organizations", "studio-authz-plugin"],
    state: "built",
  },
  {
    id: "project",
    title: "Create a project and connect its repository",
    does: "The project lives in a workspace of the organization. Its repositories come in through a connection; the backend clones them to its volume and syncs files, issues, PRs and CI runs into the artifact graph.",
    nodes: ["browser", "backend", "repo", "volumes", "postgres"],
    gears: ["studio-organizations", "studio-connector", "studio-artifact-ingest"],
    state: "built",
  },
  {
    id: "ide",
    title: "Open the project in the IDE",
    does: "The backend starts one Theia pod for the workspace (or leases a desktop session) and proxies the browser to it. The pod clones the sources; git goes through the backend's Git proxy.",
    nodes: ["browser", "desktop", "backend", "sessions", "repo"],
    gears: ["studio-session", "studio-theia", "studio-git", "studio-kits"],
    state: "built",
  },
  {
    id: "write",
    title: "Write the specs together",
    does: "People share one session, each in a git worktree of their own; the editor shows who is in a document and who wrote each save. Share with the team commits to a branch or opens a pull request.",
    nodes: ["sessions", "backend", "repo"],
    gears: ["studio-documents", "studio-presence", "studio-events", "studio-connector"],
    state: "partial",
    gap: "No live co-editing (no CRDT): two people editing at once meet at save time.",
  },
  {
    id: "check",
    title: "Check the specs",
    does: "Every sync sends the documents to the quality detector; its findings land in the graph and show in the Specs list and the IDE. Review requests and approvals move a document on.",
    nodes: ["backend", "detector", "postgres"],
    gears: ["studio-spec-quality", "studio-artifact-ingest", "studio-documents"],
    state: "built",
  },
  {
    id: "model",
    title: "Turn specs into a domain model and gears",
    does: "The domain model is read out of the specs; each requirement is mapped to candidate gears from the catalogue, and members decide. The product's gears are written to product.gdl and resolved by Gearbox against the corpus.",
    nodes: ["backend", "corpus", "volumes", "repo"],
    gears: ["studio-domain-model", "studio-spec-mapping", "studio-components-catalog", "studio-product"],
    state: "built",
  },
  {
    id: "code",
    title: "Generate and write the code with agents",
    does: "In the IDE, Gearbox generates the product from product.gdl and agents (Claude Code, Codex) write the rest. Their model calls go through the LLM proxy and are metered for the organization.",
    nodes: ["sessions", "llm", "repo"],
    gears: ["studio-llm-proxy", "studio-git", "studio-theia", "studio-usage"],
    state: "built",
  },
  {
    id: "build",
    title: "Build",
    does: "The product's own CI builds and pushes images; Studio can start its workflow and reads the runs back on each sync. A build in the IDE reports itself to the backend; its outputs are kept in file storage.",
    nodes: ["ci", "registry", "backend", "s3"],
    gears: ["studio-artifact-ingest"],
    state: "built",
  },
  {
    id: "deploy",
    title: "Deploy into a cluster",
    does: "The backend runs helm upgrade --install on the organization's cluster, into the environment's namespace, as a durable task; the deployment's status lists its workloads and hosts.",
    nodes: ["backend", "env", "registry"],
    gears: ["studio-environments", "studio-connector", "studio-tasks"],
    state: "partial",
    gap: "Started from the IDE's Generate view; deploying a CI build from the portal, and databases and config from the environment, are not built.",
  },
  {
    id: "verify",
    title: "Verify the result",
    does: "The Tests tab lists the CI jobs and where they failed; the deployment's status says what rolled out; spec↔code links and delivery stages say what each requirement reached.",
    nodes: ["ci", "env", "backend"],
    gears: ["studio-artifact-ingest", "studio-environments", "studio-documents"],
    state: "partial",
    gap: "A test is a CI job: no test reports, no end-to-end check of the deployed product.",
  },
  {
    id: "monitor",
    title: "Monitor",
    does: "Studio watches itself (metrics, dashboards, alerts) and what it costs an organization (model calls, sessions, budgets); Insight shows trends over the project's history.",
    nodes: ["metrics", "grafana", "backend", "insight", "chats"],
    gears: ["studio-usage", "studio-insight", "studio-reports", "studio-notify"],
    state: "gap",
    gap: "Nothing watches the deployed product: its metrics and logs stay on the organization's cluster.",
  },
];

export const FLOW_STATE_WORDS: Record<FlowState, string> = {
  built: "works today",
  partial: "works, with a limit",
  gap: "not built",
};

/** How another platform can use Studio, and Studio another platform. */
export interface FlowDoor {
  id: string;
  title: string;
  /** What it gives, and the path to read it from. */
  gives: string;
  paths: string[];
  state: FlowState;
}

export const FLOW_DOORS: FlowDoor[] = [
  {
    id: "rest",
    title: "REST API, described",
    gives: "Everything the portal does, with an OpenAPI document per gear.",
    paths: ["/cf/openapi.json", "/cf/docs"],
    state: "built",
  },
  {
    id: "manifest",
    title: "Backend map",
    gives: "The gears running right now, what each is for and who uses whom — what this page draws.",
    paths: ["/cf/studio-assembly/v1/manifest", "/architecture/prototype-map.json"],
    state: "built",
  },
  {
    id: "domain",
    title: "Domain model",
    gives: "The entities and relations read out of a project's specs: queried by type, changed in one batch.",
    paths: ["/cf/studio-domain-model/v1/query", "/cf/studio-domain-model/v1/mutate"],
    state: "built",
  },
  {
    id: "events",
    title: "Event stream",
    gives: "What happens, as it happens: task runs, IDE sessions, review requests; with replay from a cursor.",
    paths: ["/cf/studio-events/v1/catalog"],
    state: "built",
  },
  {
    id: "connector",
    title: "A connector of its own",
    gives: "Studio reaching into another platform — a plugin gear beside GitHub, GitLab, Kubernetes, Slack.",
    paths: ["studio-backend/src/connectors/README.md"],
    state: "built",
  },
  {
    id: "push",
    title: "Webhooks in, a public MCP server",
    gives: "Another platform telling Studio something, or an agent outside Studio calling it as tools.",
    paths: [],
    state: "gap",
  },
];

/** A platform like Research would read the same doors; nothing of this is built. */
export const RESEARCH_PROPOSAL: { title: string; reads: string; door: string }[] = [
  {
    title: "Map of the application",
    reads: "the screens and the gears each calls",
    door: "manifest",
  },
  {
    title: "Map of the backend",
    reads: "gears, their uses and their REST paths",
    door: "rest",
  },
  {
    title: "Schemes of the domain",
    reads: "entities and relations of a project",
    door: "domain",
  },
  {
    title: "Kept current, interactive",
    reads: "the event stream; links into this page by #gear= and #step=",
    door: "events",
  },
];

/* ── Selection ── */

export function stepById(id: string): FlowStep | undefined {
  return FLOW_STEPS.find((s) => s.id === id);
}

export function nodeById(id: string): FlowNode | undefined {
  for (const zone of FLOW_ZONES) {
    const node = zone.nodes.find((n) => n.id === id);
    if (node) return node;
  }
  return undefined;
}

/** The steps that pass through a box, numbered from 1 in reading order. */
export function stepsThrough(nodeId: string): number[] {
  const out: number[] = [];
  FLOW_STEPS.forEach((s, i) => {
    if (s.nodes.includes(nodeId)) out.push(i + 1);
  });
  return out;
}

/** Every gear the diagram names: the box gears and the step gears. */
export function flowGears(): string[] {
  const names = new Set<string>();
  for (const zone of FLOW_ZONES) for (const node of zone.nodes) for (const g of node.gears ?? []) names.add(g);
  for (const step of FLOW_STEPS) for (const g of step.gears) names.add(g);
  return [...names];
}
