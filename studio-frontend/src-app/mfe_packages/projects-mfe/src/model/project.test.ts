import { describe, expect, it } from 'vitest';
import { JOURNEY_STAGES, orderedStages, projectSubtitle } from './project';
import type { ProjectConfig } from '../api/types';

describe('orderedStages', () => {
  it('returns the journey order, not the order the config lists', () => {
    const config: ProjectConfig = { stages: ['testing', 'intent', 'prd'] };

    expect(orderedStages(config).map((stage) => stage.key)).toEqual([
      'intent',
      'prd',
      'testing',
    ]);
  });

  it('labels from the catalogue', () => {
    expect(orderedStages({ stages: ['prd_spec'] })).toEqual([
      { key: 'prd_spec', label: 'PRD-Spec' },
    ]);
  });

  it('keeps a stage the catalogue does not know, last, rather than dropping it', () => {
    const keys = orderedStages({ stages: ['handover', 'intent'] }).map((stage) => stage.key);

    expect(keys).toEqual(['intent', 'handover']);
  });

  it('is empty for a config with no stages', () => {
    expect(orderedStages(null)).toEqual([]);
    expect(orderedStages({})).toEqual([]);
  });

  it('agrees with the prototype that intent is the only required stage', () => {
    expect(JOURNEY_STAGES.filter((stage) => stage.required).map((s) => s.key)).toEqual(['intent']);
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
