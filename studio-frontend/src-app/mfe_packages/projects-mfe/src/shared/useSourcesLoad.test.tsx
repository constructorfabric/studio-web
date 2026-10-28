import { render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionDto, ProjectSource } from '@constructor-studio/mfe-shared';
import { ARTIFACT_NODE_TYPES } from '../api/artifactTypes';

/** The Sources rows and the load the table calls (#685, DoD `...-sources-reads`). */

type Query = { data?: unknown; isLoading: boolean; isError: boolean };
type Key = 'config' | 'nodes' | 'connections' | 'activity' | 'specs' | 'documents';

const { queries, asked, config, lines, studio, invalidate, triggerLoad } = vi.hoisted(() => ({
  queries: { current: {} as Record<string, Query> },
  asked: [] as unknown[],
  config: { current: { config: null as unknown, loading: false, unset: false, failed: false } },
  lines: { current: [] as unknown[] },
  studio: {
    current: { own: [] as { created_at: string }[], loading: false, failed: false },
  },
  invalidate: vi.fn(),
  triggerLoad: vi.fn(),
}));

const descriptor = (key: Key) => (params?: unknown) => ({ key, params });

vi.mock('@gears-frontx/react', () => ({
  apiRegistry: {
    getService: () => ({
      getTenantMetadata: descriptor('config'),
      nodes: descriptor('nodes'),
      connections: descriptor('connections'),
      sourceActivity: descriptor('activity'),
      specsPerSource: descriptor('specs'),
    }),
  },
  // A key that is not one of the services' is the hook's own read with nothing to ask.
  useApiQuery: ({ key }: { key: Key | readonly unknown[] }) => {
    asked.push(key);
    return typeof key === 'string'
      ? queries.current[key]
      : { data: null, isLoading: false, isError: false };
  },
  useQueryCache: () => ({ invalidate }),
}));
vi.mock('@gears-frontx/ui-kit', () => ({ useDataGrid: () => ({ triggerLoad }) }));
vi.mock('@constructor-studio/mfe-shared', () => ({
  AccountsApiService: class {},
  ConnectorsApiService: class {},
  PROJECT_CONFIG_TYPE: 'project-config',
}));
vi.mock('../api/ArtifactIngestApiService', () => ({ ArtifactIngestApiService: class {} }));
vi.mock('../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));
vi.mock('./useProjectConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useProjectConfig')>()),
  useProjectConfig: () => config.current,
}));
vi.mock('./useArtifactImport', () => ({ useProjectImport: () => ({ repos: lines.current }) }));
vi.mock('./useProjectDocuments', () => ({
  useProjectDocuments: (workspaceId: string | null) => {
    if (workspaceId) asked.push('documents');
    return { documents: studio.current.own, ...studio.current };
  },
}));
vi.mock('./useArtifacts', () => ({
  repositoryNodesParams: (scope: string) => ({ scope, type: 'repo', limit: 200 }),
}));

import type { SourceRow, SourcesTableRow } from '../model/sourceRows';
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
  };
  studio.current = { own: [], loading: false, failed: false };
}

const repositories = (rows: readonly SourcesTableRow[]) =>
  rows.filter((row): row is SourceRow => row.kind === 'repository');
const pathOf = (row: SourcesTableRow) => (row.kind === 'uploads' ? 'uploads' : row.fullPath);

