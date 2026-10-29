import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecRowDto, SpecRowListDto } from '../api/documentTypes';

type FetchOptions = { signal?: AbortSignal; staleTime?: number };

const { specRows, types, triggerLoad } = vi.hoisted(() => ({
  specRows: vi.fn<(options?: FetchOptions) => Promise<SpecRowListDto>>(),
  types: vi.fn<() => Promise<{ items: { key: string; name: string }[] }>>(),
  triggerLoad: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: {
    getService: () => ({
      specRows: () => ({ fetch: specRows }),
      types: () => ({ fetch: types }),
    }),
  },
}));
vi.mock('@gears-frontx/ui-kit', () => ({ useDataGrid: () => ({ triggerLoad }) }));
vi.mock('../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));

import { eventBus } from '@gears-frontx/react';
import { specRowDto } from '../model/specRows.fixture';
import { SPECS_FILTER_KEYS, useSpecsLoad } from './useSpecsLoad';

const row = (name: string, overrides: Partial<SpecRowDto> = {}) =>
  specRowDto({ name, ...overrides });

const LIST: SpecRowListDto = {
  items: [row('a.md'), row('b.md', { findings: 2 }), row('c.md'), row('d.md', { type_key: 'adr' })],
  total: 4,
  sources: { files_known: true, reviews_known: true, repos_known: false, counts: [] },
};

const names = (result: { results: { name: string }[] }) => result.results.map((r) => r.name);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const page = (n: number, limit = 2) => ({ pagination: { page: n, limit } });

beforeEach(() => {
  specRows.mockReset().mockResolvedValue(LIST);
  types.mockReset().mockResolvedValue({ items: [{ key: 'prd', name: 'PRD' }] });
  triggerLoad.mockReset();
});

describe('useSpecsLoad', () => {
  it('reads spec-rows once, then pages, filters and orders from memory', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    const { load } = result.current;

    const first = await act(() => load(page(1)));
    expect(names(first)).toEqual(['a.md', 'b.md']);
    expect(first.total).toBe(4);
    expect(names(await act(() => load(page(2))))).toEqual(['c.md', 'd.md']);

    const filtered = await act(() =>
      load({
        ...page(1),
        filters: { [SPECS_FILTER_KEYS.filter]: { value: ['with_findings'] } },
      })
    );
    expect(names(filtered)).toEqual(['b.md']);
    expect(filtered.total).toBe(1);

    const searched = await act(() =>
      load({ filters: { [SPECS_FILTER_KEYS.search]: { value: 'C.MD' } } })
    );
    expect(names(searched)).toEqual(['c.md']);

    const ordered = await act(() =>
      load({ ...page(1, 4), order: [{ column: 'document', direction: 'desc' }] })
    );
    expect(names(ordered)).toEqual(['d.md', 'c.md', 'b.md', 'a.md']);

    expect(specRows).toHaveBeenCalledTimes(1);
    expect(types).toHaveBeenCalledTimes(1);
  });

  it('reads a stored filter that is not a list, or not a known filter, as none', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    for (const value of ['with_findings', ['no_such_filter'], [3]]) {
      const loaded = await act(() =>
        result.current.load({ ...page(1, 4), filters: { [SPECS_FILTER_KEYS.filter]: { value } } })
      );
      expect(names(loaded)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    }
  });

  it('keeps every row, the filtered ones and the flags in the snapshot', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    await act(() =>
      result.current.load({
        ...page(1, 1),
        filters: { [SPECS_FILTER_KEYS.documentType]: { value: ['prd'] } },
      })
    );
    const snapshot = result.current.snapshot!;
    expect(snapshot.rows).toHaveLength(4);
    expect(snapshot.shown.map((r) => r.name)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(snapshot.sources).toBe(LIST.sources);
    expect(snapshot.failed).toBe(false);
  });

  it("offers the workspace's types in the catalogue's own order", async () => {
    const catalogue = [
      { key: 'runbook', name: 'Runbook' },
      { key: 'prd', name: 'PRD' },
    ];
    types.mockResolvedValue({ items: catalogue });
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    await act(() => result.current.load(page(1)));
    expect(result.current.snapshot?.types).toEqual(catalogue);
  });

  it('offers the types the rows have when the catalogue does not load', async () => {
    types.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    await act(() => result.current.load(page(1)));
    expect(result.current.snapshot?.types).toEqual([
      { key: 'adr', name: 'adr' },
      { key: 'prd', name: 'prd' },
    ]);
  });

  it('reads spec-rows again when its project says they changed, and only then', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    render(result.current.reloadBridge);
    await act(() => result.current.load(page(1)));

    act(() => eventBus.emit('mfe/projects/specs-changed', { projectId: 'p2' }));
    expect(triggerLoad).not.toHaveBeenCalled();
    act(() => eventBus.emit('mfe/projects/specs-changed', { projectId: 'p1' }));
    expect(triggerLoad).toHaveBeenCalledTimes(1);
    await act(() => result.current.load(page(1)));
    expect(specRows).toHaveBeenCalledTimes(2);
  });

  it('names a type by its key when the types do not load', async () => {
    types.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    const loaded = await act(() => result.current.load(page(1, 4)));
    expect(loaded.results.map((r) => r.type?.name)).toEqual(['prd', 'prd', 'prd', 'adr']);
    expect(result.current.snapshot?.failed).toBe(false);
  });

  it('marks the snapshot failed when spec-rows does not load, and reads it next time', async () => {
    specRows.mockRejectedValueOnce(new Error('502'));
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    await act(async () => {
      await expect(result.current.load(page(1))).rejects.toThrow('502');
    });
    expect(result.current.snapshot?.failed).toBe(true);

    expect(names(await act(() => result.current.load(page(1))))).toEqual(['a.md', 'b.md']);
    expect(result.current.snapshot?.failed).toBe(false);
    expect(specRows).toHaveBeenCalledTimes(2);
  });

  it('throws for a load the grid aborted, without failing the list', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    const aborted = new AbortController();
    aborted.abort();
    await act(async () => {
      await expect(result.current.load({ signal: aborted.signal })).rejects.toThrow();
    });
    expect(result.current.snapshot).toBeNull();
    expect(names(await act(() => result.current.load(page(1))))).toEqual(['a.md', 'b.md']);
    expect(specRows).toHaveBeenCalledTimes(1);
  });

  it('reads spec-rows again on reload, through the grid the bridge is rendered in', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    render(result.current.reloadBridge);
    await act(() => result.current.load(page(1)));

    act(() => result.current.reload());
    expect(triggerLoad).toHaveBeenCalledTimes(1);
    await act(() => result.current.load(page(1)));
    expect(specRows).toHaveBeenCalledTimes(2);
    // Past the shared fetch cache, which would hand back the same rows for 30 s.
    expect(specRows).toHaveBeenLastCalledWith({ staleTime: 0 });
  });

  it('reads the list of the project it is asked about', async () => {
    const { result, rerender } = renderHook(({ project }) => useSpecsLoad(project, 'w1'), {
      initialProps: { project: 'p1' },
    });
    await act(() => result.current.load(page(1)));
    rerender({ project: 'p2' });
    await act(() => result.current.load(page(1)));
    expect(specRows).toHaveBeenCalledTimes(2);
  });
});

