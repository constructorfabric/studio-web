/**
 * Organizations Domain - API Service
 *
 * Creating an organization, and asking whether this installation allows it
 * (`studio-organizations`).
 *
 * Separate from `AccountsApiService` even though an organization *is* an
 * account-management tenant: creating one is three writes in two systems — the
 * tenant, the creator's owner membership and the owner grant the authorization
 * policy reads — and the gear is what keeps them together (ADR-0018 §2). A
 * portal that created the tenant itself would produce an organization nobody
 * owns.
 */

import {
  BaseApiService,
  RestEndpointProtocol,
  RestProtocol,
  RestMockPlugin,
} from '@gears-frontx/react';
import type { Organization, OrganizationCapabilities } from './types';
import { organizationsMockMap } from './mocks';

export const ORGANIZATIONS_API_BASE_URL = '/cf/studio-organizations/v1';

export class OrganizationsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: ORGANIZATIONS_API_BASE_URL }, restProtocol, restEndpoints);

    this.registerPlugin(
      restProtocol,
      new RestMockPlugin({ mockMap: organizationsMockMap, delay: 100 })
    );
  }

  /**
   * Whether a person may create an organization here.
   *
   * Read before offering the control rather than after: an installation inside
   * one company joins people to the organization it already has, and a create
   * button that answers 403 teaches somebody that the product is broken.
   */
  readonly capabilities =
    this.protocol(RestEndpointProtocol).query<OrganizationCapabilities>('/capabilities');

  /**
   * Create an organization and become its owner.
   *
   * `organization_id` finishes one a previous attempt left half-created; the
   * error that reports it carries the id, and every write is idempotent, so
   * repeating is safe.
   */
  readonly create = this.protocol(RestEndpointProtocol).mutation<
    Organization,
    { name: string; organization_id?: string }
  >('POST', '/organizations');
}
