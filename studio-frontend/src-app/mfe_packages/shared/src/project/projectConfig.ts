/**
 * A project's attributes, as the wizard writes them and the shell reads them
 * to launch the editor's session.
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
  /** The branch a session checks out; the repository's default when absent. */
  branch?: string;
}

/**
 * The free-form object under PROJECT_CONFIG_TYPE. The backend declares the
 * metadata type as a bare object ("shape enforced client-side"), so this
 * interface IS the contract.
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
