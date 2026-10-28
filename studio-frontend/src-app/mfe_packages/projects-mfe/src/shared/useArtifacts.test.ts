import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodesParams } from '../api/ArtifactIngestApiService';
import { ARTIFACT_NODE_TYPES } from '../api/artifactTypes';

/**
 * The header's repository total is its own read: the table's page carries the
 * search and the type, the header must not (DoD `...-counters`).
 */

interface Answer {
  data?: { nodes: never[]; total: number };
  isLoading: boolean;
  isError: boolean;
}

const { answer, invalidate, imported } = vi.hoisted(() => ({
  answer: vi.fn<(params: NodesParams) => Answer>(),
  invalidate: vi.fn(),
  imported: vi.fn(),
}));

vi.mock('@gears-frontx/react', () => ({
  apiRegistry: { getService: () => ({ nodes: (params: NodesParams) => ({ params }) }) },
  useApiQuery: (descriptor: { params: NodesParams }) => answer(descriptor.params),
  useQueryCache: () => ({ invalidate }),
}));
vi.mock('../api/ArtifactIngestApiService', () => ({ ArtifactIngestApiService: class {} }));
vi.mock('./useProjectConfig', () => ({
  useProjectConfig: () => ({ config: { sources: [] }, loading: false, failed: false }),
}));
vi.mock('./useArtifactImport', () => ({ useProjectImport: () => imported() }));
vi.mock('./useProjectDocuments', () => ({
  useProjectDocuments: () => ({ documents: [], own: [], loading: false, failed: false }),
}));

import { useArtifacts } from './useArtifacts';

const ok = (total: number): Answer => ({ data: { nodes: [], total }, isLoading: false, isError: false });
const isRepositoryTotal = (params: NodesParams) =>
  params.limit === 1 && params.repo !== undefined;

beforeEach(() => {
  invalidate.mockClear();
  imported.mockReturnValue({ phase: 'idle', repos: [] });
  answer.mockReset();
  // The page answers for its filters; every limit=1 read with a repo answers 96.
  answer.mockImplementation((params) => {
    if (isRepositoryTotal(params)) return ok(96);
    if (params.limit === 1) return ok(1286);
    return ok(params.q || params.type ? 3 : 96);
  });
});

