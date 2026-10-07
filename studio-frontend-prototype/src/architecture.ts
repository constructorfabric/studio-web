/* ── The /architecture/ page's model: what the running backend is, joined ──
 *
 * Three sources, each read from where it cannot drift:
 *
 *   - the manifest, `GET /cf/studio-assembly/v1/manifest` — the gears the
 *     backend process linked, in the order it starts them, with dependencies,
 *     origin, role and purpose (docs/design/studio-assembly.md);
 *   - `/cf/openapi.json` of the same backend — which REST paths each gear
 *     serves, and the tags /api-docs/ groups them under;
 *   - `prototype-map.json`, extracted from this prototype's sources when its
 *     bundle was built (scripts/prototype-api-map.mjs) — which screen calls
 *     which path.
 *
 * Everything here is pure, so the joins are tested without a backend.
 */

import { componentOf, componentTitle } from "./api-docs";
import type { OpenApiDoc } from "./api-docs";

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
}

export interface Manifest {
  build: { commit?: string | null; features: string[] };
  sessions_enabled: boolean;
  session_image?: string | null;
  gears: ManifestGear[];
}

export interface PrototypeScreen {
  name: string;
  file: string;
  paths: string[];
}

export interface PrototypeMap {
  commit?: string | null;
  screens: PrototypeScreen[];
}

/** Where a gear's REST surface is. */
export interface RestSurface {
  /** `/studio-tasks/v1`, … — the distinct `/<segment>/<version>` heads. */
  prefixes: string[];
  /** The `componentOf` value /api-docs/ filters on. */
  component: string;
  tags: string[];
  operations: number;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** The repository the design documents and commits live in. */
export const REPOSITORY = "https://github.com/constructorfabric/studio-web";

/**
 * Each gear's layer: 0 when it needs nothing that is linked, otherwise one
 * more than the deepest of its dependencies. A dependency on a gear that is
 * not in the list is ignored — the backend would not have started, so it is
 * not something to draw.
 */
export function layers(gears: ManifestGear[]): Map<string, number> {
  const byName = new Map(gears.map((g) => [g.name, g]));
  const out = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (name: string): number => {
    const known = out.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0; // a cycle cannot boot; do not loop on one
    visiting.add(name);
    const gear = byName.get(name);
    const deps = (gear?.depends_on ?? []).filter((d) => byName.has(d));
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth));
    visiting.delete(name);
    out.set(name, value);
    return value;
  };
  for (const gear of gears) depth(gear.name);
  return out;
}

/** The gears of each layer, in start order within a layer. */
export function layered(gears: ManifestGear[]): ManifestGear[][] {
  const depth = layers(gears);
  const rows: ManifestGear[][] = [];
  for (const gear of [...gears].sort((a, b) => a.order - b.order)) {
    const at = depth.get(gear.name) ?? 0;
    (rows[at] ??= []).push(gear);
  }
  return rows.map((row) => row ?? []);
}

/** Who names `name` in `depends_on`. */
export function dependents(gears: ManifestGear[], name: string): string[] {
  return gears.filter((g) => g.depends_on.includes(name)).map((g) => g.name);
}

/**
 * The gear that serves a path: the one named by the path's first segment
 * (rule A1: a gear mounts its routes under its own name), or else the one gear
 * whose name starts with that segment — `studio-identity` is served by
 * `studio-identity-directory`, `studio-llm` by `studio-llm-proxy`. Two such
 * gears, or none, and the path is nobody's: guessing would draw a line that
 * is not there.
 */
export function pathOwner(path: string, gearNames: string[]): string | null {
  const component = componentOf(path);
  if (!component) return null;
  if (gearNames.includes(component)) return component;
  const candidates = gearNames.filter((n) => n.startsWith(`${component}-`));
  return candidates.length === 1 ? candidates[0] : null;
}

/** Each gear's REST surface, read off the OpenAPI document. */
export function restSurfaces(
  doc: OpenApiDoc,
  gearNames: string[],
): {
  byGear: Map<string, RestSurface>;
  unowned: string[];
} {
  const byGear = new Map<string, RestSurface>();
  const unowned = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const owner = pathOwner(path, gearNames);
    const parts = path.split("/").filter(Boolean);
    const mounted = parts[0] === "api" ? 1 : 0;
    const head = "/" + parts.slice(0, mounted + 2).join("/");
    if (!owner) {
      unowned.add(head);
      continue;
    }
    const surface = byGear.get(owner) ?? {
      prefixes: [],
      component: componentOf(path),
      tags: [],
      operations: 0,
    };
    if (!surface.prefixes.includes(head)) surface.prefixes.push(head);
    for (const method of METHODS) {
      const op = (item as Record<string, unknown>)[method] as { tags?: string[] } | undefined;
      if (!op || typeof op !== "object") continue;
      surface.operations += 1;
      for (const tag of op.tags ?? []) if (!surface.tags.includes(tag)) surface.tags.push(tag);
    }
    byGear.set(owner, surface);
  }
  for (const surface of byGear.values()) {
    surface.prefixes.sort();
    surface.tags.sort();
  }
  return { byGear, unowned: [...unowned].sort() };
}

/** Which gears a screen calls, and which screens call a gear. */
export function joinPrototype(
  map: PrototypeMap,
  gearNames: string[],
): { gearsOf: Map<PrototypeScreen, string[]>; screensOf: Map<string, PrototypeScreen[]>; unowned: string[] } {
  const gearsOf = new Map<PrototypeScreen, string[]>();
  const screensOf = new Map<string, PrototypeScreen[]>();
  const unowned = new Set<string>();
  for (const screen of map.screens) {
    const gears: string[] = [];
    for (const path of screen.paths) {
      const owner = pathOwner(path, gearNames);
      if (!owner) {
        unowned.add(path);
        continue;
      }
      if (!gears.includes(owner)) gears.push(owner);
    }
    gears.sort();
    gearsOf.set(screen, gears);
    for (const gear of gears) {
      const list = screensOf.get(gear) ?? [];
      list.push(screen);
      screensOf.set(gear, list);
    }
  }
  return { gearsOf, screensOf, unowned: [...unowned].sort() };
}

/** True when both commits are known and they are not the same build. */
export function commitsDiffer(backend?: string | null, prototype?: string | null): boolean {
  return Boolean(backend && prototype && backend !== prototype);
}

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

/** `studio-artifact-ingest` → `Artifact Ingest`; a plugin keeps its last word. */
export function gearTitle(name: string): string {
  return componentTitle(name);
}

/** `OrgMembersView` → `Org members view`, as a sentence. */
export function screenTitle(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  // An acronym keeps its capitals (`StudioAI` → `Studio AI`).
  const lower = words
    .split(" ")
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(" ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `src/org-admin.tsx` → `Org admin`; `src/App.tsx` → `The portal shell`. */
export function fileTitle(file: string): string {
  const stem =
    file
      .split("/")
      .pop()
      ?.replace(/\.(tsx|ts)$/, "") ?? file;
  if (stem === "App") return "Portal shell (App.tsx)";
  const words = stem.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  plugins: number;
} {
  return {
    total: gears.length,
    studio: gears.filter((g) => g.origin === "studio").length,
    platform: gears.filter((g) => g.origin !== "studio").length,
    plugins: gears.filter((g) => g.role === "plugin").length,
  };
}
