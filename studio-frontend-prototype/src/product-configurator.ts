// The product as parts to put together, the way the desktop's Gearbox
// composition tree shows it: the gears asked for, each with the slots its
// extension points open and the plugin chosen for each, and below them what
// the engine pulled in by itself and why. A person picks parts and plugins
// from short lists; the wiring between them is the engine's.
//
// Pure: product-configurator-view.tsx renders what these compute, from the
// engine's catalogue (`GET /studio-product/v1/gearbox/catalogue`) and the
// project's picks, which are crate names (`cf-gears-api-gateway`) as
// everywhere else in the portal.

import type { GearConfig, GearExplanation, ProductPreview } from "./api";
import { gearLabel } from "./product";

/** An extension point, as much of the engine's `ExtensionPointDecl` as is read here. */
export interface CataloguePoint {
  spec?: string | null;
  trait_ident?: string | null;
  sdk?: { crate_name: string } | null;
}

/** One gear of the engine's catalogue (`GearDescriptor`), as much as is read here. */
export interface CatalogueGear {
  id: string;
  /** The root it was read from, by source id. */
  source?: string | null;
  display_name?: string | null;
  description?: string | null;
  category?: string | null;
  maturity?: string | null;
  package: { crate_name: string };
  extension_points?: CataloguePoint[] | null;
  /** The point a plugin fills. `fills` before gearbox#2. */
  implements?: CataloguePlugin | null;
  fills?: CataloguePlugin | null;
  vendor_selector?: string | null;
  serves?: { config_key?: string | null }[] | null;
  /** `db`, `rest`, `stateful`, … as `#[toolkit::gear]` declares them. */
  runtime_caps?: string[] | null;
  /** Gears that must run in the same process, by engine id. */
  colocated_deps?: string[] | null;
  config_schema?: { fields?: { name: string; required?: boolean; default?: unknown }[] | null } | null;
}

export interface CataloguePlugin {
  spec?: string | null;
  point?: CataloguePoint | null;
  default_vendor?: string | null;
  default_priority?: number | string | null;
}

/** The catalogue's answer, as `gearbox catalogue --format json` writes it. */
export interface GearCatalogue {
  gears: Record<string, CatalogueGear>;
}

/** Whose a gear is: the platform's, the organization's own gear
 *  repositories', or the project's own code (its product.gdl's sources). */
export type GearOrigin = "platform" | "organization" | "project";

/** Where the catalogue's roots come from, as the catalogue route says. */
export interface CatalogueRoots {
  roots?: { source_id: string; tier?: string | null }[] | null;
  /** The roots read out of the organization's projects' own repositories. */
  project_sources?: string[] | null;
}

/** The catalogue looked up by engine id and by crate name. */
export interface CatalogueIndex {
  gears: CatalogueGear[];
  /** Whose `g` is. A gear whose root is not listed is the platform's. */
  origin: (g: CatalogueGear | undefined) => GearOrigin;
  find: (name: string) => CatalogueGear | undefined;
  /** The name a pick spells a gear by: its crate, or its engine id when
   *  another gear shares that crate, so the name finds this gear alone. */
  name: (g: CatalogueGear) => string;
}

export function indexCatalogue(catalogue: GearCatalogue | null | undefined, from: CatalogueRoots = {}): CatalogueIndex {
  const projectRoots = new Set(from.project_sources ?? []);
  const orgRoots = new Set((from.roots ?? []).filter((r) => r.tier === "organization").map((r) => r.source_id));
  const origin = (g: CatalogueGear | undefined): GearOrigin =>
    !g?.source ? "platform" : projectRoots.has(g.source) ? "project" : orgRoots.has(g.source) ? "organization" : "platform";
  const gears = Object.values(catalogue?.gears ?? {}).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(gears.map((g) => [g.id, g]));
  // A crate can hold several gears (`cf-gears-mini-chat` is mini-chat and its
  // two static plugins): its name means the one that is not a plugin, as the
  // backend's `find` reads it.
  const byCrate = new Map<string, CatalogueGear>();
  for (const g of gears) {
    const c = g.package.crate_name;
    const had = byCrate.get(c);
    if (!had || (isPlugin(had) && !isPlugin(g))) byCrate.set(c, g);
  }
  return {
    gears,
    origin,
    find: (name) => byId.get(name) ?? byCrate.get(name),
    // The crate when the crate finds this gear, else the engine id.
    name: (g) => (byCrate.get(g.package.crate_name)?.id === g.id ? g.package.crate_name : g.id),
  };
}

