/**
 * The source hosts the wizard can import from — one tab per connection.
 */

import { apiRegistry, useApiQuery } from '@gears-frontx/react';
import { ConnectorsApiService } from '../api/ConnectorsApiService';
import type { ConnectionDto } from '../api/connectorTypes';

/** `ProviderDto.category` of a driver whose repositories can be browsed. */
const SOURCE_CODE_CATEGORY = 'source_code';

export interface ConnectionsView {
  /** Source hosts only, in catalogue order. */
  connections: readonly ConnectionDto[];
  loading: boolean;
  failed: boolean;
  providerName: (provider: string) => string;
}

interface ProviderFacts {
  displayName: string;
  category: string;
}

export function useSourceConnections(orgId: string): ConnectionsView {
  const connectors = apiRegistry.getService(ConnectorsApiService);

  const {
    data: providerData,
    isLoading: providersLoading,
    isError: providersFailed,
  } = useApiQuery(connectors.providers);

  const {
    data: connectionData,
    isLoading: connectionsLoading,
    isError: connectionsFailed,
  } = useApiQuery(connectors.connections({ tenantId: orgId }));

  const facts = new Map<string, ProviderFacts>(
    (providerData?.items ?? []).map((provider) => [
      provider.provider,
      { displayName: provider.display_name, category: provider.category },
    ])
  );

  const connections = (connectionData?.items ?? []).filter(
    (connection) => facts.get(connection.provider)?.category === SOURCE_CODE_CATEGORY
  );

  return {
    connections,
    loading: connectionsLoading || providersLoading,
    failed: connectionsFailed || providersFailed,
    providerName: (provider: string) => facts.get(provider)?.displayName ?? provider,
  };
}
