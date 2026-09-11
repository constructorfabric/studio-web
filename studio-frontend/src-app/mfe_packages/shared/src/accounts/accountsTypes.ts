/** account-management's vocabulary, in one place. */

/** Hierarchy: Platform → Organization → Workspace → Project, all AM tenants. */
export const TENANT_TYPES = {
  platform: 'gts.cf.core.am.tenant_type.v1~cf.core.am.platform.v1~',
  organization: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~',
  workspace: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~',
  project: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~',
} as const;

export type TenantStatus = 'active' | 'suspended' | 'deleted';

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  tenant_type?: string;
  parent_id?: string | null;
  self_managed: boolean;
  depth: number;
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
 * `GET /me`: whom the presented token authenticates as. Display data (name,
 * email) comes from the token claims, not from this endpoint.
 */
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

/** `GET /tenants/{id}/metadata/{type}` envelope. */
export interface MetadataEntry<T> {
  value: T;
}

/** AM's own listing ceiling (`listing.max_top`), so one page is usually enough. */
export const CHILDREN_PAGE_LIMIT = 200;