/** How a gear reads to somebody choosing it. */
export function partLabel(g: CatalogueGear): string {
  const name = g.display_name?.trim();
  return name || gearLabel(g.package.crate_name);
}

function pluginOf(g: CatalogueGear): CataloguePlugin | null {
  return g.implements ?? g.fills ?? null;
}

export const isPlugin = (g: CatalogueGear): boolean => pluginOf(g) !== null;

/** Whether `plugin` fills `point`: by the GTS spec when both state one, else
 *  by the SDK crate the point lives in (the backend's own rule). */
export function fillsPoint(plugin: CatalogueGear, point: CataloguePoint): boolean {
  const f = pluginOf(plugin);
  if (!f) return false;
  const spec = f.spec ?? f.point?.spec;
  if (spec && point.spec) return spec === point.spec;
  const sdk = f.point?.sdk?.crate_name;
  return !!sdk && sdk === point.sdk?.crate_name;
}

/** `AuthNResolverPluginClient` → `AuthN resolver`: the slot as a person
 *  names it. Given its host, the words that repeat the host's name go
 *  (mini-chat's `MiniChatAuditPluginClientV1` is its `Audit`), and a slot
 *  left with none is the host's `Provider`. */
export function slotLabel(point: CataloguePoint, host?: Pick<CatalogueGear, "id" | "display_name">): string {
  // Without a trait, the spec's own name: `…~cf.core.authn_resolver.plugin.v1~` → `authn_resolver`.
  const raw =
    point.trait_ident ??
    point.spec?.split("~").filter(Boolean).pop()?.replace(/\.plugin\.v\d+$/, "").split(".").pop() ??
    "plugin";
  const stem = raw
    .replace(/V\d+$/, "")
    .replace(/(Plugin)?(Client|Api)?$/, "")
    .replace(/Plugin$/, "");
  // Camel-case words, an acronym kept whole; a lone capital after a word
  // stays with it (`AuthN`).
  const all: string[] = [];
  for (const w of (stem || raw).match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? [raw]) {
    if (/^[A-Z]$/.test(w) && all.length > 0) all[all.length - 1] += w;
    else all.push(w);
  }
  const hostWords = new Set(
    host ? `${host.id} ${host.display_name ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : [],
  );
  const words = all.filter((w) => !hostWords.has(w.toLowerCase()));
  if (words.length === 0) return host ? "Provider" : all.join(" ");
  if (words.length === 1 && words[0] === "Idp") return "IdP";
  return words.map((w, i) => (i === 0 || /[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase())).join(" ");
}

const priority = (g: CatalogueGear): number => {
  const p = pluginOf(g)?.default_priority;
  const n = typeof p === "string" ? Number(p) : p;
  return typeof n === "number" && Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** The plugins that can fill `point`, the one the engine would choose
 *  first: registered under the vendor the host selects by, then the
 *  runtime's priority (lower wins), then a `static` one, then by id — the
 *  order of `default_plugin` in the backend's completion. */
export function pluginsFor(index: CatalogueIndex, host: CatalogueGear, point: CataloguePoint): CatalogueGear[] {
  const agrees = (p: CatalogueGear) =>
    !host.vendor_selector || (pluginOf(p)?.default_vendor ?? null) === host.vendor_selector;
  return index.gears
    .filter((g) => g.id !== host.id && fillsPoint(g, point))
    .sort(
      (a, b) =>
        Number(!agrees(a)) - Number(!agrees(b)) ||
        priority(a) - priority(b) ||
        Number(!a.id.includes("static")) - Number(!b.id.includes("static")) ||
        a.id.localeCompare(b.id),
    );
}

/** A required field with no default the product leaves unset: the engine
 *  refuses the product for it. Fields generation writes do not count. */
export function unsetFields(g: CatalogueGear, config: GearConfig, name = g.package.crate_name): string[] {
  const derived = new Set((g.serves ?? []).map((s) => s.config_key).filter(Boolean));
  const set = config[name] ?? config[g.id] ?? {};
  return (g.config_schema?.fields ?? [])
    .filter((f) => f.required && (f.default === undefined || f.default === null) && !derived.has(f.name))
    .filter((f) => set[f.name] === undefined)
    .map((f) => f.name);
}

export interface SlotOption {
  name: string;
  label: string;
  description: string | null;
}

/** One extension point of a part, and what fills it. */
export interface Slot {
  key: string;
  label: string;
  options: SlotOption[];
  /** The picks filling it; usually one. */
  chosen: string[];
  /** What the engine would put there if nothing were chosen. */
  recommended: string | null;
  /** Required settings the chosen plugins still need, as `plugin.field`. */
  unset: string[];
}

/** One gear the product asks for. */
export interface Part {
  name: string;
  id: string;
  label: string;
  description: string | null;
  category: string;
  maturity: string | null;
  slots: Slot[];
  /** A plugin picked without its host in the product: the host it plugs into. */
  plugsInto: string | null;
  /** Required settings it still needs. */
  unset: string[];
}

/** A gear the engine added by itself, with its reason. */
export interface AutoPart {
  id: string;
  label: string;
  why: string;
}

export interface Composition {
  parts: Part[];
  /** Picks the catalogue does not describe. */
  unknown: string[];
  automatic: AutoPart[];
}

const OTHER = "Other";

/** The picks as parts with their slots, plus what the last resolve pulled in. */
export function compose(
  index: CatalogueIndex,
  picks: readonly string[],
  config: GearConfig,
  preview?: Pick<ProductPreview, "gears"> | null,
): Composition {
  const picked = new Map<string, CatalogueGear>();
  const unknown: string[] = [];
  for (const name of picks) {
    const g = index.find(name);
    if (g) picked.set(name, g);
    else if (!unknown.includes(name)) unknown.push(name);
  }
  const hosts = [...picked.values()].filter((g) => (g.extension_points ?? []).length > 0);
  const slotted = new Set<string>();
  const parts: Part[] = [];
  for (const [name, g] of picked) {
    if (isPlugin(g)) continue;
    const slots = (g.extension_points ?? []).map((point, i): Slot => {
      const options = pluginsFor(index, g, point);
      const chosen = picks.filter((p) => {
        const pg = picked.get(p);
        return !!pg && fillsPoint(pg, point);
      });
      chosen.forEach((c) => slotted.add(c));
      return {
        key: point.spec ?? `${g.id}#${i}`,
        label: slotLabel(point, g),
        options: options.map((o) => ({ name: index.name(o), label: partLabel(o), description: o.description ?? null })),
        chosen,
        recommended: options[0] ? index.name(options[0]) : null,
        unset: chosen.flatMap((c) => {
          const pg = picked.get(c);
          return pg ? unsetFields(pg, config, c).map((f) => `${partLabel(pg)}.${f}`) : [];
        }),
      };
    });
    parts.push(part(name, g, slots, null, config));
  }
  for (const [name, g] of picked) {
    if (!isPlugin(g) || slotted.has(name)) continue;
    const host =
      hosts.find((h) => (h.extension_points ?? []).some((p) => fillsPoint(g, p))) ??
      index.gears.find((h) => h.id !== g.id && (h.extension_points ?? []).some((p) => fillsPoint(g, p)));
    parts.push(part(name, g, [], host ? partLabel(host) : "a host the catalogue does not describe", config));
  }
  const inPicks = new Set([...picked.values()].map((g) => g.id));
  const automatic = (preview?.gears ?? [])
    .filter((g) => !inPicks.has(g.id) && !picks.includes(g.crate_name) && !g.reasons.includes("selected"))
    .map((g) => {
      const known = index.find(g.id) ?? index.find(g.crate_name);
      return { id: g.id, label: known ? partLabel(known) : gearLabel(g.crate_name), why: g.reasons.join("; ") || "pulled in" };
    });
  return { parts, unknown, automatic };
}

