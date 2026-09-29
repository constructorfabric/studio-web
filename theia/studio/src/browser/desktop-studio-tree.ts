// What the desktop Studio view draws, decided without a DOM (ADR-0027).
//
// The view lists the member's organizations, their workspaces and the projects
// nested in those, as `desktop-projects.ts` finds them. Everything that decides
// something about that list lives here, next to its tests: how two
// organizations with one name are told apart, which rows a filter leaves, which
// rows are collapsed (and how that is remembered per Studio), where the focus
// goes on a key, what a project's sources listing says about it, and where the
// portal shows a project.

import type { Organization, Tenant, Workspace } from './desktop-projects';

export type RowKind = 'organization' | 'workspace' | 'project';

/** One line of the tree, in the order it is drawn. */
export interface TreeRow {
    readonly kind: RowKind;
    readonly id: string;
    readonly name: string;
    /** What tells this organization apart from another of the same name. */
    readonly hint?: string;
    /** 1 for the top level, as `aria-level` counts. */
    readonly level: number;
    readonly parentId?: string;
    /** Whether it has rows under it at all. */
    readonly expandable: boolean;
    /** Whether they are shown; always true while a filter is typed. */
    readonly expanded: boolean;
    /** The folder a project is checked out to (workspaces and projects only). */
    readonly folder?: string;
    /** The tenants above it, for the portal link and the card. */
    readonly organizationId: string;
    readonly workspaceId?: string;
}

/** How many characters of a tenant id tell it apart, at least. */
const SHORT_ID = 8;

const sameName = (name: string) => name.trim().toLocaleLowerCase();

/**
 * What to show next to an organization's name when another one the member sees
 * has the same name: the start of its tenant id, long enough to differ, and the
 * member's role in it when the roles differ. No hint when the name is
 * unique — the name alone is what the portal shows.
 */
export function organizationHints(organizations: readonly Organization[]): Map<string, string> {
    const byName = new Map<string, Organization[]>();
    for (const org of organizations) {
        const key = sameName(org.name);
        byName.set(key, [...(byName.get(key) ?? []), org]);
    }
    const hints = new Map<string, string>();
    for (const group of byName.values()) {
        if (group.length < 2) {
            continue;
        }
        const ids = group.map(org => org.id.replace(/-/g, ''));
        let length = SHORT_ID;
        while (length < 32 && new Set(ids.map(id => id.slice(0, length))).size < ids.length) {
            length += 4;
        }
        const rolesDiffer = new Set(group.map(org => org.role ?? '')).size > 1;
        group.forEach((org, i) => {
            // The id first: it is what always differs, and what is left when the row is narrow.
            const parts = [ids[i].slice(0, length), rolesDiffer && org.role ? org.role : undefined];
            hints.set(org.id, parts.filter(Boolean).join(' · '));
        });
    }
    return hints;
}

/** The folder a project is cloned to: nested ones under their workspace's name too. */
export function folderOf(workspace: Tenant, project?: Tenant): string {
    return project ? `${workspace.name} - ${project.name}` : workspace.name;
}

export interface TreeOptions {
    /** Names to keep, case-insensitively; empty keeps everything. */
    readonly filter?: string;
    /** Rows the member closed. */
    readonly collapsed?: ReadonlySet<string>;
}

const matches = (name: string, needle: string) => !needle || name.toLocaleLowerCase().includes(needle);

/**
 * The rows to draw. The organizations are a level of their own only when there
 * is more than one — the portal hides them otherwise (concept v2).
 *
 * A filter keeps a row whose name matches, everything under it, and the rows
 * above it, and shows them all expanded: what was typed is what the member is
 * looking for, whatever they had closed before.
 */
