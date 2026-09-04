import { useCallback, useMemo } from 'react';
import { eventBus, useAppSelector } from '@gears-frontx/react';
import { useSourceConnections } from './useConnections';
import { attemptedInTab } from './importAttempts';
import {
  ARTIFACT_SYNC_SLICE_KEY,
  projectImport,
  type ProjectImport,
} from '../slices/artifactSyncSlice';
import type { SyncRequest } from '../events/artifactEvents';
import type { ProjectSource } from '../api/types';
import '../events/artifactEvents';

export function useProjectImport(projectId: string): ProjectImport {
  return useAppSelector((s) => projectImport(s[ARTIFACT_SYNC_SLICE_KEY], projectId));
}

export interface ArtifactImportView {
  isFirstImport: boolean;
  canSync: boolean;
  start: () => void;
}

interface Params {
  projectId: string;
  workspaceId: string | null;
  orgId: string;
  sources: readonly ProjectSource[];
  artifactCount: number;
  artifactsRead: boolean;
}

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-import-detect:p1
// @cpt-algo:cpt-studiofrontend-algo-project-artifacts-first-import:p2
export function useArtifactImport({
  projectId,
  workspaceId,
  orgId,
  sources,
  artifactCount,
  artifactsRead,
}: Params): ArtifactImportView {
  const state = useProjectImport(projectId);
  const {
    connections,
    loading: connectionsLoading,
    failed: connectionsFailed,
  } = useSourceConnections(orgId);

  const connectionsRead = !connectionsLoading && !connectionsFailed;

  const byId = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections]
  );

  const isFirstImport =
    artifactsRead &&
    connectionsRead &&
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-1
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-2
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-3
    sources.length > 0 &&
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-1
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-2
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-3
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-4
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-5
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-6
    artifactCount === 0 &&
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-4
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-5
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-6
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-7
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-8
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-9
    !state.attempted &&
    !attemptedInTab(projectId);
  // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-7
  // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-8
  // @cpt-end:cpt-studiofrontend-algo-project-artifacts-first-import:p2:inst-9

  const start = useCallback(() => {
    const request: SyncRequest = { projectId, workspaceId, repos: [], unsyncable: [] };
    for (const source of sources) {
      const connection = byId.get(source.connection_id);
      if (!connection) {
        request.unsyncable.push({
          repo: source.full_path,
          reason: { kind: 'i18n', key: 'artifacts_reason_no_connection' },
        });
        continue;
      }
      request.repos.push({
        repo: source.full_path,
        provider: connection.provider,
        baseUrl: connection.base_url || undefined,
        secretRef: connection.secret_ref,
      });
    }
    eventBus.emit('mfe/artifacts/sync-requested', request);
  }, [projectId, workspaceId, sources, byId]);

  return {
    isFirstImport,
    canSync: sources.length > 0 && connectionsRead,
    start,
  };
}
