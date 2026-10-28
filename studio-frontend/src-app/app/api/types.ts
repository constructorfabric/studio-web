/** Identity Domain - API Types */

/**
 * One organization membership of the signed-in person
 * (GET /cf/studio-user/v1/me/memberships).
 *
 * `role` is the role held in THAT organization — role is a property of
 * membership, never of the person (ADR-0023).
 */
export interface Membership {
  user_id: string;
  org_id: string;
  role: string;
  status: string;
  source: string;
}

export interface MembershipList {
  items: Membership[];
}

/**
 * The platform root tenant. Its type is `cf.core.am.platform.v1~`, not
 * organization, so it never appears in the context switcher itself — but a
 * person whose home tenant IS the root is a platform administrator, and that is
 * what the shell uses it for.
 *
 * Here rather than with the shared tenant vocabulary because the question it
 * answers is an identity one: not what this tenant is, but what this person is
 * allowed to see.
 */
export const PLATFORM_ROOT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

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
 * What this installation lets a person without an organization do
 * (ADR-0051 §2): create one at once, ask a platform administrator for one, or
 * nothing but wait for an invitation.
 */
export type OrganizationCreation = 'open' | 'request' | 'off';

export interface OrganizationCapabilities {
  /** True only for `open`. What an older backend answers with alone. */
  self_service: boolean;
  /** Absent from a backend older than ADR-0051. */
  organization_creation?: OrganizationCreation;
  /** Whether the caller decides organization requests: a platform administrator. */
  decides_requests?: boolean;
}

export type OrganizationRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/**
 * A person asking to become the owner of an organization that does not exist
 * yet (ADR-0051 §3). Its `id` is also the id the organization gets on approval.
 */
export interface OrganizationRequest {
  id: string;
  requested_by: string;
  /** Only in the administrator's list (`scope=all`): who asked, as the directory knows them. */
  requester_name?: string | null;
  requester_email?: string | null;
  /** The name asked for; the organization may be approved under a corrected one. */
  name: string;
  note: string;
  status: OrganizationRequestStatus;
  /** Why it was rejected, written for the requester. */
  reason?: string | null;
  organization_id?: string | null;
  created_at_ms: number;
  decided_at_ms?: number | null;
}

export interface OrganizationRequestList {
  items: OrganizationRequest[];
  total: number;
}

export interface OrganizationRequestsQuery {
  /** `mine` (the default) newest first; `all` is the platform administrator's, oldest first. */
  scope?: 'mine' | 'all';
  status?: OrganizationRequestStatus;
  offset?: number;
  limit?: number;
}

export type OrganizationRequestDecision =
  | { decision: 'approve'; name?: string }
  | { decision: 'reject'; reason?: string };

export interface Organization {
  id: string;
  name: string;
}
