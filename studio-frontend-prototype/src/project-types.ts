/* ── Project templates: what a new project may start from ────────────────────
 *
 * A template is optional, and it only fills in the New project card: the
 * project's sources (a new repository, one attached, or none yet, and whether
 * a starter gear is written there), its brief, the kits ticked, and which tabs
 * its projects show and open on. It no longer says what the project IS: there
 * is no "recipe" any more. What the product is comes from its specs, proposed
 * by Studio and confirmed by a member (product-kind.ts).
 *
 * An organization (or one of its workspaces) lists the templates its people
 * may start from. Stored as `cf.studio.project.types.v1~` tenant metadata --
 * the name it had as "project types", kept so what was saved still reads --
 * with the `inherit` policy, so the nearest tenant wins: an organization sets
 * it once for every workspace, a workspace may set its own, and a project
 * reads what applies to it through `/metadata/{type}/resolved` on itself.
 * Nothing set anywhere means BUILTIN_TEMPLATES. A stored template from before
 * names a `recipe`; it is read as the sources that recipe used to create.
 *
 * Pure, so it is tested without a backend.
 */

import type { ProjectKind } from "./api";
import { currentProjectTab } from "./product-sections";
import type { RepoRoad } from "./project-form";
import type { ProjTab } from "./project-overview";

export interface ProjectTemplate {
  /** Stable id, stored on each project as `project.config.type`. */
  key: string;
  title: string;
  description: string;
  /** The brief the card starts with. */
  brief?: string;
  /** Where the project's code starts. Absent: none yet. */
  repository?: RepoRoad;
  /** A starter gear is written into that repository. */
  starter_gear?: boolean;
  /** The tabs a project from it shows, in the tab bar's own order.
   *  Absent: every tab. */
  tabs?: ProjTab[];
  /** The tab a project from it opens on. Absent: its first tab. */
  first_tab?: ProjTab;
  /** Kit slugs ticked by default on the New project card. */
  kits?: string[];
}

export interface ProjectTemplatesDoc {
  types: ProjectTemplate[];
}

/** The sources a stored template's old `recipe` created, read once. */
const FROM_RECIPE: Record<ProjectKind, Pick<ProjectTemplate, "repository" | "starter_gear">> = {
  new_gears: { repository: "new", starter_gear: true },
  product: { repository: "new" },
  existing: { repository: "existing" },
};

const ROADS = new Set<string>(["new", "existing", "none"]);

/** What every Studio offers when nobody has said otherwise. The keys are the
 *  old built-in types', so a project created as one still finds its template. */
export const BUILTIN_TEMPLATES: ProjectTemplate[] = [
  {
    key: "new_gears",
    title: "Write a gear",
    description: "A repository with a starter gear in it: a new one, or an existing gear store.",
    repository: "new",
    starter_gear: true,
  },
  {
    key: "product",
    title: "Start from a new repository",
    description: "A new repository for the project's code and its product.gdl.",
    repository: "new",
  },
  {
    key: "existing",
    title: "Bring a repository",
    description: "Attach a repository the project already has.",
    repository: "existing",
  },
];

/** Starting points for the editor. Each is only a filled-in form: saving one
 *  stores its copy, which the organization then edits as its own. */
export const PRESETS: { id: string; title: string; templates: ProjectTemplate[] }[] = [
  { id: "builtin", title: "Studio's built-in templates", templates: BUILTIN_TEMPLATES },
  {
    id: "learning",
    title: "Learning: students working with gears",
    templates: [
      {
        key: "build-with-gears",
        title: "Build something from gears",
        description:
          "Pick gears from the catalogue and put them together in an IDE session with an agent. A repository is created for you.",
        repository: "new",
        // Releases too: the product card sends its runs there.
        tabs: ["overview", "components", "parts", "sources", "releases", "kits", "people"],
        first_tab: "overview",
      },
      {
        key: "write-a-gear",
        title: "Write a gear",
        description: "Write your own gear from a starter, try it in an IDE session and see it build.",
        repository: "new",
        starter_gear: true,
        tabs: ["overview", "parts", "sources", "releases", "tests", "kits", "people"],
        first_tab: "overview",
      },
      {
        key: "bring-a-repository",
        title: "Bring my repository",
        description: "Attach a repository you already have and keep working on it here.",
        repository: "existing",
        tabs: ["overview", "sources", "parts", "artifacts", "activity", "people"],
        first_tab: "sources",
      },
    ],
  },
];

/** The templates a stored document holds, keeping only well-formed entries. A
 *  malformed document must not take the New project card down with it: what
 *  cannot be read is left out. No document at all means the built-in set; a
 *  document that lists none means none -- a template is optional. */
