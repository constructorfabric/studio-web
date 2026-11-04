/* ── The product map: one picture of a product ───────────────────────────────
 *
 * Configure's overview (ADR-0056 §3): the product's frontend, backend and
 * infrastructure as layers of one picture, with the links between them, and
 * the constructor that adds to it. The sections below the strip are its
 * detailed views.
 *
 *   Frontend         the shell and the micro-frontends mounted in it, from
 *                    the product record's `frontend`;
 *   Backend          the gears: the picked ones (`gears`) and every one the
 *                    last check's resolution contains (`last_preview.gears`);
 *   Infrastructure   what the gears need running beside them
 *                    (`last_preview.infrastructure`).
 *
 * Links come only from facts already read, never from running the engine:
 *
 *   micro-frontend → gear      the calls the catalogue read off its API
 *                              services (`Mfe.calls`), and its `requires` in
 *                              the frontend pick;
 *   gear → infrastructure      the gears each technology names;
 *   shell → identity           the shell signs users in and the product has
 *                              a gear that signs them in;
 *   gear → gear                `colocated_deps` in the engine's catalogue,
 *                              when the catalogue was read. The resolution's
 *                              full dependency graph is the engine's and is
 *                              not drawn.
 *
 * And the problems the facts show: a screen calls a gear the product does
 * not have (a red link to a "missing" gear), a gear keeps data where an
 * environment gives no database (red), a gear no screen uses (grey).
 *
 * The same product is also its product.gdl: `productGdlLines` says which
 * lines of the description each node is, so the two views select together.
 *
 * Pure, so it is tested without a backend; product-map-view.tsx reads the
 * facts and draws them. */

import type { CatalogNode, FrontendPick, FrontxPlace, ProductTechnology, ProjectProduct } from "./api";
import { GEAR_TYPE, TIER_LABEL, tierOf } from "./catalogue-levels";
import {
  chosenShell,
  coverage,
  frontendPick,
  gearKey,
  ownerRepo,
  productIdp,
  type Library,
  type Mfe,
  type Shell,
} from "./frontend-constructor";
import { isPlugin, partLabel, subsystemOf, subsystemOrder, type CatalogueGear, type CatalogueIndex } from "./product-configurator";
import { comesWith, newFrontend, type Infrastructure } from "./product-sections";

/** The map's layers, top to bottom. An open list: the specs the project's
 *  documents declare will come above Frontend as a layer of their own. */
export type MapLayer = "frontend" | "backend" | "infrastructure";

export const MAP_LAYERS: readonly { id: MapLayer; title: string; hint: string }[] = [
  { id: "frontend", title: "Frontend", hint: "The shell and the micro-frontends mounted in it" },
  { id: "backend", title: "Backend", hint: "The gears: picked, and pulled in by the engine" },
  { id: "infrastructure", title: "Infrastructure", hint: "What the gears need running beside them" },
];

/** `ok`; `missing`: a gear a screen calls that the product does not have;
 *  `bad`: something that stops the product (no database where it runs);
 *  `warn`: something to look at; `unused`: a gear no screen uses. */
export type NodeState = "ok" | "missing" | "bad" | "warn" | "unused";

export type NodeKind = "shell" | "mfe" | "gear" | "plugin" | "missing-gear" | "technology";

export interface NodeDetail {
  kind: NodeKind;
  /** What it is, in a line. */
  what: string;
  /** What else is known: where it came from, what it carries. */
  facts: string[];
  /** The problem it has, in words; null when none. */
  problem: string | null;
  /** The section of the Product page that shows it in full. */
  section: "frontend" | "backend" | "infrastructure";
  /** A gear: its name as the picks spell it, to add or remove it. */
  gear?: string;
  /** A gear: picked for the product, or pulled in by the engine. */
  picked?: boolean;
  /** A micro-frontend: its directory, as the frontend pick keeps it. */
  path?: string;
}

export interface MapNode {
  id: string;
  layer: MapLayer;
  label: string;
  state: NodeState;
  /** The cluster it is drawn in within its layer: a gear's subsystem. */
  group: string;
  detail: NodeDetail;
  /** What else wants attention on it, beside its state: a setting still to
   *  give, a connection to make. Several at once; none yet in this version. */
  badges?: NodeBadge[];
}

