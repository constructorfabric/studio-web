/**
 * Tenants + their metadata -> what a screen renders.
 *
 * The gap between the mockups and the backend lives here. What is real: name,
 * hierarchy, lifecycle status, timestamps (AM), and mode/stages/status/source
 * (project-config metadata). What has no source at all yet: the mockups'
 * issue counts, 7-day movement, health status ("On track"/"Needs attention")
 * and freshness markers ("Stale", "Partial data").
 */

import { TENANT_TYPES, type ProjectConfig, type TenantDto, type User } from '../api/types';

export type StatusTone = 'success' | 'warning' | 'info' | 'danger' | 'muted';

export function isWorkspace(tenant: TenantDto): boolean {
  return tenant.tenant_type === TENANT_TYPES.workspace;
}

export function isProject(tenant: TenantDto): boolean {
  return tenant.tenant_type === TENANT_TYPES.project;
}

export function isOrganization(tenant: TenantDto): boolean {
  return tenant.tenant_type === TENANT_TYPES.organization;
}

/**
 * Order inside one parent: workspaces first, then projects, then anything else
 * — a tenant tree may legitimately carry types this screen knows nothing about,
 * and dropping them would hide real rows. This is the "sort by tenant type on
 * the client" half of the tree: the children request is unfiltered, so one page
 * carries every kind at once.
 */
export function tenantTypeRank(tenant: TenantDto): number {
  if (isWorkspace(tenant)) return 0;
  if (isProject(tenant)) return 1;
  return 2;
}

/**
 * The list's sort, applied entirely on the client. AM's `$orderby` allow-list
 * does carry `name` and `updated_at`, but the tree is fetched one page per
 * expanded node — ordering each page separately would order siblings, which is
 * exactly what `sortRows` already does here for free. Nothing is gained by
 * asking the server, and a mixed client/server order would be a lie the moment
 * one branch is loaded and another is not.
 */
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
 * Sibling order for a chosen sort. Tenant type stays the primary key whatever
 * the user picked: a workspace is a container, and interleaving containers with
 * their peers' contents alphabetically reads as a broken tree rather than as a
 * sorted one. Inside one type, the option decides.
 */
export function tenantComparator(
  option: ProjectSortOption
): (a: TenantDto, b: TenantDto) => number {
  const within = (a: TenantDto, b: TenantDto): number => {
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
  return (a, b) => tenantTypeRank(a) - tenantTypeRank(b) || within(a, b);
}

/** Stable: AM's `(created_at ASC, id ASC)` order survives inside each group. */
export function sortForTree(tenants: readonly TenantDto[]): TenantDto[] {
  return [...tenants].sort((a, b) => tenantTypeRank(a) - tenantTypeRank(b));
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
 * The journey-stage catalogue, mirroring `JOURNEY_STAGES` in
 * studio-frontend-prototype/src/api.ts — it moved to the clients when the
 * `studio-project` gear was retired (it used to be `GET /studio-project/v1/stages`),
 * so both clients now have to agree on it by hand. `intent` is always applied;
 * order is the journey's order, not the order a config happens to list.
 *
 * Labels are English here, exactly as in the prototype: they are catalogue data,
 * not screen copy, and inventing 8 keys × 35 locale files for a list nothing can
 * edit yet would be worse than saying so out loud. Translating them is a
 * follow-up, together with the write path.
 */
export const JOURNEY_STAGES: readonly { key: string; label: string; required: boolean }[] = [
  { key: 'intent', label: 'Intent', required: true },
  { key: 'brd', label: 'BRD', required: false },
  { key: 'prd', label: 'PRD', required: false },
  { key: 'prd_spec', label: 'PRD-Spec', required: false },
  { key: 'architecture', label: 'Architecture', required: false },
  { key: 'ui_design', label: 'UI Design', required: false },
  { key: 'user_stories', label: 'User Stories', required: false },
  { key: 'testing', label: 'Testing', required: false },
];

/**
 * A config's stages in catalogue order, with labels. A key the catalogue does
 * not know is kept, at the end, under its own name — the metadata is free-form
 * and another writer may add stages, and silently dropping one would make the
 * screen lie about what the project carries.
 */
export function orderedStages(
  config: ProjectConfig | null
): { key: string; label: string }[] {
  const stages = config?.stages;
  if (!stages?.length) return [];
  const known = JOURNEY_STAGES.filter((stage) => stages.includes(stage.key)).map(
    ({ key, label }) => ({ key, label })
  );
  const catalogue = new Set(JOURNEY_STAGES.map((stage) => stage.key));
  const unknown = stages.filter((key) => !catalogue.has(key)).map((key) => ({ key, label: key }));
  return [...known, ...unknown];
}

export function ownerName(id: string | undefined, users: Map<string, User> | null): string | null {
  if (!id) return null;
  const user = users?.get(id);
  if (!user) return null;
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

export function usersById(users: readonly User[] | undefined): Map<string, User> | null {
  if (!users) return null;
  return new Map(users.map((user) => [user.id, user]));
}
