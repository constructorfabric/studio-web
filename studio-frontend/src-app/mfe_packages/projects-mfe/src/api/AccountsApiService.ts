/**
 * account-management — the only gear behind this MFE now.
 *
 * 1. `/tenants/{id}/children` returns **direct children only** — the repo AND-s
 *    `tenants.parent_id` with the path parent (`repo_impl/reads.rs::list_children`),
 *    and the only query params are `limit`, `cursor`, `$filter`, `$orderby`.
 *    There is no subtree endpoint and no `GET /tenants` collection, and neither
 *    `parent_id` nor `depth` is in the OData allow-list — so "the whole
 *    organization in one request" is not available at any price. The tree is
 *    therefore one request per *expanded* node; see shared/projectTree.tsx.
 * 2. It is cursor-paginated and clamped to 200 rows per page
 *    (`listing.max_top`), so a node with more children needs the cursor.
 * 3. Project attributes are tenant metadata, one GET per project, with no bulk
 *    read of any kind. That is why the list screen does not read them at all
 *    (it would be one request per row) and the project screen does.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { Me, MetadataEntry, Page, ProjectConfig, TenantDto, User } from './types';

/** `POST /tenants`. AM accepts these three fields on create. */
export interface CreateTenantBody {
  name: string;
  parent_id: string;
  tenant_type: string;
}

export const ACCOUNTS_API_BASE_URL = '/cf/account-management/v1';

/** AM's own ceiling (`listing.max_top`), so one page is usually enough. */
export const CHILDREN_PAGE_LIMIT = 200;

export interface ChildrenParams {
  tenantId: string;
  tenantType?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Parameters of the one page the tree reads per node — and therefore the cache
 * key the wizard has to invalidate for a created project to appear in the list.
 */
export function childrenPageParams(tenantId: string): ChildrenParams {
  return { tenantId, limit: CHILDREN_PAGE_LIMIT };
}

function childrenPath({ tenantId, tenantType, limit, cursor }: ChildrenParams): string {
  const query = new URLSearchParams();
  if (tenantType) query.set('$filter', `tenant_type eq '${tenantType}'`);
  if (limit !== undefined) query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString();
  return `/tenants/${tenantId}/children${suffix ? `?${suffix}` : ''}`;
}

export class AccountsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: ACCOUNTS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  readonly me = this.protocol(RestEndpointProtocol).query<Me>('/me');

  readonly tenant = this.protocol(RestEndpointProtocol).queryWith<TenantDto, { tenantId: string }>(
    ({ tenantId }) => `/tenants/${tenantId}`
  );

  readonly children = this.protocol(RestEndpointProtocol).queryWith<Page<TenantDto>, ChildrenParams>(
    childrenPath
  );

  readonly tenantUsers = this.protocol(RestEndpointProtocol).queryWith<
    Page<User>,
    { tenantId: string }
  >(({ tenantId }) => `/tenants/${tenantId}/users`);

  /** 404 means "never set" — see shared/notFound.ts for the read side. */
  readonly projectConfig = this.protocol(RestEndpointProtocol).queryWith<
    MetadataEntry<ProjectConfig>,
    { tenantId: string; metadataType: string }
  >(({ tenantId, metadataType }) => `/tenants/${tenantId}/metadata/${metadataType}`);

  readonly createTenant = this.protocol(RestEndpointProtocol).mutation<
    TenantDto,
    CreateTenantBody
  >('POST', '/tenants');

  projectConfigWrite(tenantId: string, metadataType: string) {
    return this.protocol(RestEndpointProtocol).mutation<unknown, ProjectConfig>(
      'PUT',
      `/tenants/${tenantId}/metadata/${metadataType}`
    );
  }
}
