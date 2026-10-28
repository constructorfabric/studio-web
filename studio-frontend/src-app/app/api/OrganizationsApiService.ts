/**
 * Organizations Domain - API Service
 *
 * Creating an organization, and asking whether this installation allows it
 * (`studio-organizations`) — or, where it only allows asking, the requests a
 * platform administrator decides (ADR-0051 §§3–4).
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
import type {
  Organization,
  OrganizationCapabilities,
  OrganizationRequest,
  OrganizationRequestDecision,
  OrganizationRequestList,
  OrganizationRequestsQuery,
} from './types';
import { organizationsMockMap } from './mocks';

export const ORGANIZATIONS_API_BASE_URL = '/cf/studio-organizations/v1';

function requestsPath(query: OrganizationRequestsQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search === '' ? '/organization-requests' : `/organization-requests?${search}`;
}

function requestPath(id: string, action: 'cancel' | 'decision'): string {
  return `/organization-requests/${encodeURIComponent(id)}/${action}`;
}

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

  /**
   * Ask a platform administrator for an organization, where creation is
   * `request`. One pending request per person: a second is refused with
   * `REQUEST_ALREADY_PENDING`, and none while they own as many as they may
   * (`ORGANIZATION_LIMIT_REACHED`).
   */
  readonly requestOrganization = this.protocol(RestEndpointProtocol).mutation<
    OrganizationRequest,
    { name: string; note?: string }
  >('POST', '/organization-requests');

  /**
   * Requests: the caller's own (`scope: 'mine'`, newest first), or — for a
   * platform administrator only — everybody's (`scope: 'all'`, oldest first, so
   * the one waiting longest is on top). Read with `staleTime: 0` when the
   * answer is meant to show a decision made elsewhere.
   */
  readonly organizationRequests = this.protocol(RestEndpointProtocol).queryWith<
    OrganizationRequestList,
    OrganizationRequestsQuery
  >(requestsPath);

  /** Withdraw one of the caller's own pending requests. */
  cancelRequest(id: string) {
    return this.protocol(RestEndpointProtocol).mutation<OrganizationRequest, void>(
      'POST',
      requestPath(id, 'cancel')
    );
  }

  /**
   * A platform administrator's decision. Approval creates the organization
   * with the request's id and the requester as its owner; a failure part-way
   * leaves the request pending, and approving again finishes the same
   * organization rather than making a second.
   */
  decideRequest(id: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      OrganizationRequest,
      OrganizationRequestDecision
    >('POST', requestPath(id, 'decision'));
  }
}
