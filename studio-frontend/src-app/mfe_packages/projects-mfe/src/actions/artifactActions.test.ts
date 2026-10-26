import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_ACTION_ARTIFACT_OPEN } from '@constructor-studio/mfe-shared';
import { createMfeBridgeFixture } from '../../../../__test-utils__/createMfeBridgeFixture';
import type { ArtifactRow } from '../model/artifact';
import { buildSpecRows } from '../model/specRows';
import { specRowDto } from '../model/specRows.fixture';
import { requestOpenArtifact, requestOpenSpec } from './artifactActions';

const FILE: ArtifactRow = {
  id: 'node-1',
  kind: 'file',
  name: 'README.md',
  repository: 'group/repo',
  path: 'docs/README.md',
  url: 'https://forge.example/group/repo/-/blob/main/docs/README.md',
  sync: 'ingested',
  updatedAt: null,
  provenance: 'checkout',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestOpenArtifact', () => {
  it('tells the shell which artifact was asked for, and nothing else', () => {
    const { bridge, executeActionsChain } = createMfeBridgeFixture({
      domainId: 'screen',
      instanceId: 'inst',
    });

    requestOpenArtifact(bridge, 'proj-1', FILE);

    expect(executeActionsChain).toHaveBeenCalledTimes(1);
    const [chain] = executeActionsChain.mock.calls[0];
    expect(chain.action.type).toBe(STUDIO_ACTION_ARTIFACT_OPEN);
    // Exactly the five fields the schema names — no row-only data like the
    // forge url, which the shell does not need and the address must not carry.
    expect(chain.action.payload).toEqual({
      projectId: 'proj-1',
      artifactId: 'node-1',
      repository: 'group/repo',
      path: 'docs/README.md',
      kind: 'file',
    });
  });

  it('survives a chain the shell refuses — the screen stays up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bridge } = createMfeBridgeFixture({
      domainId: 'screen',
      instanceId: 'inst',
      executeActionsChain: vi
        .fn<ReturnType<typeof createMfeBridgeFixture>['bridge']['executeActionsChain']>()
        .mockRejectedValue(new Error('No handler for action target')),
    });

    expect(() => requestOpenArtifact(bridge, 'proj-1', FILE)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    // Logged, not swallowed: a refused request leaves a trace.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('host action failed'),
      STUDIO_ACTION_ARTIFACT_OPEN,
      expect.any(Error)
    );
  });

  it('publishes nothing without a bridge', () => {
    expect(() => requestOpenArtifact(null, 'proj-1', FILE)).not.toThrow();
  });
});

describe('requestOpenSpec', () => {
  const ALL_SOURCES = { files_known: true, reviews_known: true, repos_known: true, counts: [] };
  const specRow = (overrides: Parameters<typeof specRowDto>[0]) =>
    buildSpecRows([specRowDto(overrides)], ALL_SOURCES, [])[0];
  const opened = (row: ReturnType<typeof specRow>) => {
    const { bridge, executeActionsChain } = createMfeBridgeFixture({ domainId: 'screen', instanceId: 'inst' });
    requestOpenSpec(bridge, 'proj-1', row);
    return executeActionsChain.mock.calls.map(([chain]) => chain.action.payload);
  };

  it('opens a repository file by its node, repository and path', () => {
    const row = specRow({ node_id: 'node-7', repo_full_path: 'acme/web', path: 'docs/prd.md' });
    expect(opened(row)).toEqual([
      { projectId: 'proj-1', artifactId: 'node-7', repository: 'acme/web', path: 'docs/prd.md', kind: 'file' },
    ]);
  });

  it('opens a Studio document by its id, its title where a file has its path', () => {
    const row = specRow({ id: 'doc-3', origin: 'authored', name: 'Payments PRD', node_id: null, repo_full_path: '' });
    expect(opened(row)).toEqual([
      { projectId: 'proj-1', artifactId: 'doc-3', repository: '', path: 'Payments PRD', kind: 'document' },
    ]);
  });

  it('asks for nothing when a file has no repository to open it from', () => {
    expect(opened(specRow({ repo_full_path: '' }))).toEqual([]);
  });
});
