import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { apiRegistry, useApiQuery } from '@gears-frontx/react';
import {
  AccountsApiService,
  CHILDREN_PAGE_LIMIT,
  childrenPageParams,
} from '../api/AccountsApiService';
import { type Page, type TenantDto } from '../api/types';
import { isProject, sortForTree } from '../model/project';
import { OrganizationProvider, useOrganization, type OrganizationRef } from './organization';
import { useBridge } from './bridge';

/**
 * The organization's tenant tree, fetched one node at a time.
 *
 * Why not one request: `/tenants/{id}/children` returns direct children only,
 * AM has no subtree endpoint and no `GET /tenants` collection, and `parent_id` /
 * `depth` are not in its OData allow-list — so a whole-organization read does
 * not exist to be called. The cheapest honest shape is therefore:
 *
 * * one request per *expanded* node, not per node — a collapsed branch costs
 *   nothing, and a node whose `child_count` is 0 costs nothing either;
 * * that request is **unfiltered** by `tenant_type`, so one page carries
 *   workspaces, projects and anything else at once and is partitioned
 *   client-side (`sortForTree`). Nesting is not assumed to be
 *   workspace → project: a workspace inside a workspace renders as one;
 * * **everything starts collapsed.** Only the organization's own children are
 *   fetched up front, because they are the screen; every level below waits for
 *   a click on its chevron. First paint is therefore 3 requests and no more,
 *   with no per-project metadata read at all — that one was the real N, one
 *   request per row. Re-opening a branch costs nothing: the page stays both in
 *   this context's state and in the shared React Query cache.
 *
 * The price is that the screen only knows the projects the user has opened a
 * branch to. Nothing pretends otherwise: there is no row count, and what the
 * shell's switcher gets is the open project's siblings — one workspace's page,
 * which is exactly what is loaded — not a list of "all projects".
 *
 * The queries live in components rather than in a loop because `useApiQuery`
 * takes a descriptor and has no `enabled` flag, and `useQueryCache()` exposes no
 * imperative fetch: "fetch once this node is expanded" has to be a mount.
 *
 * Server state stays in the shared React Query cache; this context holds only
 * the assembled shape. Freshness is refetch-driven — AM publishes no stream.
 */

export interface TreeRow {
  tenant: TenantDto;
  /** 0 = direct child of the organization. */
  level: number;
  /** Has children AM would return — the chevron is drawn from this. */
  expandable: boolean;
  expanded: boolean;
  /** Open, and its page has not arrived yet: the row below is a skeleton. */
  pending: boolean;
}

export interface ProjectTree {
  org: OrganizationRef | null;
  /** Depth-first, expansion honoured: exactly the rows a table should draw. */
  rows: TreeRow[];
  /**
   * The same walk with every loaded branch revealed, whatever its expansion
   * state. Search filters this one: a row the user has already seen must not
   * vanish because its parent happens to be collapsed.
   */
  searchRows: TreeRow[];
  /**
   * The projects that share a tenant's parent, current one included — what the
   * top bar's switcher offers while that project is open. Empty for a tenant
   * whose parent page is not loaded, which cannot happen for a row the user just
   * clicked: its branch had to be open for the row to exist.
   */
  siblingProjects: (tenantId: string) => TenantDto[];
  toggle: (tenantId: string) => void;
  loading: boolean;
  failed: boolean;
}

const NO_TOGGLE = () => undefined;
const NO_SIBLINGS = (): TenantDto[] => [];

const EMPTY: ProjectTree = {
  org: null,
  rows: [],
  searchRows: [],
  siblingProjects: NO_SIBLINGS,
  toggle: NO_TOGGLE,
  loading: true,
  failed: false,
};

const TreeContext = createContext<ProjectTree>(EMPTY);

export function useProjectTree(): ProjectTree {
  return useContext(TreeContext);
}

type ChildrenByParent = Record<string, TenantDto[]>;
type ChildrenAction = { parentId: string; items: TenantDto[] };

function childrenReducer(state: ChildrenByParent, action: ChildrenAction): ChildrenByParent {
  return { ...state, [action.parentId]: sortForTree(action.items) };
}

/** Closed is the default for every node, so an absent entry means collapsed. */
function expandedReducer(
  state: Record<string, boolean>,
  tenantId: string
): Record<string, boolean> {
  return { ...state, [tenantId]: !state[tenantId] };
}

/** Exported for tests: this is the whole visible-shape decision in one place. */
export function buildRows(
  orgId: string,
  children: ChildrenByParent,
  expanded: Record<string, boolean>,
  /** Ignore the expansion state and show every branch already in memory. */
  revealLoaded = false
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parentId: string, level: number): void => {
    for (const tenant of children[parentId] ?? []) {
      const loaded = children[tenant.id];
      // `child_count` counts soft-deleted children too, so it can promise a
      // branch that expands to nothing. Zero is a reliable leaf, and so is a
      // page that came back empty — demote it rather than leave a chevron that
      // opens onto nothing.
      const expandable = tenant.child_count > 0 && loaded?.length !== 0;
      const open = expandable && (revealLoaded ? loaded !== undefined : !!expanded[tenant.id]);
      rows.push({
        tenant,
        level,
        expandable,
        expanded: open,
        pending: open && loaded === undefined,
      });
      if (open) walk(tenant.id, level + 1);
    }
  };
  walk(orgId, 0);
  return rows;
}

