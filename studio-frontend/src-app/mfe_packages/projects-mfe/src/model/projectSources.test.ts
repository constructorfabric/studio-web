import { describe, expect, it } from 'vitest';
import type { ProjectSource } from '@constructor-studio/mfe-shared';
import { repositoryKey, withSources, withoutSource } from './projectSources';

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
    expect(repositoryKey('https://github.com/acme/api/.git')).toBe('github.com/acme/api');
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
