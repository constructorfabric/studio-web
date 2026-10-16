import type { ProjectSource } from '@constructor-studio/mfe-shared';
import { useEffect, useMemo } from 'react';
import { apiRegistry, eventBus, useApiQuery } from '@gears-frontx/react';
import { ArtifactIngestApiService } from '../api/ArtifactIngestApiService';
import { syncPlan, unsyncedSources } from '../model/syncRequest';
import { useSourceConnections } from './useConnections';
import { useProjectImport } from './useArtifactImport';
import { repositoryNodesParams } from './useArtifacts';
import { requestedInTab } from './importAttempts';
import '../events/artifactEvents';

interface Params {
  projectId: string;
  workspaceId: string | null;
  orgId: string;
  sources: readonly ProjectSource[];
  sourcesRead: boolean;
  isFirstImport: boolean;
}

// @cpt-dod:cpt-studiofrontend-dod-project-sources-sync-missing:p1
// @cpt-algo:cpt-studiofrontend-algo-project-sources-sync-missing:p2
export function useSourcesSync({
  projectId,
  workspaceId,
  orgId,
  sources,
  sourcesRead,
  isFirstImport,
}: Params): void {
  const ingest = apiRegistry.getService(ArtifactIngestApiService);
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-4
  const nodes = useApiQuery(ingest.nodes(repositoryNodesParams(projectId)));
  // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-4
  const { connections, loading, failed } = useSourceConnections(orgId);
  const { repos: lines, lookedUp } = useProjectImport(projectId);

  const repoNodes = nodes.data?.nodes ?? null;
  const byId = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections]
  );
  const ready = sourcesRead && repoNodes !== null && !nodes.isError && !loading && !failed;

  useEffect(() => {
    if (!ready || !repoNodes) return;
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-13
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-14
    if (!lookedUp) return;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-13
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-14
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-1
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-2
    if (isFirstImport) return;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-1
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-2
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-3
    const missing = unsyncedSources(sources, repoNodes, lines, requestedInTab(projectId));
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-3
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-8
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-9
    if (missing.length === 0) return;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-8
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-9
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-10
    const plan = syncPlan(missing, byId);
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-10
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-11
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-12
    eventBus.emit('mfe/artifacts/repos-added', { projectId, workspaceId, ...plan });
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-11
    // @cpt-end:cpt-studiofrontend-algo-project-sources-sync-missing:p2:inst-12
  }, [ready, lookedUp, isFirstImport, sources, repoNodes, lines, byId, projectId, workspaceId]);
}
