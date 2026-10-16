import { render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionDto, ProjectSource } from '@constructor-studio/mfe-shared';
import { ARTIFACT_NODE_TYPES } from '../api/artifactTypes';

/** The Sources rows and the load the table calls (#685, DoD `...-sources-reads`). */

type Query = { data?: unknown; isLoading: boolean; isError: boolean };
type Key = 'nodes' | 'connections' | 'activity' | 'specs' | 'documents';

const { queries, config, lines, invalidate, triggerLoad } = vi.hoisted(() => ({
  queries: { current: {} as Record<string, Query> },
  config: { current: { config: null as unknown, loading: false, failed: false } },
  lines: { current: [] as unknown[] },
  invalidate: vi.fn(),
  triggerLoad: vi.fn(),
}));

const descriptor = (key: Key) => () => ({ key });

vi.mock('@gears-frontx/react', () => ({
  apiRegistry: {
    getService: () => ({
      nodes: descriptor('nodes'),
      connections: descriptor('connections'),
      sourceActivity: descriptor('activity'),
      specsPerSource: descriptor('specs'),
      projectDocuments: descriptor('documents'),
    }),
  },
  useApiQuery: ({ key }: { key: Key }) => queries.current[key],
  useQueryCache: () => ({ invalidate }),
}));
vi.mock('@gears-frontx/ui-kit', () => ({ useDataGrid: () => ({ triggerLoad }) }));
vi.mock('@constructor-studio/mfe-shared', () => ({ ConnectorsApiService: class {} }));
vi.mock('../api/ArtifactIngestApiService', () => ({ ArtifactIngestApiService: class {} }));
vi.mock('../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));
vi.mock('./useProjectConfig', () => ({ useProjectConfig: () => config.current }));
vi.mock('./useArtifactImport', () => ({ useProjectImport: () => ({ repos: lines.current }) }));
vi.mock('./useArtifacts', () => ({
  repositoryNodesParams: (scope: string) => ({ scope, type: 'repo', limit: 200 }),
}));

import { SOURCES_FILTER_KEYS, useSourcesLoad, type SourcesLoad } from './useSourcesLoad';

const answered = (data: unknown): Query => ({ data, isLoading: false, isError: false });
const failedQuery: Query = { data: undefined, isLoading: false, isError: true };
const pending: Query = { data: undefined, isLoading: true, isError: false };

const source = (full_path: string, connection_id = 'c-github'): ProjectSource => ({
  connection_id,
  full_path,
  clone_url: `https://example.test/${full_path}.git`,
});

const connection = (id: string, provider: string) =>
  ({ id, provider, label: id, base_url: '', secret_ref: `studio-connection-${id}` }) as ConnectionDto;

const SOURCES = [source('acme/api'), source('acme/web'), source('lab/tool', 'c-gitlab')];

function answerAll() {
  queries.current = {
    nodes: answered({
      nodes: [
        {
          type_id: ARTIFACT_NODE_TYPES.repo,
          instance_id: 'n-api',
          value: {
            full_path: 'acme/api',
            provider: 'github',
            connector_id: 'studio-connection-c-github',
            synced_at: '2026-10-14T10:52:00Z',
          },
        },
      ],
      total: 1,
    }),
    connections: answered({ items: [connection('c-github', 'github'), connection('c-gitlab', 'gitlab')] }),
    activity: answered({
      items: [{ repo: 'n-api', open: 2, merged: 1, commits: 5, days: [0, 0, 1, 0, 0, 1, 0] }],
      total: 1,
      days: 7,
    }),
    specs: answered({ items: [{ repo: 'n-api', specs: 12 }], total: 1, files_known: true }),
    documents: answered({ items: [], total: 3 }),
  };
}

/** The hook, and its bridge rendered as the grid would. */
function mount() {
  let projectId = 'p-1';
  const hook = renderHook((props: { projectId: string }) => useSourcesLoad(props.projectId, 'ws-1', 'org-1'), {
    initialProps: { projectId },
  });
  const grid = render(hook.result.current.rowsBridge);
  return {
    get view(): SourcesLoad {
      return hook.result.current;
    },
    rerender(next = projectId) {
      projectId = next;
      hook.rerender({ projectId });
      grid.rerender(hook.result.current.rowsBridge);
    },
  };
}

const importLine = (runId: string, status: string) => ({
  repo: 'acme/web',
  runId,
  status,
  reason: null,
  cancelling: false,
});

beforeEach(() => {
  answerAll();
  config.current = { config: { sources: SOURCES }, loading: false, failed: false };
  lines.current = [];
  invalidate.mockReset();
  triggerLoad.mockReset();
});

describe('useSourcesLoad', () => {
  it('gives rows for a synced GitHub repository, an unsynced one and a GitLab one', () => {
    const { view } = mount();

    expect(view.ready).toBe(true);
    expect(view.failed).toBe(false);
    expect(view.rows.map((row) => [row.fullPath, row.lastSync, row.specs, row.activity?.open])).toEqual([
      ['acme/api', { kind: 'synced', at: '2026-10-14T10:52:00Z' }, 12, 2],
      ['acme/web', { kind: 'not_synced' }, null, undefined],
      ['lab/tool', { kind: 'unavailable', provider: 'gitlab' }, null, undefined],
    ]);
    expect(view.footer).toEqual({ sources: 3, specs: 12, createdInStudio: 3, openPullRequests: 2 });
    expect(view.windowDays).toBe(7);
  });

  it('searches and pages the rows it built, and the footer still counts them all', async () => {
    const { view } = mount();

    const searched = await view.load({ filters: { [SOURCES_FILTER_KEYS.search]: { value: 'ACME' } } });
    expect(searched.results.map((row) => row.fullPath)).toEqual(['acme/api', 'acme/web']);
    expect(searched.total).toBe(2);

    const second = await view.load({ pagination: { page: 2, limit: 2 } });
    expect(second.results.map((row) => row.fullPath)).toEqual(['lab/tool']);
    expect(second.total).toBe(3);
    expect(view.footer.sources).toBe(3);
  });

  it('is not ready until every read has answered or failed', () => {
    queries.current.activity = pending;
    expect(mount().view.ready).toBe(false);
  });

  it('fails on the config or the repository nodes, and shows gaps for the other reads', () => {
    queries.current.activity = failedQuery;
    queries.current.specs = failedQuery;
    queries.current.documents = failedQuery;
    const sources = mount();

    expect(sources.view.failed).toBe(false);
    expect(sources.view.rows[0]).toMatchObject({ specs: null, activity: null });
    expect(sources.view.footer).toEqual({
      sources: 3,
      specs: null,
      createdInStudio: null,
      openPullRequests: null,
    });

    queries.current.nodes = failedQuery;
    sources.rerender();
    expect(sources.view.failed).toBe(true);

    answerAll();
    config.current = { config: null, loading: false, failed: true };
    sources.rerender();
    expect(sources.view.failed).toBe(true);
  });

  it('with the connections unread, reads no row as Not connected and takes the provider from the node', () => {
    queries.current.connections = failedQuery;
    const { view } = mount();

    expect(view.failed).toBe(false);
    expect(view.rows.map((row) => [row.provider, row.lastSync.kind])).toEqual([
      ['github', 'synced'],
      [null, 'not_synced'],
      [null, 'not_synced'],
    ]);
  });

  it('reads the nodes, the activity and the specs again when a sync settles', () => {
    lines.current = [importLine('r-old', 'failed')];
    const sources = mount();
    expect(invalidate).not.toHaveBeenCalled();

    lines.current = [importLine('r-1', 'running')];
    sources.rerender();
    expect(invalidate).not.toHaveBeenCalled();

    lines.current = [importLine('r-1', 'succeeded')];
    sources.rerender();
    expect(invalidate.mock.calls.map(([query]) => query.key)).toEqual(['nodes', 'activity', 'specs']);
  });

  it('does not read again for a sync that settles as the project changes', () => {
    lines.current = [importLine('r-1', 'running')];
    const sources = mount();

    lines.current = [importLine('r-1', 'succeeded')];
    sources.rerender('p-2');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("loads the grid again when the rows change, but not for its first load or a sync's progress", () => {
    const sources = mount();
    expect(triggerLoad).not.toHaveBeenCalled();

    const running = { repo: 'acme/web', runId: 'r-1', status: 'running', reason: null, cancelling: false };
    lines.current = [{ ...running, phase: 'fetching' }];
    sources.rerender();
    expect(triggerLoad).toHaveBeenCalledTimes(1);
    expect(sources.view.rows[1].sync).toEqual({ kind: 'in_flight', cancelling: false, canCancel: true });

    lines.current = [{ ...running, phase: 'storing', stored: 40 }];
    sources.rerender();
    expect(triggerLoad).toHaveBeenCalledTimes(1);
  });
});
