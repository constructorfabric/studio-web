import { describe, expect, it } from 'vitest';
import type { ConnectionDto } from '../connector/connectorTypes';
import { checkoutDirectory, sessionSources } from './sessionSources';

function connection(id: string, scope: string): ConnectionDto {
  return {
    id,
    owner_tenant_id: 'org',
    provider: 'github',
    label: id,
    account: 'acme',
    base_url: '',
    scope,
    secret_ref: `ref-${id}`,
    created_at_epoch_secs: 0,
  };
}

const source = (full_path: string, connection_id = 'c-org') => ({
  connection_id,
  full_path,
  clone_url: `https://git.test/${full_path}.git`,
});

describe('sessionSources', () => {
  it('names each directory after the last segment of full_path, one name per source, in order', () => {
    const repos = sessionSources(
      [source('Acme/Web.App'), source('other/web-app'), source('acme/web.app'), source('group/sub/api')],
      [connection('c-org', 'organization')]
    );

    // The backend refuses a name outside [a-z0-9_-]+ or a duplicate with a 500.
    expect(repos.map((repo) => repo.name)).toEqual(['web-app', 'web-app-2', 'web-app-3', 'api']);
    expect(repos[0]).toEqual({
      name: 'web-app',
      kind: 'git',
      url: 'https://git.test/Acme/Web.App.git',
      token_ref: 'ref-c-org',
    });
    expect(sessionSources([], [])).toEqual([]);
  });

  it('skips a source with no clone url, so it takes no name', () => {
    const repos = sessionSources(
      [{ connection_id: 'c-org', full_path: 'acme/web', clone_url: ' ' }, source('other/web')],
      [connection('c-org', 'organization')]
    );

    expect(repos.map((repo) => repo.name)).toEqual(['web']);
  });

  it('names a source with no full_path `source` instead of throwing', () => {
    const stored = { connection_id: 'c-org', clone_url: 'https://git.test/x.git' } as unknown as Parameters<
      typeof sessionSources
    >[0][number];

    expect(sessionSources([stored], [connection('c-org', 'organization')]).map((repo) => repo.name)).toEqual(['source']);
  });

  it("finds the directory an artifact's repository is checked out into, the launch's suffix included", () => {
    const sources = [
      { connection_id: 'c-org', full_path: 'acme/skipped', clone_url: '' },
      source('acme/web'),
      source('other/web'),
    ];

    expect(checkoutDirectory(sources, 'acme/web')).toBe('web');
    expect(checkoutDirectory(sources, 'other/web')).toBe('web-2');
    // Not cloned, or not a source of the project: nowhere to look.
    expect(checkoutDirectory(sources, 'acme/skipped')).toBeNull();
    expect(checkoutDirectory(sources, 'acme/unknown')).toBeNull();
  });

  it('sends no reference for a personal connection, nor for one the organization no longer has', () => {
    const repos = sessionSources(
      [source('a/shared', 'c-ws'), source('a/mine', 'c-me'), source('a/gone', 'c-deleted')],
      [connection('c-ws', 'workspace'), connection('c-me', 'personal')]
    );

    expect(repos[0]?.token_ref).toBe('ref-c-ws');
    expect(repos[1]).not.toHaveProperty('token_ref');
    expect(repos[2]).not.toHaveProperty('token_ref');
  });
});
