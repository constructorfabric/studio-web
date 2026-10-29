/* ── The /architecture/ page's model: what Studio is, in the reader's terms ──
 *
 * Sources, each read from where it cannot drift:
 *
 *   - the manifest, `GET /cf/studio-assembly/v1/manifest` — the gears the
 *     backend process linked, with origin, role, purpose, toolkit
 *     dependencies and (newer backends) `uses`: which other Studio gear each
 *     one reaches and how (docs/design/studio-assembly.md);
 *   - `/cf/openapi.json` of the same backend — which REST paths each gear
 *     serves;
 *   - the tables below, kept by hand and held to the code by
 *     `architecture.test.ts`: which domain a gear belongs to, and which gears
 *     each thing a person can do in Studio calls.
 *
 * Everything here is pure, so it is tested without a backend.
 */

import { componentOf, componentTitle } from "./api-docs";
import type { OpenApiDoc } from "./api-docs";

/* ── The manifest ────────────────────────────────────────────────────────── */

/**
 * How one gear reaches another, worst way first:
 *
 *   - `port`     — the other gear's `port`/`sdk` module, the way it offers;
 *   - `surface`  — something the other gear's `mod.rs` re-exports at the top;
 *   - `internal` — one of its private modules: a boundary violation.
 */
export type Via = "port" | "surface" | "internal";

export interface GearUse {
  gear: string;
  via: Via | string;
  /** The modules or items of the other gear it names. */
  items?: string[];
}

export interface ManifestGear {
  name: string;
  origin: "studio" | "platform" | string;
  role: "system" | "plugin" | "gear" | string;
  extends?: string | null;
  depends_on: string[];
  capabilities: string[];
  order: number;
  purpose?: string | null;
  design_doc?: string | null;
  /** Absent on a backend older than the field: the page then says so. */
  uses?: GearUse[];
}

export interface Manifest {
  build: { commit?: string | null; features: string[] };
  sessions_enabled: boolean;
  session_image?: string | null;
  gears: ManifestGear[];
}

/** The part of `prototype-map.json` the page still reads: its build commit. */
export interface PrototypeMap {
  commit?: string | null;
}

/* ── Domains ─────────────────────────────────────────────────────────────── */

export type DomainId =
  | "specs"
  | "repos"
  | "people"
  | "ide"
  | "background"
  | "reporting"
  | "plumbing"
  | "other"
  | "platform";

export interface Domain {
  id: DomainId;
  title: string;
  /** One line: what the gears of this domain are for, together. */
  blurb: string;
  /** Studio gears, in reading order. */
  gears: string[];
}

/**
 * Studio's gears by what they are about. A gear missing here lands in
 * "Other" — a new gear never breaks the page, it only waits to be placed.
 */
export const DOMAINS: Domain[] = [
  {
    id: "specs",
    title: "Specs & product",
    blurb: "Specification documents, their quality and mapping to gears, a project's product and its gear repository, the component catalogue, kits and the domain model.",
    gears: [
      "studio-documents",
      "studio-spec-quality",
      "studio-spec-mapping",
      "studio-product",
      "studio-components-catalog",
      "studio-kits",
      "studio-domain-model",
      "studio-environments",
    ],
  },
  {
    id: "repos",
    title: "Repositories & artifacts",
    blurb: "Connections to GitHub, GitLab, chats and LLM vendors; syncing their issues, PRs and files into the artifact graph; the Git proxy.",
    gears: ["studio-connector", "studio-artifact-ingest", "studio-git"],
  },
  {
    id: "people",
    title: "People & organizations",
    blurb: "Users and their profiles, identities across providers, organizations, who is online, and who may do what.",
    gears: [
      "studio-user",
      "studio-identity-directory",
      "studio-organizations",
      "studio-presence",
      "studio-authz-plugin",
    ],
  },
  {
    id: "ide",
    title: "IDE sessions & AI",
    blurb: "Per-project Theia IDE containers, the bridge from the IDE back to Studio, and the LLM proxy the agents call.",
    gears: ["studio-session", "studio-theia", "studio-llm-proxy"],
  },
  {
    id: "background",
    title: "Background & delivery",
    blurb: "Durable background tasks, schedules, notifications and the event stream the portal listens to.",
    gears: ["studio-tasks", "studio-scheduler", "studio-notify", "studio-events"],
  },
  {
    id: "reporting",
    title: "Reporting",
    blurb: "Reports and the roadmap plan, Insight's trends over the synced history, and what usage costs an organization.",
    gears: ["studio-reports", "studio-insight", "studio-usage"],
  },
  {
    id: "plumbing",
    title: "Plumbing",
    blurb: "What keeps the process standing: this manifest, the Postgres secret store and the secrets seeded at start.",
    gears: ["studio-assembly", "studio-credstore-pg", "studio-secrets-bootstrap"],
  },
];

