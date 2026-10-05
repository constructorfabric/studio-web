import type { StudioArtifactKind } from '@constructor-studio/mfe-shared';

/** `GET /nodes`. Keyed by the shell's artifact kinds: a missing or extra one does not compile. */
export const ARTIFACT_NODE_TYPES = {
  repo: 'gts.cf.studio.artifact.repo.v1~',
  file: 'gts.cf.studio.artifact.file.v1~',
  issue: 'gts.cf.studio.artifact.issue.v1~',
  pullRequest: 'gts.cf.studio.artifact.pull_request.v1~',
  // Not in the gear's default listing ("graph detail"); reached through `type`.
  commit: 'gts.cf.studio.artifact.commit.v1~',
  comment: 'gts.cf.studio.artifact.comment.v1~',
  user: 'gts.cf.studio.artifact.user.v1~',
} as const satisfies Record<StudioArtifactKind, string>;

export type ArtifactKind = keyof typeof ARTIFACT_NODE_TYPES;

export const ARTIFACT_REPO_TYPE = 'repo';

export interface ArtifactNodeValue {
  repo?: string;
  full_path?: string;
  title?: string;
  path?: string;
  number?: number;
  state?: string;
  author?: string;
  provider?: string;
  url?: string;
  size?: number;
  sha?: string;
  /** Commits only. */
  short_sha?: string;
  login?: string;
  is_dir?: boolean;
  /** Files read from a checkout rather than listed through a connector. */
  from_checkout?: boolean;
  /** Written by syncs before 2026-10-05, beside an excerpt they no longer store. */
  has_text?: boolean;
  /** RFC 3339. Issues, pull requests, commits and comments — files, repos and users have none. */
  created_at?: string;
  updated_at?: string;
  origin?: string;
  workspace_id?: string;
  project_id?: string;
}

export interface ArtifactNodeDto {
  type_id: string;
  instance_id: string;
  value: ArtifactNodeValue;
}

export interface ArtifactNodeListDto {
  nodes: ArtifactNodeDto[];
  total: number;
  next_cursor?: string;
}

/** `POST /sync` */
export interface SyncBody {
  provider: string;
  base_url?: string;
  secret_ref: string;
  repo_full_path: string;
  workspace_id?: string;
  project_id?: string;
}

export interface SyncEnqueuedDto {
  task_id: string;
  status: string;
}

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface TaskStatusDto {
  task_id: string;
  status: TaskStatus;
  repo_full_path: string;
  message?: string | null;
  issues: number;
  pull_requests: number;
  files: number;
  comments: number;
  commits: number;
  stored: number;
}
