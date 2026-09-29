import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { answer, invalidate } = vi.hoisted(() => ({
  answer: vi.fn<(params: NodesParams) => Answer>(),
  invalidate: vi.fn(),
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
vi.mock('./useArtifactImport', () => ({
  useProjectImport: () => ({ phase: 'idle', repos: [] }),
}));

import { useArtifacts } from './useArtifacts';

const ok = (total: number): Answer => ({ data: { nodes: [], total }, isLoading: false, isError: false });
const isRepositoryTotal = (params: NodesParams) =>
  params.limit === 1 && params.repo !== undefined;

beforeEach(() => {
  invalidate.mockClear();
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
      useArtifacts('p1', { repo: 'r-1', kind: 'issue', search: 'broken', offset: 0 })
    );
    expect(result.current.total).toBe(3);
    expect(result.current.repositoryTotal).toBe(96);
    expect(answer).toHaveBeenCalledWith({ scope: 'p1', repo: 'r-1', limit: 1 });
  });

  it('is absent with no repository chosen, and its read is the project count', () => {
    const { result } = renderHook(() =>
      useArtifacts('p1', { repo: null, kind: null, search: '', offset: 0 })
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
      useArtifacts('p1', { repo: 'r-1', kind: null, search: '', offset: 0 })
    );
    expect(result.current.repositoryTotal).toBeNull();
    expect(result.current.repositoryTotalFailed).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('is asked again by refetch', () => {
    const { result } = renderHook(() =>
      useArtifacts('p1', { repo: 'r-1', kind: null, search: '', offset: 0 })
    );
    result.current.refetch();
    expect(invalidate).toHaveBeenCalledWith({ params: { scope: 'p1', repo: 'r-1', limit: 1 } });
  });
});

describe('a page on the way', () => {
  it('keeps the last total of the same project, and only of the same project', () => {
    const { result, rerender } = renderHook(
      ({ projectId, search }) => useArtifacts(projectId, { repo: null, kind: null, search, offset: 0 }),
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
    renderHook(() => useArtifacts('p1', { repo: null, kind: 'issue', search: '', offset: 0 }));
    expect(pageRequest()?.type).toBe(ARTIFACT_NODE_TYPES.issue);
  });

  it('sends no type for all types — the gear answers its default kinds', () => {
    renderHook(() => useArtifacts('p1', { repo: null, kind: null, search: '', offset: 0 }));
    expect(pageRequest()).toBeDefined();
    expect(pageRequest()).not.toHaveProperty('type', expect.anything());
  });
});
