import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioEventsApiService, type StudioEvent } from './StudioEventsApiService';

const SHARED_AUTH_SESSION_SYMBOL = Symbol.for('frontx:auth:shared-session');

type SharedAuthHost = typeof globalThis & { [SHARED_AUTH_SESSION_SYMBOL]?: unknown };

/** Publish a host session, the way the `auth()` plugin does for MFEs. */
function publishBearerSession(token: string): void {
  (globalThis as SharedAuthHost)[SHARED_AUTH_SESSION_SYMBOL] = {
    getSession: async () => ({ kind: 'bearer', token }),
  };
}

function sseResponse(events: object[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new TextEncoder().encode(text), { status: 200 });
}

function event(seq: number, kind = 'task.succeeded') {
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq,
    kind,
    subject_type: 'task',
    subject_id: 'task-1',
    source: 'studio-artifact-ingest',
    payload: { task_id: 'task-1', status: 'succeeded' },
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('StudioEventsApiService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as SharedAuthHost)[SHARED_AUTH_SESSION_SYMBOL];
  });

  it('declares the stream and the catch-up page against the studio-events gear', () => {
    const service = new StudioEventsApiService();

    expect(service.events.key).toEqual(['/cf/studio-events/v1', 'SSE', '/stream']);
    expect(service.since({ afterSeq: 12 }).key[2]).toBe('/events?after_seq=12');
    // The starting cursor rides in the URL, which the transport reads and the
    // server ignores — and which makes this a different descriptor, so
    // useApiStream opens a new connection instead of keeping the old one.
    expect(service.streamFrom(7).key[2]).toBe('/stream?resume_from=7');
    expect(service.streamFrom(7).key).not.toEqual(service.events.key);
  });

  it('connects with the host session bearer and delivers parsed events', async () => {
    publishBearerSession('session-token');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([event(1)]))
      .mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const service = new StudioEventsApiService();
    const seen: StudioEvent[] = [];
    const connectionId = await service.events.connect((e) => seen.push(e));

    await until(() => seen.length === 1, 'the event');
    service.events.disconnect(connectionId);

    expect(seen[0]?.kind).toBe('task.succeeded');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/cf/studio-events/v1/stream');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
    });
  });

  // The cursor mechanics themselves — replaying the gap, dropping the overlap
  // — are the transport's, and are covered in
  // src/api/sse/__tests__/FetchEventSource.test.ts. Exercising them here would
  // only pull axios into a jsdom XHR that has nothing to answer it.
});
