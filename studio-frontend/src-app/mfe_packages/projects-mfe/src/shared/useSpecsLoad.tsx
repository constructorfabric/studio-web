import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import {
  useDataGrid,
  type DataGridLoadContext,
  type DataGridLoadResult,
} from '@gears-frontx/ui-kit';
import { DocumentsApiService } from '../api/DocumentsApiService';
import type { SpecRowsSourcesDto } from '../api/documentTypes';
import {
  buildSpecRows,
  filterSpecRows,
  sortSpecRows,
  type SpecRow,
  type SpecsQuery,
} from '../model/specRows';

/** Where the table's plugins put each filter in `DataGridLoadContext.filters` (#692). */
export const SPECS_FILTER_KEYS = {
  filter: 'specs',
  documentType: 'documentType',
  search: 'textSearch',
} as const;

/** What the page alone does not carry, rebuilt by every load. */
export interface SpecsSnapshot {
  rows: SpecRow[];
  /** The rows the filters keep, in the table's order: what Check takes with nothing selected. */
  shown: SpecRow[];
  sources: SpecRowsSourcesDto;
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
}

const NO_SOURCES: SpecRowsSourcesDto = {
  files_known: true,
  reviews_known: true,
  repos_known: true,
  counts: [],
};

// The values come from #692's own plugins, which keep them in memory.
function queryOf(filters: DataGridLoadContext['filters']): SpecsQuery {
  return {
    filter: filters?.[SPECS_FILTER_KEYS.filter]?.value ?? 'all',
    documentType: filters?.[SPECS_FILTER_KEYS.documentType]?.value ?? null,
    search: filters?.[SPECS_FILTER_KEYS.search]?.value ?? '',
  };
}

async function fetchAnswer(projectId: string, workspaceId: string): Promise<Answer> {
  const documents = apiRegistry.getService(DocumentsApiService);
  const [list, types] = await Promise.all([
    documents.specRows({ projectId }).fetch(),
    // Without the names a type reads as its key; that is no reason to fail the list.
    documents.types({ workspaceId }).fetch().catch(() => ({ items: [] })),
  ]);
  return { rows: buildSpecRows(list.items, list.sources, types.items), sources: list.sources };
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
      if (kept.current?.key !== key) {
        kept.current = { key, answer: fetchAnswer(projectId, workspaceId) };
      }
      const pending = kept.current.answer;
      // Another project, or reload(), may have started a newer read meanwhile.
      const current = () => kept.current?.answer === pending;
      let answer: Answer;
      try {
        answer = await pending;
      } catch (error) {
        if (current()) {
          kept.current = null;
          setSnapshot({ rows: [], shown: [], sources: NO_SOURCES, failed: true });
        }
        throw error;
      }
      context.signal?.throwIfAborted();
      if (!current()) throw new Error('A newer read of spec-rows replaced this one');

      const filtered = filterSpecRows(answer.rows, queryOf(context.filters));
      const shown = sortSpecRows(filtered, context.order?.[0]);
      setSnapshot({ rows: answer.rows, shown, sources: answer.sources, failed: false });

      const { page, limit } = context.pagination ?? { page: 1, limit: shown.length };
      return { results: shown.slice((page - 1) * limit, page * limit), total: shown.length };
    },
    [projectId, workspaceId]
  );

  const reload = useCallback(() => {
    kept.current = null;
    triggerRef.current?.();
  }, []);

  return { load, snapshot, reload, reloadBridge: <ReloadBridge triggerRef={triggerRef} /> };
}
