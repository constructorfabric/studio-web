// @vitest-environment node

/**
 * Where the end-to-end suite runs, and as whom (ADR-0029, amended by
 * ADR-0031): the seeded `demo/studio` belong to the compose portal on
 * `localhost:8080` and to nothing else, a named account wins everywhere, and
 * a password never goes over plain HTTP away from this machine.
 */

import { describe, expect, it } from 'vitest';
import { readEnv } from '../e2e/support/env';

const NAMED = { E2E_USER: 'e2e', E2E_PASSWORD: 'pw' };

describe('readEnv', () => {
  it('is the compose portal with its seeded account when nothing is set', () => {
    const env = readEnv({});
    expect(env.baseUrl).toBe('http://localhost:8080');
    expect(env.isLocal).toBe(true);
    expect(env.credentials).toEqual({ username: 'demo', password: 'studio' });
  });

  it('seeds the compose portal by either name of this machine', () => {
    expect(readEnv({ E2E_BASE_URL: 'http://127.0.0.1:8080' }).credentials.username).toBe('demo');
  });

  it('names no account for the dev server, whichever stand is behind it', () => {
    expect(() => readEnv({ E2E_BASE_URL: 'http://localhost:5173' })).toThrow(/E2E_USER and E2E_PASSWORD/);
    expect(() => readEnv({ E2E_BASE_URL: 'http://localhost' })).toThrow(/E2E_USER and E2E_PASSWORD/);
  });

  it('takes a named account over the seeded one, and needs both halves of it', () => {
    expect(readEnv({ E2E_BASE_URL: 'http://localhost:8080', ...NAMED }).credentials).toEqual({
      username: 'e2e',
      password: 'pw',
    });
    expect(readEnv({ E2E_BASE_URL: 'http://localhost:5173', ...NAMED }).isLocal).toBe(true);
    expect(() => readEnv({ E2E_BASE_URL: 'http://localhost:5173', E2E_USER: 'e2e' })).toThrow(/E2E_PASSWORD/);
  });

  it('refuses plain HTTP away from this machine', () => {
    expect(() => readEnv({ E2E_BASE_URL: 'http://studio-dev.cfabric.org', ...NAMED })).toThrow(/https:\/\//);
    expect(readEnv({ E2E_BASE_URL: 'https://studio-dev.cfabric.org', ...NAMED }).isLocal).toBe(false);
  });
});
