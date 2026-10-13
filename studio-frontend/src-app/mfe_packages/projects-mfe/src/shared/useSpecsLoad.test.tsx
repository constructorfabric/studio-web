import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecRowDto, SpecRowListDto } from '../api/documentTypes';

const { specRows, types, triggerLoad } = vi.hoisted(() => ({
  specRows: vi.fn<() => Promise<SpecRowListDto>>(),
  types: vi.fn<() => Promise<{ items: { key: string; name: string }[] }>>(),
  triggerLoad: vi.fn(),
}));

vi.mock('@gears-frontx/react', () => ({
  apiRegistry: {
    getService: () => ({
      specRows: () => ({ fetch: specRows }),
      types: () => ({ fetch: types }),
    }),
  },
}));
vi.mock('@gears-frontx/ui-kit', () => ({ useDataGrid: () => ({ triggerLoad }) }));
vi.mock('../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));

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
        filters: { [SPECS_FILTER_KEYS.filter]: { value: 'with_findings' } },
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

  it('keeps every row, the filtered ones and the flags in the snapshot', async () => {
    const { result } = renderHook(() => useSpecsLoad('p1', 'w1'));
    await act(() =>
      result.current.load({
        ...page(1, 1),
        filters: { [SPECS_FILTER_KEYS.documentType]: { value: 'prd' } },
      })
    );
    const snapshot = result.current.snapshot!;
    expect(snapshot.rows).toHaveLength(4);
    expect(snapshot.shown.map((r) => r.name)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(snapshot.sources).toBe(LIST.sources);
    expect(snapshot.failed).toBe(false);
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