export const OTHER_DOMAIN: Domain = {
  id: "other",
  title: "Other",
  blurb: "Studio gears this page has not been taught to place yet.",
  gears: [],
};

export const PLATFORM_DOMAIN: Domain = {
  id: "platform",
  title: "Platform (gears-rust)",
  blurb: "The runtime Studio is assembled on: registries, the gateway, auth resolvers, accounts, storage and chat.",
  gears: [],
};

const DOMAIN_OF = new Map<string, DomainId>(DOMAINS.flatMap((d) => d.gears.map((g) => [g, d.id] as const)));

/** The domain of a gear. A Studio plugin sits with the gear it plugs into. */
export function domainOf(gear: Pick<ManifestGear, "name" | "origin" | "extends">): DomainId {
  const placed = DOMAIN_OF.get(gear.name);
  if (placed) return placed;
  if (gear.origin !== "studio") return "platform";
  const host = gear.extends ? DOMAIN_OF.get(gear.extends) : undefined;
  return host ?? "other";
}

export function domainById(id: DomainId): Domain {
  return DOMAINS.find((d) => d.id === id) ?? (id === "platform" ? PLATFORM_DOMAIN : OTHER_DOMAIN);
}

/** The platform's gears by what they do, so its layer reads as a few rows. */
export const PLATFORM_GROUPS: { title: string; gears: string[] }[] = [
  {
    title: "Runtime",
    gears: ["types-registry", "nodes-registry", "gear-orchestrator", "api-gateway", "grpc-hub", "event-broker"],
  },
  {
    title: "Sign-in & access",
    gears: ["authn-resolver", "authz-resolver", "tenant-resolver"],
  },
  {
    title: "Accounts & tenants",
    gears: ["account-management", "resource-group", "simple-user-settings"],
  },
  {
    title: "Storage",
    gears: ["credstore", "graph-storage", "file-storage"],
  },
  {
    title: "Chat & outbound calls",
    gears: ["mini-chat", "oagw", "model-registry"],
  },
];

/**
 * A platform plugin whose host the manifest could not name
 * (`keycloak-idp-plugin`, `single-tenant-tr-plugin`): its point, the word
 * before `-plugin`, says which row it belongs to.
 */
const PLUGIN_POINT_GROUP: Record<string, string> = {
  authn: "Sign-in & access",
  authz: "Sign-in & access",
  idp: "Sign-in & access",
  tr: "Sign-in & access",
  credstore: "Storage",
};

/** The row a platform gear sits in; a plugin sits with the gear it plugs into. */
export function platformGroupOf(gear: Pick<ManifestGear, "name" | "extends">): string {
  for (const key of [gear.name, gear.extends]) {
    const group = PLATFORM_GROUPS.find((g) => key && g.gears.includes(key));
    if (group) return group.title;
  }
  const point = gear.name.match(/-([a-z0-9]+)-plugin$/)?.[1];
  return (point && PLUGIN_POINT_GROUP[point]) || "Other platform gears";
}

export interface GroupedDomain {
  domain: Domain;
  /** Gears with work of their own, in the table's order, then by name. */
  gears: ManifestGear[];
  /** Plugins, by the gear they plug into. */
  plugins: Map<string, ManifestGear[]>;
}

/** Studio's linked gears by domain, in the table's order; empty domains dropped. */
export function groupStudio(gears: ManifestGear[]): GroupedDomain[] {
  const order = (g: ManifestGear) => {
    const domain = DOMAINS.find((d) => d.gears.includes(g.name));
    return domain ? domain.gears.indexOf(g.name) : Number.MAX_SAFE_INTEGER;
  };
  const out: GroupedDomain[] = [];
  for (const domain of [...DOMAINS, OTHER_DOMAIN]) {
    const members = gears.filter((g) => g.origin === "studio" && domainOf(g) === domain.id);
    if (members.length === 0) continue;
    const plugins = new Map<string, ManifestGear[]>();
    const own: ManifestGear[] = [];
    for (const g of members) {
      const host = g.role === "plugin" && g.extends && members.some((m) => m.name === g.extends) ? g.extends : null;
      if (host && !DOMAIN_OF.has(g.name)) {
        plugins.set(host, [...(plugins.get(host) ?? []), g]);
      } else {
        own.push(g);
      }
    }
    own.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    out.push({ domain, gears: own, plugins });
  }
  return out;
}

/** The platform's linked gears by row, in the table's order; plugins last in their row. */
export function groupPlatform(gears: ManifestGear[]): { title: string; gears: ManifestGear[] }[] {
  const titles = [...PLATFORM_GROUPS.map((g) => g.title), "Other platform gears"];
  return titles
    .map((title) => ({
      title,
      gears: gears
        .filter((g) => g.origin !== "studio" && platformGroupOf(g) === title)
        .sort(
          (a, b) =>
            Number(a.role === "plugin") - Number(b.role === "plugin") || a.order - b.order || a.name.localeCompare(b.name),
        ),
    }))
    .filter((row) => row.gears.length > 0);
}

