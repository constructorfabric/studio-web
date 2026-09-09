/**
 * The projects domain's own shapes. Everything that is account-management's
 * vocabulary — the tenant, the page envelope, `TENANT_TYPES`, `Me`, `User`,
 * `MetadataEntry` — now lives in `@constructor-studio/mfe-shared`, because it
 * was the same wire in two MFEs and the two copies had already drifted.
 *
 * What stays here is what only this MFE writes.
 */

/** Project attributes live in this tenant-metadata type, per tenant. */
export const PROJECT_CONFIG_TYPE =
  'gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~';

export type ProjectMode = 'greenfield' | 'modernize';
export type ProjectStatus = 'draft' | 'active' | 'archived';

/** One repository a project was seeded from. */
export interface ProjectSource {
  connection_id: string;
  full_path: string;
  clone_url: string;
}

/**
 * The free-form object under PROJECT_CONFIG_TYPE. The backend declares the
 * metadata type as a bare object ("shape enforced client-side"), so this
 * interface IS the contract.
 *
 * Do not add fields nothing writes: a `description` used to live here for a
 * second line in the mockups, and it could only ever render empty.
 */
export interface ProjectConfig {
  mode?: ProjectMode;
  stages?: string[];
  status?: ProjectStatus;
  sources?: ProjectSource[];
  source_git_url?: string;
  brief?: string;
  owner_id?: string;
}
