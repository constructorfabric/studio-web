import { ProjectSource } from '../api/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRegistry, useApiQuery, useQueryCache } from '@gears-frontx/react';
import { ArtifactIngestApiService, type NodesParams } from '../api/ArtifactIngestApiService';
import { ARTIFACT_NODE_TYPES, ARTIFACT_REPO_TYPE, type ArtifactKind } from '../api/artifactTypes';
import {
  buildArtifactRows,
  buildRepositories,
  type ArtifactRepository,
  type ArtifactRow,
} from '../model/artifact';
import { useProjectConfig } from './useProjectConfig';
import { useProjectImport } from './useArtifactImport';

export const ARTIFACTS_PAGE_SIZE = 18;

/** An offset at or past the last row moves back to the start of the last page. */
export function clampOffset(offset: number, total: number): number {
  return total > 0 && offset >= total
    ? (Math.ceil(total / ARTIFACTS_PAGE_SIZE) - 1) * ARTIFACTS_PAGE_SIZE
    : offset;
}

const REPOSITORY_CEILING = 200;

export interface ArtifactCountView {
  total: number;
  sources: ProjectSource[];
  loading: boolean;
  failed: boolean;
}

export function useArtifactCount(projectId: string): ArtifactCountView {
  const ingest = apiRegistry.getService(ArtifactIngestApiService);
  const { data, isLoading, isError } = useApiQuery(
    ingest.nodes({ scope: projectId, limit: 1 })
  );
  const { config, loading: configLoading, failed: configFailed } = useProjectConfig(projectId);
  const sources = useMemo(() => config?.sources ?? [], [config]);

  return {
    total: data?.total ?? 0,
    sources,
    loading: isLoading || configLoading,
    failed: isError || configFailed,
  };
}

export interface ArtifactsQuery {
  repo: string | null;
  kind: ArtifactKind | null;
  search: string;
  offset: number;
  pageSize?: number;
}

export interface ArtifactsView {
  rows: ArtifactRow[];
  total: number;
  projectTotal: number;
  repositoryTotal: number | null;
  repositoryTotalFailed: boolean;
  repositories: ArtifactRepository[];
  sources: ProjectSource[];
  /** Nothing to show yet: the first page, the repositories or the count. */
  loading: boolean;
  /** A filter or page changed and its rows are on the way; `total` is the last one. */
  refreshing: boolean;
  failed: boolean;
  refetch: () => void;
}

// @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-6
// @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-7
function useImportRefresh(projectId: string, refetch: () => void): void {
  const importState = useProjectImport(projectId);
  const stored = importState.repos.reduce((sum, repo) => sum + repo.stored, 0);
  const watching = importState.phase === 'running';
  const seen = useRef<string | null>(null);

  useEffect(() => {
    const mark = `${stored}|${watching}`;
    if (seen.current === mark) return;
    const first = seen.current === null;
    seen.current = mark;
    if (first && stored === 0 && !watching) return;
    refetch();
  }, [stored, watching, refetch]);
}
// @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-6
// @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-7

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-counters:p1
// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-page:p1
export function useArtifacts(projectId: string, query: ArtifactsQuery): ArtifactsView {
  const ingest = apiRegistry.getService(ArtifactIngestApiService);
  const cache = useQueryCache();
  const pageSize = query.pageSize ?? ARTIFACTS_PAGE_SIZE;
  const search = query.search.trim();

  const pageParams = useMemo<NodesParams>(
    () => ({
      scope: projectId,
      sort: 'updated',
      limit: pageSize,
      offset: query.offset,
      repo: query.repo ?? undefined,
      type: query.kind ? ARTIFACT_NODE_TYPES[query.kind] : undefined,
      q: search || undefined,
    }),
    [projectId, pageSize, query.offset, query.repo, query.kind, search]
  );

  const repositoryParams = useMemo<NodesParams>(
    () => ({ scope: projectId, type: ARTIFACT_REPO_TYPE, limit: REPOSITORY_CEILING }),
    [projectId]
  );

  const page = useApiQuery(ingest.nodes(pageParams));
  // The last answer for this project, so a new filter keeps the strip and the
  // paginator on screen instead of dropping back to the first-load skeleton.
  const [settled, setSettled] = useState<{ projectId: string; total: number } | null>(null);
  if (page.data && (settled?.projectId !== projectId || settled.total !== page.data.total)) {
    setSettled({ projectId, total: page.data.total });
  }
  const held = settled?.projectId === projectId ? settled : null;
  const repositoryNodes = useApiQuery(ingest.nodes(repositoryParams));
  const scope = useArtifactCount(projectId);

  const repositoryTotalParams = useMemo<NodesParams>(
    () =>
      query.repo ? { scope: projectId, repo: query.repo, limit: 1 } : { scope: projectId, limit: 1 },
    [projectId, query.repo]
  );
  const repositoryTotalNodes = useApiQuery(ingest.nodes(repositoryTotalParams));

  const repositories = useMemo(
    () => buildRepositories(repositoryNodes.data?.nodes ?? []),
    [repositoryNodes.data]
  );
  const repoNames = useMemo(
    () => new Map(repositories.map((repository) => [repository.id, repository.name])),
    [repositories]
  );
  const rows = useMemo(
    () => buildArtifactRows(page.data?.nodes ?? [], repoNames),
    [page.data, repoNames]
  );

  const refetch = useCallback(() => {
    void cache.invalidate(ingest.nodes(pageParams));
    void cache.invalidate(ingest.nodes(repositoryParams));
    void cache.invalidate(ingest.nodes({ scope: projectId, limit: 1 }));
    void cache.invalidate(ingest.nodes(repositoryTotalParams));
  }, [cache, ingest, pageParams, repositoryParams, projectId, repositoryTotalParams]);

  useImportRefresh(projectId, refetch);

  return {
    rows,
    total: page.data?.total ?? held?.total ?? 0,
    projectTotal: scope.total,
    repositoryTotal: query.repo && repositoryTotalNodes.data ? repositoryTotalNodes.data.total : null,
    repositoryTotalFailed: query.repo !== null && repositoryTotalNodes.isError,
    repositories,
    sources: scope.sources,
    loading: (page.isLoading && held === null) || repositoryNodes.isLoading || scope.loading,
    refreshing: page.isLoading && held !== null,
    failed: page.isError || repositoryNodes.isError || scope.failed,
    refetch,
  };
}
