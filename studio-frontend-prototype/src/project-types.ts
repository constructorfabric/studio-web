/* ── The kinds of project a workspace offers ──────────────────────────────────
 *
 * A project type is data, not a branch in the code: an organization (or one of
 * its workspaces) lists the types its people may create, and each says
 *
 *   - what creating it provisions — one of the portal's creation recipes
 *     (`ProjectKind`: a gear repository, a product repository, or an existing
 *     repository attached), which is the only part the code has to know;
 *   - which of the project's tabs it shows, and which one opens first;
 *   - which kits are ticked when it is created.
 *
 * Stored as `cf.studio.project.types.v1~` tenant metadata with the `inherit`
 * policy, so the nearest tenant wins: an organization sets it once for every
 * workspace, a workspace may set its own, and a project reads what applies to
 * it through `/metadata/{type}/resolved` on itself. Nothing set anywhere means
 * BUILTIN_TYPES — the three kinds every Studio has had.
 *
 * Pure, so it is tested without a backend.
 */

import type { ProjectKind } from "./api";
import type { ProjTab } from "./project-overview";

export interface ProjectType {
  /** Stable id, stored on each project as `project.config.type`. */
  key: string;
  title: string;
  description: string;
  /** What creating one provisions. */
  recipe: ProjectKind;
  /** The tabs a project of this type shows, in the tab bar's own order.
   *  Absent: every tab. */
  tabs?: ProjTab[];
  /** The tab a project of this type opens on. Absent: its first tab. */
  first_tab?: ProjTab;
  /** Kit slugs ticked by default on the New project card. */
  kits?: string[];
}

export interface ProjectTypesDoc {
  types: ProjectType[];
}

export const RECIPES: { id: ProjectKind; title: string; creates: string }[] = [
  { id: "new_gears", title: "New gears", creates: "a gear repository with a starter gear" },
  { id: "product", title: "Product from gears", creates: "a product repository and an empty product.gdl" },
  { id: "existing", title: "Existing repository", creates: "nothing — an existing repository is attached" },
];

/** What every Studio offers when nobody has said otherwise. */
export const BUILTIN_TYPES: ProjectType[] = [
  {
    key: "new_gears",
    title: "New Gears",
    description: "Build new gears. Create a new repo, or use an existing gear store.",
    recipe: "new_gears",
  },
  {
    key: "product",
    title: "Product from Gears",
    description: "Assemble a product from gears. A new repository is created.",
    recipe: "product",
  },
  {
    key: "existing",
    title: "Existing Gears app",
    description: "Import a gears-based app already built. Attach its repository.",
    recipe: "existing",
  },
];

/** Starting points for the editor. Each is only a filled-in form: saving one
 *  stores its copy, which the organization then edits as its own. */
export const PRESETS: { id: string; title: string; types: ProjectType[] }[] = [
  { id: "builtin", title: "Studio's built-in types", types: BUILTIN_TYPES },
  {
    id: "learning",
    title: "Learning: students working with gears",
    types: [
      {
        key: "build-with-gears",
        title: "Build something from gears",
        description:
          "Pick gears from the catalogue and put them together in an IDE session with an agent. A repository is created for you.",
        recipe: "product",
        tabs: ["overview", "components", "parts","sources", "builds", "kits", "people"],
        first_tab: "overview",
      },
      {
        key: "write-a-gear",
        title: "Write a gear",
        description: "Write your own gear from a starter, try it in an IDE session and see it build.",
        recipe: "new_gears",
        tabs: ["overview", "parts", "sources", "builds", "tests", "kits", "people"],
        first_tab: "overview",
      },
      {
        key: "bring-a-repository",
        title: "Bring my repository",
        description: "Attach a repository you already have and keep working on it here.",
        recipe: "existing",
        tabs: ["overview", "sources", "parts", "artifacts", "activity", "people"],
        first_tab: "sources",
      },
    ],
  },
];

