import { apiRegistry, useApiQuery } from '@gears-frontx/react';
import { AccountsApiService } from '../api/AccountsApiService';
import { PROJECT_CONFIG_TYPE, type ProjectConfig } from '../api/types';
import { isNotFound } from './notFound';

/**
 * A project's attributes. One request per project — the metadata lives on the
 * project tenant, and AM has no bulk metadata read — which is fine inside a row
 * component: React Query dedupes and caches per tenant id.
 */
export function useProjectConfig(tenantId: string): {
  config: ProjectConfig | null;
  loading: boolean;
  /** Metadata was never written for this project (404), which is not an error. */
  unset: boolean;
  failed: boolean;
} {
  const accounts = apiRegistry.getService(AccountsApiService);
  const { data, isLoading, isError, error } = useApiQuery(
    accounts.projectConfig({ tenantId, metadataType: PROJECT_CONFIG_TYPE })
  );
  const unset = isError && isNotFound(error);

  return {
    config: data?.value ?? null,
    loading: isLoading,
    unset,
    failed: isError && !unset,
  };
}