export interface NodeBadge {
  tone: "bad" | "warn" | "info";
  text: string;
}

/** What runs where, over the map: for a chosen environment, each node's
 *  running version and health, by node id. The map draws with or without it. */
export type MapOverlay = ReadonlyMap<string, { version?: string | null; health?: "healthy" | "failing" | "unknown"; note?: string }>;

/** `calls`: a screen calls a gear's API; `runs-on`: a gear needs a
 *  technology; `signs-in`: the shell signs users in against it; `depends`:
 *  one gear runs with another. Open, as the layers are: specs will close
 *  gears by contract or by words, and gears will use external services. */
export type LinkKind = "calls" | "runs-on" | "signs-in" | "depends";

/** The Infrastructure layer's groups: what Studio deploys with the product,
 *  and what runs beside it that somebody else runs. External services will
 *  be a group of their own. */
export const RUNS_WITH = "Runs with the product";
export const RUNS_BESIDE = "Runs beside it, outside Studio";

export interface MapLink {
  from: string;
  to: string;
  kind: LinkKind;
  state: "ok" | "bad";
  /** Where the link comes from, in words. */
  why: string;
}

export interface ProductMap {
  nodes: MapNode[];
  links: MapLink[];
}

export interface MapFacts {
  product: Pick<ProjectProduct, "gears" | "last_preview" | "frontend"> | null;
  /** `infrastructureOf(product, targets)`; null when it could not be read. */
  infra: Infrastructure | null;
  /** The catalogue's micro-frontends and shells (`mfesFrom`, `shellsFrom`). */
  mfes: readonly Mfe[];
  shells: readonly Shell[];
  /** The engine's catalogue, for subsystems, names and gear dependencies;
   *  the map is drawn without it. */
  catalogue?: CatalogueIndex | null;
  /** The project's catalogue (ADR-0061): the organization's components and
   *  the project's own, read from their passports. A gear the engine's
   *  corpus does not hold -- one in the project's own repository, Studio's
   *  for Studioweb -- is described from here, so its card keeps its
   *  description, subsystem and version rather than only its crate name. */
  components?: readonly CatalogNode[];
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The project catalogue's gear node for a gear, by key. */
function passportGear(components: readonly CatalogNode[] | undefined, key: string): CatalogNode | null {
  return (
    (components ?? []).find(
      (n) => n.type_id === GEAR_TYPE && gearKey(text(n.value.name) ?? n.instance_id) === key,
    ) ?? null
  );
}

/** A passport's subsystem: its category, as the engine's are named. */
function passportSubsystem(n: CatalogNode): string {
  const c = text(n.value.category) ?? (Array.isArray(n.value.categories) ? text(n.value.categories[0]) : null);
  return subsystemOf({ category: c ?? undefined });
}

/** Why the map's Frontend lane is empty, in a line. "No frontend" is said
 *  only when nothing says there is one: a frontend picked before the product
 *  kept it (the configuration's), or one the saved description names that the
 *  product record no longer has -- a save that dropped it -- is named as such,
 *  so a FrontX product does not read as one without screens. */
export function frontendAbsence(f: {
  /** The project's configuration still holds a frontend picked before the
   *  product kept it. */
  picked: boolean;
  /** The newest saved description, when it could be read. */
  described: { revision: number; text: string } | null;
}): { text: string; tone: "none" | "warn" } {
  if (f.picked)
    return {
      tone: "warn",
      text: "A frontend was picked before the product kept it: open Frontend and save it to the product to see it here.",
    };
  if (f.described && /\bfrontx_product\(/.test(f.described.text))
    return {
      tone: "warn",
      text: `Revision ${f.described.revision} of product.gdl has a FrontX frontend that the product record does not: open Frontend to put it back, or save again to drop it.`,
    };
  return {
    tone: "none",
    text: "No frontend: the product is its gears and their APIs. Drag a screen here to start one from the FrontX shell template.",
  };
}

export const SHELL_NODE = "shell";
export const gearNode = (key: string) => `gear:${gearKey(key)}`;
export const mfeNode = (path: string) => `mfe:${path}`;
export const techNode = (id: string) => `infra:${id}`;

/** The group missing gears are drawn in, first in the Backend layer. */
export const MISSING_GROUP = "Not in the product";

const repoKey = (repo: string | null | undefined) => (ownerRepo(repo) ?? repo ?? "").toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A micro-frontend as a reader names it: its package without the scope,
 *  else its directory's last part. */
export function mfeLabel(place: Pick<FrontxPlace, "package" | "path">): string {
  return (place.package ?? place.path.split("/").filter(Boolean).pop() ?? place.path).replace(/^@[^/]+\//, "");
}

/** The catalogue's entry for a mounted micro-frontend: by the npm name it was
 *  kept with, else by where it is. */
export function catalogueMfe(place: FrontxPlace, mfes: readonly Mfe[]): Mfe | null {
  return (
    (place.package ? mfes.find((m) => m.name === place.package) : undefined) ??
    mfes.find((m) => repoKey(m.repo) === repoKey(place.repo) && m.path === place.path) ??
    null
  );
}

/** The gear that signs the product's users in, by key: an OIDC or Keycloak
 *  plugin or IdP first, then account-management, then authn-resolver. */
export function authGear(keys: readonly string[]): string | null {
  return (
    productIdp(keys) ??
    keys.find((k) => /(^|-)(oidc|keycloak)(-|$)/.test(k)) ??
    keys.find((k) => k === "account-management") ??
    keys.find((k) => k === "authn-resolver") ??
    null
  );
}

const PULLED_IN = "Pulled in by the engine";
const PICKED = "Picked";

export function productMap(f: MapFacts): ProductMap {
  const nodes: MapNode[] = [];
  const links: MapLink[] = [];
  const index = f.catalogue ?? null;
  const picked = f.product?.gears ?? [];
  const resolved = f.product?.last_preview?.gears ?? [];
  const pickedKeys = new Set(picked.map(gearKey));

  // ── Backend: every gear, picked or pulled in, once by key.
  const gears = new Map<string, { name: string; cat: CatalogueGear | undefined }>();
  for (const name of [...picked, ...resolved]) {
    const key = gearKey(name);
    if (!gears.has(key)) gears.set(key, { name, cat: index?.find(name) ?? index?.find(key) });
  }
  const keys = [...gears.keys()];
  for (const [key, { name, cat }] of gears) {
    const isPicked = pickedKeys.has(key);
    const plugin = cat ? isPlugin(cat) : /-plugin$/.test(key);
    const facts = [
      isPicked
        ? "Picked for the product."
        : "Pulled in by the engine: the resolution needs it for a gear that was picked.",
    ];
    if (cat) {
      if (cat.display_name && cat.display_name !== key) facts.push(`Called ${cat.display_name} in the catalogue.`);
      facts.push(`Subsystem: ${subsystemOf(cat)}; crate ${cat.package.crate_name}${cat.source ? `, from ${cat.source}` : ""}.`);
      if (index) facts.push(`It is the ${index.origin(cat)}'s.`);
      if (cat.runtime_caps?.length) facts.push(`It declares ${cat.runtime_caps.join(", ")}.`);
      if (cat.maturity) facts.push(`Maturity: ${cat.maturity}.`);
    }
    // Not in the engine's corpus: what its own passport says, from the
    // project's catalogue.
    const own = cat ? null : passportGear(f.components, key);
    if (own) {
      const repo = text(own.value.synced_from) ?? text(own.value.source_repo);
      const path = text(own.value.repo_path) ?? text(own.value.path);
      const version = text(own.value.max_version) ?? text(own.value.newest_version) ?? text(own.value.version);
      facts.push(
        `Described by its ${text(own.value.declared_in) ?? "passport"}${repo ? ` in ${repo}${path ? `, ${path}` : ""}` : ""}: ${TIER_LABEL[tierOf(own)].toLowerCase()}'s catalogue.`,
      );
      if (version) facts.push(`Version ${version}.`);
      const caps = Array.isArray(own.value.runtime_capabilities) ? own.value.runtime_capabilities.filter((x): x is string => typeof x === "string") : [];
      if (caps.length) facts.push(`It declares ${caps.join(", ")}.`);
    } else if (!cat) facts.push(`Crate ${name}.`);
    const ownPlugin = own ? text(own.value.kind) === "plugin" : false;
    nodes.push({
      id: gearNode(key),
      layer: "backend",
      label: cat ? partLabel(cat) : own ? (text(own.value.display_name) ?? text(own.value.title) ?? gearKey(name)) : gearKey(name),
      state: "ok",
      group: cat || !own ? (index ? subsystemOf(cat ?? {}) : isPicked ? PICKED : PULLED_IN) : passportSubsystem(own),
      detail: {
        kind: plugin || ownPlugin ? "plugin" : "gear",
        what:
          cat?.description?.trim() ||
          text(own?.value.description) ||
          (plugin || ownPlugin ? `The ${key} plugin.` : `The ${key} gear.`),
        facts,
        problem: null,
        section: "backend",
        gear: isPicked ? (picked.find((p) => gearKey(p) === key) ?? name) : name,
        picked: isPicked,
      },
    });
  }
  const node = (id: string) => nodes.find((n) => n.id === id);

  // ── Frontend: the shell, and the micro-frontends mounted in it.
  const front = f.product?.frontend ?? null;
  const screens: Mfe[] = [];
  if (front) {
    const shellRef = `github:${front.shell.repo}//${front.shell.path}@${front.shell.ref ?? "main"}`;
    const shell = chosenShell(f.shells, shellRef);
    const auth = authGear(keys);
    const shellLabel = front.shell.path.split("/").filter(Boolean).pop() ?? front.shell.path;
    const shellFacts = [
      `From ${front.shell.repo}, ${front.shell.path} at ${front.shell.ref ?? "main"}.`,
      shell?.signsIn === true
        ? "It signs users in."
        : shell?.signsIn === false
          ? "It does not sign users in."
          : "Whether it signs users in is not known: the catalogue has not read it.",
      `${plural(front.mfes.length, "micro-frontend")} mounted in it.`,
    ];
    const lacksAuth = shell?.signsIn === true && !auth;
    nodes.push({
      id: SHELL_NODE,
      layer: "frontend",
      label: shellLabel,
      state: lacksAuth ? "warn" : "ok",
      group: "Shell",
      detail: {
        kind: "shell",
        what: "The FrontX shell the screens are mounted in.",
        facts: shellFacts,
        problem: lacksAuth
          ? "It signs users in, and the product has no gear that signs them in (account-management, authn-resolver, an OIDC or Keycloak plugin)."
          : null,
        section: "frontend",
      },
    });
    if (shell?.signsIn === true && auth) {
      const idp = (f.product?.last_preview?.infrastructure ?? []).find((t) => t.id === "oidc" || t.id === "keycloak");
      links.push({
        from: SHELL_NODE,
        to: idp ? techNode(idp.id) : gearNode(auth),
        kind: "signs-in",
        state: "ok",
        why: idp
          ? `${shellLabel} signs users in; the product signs them in through ${idp.name} (${auth} needs it).`
          : `${shellLabel} signs users in; the product signs them in through ${auth}.`,
      });
    }

    for (const place of front.mfes) {
      const cat = catalogueMfe(place, f.mfes);
      const label = mfeLabel(place);
      const requires = (place.requires ?? []).map(gearKey);
      const calls = [...new Set([...(cat?.calls ?? []).map(gearKey), ...requires])].sort();
      screens.push({ ...(cat ?? emptyMfe(place)), calls });
      const shows = (cat?.placements ?? []).map((p) => p.label ?? p.route ?? p.id.split("~").pop() ?? p.id);
      const facts = [`From ${place.repo}, ${place.path}${place.ref ? ` at ${place.ref}` : ""}.`];
      if (shows.length) facts.push(`Shows ${shows.join(", ")}.`);
      if (cat?.version) facts.push(`Version ${cat.version}.`);
      if (!cat) facts.push("The catalogue does not list it: only its recorded requirements are known.");
      const lacks = calls.filter((c) => !gears.has(c));
      nodes.push({
        id: mfeNode(place.path),
        layer: "frontend",
        label,
        state: lacks.length > 0 ? "missing" : "ok",
        group: "Shell",
        detail: {
          kind: "mfe",
          what: cat?.description || "A micro-frontend mounted in the shell.",
          facts,
          problem: lacks.length > 0 ? `It calls ${lacks.join(", ")}, which the product does not have.` : null,
          section: "frontend",
          path: place.path,
        },
      });
      for (const c of calls) {
        const has = gears.has(c);
        if (!has && !node(gearNode(c))) {
          const found = index?.find(c) ?? index?.find(`cf-gears-${c}`) ?? index?.find(`cf-${c}`);
          nodes.push({
            id: gearNode(c),
            layer: "backend",
            label: found ? partLabel(found) : c,
            state: "missing",
            group: MISSING_GROUP,
            detail: {
              kind: "missing-gear",
              what: found?.description?.trim() || `The ${c} gear.`,
              facts: [found ? `The catalogue has it: crate ${found.package.crate_name}.` : "The catalogue was not read, or does not have it."],
              problem: `A screen calls /cf/${c}, and the product does not have it.`,
              section: "backend",
              gear: found && index ? index.name(found) : c,
            },
          });
        }
        const viaDep = cat?.via[c] ?? cat?.via[Object.keys(cat.via).find((k) => gearKey(k) === c) ?? ""];
        const said = cat?.calls.some((x) => gearKey(x) === c);
        const why = said
          ? `${label} calls /cf/${c}${viaDep ? ` through ${viaDep}` : ""}${requires.includes(c) ? "; the frontend pick records it as required" : ""}.`
          : `${label} requires ${c}: the frontend pick records it.`;
        links.push({ from: mfeNode(place.path), to: gearNode(c), kind: "calls", state: has ? "ok" : "bad", why: has ? why : `${why} The product does not have it.` });
      }
    }
    for (const n of nodes) if (n.state === "missing" && n.detail.kind === "missing-gear") {
      const by = links.filter((l) => l.to === n.id).map((l) => node(l.from)?.label ?? l.from);
      n.detail.problem = `${by.join(", ")} ${by.length === 1 ? "calls" : "call"} it, and the product does not have it.`;
    }

    // A gear no screen uses, plugins and platform plumbing aside.
    const unseen = new Set(coverage(screens, keys).unseen);
    for (const n of nodes) {
      if (n.layer !== "backend" || n.state !== "ok" || n.detail.kind !== "gear") continue;
      const key = n.id.slice("gear:".length);
      if (!unseen.has(key)) continue;
      n.state = "unused";
      n.detail.facts.push("No screen of the product calls it.");
    }
  }

  // ── Infrastructure: what the gears need, and whether where it runs gives it.
  const needs: ProductTechnology[] = f.infra?.needs ?? f.product?.last_preview?.infrastructure ?? [];
  const stops = (f.infra?.runsIn ?? []).filter((r) => r.missing.includes("PostgreSQL"));
  for (const t of needs) {
    const bad = t.id === "postgres" && stops.length > 0;
    const facts = [`Comes ${comesWith(t.id).words}.`, `${plural(t.gears.length, "gear")} need it.`];
    if (t.id === "postgres")
      for (const r of f.infra?.runsIn ?? []) facts.push(`${r.environment} (${r.namespace}): ${r.database}.`);
    nodes.push({
      id: techNode(t.id),
      layer: "infrastructure",
      label: t.name,
      state: bad ? "bad" : "ok",
      group: comesWith(t.id).deployed ? RUNS_WITH : RUNS_BESIDE,
      detail: {
        kind: "technology",
        what: t.why,
        facts,
        problem: bad
          ? `A deploy to ${stops.map((r) => r.environment).join(", ")} will stop: it gives no database for the gears that keep data. Switch it to the product's own Postgres (Organization › Infrastructure).`
          : null,
        section: "infrastructure",
      },
    });
    for (const g of t.gears) {
      const id = gearNode(g);
      const from = node(id);
      if (!from) continue;
      links.push({
        from: id,
        to: techNode(t.id),
        kind: "runs-on",
        state: bad ? "bad" : "ok",
        why: `${from.label} ${t.id === "postgres" ? "keeps data" : `needs ${t.name}`} → ${t.name}: ${t.why}${bad ? ` ${stops.map((r) => r.environment).join(", ")} gives no database.` : ""}`,
      });
    }
  }

  // ── Gear → gear: what the catalogue says must run with it.
  if (index) {
    for (const [key, { cat }] of gears) {
      for (const dep of cat?.colocated_deps ?? []) {
        const to = gearNode(dep);
        if (to === gearNode(key) || !gears.has(gearKey(dep))) continue;
        links.push({
          from: gearNode(key),
          to,
          kind: "depends",
          state: "ok",
          why: `${node(gearNode(key))?.label ?? key} runs in the same process as ${node(to)?.label ?? dep} (its gear.gdl's colocated_deps).`,
        });
      }
    }
  }

  return { nodes, links };
}

function emptyMfe(place: FrontxPlace): Mfe {
  return { name: place.package ?? place.path, description: "", version: null, repo: place.repo, placements: [], calls: [], via: {}, path: place.path };
}

/** The nodes of a layer in their groups, in drawing order: missing gears
 *  first, then the subsystems as the configurator orders them. */
export function groupsOf(nodes: readonly MapNode[], layer: MapLayer): { group: string; nodes: MapNode[] }[] {
  const groups = new Map<string, MapNode[]>();
  for (const n of nodes) if (n.layer === layer) groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
  const rank = (g: string) => (g === MISSING_GROUP || g === "Shell" ? 0 : g === PICKED ? 1 : g === PULLED_IN ? 2 : 3);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || subsystemOrder(a, b))
    .map(([group, list]) => ({ group, nodes: [...list].sort((a, b) => a.label.localeCompare(b.label)) }));
}

/** What the map shows wrong, worst first: the problems a node has. */
export function problemsOf(map: ProductMap): { node: MapNode; text: string }[] {
  const rank: Record<NodeState, number> = { bad: 0, missing: 1, warn: 2, unused: 3, ok: 4 };
  return map.nodes
    .filter((n) => n.detail.problem)
    .sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label))
    .map((node) => ({ node, text: node.detail.problem! }));
}