/**
 * Re-orders siblings without flattening the tree.
 *
 * `rows` is a depth-first walk carrying a `level` per row, so a row's subtree is
 * simply the run that follows it at a deeper level. Sorting the flat array
 * directly would tear children away from their parent; this sorts each sibling
 * group and re-emits every subtree behind the row it belongs to.
 *
 * Exported for tests, and pure: the input array is never mutated.
 */
export function sortRows(
  rows: readonly TreeRow[],
  compare: (a: TenantDto, b: TenantDto) => number
): TreeRow[] {
  const walk = (from: number, level: number): [TreeRow[], number] => {
    const groups: { row: TreeRow; subtree: TreeRow[] }[] = [];
    let index = from;
    while (index < rows.length && rows[index].level === level) {
      const row = rows[index];
      const [subtree, next] = walk(index + 1, level + 1);
      groups.push({ row, subtree });
      index = next;
    }
    groups.sort((a, b) => compare(a.row.tenant, b.row.tenant));
    return [groups.flatMap((group) => [group.row, ...group.subtree]), index];
  };
  return walk(0, rows[0]?.level ?? 0)[0];
}

function warnIfTruncated(parentId: string, page: Page<TenantDto>): void {
  if (!page.page_info?.next_cursor) return;
  // Never truncate silently.
  console.warn(
    `[projects-mfe] tenant ${parentId} has more than ${CHILDREN_PAGE_LIMIT} children; ` +
      'only the first page is shown.'
  );
}

/** One unfiltered page of a node's children, pushed into the tree state. */
function useChildrenPage(
  parentId: string,
  onLoaded: (parentId: string, items: TenantDto[]) => void
): { isLoading: boolean; isError: boolean } {
  const accounts = apiRegistry.getService(AccountsApiService);
  const { data, isLoading, isError } = useApiQuery(
    accounts.children(childrenPageParams(parentId))
  );

  useEffect(() => {
    if (!data) return;
    warnIfTruncated(parentId, data);
    onLoaded(parentId, data.items);
  }, [data, onLoaded, parentId]);

  return { isLoading, isError };
}

/** Mounted only for expanded nodes; renders nothing, its job is its query. */
const NodeChildren: React.FC<{
  parentId: string;
  onLoaded: (parentId: string, items: TenantDto[]) => void;
}> = ({ parentId, onLoaded }) => {
  useChildrenPage(parentId, onLoaded);
  return null;
};

const WithOrg: React.FC<{ org: OrganizationRef; children: ReactNode }> = ({ org, children }) => {
  const [childrenByParent, loaded] = useReducer(childrenReducer, {});
  const [expandedOverrides, toggleExpanded] = useReducer(expandedReducer, {});

  const onLoaded = useCallback(
    (parentId: string, items: TenantDto[]) => loaded({ parentId, items }),
    []
  );
  const { isLoading, isError } = useChildrenPage(org.id, onLoaded);

  const rows = useMemo(
    () => buildRows(org.id, childrenByParent, expandedOverrides),
    [org.id, childrenByParent, expandedOverrides]
  );
  const searchRows = useMemo(
    () => buildRows(org.id, childrenByParent, expandedOverrides, true),
    [org.id, childrenByParent, expandedOverrides]
  );

  const toggle = useCallback((tenantId: string) => toggleExpanded(tenantId), []);

  /**
   * Siblings are read off the parent's own page — the one this MFE fetched when
   * the branch was expanded. Deliberately NOT "every project loaded so far": the
   * switcher moves sideways inside one workspace, and a flat list of everything
   * the session happens to have opened is neither that nor a complete list of
   * the organization's projects.
   */
  const siblingProjects = useCallback(
    (tenantId: string): TenantDto[] => {
      for (const page of Object.values(childrenByParent)) {
        if (page.some((candidate) => candidate.id === tenantId)) return page.filter(isProject);
      }
      return [];
    },
    [childrenByParent]
  );

  const value = useMemo<ProjectTree>(
    () => ({
      org,
      rows,
      searchRows,
      siblingProjects,
      toggle,
      // Only the organization's own page gates the screen; a node still in
      // flight shows as a row without children rather than as a spinner.
      loading: isLoading,
      failed: isError,
    }),
    [org, rows, searchRows, siblingProjects, toggle, isLoading, isError]
  );

  return (
    <TreeContext.Provider value={value}>
      {rows
        .filter((row) => row.expanded)
        .map((row) => (
          <NodeChildren key={row.tenant.id} parentId={row.tenant.id} onLoaded={onLoaded} />
        ))}
      {children}
    </TreeContext.Provider>
  );
};

/**
 * The tree exists only once an organization does. The answer comes from the
 * shell as a shared property (`shared/organization`) — the wizard needs the same
 * answer and runs in a different module graph, so neither root can hand it to
 * the other, but both can be told.
 */
const TreeForOrganization: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { org, loading, failed } = useOrganization();

  if (!org) {
    return (
      <TreeContext.Provider value={{ ...EMPTY, loading, failed }}>
        {children}
      </TreeContext.Provider>
    );
  }
  return <WithOrg org={org}>{children}</WithOrg>;
};

/**
 * The bridge comes from context here: this screen is rendered inside
 * `ProjectsRoot`'s `BridgeProvider`. The wizard, whose organization provider
 * sits above its own bridge provider, passes it as a prop instead.
 */
export const ProjectTreeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const bridge = useBridge();
  return (
    <OrganizationProvider bridge={bridge}>
      <TreeForOrganization>{children}</TreeForOrganization>
    </OrganizationProvider>
  );
};