/* ── Who uses whom ───────────────────────────────────────────────────────── */

export interface Edge {
  from: string;
  to: string;
  via: Via;
  items: string[];
}

const VIA_RANK: Record<Via, number> = { port: 0, surface: 1, internal: 2 };

/** A `via` this page does not know is read as `surface`: not the intended way, not proven a breach. */
export function normaliseVia(via: string): Via {
  return via === "port" || via === "internal" || via === "surface" ? via : "surface";
}

/** True when the backend reports `uses` at all (an older one does not). */
export function reportsUses(gears: ManifestGear[]): boolean {
  return gears.some((g) => Array.isArray(g.uses));
}

/** Every gear-to-gear use, one per pair (the worst `via` wins), self-uses dropped. */
export function edgesOf(gears: ManifestGear[]): Edge[] {
  const byPair = new Map<string, Edge>();
  for (const gear of gears) {
    for (const use of gear.uses ?? []) {
      if (!use || typeof use.gear !== "string" || use.gear === gear.name) continue;
      const key = `${gear.name}\u0000${use.gear}`;
      const via = normaliseVia(String(use.via));
      const items = [...new Set(use.items ?? [])];
      const known = byPair.get(key);
      if (!known) {
        byPair.set(key, { from: gear.name, to: use.gear, via, items: items.sort() });
        continue;
      }
      if (VIA_RANK[via] > VIA_RANK[known.via]) known.via = via;
      known.items = [...new Set([...known.items, ...items])].sort();
    }
  }
  return [...byPair.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export function edgeCounts(edges: Edge[]): Record<Via, number> & { total: number } {
  const out = { port: 0, surface: 0, internal: 0, total: edges.length };
  for (const e of edges) out[e.via] += 1;
  return out;
}

/** What `name` uses, worst first, then by name. */
/** One kind of event on the studio-events channel, as
 *  `GET /studio-events/v1/catalog` serves docs/events-catalog.md. */
export interface EventKind {
  kind: string;
  subject_type: string;
  publisher?: string | null;
  when: string;
  fields: string[];
}

/** The kinds `gear` publishes, by name. Unversioned: the compatibility
 *  ratchet (rule G4) keeps each one's payload from losing a field. */
export function eventsOf(catalog: EventKind[], gear: string): EventKind[] {
  return catalog.filter((k) => k.publisher === gear).sort((a, b) => a.kind.localeCompare(b.kind));
}

export function usesOf(edges: Edge[], name: string): Edge[] {
  return edges
    .filter((e) => e.from === name)
    .sort((a, b) => VIA_RANK[b.via] - VIA_RANK[a.via] || a.to.localeCompare(b.to));
}

/** Who uses `name`, worst first, then by name. */
export function usedBy(edges: Edge[], name: string): Edge[] {
  return edges
    .filter((e) => e.to === name)
    .sort((a, b) => VIA_RANK[b.via] - VIA_RANK[a.via] || a.from.localeCompare(b.from));
}

export interface Leak {
  /** The gear whose insides are reached. */
  gear: string;
  /** The gears reaching in. */
  users: string[];
  /** Each private module reached, with who reaches it; most-reached first. */
  modules: { item: string; users: string[] }[];
}

/** Boundary violations by the gear whose internals are used, worst first. */
export function leaks(edges: Edge[]): Leak[] {
  const byGear = new Map<string, Leak>();
  for (const e of edges) {
    if (e.via !== "internal") continue;
    const leak = byGear.get(e.to) ?? { gear: e.to, users: [], modules: [] };
    leak.users.push(e.from);
    for (const item of e.items.length ? e.items : ["(unnamed)"]) {
      const module = leak.modules.find((m) => m.item === item);
      if (module) module.users.push(e.from);
      else leak.modules.push({ item, users: [e.from] });
    }
    byGear.set(e.to, leak);
  }
  const out = [...byGear.values()];
  for (const leak of out) {
    leak.users.sort();
    for (const m of leak.modules) m.users.sort();
    leak.modules.sort((a, b) => b.users.length - a.users.length || a.item.localeCompare(b.item));
  }
  return out.sort((a, b) => b.users.length - a.users.length || a.gear.localeCompare(b.gear));
}

/** Per gear: how many it uses, how many use it, how many of those reach its internals. */
export function gearCounts(edges: Edge[], name: string): { uses: number; usedBy: number; reachedInto: number; reachesInto: number } {
  let uses = 0;
  let used = 0;
  let reachedInto = 0;
  let reachesInto = 0;
  for (const e of edges) {
    if (e.from === name) {
      uses += 1;
      if (e.via === "internal") reachesInto += 1;
    }
    if (e.to === name) {
      used += 1;
      if (e.via === "internal") reachedInto += 1;
    }
  }
  return { uses, usedBy: used, reachedInto, reachesInto };
}

/** Uses that cross from one domain to another, with how many are internal; busiest first. */
export function domainLinks(
  edges: Edge[],
  gears: ManifestGear[],
): { from: DomainId; to: DomainId; total: number; internal: number }[] {
  const byName = new Map(gears.map((g) => [g.name, g]));
  const out = new Map<string, { from: DomainId; to: DomainId; total: number; internal: number }>();
  for (const e of edges) {
    const a = byName.get(e.from);
    const b = byName.get(e.to);
    if (!a || !b) continue;
    const from = domainOf(a);
    const to = domainOf(b);
    if (from === to) continue;
    const key = `${from}>${to}`;
    const link = out.get(key) ?? { from, to, total: 0, internal: 0 };
    link.total += 1;
    if (e.via === "internal") link.internal += 1;
    out.set(key, link);
  }
  return [...out.values()].sort((a, b) => b.internal - a.internal || b.total - a.total);
}

/* ── What a person can do, and which gears do it ─────────────────────────── */

/**
 * REST component (a path's first segment; `api/file-storage` is one level
 * down) → the gear that serves it. Every component the prototype's sources
 * name must be here — `architecture.test.ts` reads them and fails on a new
 * one — so the map cannot silently miss a gear.
 */
export const COMPONENT_GEAR: Record<string, string> = {
  "account-management": "account-management",
  credstore: "credstore",
  "file-storage": "file-storage",
  "gear-orchestrator": "gear-orchestrator",
  "mini-chat": "mini-chat",
  oagw: "oagw",
  "resource-group": "resource-group",
  "types-registry": "types-registry",
  "studio-artifact-ingest": "studio-artifact-ingest",
  "studio-assembly": "studio-assembly",
  "studio-components-catalog": "studio-components-catalog",
  "studio-connector": "studio-connector",
  "studio-documents": "studio-documents",
  "studio-domain-model": "studio-domain-model",
  "studio-environments": "studio-environments",
  "studio-events": "studio-events",
  "studio-git": "studio-git",
  "studio-identity": "studio-identity-directory",
  "studio-insight": "studio-insight",
  "studio-kits": "studio-kits",
  "studio-llm": "studio-llm-proxy",
  "studio-notify": "studio-notify",
  "studio-organizations": "studio-organizations",
  "studio-presence": "studio-presence",
  "studio-product": "studio-product",
  "studio-reports": "studio-reports",
  "studio-scheduler": "studio-scheduler",
  "studio-session": "studio-session",
  "studio-spec-mapping": "studio-spec-mapping",
  "studio-spec-quality": "studio-spec-quality",
  "studio-tasks": "studio-tasks",
  "studio-usage": "studio-usage",
  "studio-theia": "studio-theia",
  "studio-user": "studio-user",
};

export type SurfaceArea = "portal" | "project" | "organization" | "admin" | "outside";

export const AREAS: { id: SurfaceArea; title: string }[] = [
  { id: "portal", title: "Everywhere in the portal" },
  { id: "project", title: "Inside a project" },
  { id: "organization", title: "Across the organization" },
  { id: "admin", title: "Administration" },
  { id: "outside", title: "Outside the browser portal" },
];

export interface Surface {
  id: string;
  area: SurfaceArea;
  title: string;
  /** What a person does there, in their words. */
  does: string;
  /** The gears it calls, sorted. */
  gears: string[];
  /**
   * Where that list comes from. For the portal: the prototype's React
   * components, whose calls the test reads and compares with `gears`. For the
   * IDE and the desktop app: their source files, named for the reader.
   */
  components?: string[];
  sources?: string[];
  /** Gears it runs inside of rather than calls (the IDE in studio-session's container). */
  hostedBy?: string[];
}

export const SURFACES: Surface[] = [
  {
    id: "shell",
    area: "portal",
    title: "Sign-in, navigation and notifications",
    does: "Sign in, switch organization and workspace, get notified, see who is online, open a project in the IDE or the desktop app.",
    components: ["App", "Login", "Shell", "ContextPane", "ChatNotifier", "EditorNotifier", "OpenInDesktop", "StudioLauncher", "WhoIsOnline", "OrgMark"],
    gears: [
      "account-management",
      "studio-connector",
      "studio-events",
      "studio-notify",
      "studio-organizations",
      "studio-presence",
      "studio-session",
      "studio-user",
    ],
  },
  {
    id: "home",
    area: "portal",
    title: "Home",
    does: "See your projects, running IDE sessions, and everything waiting on you — reviews asked of you and pull requests whose next step is yours — at a glance.",
    components: ["HomeView", "WaitingOnYou"],
    gears: [
      "gear-orchestrator",
      "studio-artifact-ingest",
      "studio-documents",
      "studio-events",
      "studio-session",
      "studio-user",
    ],
  },
  {
    id: "workspaces",
    area: "portal",
    title: "Workspaces and their projects",
    does: "Browse workspaces, create a project from a product, see the portfolio.",
    components: ["WorkspacesView", "WorkspaceProjects", "WorkspaceDashboard", "ProjectsPortfolio", "ProjectScreen"],
    gears: [
      "account-management",
      "studio-connector",
      "studio-documents",
      "studio-kits",
      "studio-organizations",
      "studio-product",
    ],
  },
  {
    id: "doc-types",
    area: "portal",
    title: "Document types and process",
    does: "Define document templates, section checklists and the journey's stages for a workspace.",
    components: ["DocumentTypesTab", "ProcessCatalogTab", "TypesView"],
    gears: ["studio-documents", "studio-spec-quality"],
  },
  {
    id: "project-types",
    area: "portal",
    title: "Project types",
    does: "Decide which kinds of project an organization or a workspace offers, what each creates and which tabs its projects show.",
    components: ["ProjectTypesTab"],
    gears: ["account-management", "studio-kits"],
  },
  {
    id: "project-overview",
    area: "project",
    title: "Overview",
    does: "See a project's state and its path to a product that builds: specs, components, pull requests waiting on people, its IDE.",
    components: ["ProjectOverview", "ProjectPath", "PullRequestsWaiting"],
    gears: [
      "account-management",
      "studio-artifact-ingest",
      "studio-connector",
      "studio-documents",
      "studio-kits",
      "studio-product",
      "studio-session",
    ],
  },
  {
    id: "project-specs",
    area: "project",
    title: "Specs",
    does: "Read and publish specifications, see their quality findings and how they map to gears.",
    components: [
      "DocumentsTab",
      "IngestedDocumentsView",
      "ReviewPanel",
      "DomainQuestionsPanel",
      "BriefPanel",
      "RemarksPanel",
      "PullRequestChecksPanel",
      "SpecQuality",
      "SqStatusChip",
      "PublishModal",
      "SeedModal",
      "RepoTargetFields",
      "ScaffoldModal",
    ],
    gears: [
      "account-management",
      "studio-artifact-ingest",
      "studio-connector",
      "studio-documents",
      "studio-events",
      "studio-product",
      "studio-spec-mapping",
      "studio-spec-quality",
      "studio-user",
    ],
  },
  {
    id: "project-domain-model",
    area: "project",
    title: "Domain model",
    does: "The application the specs describe, read out of them fact by fact, where they disagree about it, and what they ask for that the code is not made of; the project's Issues tab is the same component, opening an issue for a person to take. Its installed kits are asked which hypothesis check methods they add.",
    components: ["SpecModelTab"],
    gears: ["studio-documents", "studio-kits", "studio-product", "studio-spec-mapping", "studio-user"],
  },
  {
    id: "project-components",
    area: "project",
    title: "Components and kits",
    does: "Pick the gears a product is built from, compare the spec with the code, install kits.",
    components: [
      "ProjectKits",
      "SuggestedComponents",
      "BringsWithIt",
      "BeyondGears",
      "ProductCard",
      "GearConfigForm",
      "ProjectCandidate",
      "ProductConfigurator",
      "ProjectComponentsInventory",
      "Explanation",
      "ExplainAll",
    ],
    gears: [
      "studio-components-catalog",
      "studio-documents",
      "studio-environments",
      "studio-kits",
      "studio-product",
      "studio-spec-mapping",
    ],
  },
  {
    id: "project-frontend",
    area: "project",
    title: "Product: its header, Infrastructure and Frontend",
    does: "See the product in one line (profile, gears, where it was saved, whether it resolves, whether it has a frontend) and switch between its parts; see where it runs (its profile, environments and their databases); add a frontend from FrontX's shell template, or leave the product gears alone; compose the UI from micro-frontends in the shell, see whether the product has the gears each screen calls, read the project's own repository into the catalogue when it has no micro-frontend, and find FrontX's templates to start a new one.",
    components: ["FrontendConstructor", "ProductFrontend", "ProductInfrastructure", "ProductPage"],
    gears: ["account-management", "studio-artifact-ingest", "studio-components-catalog", "studio-environments", "studio-product"],
  },
  {
    id: "project-builds",
    area: "project",
    title: "Builds",
    does: "Build the composed product and publish it: in Studio as a Job in the organization's cluster, on the member's machine in the desktop IDE, or by proposing a CI workflow; follow each build's stages (prepare, images, publish) and read the end of each step's log from its pod, a failed one with its first error, a published one with its images and chart; deploy a published build to an environment; and read the CI runs of the project's repositories.",
    components: ["ProjectBuilds", "BuildInStudio", "BuildLogPanel", "InCi", "ProposeBuildWorkflow", "DeployBuildTo"],
    gears: ["account-management", "studio-artifact-ingest", "studio-environments", "studio-product"],
  },
  {
    id: "project-tests",
    area: "project",
    title: "Tests",
    does: "See whether what the project built works: the mainline's CI and its 7-day pass rate, each open pull request's CI and document checks, the CI runs of the last two weeks with the job and step that failed; and how much of what the specs declare the code answers, which opens Specs.",
    components: ["ProjectTests"],
    gears: ["studio-artifact-ingest", "studio-documents", "studio-spec-mapping"],
  },
  {
    id: "project-deploys",
    area: "project",
    title: "Deploys",
    does: "See where the project's product runs and run it there: each environment it may deploy to, its namespace and registry, the last deploy; deploy a build the Builds tab, a pipeline or the IDE published, roll back, uninstall; set the release's chart values and secrets per environment; bind the product's kubernetes profiles and read the deploy history.",
    components: [
      "ProjectDeploys",
      "ProjectEnvironments",
      "StatusButton",
      "EnvironmentActions",
      "EnvironmentConfig",
    ],
    gears: ["studio-artifact-ingest", "studio-environments"],
  },
  {
    id: "project-artifacts",
    area: "project",
    title: "Artifacts",
    does: "Take what the project produced: the files its CI builds kept, under the build, and its releases, downloaded straight from the provider; see the repository documents Studio has typed and the files kept in Studio, and add one.",
    components: ["ProjectOutputs", "ProjectFiles"],
    gears: ["file-storage", "studio-artifact-ingest"],
  },
  {
    id: "project-sources",
    area: "project",
    title: "Sources",
    does: "Attach repositories, choose how shared edits land, run a sync.",
    components: ["ProjectSources", "RepoBrowser", "SourceAttachPicker"],
    gears: [
      "account-management",
      "studio-artifact-ingest",
      "studio-connector",
      "studio-documents",
      "studio-events",
    ],
  },
  {
    id: "project-activity",
    area: "project",
    title: "Activity",
    does: "Follow what happened in the project's repositories.",
    components: ["ActivityView"],
    gears: ["studio-artifact-ingest"],
  },
  {
    id: "project-team",
    area: "project",
    title: "Team and automation",
    does: "See who works on the project; set its automation.",
    components: ["PeopleView", "AutomationSettings"],
    gears: ["account-management", "studio-organizations", "studio-user"],
  },
  {
    id: "publication-requests",
    area: "organization",
    title: "Publication requests",
    does: "Answer the organizations' requests to give a gear to the platform: preview and publish it as a pull request into the platform's gear repository, or decline it; name the platform's gear curators.",
    components: ["PublicationRequests", "Curators"],
    gears: ["studio-components-catalog", "studio-user"],
  },
  {
    id: "platform-sources",
    area: "organization",
    title: "Platform repositories",
    does: "One row per repository the platform's components come from, with its two roles: listed in the catalogue (synced into Components) and built from (the Gearbox engine's corpus). A platform administrator lists or unlists one, adds a gear repository (tested first) or removes it, and keeps the catalogue's settings and sync below.",
    components: ["GearSources", "AddGearRepository"],
    gears: ["studio-components-catalog", "studio-connector", "studio-product"],
  },
  {
    id: "org-sources",
    area: "organization",
    title: "Organization component repositories",
    does: "Components > Repositories: list the organization's own gear repositories, read after the platform's in its corpus (ADR-0046 phase 3): add or remove one, see what the engine read, and pick the one Create a gear writes into.",
    components: ["OrgSources", "GearSources", "AddGearRepository", "CreateGearRepository"],
    gears: ["studio-components-catalog", "studio-connector", "studio-product"],
  },
  {
    id: "organization-dashboard",
    area: "organization",
    title: "Organization overview",
    does: "Open the organization from the path and see what needs its leaders: refused connections, spend against the same days last month with a month-end forecast, pull requests stuck over 7 days and who they wait on, components to decide; its workspaces worst first, down to projects; and where the money goes.",
    components: ["OrgDashboard"],
    gears: ["studio-organizations"],
  },
  {
    id: "costs",
    area: "organization",
    title: "Costs",
    does: "See what the organization's model calls and IDE sessions cost over a period -- by project, person, model, source or who paid, with or without people's own keys -- set monthly budgets that warn when this month's spend or its forecast nears or passes them, and keep the price list they are priced with.",
    components: ["OrgBudgets", "OrgCosts"],
    gears: ["studio-usage"],
  },
  {
    id: "environments",
    area: "organization",
    title: "Environments",
    does: "Declare where the organization's products run -- a cluster connection, a registry, a namespace per project, or a Constructor Research project and its hardware; approval for protected ones -- approve deploys, and see what runs where.",
    components: ["OrgEnvironments", "EnvironmentForm", "ResearchFields", "AddCluster", "AddRegistry"],
    gears: ["account-management", "studio-connector", "studio-environments"],
  },
  {
    id: "connections",
    area: "organization",
    title: "Connections",
    does: "Connect GitHub, GitLab, chats, LLM vendors and clusters once for the whole organization, sign in to Constructor Research, and see which environments use each cluster.",
    components: ["ConnectorsView", "ConnectionList", "AddConnector", "EditConnection", "SignInCallback"],
    gears: ["studio-connector", "studio-environments"],
  },
  {
    id: "components-catalog",
    area: "organization",
    title: "Components catalogue",
    does: "Browse every gear a product can be built from, with its profile and documentation.",
    components: ["ComponentsCatalog", "ComponentRegistry", "RegistryDecisions", "DeclareCandidate", "SuggestDescription", "ExtractReadiness", "GearDetail", "ProfileEditor", "PlatformSourcesPanel"],
    gears: ["studio-components-catalog", "studio-connector", "studio-kits", "studio-user"],
  },
  {
    id: "reports",
    area: "organization",
    title: "Reports and the roadmap",
    does: "Run reports, edit the roadmap plan and read it against people and projects.",
    components: ["ReportsScreen", "ReportCard", "PlanEditor", "RoadmapReportBody", "RoadmapReportDialog"],
    gears: ["studio-connector", "studio-reports", "studio-tasks", "studio-user"],
  },
  {
    id: "domain-model",
    area: "organization",
    title: "Objects and views",
    does: "Explore the domain model: object types, their relations, saved views.",
    components: ["ObjectTypes", "ViewsScreen", "ViewGraph", "ViewTable", "DomainModelGraph"],
    gears: ["studio-components-catalog", "studio-domain-model", "types-registry"],
  },
  {
    id: "background-work",
    area: "organization",
    title: "Background work",
    does: "Watch syncs, analyses and scheduled jobs run, and retry the ones that failed.",
    components: ["BackgroundWork"],
    gears: ["studio-events", "studio-scheduler", "studio-tasks"],
  },
  {
    id: "people",
    area: "organization",
    title: "People and your profile",
    does: "Find colleagues, edit your profile and view preferences, see the logins and accounts that are you, keep your AI keys.",
    components: ["MyPersonCard", "MyIdentitiesCard", "MemberDirectoryForm", "ViewModePreferences", "AiKeysCard"],
    gears: ["credstore", "studio-user"],
  },
  {
    id: "chats-files",
    area: "organization",
    title: "Chats, files and Studio AI",
    does: "Talk to the assistant, keep chat history, upload files.",
    components: ["ChatsView", "FilterPanel", "StudioAI", "FilesView"],
    gears: ["file-storage", "mini-chat"],
  },
  {
    id: "admin",
    area: "admin",
    title: "Organizations, members and access",
    does: "Manage organizations and their logos, members and their identities, roles, integrations and secrets.",
    components: [
      "OrganizationsView",
      "AccessView",
      "SecretsView",
      "OrgMembersView",
      "IdentityDirectory",
      "OrganizationsTable",
      "MemberIdentitiesPanel",
      "LogoControl",
    ],
    gears: [
      "account-management",
      "credstore",
      "resource-group",
      "studio-connector",
      "studio-identity-directory",
      "studio-organizations",
      "studio-user",
    ],
  },
  {
    id: "system",
    area: "admin",
    title: "System and architecture",
    does: "Inspect the running platform: registries, outbound gateway, the domain model, and this page.",
    components: ["SystemView", "ArchitecturePage", "FlowDoors"],
    gears: [
      "gear-orchestrator",
      "oagw",
      "studio-assembly",
      "studio-connector",
      "studio-domain-model",
      "studio-events",
      "types-registry",
    ],
  },
  {
    id: "ide",
    area: "outside",
    title: "IDE session (Theia in the browser)",
    does: "Edit specs in a per-project IDE: quality findings beside the text, the artifact graph, AI agents, sharing edits back.",
    sources: ["theia/studio/src/browser/", "theia/studio/src/node/"],
    hostedBy: ["studio-session"],
    gears: [
      "account-management",
      "mini-chat",
      "studio-artifact-ingest",
      "studio-components-catalog",
      "studio-connector",
      "studio-documents",
      "studio-llm-proxy",
      "studio-presence",
      "studio-reports",
      "studio-session",
      "studio-spec-quality",
      "studio-tasks",
      "studio-theia",
    ],
  },
  {
    id: "desktop",
    area: "outside",
    title: "Desktop app (Electron)",
    does: "Everything the IDE does, on your machine — plus your projects and kits from Studio, the gear catalogue for Gearbox, Git through Studio's proxy, a lease on a session, and the builds Build and Run report.",
    sources: ["theia/studio/src/{browser,node}/desktop-*.ts", "theia/studio/src/browser/gearbox-*.ts"],
    gears: [
      "account-management",
      "studio-artifact-ingest",
      "studio-components-catalog",
      "studio-environments",
      "studio-git",
      "studio-kits",
      "studio-organizations",
      "studio-product",
      "studio-session",
      "studio-user",
    ],
  },
];

/** The REST components named in a source text: `/studio-tasks/v1…` → `studio-tasks`. */
export function restComponentsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/["'`]\/(?:cf\/)?(?:(api)\/)?([a-z][a-z0-9-]*)\/v\d+\b/g)) found.add(m[2]);
  return [...found].sort();
}

/** The gear behind each REST component of `paths` (unknown components are left out). */
export function gearsOfPaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const gear = COMPONENT_GEAR[componentOf(path)];
    if (gear) out.add(gear);
  }
  return [...out].sort();
}

