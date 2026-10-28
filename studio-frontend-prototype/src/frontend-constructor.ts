/* ── The frontend constructor's model (ADR-0050) ──────────────────────────────
 *
 * A product's frontend is a FrontX shell with micro-frontends mounted in it.
 * The catalogue already lists every FrontX package; a sync now also records,
 * for a micro-frontend, where it shows in the shell (its `mfe.json`
 * extensions) and which gears its API services call (`/cf/<gear>/v1`). This
 * module turns those into what the constructor draws: the shell's zones with
 * the screens the picked packages bring, and whether the product has the
 * gears they call.
 *
 * Pure, so it is tested without a backend.
 */

import type { CatalogNode, CatalogRepoSource } from "./api";

export const FRONTX_NODE_TYPE = "gts.cf.studio.catalog.frontx.v1~";

/** FrontX's own templates: `template-mfe` carries a blank micro-frontend, a
 *  demo and two widget fixtures, each with an `mfe.json`. The catalogue reads
 *  them as templates and examples, not as screens a product mounts, so the
 *  constructor offers them as where a new micro-frontend starts; the
 *  micro-frontends a product adds come from a repository that has real ones
 *  (the project's own, see `frontxSuggestion`). */
export const SUGGESTED_FRONTX_SOURCE = {
  repo: "constructorfabric/gears-frontx-templates",
  git_ref: "main",
  mode: "frontx",
} as const;

/** The nil tenant: in an organization's source it stands for the
 *  organization itself, whose GitHub connection the sync reads through. */
const ORG_TENANT = "00000000-0000-0000-0000-000000000000";

const repoKey = (repo: string) =>
  repo
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");

/** The organization's catalogue sources with the suggested FrontX one added
 *  at the end, or `null` when it already reads that repository as FrontX
 *  (at any ref): then there is nothing to add, only to sync. */
export function withSuggestedFrontx(items: readonly CatalogRepoSource[]): CatalogRepoSource[] | null {
  return withFrontxSource(items, SUGGESTED_FRONTX_SOURCE.repo, SUGGESTED_FRONTX_SOURCE.git_ref);
}

/** The organization's catalogue sources with `repo` added as a FrontX source
 *  at the end, or `null` when it already reads that repository as FrontX (at
 *  any ref): then there is nothing to add, only to sync. */
export function withFrontxSource(
  items: readonly CatalogRepoSource[],
  repo: string,
  gitRef: string | null = "main",
): CatalogRepoSource[] | null {
  const want = repoKey(repo);
  const has = items.some((s) => (s.mode || "gears") === "frontx" && repoKey(s.repo) === want);
  if (has) return null;
  return [...items, { tenant: ORG_TENANT, connection_id: null, repo, git_ref: gitRef, mode: "frontx" }];
}

/** The repository the constructor offers to read micro-frontends from: the
 *  project's own first one the catalogue does not read as FrontX yet. Its
 *  micro-frontends are the screens this product is likely to mount (Studio's
 *  own are under `studio-frontend/src-app/mfe_packages/`). `null` when every
 *  repository of the project is read already, or it has none. */
export function frontxSuggestion(projectRepos: readonly string[], sources: readonly CatalogRepoSource[]): string | null {
  const read = new Set(sources.filter((s) => (s.mode || "gears") === "frontx").map((s) => repoKey(s.repo)));
  return projectRepos.find((r) => r.trim() && !read.has(repoKey(r))) ?? null;
}

/** `owner/repo` of a GitHub pull request link, or `null`. */
function repoOfPullRequest(url: string | null | undefined): string | null {
  const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//i.exec(url ?? "");
  return m ? m[1] : null;
}

/** The project's repositories, the one a product is written to first: its
 *  connected gear repository, its sources, the repository the product's last
 *  pull request went to, and the repositories ingested as its artifacts. Each
 *  once, in that order. A project need not have every record: one whose
 *  repository was never ingested still names it as a source. */