const RECIPE_IDS = new Set<string>(RECIPES.map((r) => r.id));

/** The types a stored document holds, keeping only well-formed entries. A
 *  malformed document must not take the New project card down with it: what
 *  cannot be read is left out, and nothing readable means the built-in set. */
export function parseTypes(raw: unknown, knownTabs: readonly string[]): ProjectType[] {
  const list = raw && typeof raw === "object" ? (raw as { types?: unknown }).types : undefined;
  if (!Array.isArray(list)) return BUILTIN_TYPES;
  const known = new Set(knownTabs);
  const seen = new Set<string>();
  const out: ProjectType[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const key = typeof t.key === "string" ? t.key.trim() : "";
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!key || !title || seen.has(key) || typeof t.recipe !== "string" || !RECIPE_IDS.has(t.recipe)) continue;
    seen.add(key);
    const tabs = Array.isArray(t.tabs)
      ? (t.tabs.filter((x) => typeof x === "string" && known.has(x)) as ProjTab[])
      : undefined;
    const first = typeof t.first_tab === "string" && known.has(t.first_tab) ? (t.first_tab as ProjTab) : undefined;
    const kits = Array.isArray(t.kits) ? t.kits.filter((x): x is string => typeof x === "string" && x !== "") : undefined;
    out.push({
      key,
      title,
      description: typeof t.description === "string" ? t.description : "",
      recipe: t.recipe as ProjectKind,
      ...(tabs && tabs.length > 0 ? { tabs } : {}),
      ...(first ? { first_tab: first } : {}),
      ...(kits && kits.length > 0 ? { kits } : {}),
    });
  }
  return out.length > 0 ? out : BUILTIN_TYPES;
}

/** Why a document cannot be saved, or null. The editor saves only what
 *  `parseTypes` would read back unchanged. */
export function typesProblem(types: ProjectType[]): string | null {
  if (types.length === 0) return "Keep at least one type: the New project card needs something to offer.";
  const keys = new Set<string>();
  for (const t of types) {
    if (!t.title.trim()) return "Every type needs a title.";
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(t.key)) return `“${t.title}”: the key may hold only a–z, 0–9, - and _.`;
    if (keys.has(t.key)) return `Two types share the key “${t.key}”.`;
    keys.add(t.key);
    if (t.tabs && t.tabs.length === 0) return `“${t.title}” shows no tab at all.`;
    if (t.first_tab && t.tabs && !t.tabs.includes(t.first_tab)) return `“${t.title}” opens on a tab it does not show.`;
  }
  return null;
}

/** A key for a new type, from its title, not taken by any other. */
export function keyFor(title: string, taken: Iterable<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "type";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** The type a project is: by the key it was created with, else — for a project
 *  older than types, or whose type was since removed — the built-in one of its
 *  recipe, which shows every tab. */
export function typeOfProject(
  config: { type?: string; kind?: ProjectKind } | null | undefined,
  types: ProjectType[],
): ProjectType | null {
  if (!config) return null;
  const own = config.type ? types.find((t) => t.key === config.type) : undefined;
  if (own) return own;
  return BUILTIN_TYPES.find((t) => t.recipe === (config.kind ?? "")) ?? null;
}

/** The tabs a project shows: its type's, in the order `all` puts them. */
export function visibleTabs<T extends { id: ProjTab }>(all: readonly T[], type: ProjectType | null): T[] {
  if (!type?.tabs) return [...all];
  const keep = new Set(type.tabs);
  const shown = all.filter((t) => keep.has(t.id));
  return shown.length > 0 ? shown : [...all];
}

/** Where a project opens: its type's first tab, else the first it shows. */
export function landingTab(all: readonly { id: ProjTab }[], type: ProjectType | null): ProjTab {
  const shown = visibleTabs(all, type);
  if (type?.first_tab && shown.some((t) => t.id === type.first_tab)) return type.first_tab;
  return shown[0]?.id ?? "overview";
}