export function treeRows(organizations: readonly Organization[], options: TreeOptions = {}): TreeRow[] {
    const needle = (options.filter ?? '').trim().toLocaleLowerCase();
    const collapsed = options.collapsed ?? new Set<string>();
    const filtering = needle.length > 0;
    const showOrgs = organizations.length > 1;
    const hints = organizationHints(organizations);
    const rows: TreeRow[] = [];
    const open = (id: string) => filtering || !collapsed.has(id);

    for (const org of organizations) {
        const orgMatches = matches(org.name, needle);
        const workspaces: Array<{ ws: Workspace; nested: Tenant[]; keep: boolean }> = org.projects.map(ws => {
            const wsMatches = orgMatches || matches(ws.name, needle);
            const nested = wsMatches ? ws.nested : ws.nested.filter(p => matches(p.name, needle));
            return { ws, nested, keep: wsMatches || nested.length > 0 };
        }).filter(w => w.keep);
        if (filtering && !orgMatches && workspaces.length === 0) {
            continue;
        }
        const orgLevel = showOrgs ? 1 : 0;
        const orgOpen = !showOrgs || open(org.id);
        if (showOrgs) {
            rows.push({
                kind: 'organization', id: org.id, name: org.name, hint: hints.get(org.id), level: 1,
                expandable: org.projects.length > 0, expanded: org.projects.length > 0 && orgOpen, organizationId: org.id,
            });
        }
        if (!orgOpen) {
            continue;
        }
        for (const { ws, nested } of workspaces) {
            const wsOpen = open(ws.id);
            rows.push({
                kind: 'workspace', id: ws.id, name: ws.name, level: orgLevel + 1, parentId: showOrgs ? org.id : undefined,
                expandable: ws.nested.length > 0, expanded: ws.nested.length > 0 && wsOpen,
                folder: folderOf(ws), organizationId: org.id,
            });
            if (!wsOpen) {
                continue;
            }
            for (const project of nested) {
                rows.push({
                    kind: 'project', id: project.id, name: project.name, level: orgLevel + 2, parentId: ws.id,
                    expandable: false, expanded: false, folder: folderOf(ws, project),
                    organizationId: org.id, workspaceId: ws.id,
                });
            }
        }
    }
    return rows;
}

/** Whether a filter left nothing, as opposed to there being nothing. */
export function filteredOutEverything(organizations: readonly Organization[], filter: string): boolean {
    return filter.trim().length > 0 && treeRows(organizations, { filter }).length === 0;
}

// --- collapse state, remembered per Studio ---------------------------------

/** Where the view keeps which rows are closed, one entry per Studio. */
export function collapsedStorageKey(studioUrl: string | undefined): string {
    return `studio.desktop.tree.collapsed:${(studioUrl ?? '').replace(/\/+$/, '')}`;
}

/** Read what was stored; anything that is not a list of ids is nothing. */
export function parseCollapsed(stored: unknown): Set<string> {
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
}

export function toggleCollapsed(collapsed: ReadonlySet<string>, id: string, expand?: boolean): Set<string> {
    const next = new Set(collapsed);
    const close = expand === undefined ? !next.has(id) : !expand;
    if (close) {
        next.add(id);
    } else {
        next.delete(id);
    }
    return next;
}

/** Drop the ids of rows that are gone, so the stored list does not grow forever. */
export function pruneCollapsed(collapsed: ReadonlySet<string>, organizations: readonly Organization[]): Set<string> {
    const known = new Set<string>();
    for (const org of organizations) {
        known.add(org.id);
        org.projects.forEach(ws => known.add(ws.id));
    }
    return new Set([...collapsed].filter(id => known.has(id)));
}

// --- keyboard --------------------------------------------------------------

/** What a key does in the tree (WAI-ARIA tree view pattern). */
export type TreeKeyAction =
    | { readonly type: 'focus'; readonly id: string }
    | { readonly type: 'expand'; readonly id: string }
    | { readonly type: 'collapse'; readonly id: string }
    | { readonly type: 'activate'; readonly id: string }
    | undefined;

export function treeKey(rows: readonly TreeRow[], currentId: string | undefined, key: string): TreeKeyAction {
    if (rows.length === 0) {
        return undefined;
    }
    const index = rows.findIndex(r => r.id === currentId);
    const row = index >= 0 ? rows[index] : undefined;
    const focus = (i: number): TreeKeyAction => ({ type: 'focus', id: rows[Math.max(0, Math.min(rows.length - 1, i))].id });
    switch (key) {
        case 'ArrowDown':
            return focus(index + 1);
        case 'ArrowUp':
            return focus(index < 0 ? 0 : index - 1);
        case 'Home':
            return focus(0);
        case 'End':
            return focus(rows.length - 1);
        case 'ArrowRight':
            if (!row) {
                return focus(0);
            }
            if (row.expandable && !row.expanded) {
                return { type: 'expand', id: row.id };
            }
            return row.expandable ? focus(index + 1) : undefined;
        case 'ArrowLeft':
            if (!row) {
                return undefined;
            }
            if (row.expandable && row.expanded) {
                return { type: 'collapse', id: row.id };
            }
            return row.parentId ? { type: 'focus', id: row.parentId } : undefined;
        case 'Enter':
        case ' ':
            return row ? { type: 'activate', id: row.id } : undefined;
        default:
            return undefined;
    }
}