/** The surfaces that call `gear`. */
export function surfacesOf(gear: string, surfaces: Surface[] = SURFACES): Surface[] {
  return surfaces.filter((s) => s.gears.includes(gear));
}

/** How many surfaces call each gear. */
export function surfaceCounts(surfaces: Surface[] = SURFACES): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of surfaces) for (const g of s.gears) out.set(g, (out.get(g) ?? 0) + 1);
  return out;
}

/* ── REST surface (from /cf/openapi.json) ────────────────────────────────── */

export interface RestSurface {
  /** `/studio-tasks/v1`, … — the distinct `/<segment>/<version>` heads. */
  prefixes: string[];
  /** The `componentOf` value /api-docs/ filters on. */
  component: string;
  operations: number;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * The gear that serves a path: the one named by the path's first segment
 * (rule A1), else the table above, else the one gear whose name starts with
 * that segment. Two such gears, or none, and the path is nobody's.
 */
export function pathOwner(path: string, gearNames: string[]): string | null {
  const component = componentOf(path);
  if (!component) return null;
  if (gearNames.includes(component)) return component;
  const mapped = COMPONENT_GEAR[component];
  if (mapped && gearNames.includes(mapped)) return mapped;
  const candidates = gearNames.filter((n) => n.startsWith(`${component}-`));
  return candidates.length === 1 ? candidates[0] : null;
}

/** Each gear's REST surface, read off the OpenAPI document. */
export function restSurfaces(doc: OpenApiDoc, gearNames: string[]): Map<string, RestSurface> {
  const byGear = new Map<string, RestSurface>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const owner = pathOwner(path, gearNames);
    if (!owner) continue;
    const parts = path.split("/").filter(Boolean);
    const mounted = parts[0] === "api" ? 1 : 0;
    const head = "/" + parts.slice(0, mounted + 2).join("/");
    const surface = byGear.get(owner) ?? { prefixes: [], component: componentOf(path), operations: 0 };
    if (!surface.prefixes.includes(head)) surface.prefixes.push(head);
    for (const method of METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (op && typeof op === "object") surface.operations += 1;
    }
    byGear.set(owner, surface);
  }
  for (const surface of byGear.values()) surface.prefixes.sort();
  return byGear;
}

