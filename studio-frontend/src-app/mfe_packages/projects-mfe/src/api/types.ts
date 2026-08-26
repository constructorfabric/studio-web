/**
 * Wire shapes. Projects are account-management tenants now — the
 * `studio-project` gear was retired (see the note in every studio-backend
 * config profile), so everything here is AM's vocabulary.
 */

/** Hierarchy: Platform → Organization → Workspace → Project, all AM tenants. */
export const TENANT_TYPES = {
  platform: 'gts.cf.core.am.tenant_type.v1~cf.core.am.platform.v1~',
  organization: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~',
  workspace: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~',
  project: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~',
} as const;

/** Project attributes live in this tenant-metadata type, per tenant. */
export const PROJECT_CONFIG_TYPE =
  'gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~';

export type TenantStatus = 'active' | 'suspended' | 'deleted';

export interface TenantDto {
  id: string;
  name: string;
  status: TenantStatus;
  tenant_type?: string;
  parent_id?: string | null;
  self_managed: boolean;
  depth: number;
  /** DIRECT children visible to the caller — not a subtree count. */
  child_count: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

/** AM's cursor-paginated envelope. */
export interface Page<T> {
  items: T[];
  page_info?: { next_cursor: string | null; prev_cursor: string | null; limit: number };
}

/**
 * The free-form object under PROJECT_CONFIG_TYPE. The backend declares the
 * metadata type as a bare object ("shape enforced client-side"), so this
 * interface IS the contract.
 *
 * It used to mirror `ProjectConfig` in studio-frontend-prototype/src/api.ts
 * field for field, the prototype being its only writer. The New project wizard
 * is the second writer now and adds one field the prototype does not know,
 * `owner_id` — a reader must treat it as optional, which it already is.
 *
 * Still do not add fields nothing writes: a `description` used to live here for
 * a second line in the mockups, and it could only ever render empty.
 */
export type ProjectMode = 'greenfield' | 'modernize';
export type ProjectStatus = 'draft' | 'active' | 'archived';

/**
 * One repository a project was seeded from.
 */
export interface ProjectSource {
  connection_id: string;
  full_path: string;
  clone_url: string;
}

export interface ProjectConfig {
  mode?: ProjectMode;
  stages?: string[];
  status?: ProjectStatus;
  sources?: ProjectSource[];
  source_git_url?: string;
  brief?: string;
  owner_id?: string;
}

/** `GET /metadata/{type}` envelope. */
export interface MetadataEntry<T> {
  value: T;
}

export interface Me {
  subject_id: string;
  subject_type?: string;
  subject_tenant_id?: string;
}

export interface User {
  id: string;
  username: string;
  email?: string;
  display_name?: string;
}