/** The links a node has, either end. */
export function linksOf(map: ProductMap, id: string): MapLink[] {
  return map.links.filter((l) => l.from === id || l.to === id);
}

/* ── What an add or a remove writes ──────────────────────────────────────── */

/** The picks with `gear` added, unless a gear of that key is there already. */
export function gearsWith(picks: readonly string[], gear: string): string[] {
  const key = gearKey(gear);
  return picks.some((p) => gearKey(p) === key) ? [...picks] : [...picks, gear];
}

/** The picks without the gear of `gear`'s key. */
export function gearsWithout(picks: readonly string[], gear: string): string[] {
  const key = gearKey(gear);
  return picks.filter((p) => gearKey(p) !== key);
}

/** The frontend with `mfe` mounted: the shell template when the product has
 *  no frontend yet, the micro-frontend placed as Frontend › Save places it,
 *  with the gears of the product it calls and the libraries it needs. Every
 *  micro-frontend already mounted is kept as recorded. `error` when the
 *  catalogue cannot place it; nothing is added then. */
export function frontendWith(
  current: FrontendPick | null | undefined,
  mfe: Mfe,
  libraries: readonly Library[],
  productGears: readonly string[],
): { pick: FrontendPick | null; error: string | null } {
  const base = current ?? newFrontend();
  const shellRef = `github:${base.shell.repo}//${base.shell.path}@${base.shell.ref ?? "main"}`;
  const { pick, unplaced } = frontendPick(shellRef, [mfe], libraries, productGears);
  if (!pick) return { pick: null, error: `The shell \`${shellRef}\` is not a repository and directory.` };
  if (unplaced.includes(mfe.name) || pick.mfes.length === 0)
    return { pick: null, error: `The catalogue does not say where ${mfe.name} is yet; sync the catalogue, then add it.` };
  const added = pick.mfes[0];
  const libs = [...(base.libraries ?? [])];
  for (const l of pick.libraries ?? [])
    if (!libs.some((x) => repoKey(x.repo) === repoKey(l.repo) && x.path === l.path)) libs.push(l);
  return {
    pick: {
      shell: base.shell,
      mfes: [...base.mfes.filter((m) => !(repoKey(m.repo) === repoKey(added.repo) && m.path === added.path)), added],
      ...(libs.length > 0 ? { libraries: libs } : {}),
    },
    error: null,
  };
}

