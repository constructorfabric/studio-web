/**
 * The portal's address: where the person is, as a path, and back.
 *
 * The shell's `Place` (App.tsx) is the whole of where someone is -- the
 * section, the workspace and project open in it, their tabs, the admin area
 * -- and it used to live only in sessionStorage, so nothing had an address:
 * no link could be shared, and Back did not go back. This is that same place
 * written into the URL. No router library: the place already is the route,
 * and the History API is all that writing it down needs.
 *
 *   /workspaces                                   the portfolio
 *   /workspaces/{ws}[/{workspaceTab}]              a workspace
 *   /workspaces/{ws}/projects/{project}[/{tab}]    a project
 *   /components, /people, /connections, …          a section
 *   /admin/{adminView}                             administration
 *   ?org={id}                                      the organization, on any of them
 *
 * `/space/{uuid}` (an open IDE) and the proxy prefixes `/cf/` and `/studio/`
 * are not this module's; `pathToPlace` answers nothing for them.
 */

// Project tabs that became a section of another (the Frontend tab is now
// Product › Frontend): an old address opens the tab that holds it, and the
// section scrolls itself into view (product-sections-view.tsx).
import { MOVED_PROJECT_TABS } from "./product-sections";

/** What of the shell's Place an address carries. */
export interface UrlPlace {
  view: string;
  crumb: { projectId?: string; nestedId?: string };
  projectTab: string;
  workspaceTab: string;
  activeOrgId: string | null;
  adminOpen: boolean;
  adminView: string;
}

/** The shell's sections and the path each has. `projects` is the portfolio of workspaces. */
export const VIEW_PATHS = {
  projects: "workspaces",
  people: "people",
  connectors: "connections",
  environments: "environments",
  costs: "costs",
  gears: "components",
  platform: "platform",
  publications: "publication-requests",
  "platform-sources": "platform-sources",
  "org-sources": "sources",
  org: "organization",
  reports: "reports",
  tasks: "background-work",
  system: "system",
  profile: "profile",
} as const;

/** Sections that moved into administration, by their old path. A link
 *  someone kept still lands on the same screen, now under `/admin/`. */
const MOVED_TO_ADMIN: Record<string, string> = { objects: "objects", views: "views" };

/** What each part of a path may name; anything else is not an address of ours. */
export interface KnownPlaces {
  projectTabs: readonly string[];
  workspaceTabs: readonly string[];
  adminViews: readonly string[];
}

/** The tabs a place opens on when its address does not name one. */
export const DEFAULT_PROJECT_TAB = "overview";
export const DEFAULT_WORKSPACE_TAB = "projects";

const ID = /^[0-9A-Za-z_-][0-9A-Za-z_.:-]{0,127}$/;
const seg = (value: string) => encodeURIComponent(value);

export function placeToPath(place: UrlPlace): string {
  let path: string;
  if (place.adminOpen) {
    path = `/admin/${seg(place.adminView)}`;
  } else if (place.view === "projects" && place.crumb.projectId) {
    path = `/workspaces/${seg(place.crumb.projectId)}`;
    if (place.crumb.nestedId) {
      path += `/projects/${seg(place.crumb.nestedId)}`;
      if (place.projectTab !== DEFAULT_PROJECT_TAB) path += `/${seg(place.projectTab)}`;
    } else if (place.workspaceTab !== DEFAULT_WORKSPACE_TAB) {
      path += `/${seg(place.workspaceTab)}`;
    }
  } else {
    path = `/${VIEW_PATHS[place.view as keyof typeof VIEW_PATHS] ?? VIEW_PATHS.projects}`;
  }
  return place.activeOrgId ? `${path}?org=${seg(place.activeOrgId)}` : path;
}

/**
 * The place an address names, or undefined when it is not one of ours -- the
 * root, an IDE space, a proxy path, a tab or section this build does not
 * have. Undefined means "keep whatever else the shell knows", never "reset".
 */
export function pathToPlace(pathname: string, search: string, known: KnownPlaces): Partial<UrlPlace> | undefined {
  const parts = pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return "\u0000";
    }
  });
  if (parts.length === 0 || parts.some((p) => p.includes("\u0000"))) return undefined;
  const org = new URLSearchParams(search).get("org");
  const withOrg = (place: Partial<UrlPlace>): Partial<UrlPlace> =>
    org && ID.test(org) ? { ...place, activeOrgId: org } : place;

  const [head, ...rest] = parts;
  if (head === "admin") {
    const [adminView] = rest;
    if (rest.length !== 1 || !known.adminViews.includes(adminView)) return undefined;
    return withOrg({ adminOpen: true, adminView });
  }
  if (head === "workspaces" && rest.length > 0) {
    const [ws, second, project, tab] = rest;
    if (!ID.test(ws)) return undefined;
    if (second === "projects" && project !== undefined) {
      if (!ID.test(project) || rest.length > 4) return undefined;
      const projectTab = (tab !== undefined ? MOVED_PROJECT_TABS[tab]?.tab : undefined) ?? tab ?? DEFAULT_PROJECT_TAB;
      if (!known.projectTabs.includes(projectTab)) return undefined;
      return withOrg({ view: "projects", adminOpen: false, crumb: { projectId: ws, nestedId: project }, projectTab });
    }
    if (rest.length > 2) return undefined;
    const workspaceTab = second ?? DEFAULT_WORKSPACE_TAB;
    if (!known.workspaceTabs.includes(workspaceTab)) return undefined;
    return withOrg({ view: "projects", adminOpen: false, crumb: { projectId: ws }, workspaceTab });
  }
  if (rest.length > 0) return undefined;
  if (head in MOVED_TO_ADMIN) return withOrg({ adminOpen: true, adminView: MOVED_TO_ADMIN[head] });
  const view = (Object.keys(VIEW_PATHS) as (keyof typeof VIEW_PATHS)[]).find((v) => VIEW_PATHS[v] === head);
  if (!view) return undefined;
  return withOrg({ view, adminOpen: false, crumb: {} });
}