// --- where a project is ----------------------------------------------------

/** A project located in the tree: its organization, its workspace, and itself when nested. */
export interface Located {
    readonly organization: Organization;
    readonly workspace: Workspace;
    readonly project?: Tenant;
}

export function locate(organizations: readonly Organization[] | undefined, id: string | undefined): Located | undefined {
    if (!id) {
        return undefined;
    }
    for (const organization of organizations ?? []) {
        for (const workspace of organization.projects) {
            if (workspace.id === id) {
                return { organization, workspace };
            }
            const project = workspace.nested.find(p => p.id === id);
            if (project) {
                return { organization, workspace, project };
            }
        }
    }
    return undefined;
}

/** Every workspace and nested project, in tree order: what the view asks the sources of. */
export function openableIds(organizations: readonly Organization[]): string[] {
    return organizations.flatMap(org => org.projects.flatMap(ws => [ws.id, ...ws.nested.map(p => p.id)]));
}

// --- what a project's sources listing says ---------------------------------

/**
 * Whether a project can be opened, learned before the click from the same
 * listing the open itself starts with (`studio-git` `GET /sources`):
 * `ready` with the number of repositories a desktop can clone, `empty` when it
 * has none yet, `unknown` when the listing could not say — and then the click
 * stays, and its own error is shown on the row.
 */
export type SourcesState =
    | { readonly state: 'ready'; readonly repositories: number }
    | { readonly state: 'empty' }
    | { readonly state: 'unknown' };

/**
 * Read a `studio-git` sources answer. A 404 that names the project is studio-git
 * saying the project has no settings for it, or none this member can read; the
 * view lists only projects the member can read, so for a row it is "no sources
 * yet" — the same reading the IDE backend makes before it says so on open. A 404
 * that names nothing is the gateway's (no studio-git), which says nothing about
 * the project.
 */
export function sourcesStateOf(status: number, body: unknown): SourcesState {
    if (status === 200) {
        const page = body as { items?: unknown[]; total?: number } | undefined;
        const count = typeof page?.total === 'number' ? page.total : Array.isArray(page?.items) ? page!.items!.length : undefined;
        if (count === undefined) {
            return { state: 'unknown' };
        }
        return count > 0 ? { state: 'ready', repositories: count } : { state: 'empty' };
    }
    if (status === 404) {
        const named = !!(body as { context?: { resource_name?: string } } | undefined)?.context?.resource_name;
        return named ? { state: 'empty' } : { state: 'unknown' };
    }
    return { state: 'unknown' };
}

// --- the portal ------------------------------------------------------------

/**
 * Where the portal shows a workspace, or a project nested in it: the shell's
 * one address (studio-frontend `app/routing/route.ts`, ADR-0028), e.g.
 * `https://studio.example.com/?screen=projects;org=<o>;workspace=<w>;project=<p>`.
 */
export function portalUrl(studioUrl: string, where: { organization: string; workspace: string; project?: string }): string {
    const params = [`screen=projects`, `org=${encodeURIComponent(where.organization)}`, `workspace=${encodeURIComponent(where.workspace)}`];
    if (where.project) {
        params.push(`project=${encodeURIComponent(where.project)}`);
    }
    return `${studioUrl.replace(/\/+$/, '')}/?${params.join(';')}`;
}

/** The Studio a header names: "Dev · studio-dev.cfabric.org", or the host alone. */
export function studioLabel(studioUrl: string | undefined, environment?: { id: string; label: string }): { name?: string; host: string } {
    const host = (studioUrl ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const named = environment && environment.id !== 'custom' && environment.id !== 'pinned' ? environment.label : undefined;
    return { name: named, host };
}