/** The hook, and its bridge rendered as the grid would. */
function mount(workspaceId: string | null = 'ws-1') {
  let projectId = 'p-1';
  const hook = renderHook((props: { projectId: string }) => useSourcesLoad(props.projectId, workspaceId, 'org-1', 'Uploaded files'), {
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

const importLine = (runId: string | null, status: string) => ({
  repo: 'acme/web',
  runId,
  status,
  reason: null,
  cancelling: false,
});

beforeEach(() => {
  answerAll();
  config.current = { config: { sources: SOURCES }, loading: false, unset: false, failed: false };
  lines.current = [];
  asked.length = 0;
  invalidate.mockReset();
  triggerLoad.mockReset();
});

describe('useSourcesLoad', () => {
  it('gives rows for a synced GitHub repository, an unsynced one and a GitLab one', () => {
    const { view } = mount();

    expect(view.ready).toBe(true);
    expect(view.failed).toBe(false);
    expect(
      repositories(view.rows).map((row) => [row.fullPath, row.lastSync, row.specs, row.activity?.open])
    ).toEqual([
      ['acme/api', { kind: 'synced', at: '2026-10-14T10:52:00Z' }, 12, 2],
      ['acme/web', { kind: 'not_synced' }, null, undefined],
      ['lab/tool', { kind: 'unavailable', provider: 'gitlab' }, null, undefined],
    ]);
    expect(view.footer).toEqual({ sources: 3, specs: 12, openPullRequests: 2 });
    expect(view.windowDays).toBe(7);
  });

  it('searches and pages the rows it built, and the footer still counts them all', async () => {
    const { view } = mount();

    const searched = await view.load({ filters: { [SOURCES_FILTER_KEYS.search]: { value: 'ACME' } } });
    expect(searched.results.map(pathOf)).toEqual(['acme/api', 'acme/web']);
    expect(searched.total).toBe(2);

    const second = await view.load({ pagination: { page: 2, limit: 2 } });
    expect(second.results.map(pathOf)).toEqual(['lab/tool']);
    expect(second.total).toBe(3);
    expect(view.footer.sources).toBe(3);
  });

  it.each<Key>(['config', 'nodes', 'connections', 'activity', 'specs', 'documents'])(
    'is not ready until the %s read has answered or failed',
    (read) => {
      if (read === 'config') config.current.loading = true;
      else if (read === 'documents') studio.current.loading = true;
      else queries.current[read] = pending;
      expect(mount().view.ready).toBe(false);
    }
  );

  it('fails on the config or the repository nodes, and shows gaps for the other reads', () => {
    queries.current.activity = failedQuery;
    queries.current.specs = failedQuery;
    studio.current.failed = true;
    const sources = mount();

    expect(sources.view.failed).toBe(false);
    expect(sources.view.rows[0]).toMatchObject({ specs: null, activity: null });
    expect(sources.view.footer).toEqual({ sources: 3, specs: null, openPullRequests: null });

    queries.current.nodes = failedQuery;
    sources.rerender();
    expect(sources.view.failed).toBe(true);

    answerAll();
    config.current = { config: null, loading: false, unset: false, failed: true };
    sources.rerender();
    expect(sources.view.failed).toBe(true);
  });

  it('with no config written yet, is ready with no rows and does not fail', () => {
    config.current = { config: null, loading: false, unset: true, failed: false };
    const { view } = mount();

    expect(view.ready).toBe(true);
    expect(view.failed).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.footer.sources).toBe(0);
  });

  it('with the connections unread, reads no row as Not connected and takes the provider from the node', () => {
    queries.current.connections = failedQuery;
    const { view } = mount();

    expect(view.failed).toBe(false);
    expect(repositories(view.rows).map((row) => [row.provider, row.lastSync.kind])).toEqual([
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

  it('does not read again for a line that never had a run', () => {
    const sources = mount();

    lines.current = [importLine(null, 'unsyncable')];
    sources.rerender();
    lines.current = [importLine(null, 'failed')];
    sources.rerender();
    expect(invalidate).not.toHaveBeenCalled();
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
    expect(repositories(sources.view.rows)[1].sync).toEqual({
      kind: 'in_flight',
      cancelling: false,
      canCancel: true,
    });

    lines.current = [{ ...running, phase: 'storing', stored: 40 }];
    sources.rerender();
    expect(triggerLoad).toHaveBeenCalledTimes(1);
  });

  it('adds the Uploaded files row after the sources, found by its name, and counts it', async () => {
    studio.current.own = [{ created_at: '2026-10-20T10:00:00Z' }, { created_at: '2026-10-21T10:00:00Z' }];
    const { view } = mount();

    expect(view.rows.map(pathOf)).toEqual(['acme/api', 'acme/web', 'lab/tool', 'uploads']);
    expect(view.footer).toEqual({ sources: 4, specs: 14, openPullRequests: 2 });
    const searched = await view.load({ filters: { [SOURCES_FILTER_KEYS.search]: { value: 'upload' } } });
    expect(searched.results.map(pathOf)).toEqual(['uploads']);
  });

  it('with no workspace, asks for no documents and leaves the specs count missing', () => {
    const { view } = mount(null);

    expect(view.ready).toBe(true);
    expect(view.rows).toHaveLength(3);
    expect(view.footer.specs).toBeNull();
    expect(asked).not.toContain('documents');
  });

  it('reads the config and the repository nodes again on retry', () => {
    const { view } = mount();

    view.retry();
    expect(invalidate.mock.calls.map(([query]) => [query.key, query.params])).toEqual([
      ['config', { tenantId: 'p-1', metadataType: 'project-config' }],
      ['nodes', { scope: 'p-1', type: 'repo', limit: 200 }],
    ]);
  });
});
