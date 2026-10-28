import { describe, expect, it } from 'vitest';
import type { ConnectionDto, ProjectSource } from '@constructor-studio/mfe-shared';
import {
  ARTIFACT_NODE_TYPES,
  type ArtifactNodeDto,
  type SourceActivityListDto,
} from '../api/artifactTypes';
import type { SpecsPerSourceListDto } from '../api/documentTypes';
import {
  activityScale,
  buildSourceRows,
  filterSourceRows,
  sourcesFooter,
  type SourceImportLine,
  type SourceRow,
  type SourcesAnswers,
  type SourcesTableRow,
} from './sourceRows';
import { sourceRow } from './sourceRows.fixture';

const source = (
  full_path: string,
  connection_id = 'c-github',
  branch?: string
): ProjectSource => ({
  connection_id,
  full_path,
  clone_url: `https://example.test/${full_path}.git`,
  ...(branch ? { branch } : {}),
});

const connection = (id: string, provider: string): ConnectionDto =>
  ({ id, provider, label: id, base_url: '', secret_ref: `studio-connection-${id}` }) as ConnectionDto;

const repoNode = (
  id: string,
  full_path: string,
  value: Partial<ArtifactNodeDto['value']> = {}
): ArtifactNodeDto => ({
  type_id: ARTIFACT_NODE_TYPES.repo,
  instance_id: id,
  value: { full_path, provider: 'github', connector_id: 'studio-connection-c-github', ...value },
});

const line = (repo: string, overrides: Partial<SourceImportLine> = {}): SourceImportLine => ({
  repo,
  runId: 'run-1',
  status: 'running',
  reason: null,
  cancelling: false,
  ...overrides,
});

const CONNECTIONS = [connection('c-github', 'github'), connection('c-gitlab', 'gitlab')];

const ACTIVITY: SourceActivityListDto = {
  items: [{ repo: 'n-api', open: 3, merged: 4, commits: 9, days: [0, 1, 0, 2, 0, 0, 1] }],
  total: 1,
  days: 7,
};

const SPECS: SpecsPerSourceListDto = { items: [{ repo: 'n-api', specs: 12 }], total: 1, files_known: true };

function answers(overrides: Partial<SourcesAnswers> = {}): SourcesAnswers {
  return {
    sources: [source('acme/api', 'c-github', 'main')],
    nodes: [repoNode('n-api', 'acme/api', { synced_at: '2026-10-14T10:52:00Z' })],
    connections: CONNECTIONS,
    activity: ACTIVITY,
    specs: SPECS,
    lines: [],
    uploads: [],
    ...overrides,
  };
}

const only = (input: SourcesAnswers): SourceRow => {
  const [row] = buildSourceRows(input);
  if (row.kind !== 'repository') throw new Error('Not a repository row');
  return row;
};

describe('a source in the config is a row', () => {
  it('joined to its repository node: last sync, specs, pull requests and commits', () => {
    expect(only(answers())).toEqual({
      kind: 'repository',
      id: 'c-github:acme/api',
      connectionId: 'c-github',
      provider: 'github',
      name: 'api',
      fullPath: 'acme/api',
      cloneUrl: 'https://example.test/acme/api.git',
      branch: 'main',
      nodeId: 'n-api',
      specs: 12,
      activity: { open: 3, merged: 4, commits: 9, days: [0, 1, 0, 2, 0, 0, 1] },
      lastSync: { kind: 'synced', at: '2026-10-14T10:52:00Z' },
      sync: { kind: 'none' },
    });
  });

  it("in the config's order, one per source and none for a node the config does not name", () => {
    const rows = buildSourceRows(
      answers({
        sources: [source('acme/web'), source('acme/api')],
        nodes: [repoNode('n-api', 'acme/api'), repoNode('n-old', 'acme/old')],
      })
    );
    expect(rows.map((row) => row.kind === 'repository' && row.fullPath)).toEqual(['acme/web', 'acme/api']);
  });

  it('shows the branch only when the config has one', () => {
    expect(only(answers({ sources: [source('acme/api')] })).branch).toBeNull();
  });

  it('with no repository node reads Not synced, its numbers missing, the provider its connection’s', () => {
    expect(only(answers({ nodes: [] }))).toMatchObject({
      provider: 'github',
      nodeId: null,
      specs: null,
      activity: null,
      lastSync: { kind: 'not_synced' },
    });
  });

  it('reads Not synced while its node has no finished sync', () => {
    expect(only(answers({ nodes: [repoNode('n-api', 'acme/api')] })).lastSync).toEqual({
      kind: 'not_synced',
    });
  });

  it('on GitLab or Bitbucket reads that its provider cannot sync', () => {
    const row = only(answers({ sources: [source('lab/tool', 'c-gitlab')], nodes: [] }));
    expect(row.provider).toBe('gitlab');
    expect(row.lastSync).toEqual({ kind: 'unavailable', provider: 'gitlab' });
  });

  it('whose connection is gone reads Not connected, and still shows what its node holds', () => {
    const row = only(answers({ connections: [connection('c-gitlab', 'gitlab')] }));
    expect(row.lastSync).toEqual({ kind: 'not_connected' });
    expect(row.specs).toBe(12);
    expect(row.activity?.open).toBe(3);
  });

  it('does not read Not connected when the connections could not be read', () => {
    const row = only(answers({ connections: null }));
    expect(row.provider).toBe('github');
    expect(row.lastSync.kind).toBe('synced');
    expect(only(answers({ connections: null, nodes: [] })).lastSync).toEqual({ kind: 'not_synced' });
  });

  it("takes the provider from its node before its connection's", () => {
    const row = only(answers({ connections: [connection('c-github', 'gitlab')] }));
    expect(row.provider).toBe('github');
    expect(row.lastSync).toEqual({ kind: 'synced', at: '2026-10-14T10:52:00Z' });
  });

  it('attached again through another connection does not take the old node', () => {
    const old = repoNode('n-old', 'acme/api', {
      connector_id: 'studio-connection-c-old',
      synced_at: '2026-01-01T00:00:00Z',
    });
    expect(only(answers({ nodes: [old] }))).toMatchObject({
      nodeId: null,
      lastSync: { kind: 'not_synced' },
    });
  });
});

