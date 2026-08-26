/**
 * Accounts Domain - API Types
 * Type definitions for accounts service endpoints
 */

/**
 * The backend's identity check (GET /cf/account-management/v1/me):
 * whom the presented token authenticates as. Display data (name, email)
 * comes from the token claims, not from this endpoint.
 */
export interface Me {
  subject_id: string;
  subject_type?: string;
  subject_tenant_id?: string;
}

/**
 * An account-management tenant. Studio models both organizations and
 * workspaces as tenants and tells them apart by `tenant_type`, so the type
 * string is what the shell filters on — never the name or position.
 */
export interface Tenant {
  id: string;
  name: string;
  tenant_type: string;
  self_managed?: boolean;
}

/** Account-management's list envelope. Only `items` is consumed here. */
export interface Page<T> {
  items: T[];
  page_info?: { next_cursor: string | null; prev_cursor: string | null; limit: number };
}

/**
 * Tenant type IDs seeded by studio-backend config
 * (`types-registry.config.entities`). The organization type is the one the
 * top-bar context switcher offers; workspaces are a level the current concept
 * does not surface.
 */
export const TENANT_TYPES = {
  organization: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~',
  workspace: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~',
} as const;