function part(name: string, g: CatalogueGear, slots: Slot[], plugsInto: string | null, config: GearConfig): Part {
  return {
    name,
    id: g.id,
    label: partLabel(g),
    description: g.description?.trim() || null,
    category: subsystemOf(g),
    maturity: g.maturity ?? null,
    slots,
    plugsInto,
    unset: unsetFields(g, config, name),
  };
}

/** The picks with `slot` filled by `next` alone, or emptied when `next` is
 *  null. Whatever filled it before goes. */
export function choosePlugin(picks: readonly string[], slot: Pick<Slot, "chosen">, next: string | null): string[] {
  const out = picks.filter((p) => !slot.chosen.includes(p));
  if (next && !out.includes(next)) out.push(next);
  return out;
}

/** The picks without `name` and without the plugins filling its slots: a
 *  part taken out takes what was plugged into it. */
export function removePart(picks: readonly string[], part: Pick<Part, "name" | "slots">): string[] {
  const gone = new Set([part.name, ...part.slots.flatMap((s) => s.chosen)]);
  return picks.filter((p) => !gone.has(p));
}

/** A part one could add: not a plugin (those are chosen in a slot), not
 *  already in the product. */
export interface Offer {
  name: string;
  label: string;
  description: string | null;
  category: string;
  maturity: string | null;
  /** How many slots it opens, each filled for you. */
  slots: number;
}

