import type { ProjectSource } from '@constructor-studio/mfe-shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRegistry, useApiQuery, useQueryCache } from '@gears-frontx/react';
import { ArtifactIngestApiService, type NodesParams } from '../api/ArtifactIngestApiService';
import { ARTIFACT_NODE_TYPES, ARTIFACT_REPO_TYPE, type ArtifactKind } from '../api/artifactTypes';
import {
  artifactPage,
  buildArtifactRows,
  buildRepositories,
  studioDocumentRow,
  type ArtifactRepository,
  type ArtifactRow,
} from '../model/artifact';
import { useProjectConfig } from './useProjectConfig';
import { useProjectImport } from './useArtifactImport';
import { useProjectDocuments } from './useProjectDocuments';

export const ARTIFACTS_PAGE_SIZE = 18;

const REPOSITORY_CEILING = 200;

export function repositoryNodesParams(projectId: string): NodesParams {
  return { scope: projectId, type: ARTIFACT_REPO_TYPE, limit: REPOSITORY_CEILING };
}

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

/** The stored count grows once per flushed chunk; it re-reads the artifacts at most this often. */
const STORED_REFRESH_MS = 2_000;

// @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-11
/** Re-reads when a run starts, since the gear writes its repository's node then, when one settles, and when the stored count grows. */
function useImportRefresh(projectId: string, refetch: () => void): void {
  const importState = useProjectImport(projectId);
  const stored = importState.repos.reduce((sum, repo) => sum + repo.stored, 0);
  const statuses = importState.repos.map((repo) => repo.status).join();
  const watching = importState.phase === 'running';
  const seen = useRef<{ stored: number; statuses: string } | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(refetch);

  useEffect(() => {
    latest.current = refetch;
  }, [refetch]);

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    },
    []
  );

  useEffect(() => {
    const last = seen.current;
    if (last?.stored === stored && last.statuses === statuses) return;
    seen.current = { stored, statuses };
    if (!last && stored === 0 && !watching) return;
    if (last?.statuses === statuses) {
      pending.current ??= setTimeout(() => {
        pending.current = null;
        latest.current();
      }, STORED_REFRESH_MS);
      return;
    }
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    refetch();
  }, [stored, statuses, watching, refetch]);
}
// @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-11

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-counters:p1
// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-page:p1
export function useArtifacts(
  projectId: string,
  workspaceId: string | null,
  query: ArtifactsQuery
): ArtifactsView {
  const ingest = apiRegistry.getService(ArtifactIngestApiService);
  const cache = useQueryCache();
  const pageSize = query.pageSize ?? ARTIFACTS_PAGE_SIZE;
  const search = query.search.trim();

  // The project's own Studio documents come first. They have no repository and no kind,
  // so either filter hides them; the search matches their title.
  const studio = useProjectDocuments(workspaceId, projectId);
  const documents = useMemo(() => {
    if (query.repo || query.kind) return [];
    const needle = search.toLowerCase();
    return studio.own.filter((document) => document.title.toLowerCase().includes(needle));
  }, [studio.own, query.repo, query.kind, search]);
  const split = useMemo(
    () => artifactPage(documents, query.offset, pageSize),
    [documents, query.offset, pageSize]
  );

  const pageParams = useMemo<NodesParams>(
    () => ({
      scope: projectId,
      sort: 'updated',
      limit: Math.max(1, split.graphLimit),
      offset: split.graphOffset,
      repo: query.repo ?? undefined,
      type: query.kind ? ARTIFACT_NODE_TYPES[query.kind] : undefined,
      q: search || undefined,
    }),
    [projectId, split.graphLimit, split.graphOffset, query.repo, query.kind, search]
  );

  const repositoryParams = useMemo(() => repositoryNodesParams(projectId), [projectId]);

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
    () => [
      ...split.docRows.map(studioDocumentRow),
      ...buildArtifactRows(page.data?.nodes ?? [], repoNames).slice(0, split.graphLimit),
    ],
    [split.docRows, split.graphLimit, page.data, repoNames]
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
    total: (page.data?.total ?? held?.total ?? 0) + documents.length,
    projectTotal: scope.total + studio.own.length,
    repositoryTotal: query.repo && repositoryTotalNodes.data ? repositoryTotalNodes.data.total : null,
    repositoryTotalFailed: query.repo !== null && repositoryTotalNodes.isError,
    repositories,
    sources: scope.sources,
    loading:
      (page.isLoading && held === null) ||
      repositoryNodes.isLoading ||
      scope.loading ||
      studio.loading,
    refreshing: page.isLoading && held !== null,
    failed: page.isError || repositoryNodes.isError || scope.failed,
    refetch,
  };
}
