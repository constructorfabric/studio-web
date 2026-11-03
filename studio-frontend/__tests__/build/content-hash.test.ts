// @vitest-environment node

/**
 * The shared-chunk hash the manifest publishes as `contentHash`. mfes 0.4.0
 * keys its shared-chunk cache on `name@version@contentHash` across every MFE,
 * so the hash has to follow the bytes served: one too fine only costs a second
 * fetch, one too coarse hands an MFE another build's chunk.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeContentHash, normalizeEmbeddedModulePathsInSource } from '../../src/build/mf-gts';

describe('normalizeEmbeddedModulePathsInSource', () => {
  it('writes one path for a dependency, whatever the install layout', () => {
    const canonical = '// node_modules/react/index.js\nvar a = 1;';

    for (const layout of [
      '// ../../node_modules/react/index.js\nvar a = 1;',
      '// ../../node_modules/.pnpm/react@19.2.0/node_modules/react/index.js\nvar a = 1;',
      '// node_modules/.pnpm/react@19.2.0/node_modules/react/index.js\nvar a = 1;',
    ]) {
      expect(normalizeEmbeddedModulePathsInSource(layout)).toBe(canonical);
    }
  });

  it('leaves a source without such a path as it is', () => {
    const source = "// node_modules/react/index.js\nimport x from './node_modules/local.js';\nconst icon = '../assets/node.svg';";

    expect(normalizeEmbeddedModulePathsInSource(source)).toBe(source);
  });
});

describe('computeContentHash', () => {
  const dirs: string[] = [];

  /** A chunk file of its own holding `bytes`. */
  function chunk(bytes: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'content-hash-'));
    dirs.push(dir);
    const file = join(dir, 'chunk.js');
    writeFileSync(file, bytes);
    return file;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('is the sha256 of the chunk, and changes with its bytes', () => {
    const hash = computeContentHash(chunk('export const a = 1;'));

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash(chunk('export const a = 1;'))).toBe(hash);
    expect(computeContentHash(chunk('export const a = 2;'))).not.toBe(hash);
  });

  it('is absent, with a warning, when the chunk cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(computeContentHash(join(tmpdir(), 'no-such-dir', 'chunk.js'))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('contentHash'));
  });
});
