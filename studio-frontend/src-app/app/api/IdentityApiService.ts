/**
 * Identity Domain - API Service
 *
 * The canonical Studio person and what it belongs to (`studio-user`).
 *
 * Separate from `AccountsApiService` because it is a separate gear on a separate
 * base path: account-management answers "what tenants exist", this answers "who
 * is this person and which organizations are they a member of". The organization
 * list comes from here rather than from the tenant tree — membership is the
 * authority for organization access (ADR-0011 §2), and a home-tenant attribute
 * on the token never was one.
 */

import {
  BaseApiService,
  RestEndpointProtocol,
  RestProtocol,
  RestMockPlugin,
} from '@gears-frontx/react';
import type { InvitationList, Membership, MembershipList } from './types';
import { identityMockMap } from './mocks';

export const IDENTITY_API_BASE_URL = '/cf/studio-user/v1';

export class IdentityApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: IDENTITY_API_BASE_URL }, restProtocol, restEndpoints);

    this.registerPlugin(
      restProtocol,
      new RestMockPlugin({ mockMap: identityMockMap, delay: 100 })
    );
  }

  /**
   * The signed-in person's organization memberships, each carrying the role
   * held there.
   *
   * Only ids and roles — `studio-user` does not store organization names, so
   * the shell resolves each one through account-management. An empty list is a
   * valid, expected answer: it means this person has not been given access to
   * an organization yet.
   */
  readonly myMemberships =
    this.protocol(RestEndpointProtocol).query<MembershipList>('/me/memberships');

  /**
   * Invitations waiting for this person, matched to the addresses they have
   * proven — never to one they typed.
   *
   * This is how somebody with no organization gets one without an administrator
   * in the loop (ADR-0018 §2): the invitation was addressed to them, so it is
   * theirs to accept.
   */
  readonly myInvitations =
    this.protocol(RestEndpointProtocol).query<InvitationList>('/me/invitations');

  /**
   * Accept one, by the token that came with it.
   *
   * The membership it returns is the answer — the shell reloads its context
   * from it rather than guessing what changed.
   */
  readonly acceptInvitation = this.protocol(RestEndpointProtocol).mutation<
    Membership,
    { token: string } | { invitation_id: string }
  >('POST', '/me/invitations/accept');
}
