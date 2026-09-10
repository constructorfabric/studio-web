/**
 * The studio-connector client, for every MFE that talks to that gear.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type {
  ConnectionListDto,
  ConnectionTestDto,
  CreateConnectionBody,
  NotifyTargetListDto,
  ProviderListDto,
  RemoteRepoListDto,
  SendMessageBody,
  SentMessageDto,
} from './connectorTypes';

export const CONNECTORS_API_BASE_URL = '/cf/studio-connector/v1';

export const REPOSITORY_PAGE_LIMIT = 100;

export interface ConnectionsParams {
  /** Organization tenant whose catalogue to read. */
  tenantId: string;
}

export interface ConnectionTestParams {
  connectionId: string;
  tenantId: string;
}

export interface RepositoriesParams {
  connectionId: string;
  tenantId: string;
  search?: string;
  limit?: number;
}

/** Same three parameters as a repository listing, for the same reason. */
export type TargetsParams = RepositoriesParams;

export interface SendMessageParams {
  connectionId: string;
  tenantId: string;
}

export function connectionsPath({ tenantId }: ConnectionsParams): string {
  return `/connections?tenant=${encodeURIComponent(tenantId)}`;
}

export function connectionTestPath({ connectionId, tenantId }: ConnectionTestParams): string {
  return `/connections/${encodeURIComponent(connectionId)}/test?tenant=${encodeURIComponent(
    tenantId
  )}`;
}

export function repositoriesPath(params: RepositoriesParams): string {
  return listingPath('repositories', params);
}

/**
 * A filtered listing under one connection. Shared by repositories and
 * notification channels so the two cannot drift on tenant scoping or on
 * dropping an empty `search` — the bug the path tests describe.
 */
function listingPath(
  resource: string,
  { connectionId, tenantId, search, limit }: RepositoriesParams
): string {
  const query = new URLSearchParams({ tenant: tenantId });
  if (search) query.set('search', search);
  if (limit !== undefined) query.set('limit', String(limit));
  return `/connections/${encodeURIComponent(connectionId)}/${resource}?${query.toString()}`;
}

export function targetsPath(params: TargetsParams): string {
  return listingPath('targets', params);
}

export function sendMessagePath({ connectionId, tenantId }: SendMessageParams): string {
  return `/connections/${encodeURIComponent(connectionId)}/messages?tenant=${encodeURIComponent(
    tenantId
  )}`;
}

export class ConnectorsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: CONNECTORS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  readonly providers = this.protocol(RestEndpointProtocol).query<ProviderListDto>('/providers');

  readonly connections = this.protocol(RestEndpointProtocol).queryWith<
    ConnectionListDto,
    ConnectionsParams
  >(connectionsPath);

  readonly repositories = this.protocol(RestEndpointProtocol).queryWith<
    RemoteRepoListDto,
    RepositoriesParams
  >(repositoriesPath);

  readonly targets = this.protocol(RestEndpointProtocol).queryWith<
    NotifyTargetListDto,
    TargetsParams
  >(targetsPath);

  readonly createConnection = this.protocol(RestEndpointProtocol).mutation<
    ConnectionTestDto,
    CreateConnectionBody
  >('POST', '/connections');

  /**
   * Post through a notification connection. A mutation per connection rather
   * than one taking the id in its body, because the gear puts it in the path.
   */
  sendMessage(params: SendMessageParams) {
    return this.protocol(RestEndpointProtocol).mutation<SentMessageDto, SendMessageBody>(
      'POST',
      sendMessagePath(params)
    );
  }

  connectionTest(params: ConnectionTestParams) {
    return this.protocol(RestEndpointProtocol).mutation<ConnectionTestDto, void>(
      'POST',
      connectionTestPath(params)
    );
  }
}
