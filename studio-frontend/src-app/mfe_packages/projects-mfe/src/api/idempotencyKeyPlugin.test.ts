import { describe, expect, it } from 'vitest';
import type { RestRequestContext } from '@gears-frontx/react';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKeyPlugin } from './idempotencyKeyPlugin';

const request = (method: RestRequestContext['method'], url: string, headers: Record<string, string> = {}) =>
  ({ method, url, headers }) as RestRequestContext;

describe('IdempotencyKeyPlugin', () => {
  const plugin = new IdempotencyKeyPlugin((url) => url.endsWith('/sync'));

  it('gives every POST that starts work a key of its own', () => {
    const first = plugin.onRequest(request('POST', '/cf/studio-artifact-ingest/v1/sync'));
    const second = plugin.onRequest(request('POST', '/cf/studio-artifact-ingest/v1/sync'));
    expect(first.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.headers[IDEMPOTENCY_KEY_HEADER]).not.toBe(first.headers[IDEMPOTENCY_KEY_HEADER]);
  });

  it('keeps a key the caller already chose, so a retry can reuse it', () => {
    const out = plugin.onRequest(request('POST', '/x/sync', { [IDEMPOTENCY_KEY_HEADER]: 'k-1' }));
    expect(out.headers[IDEMPOTENCY_KEY_HEADER]).toBe('k-1');
  });

  it('leaves reads and other paths alone', () => {
    expect(plugin.onRequest(request('GET', '/x/sync')).headers).toEqual({});
    expect(plugin.onRequest(request('POST', '/x/nodes')).headers).toEqual({});
  });
});
