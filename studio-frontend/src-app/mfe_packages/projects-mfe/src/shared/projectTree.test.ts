import { describe, expect, it } from 'vitest';
import { buildRows, sortRows } from './projectTree';
import { TENANT_TYPES, type TenantDto } from '../api/types';
import { sortForTree, tenantComparator } from '../model/project';

const ORG = 'org-1';

function tenant(
  id: string,
  tenantType: string,
  parentId: string,
  childCount = 0
): TenantDto {
  return {
    id,
    name: id,
    status: 'active',
    tenant_type: tenantType,
    parent_id: parentId,
    self_managed: false,
    depth: 1,
    child_count: childCount,
    created_at: '2026-07-14T09:12:00Z',
    updated_at: '2026-07-14T09:12:00Z',
  };
}

const workspace = tenant('ws', TENANT_TYPES.workspace, ORG, 2);
const nested = tenant('nested-ws', TENANT_TYPES.workspace, 'ws', 1);
const project = tenant('proj', TENANT_TYPES.project, ORG);
const childProject = tenant('child-proj', TENANT_TYPES.project, 'ws');
const grandchild = tenant('grandchild', TENANT_TYPES.project, 'nested-ws');

/** What every parent's page would hold once fetched. */
const LOADED = {
  [ORG]: sortForTree([project, workspace]),
  ws: sortForTree([childProject, nested]),
  'nested-ws': [grandchild],
};

describe('sortForTree', () => {
  it('puts workspaces before projects and keeps server order inside a group', () => {
    const second = { ...workspace, id: 'ws-2' };
    expect(sortForTree([project, workspace, second]).map((t) => t.id)).toEqual([
      'ws',
      'ws-2',
      'proj',
    ]);
  });
});

describe('buildRows', () => {
  it('starts with every branch closed, whatever is already loaded', () => {
    const rows = buildRows(ORG, LOADED, {});

    // Sorted by type: the workspace comes before the project that shares its
    // parent. Nothing is open, so no descendant is part of the shape and no
    // request is derived from one.
    expect(rows.map((row) => [row.tenant.id, row.level, row.expanded])).toEqual([
      ['ws', 0, false],
      ['proj', 0, false],
    ]);
  });

  it('opens exactly the branch that was toggled', () => {
    const rows = buildRows(ORG, LOADED, { ws: true });

    expect(rows.map((row) => [row.tenant.id, row.level])).toEqual([
      ['ws', 0],
      ['nested-ws', 1],
      ['child-proj', 1],
      ['proj', 0],
    ]);
  });

  it('opens a deeper branch only when it is toggled too', () => {
    const rows = buildRows(ORG, LOADED, { ws: true, 'nested-ws': true });

    expect(rows.map((row) => row.tenant.id)).toEqual([
      'ws',
      'nested-ws',
      'grandchild',
      'child-proj',
      'proj',
    ]);
  });

  it('closes a branch again when it is toggled off', () => {
    const rows = buildRows(ORG, LOADED, { ws: false });

    expect(rows.map((row) => row.tenant.id)).toEqual(['ws', 'proj']);
  });

  it('marks a childless tenant as a leaf, so no request is derived from it', () => {
    const rows = buildRows(ORG, LOADED, {});
    const leaf = rows.find((row) => row.tenant.id === 'proj');

    expect(leaf?.expandable).toBe(false);
    expect(leaf?.expanded).toBe(false);
  });
});

describe('buildRows, revealLoaded', () => {
  it('shows every loaded branch whatever its expansion state', () => {
    // What search runs over: `nested-ws` is collapsed, but its page is in
    // memory, so the project inside it must still be findable.
    const rows = buildRows(ORG, LOADED, { ws: false }, true);

    expect(rows.map((row) => row.tenant.id)).toEqual([
      'ws',
      'nested-ws',
      'grandchild',
      'child-proj',
      'proj',
    ]);
  });

  it('does not claim a branch is open when its page is not loaded yet', () => {
    const rows = buildRows(ORG, { [ORG]: [workspace] }, {}, true);

    expect(rows.map((row) => [row.tenant.id, row.expanded, row.pending])).toEqual([
      ['ws', false, false],
    ]);
  });
});

