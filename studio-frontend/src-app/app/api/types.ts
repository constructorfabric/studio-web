/**
 * Identity Domain - API Types
 *
 * What `studio-user` answers with. The account-management vocabulary this used
 * to hold — `Me`, `Tenant`, `Page`, `TENANT_TYPES` — moved to
 * `@constructor-studio/mfe-shared`, where the MFEs can reach it too; only what
 * is identity's own is left here.
 */

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