describe('a missing number is not zero', () => {
  it('specs are missing for every row when the files are not known, or the read failed', () => {
    expect(only(answers({ specs: { ...SPECS, files_known: false } })).specs).toBeNull();
    expect(only(answers({ specs: null })).specs).toBeNull();
  });

  it('a node the specs per source does not list has none', () => {
    expect(only(answers({ specs: { items: [], total: 0, files_known: true } })).specs).toBe(0);
  });

  it('pull requests and commits are missing when the activity could not be read', () => {
    expect(only(answers({ activity: null })).activity).toBeNull();
  });

  it('a node the activity does not list had none, on every day of the window', () => {
    expect(only(answers({ activity: { items: [], total: 0, days: 7 } })).activity).toEqual({
      open: 0,
      merged: 0,
      commits: 0,
      days: [0, 0, 0, 0, 0, 0, 0],
    });
  });
});

describe('the sync this tab follows', () => {
  const syncOf = (...lines: SourceImportLine[]) => only(answers({ lines })).sync;

  it('is in flight while queued or running, and can be cancelled when it has a run', () => {
    expect(syncOf(line('acme/api', { status: 'queued' }))).toEqual({
      kind: 'in_flight',
      cancelling: false,
      canCancel: true,
    });
    expect(syncOf(line('acme/api', { runId: null }))).toMatchObject({
      kind: 'in_flight',
      canCancel: false,
    });
  });

  it('cannot be cancelled again while a cancel is pending', () => {
    expect(syncOf(line('acme/api', { cancelling: true }))).toEqual({
      kind: 'in_flight',
      cancelling: true,
      canCancel: false,
    });
  });

  it('leaves the first line as it was while it runs', () => {
    const row = only(answers({ lines: [line('acme/api')] }));
    expect(row.lastSync).toEqual({ kind: 'synced', at: '2026-10-14T10:52:00Z' });
  });

  it('stopped says why, and whether Sync now retries the run', () => {
    const reason = { kind: 'provider', text: 'Bad credentials' } as const;
    expect(syncOf(line('acme/api', { status: 'failed', reason }))).toEqual({
      kind: 'stopped',
      status: 'failed',
      reason,
      canRetry: true,
    });
    expect(syncOf(line('acme/api', { status: 'cancelled' }))).toMatchObject({
      status: 'cancelled',
      canRetry: true,
    });
    expect(syncOf(line('acme/api', { status: 'lost' }))).toMatchObject({
      status: 'lost',
      canRetry: false,
    });
    expect(syncOf(line('acme/api', { status: 'failed', runId: null }))).toMatchObject({
      canRetry: false,
    });
  });

  it('is none once it succeeded, for an unsyncable repository, or with no line', () => {
    expect(syncOf(line('acme/api', { status: 'succeeded' }))).toEqual({ kind: 'none' });
    expect(syncOf(line('acme/api', { status: 'unsyncable', runId: null }))).toEqual({ kind: 'none' });
    expect(syncOf(line('acme/web'))).toEqual({ kind: 'none' });
  });

  it('finds its line whatever the case of the path', () => {
    expect(syncOf(line('Acme/API')).kind).toBe('in_flight');
  });
});

