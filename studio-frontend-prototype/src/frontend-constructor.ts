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

/** The FrontX repository the constructor offers when the catalogue has no
 *  micro-frontend yet: FrontX's own templates, whose `template-mfe` carries
 *  four micro-frontends with an `mfe.json` each (`_blank-mfe`, `demo-mfe`,
 *  two widget fixtures). Public, so the organization's GitHub connection
 *  reads it whatever it is scoped to. It is the constructor's counterpart of
 *  the Gearbox corpus (`STUDIO_GEARBOX_CORPUS_URL`): a well-known starting
 *  point, offered rather than imposed, and an ordinary catalogue source once
 *  added. */
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
  const want = repoKey(SUGGESTED_FRONTX_SOURCE.repo);
  const has = items.some((s) => (s.mode || "gears") === SUGGESTED_FRONTX_SOURCE.mode && repoKey(s.repo) === want);
  if (has) return null;
  return [...items, { tenant: ORG_TENANT, connection_id: null, ...SUGGESTED_FRONTX_SOURCE }];
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
    const isMfe = v.component_kind === "micro-frontend" || Array.isArray(auto.mfe_extensions);
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
