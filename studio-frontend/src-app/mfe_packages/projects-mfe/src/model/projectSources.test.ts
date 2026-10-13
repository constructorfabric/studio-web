import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService, mockInvalidate } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
  mockInvalidate: vi.fn(() => Promise.resolve()),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: mockGetService },
  invalidateQueryCacheForApp: mockInvalidate,
}));

import type { FrontXApp } from '@gears-frontx/react';
import {
  PROJECT_CONFIG_TYPE,
  type ProjectConfig,
  type ProjectSource,
} from '@constructor-studio/mfe-shared';
import {
  repositoryKey,
  withSources,
  withoutSource,
  writeProjectSources,
} from './projectSources';

const source = (connection: string, fullPath: string): ProjectSource => ({
  connection_id: connection,
  full_path: fullPath,
  clone_url: `https://github.com/${fullPath}.git`,
});

const API = source('c-1', 'acme/api');
const WEB = { ...source('c-1', 'acme/web'), branch: 'main', share_mode: 'pull_request' } as const;
const DOCS = source('c-2', 'acme/docs');

describe('repositoryKey', () => {
  it('names a repository however its URL is spelled', () => {
    expect(repositoryKey(' https://user:token@GitHub.com/Acme/API.git/ ')).toBe('github.com/acme/api');
    expect(repositoryKey('https://github.com/acme/api')).toBe('github.com/acme/api');
  });

  it('names nothing without a scheme, a host or a path', () => {
    expect(repositoryKey('git@github.com:acme/api.git')).toBeNull();
    expect(repositoryKey('https://github.com/')).toBeNull();
  });
});

describe('withSources', () => {
  it('appends after the sources there are, and says what it appended', () => {
    const { sources, added } = withSources([API, WEB], [DOCS]);
    expect(sources).toEqual([API, WEB, DOCS]);
    expect(added).toEqual([DOCS]);
  });

  it('skips a repository already attached, through any connection', () => {
    const again = { ...source('c-2', 'Acme/API'), clone_url: 'https://github.com/Acme/API' };
    const { sources, added } = withSources([API], [again, DOCS, DOCS]);
    expect(sources).toEqual([API, DOCS]);
    expect(added).toEqual([DOCS]);
  });
});

describe('withoutSource', () => {
  it('removes the one entry and keeps the others as they were', () => {
    expect(withoutSource([API, WEB, DOCS], { connection_id: 'c-1', full_path: 'acme/web' })).toEqual([
      API,
      DOCS,
    ]);
  });

  it('matches the connection as well as the path', () => {
    expect(withoutSource([API], { connection_id: 'c-2', full_path: 'acme/api' })).toEqual([API]);
  });
});

describe('writeProjectSources', () => {
  const CONFIG: ProjectConfig = {
    mode: 'modernize',
    stages: ['intent', 'design'],
    status: 'active',
    brief: 'Rebuild the portal',
    owner_id: 'u-1',
    sources: [API, WEB],
  };
  const app = {} as FrontXApp;
  let stored: { value: ProjectConfig } | null;
  const read = { fetch: vi.fn(() => Promise.resolve(stored)) };
  const put = vi.fn((_config: ProjectConfig) => Promise.resolve({}));
  const accounts = {
    getTenantMetadata: vi.fn(() => read),
    putTenantMetadata: vi.fn(() => ({ fetch: put })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stored = { value: CONFIG };
    mockGetService.mockReturnValue(accounts);
  });

  it('appends a source and keeps the other sources and every other field', async () => {
    const written = await writeProjectSources(app, 'p-1', (sources) => withSources(sources, [DOCS]).sources);

    expect(read.fetch).toHaveBeenCalledWith({ staleTime: 0 });
    expect(accounts.putTenantMetadata).toHaveBeenCalledWith('p-1', PROJECT_CONFIG_TYPE);
    expect(put).toHaveBeenCalledWith({ ...CONFIG, sources: [API, WEB, DOCS] });
    expect(written).toEqual([API, WEB, DOCS]);
    expect(mockInvalidate).toHaveBeenCalledWith(app, read);
  });

  it('removes a source and keeps the other sources and every other field', async () => {
    const written = await writeProjectSources(app, 'p-1', (sources) => withoutSource(sources, API));

    expect(put).toHaveBeenCalledWith({ ...CONFIG, sources: [WEB] });
    expect(written).toEqual([WEB]);
  });

  it('drops a source_git_url that names a repository no longer attached, and keeps one that does', async () => {
    stored = { value: { ...CONFIG, source_git_url: API.clone_url } };
    await writeProjectSources(app, 'p-1', (sources) => withoutSource(sources, API));
    expect(put).toHaveBeenLastCalledWith({ ...CONFIG, sources: [WEB] });

    await writeProjectSources(app, 'p-1', (sources) => withSources(sources, [DOCS]).sources);
    expect(put).toHaveBeenLastCalledWith({
      ...CONFIG,
      source_git_url: API.clone_url,
      sources: [API, WEB, DOCS],
    });
  });

  it('writes the sources alone for a project whose config was never written', async () => {
    stored = null;
    await writeProjectSources(app, 'p-1', (sources) => withSources(sources, [DOCS]).sources);
    expect(put).toHaveBeenCalledWith({ sources: [DOCS] });
  });

  it('rejects when the write is refused, and invalidates nothing', async () => {
    put.mockRejectedValueOnce(new Error('403'));
    await expect(writeProjectSources(app, 'p-1', (sources) => sources)).rejects.toThrow('403');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