describe('the search', () => {
  const rows = buildSourceRows(
    answers({ sources: [source('acme/api'), source('Tools/Insight'), source('acme/web')] })
  );

  const paths = (kept: readonly SourcesTableRow[]) =>
    kept.map((row) => (row.kind === 'uploads' ? row.kind : row.fullPath));

  it('keeps the rows whose name or path holds the text, ignoring case, in their order', () => {
    expect(paths(filterSourceRows(rows, ' ACME ', 'Uploaded files'))).toEqual([
      'acme/api',
      'acme/web',
    ]);
    expect(paths(filterSourceRows(rows, 'insight', 'Uploaded files'))).toEqual(['Tools/Insight']);
  });

  it('keeps every row when empty', () => {
    expect(filterSourceRows(rows, '', 'Uploaded files')).toHaveLength(3);
  });

  it('keeps the uploads row by the name the table gives it', () => {
    const withUploads = buildSourceRows(
      answers({ sources: [source('acme/api')], uploads: [{ created_at: '2026-10-20T10:00:00Z' }] })
    );
    expect(paths(filterSourceRows(withUploads, 'upload', 'Uploaded files'))).toEqual(['uploads']);
    expect(paths(filterSourceRows(withUploads, 'загруж', 'Загруженные файлы'))).toEqual(['uploads']);
    expect(paths(filterSourceRows(withUploads, 'acme', 'Uploaded files'))).toEqual(['acme/api']);
  });
});

describe('the footer', () => {
  const input = answers({
    sources: [source('acme/api'), source('acme/web'), source('lab/tool', 'c-gitlab')],
    nodes: [repoNode('n-api', 'acme/api'), repoNode('n-web', 'acme/web')],
    activity: {
      items: [
        { repo: 'n-api', open: 3, merged: 0, commits: 1, days: [0, 0, 0, 0, 0, 0, 0] },
        { repo: 'n-web', open: 2, merged: 1, commits: 0, days: [0, 0, 0, 0, 0, 0, 0] },
      ],
      total: 2,
      days: 7,
    },
    specs: { items: [{ repo: 'n-api', specs: 12 }, { repo: 'n-web', specs: 5 }], total: 2, files_known: true },
  });
  const rows = buildSourceRows(input);

  it('counts every source, the specs from them and the open pull requests', () => {
    expect(sourcesFooter(rows, input)).toEqual({ sources: 3, specs: 17, openPullRequests: 5 });
  });

  it('counts the uploads row among the sources and its documents among the specs', () => {
    const uploads = [{ created_at: '2026-10-20T10:00:00Z' }, { created_at: '2026-10-21T10:00:00Z' }];
    const withUploads = { ...input, uploads };
    expect(sourcesFooter(buildSourceRows(withUploads), withUploads)).toEqual({
      sources: 4,
      specs: 19,
      openPullRequests: 5,
    });
  });

  it('leaves out of a sum what is missing, and is missing what could not be read', () => {
    expect(sourcesFooter(rows, { ...input, specs: null, activity: null })).toEqual({
      sources: 3,
      specs: null,
      openPullRequests: null,
    });
    expect(sourcesFooter(rows, { ...input, specs: { ...SPECS, files_known: false } }).specs).toBeNull();
    expect(sourcesFooter(rows, { ...input, uploads: null }).specs).toBeNull();
  });
});

describe('the uploads row', () => {
  const uploads = [
    { created_at: '2026-10-20T10:00:00Z' },
    { created_at: '2026-10-22T09:00:00Z' },
    { created_at: '2026-10-21T10:00:00Z' },
  ];

  it('is absent while the project has no document of its own, or they could not be read', () => {
    expect(buildSourceRows(answers({ uploads: [] })).map((row) => row.kind)).toEqual(['repository']);
    expect(buildSourceRows(answers({ uploads: null })).map((row) => row.kind)).toEqual([
      'repository',
    ]);
  });

  it('comes last, with the number of documents and the newest one', () => {
    const rows = buildSourceRows(answers({ sources: [source('acme/api'), source('acme/web')], uploads }));
    expect(rows.map((row) => row.kind)).toEqual(['repository', 'repository', 'uploads']);
    expect(rows[2]).toEqual({ kind: 'uploads', id: 'uploads', specs: 3, lastAt: '2026-10-22T09:00:00Z' });
  });

  it('shows on a project with no source', () => {
    expect(buildSourceRows(answers({ sources: [], uploads })).map((row) => row.kind)).toEqual([
      'uploads',
    ]);
  });
});

describe('the activity scale', () => {
  const week = (days: number[]) => ({ open: 0, merged: 0, commits: 0, days });

  it("is the busiest day of every row, the rows of other pages included", () => {
    const rows = [
      sourceRow({ activity: week([0, 1, 0, 0, 0, 0, 2]) }),
      sourceRow({ activity: null }),
      sourceRow({ activity: week([0, 0, 7, 0, 0, 0, 0]) }),
    ];
    expect(activityScale(rows)).toBe(7);
  });

  it('is at least 3, so a single pull request does not fill the cell', () => {
    expect(activityScale([sourceRow({ activity: week([0, 1, 0, 0, 0, 0, 0]) })])).toBe(3);
    expect(activityScale([])).toBe(3);
  });
});