export function projectRepos(of: {
  gearRepo?: string | null;
  sources?: readonly { full_path: string }[];
  writtenPrUrl?: string | null;
  artifactRepos?: readonly string[];
}): string[] {
  const all = [
    of.gearRepo,
    ...(of.sources ?? []).map((s) => s.full_path),
    repoOfPullRequest(of.writtenPrUrl),
    ...(of.artifactRepos ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of all) {
    if (!r?.trim() || seen.has(repoKey(r))) continue;
    seen.add(repoKey(r));
    out.push(r.trim());
  }
  return out;
}

/** Catalogue kinds of a package that shows how to write a micro-frontend
 *  rather than being one a product mounts. */
const TEMPLATE_KINDS = new Set(["template", "example"]);

/** A template or example micro-frontend: where a new one starts, not a screen
 *  to add. */
export function isTemplateMfe(m: Pick<Mfe, "kind" | "repo">): boolean {
  return TEMPLATE_KINDS.has(m.kind ?? "") || repoKey(m.repo ?? "").includes(repoKey(SUGGESTED_FRONTX_SOURCE.repo));
}

/** The micro-frontends a product can add, and the templates to start a new
 *  one from. */
export function splitTemplates(mfes: readonly Mfe[]): { addable: Mfe[]; templates: Mfe[] } {
  return { addable: mfes.filter((m) => !isTemplateMfe(m)), templates: mfes.filter(isTemplateMfe) };
}

/** One place a micro-frontend takes in the shell. */
export interface Placement {
  id: string;
  /** The shell domain it mounts in: `screen`, `sidebar`, `overlay`, `popup`, … */
  domain: string;
  label: string | null;
  icon: string | null;
  route: string | null;
  order: number | null;
  /** Which level of the portal it belongs to (`organization`, `project`, …). */
  level: string | null;
}

export interface Mfe {
  /** The npm package name, the catalogue key. */
  name: string;
  /** The catalogue's kind: `micro-frontend`, or `template`/`example` for one
   *  that shows how to write a micro-frontend. */
  kind?: string | null;
  description: string;
  version: string | null;
  repo: string | null;
  placements: Placement[];
  /** Gear route segments it calls (`studio-documents`): its own API
   *  services', and those of the FrontX packages it depends on. */
  calls: string[];
  /** For a call it makes through a dependency: which package makes it. */
  via: Record<string, string>;
}

/** The shell's zones, in the order the constructor draws them. A domain no
 *  zone names is shown under "other", never dropped. */
export const ZONES: { domain: string; title: string; hint: string }[] = [
  { domain: "screen", title: "Screens", hint: "Full pages, one per route; the navigation lists them" },
  { domain: "sidebar", title: "Sidebar", hint: "Panels beside the page" },
  { domain: "overlay", title: "Overlays", hint: "Drawn over the page" },
  { domain: "popup", title: "Popups", hint: "Dialogs a screen opens" },
];

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function placementOf(raw: unknown): Placement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    domain: str(r.domain) ?? "other",
    label: str(r.label),
    icon: str(r.icon),
    route: str(r.route),
    order: typeof r.order === "number" ? r.order : null,
    level: str(r.level),
  };
}

/** The micro-frontends in the catalogue, with what their profiles say. A
 *  package the scan did not find to be a micro-frontend is not one here. */