/** What can be added, grouped by category in name order, filtered by `query`
 *  over name, id and description. */
export function offers(index: CatalogueIndex, picks: readonly string[], query = ""): { category: string; items: Offer[] }[] {
  const have = new Set(picks.map((p) => index.find(p)?.id ?? p));
  const q = query.trim().toLowerCase();
  const groups = new Map<string, Offer[]>();
  for (const g of index.gears) {
    if (isPlugin(g) || have.has(g.id)) continue;
    const label = partLabel(g);
    const text = `${label} ${g.id} ${g.package.crate_name} ${g.description ?? ""}`.toLowerCase();
    if (q && !text.includes(q)) continue;
    const category = subsystemOf(g);
    const list = groups.get(category) ?? [];
    list.push({
      name: index.name(g),
      label,
      description: g.description?.trim() || null,
      category,
      maturity: g.maturity ?? null,
      slots: (g.extension_points ?? []).length,
    });
    groups.set(category, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => subsystemOrder(a, b))
    .map(([category, items]) => ({ category, items: items.sort((a, b) => a.label.localeCompare(b.label)) }));
}

/** Parts grouped by category, in the order the categories first appear. */
export function byCategory(parts: readonly Part[]): { category: string; parts: Part[] }[] {
  const groups: { category: string; parts: Part[] }[] = [];
  for (const p of parts) {
    const g = groups.find((x) => x.category === p.category);
    if (g) g.parts.push(p);
    else groups.push({ category: p.category, parts: [p] });
  }
  return groups;
}

// ── Subsystems: the gear's `category`, named for a person ─────────────────

/** The corpus's categories, as a person reads them. Anything else is shown
 *  with its dashes turned into spaces. */
const SUBSYSTEM_NAMES: Record<string, string> = {
  "core-platform-integration": "Platform integration",
  "core-functionality": "Core",
  "api-ingress": "API ingress",
  "gen-ai": "AI",
  bss: "Billing (BSS)",
  oss: "Operations (OSS)",
  serverless: "Serverless",
  example: "Examples",
};

/** The subsystem a gear belongs to: its `category` from gear.gdl. */
export function subsystemOf(g: Pick<CatalogueGear, "category">): string {
  const c = g.category?.trim();
  if (!c) return OTHER;
  return SUBSYSTEM_NAMES[c] ?? c.charAt(0).toUpperCase() + c.slice(1).replace(/[-_]+/g, " ");
}

/** Subsystems by name, with Examples and Other at the end. */
export function subsystemOrder(a: string, b: string): number {
  const rank = (x: string) => (x === OTHER ? 2 : x === "Examples" ? 1 : 0);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Every subsystem the catalogue has, in order: the zones of the map. */
export function subsystems(index: CatalogueIndex): string[] {
  return [...new Set(index.gears.map(subsystemOf))].sort(subsystemOrder);
}

/** What is known of a gear for certain, in plain words, for when its
 *  gear.gdl has no description and beside it when it has one. */
export function gearFacts(index: CatalogueIndex, g: CatalogueGear): string[] {
  const out: string[] = [];
  const caps = new Set(g.runtime_caps ?? []);
  const plug = pluginOf(g);
  if (plug) {
    const host = index.gears.find((h) => h.id !== g.id && (h.extension_points ?? []).some((p) => fillsPoint(g, p)));
    out.push(host ? `A choice for ${partLabel(host)}.` : "A plugin.");
  }
  if (caps.has("rest")) out.push("Serves a REST API.");
  if (caps.has("db")) out.push("Keeps its data in its own database.");
  if (caps.has("grpc") || caps.has("grpc_hub")) out.push("Talks gRPC.");
  const slots = (g.extension_points ?? []).map((p) => slotLabel(p, g).toLowerCase());
  if (slots.length > 0) out.push(`You choose its ${slots.join(" and ")}.`);
  const deps = (g.colocated_deps ?? []).map((d) => index.find(d)).filter((d): d is CatalogueGear => !!d);
  if (deps.length > 0) out.push(`Brings along: ${deps.map(partLabel).join(", ")}.`);
  return out;
}

/** One thing the person still has to do before the product builds. */
export interface Todo {
  part: string;
  text: string;
}

/** What is left: a slot nothing fills, a required setting left unset. */
export function todos(c: Composition): Todo[] {
  const out: Todo[] = [];
  for (const p of c.parts) {
    for (const s of p.slots) {
      const what = s.label.toLowerCase();
      if (s.chosen.length === 0 && s.options.length > 0) out.push({ part: p.name, text: `${p.label}: choose its ${what}` });
      if (s.options.length === 0) out.push({ part: p.name, text: `${p.label}: nothing in the catalogue can be its ${what}` });
      for (const f of s.unset) out.push({ part: p.name, text: `${p.label}: set ${f}` });
    }
    for (const f of p.unset) out.push({ part: p.name, text: `${p.label}: set ${f}` });
  }
  return out;
}

// ── Explanations: a gear in plain words, kept per organization ────────────

/** The organization's explanations, by the gear's engine id. */
export type ExplanationIndex = ReadonlyMap<string, GearExplanation>;

export function explanationIndex(items: readonly GearExplanation[] | null | undefined): Map<string, GearExplanation> {
  return new Map((items ?? []).map((e) => [e.gear_id, e]));
}

/** What a person reads about a gear: the organization's explanation, else
 *  the catalogue's description, else nothing. */
export function plainWords(
  g: Pick<CatalogueGear, "id" | "description"> | null | undefined,
  explanations: ExplanationIndex,
): string | null {
  if (!g) return null;
  return explanations.get(g.id)?.text.trim() || g.description?.trim() || null;
}

/** Gears with neither a description nor an explanation, plugins included:
 *  what "Explain all without description" works through. */
export function unexplained(index: CatalogueIndex, explanations: ExplanationIndex): CatalogueGear[] {
  return index.gears.filter((g) => !g.description?.trim() && !explanations.get(g.id)?.text.trim());
}

/** How a run over many items went. */
export interface BatchResult {
  done: number;
  failed: number;
  /** Items never started, because `stop` said so. */
  skipped: number;
}

/** Run `work` over `items`, at most `limit` at a time, in order. `onProgress`
 *  hears after each item; once `stop()` is true no new item starts, and the
 *  ones running finish. A failed item is counted, not thrown. */
export async function inBatches<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  opts: { onProgress?: (r: BatchResult) => void; stop?: () => boolean } = {},
): Promise<BatchResult> {
  const r: BatchResult = { done: 0, failed: 0, skipped: 0 };
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      if (opts.stop?.()) {
        r.skipped += items.length - next;
        next = items.length;
        break;
      }
      const item = items[next++];
      try {
        await work(item);
        r.done++;
      } catch {
        r.failed++;
      }
      opts.onProgress?.({ ...r });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return r;
}