describe('the repository total in the header', () => {
  it('is the repository read, not the filtered page', () => {
    const { result } = renderHook(() =>
      useArtifacts('p1', 'w1', { repo: 'r-1', kind: 'issue', search: 'broken', offset: 0 })
    );
    expect(result.current.total).toBe(3);
    expect(result.current.repositoryTotal).toBe(96);
    expect(answer).toHaveBeenCalledWith({ scope: 'p1', repo: 'r-1', limit: 1 });
  });

  it('is absent with no repository chosen, and its read is the project count', () => {
    const { result } = renderHook(() =>
      useArtifacts('p1', 'w1', { repo: null, kind: null, search: '', offset: 0 })
    );
    expect(result.current.repositoryTotal).toBeNull();
    expect(result.current.projectTotal).toBe(1286);
    expect(answer.mock.calls.some(([params]) => isRepositoryTotal(params))).toBe(false);
  });

  it('fails on its own, without taking the table down', () => {
    answer.mockImplementation((params) =>
      isRepositoryTotal(params) ? { isLoading: false, isError: true } : ok(96)
    );
    const { result } = renderHook(() =>
      useArtifacts('p1', 'w1', { repo: 'r-1', kind: null, search: '', offset: 0 })
    );
    expect(result.current.repositoryTotal).toBeNull();
    expect(result.current.repositoryTotalFailed).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('is asked again by refetch', () => {
    const { result } = renderHook(() =>
      useArtifacts('p1', 'w1', { repo: 'r-1', kind: null, search: '', offset: 0 })
    );
    result.current.refetch();
    expect(invalidate).toHaveBeenCalledWith({ params: { scope: 'p1', repo: 'r-1', limit: 1 } });
  });
});

describe('a page on the way', () => {
  it('keeps the last total of the same project, and only of the same project', () => {
    const { result, rerender } = renderHook(
      ({ projectId, search }) => useArtifacts(projectId, 'w1', { repo: null, kind: null, search, offset: 0 }),
      { initialProps: { projectId: 'p1', search: '' } }
    );
    // The first page answered 96; the search narrows it to 3.
    rerender({ projectId: 'p1', search: 'broken' });
    expect(result.current.total).toBe(3);

    answer.mockImplementation((params) => {
      if (params.sort === 'updated') return { isLoading: true, isError: false };
      return params.limit === 1 ? ok(1286) : ok(96);
    });
    rerender({ projectId: 'p1', search: 'other' });
    expect(result.current).toMatchObject({ total: 3, refreshing: true, loading: false });

    rerender({ projectId: 'p2', search: 'other' });
    expect(result.current).toMatchObject({ total: 0, refreshing: false, loading: true });
  });
});

describe('the type filter', () => {
  const pageRequest = () =>
    answer.mock.calls.map(([params]) => params).find((params) => params.sort === 'updated');

  it('sends the chosen kind as its full GTS id', () => {
    renderHook(() => useArtifacts('p1', 'w1', { repo: null, kind: 'issue', search: '', offset: 0 }));
    expect(pageRequest()?.type).toBe(ARTIFACT_NODE_TYPES.issue);
  });

  it('sends no type for all types — the gear answers its default kinds', () => {
    renderHook(() => useArtifacts('p1', 'w1', { repo: null, kind: null, search: '', offset: 0 }));
    expect(pageRequest()).toBeDefined();
    expect(pageRequest()).not.toHaveProperty('type', expect.anything());
  });
});

describe('the re-read while an import runs', () => {
  const QUERY = { repo: null, kind: null, search: '', offset: 0 };
  /** One refetch invalidates the page, the repositories, the project count and the repository total. */
  const READS_PER_REFETCH = 4;
  const importing = (...repos: [status: string, stored: number][]) => ({
    phase: 'running',
    repos: repos.map(([status, stored], i) => ({ repo: `acme/r-${i}`, status, stored })),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happens at once when a sync starts or settles, and not again for the same statuses', () => {
    imported.mockReturnValue(importing(['queued', 0], ['queued', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', QUERY));
    invalidate.mockClear();

    imported.mockReturnValue(importing(['running', 0], ['queued', 0]));
    rerender();
    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);

    rerender();
    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
  });

  it('happens once in two seconds however often the stored count grows', () => {
    imported.mockReturnValue(importing(['running', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', QUERY));
    invalidate.mockClear();

    for (const stored of [1_000, 2_000, 3_000]) {
      imported.mockReturnValue(importing(['running', stored]));
      rerender();
    }
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
  });

  it('keeps happening every two seconds while the stored count keeps growing', () => {
    imported.mockReturnValue(importing(['running', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', QUERY));
    invalidate.mockClear();

    for (let second = 1; second <= 5; second += 1) {
      imported.mockReturnValue(importing(['running', second * 1_000]));
      rerender();
      vi.advanceTimersByTime(1_000);
      if (second === 2) expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
    }

    expect(invalidate).toHaveBeenCalledTimes(2 * READS_PER_REFETCH);
  });

  it('drops the pending one when a status change re-reads at once', () => {
    imported.mockReturnValue(importing(['running', 0], ['queued', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', QUERY));
    invalidate.mockClear();

    imported.mockReturnValue(importing(['running', 1_000], ['queued', 0]));
    rerender();
    imported.mockReturnValue(importing(['running', 1_000], ['running', 0]));
    rerender();
    vi.advanceTimersByTime(2_000);

    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
  });

  it('does not happen once the hook is gone', () => {
    imported.mockReturnValue(importing(['running', 0]));
    const { rerender, unmount } = renderHook(() => useArtifacts('p1', 'w1', QUERY));
    invalidate.mockClear();

    imported.mockReturnValue(importing(['running', 1_000]));
    rerender();
    unmount();
    vi.advanceTimersByTime(2_000);

    expect(invalidate).not.toHaveBeenCalled();
  });
});
