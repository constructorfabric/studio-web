import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { apiRegistry, useApiQuery, useQueryCache } from '@gears-frontx/react';
import {
  useDataGrid,
  type DataGridLoadContext,
  type DataGridLoadResult,
} from '@gears-frontx/ui-kit';
import { AccountsApiService, ConnectorsApiService } from '@constructor-studio/mfe-shared';
import { ArtifactIngestApiService } from '../api/ArtifactIngestApiService';
import { DocumentsApiService } from '../api/DocumentsApiService';
import { inFlight } from '../model/repoImport';
import {
  buildSourceRows,
  filterSourceRows,
  sourcesFooter,
  type SourceImportLine,
  type SourcesAnswers,
  type SourcesFooter,
  type SourcesTableRow,
} from '../model/sourceRows';
import { TEXT_SEARCH_FILTER_KEY } from './dataGridFilters';
import { useProjectImport } from './useArtifactImport';
import { repositoryNodesParams } from './useArtifacts';
import { projectConfigQuery, useProjectConfig } from './useProjectConfig';
import { useProjectDocuments } from './useProjectDocuments';

export const SOURCES_FILTER_KEYS = {
  search: TEXT_SEARCH_FILTER_KEY,
} as const;

export interface SourcesLoad {
  ready: boolean;
  failed: boolean;
  rows: SourcesTableRow[];
  footer: SourcesFooter;
  windowDays: number | null;
  retry: () => void;
  load: (context: DataGridLoadContext) => Promise<DataGridLoadResult<SourcesTableRow>>;
  rowsBridge: React.ReactElement;
}

const RowsBridge: React.FC<{ rowsKey: string }> = ({ rowsKey }) => {
  const grid = useDataGrid();
  const shown = useRef(rowsKey);
  useEffect(() => {
    if (shown.current === rowsKey) return;
    shown.current = rowsKey;
    void grid.triggerLoad();
  }, [grid, rowsKey]);
  return null;
};

function settledSyncsOf(lines: readonly SourceImportLine[]): string {
  return lines
    .filter((line) => line.runId !== null && !inFlight(line.status))
    .map((line) => `${line.repo}:${line.runId}:${line.status}`)
    .join('\n');
}

function useOnSyncSettled(projectId: string, settledSyncs: string, onSettled: () => void): void {
  const seen = useRef<{ projectId: string; syncs: Set<string> } | null>(null);
  useEffect(() => {
    const previous = seen.current;
    const current = new Set(settledSyncs ? settledSyncs.split('\n') : []);
    seen.current = { projectId, syncs: current };
    if (previous?.projectId !== projectId) return;
    const newlySettled = [...current].some((sync) => !previous.syncs.has(sync));
    if (newlySettled) onSettled();
  }, [projectId, settledSyncs, onSettled]);
}

// @cpt-dod:cpt-studiofrontend-dod-project-sources-reads:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-gaps:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-search:p1
/** `uploadsName` is the "Uploaded files" row's name, which the search matches. */
export function useSourcesLoad(
  projectId: string,
  workspaceId: string | null,
  orgId: string,
  uploadsName: string
): SourcesLoad {
  const accounts = apiRegistry.getService(AccountsApiService);
  const ingest = apiRegistry.getService(ArtifactIngestApiService);
  const documents = apiRegistry.getService(DocumentsApiService);
  const connectors = apiRegistry.getService(ConnectorsApiService);
  const cache = useQueryCache();

  const config = useProjectConfig(projectId);
  const nodesParams = useMemo(() => repositoryNodesParams(projectId), [projectId]);
  const nodes = useApiQuery(ingest.nodes(nodesParams));
  const connections = useApiQuery(connectors.connections({ tenantId: orgId }));
  const activity = useApiQuery(ingest.sourceActivity({ scope: projectId }));
  const specs = useApiQuery(documents.specsPerSource({ scope: projectId }));
  const studio = useProjectDocuments(workspaceId, projectId);
  const { repos: lines } = useProjectImport(projectId);

  const answers = useMemo<SourcesAnswers>(
    () => ({
      sources: config.config?.sources ?? [],
      nodes: nodes.data?.nodes ?? [],
      connections: connections.isError ? null : (connections.data?.items ?? []),
      activity: activity.isError ? null : (activity.data ?? null),
      specs: specs.isError ? null : (specs.data ?? null),
      lines,
      // Without a workspace they cannot be read either.
      uploads: workspaceId === null || studio.failed ? null : studio.own,
    }),
    [
      config.config,
      nodes.data,
      connections.isError,
      connections.data,
      activity.isError,
      activity.data,
      specs.isError,
      specs.data,
      lines,
      workspaceId,
      studio.failed,
      studio.own,
    ]
  );
  const rows = useMemo(() => buildSourceRows(answers), [answers]);
  const footer = useMemo(() => sourcesFooter(rows, answers), [rows, answers]);

  const rowsKey = useMemo(() => JSON.stringify(rows), [rows]);

  // A repository's numbers move when its sync ends; nothing pushes them.
  const refetchAfterSync = useCallback(() => {
    void cache.invalidate(ingest.nodes(nodesParams));
    void cache.invalidate(ingest.sourceActivity({ scope: projectId }));
    void cache.invalidate(documents.specsPerSource({ scope: projectId }));
  }, [cache, ingest, documents, nodesParams, projectId]);
  useOnSyncSettled(projectId, settledSyncsOf(lines), refetchAfterSync);

  const retry = useCallback(() => {
    void cache.invalidate(projectConfigQuery(accounts, projectId));
    void cache.invalidate(ingest.nodes(nodesParams));
  }, [cache, accounts, ingest, nodesParams, projectId]);

  const rowsRef = useRef(rows);
  const uploadsNameRef = useRef(uploadsName);
  useLayoutEffect(() => {
    rowsRef.current = rows;
    uploadsNameRef.current = uploadsName;
  }, [rows, uploadsName]);

  const load = useCallback(
    async (context: DataGridLoadContext): Promise<DataGridLoadResult<SourcesTableRow>> => {
      const search: string = context.filters?.[SOURCES_FILTER_KEYS.search]?.value ?? '';
      const shown = filterSourceRows(rowsRef.current, search, uploadsNameRef.current);
      const { page, limit } = context.pagination ?? { page: 1, limit: shown.length };
      return { results: shown.slice((page - 1) * limit, page * limit), total: shown.length };
    },
    []
  );

  return {
    ready:
      !config.loading &&
      !nodes.isLoading &&
      !connections.isLoading &&
      !activity.isLoading &&
      !specs.isLoading &&
      !studio.loading,
    failed: config.failed || nodes.isError,
    rows,
    footer,
    windowDays: answers.activity?.days ?? null,
    retry,
    load,
    rowsBridge: <RowsBridge rowsKey={rowsKey} />,
  };
}