describe('useSpecsLoad, with reads that overlap', () => {
  it('serves loads started together from one read', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    const [first, second] = await act(() =>
      Promise.all([
        result.current.load(page(1)),
        result.current.load({
          filters: { [SPECS_FILTER_KEYS.filter]: { value: ['with_findings'] } },
        }),
      ])
    );
    expect(names(first)).toEqual(['a.md', 'b.md']);
    expect(names(second)).toEqual(['b.md']);
    expect(specRows).toHaveBeenCalledTimes(1);
  });

  it('answers a waiting load from the read a load the grid aborted started', async () => {
    const read = deferred<SpecRowListDto>();
    specRows.mockImplementationOnce((options) => {
      options?.signal?.addEventListener('abort', () => read.reject(new Error('aborted')));
      return read.promise;
    });
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    const grid = new AbortController();
    const aborted = result.current.load({ ...page(1), signal: grid.signal });
    const waiting = result.current.load(page(1));
    grid.abort();
    await act(async () => {
      read.resolve(LIST);
      await expect(aborted).rejects.toThrow();
    });
    expect(names(await act(() => waiting))).toEqual(['a.md', 'b.md']);
    expect(specRows).toHaveBeenCalledTimes(1);
  });

  it("answers from the newer project's read when the older read fails late", async () => {
    const older = deferred<SpecRowListDto>();
    specRows.mockReturnValueOnce(older.promise);
    const { result, rerender } = renderHook(({ project }) => useSpecsLoad(project, 'w1'), {
      initialProps: { project: 'p1' },
    });
    const late = result.current.load(page(1));
    rerender({ project: 'p2' });
    await act(() => result.current.load(page(1)));
    await act(async () => {
      older.reject(new Error('502'));
      await late;
    });
    expect(result.current.snapshot?.failed).toBe(false);
    expect(result.current.snapshot?.rows).toHaveLength(4);
  });

  it('lets a load whose read reload() replaced wait on the newer read', async () => {
    const stale = deferred<SpecRowListDto>();
    specRows.mockReturnValueOnce(stale.promise);
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    // The grid's first load: throwing here would leave the grid on its error view.
    const first = result.current.load(page(1, 4));
    act(() => result.current.reload());
    await act(async () => {
      stale.resolve({ ...LIST, items: [row('stale.md')] });
      expect(names(await first)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    });
    expect(specRows).toHaveBeenCalledTimes(2);
  });

  it('answers with the newer read even when the one reload() replaced answers last', async () => {
    const stale = deferred<SpecRowListDto>();
    specRows.mockReturnValueOnce(stale.promise);
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    const late = result.current.load(page(1, 4));
    act(() => result.current.reload());
    await act(() => result.current.load(page(1, 4)));
    await act(async () => {
      stale.resolve({ ...LIST, items: [row('stale.md')] });
      expect(names(await late)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    });
    const rows = result.current.snapshot?.rows.map((r) => r.name);
    expect(rows).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    expect(specRows).toHaveBeenCalledTimes(2);
  });

  it('keeps the fresh read when the one reload() replaced fails', async () => {
    const stale = deferred<SpecRowListDto>();
    specRows.mockReturnValueOnce(stale.promise);
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    const late = result.current.load(page(1));
    act(() => result.current.reload());
    await act(() => result.current.load(page(1)));
    await act(async () => {
      stale.reject(new Error('502'));
      expect(names(await late)).toEqual(['a.md', 'b.md']);
    });
    expect(result.current.snapshot?.failed).toBe(false);
    await act(() => result.current.load(page(2)));
    expect(specRows).toHaveBeenCalledTimes(2);
  });

  it('reads again after reload() before the grid has mounted the bridge', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    await act(() => result.current.load(page(1)));
    act(() => result.current.reload());
    expect(triggerLoad).not.toHaveBeenCalled();
    await act(() => result.current.load(page(1)));
    expect(specRows).toHaveBeenCalledTimes(2);
  });
});
