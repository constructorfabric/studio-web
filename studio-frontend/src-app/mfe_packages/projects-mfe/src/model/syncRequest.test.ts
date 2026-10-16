import { describe, expect, it } from 'vitest';
import type { ConnectionDto, ProjectSource } from '@constructor-studio/mfe-shared';
import { ARTIFACT_NODE_TYPES, type ArtifactNodeDto } from '../api/artifactTypes';
import { repoNodeOf, syncPlan, unsyncedSources } from './syncRequest';

const source = (full_path: string, connection_id = 'c-github'): ProjectSource => ({
  connection_id,
  full_path,
  clone_url: `https://example.test/${full_path}.git`,
});

const repoNode = (full_path: string, connector_id?: string, id = full_path): ArtifactNodeDto => ({
  type_id: ARTIFACT_NODE_TYPES.repo,
  instance_id: id,
  value: { full_path, connector_id },
});

const connection = (id: string, provider: string): ConnectionDto =>
  ({ id, provider, label: id, base_url: '', secret_ref: `ref-${id}` }) as ConnectionDto;

const connections = new Map([
  ['c-github', connection('c-github', 'github')],
  ['c-gitlab', connection('c-gitlab', 'gitlab')],
  ['c-bitbucket', connection('c-bitbucket', 'bitbucket')],
]);

describe('which sources a sync is asked for', () => {
  it('asks for a GitHub repository with what the gear needs to pull it', () => {
    expect(syncPlan([source('acme/api')], connections)).toEqual({
      repos: [{ repo: 'acme/api', provider: 'github', baseUrl: undefined, secretRef: 'ref-c-github' }],
      unsyncable: [],
    });
  });

  it('records GitLab and Bitbucket repositories as unsyncable, saying why', () => {
    const plan = syncPlan(
      [source('acme/lab', 'c-gitlab'), source('acme/bucket', 'c-bitbucket')],
      connections
    );

    expect(plan.repos).toEqual([]);
    expect(plan.unsyncable).toEqual([
      { repo: 'acme/lab', reason: { kind: 'i18n', key: 'artifacts_reason_provider_cannot_sync' } },
      { repo: 'acme/bucket', reason: { kind: 'i18n', key: 'artifacts_reason_provider_cannot_sync' } },
    ]);
  });

  it('records a source whose connection is gone as unsyncable', () => {
    expect(syncPlan([source('acme/api', 'c-gone')], connections).unsyncable).toEqual([
      { repo: 'acme/api', reason: { kind: 'i18n', key: 'artifacts_reason_no_connection' } },
    ]);
  });
});

describe("a source's repository node", () => {
  it('is the node of the same path synced through the same connection', () => {
    const nodes = [
      repoNode('acme/api', 'studio-connection-c-other', 'other'),
      repoNode('acme/api', 'studio-connection-c-github', 'mine'),
    ];
    expect(repoNodeOf(nodes, source('acme/api'))?.instance_id).toBe('mine');
  });

  it('is not the node another connection synced, so a repository attached again reads as never synced', () => {
    expect(repoNodeOf([repoNode('acme/api', 'studio-connection-c-old')], source('acme/api'))).toBeNull();
  });

  it('is matched by path alone when the node carries no connection', () => {
    expect(repoNodeOf([repoNode('acme/api')], source('acme/api'))?.instance_id).toBe('acme/api');
  });

  it('is matched by path alone when synced through a connection without a token, whose reference is empty', () => {
    expect(repoNodeOf([repoNode('acme/api', '')], source('acme/api'))?.instance_id).toBe('acme/api');
    expect(unsyncedSources([source('acme/api')], [repoNode('acme/api', '')], [], [])).toEqual([]);
  });

  it('ignores what the provider did to the path case, and nodes that are not repositories', () => {
    const file = { ...repoNode('acme/api'), type_id: ARTIFACT_NODE_TYPES.file };
    expect(repoNodeOf([file], source('acme/api'))).toBeNull();
    expect(repoNodeOf([repoNode('acme/api')], source('Acme/API'))).not.toBeNull();
  });
});

describe('the sources nothing has pulled in', () => {
  const sources = [source('acme/api'), source('acme/web'), source('acme/docs')];

  it('takes the sources the graph has no repository node for', () => {
    expect(
      unsyncedSources(sources, [repoNode('acme/api')], [], []).map((s) => s.full_path)
    ).toEqual(['acme/web', 'acme/docs']);
  });

  it('matches a node whatever the provider did to the path case', () => {
    expect(unsyncedSources([source('Acme/API')], [repoNode('acme/api')], [], [])).toEqual([]);
  });

  it('takes a repository attached again through another connection, whose old node is not its own', () => {
    const nodes = [repoNode('acme/api', 'studio-connection-c-old')];
    expect(unsyncedSources([source('acme/api')], nodes, [], []).map((s) => s.full_path)).toEqual([
      'acme/api',
    ]);
  });

  it('leaves out a repository that has a line in the import, whatever its state', () => {
    const lines = [{ repo: 'acme/web' }, { repo: 'acme/docs' }];
    expect(unsyncedSources(sources, [], lines, []).map((s) => s.full_path)).toEqual(['acme/api']);
  });

  it('leaves out a repository this tab already asked for, even one whose sync failed', () => {
    expect(unsyncedSources(sources, [], [], ['acme/web']).map((s) => s.full_path)).toEqual([
      'acme/api',
      'acme/docs',
    ]);
  });
});
