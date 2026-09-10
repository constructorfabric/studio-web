import { describe, expect, it } from 'vitest';
import { orderedStages, projectSubtitle } from './project';
import type { ProjectConfig } from '../api/types';

/**
 * A stand-in for what `GET /workspaces/{id}/stages` returns: already the
 * effective, ordered list. The tests below never re-sort it — that is the point
 * of the assertions.
 */
const CATALOGUE = [
  { key: 'intent', label: 'Intent' },
  { key: 'prd', label: 'PRD' },
  { key: 'prd_spec', label: 'PRD-Spec' },
  { key: 'testing', label: 'Testing' },
];

describe('orderedStages', () => {
  it('returns catalogue order, not the order the config lists', () => {
    const config: ProjectConfig = { stages: ['testing', 'intent', 'prd'] };

    expect(orderedStages(config, CATALOGUE).map((stage) => stage.key)).toEqual([
      'intent',
      'prd',
      'testing',
    ]);
  });

  it('labels from the catalogue', () => {
    expect(orderedStages({ stages: ['prd_spec'] }, CATALOGUE)).toEqual([
      { key: 'prd_spec', label: 'PRD-Spec' },
    ]);
  });

  it('keeps a stage the catalogue does not know, last, rather than dropping it', () => {
    // A project may carry a key another writer added, or one the workspace has
    // since hidden. Dropping it would make the screen lie about the project.
    const keys = orderedStages({ stages: ['handover', 'intent'] }, CATALOGUE).map((s) => s.key);

    expect(keys).toEqual(['intent', 'handover']);
  });

  it('follows a reordered catalogue rather than a built-in order', () => {
    // The whole point of serving the catalogue: an organization may reorder it,
    // and the screen has to follow.
    const reordered = [
      { key: 'prd', label: 'PRD' },
      { key: 'intent', label: 'Intent' },
    ];

    expect(orderedStages({ stages: ['intent', 'prd'] }, reordered).map((s) => s.key)).toEqual([
      'prd',
      'intent',
    ]);
  });

  it('renders keys under their own names when the catalogue has not loaded', () => {
    // An empty catalogue is the loading state, and a project still has stages.
    expect(orderedStages({ stages: ['intent'] }, [])).toEqual([{ key: 'intent', label: 'intent' }]);
  });

  it('is empty for a config with no stages', () => {
    expect(orderedStages(null, CATALOGUE)).toEqual([]);
    expect(orderedStages({}, CATALOGUE)).toEqual([]);
  });
});

describe('projectSubtitle', () => {
  it('prefers the brief, falls back to the git source', () => {
    expect(projectSubtitle({ brief: ' ship it ' })).toBe('ship it');
    expect(projectSubtitle({ source_git_url: 'https://example.test/repo' })).toBe(
      'https://example.test/repo'
    );
    expect(projectSubtitle({})).toBeNull();
  });
});
