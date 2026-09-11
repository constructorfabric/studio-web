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
  /**
   * `active` or `suspended`. A suspended membership grants nothing while it
   * stands, so it never reaches this list — the shell reads the field to say
   * what it is looking at, not to decide access.
   */
  status: string;
  source: string;
}

export interface MembershipList {
  items: Membership[];
}

/**
 * An invitation waiting for the signed-in person
 * (GET /cf/studio-user/v1/me/invitations).
 *
 * Matched to them by a verified address, never by one they typed: the token is
 * what accepts it, and the list only ever shows invitations already addressed
 * to an address this person has proven (ADR-0018 §2).
 */
export interface Invitation {
  id: string;
  org_id: string;
  email: string;
  role: string;
  expires_at_epoch_ms: number;
}

export interface InvitationList {
  items: Invitation[];
}

/**
 * What this installation lets people do with organizations
 * (GET /cf/studio-organizations/v1/capabilities).
 *
 * `self_service` is false in an installation inside one company, where the
 * organization already exists and people are joined to it — so the screen
 * offers waiting rather than a control that answers 403 (ADR-0018 §4).
 */
export interface OrganizationCapabilities {
  self_service: boolean;
}

/** An organization as `studio-organizations` returns it. */
export interface Organization {
  id: string;
  name: string;
}
