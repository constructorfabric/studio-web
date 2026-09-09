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
  /** DIRECT children visible to the caller — not a subtree count. */
  child_count?: number;
}

/** Account-management's list envelope. Only `items` is consumed here. */
export interface Page<T> {
  items: T[];
  page_info?: { next_cursor: string | null; prev_cursor: string | null; limit: number };
}

/**
 * Tenant type IDs seeded by studio-backend config
 * (`types-registry.config.entities`). Both are surfaced in the top bar: the
 * organization in the context slot, the workspace in its own slot beside it.
 * A project's parent is a workspace, which is why the shell resolves them.
 */
export const TENANT_TYPES = {
  organization: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~',
  workspace: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~',
} as const;

/**
 * The platform root tenant. Its type is `cf.core.am.platform.v1~`, not
 * organization, so it never appears in the context switcher itself — but a
 * person whose home tenant IS the root is a platform administrator, and that is
 * what the shell uses it for.
 */
export const PLATFORM_ROOT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * One organization membership of the signed-in person
 * (GET /cf/studio-user/v1/me/memberships).
 *
 * `role` is the role held in THAT organization — role is a property of
 * membership, never of the person (ADR-0006).
 */
export interface Membership {
  user_id: string;
  org_id: string;
  role: string;
  source: string;
}

export interface MembershipList {
  items: Membership[];
}