/** The frontend without the micro-frontend at `path`. */
export function frontendWithout(current: FrontendPick, path: string): FrontendPick {
  return { ...current, mfes: current.mfes.filter((m) => m.path !== path) };
}

/** The frontend with each catalogued micro-frontend's `requires` brought up
 *  to the product's gears, as a save from Frontend would write it; `null`
 *  when nothing changes. */
export function withRequires(
  current: FrontendPick | null | undefined,
  mfes: readonly Mfe[],
  productGears: readonly string[],
): FrontendPick | null {
  if (!current) return null;
  const have = new Set(productGears.map(gearKey));
  let changed = false;
  const next = current.mfes.map((m) => {
    const cat = catalogueMfe(m, mfes);
    if (!cat) return m;
    const requires = [...new Set(cat.calls.map(gearKey).filter((g) => have.has(g)))].sort();
    if (JSON.stringify(requires) === JSON.stringify(m.requires ?? [])) return m;
    changed = true;
    const { requires: _old, ...rest } = m;
    return requires.length > 0 ? { ...rest, requires } : rest;
  });
  return changed ? { ...current, mfes: next } : null;
}

/* ── The map's other view: product.gdl ────────────────────────────────────── */

/** Which lines (1-based) of a product.gdl each node is: a gear its
 *  `use_gear("<id>"` line, a plugin its `plugin("<id>"` (on its host's line),
 *  a micro-frontend its `frontx_mfe(package = path("<path>")` line, the shell
 *  the `shell = path(` line inside `frontend = frontx_product(`, Postgres the
 *  profiles' `database = postgres(` lines. `byLine` names the node a line is
 *  first: the gear before the plugins written on its line. A description
 *  without a frontend block simply has no lines for the frontend. */
