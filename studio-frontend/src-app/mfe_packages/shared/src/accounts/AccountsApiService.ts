/** account-management, for every MFE that reads it.  */

import {
  BaseApiService,
  RestEndpointProtocol,
  RestProtocol,
  type EndpointDescriptor,
} from '@gears-frontx/react';
import { orNullOnNotFound } from '../errors/notFound';
import {
  ACCOUNTS_API_BASE_URL,
  childrenPath,
  mePath,
  organizationsPath,
  projectsPath,
  tenantMetadataPath,
  tenantPath,
  tenantUserPath,
  tenantsPath,
  workspacesPath,
} from './accountsPaths';
import { TENANT_TYPES } from './accountsTypes';
import type { Me, MetadataEntry, Page, Tenant, User } from './accountsTypes';

export { ACCOUNTS_API_BASE_URL };

/** AM accepts these three fields on create. */
export interface CreateTenantBody {
  name: string;
  parent_id: string;
  tenant_type: string;
}

export class AccountsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    super(
      { baseURL: ACCOUNTS_API_BASE_URL },
      restProtocol,
      new RestEndpointProtocol(restProtocol)
    );
  }

  private get rest() {
    return this.protocol(RestEndpointProtocol);
  }

  /** Whom the presented token authenticates as. */
  readonly getMe = this.protocol(RestEndpointProtocol).query<Me>(mePath());

  /** One tenant by id — `/me` answers with an id and never a name. */
  readonly getTenant = this.protocol(RestEndpointProtocol).queryWith<
    Tenant,
    { tenantId: string }
  >(tenantPath);

  /**
   * Every child of a tenant, unfiltered. For the callers that partition the
   * page themselves; prefer the three named reads below.
   */
  readonly getChildren = this.protocol(RestEndpointProtocol).queryWith<
    Page<Tenant>,
    { tenantId: string; tenantType?: string; limit?: number; cursor?: string }
  >(childrenPath);

  readonly getOrganizations = this.protocol(RestEndpointProtocol).queryWith<
    Page<Tenant>,
    { tenantId: string }
  >(organizationsPath);

  readonly getWorkspaces = this.protocol(RestEndpointProtocol).queryWith<
    Page<Tenant>,
    { organizationId: string }
  >(workspacesPath);

  /**
   * `parentId`, not `workspaceId`: a project's allowed parents are the
   * organization AND the workspace (dev.yaml, ADR-0010), and the New project
   * wizard creates one straight under the organization.
   */
  readonly getProjects = this.protocol(RestEndpointProtocol).queryWith<
    Page<Tenant>,
    { parentId: string }
  >(projectsPath);

  /** The one user matching an id inside a tenant, as a one-item page. */
  readonly findTenantUser = this.protocol(RestEndpointProtocol).queryWith<
    Page<User>,
    { tenantId: string; userId: string }
  >(tenantUserPath);

  private readonly metadataEntry = this.protocol(RestEndpointProtocol).queryWith<
    MetadataEntry<unknown>,
    { tenantId: string; metadataType: string }
  >(tenantMetadataPath);

  /**
   * A tenant's metadata of one type, or `null` when it was never written — a
   * 404 here is data, not a failure. Generic on purpose: the envelope is AM's,
   * the payload belongs to whichever MFE owns that metadata type.
   */
  getTenantMetadata<T>(params: {
    tenantId: string;
    metadataType: string;
  }): EndpointDescriptor<MetadataEntry<T> | null> {
    return orNullOnNotFound(
      this.metadataEntry(params) as EndpointDescriptor<MetadataEntry<T>>
    );
  }

  putTenantMetadata<T>(tenantId: string, metadataType: string) {
    return this.rest.mutation<unknown, T>(
      'PUT',
      tenantMetadataPath({ tenantId, metadataType })
    );
  }

  private readonly createTenant = this.protocol(RestEndpointProtocol).mutation<
    Tenant,
    CreateTenantBody
  >('POST', tenantsPath());

  /**
   * The same POST as `createProject`, with the one field that decides which of
   * the two it is. A caller that had to pass `tenant_type` itself could pass
   * the wrong one, and nothing would complain until the tenant tree was wrong.
   */
  createWorkspace(
    params: { name: string; parentId: string },
    options?: { signal?: AbortSignal }
  ): Promise<Tenant> {
    return this.createTenant.fetch(
      { name: params.name, parent_id: params.parentId, tenant_type: TENANT_TYPES.workspace },
      options
    );
  }

  createProject(
    params: { name: string; parentId: string },
    options?: { signal?: AbortSignal }
  ): Promise<Tenant> {
    return this.createTenant.fetch(
      { name: params.name, parent_id: params.parentId, tenant_type: TENANT_TYPES.project },
      options
    );
  }
}