describe('buildRows, pending and empty branches', () => {
  it('marks an open branch whose page has not arrived', () => {
    const rows = buildRows(ORG, { [ORG]: [workspace] }, { ws: true });

    expect(rows).toEqual([
      { tenant: workspace, level: 0, expandable: true, expanded: true, pending: true },
    ]);
  });

  it('demotes a branch whose page came back empty to a leaf', () => {
    const rows = buildRows(ORG, { [ORG]: [workspace], ws: [] }, { ws: true });

    expect(rows.map((row) => [row.tenant.id, row.expandable, row.pending])).toEqual([
      ['ws', false, false],
    ]);
  });
});

describe('sortRows', () => {
  /**
   * Two workspaces, each with two projects, laid out depth-first the way
   * `buildRows` emits them. Named so the expected order is readable: `b-ws`
   * updated later than `a-ws`, and inside each the projects disagree.
   */
  const at = (base: TenantDto, id: string, updatedAt: string): TenantDto => ({
    ...base,
    id,
    name: id,
    updated_at: updatedAt,
  });

  const aWs = at(tenant('a-ws', TENANT_TYPES.workspace, ORG, 2), 'a-ws', '2026-01-01T00:00:00Z');
  const bWs = at(tenant('b-ws', TENANT_TYPES.workspace, ORG, 2), 'b-ws', '2026-06-01T00:00:00Z');
  const a1 = at(tenant('a1', TENANT_TYPES.project, 'a-ws'), 'a1', '2026-02-01T00:00:00Z');
  const a2 = at(tenant('a2', TENANT_TYPES.project, 'a-ws'), 'a2', '2026-05-01T00:00:00Z');
  const b1 = at(tenant('b1', TENANT_TYPES.project, 'b-ws'), 'b1', '2026-03-01T00:00:00Z');
  const b2 = at(tenant('b2', TENANT_TYPES.project, 'b-ws'), 'b2', '2026-04-01T00:00:00Z');

  const rows = buildRows(
    ORG,
    { [ORG]: [aWs, bWs], 'a-ws': [a1, a2], 'b-ws': [b1, b2] },
    { 'a-ws': true, 'b-ws': true }
  );

  const ids = (sorted: { tenant: TenantDto }[]): string[] =>
    sorted.map((row) => row.tenant.id);

  it('keeps every child behind its own parent', () => {
    // b-ws is the more recent workspace, so it leads — but its projects move
    // with it rather than being interleaved with a-ws's.
    expect(ids(sortRows(rows, tenantComparator('recent')))).toEqual([
      'b-ws',
      'b2',
      'b1',
      'a-ws',
      'a2',
      'a1',
    ]);
  });

  it('reverses only within each sibling group for the opposite order', () => {
    expect(ids(sortRows(rows, tenantComparator('oldest')))).toEqual([
      'a-ws',
      'a1',
      'a2',
      'b-ws',
      'b1',
      'b2',
    ]);
  });

  it('sorts a workspace ahead of a project whatever the option says', () => {
    // `z-ws` loses on every name and timestamp comparison and still leads:
    // containers are the primary key, or the tree reads as broken.
    const zWs = at(tenant('z-ws', TENANT_TYPES.workspace, ORG), 'z-ws', '2020-01-01T00:00:00Z');
    const aProj = at(tenant('a-proj', TENANT_TYPES.project, ORG), 'a-proj', '2030-01-01T00:00:00Z');
    const flat = buildRows(ORG, { [ORG]: [aProj, zWs] }, {});

    expect(ids(sortRows(flat, tenantComparator('alphabetical')))).toEqual(['z-ws', 'a-proj']);
    expect(ids(sortRows(flat, tenantComparator('recent')))).toEqual(['z-ws', 'a-proj']);
  });

  it('does not mutate its input', () => {
    const before = ids(rows);
    sortRows(rows, tenantComparator('alphabetical'));
    expect(ids(rows)).toEqual(before);
  });

  it('survives an empty list', () => {
    expect(sortRows([], tenantComparator('recent'))).toEqual([]);
  });
});
