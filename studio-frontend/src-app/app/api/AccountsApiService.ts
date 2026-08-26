/**
 * Accounts Domain - API Service
 * Service for accounts domain (users, tenants, authentication, permissions)
 */

import {
  BaseApiService,
  RestEndpointProtocol,
  RestProtocol,
  RestMockPlugin,
} from '@gears-frontx/react';
import type { Me, Page, Tenant } from './types';
import { accountsMockMap } from './mocks';

/**
 * The real account-management gear behind the /cf gateway prefix
 * (vite dev proxy / nginx location — same-origin in every environment).
 * Exported so raw probes (LoginScreen's pre-session token check) stay on
 * the same base as the service.
 */
export const ACCOUNTS_API_BASE_URL = '/cf/account-management/v1';

/**
 * Accounts API Service
 * Manages accounts domain endpoints:
 * - User management (current user, profile, preferences)
 * - Tenant management (current tenant, switching)
 * - Authentication (login, logout, tokens)
 * - Permissions and roles
 */
export class AccountsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({
      timeout: 30000,
    });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: ACCOUNTS_API_BASE_URL }, restProtocol, restEndpoints);

    // Register mock plugin (framework controls when it's active based on mock mode toggle)
    this.registerPlugin(
      restProtocol,
      new RestMockPlugin({
        mockMap: accountsMockMap,
        delay: 100,
      })
    );
  }

  /** Identity check against the backend: who does this token authenticate as. */
  readonly me = this.protocol(RestEndpointProtocol).query<Me>('/me');

  /**
   * One tenant by id. The shell resolves the signed-in user's home tenant this
   * way (`/me` returns only its id, never its name), which is what the top-bar
   * context switcher shows when the scope is the organization.
   */
  readonly tenant = this.protocol(RestEndpointProtocol).queryWith<Tenant, { tenantId: string }>(
    ({ tenantId }) => `/tenants/${tenantId}`
  );

  /**
   * A tenant's children. Organizations the user can switch to are the children
   * of their home tenant whose `tenant_type` is the organization type — the
   * filtering is the caller's, since account-management has no type query
   * parameter.
   */
  readonly tenantChildren = this.protocol(RestEndpointProtocol).queryWith<
    Page<Tenant>,
    { tenantId: string }
  >(({ tenantId }) => `/tenants/${tenantId}/children`);
}
