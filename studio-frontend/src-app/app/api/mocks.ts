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
import type { MembershipList } from './types';

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
        source: 'assignment',
      },
    ],
  }),
};
