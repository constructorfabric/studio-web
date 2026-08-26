/**
 * Wire shapes of the studio-connector gear — the second gear this MFE talks to,
 * kept apart from `types.ts` because that file is account-management's
 * vocabulary and these are not tenants.
 */

/**
 * A driver the backend can talk to. `GET /studio-connector/v1/providers`.
 * Read for one field: the properly-cased name for a tab caption — the wire key
 * is `github`, the design says `GitHub`, and casing that by hand gets it wrong.
 */
export interface ProviderDto {
  provider: string;
  display_name: string;
  category: string;
  default_base_url: string;
  instance_id: string;
  credential_label: string;
  credential_hint: string;
}

export interface ProviderListDto {
  items: ProviderDto[];
}

/** A configured source host. `GET /studio-connector/v1/connections`. */
export interface ConnectionDto {
  id: string;
  owner_tenant_id: string;
  provider: string;
  label: string;
  account: string;
  base_url: string;
  scope: string;
  secret_ref: string;
  created_at_epoch_secs: number;
}

export interface ConnectionListDto {
  items: ConnectionDto[];
}

/**
 * A repository reachable through one connection.
 */
export interface RemoteRepoDto {
  id: string;
  name: string;
  full_path: string;
  clone_url: string;
  default_branch?: string | null;
  description?: string | null;
  visibility?: string | null;
}

export interface RemoteRepoListDto {
  items: RemoteRepoDto[];
}
