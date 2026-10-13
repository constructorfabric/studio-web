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
import { withSources, withoutSource } from '../model/projectSources';
import { writeProjectSources } from './projectSourcesEffects';

const source = (connection: string, fullPath: string): ProjectSource => ({
  connection_id: connection,
  full_path: fullPath,
  clone_url: `https://github.com/${fullPath}.git`,
});

const API = source('c-1', 'acme/api');
const WEB = { ...source('c-1', 'acme/web'), branch: 'main', share_mode: 'pull_request' } as const;
const DOCS = source('c-2', 'acme/docs');

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