/* ── Words ───────────────────────────────────────────────────────────────── */

/** A toolkit capability, said plainly. */
export function capabilityWords(capability: string): string {
  switch (capability) {
    case "rest":
      return "serves a REST API";
    case "db":
      return "owns tables in Postgres";
    case "stateful":
      return "runs work of its own between requests (workers, timers, connections)";
    case "system":
      return "part of the platform runtime, started before everything else";
    default:
      return capability;
  }
}

export const VIA_WORDS: Record<Via, { label: string; says: string }> = {
  port: { label: "port", says: "through its port — the way it offers" },
  surface: { label: "surface", says: "through what its module exports at the top" },
  internal: { label: "internal", says: "into a private module — a boundary violation" },
};

/** The repository the design documents and commits live in. */
export const REPOSITORY = "https://github.com/constructorfabric/studio-web";

/** A design document at the commit the backend was built from (main for a local build). */
export function designDocUrl(path: string, commit?: string | null): string {
  return `${REPOSITORY}/blob/${commit || "main"}/${path}`;
}

export function commitUrl(commit: string): string {
  return `${REPOSITORY}/commit/${commit}`;
}

/** The /api-docs/ page narrowed to one gear's paths. */
export function apiDocsUrl(component: string): string {
  return `/api-docs/?component=${encodeURIComponent(component)}`;
}

/** `studio-artifact-ingest` → `Artifact Ingest`. */
export function gearTitle(name: string): string {
  return componentTitle(name);
}

/** True when both commits are known and they are not the same build. */
export function commitsDiffer(backend?: string | null, prototype?: string | null): boolean {
  return Boolean(backend && prototype && backend !== prototype);
}

/** A short commit for display. */
export function shortCommit(commit?: string | null): string {
  return commit ? commit.slice(0, 10) : "local build";
}

/** The counts the header states. */
export function summary(gears: ManifestGear[]): {
  total: number;
  studio: number;
  platform: number;
  connectorPlugins: number;
  domains: number;
} {
  const studio = gears.filter((g) => g.origin === "studio");
  const connectorPlugins = studio.filter((g) => g.role === "plugin" && !DOMAIN_OF.has(g.name)).length;
  return {
    total: gears.length,
    studio: studio.length - connectorPlugins,
    platform: gears.length - studio.length,
    connectorPlugins,
    domains: groupStudio(gears).length,
  };
}
