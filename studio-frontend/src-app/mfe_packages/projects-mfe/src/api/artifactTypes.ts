/** `GET /nodes` */
export const ARTIFACT_NODE_TYPES = {
  repo: 'gts.cf.studio.artifact.repo.v1~',
  file: 'gts.cf.studio.artifact.file.v1~',
  issue: 'gts.cf.studio.artifact.issue.v1~',
  pullRequest: 'gts.cf.studio.artifact.pull_request.v1~',
} as const;

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
  is_dir?: boolean;
  has_text?: boolean;
  /** RFC 3339. Issues and pull requests only — no other node type has one. */
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
