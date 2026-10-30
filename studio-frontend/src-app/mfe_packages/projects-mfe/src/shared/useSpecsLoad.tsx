import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiRegistry, eventBus } from '@gears-frontx/react';
import {
  useDataGrid,
  type DataGridLoadContext,
  type DataGridLoadResult,
} from '@gears-frontx/ui-kit';
import { DocumentsApiService } from '../api/DocumentsApiService';
import '../events/specsEvents';
import type { DocumentTypeDto, SpecRowsSourcesDto } from '../api/documentTypes';
import {
  buildSpecRows,
  documentTypeOptions,
  filterSpecRows,
  sortSpecRows,
  type SpecRow,
  type SpecsQuery,
} from '../model/specRows';
import { isSpecsFilter, type SpecsFilter } from '../model/specsFilter';
import { TEXT_SEARCH_FILTER_KEY, tagGroupChoice } from './dataGridFilters';

/** Where the table's plugins put each filter in `DataGridLoadContext.filters` (#692, #878). */
export const SPECS_FILTER_KEYS = {
  filter: 'specs',
  documentType: 'documentType',
  search: TEXT_SEARCH_FILTER_KEY,
} as const;

/** What the page alone does not carry, rebuilt by every load. */
export interface SpecsSnapshot {
  rows: SpecRow[];
  /** The rows the filters keep, in the table's order: what Check takes with nothing selected. */
  shown: SpecRow[];
  /** The *Filter specs* value `shown` was kept by: the footer counts the rows it picks from. */
  filter: SpecsFilter;
  sources: SpecRowsSourcesDto;
  /**
   * What the Type menu offers (#690): the workspace's catalogue in its own order,
   * or, when it did not load, the types the rows have.
   */
  types: DocumentTypeDto[];
  /** `spec-rows` did not load. */
  failed: boolean;
}

export interface SpecsLoad {
  load: (context: DataGridLoadContext) => Promise<DataGridLoadResult<SpecRow>>;
  /** `null` until the first load settles. */
  snapshot: SpecsSnapshot | null;
  /** Reads `spec-rows` again and reloads the table, keeping its filters. */
  reload: () => void;
  /** Render inside the `DataGrid`: it hands the grid's `triggerLoad` to `reload`. */
  reloadBridge: React.ReactElement;
}

interface Answer {
  rows: SpecRow[];
  sources: SpecRowsSourcesDto;
  types: DocumentTypeDto[];
}

const NO_SOURCES: SpecRowsSourcesDto = {
  files_known: true,
  reviews_known: true,
  repos_known: true,
  counts: [],
};

// The search comes from the kit's text search (#692), the filter and the document type from its tag groups (#878).
function queryOf(filters: DataGridLoadContext['filters']): SpecsQuery {
  const filter = tagGroupChoice(filters?.[SPECS_FILTER_KEYS.filter]);
  return {
    filter: isSpecsFilter(filter) ? filter : 'all',
    documentType: tagGroupChoice(filters?.[SPECS_FILTER_KEYS.documentType]),
    search: filters?.[SPECS_FILTER_KEYS.search]?.value ?? '',
  };
}

async function fetchAnswer(projectId: string, workspaceId: string): Promise<Answer> {
  const documents = apiRegistry.getService(DocumentsApiService);
  const [list, types] = await Promise.all([
    // `kept` is the cache here; the shared one would answer reload() with the same rows for 30 s.
    documents.specRows({ projectId }).fetch({ staleTime: 0 }),
    // Without the names a type reads as its key; that is no reason to fail the list.
    documents.types({ workspaceId }).fetch().catch(() => ({ items: [] })),
  ]);
  const rows = buildSpecRows(list.items, list.sources, types.items);
  return {
    rows,
    sources: list.sources,
    types: types.items.length > 0 ? types.items : documentTypeOptions(rows),
  };
}

const ReloadBridge: React.FC<{ triggerRef: React.RefObject<(() => void) | null> }> = ({
  triggerRef,
}) => {
  const grid = useDataGrid();
  useEffect(() => {
    triggerRef.current = () => void grid.triggerLoad();
    return () => {
      triggerRef.current = null;
    };
  }, [grid, triggerRef]);
  return null;
};

/**
 * The Specs table's `load` (#689). `spec-rows` is not paged, so the list is
 * read once per mount of the section and every change of page, order, filter
 * or search works on that answer; only `reload()` reads it again.
 *
 * The read is shared by every load waiting on it, so no load's signal aborts
 * it. A load whose signal was aborted throws instead of returning, which keeps
 * a superseded result out of the grid: it has no stale-response guard.
 */
export function useSpecsLoad(projectId: string, workspaceId: string): SpecsLoad {
  const kept = useRef<{ key: string; answer: Promise<Answer> } | null>(null);
  const triggerRef = useRef<(() => void) | null>(null);
  const [snapshot, setSnapshot] = useState<SpecsSnapshot | null>(null);

  const load = useCallback(
    async (context: DataGridLoadContext): Promise<DataGridLoadResult<SpecRow>> => {
      const key = `${projectId}/${workspaceId}`;
      if (kept.current?.key !== key) kept.current = null;
      let answer: Answer | undefined;
      // reload() can replace the read a load waits on. The load then waits on the newer
      // one, so it neither returns rows from before a change nor fails the grid's first load.
      while (!answer) {
        kept.current ??= { key, answer: fetchAnswer(projectId, workspaceId) };
        const pending = kept.current.answer;
        try {
          const settled = await pending;
          if (kept.current?.answer === pending) answer = settled;
        } catch (error) {
          // Every load that waited on the failed read fails with it: one that read again could
          // write a good snapshot over the failed one and leave the grid on its own error view.
          // Only a load whose read reload() replaced with a newer one waits on that.
          if (!kept.current || kept.current.answer === pending) {
            kept.current = null;
            setSnapshot({
              rows: [],
              shown: [],
              filter: 'all',
              sources: NO_SOURCES,
              types: [],
              failed: true,
            });
            throw error;
          }
        }
        context.signal?.throwIfAborted();
      }

      const query = queryOf(context.filters);
      const shown = sortSpecRows(filterSpecRows(answer.rows, query), context.order?.[0]);
      setSnapshot({
        rows: answer.rows,
        shown,
        filter: query.filter,
        sources: answer.sources,
        types: answer.types,
        failed: false,
      });

      const { page, limit } = context.pagination ?? { page: 1, limit: shown.length };
      return { results: shown.slice((page - 1) * limit, page * limit), total: shown.length };
    },
    [projectId, workspaceId]
  );

  const reload = useCallback(() => {
    kept.current = null;
    triggerRef.current?.();
  }, []);

  useEffect(() => {
    const subscription = eventBus.on('mfe/projects/specs-changed', (changed) => {
      if (changed.projectId === projectId) reload();
    });
    return () => subscription.unsubscribe();
  }, [projectId, reload]);

  return { load, snapshot, reload, reloadBridge: <ReloadBridge triggerRef={triggerRef} /> };
}
