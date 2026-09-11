/**
 * Accounts Domain - Mock Data
 * Mock responses for accounts service endpoints
 *
 * Used with MockPlugin for development and testing.
 * Keys are full URL patterns (including baseURL path); a `:param` segment
 * matches one path segment, which is how the parameterized tenant endpoints
 * are covered without enumerating ids.
 */

import type { MockMap } from '@gears-frontx/react';
import type {
  InvitationList,
  Me,
  MembershipList,
  Organization,
  OrganizationCapabilities,
  Page,
  Tenant,
} from './types';
import { TENANT_TYPES } from './types';

const HOME_TENANT_ID = '00000000-0000-0000-0000-0000000000aa';

/**
 * Accounts mock map
 * Keys are full URL patterns (including the /cf/account-management/v1 baseURL)
 */
export const accountsMockMap: MockMap = {
  'GET /cf/account-management/v1/me': (): Me => ({
    subject_id: '00000000-0000-0000-0000-000000000001',
    subject_type: 'user',
    subject_tenant_id: HOME_TENANT_ID,
  }),

  // The signed-in user's home tenant. A mock factory receives only the request
  // body, never the URL, so this answers for any id — enough to exercise the
  // top bar, which asks for exactly one tenant.
  'GET /cf/account-management/v1/tenants/:tenantId': (): Tenant => ({
    id: HOME_TENANT_ID,
    name: 'My Organization',
    tenant_type: TENANT_TYPES.organization,
  }),

  // Two switchable organizations plus one workspace, so the context switcher
  // has something to filter: only the organizations may appear in it.
  'GET /cf/account-management/v1/tenants/:tenantId/children': (): Page<Tenant> => ({
    items: [
      {
        id: '00000000-0000-0000-0000-0000000000b1',
        name: 'Constructor Fabric',
        tenant_type: TENANT_TYPES.organization,
      },
      {
        id: '00000000-0000-0000-0000-0000000000b2',
        name: 'Agent Labs',
        tenant_type: TENANT_TYPES.organization,
      },
      {
        id: '00000000-0000-0000-0000-0000000000b3',
        name: 'Platform workspace',
        tenant_type: TENANT_TYPES.workspace,
      },
    ],
  }),
};

/**
 * Identity mock map (the /cf/studio-user/v1 baseURL).
 *
 * One membership, of the same organization the accounts mock calls home, so the
 * mocked shell resolves the same context through either source.
 */
export const identityMockMap: MockMap = {
  'GET /cf/studio-user/v1/me/memberships': (): MembershipList => ({
    items: [
      {
        user_id: '00000000-0000-0000-0000-0000000000f1',
        org_id: HOME_TENANT_ID,
        role: 'owner',
        status: 'active',
        source: 'assignment',
      },
    ],
  }),

  // Nothing waiting: the ordinary case for somebody who already has an
  // organization, and the one the shell has to render without looking empty.
  'GET /cf/studio-user/v1/me/invitations': (): InvitationList => ({ items: [] }),
};

/**
 * Organizations mock map
 * Keys are full URL patterns (including the /cf/studio-organizations/v1 baseURL)
 */
export const organizationsMockMap: MockMap = {
  'GET /cf/studio-organizations/v1/capabilities': (): OrganizationCapabilities => ({
    self_service: true,
  }),

  'POST /cf/studio-organizations/v1/organizations': (body): Organization => ({
    id: '00000000-0000-0000-0000-0000000000c1',
    name: (body as { name?: string } | undefined)?.name ?? 'New organization',
  }),
};
