/**
 * A project's attributes, as the wizard writes them and the shell reads them
 * to launch the editor's session.
 */

/** Project attributes live in this tenant-metadata type, per tenant. */
export const PROJECT_CONFIG_TYPE =
  'gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~';

export type ProjectMode = 'greenfield' | 'modernize';
export type ProjectStatus = 'draft' | 'active' | 'archived';

/**
 * How the IDE's "Share with the team" lands a person's edits in a repository:
 * `branch` commits and pushes straight to the branch the project works on;
 * `pull_request` pushes to a per-person branch and opens (or adds to) a pull
 * request. Pull requests are GitHub-only for now.
 */
export type ShareMode = 'branch' | 'pull_request';

/** What an absent `share_mode` means — the behaviour every older project has. */
export const DEFAULT_SHARE_MODE: ShareMode = 'branch';

/** One repository a project was seeded from. */
export interface ProjectSource {
  connection_id: string;
  full_path: string;
  clone_url: string;
  /** The branch a session checks out; the repository's default when absent. */
  branch?: string;
  /** How shared edits reach this repository; {@link DEFAULT_SHARE_MODE} when absent. */
  share_mode?: ShareMode;
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
