import { describe, expect, it } from 'vitest';
import {
  RestPlugin,
  RestProtocol,
  type ApiPluginErrorContext,
  type RestRequestContext,
} from '@gears-frontx/react';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKeyPlugin } from './idempotencyKeyPlugin';
import {
  ARTIFACT_INGEST_API_BASE_URL,
  ArtifactIngestApiService,
  startsSync,
} from './ArtifactIngestApiService';
import type { SyncBody } from './artifactTypes';
import {
  DOCUMENTS_API_BASE_URL,
  DocumentsApiService,
  startsQualityRun,
} from './DocumentsApiService';

const request = (
  method: RestRequestContext['method'],
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
) => ({ method, url, body, headers }) as RestRequestContext;

const SYNC_URL = `${ARTIFACT_INGEST_API_BASE_URL}/sync`;

describe('IdempotencyKeyPlugin', () => {
  const plugin = new IdempotencyKeyPlugin(startsSync);

  it('gives every new body that starts work a key of its own', () => {
    const first = plugin.onRequest(request('POST', SYNC_URL, { repo: 'a' }));
    const second = plugin.onRequest(request('POST', SYNC_URL, { repo: 'a' }));
    expect(first.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.headers[IDEMPOTENCY_KEY_HEADER]).not.toBe(first.headers[IDEMPOTENCY_KEY_HEADER]);
  });

  it('gives the same body object the same key, so a resend is the same intent', () => {
    const body = { repo: 'a' };
    const first = plugin.onRequest(request('POST', SYNC_URL, body));
    const again = plugin.onRequest(request('POST', SYNC_URL, body));
    expect(again.headers[IDEMPOTENCY_KEY_HEADER]).toBe(first.headers[IDEMPOTENCY_KEY_HEADER]);
  });

  it('gives one body sent to two URLs two keys: the server remembers a key per tenant, not per route', () => {
    const body = { repo: 'a' };
    const first = plugin.onRequest(request('POST', SYNC_URL, body));
    const other = plugin.onRequest(request('POST', `${SYNC_URL}?again=1`, body));
    expect(other.headers[IDEMPOTENCY_KEY_HEADER]).not.toBe(first.headers[IDEMPOTENCY_KEY_HEADER]);
  });

  it('keeps a key the caller already chose', () => {
    const out = plugin.onRequest(request('POST', SYNC_URL, {}, { [IDEMPOTENCY_KEY_HEADER]: 'k-1' }));
    expect(out.headers[IDEMPOTENCY_KEY_HEADER]).toBe('k-1');
  });

  it('leaves reads and other paths alone', () => {
    expect(plugin.onRequest(request('GET', SYNC_URL)).headers).toEqual({});
    expect(plugin.onRequest(request('POST', `${ARTIFACT_INGEST_API_BASE_URL}/nodes`, {})).headers).toEqual({});
    expect(plugin.onRequest(request('POST', '/cf/other-gear/v1/sync', {})).headers).toEqual({});
  });
});

describe('startsSync', () => {
  it('names the sync route exactly, with or without a query', () => {
    expect(startsSync(SYNC_URL)).toBe(true);
    expect(startsSync(`${SYNC_URL}?dry=1`)).toBe(true);
    // Built from the base, not written out: these routes do not exist, and
    // scripts/check-api-usage.mjs reads every literal path as a call.
    expect(startsSync(`${ARTIFACT_INGEST_API_BASE_URL}/quality/sync`)).toBe(false);
    expect(startsSync(`${SYNC_URL}/x`)).toBe(false);
  });
});

describe('startsQualityRun', () => {
  const QUALITY = `${DOCUMENTS_API_BASE_URL}/workspaces/w-1/projects/p-1/quality`;

  it('names a quality run of any detector, with or without a query', () => {
    expect(startsQualityRun(`${QUALITY}/purpose`)).toBe(true);
    expect(startsQualityRun(`${QUALITY}/leak?x=1`)).toBe(true);
  });

  it('leaves the other routes alone', () => {
    // Built from the base, not written out: scripts/check-api-usage.mjs reads
    // every literal path as a call.
    expect(startsQualityRun(`${DOCUMENTS_API_BASE_URL}/workspaces/w-1/projects/p-1/documents`)).toBe(false);
    expect(startsQualityRun(`${QUALITY}/purpose/x`)).toBe(false);
    expect(startsQualityRun(`${ARTIFACT_INGEST_API_BASE_URL}/workspaces/w-1/projects/p-1/quality/leak`)).toBe(
      false
    );
  });
});

/** Records every request it is handed; the first `fail` of them are lost. */
function recordingAdapter(fail = 0) {
  const seen: { method?: string; headers: Record<string, unknown> }[] = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    seen.push({ method: config.method, headers: { ...config.headers } });
    if (seen.length <= fail) throw new Error('lost on the way');
    const data = config.method === 'post' ? { run_id: 'r-1', status: 'queued' } : { items: [], total: 0 };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  return { seen, adapter };
}

/** The service's REST protocol, its axios client answered by `adapter`. */
function wired(
  service: ArtifactIngestApiService | DocumentsApiService,
  adapter: AxiosAdapter
): RestProtocol {
  const rest = (service as unknown as { protocol: (c: typeof RestProtocol) => RestProtocol }).protocol(
    RestProtocol
  );
  (rest as unknown as { client: { defaults: { adapter: AxiosAdapter } } }).client.defaults.adapter = adapter;
  return rest;
}

const BODY: SyncBody = { provider: 'github', secret_ref: 's', repo_full_path: 'o/r' };

describe('ArtifactIngestApiService and the key', () => {
  it('sends a key on POST /sync and none on the nodes read', async () => {
    const service = new ArtifactIngestApiService();
    const { seen, adapter } = recordingAdapter();
    wired(service, adapter);

    await service.sync.fetch(BODY);
    await service.nodes({ scope: 'p-1' }).fetch({ staleTime: 0 });

    expect(seen.map((r) => r.method)).toEqual(['post', 'get']);
    expect(seen[0].headers[IDEMPOTENCY_KEY_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1].headers[IDEMPOTENCY_KEY_HEADER]).toBeUndefined();
  });

  it('keeps the key on a plugin retry, which rebuilds the request before the plugins', async () => {
    class RetryOnce extends RestPlugin {
      async onError(context: ApiPluginErrorContext) {
        return context.retryCount === 0 ? context.retry() : context.error;
      }
    }
    const service = new ArtifactIngestApiService();
    const { seen, adapter } = recordingAdapter(1);
    wired(service, adapter).plugins.add(new RetryOnce());

    await service.sync.fetch(BODY);

    expect(seen).toHaveLength(2);
    expect(seen[1].headers[IDEMPOTENCY_KEY_HEADER]).toBe(seen[0].headers[IDEMPOTENCY_KEY_HEADER]);
  });
});

describe('DocumentsApiService and the key', () => {
  it('sends purpose and leak of one body each its own key, and none on a write that starts no run', async () => {
    const service = new DocumentsApiService();
    const { seen, adapter } = recordingAdapter();
    wired(service, adapter);
    const project = { workspaceId: 'w-1', projectId: 'p-1' };
    const body = { binding_ids: ['b-1'], document_ids: [] };

    await service.analyze({ ...project, detector: 'purpose' }).fetch(body);
    await service.analyze({ ...project, detector: 'leak' }).fetch(body);
    await service.createDocument(project).fetch({ type_key: 'prd', title: 'PRD' });

    const keys = seen.map((r) => r.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBeUndefined();
  });
});
