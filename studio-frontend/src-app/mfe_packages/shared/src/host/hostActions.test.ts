import { describe, expect, it } from 'vitest';
import { STUDIO_ARTIFACT_KINDS, isStudioArtifactKind } from './hostActions';

describe('isStudioArtifactKind', () => {
  it('accepts every declared kind', () => {
    for (const kind of STUDIO_ARTIFACT_KINDS) expect(isStudioArtifactKind(kind)).toBe(true);
  });

  it('refuses anything else, including a near miss and a non-string', () => {
    for (const value of ['spec_finding', 'File', '', undefined, null, 1, {}]) {
      expect(isStudioArtifactKind(value)).toBe(false);
    }
  });
});