export function parseTemplates(raw: unknown, knownTabs: readonly string[]): ProjectTemplate[] {
  const list = raw && typeof raw === "object" ? (raw as { types?: unknown }).types : undefined;
  if (!Array.isArray(list)) return BUILTIN_TEMPLATES;
  const known = new Set(knownTabs);
  const seen = new Set<string>();
  const out: ProjectTemplate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const key = typeof t.key === "string" ? t.key.trim() : "";
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!key || !title || seen.has(key)) continue;
    seen.add(key);
    // A template saved as a project type names the recipe it created with.
    const legacy = typeof t.recipe === "string" ? FROM_RECIPE[t.recipe as ProjectKind] : undefined;
    const repository =
      typeof t.repository === "string" && ROADS.has(t.repository) ? (t.repository as RepoRoad) : legacy?.repository;
    const starter = typeof t.starter_gear === "boolean" ? t.starter_gear : legacy?.starter_gear;
    // A template saved before a tab moved names its old id (Builds, Deploys):
    // read as the tab that holds it now, once.
    const tabs = Array.isArray(t.tabs)
      ? ([...new Set(t.tabs.filter((x): x is string => typeof x === "string").map(currentProjectTab))].filter((x) =>
          known.has(x),
        ) as ProjTab[])
      : undefined;
    const firstTab = typeof t.first_tab === "string" ? currentProjectTab(t.first_tab) : "";
    const first = known.has(firstTab) ? (firstTab as ProjTab) : undefined;
    const kits = Array.isArray(t.kits) ? t.kits.filter((x): x is string => typeof x === "string" && x !== "") : undefined;
    const brief = typeof t.brief === "string" && t.brief.trim() ? t.brief : undefined;
    const hasRepo = !!repository && repository !== "none";
    out.push({
      key,
      title,
      description: typeof t.description === "string" ? t.description : "",
      ...(brief ? { brief } : {}),
      ...(hasRepo ? { repository } : {}),
      ...(starter && hasRepo ? { starter_gear: true } : {}),
      ...(tabs && tabs.length > 0 ? { tabs } : {}),
      ...(first ? { first_tab: first } : {}),
      ...(kits && kits.length > 0 ? { kits } : {}),
    });
  }
  return out;
}

/** What the card is filled in with when a template is picked; `null` -- no
 *  template -- starts it empty. */
export function templateDefaults(t: ProjectTemplate | null): {
  road: RepoRoad;
  starterGear: boolean;
  brief: string;
  kits: string[];
} {
  const road = t?.repository ?? "none";
  return { road, starterGear: !!t?.starter_gear && road !== "none", brief: t?.brief ?? "", kits: t?.kits ?? [] };
}

/** What a template fills in, in a line for the card and the editor. */
export function templateFills(t: ProjectTemplate): string {
  const road =
    t.repository === "new" ? "a new repository" : t.repository === "existing" ? "a repository attached" : "no repository yet";
  const parts = [t.starter_gear ? `${road} with a starter gear` : road];
  if (t.brief) parts.push("a brief");
  if (t.kits?.length) parts.push(`${t.kits.length} kit${t.kits.length === 1 ? "" : "s"}`);
  if (t.tabs) parts.push(`${t.tabs.length} tabs`);
  return `Fills in ${parts.join(", ")}.`;
}

/** Why a document cannot be saved, or null. The editor saves only what
 *  `parseTemplates` would read back unchanged. An empty list is fine: the
 *  card then offers no template, and every project starts empty. */
export function templatesProblem(templates: ProjectTemplate[]): string | null {
  const keys = new Set<string>();
  for (const t of templates) {
    if (!t.title.trim()) return "Every template needs a title.";
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(t.key)) return `“${t.title}”: the key may hold only a–z, 0–9, - and _.`;
    if (keys.has(t.key)) return `Two templates share the key “${t.key}”.`;
    keys.add(t.key);
    if (t.tabs && t.tabs.length === 0) return `“${t.title}” shows no tab at all.`;
    if (t.first_tab && t.tabs && !t.tabs.includes(t.first_tab)) return `“${t.title}” opens on a tab it does not show.`;
  }
  return null;
}

/** A key for a new template, from its title, not taken by any other. */
export function keyFor(title: string, taken: Iterable<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "template";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** The template a project was created from: by the key it kept, else -- for a
 *  project created as one of the old built-in types, which kept its kind --
 *  the built-in template of that key, which shows every tab. `null` for a
 *  project created without one. */
export function templateOfProject(
  config: { type?: string; kind?: ProjectKind } | null | undefined,
  templates: ProjectTemplate[],
): ProjectTemplate | null {
  if (!config) return null;
  const own = config.type ? templates.find((t) => t.key === config.type) : undefined;
  if (own) return own;
  return BUILTIN_TEMPLATES.find((t) => t.key === (config.kind ?? "")) ?? null;
}

/** The tabs a project shows: its template's, in the order `all` puts them. */
export function visibleTabs<T extends { id: ProjTab }>(all: readonly T[], template: ProjectTemplate | null): T[] {
  const keep = template?.tabs ? new Set(template.tabs) : null;
  const named = keep ? all.filter((t) => keep.has(t.id)) : [];
  const shown = named.length > 0 ? named : [...all];
  // Components is a section of Product (Parts) where a project has Product,
  // and a tab of its own only where it has not: two tabs read as one.
  return shown.some((t) => t.id === "components") ? shown.filter((t) => t.id !== "parts") : shown;
}

/** Where a project opens: its template's first tab, else the first it shows. */
export function landingTab(all: readonly { id: ProjTab }[], template: ProjectTemplate | null): ProjTab {
  const shown = visibleTabs(all, template);
  if (template?.first_tab && shown.some((t) => t.id === template.first_tab)) return template.first_tab;
  return shown[0]?.id ?? "overview";
}
