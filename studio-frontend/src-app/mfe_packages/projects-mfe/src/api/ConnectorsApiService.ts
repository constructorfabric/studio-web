/**
 * studio-connector — the gear behind the wizard's second step.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { ConnectionListDto, ProviderListDto, RemoteRepoListDto } from './connectorTypes';

export const CONNECTORS_API_BASE_URL = '/cf/studio-connector/v1';

/** The gear clamps `limit` to 1..=100; ask for the ceiling. */
export const REPOSITORY_PAGE_LIMIT = 100;

export interface ConnectionsParams {
  /** Organization tenant whose catalogue to read. */
  tenantId: string;
}

export interface RepositoriesParams {
  connectionId: string;
  tenantId: string;
  /** Passed to the provider; empty means "no filter", not "match empty". */
  search?: string;
  limit?: number;
}

function connectionsPath({ tenantId }: ConnectionsParams): string {
  return `/connections?tenant=${encodeURIComponent(tenantId)}`;
}

function repositoriesPath({
  connectionId,
  tenantId,
  search,
  limit,
}: RepositoriesParams): string {
  const query = new URLSearchParams({ tenant: tenantId });
  if (search) query.set('search', search);
  if (limit !== undefined) query.set('limit', String(limit));
  return `/connections/${connectionId}/repositories?${query.toString()}`;
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
}