export function productGdlLines(
  text: string,
  nodeIds: readonly string[],
): { byNode: Map<string, number[]>; byLine: Map<number, string> } {
  const ids = new Set(nodeIds);
  const byNode = new Map<string, number[]>();
  const byLine = new Map<number, string>();
  const claim = (id: string, line: number) => {
    if (!ids.has(id)) return;
    const at = byNode.get(id) ?? [];
    if (!at.includes(line)) byNode.set(id, [...at, line]);
    if (!byLine.has(line)) byLine.set(line, id);
  };
  let inFrontend = false;
  let depth = 0;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const n = i + 1;
    const code = line.replace(/#.*$/, "");
    if (/\bfrontend\s*=\s*frontx_product\(/.test(code)) {
      inFrontend = true;
      depth = 0;
    }
    if (inFrontend) {
      if (/^\s*shell\s*=\s*path\(/.test(code)) claim(SHELL_NODE, n);
      for (const ch of code) depth += ch === "(" || ch === "[" ? 1 : ch === ")" || ch === "]" ? -1 : 0;
      if (depth <= 0 && !/frontx_product\($/.test(code.trim())) inFrontend = false;
    }
    const mfe = /\bfrontx_mfe\(\s*package\s*=\s*path\(\s*"([^"]+)"/.exec(code);
    if (mfe) claim(mfeNode(mfe[1]), n);
    const gear = /\buse_gear\(\s*"([^"]+)"/.exec(code);
    if (gear) claim(gearNode(gear[1]), n);
    for (const p of code.matchAll(/\bplugin\(\s*"([^"]+)"/g)) claim(gearNode(p[1]), n);
    if (/\bdatabase\s*=\s*postgres\(/.test(code)) claim(techNode("postgres"), n);
  });
  return { byNode, byLine };
}
