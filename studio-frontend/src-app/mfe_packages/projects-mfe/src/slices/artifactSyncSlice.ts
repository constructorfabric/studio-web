/** Where a project's import stands */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';

export type RepoImportStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'lost'
  | 'unwatched'
  | 'unsyncable';

export interface RepoImport {
  repo: string;
  taskId: string | null;
  status: RepoImportStatus;
  reason: Refusal | null;
  stored: number;
}

export type ImportPhase = 'idle' | 'running' | 'settled' | 'failed';

export interface ProjectImport {
  phase: ImportPhase;
  attempted: boolean;
  repos: RepoImport[];
}

export interface ArtifactSyncState {
  byProject: Record<string, ProjectImport>;
}

const SLICE_KEY = 'projects/artifact-sync' as const;

const initialState: ArtifactSyncState = { byProject: {} };

const EMPTY: ProjectImport = { phase: 'idle', attempted: false, repos: [] };

const UNSETTLED: readonly RepoImportStatus[] = ['queued', 'running'];
const CAME_THROUGH: readonly RepoImportStatus[] = ['succeeded', 'unwatched'];

// @cpt-state:cpt-studiofrontend-state-project-artifacts-import:p2
function settle(repos: readonly RepoImport[]): ImportPhase {
  if (repos.length === 0) return 'settled';
  if (repos.some((r) => UNSETTLED.includes(r.status))) return 'running';
  return repos.some((r) => CAME_THROUGH.includes(r.status)) ? 'settled' : 'failed';
}

function repoOf(state: ArtifactSyncState, projectId: string, repo: string) {
  const entry = state.byProject[projectId];
  const row = entry?.repos.find((r) => r.repo === repo);
  return entry && row ? { entry, row } : null;
}

const { slice, importStarted, repoEnqueued, repoProgressed, importAbandoned } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    importStarted: (
      state: ArtifactSyncState,
      action: ReducerPayload<{
        projectId: string;
        repos: string[];
        unsyncable: { repo: string; reason: Refusal }[];
      }>
    ) => {
      const { projectId, repos, unsyncable } = action.payload;
      const rows: RepoImport[] = [
        ...repos.map((repo) => ({
          repo,
          taskId: null,
          status: 'queued' as const,
          reason: null,
          stored: 0,
        })),
        ...unsyncable.map(({ repo, reason }) => ({
          repo,
          taskId: null,
          status: 'unsyncable' as const,
          reason,
          stored: 0,
        })),
      ];
      state.byProject[projectId] = { phase: settle(rows), attempted: true, repos: rows };
    },

    repoEnqueued: (
      state: ArtifactSyncState,
      action: ReducerPayload<{ projectId: string; repo: string; taskId: string }>
    ) => {
      const found = repoOf(state, action.payload.projectId, action.payload.repo);
      if (!found) return;
      found.row.taskId = action.payload.taskId;
      found.row.status = 'running';
    },

    repoProgressed: (
      state: ArtifactSyncState,
      action: ReducerPayload<{
        projectId: string;
        repo: string;
        status: RepoImportStatus;
        reason: Refusal | null;
        stored: number;
      }>
    ) => {
      const { projectId, repo, status, reason, stored } = action.payload;
      const found = repoOf(state, projectId, repo);
      if (!found) return;
      found.row.status = status;
      found.row.reason = reason;
      found.row.stored = stored;
      found.entry.phase = settle(found.entry.repos);
    },

    importAbandoned: (state: ArtifactSyncState, action: ReducerPayload<string>) => {
      const entry = state.byProject[action.payload];
      if (entry) state.byProject[action.payload] = { ...EMPTY, attempted: entry.attempted };
    },
  },
});

export const artifactSyncSlice = slice;
export { importStarted, repoEnqueued, repoProgressed, importAbandoned };
export const ARTIFACT_SYNC_SLICE_KEY = SLICE_KEY;

export function projectImport(state: ArtifactSyncState, projectId: string): ProjectImport {
  return state.byProject[projectId] ?? EMPTY;
}

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/artifact-sync': ArtifactSyncState;
  }
}

export default slice.reducer;