export function mfesFrom(nodes: CatalogNode[], profiles: Record<string, Record<string, unknown>>): Mfe[] {
  const out: Mfe[] = [];
  const autoOf = (name: string) => (profiles[name]?.auto ?? {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // Every FrontX package's own calls, libraries included: a micro-frontend
  // that talks to the backend through a shared package calls what it calls.
  const own = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.type_id !== FRONTX_NODE_TYPE) continue;
    const name = str((n.value as Record<string, unknown>).name) ?? n.instance_id;
    own.set(name, strings(autoOf(name).mfe_calls));
  }
  for (const n of nodes) {
    if (n.type_id !== FRONTX_NODE_TYPE) continue;
    const v = n.value as Record<string, unknown>;
    const name = str(v.name) ?? n.instance_id;
    const auto = (profiles[name]?.auto ?? {}) as Record<string, unknown>;
    const kind = str(v.component_kind);
    // A template or example counts when it is a micro-frontend's template:
    // it declares extensions, or names itself one (`_blank-mfe`).
    const isMfe =
      kind === "micro-frontend" ||
      Array.isArray(auto.mfe_extensions) ||
      (TEMPLATE_KINDS.has(kind ?? "") && /mfe/i.test(name));
    if (!isMfe) continue;
    const placements = (Array.isArray(auto.mfe_extensions) ? auto.mfe_extensions : [])
      .map(placementOf)
      .filter((p): p is Placement => p !== null);
    const calls = new Set(strings(auto.mfe_calls));
    const via: Record<string, string> = {};
    for (const dep of strings(auto.deps_names)) {
      for (const c of own.get(dep) ?? []) {
        if (!calls.has(c)) {
          calls.add(c);
          via[c] = dep;
        }
      }
    }
    out.push({
      name,
      kind,
      description: str(v.description) ?? str(profiles[name]?.description) ?? "",
      version: str(v.max_version) ?? str(v.newest_version),
      repo: str(v.repository) ?? str(v.synced_from),
      placements,
      calls: [...calls].sort(),
      via,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A gear's key as a route names it: `cf-gears-account-management` and
 *  `account-management` are the same gear; so are `studio-documents` and
 *  `cf-studio-documents`. */
export function gearKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^cf-gears-/, "")
    .replace(/^cf-/, "");
}

/** A placement's text, for a reader: its label, else its route, else the
 *  last part of its id. */
export function placementLabel(p: Placement): string {
  return p.label ?? p.route ?? p.id.split("~").filter(Boolean).pop() ?? p.id;
}

/** The picked packages' placements in each zone, ordered as the shell
 *  orders them (`order`, then label). Zones nothing fills stay, empty. */
export function zonesOf(picked: Mfe[]): { domain: string; title: string; hint: string; items: { mfe: Mfe; placement: Placement }[] }[] {
  const known = new Set(ZONES.map((z) => z.domain));
  const all = picked.flatMap((mfe) => mfe.placements.map((placement) => ({ mfe, placement })));
  const others = [...new Set(all.map((x) => x.placement.domain).filter((d) => !known.has(d)))].sort();
  const zones = [...ZONES, ...others.map((d) => ({ domain: d, title: d, hint: "A domain this shell has no name for" }))];
  return zones.map((z) => ({
    ...z,
    items: all
      .filter((x) => x.placement.domain === z.domain)
      .sort(
        (a, b) =>
          (a.placement.order ?? 1e9) - (b.placement.order ?? 1e9) ||
          placementLabel(a.placement).localeCompare(placementLabel(b.placement)),
      ),
  }));
}

export interface Coverage {
  /** Per picked package: the gears it calls that the product does not have. */
  missing: Map<string, string[]>;
  /** The product's gears no picked package calls: backend without a screen. */
  unseen: string[];
}

/** Whether the product has the gears its frontend calls, and which of its
 *  gears no screen uses. Platform plumbing every product has (the gateway,
 *  sign-in) is not asked to have a screen. */
export function coverage(picked: Mfe[], productGears: string[]): Coverage {
  const have = new Set(productGears.map(gearKey));
  const missing = new Map<string, string[]>();
  const used = new Set<string>();
  for (const m of picked) {
    const lacks = m.calls.filter((c) => !have.has(gearKey(c)));
    if (lacks.length > 0) missing.set(m.name, lacks);
    for (const c of m.calls) used.add(gearKey(c));
  }
  const unseen = [...have].filter((g) => !used.has(g) && !PLUMBING.has(g)).sort();
  return { missing, unseen };
}

/** Gears that serve the platform rather than a screen of their own. */
const PLUMBING = new Set([
  "api-gateway",
  "authn-resolver",
  "authz-resolver",
  "tenant-resolver",
  "types-registry",
  "credstore",
  "grpc-hub",
  "nodes-registry",
  "oagw",
  "api-egress",
  "module-orchestrator",
]);

/** Packages that offer a screen for a gear, for "what could show this". */
export function offersFor(gear: string, mfes: Mfe[]): Mfe[] {
  const k = gearKey(gear);
  return mfes.filter((m) => m.calls.some((c) => gearKey(c) === k));
}
