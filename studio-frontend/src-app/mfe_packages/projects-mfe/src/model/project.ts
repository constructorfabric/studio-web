/**
 * Tenants + their metadata -> what a screen renders.
 */

import { TENANT_TYPES, type ProjectConfig, type TenantDto, type User } from '../api/types';

export type StatusTone = 'success' | 'warning' | 'info' | 'danger' | 'muted';

export function isProject(tenant: TenantDto): boolean {
  return tenant.tenant_type === TENANT_TYPES.project;
}

/** The list's sort, applied entirely on the client. */

export type ProjectSortOption = 'recent' | 'oldest' | 'alphabetical';

export const DEFAULT_SORT_OPTION: ProjectSortOption = 'recent';

export const SORT_OPTIONS: readonly ProjectSortOption[] = [
  'recent',
  'oldest',
  'alphabetical',
];

/**
 * Which column carries the sort indicator. The mockup draws the chevron in the
 * header of the column the sort acts on; ours acts on the name or the
 * timestamp, so it is one of those two.
 */
export function sortedColumn(option: ProjectSortOption): 'project' | 'updated' {
  return option === 'alphabetical' ? 'project' : 'updated';
}

export function sortDirection(option: ProjectSortOption): 'asc' | 'desc' {
  return option === 'recent' ? 'desc' : 'asc';
}

/**
 * Row order for a chosen sort. One rule and no tie-breaker by tenant type: every
 * row is a project now that the list is rooted at a workspace.
 */
export function tenantComparator(
  option: ProjectSortOption
): (a: TenantDto, b: TenantDto) => number {
  return (a, b) => {
    switch (option) {
      case 'alphabetical':
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      case 'oldest':
        return a.updated_at.localeCompare(b.updated_at);
      case 'recent':
      default:
        return b.updated_at.localeCompare(a.updated_at);
    }
  };
}

/**
 * The project's own status comes from its config metadata; the tenant's
 * `status` is a lifecycle flag (active/suspended/deleted) and only overrides it
 * when the tenant itself is not active — a suspended tenant is not "draft".
 */
export function projectStatus(
  tenant: TenantDto,
  config: ProjectConfig | null
): 'draft' | 'active' | 'archived' | 'suspended' | 'deleted' | 'unknown' {
  if (tenant.status === 'suspended') return 'suspended';
  if (tenant.status === 'deleted') return 'deleted';
  const status = config?.status;
  if (status === 'draft' || status === 'active' || status === 'archived') return status;
  return 'unknown';
}

export function statusTone(status: ReturnType<typeof projectStatus>): StatusTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'warning';
    case 'suspended':
    case 'deleted':
      return 'danger';
    default:
      return 'muted';
  }
}

export function projectSubtitle(config: ProjectConfig | null): string | null {
  return (
    config?.brief?.trim() ||
    config?.source_git_url ||
    config?.sources?.[0]?.clone_url ||
    null
  );
}

/**
 * A config's stages in catalogue order, with labels.
 *
 * `catalogue` is the workspace's effective stage list, from
 * `DocumentsApiService.stages`. It used to be a constant here (`JOURNEY_STAGES`)
 * and the same list again in the prototype; ADR-0014 section 7 moved it to the
 * server so an organization can change the path its projects follow.
 *
 * A key the catalogue does not know is kept, at the end, under its own name —
 * the metadata is free-form and another writer may add stages, and silently
 * dropping one would make the screen lie about what the project carries. That
 * now also covers a stage the workspace has since hidden, which is the same
 * situation and deserves the same honesty.
 *
 * Order comes from the catalogue, which arrives sorted; this filters, it never
 * re-sorts.
 */
export function orderedStages(
  config: ProjectConfig | null,
  catalogue: readonly { key: string; label: string }[]
): { key: string; label: string }[] {
  const stages = config?.stages;
  if (!stages?.length) return [];
  const known = catalogue
    .filter((stage) => stages.includes(stage.key))
    .map(({ key, label }) => ({ key, label }));
  const seen = new Set(catalogue.map((stage) => stage.key));
  const unknown = stages.filter((key) => !seen.has(key)).map((key) => ({ key, label: key }));
  return [...known, ...unknown];
}

export function displayName(user: User): string {
  return user.display_name?.trim() || user.username;
}

/**
 * TODO: issue counts, 7-day movement, health status and freshness are in the
 * mockups and in no endpoint — the retired projects gear did not have them
 * either, and spec-quality is an analyze-per-request passthrough with no
 * per-project aggregate. They stay undefined rather than invented; wiring them
 * up later is a change to these three functions.
 */
export function issueSummary(_tenant: TenantDto): undefined {
  return undefined;
}

export function movement7d(_tenant: TenantDto): undefined {
  return undefined;
}

export function healthStatus(_tenant: TenantDto): undefined {
  return undefined;
}

