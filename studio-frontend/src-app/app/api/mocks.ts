/**
 * Accounts Domain - Mock Data
 * Mock responses for accounts service endpoints
 *
 * Used with MockPlugin for development and testing.
 * Keys are full URL patterns (including baseURL path).
 */

import type { MockMap } from '@gears-frontx/react';
import type { Me } from './types';

/**
 * Accounts mock map
 * Keys are full URL patterns (including the /cf/account-management/v1 baseURL)
 */
export const accountsMockMap: MockMap = {
  'GET /cf/account-management/v1/me': (): Me => ({
    subject_id: '00000000-0000-0000-0000-000000000001',
    subject_type: 'user',
    subject_tenant_id: '00000000-0000-0000-0000-0000000000aa',
  }),
};
