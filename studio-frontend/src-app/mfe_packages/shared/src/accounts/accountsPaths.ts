/**
 * The URLs the client builds, exported rather than hidden.
 *
 * `RestMockPlugin` matches a mock key as the exact string `METHOD url`, query
 * string included, so a map that spells the path by hand silently matches
 * nothing. Keying a mock off these functions is the only way to stay in step.
 *
 * Their own module, not `AccountsApiService.ts`: a mock map importing the
 * service to reach them would close an import cycle and read a `const` from its
 * temporal dead zone at load time.
 */

import { CHILDREN_PAGE_LIMIT, TENANT_TYPES } from './accountsTypes';

export const ACCOUNTS_API_BASE_URL = '/cf/account-management/v1';

export const mePath = (): string => '/me';

export const tenantPath = ({ tenantId }: { tenantId: string }): string =>
  `/tenants/${tenantId}`;

export const tenantsPath = (): string => '/tenants';

/** Every child, whatever its type. */
export function childrenPath({
  tenantId,
  tenantType,
  limit,
  cursor,
}: {
  tenantId: string;
  tenantType?: string;
  limit?: number;
  cursor?: string;
}): string {
  const query = new URLSearchParams();
  if (tenantType) query.set('$filter', `tenant_type eq '${tenantType}'`);
  if (limit !== undefined) query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString();
  return `/tenants/${tenantId}/children${suffix ? `?${suffix}` : ''}`;
}

export const childrenOfTypePath = (tenantId: string, tenantType: string): string =>
  childrenPath({ tenantId, tenantType, limit: CHILDREN_PAGE_LIMIT });

export const workspacesPath = ({ organizationId }: { organizationId: string }): string =>
  childrenOfTypePath(organizationId, TENANT_TYPES.workspace);

export const projectsPath = ({ parentId }: { parentId: string }): string =>
  childrenOfTypePath(parentId, TENANT_TYPES.project);

export const organizationsPath = ({ tenantId }: { tenantId: string }): string =>
  childrenOfTypePath(tenantId, TENANT_TYPES.organization);

export const tenantMetadataPath = ({
  tenantId,
  metadataType,
}: {
  tenantId: string;
  metadataType: string;
}): string => `/tenants/${tenantId}/metadata/${metadataType}`;

export function tenantUserPath({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: string;
}): string {
  const query = new URLSearchParams({ $filter: `id eq ${userId}`, limit: '1' });
  return `/tenants/${tenantId}/users?${query.toString()}`;
}
