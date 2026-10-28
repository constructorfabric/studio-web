/**
 * Identity Domain - Mock Data
 *
 * Used with `RestMockPlugin`, registered by `IdentityApiService` itself.
 * Keys are full URL patterns including the baseURL path, because the plugin
 * matches the whole URL — query string included.
 *
 * The accounts map that used to live beside this one is gone with the shell's
 * own accounts service: it keyed the workspaces read by a URL the client never
 * built, so it never answered and hid a real 500 behind a mock.
 */

import type { MockMap } from '@gears-frontx/react';
import type {
  InvitationList,
  MembershipList,
  Organization,
  OrganizationCapabilities,
  OrganizationRequest,
  OrganizationRequestList,
} from './types';

/** The organization the mocked session is a member of. */
const HOME_TENANT_ID = '00000000-0000-0000-0000-0000000000aa';

/**
 * Identity mock map (the /cf/studio-user/v1 baseURL).
 *
 * One membership, so a mocked shell resolves exactly one organization and the
 * access gate stays out of the way.
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

  'GET /cf/studio-user/v1/me/invitations': (): InvitationList => ({ items: [] }),
};

/**
 * One pending request, for the decide/withdraw writes to answer with: the mock
 * keeps no state, so a write answers as if it had been applied to this one.
 */
function mockRequest(overrides: Partial<OrganizationRequest> = {}): OrganizationRequest {
  return {
    id: '00000000-0000-0000-0000-0000000000d1',
    requested_by: '00000000-0000-0000-0000-0000000000f1',
    name: 'New organization',
    note: '',
    status: 'pending',
    created_at_ms: 1_767_225_600_000,
    ...overrides,
  };
}

const NO_REQUESTS = (): OrganizationRequestList => ({ items: [], total: 0 });

export const organizationsMockMap: MockMap = {
  'GET /cf/studio-organizations/v1/capabilities': (): OrganizationCapabilities => ({
    self_service: true,
    organization_creation: 'open',
    decides_requests: false,
  }),

  'POST /cf/studio-organizations/v1/organizations': (body): Organization => ({
    id: '00000000-0000-0000-0000-0000000000c1',
    name: (body as { name?: string } | undefined)?.name ?? 'New organization',
  }),

  // The plugin matches the query string too, so each read the portal makes
  // has its own key; anything else falls through to the network.
  'GET /cf/studio-organizations/v1/organization-requests?scope=mine': NO_REQUESTS,
  'GET /cf/studio-organizations/v1/organization-requests?scope=all&status=pending': NO_REQUESTS,

  'POST /cf/studio-organizations/v1/organization-requests': (body): OrganizationRequest => {
    const asked = body as { name?: string; note?: string } | undefined;
    return mockRequest({ name: asked?.name ?? 'New organization', note: asked?.note ?? '' });
  },

  'POST /cf/studio-organizations/v1/organization-requests/:id/cancel': (): OrganizationRequest =>
    mockRequest({ status: 'withdrawn', decided_at_ms: 1_767_229_200_000 }),

  'POST /cf/studio-organizations/v1/organization-requests/:id/decision': (
    body
  ): OrganizationRequest => {
    const decided = body as { decision?: string; name?: string; reason?: string } | undefined;
    return decided?.decision === 'approve'
      ? mockRequest({
          status: 'approved',
          name: decided.name ?? 'New organization',
          organization_id: '00000000-0000-0000-0000-0000000000d1',
          decided_at_ms: 1_767_229_200_000,
        })
      : mockRequest({
          status: 'rejected',
          reason: decided?.reason ?? null,
          decided_at_ms: 1_767_229_200_000,
        });
  },
};
