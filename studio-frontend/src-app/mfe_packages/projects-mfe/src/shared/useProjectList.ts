/**
 * The rows the list screen draws: the tenant tree, narrowed by the toolbar's
 * search and ordered by its sort.
 *
 * Both are client-side and neither touches the network — see
 * `ProjectSortOption` in `model/project.ts` for why asking AM to sort would buy
 * nothing. The screen owns the two values as plain state and passes them in;
 * there is no slice, because the toolbar and the table are children of the same
 * component and have no router between them.
 */

import { useMemo } from 'react';
import { tenantComparator, type ProjectSortOption } from '../model/project';
import { sortRows, useProjectTree, type TreeRow } from './projectTree';

export interface ProjectListView {
  /** Ready to render, in order. */
  rows: TreeRow[];
  loading: boolean;
  failed: boolean;
  org: ReturnType<typeof useProjectTree>['org'];
  toggle: (tenantId: string) => void;
}

/**
 * Search keeps every match plus its whole ancestor chain, so a match is never
 * orphaned from the branch it lives in, and it runs over `searchRows` — every
 * branch already in memory, collapsed or not. Collapsing a workspace must not
 * hide a project the user could see a second ago. What search still cannot
 * reach is a branch nobody has expanded yet: those pages have not been fetched,
 * and AM has no way to fetch a subtree in one call.
 */
function filterByQuery(
  rows: readonly TreeRow[],
  searchRows: readonly TreeRow[],
  query: string
): readonly TreeRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;

  const byId = new Map(searchRows.map((row) => [row.tenant.id, row]));
  const keep = new Set<string>();
  for (const row of searchRows) {
    if (!row.tenant.name.toLowerCase().includes(needle)) continue;
    keep.add(row.tenant.id);
    let ancestor = row.tenant.parent_id;
    while (ancestor && byId.has(ancestor) && !keep.has(ancestor)) {
      keep.add(ancestor);
      ancestor = byId.get(ancestor)?.tenant.parent_id;
    }
  }
  return searchRows.filter((row) => keep.has(row.tenant.id));
}

export function useProjectList(query: string, sort: ProjectSortOption): ProjectListView {
  const { loading, failed, org, rows, searchRows, toggle } = useProjectTree();

  const visible = useMemo(() => {
    // Filter first: sorting is per sibling group, and dropping a row can only
    // shrink a group, never reorder one.
    const matched = filterByQuery(rows, searchRows, query);
    return sortRows(matched, tenantComparator(sort));
  }, [rows, searchRows, query, sort]);

  return { rows: visible, loading, failed, org, toggle };
}
