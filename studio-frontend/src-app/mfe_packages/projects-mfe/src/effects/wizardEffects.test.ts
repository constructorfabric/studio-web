import { describe, expect, it } from 'vitest';
import { toProjectConfig } from './wizardEffects';
import { EMPTY_DRAFT, type ProjectDraft } from '../model/projectDraft';

const DRAFT: ProjectDraft = {
  ...EMPTY_DRAFT,
  name: 'Agent Platform',
  mode: 'modernize',
  sources: [
    {
      id: 'r1',
      fullPath: 'acme/web',
      cloneUrl: 'https://github.com/acme/web.git',
      connectionId: 'c-gh',
      shareMode: 'pull_request',
    },
    {
      id: 'r2',
      fullPath: 'acme/api',
      cloneUrl: 'https://bitbucket.org/acme/api.git',
      connectionId: 'c-bb',
      shareMode: 'branch',
    },
  ],
};

describe('the project config the wizard writes', () => {
  it('carries each repository with how its shared edits land', () => {
    expect(toProjectConfig(DRAFT, ['intent']).sources).toEqual([
      {
        connection_id: 'c-gh',
        full_path: 'acme/web',
        clone_url: 'https://github.com/acme/web.git',
        share_mode: 'pull_request',
      },
      {
        connection_id: 'c-bb',
        full_path: 'acme/api',
        clone_url: 'https://bitbucket.org/acme/api.git',
        share_mode: 'branch',
      },
    ]);
  });

  it('has no sources at all for a project started from scratch', () => {
    const config = toProjectConfig({ ...EMPTY_DRAFT, name: 'Blank', mode: 'greenfield' }, []);

    expect(config.sources).toBeUndefined();
    expect(config.source_git_url).toBeUndefined();
  });
});
