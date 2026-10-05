import { describe, expect, it } from 'vitest';
import { ARTIFACT_NODE_TYPES } from '../api/artifactTypes';
import { buildArtifactRows, buildRepositories, clampOffset, opensInEditor } from './artifact';

const REPOS = new Map([['repo-1', 'group/repo']]);

function row(type: keyof typeof ARTIFACT_NODE_TYPES, value: Record<string, unknown>) {
  const [built] = buildArtifactRows(
    [{ type_id: ARTIFACT_NODE_TYPES[type], instance_id: 'n-1', value }],
    REPOS
  );
  return built;
}

describe('rows of the kinds outside the default listing', () => {
  it('names a commit by its short sha and subject, and dates it', () => {
    const commit = row('commit', {
      repo: 'repo-1',
      short_sha: 'a1b2c3d',
      title: 'Fix the build',
      url: 'https://forge.example/group/repo/-/commit/a1b2c3d',
      created_at: '2026-09-20T10:00:00Z',
    });
    expect(commit.kind).toBe('commit');
    expect(commit.name).toBe('a1b2c3d Fix the build');
    expect(commit.repository).toBe('group/repo');
    expect(commit.path).toBe('-/commit/a1b2c3d');
    expect(commit.updatedAt).toBe(Date.parse('2026-09-20T10:00:00Z'));
  });

  it('names a comment by its snippet', () => {
    const comment = row('comment', {
      repo: 'repo-1',
      title: 'Looks good to me',
      url: 'https://forge.example/group/repo/-/issues/4#note_9',
      created_at: '2026-09-20T10:00:00Z',
    });
    expect(comment.kind).toBe('comment');
    expect(comment.name).toBe('Looks good to me');
    // The fragment is what tells two comments on one issue apart.
    expect(comment.path).toBe('-/issues/4#note_9');
  });

  it('names a user by login, with no repository and no path', () => {
    const user = row('user', { provider: 'gitlab', login: 'ada', title: 'ada' });
    expect(user.kind).toBe('user');
    expect(user.name).toBe('ada');
    expect(user.repository).toBe('');
    expect(user.path).toBe('');
    expect(user.updatedAt).toBeNull();
    expect(user.provenance).toBeNull();
  });

  it('opens none of them in the editor — only a file with a path does', () => {
    expect(opensInEditor(row('commit', { repo: 'repo-1', short_sha: 'a', title: 't' }))).toBe(false);
    expect(opensInEditor(row('comment', { repo: 'repo-1', title: 't' }))).toBe(false);
    expect(opensInEditor(row('user', { login: 'ada' }))).toBe(false);
    expect(opensInEditor(row('file', { repo: 'repo-1', path: 'docs/a.md' }))).toBe(true);
    expect(opensInEditor(row('file', { repo: 'repo-1' }))).toBe(false);
  });
});

describe('rows of the default listing', () => {
  it('names a file by its last segment and keeps its checkout-relative path', () => {
    const file = row('file', { repo: 'repo-1', path: 'docs/guide/a.md', from_checkout: true });
    expect(file.name).toBe('a.md');
    expect(file.path).toBe('docs/guide/a.md');
    expect(file.repository).toBe('group/repo');
    expect(file.updatedAt).toBeNull();
    expect(file.provenance).toBe('checkout');
  });

  it('says where a file came from when it has no time', () => {
    expect(row('file', { repo: 'repo-1', path: 'a.md' }).provenance).toBe('tree');
    expect(row('file', { repo: 'repo-1', path: 'logo.png', from_checkout: true }).provenance).toBe(
      'checkout'
    );
    expect(row('file', { repo: 'repo-1', path: 'a.md', has_text: true }).provenance).toBe(
      'checkout'
    );
    expect(row('file', { repo: 'repo-1', path: 'a.md', origin: 'upload' }).provenance).toBe(
      'upload'
    );
  });

  it('names an issue and a pull request by number and title, with the path under the repository', () => {
    const issue = row('issue', {
      repo: 'repo-1',
      number: 4,
      title: 'Broken link',
      url: 'https://forge.example/group/repo/-/issues/4',
      updated_at: '2026-09-21T10:00:00Z',
    });
    expect(issue.name).toBe('#4 Broken link');
    expect(issue.path).toBe('-/issues/4');
    expect(issue.updatedAt).toBe(Date.parse('2026-09-21T10:00:00Z'));
    expect(issue.provenance).toBeNull();

    const pr = row('pullRequest', {
      repo: 'repo-1',
      number: 7,
      title: 'Add docs',
      url: 'https://forge.example/group/repo/-/merge_requests/7',
    });
    expect(pr.name).toBe('#7 Add docs');
    expect(pr.path).toBe('-/merge_requests/7');
  });

  it('names a repository by its full path, as its own repository, with no path', () => {
    const repo = row('repo', { full_path: 'group/other' });
    expect(repo.name).toBe('group/other');
    expect(repo.repository).toBe('group/other');
    expect(repo.path).toBe('');
    expect(repo.provenance).toBe('repository');
  });

  it('leaves a repository blank rather than guess one it cannot name', () => {
    expect(row('issue', { repo: 'unknown', title: 't' }).repository).toBe('');
  });
});

describe('buildRepositories', () => {
  it('lists repository nodes only, by name, skipping one without a name', () => {
    const repositories = buildRepositories([
      { type_id: ARTIFACT_NODE_TYPES.repo, instance_id: 'r-2', value: { full_path: 'group/zeta' } },
      { type_id: ARTIFACT_NODE_TYPES.file, instance_id: 'f-1', value: { path: 'a.md' } },
      { type_id: ARTIFACT_NODE_TYPES.repo, instance_id: 'r-1', value: { full_path: 'group/alpha' } },
      { type_id: ARTIFACT_NODE_TYPES.repo, instance_id: 'r-3', value: {} },
    ]);
    expect(repositories).toEqual([
      { id: 'r-1', name: 'group/alpha' },
      { id: 'r-2', name: 'group/zeta' },
    ]);
  });
});

describe('clampOffset', () => {
  it('moves an offset past the last row back to the last page, and leaves any other alone', () => {
    expect(clampOffset(72, 20, 18)).toBe(18);
    expect(clampOffset(18, 18, 18)).toBe(0);
    expect(clampOffset(36, 96, 18)).toBe(36);
    expect(clampOffset(36, 0, 18)).toBe(36);
  });
});
