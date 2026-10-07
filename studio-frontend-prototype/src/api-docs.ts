/* ── The backend's API, grouped by the component that serves it ─────────────
 *
 * `/cf/openapi.json` is assembled by the platform's API gateway from every
 * gear in the binary. It tags operations, but declares no tag list and no
 * grouping, so a viewer shows forty tags in one flat run with nothing saying
 * which gear each belongs to.
 *
 * The grouping is recovered here, on our side, from what the document already
 * says: a gear mounts its routes under its own first path segment
 * (studio-git/v1/…, account-management/v1/…; api/file-storage/… is
 * the one gear one level down). Each such prefix is a component, its
 * operations' tags are its sections, and `x-tagGroups` carries that to the
 * viewer. Nothing in the toolkit changes, and a gear added tomorrow lands in a
 * group of its own without an edit here.
 */

type Operation = { tags?: string[]; [key: string]: unknown };
type PathItem = Record<string, unknown>;

export interface OpenApiDoc {
  paths?: Record<string, PathItem>;
  tags?: { name: string; description?: string }[];
  "x-tagGroups"?: TagGroup[];
  [key: string]: unknown;
}

export interface TagGroup {
  name: string;
  tags: string[];
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Prefixes that are one gear's mount point rather than the gear itself. */
const MOUNTS = new Set(["api"]);

/** Words a component name spells in capitals. */
const ACRONYMS = new Set(["api", "authz", "sdk", "oagw", "llm", "id"]);

/** The component a path belongs to: its first segment, or the second under a
 *  shared mount. `""` for a path with no segment at all. */
export function componentOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 1 && MOUNTS.has(parts[0])) return parts[1];
  return parts[0] ?? "";
}

/** Studio's own gears, as opposed to the platform's. */
export function isStudio(component: string): boolean {
  return component.startsWith("studio-") || component === "spec-quality";
}

/** `studio-artifact-ingest` → `Artifact Ingest`, `authz-resolver` → `AuthZ Resolver`. */
export function componentTitle(component: string): string {
  const bare = component.replace(/^studio-/, "");
  return bare
    .split("-")
    .filter(Boolean)
    .map((w) => (w === "authz" ? "AuthZ" : ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** How a tag reads in the viewer: Studio's gears tag in one CamelCase word
 *  (`StudioArtifactIngest`), which under a "Studio · …" group says "Studio"
 *  twice and runs the rest together. The tag itself is not renamed. */
export function tagTitle(tag: string): string {
  if (!/^Studio[A-Z]/.test(tag)) return tag;
  return tag.slice("Studio".length).replace(/([a-z])([A-Z])/g, "$1 $2");
}

function groupName(component: string): string {
  return `${isStudio(component) ? "Studio" : "Platform"} · ${componentTitle(component)}`;
}

/** The document with every operation tagged and its tags grouped by component.
 *  An untagged operation takes its component's title as its tag. A tag used
 *  by two components belongs to the one with more of its operations: a viewer
 *  shows a tag in one group only. The input is not modified. */
export function groupByComponent(doc: OpenApiDoc): OpenApiDoc {
  const paths: Record<string, PathItem> = {};
  // tag → component → operations under it
  const uses = new Map<string, Map<string, number>>();
  const firstSeen: string[] = [];

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const component = componentOf(path);
    const next: PathItem = { ...item };
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op || typeof op !== "object") continue;
      const tags = op.tags?.length ? op.tags : [componentTitle(component) || "Other"];
      next[method] = { ...op, tags };
      for (const tag of tags) {
        if (!uses.has(tag)) {
          uses.set(tag, new Map());
          firstSeen.push(tag);
        }
        const byComponent = uses.get(tag)!;
        byComponent.set(component, (byComponent.get(component) ?? 0) + 1);
      }
    }
    paths[path] = next;
  }

  const groups = new Map<string, TagGroup>();
  for (const tag of firstSeen) {
    let owner = "";
    let most = -1;
    for (const [component, n] of uses.get(tag)!) {
      if (n > most) {
        owner = component;
        most = n;
      }
    }
    const name = groupName(owner);
    if (!groups.has(name)) groups.set(name, { name, tags: [] });
    groups.get(name)!.tags.push(tag);
  }

  // The platform first, then Studio; by name within each.
  const ordered = [...groups.values()].sort((a, b) => {
    const studio = Number(a.name.startsWith("Studio")) - Number(b.name.startsWith("Studio"));
    return studio || a.name.localeCompare(b.name);
  });
  for (const group of ordered) group.tags.sort((a, b) => a.localeCompare(b));

  const described = new Map((doc.tags ?? []).map((t) => [t.name, t]));
  const tags = ordered.flatMap((g) =>
    g.tags.map((name) => {
      const tag = described.get(name) ?? { name };
      const shown = tagTitle(name);
      return shown === name || "x-displayName" in tag ? tag : { ...tag, "x-displayName": shown };
    }),
  );

  return { ...doc, paths, tags, "x-tagGroups": ordered };
}

/** The document narrowed to one component's paths — how /architecture/ opens
 *  this page on one gear (`/api-docs/?component=studio-tasks`). An unknown
 *  component leaves an empty document, which the viewer shows as such rather
 *  than as the whole API under a misleading title. */
export function onlyComponent(doc: OpenApiDoc, component: string): OpenApiDoc {
  const paths = Object.fromEntries(
    Object.entries(doc.paths ?? {}).filter(([path]) => componentOf(path) === component),
  );
  return { ...doc, paths };
}
