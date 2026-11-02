import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHARED_AUTH_SESSION_SYMBOL } from '@gears-frontx/frontx-template-shell';
import { StudioEventsApiService, pageThrough, type StudioEvent } from './StudioEventsApiService';

type SharedAuthHost = typeof globalThis & { [SHARED_AUTH_SESSION_SYMBOL]?: unknown };

/** Publish a host session, the way the shell's `sharedAuthTransport()` does for MFEs. */
function publishBearerSession(token: string): void {
  (globalThis as SharedAuthHost)[SHARED_AUTH_SESSION_SYMBOL] = {
    getSession: async () => ({ kind: 'bearer', token }),
  };
}

function sseResponse(events: object[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new TextEncoder().encode(text), { status: 200 });
}

/** The run every event below is about. `subject_id` is the run id. */
const RUN_ID = '9c8c6d5e-2f1a-4b7c-8d3e-6a5b4c3d2e1f';

/**
 * One event exactly as `studio-tasks` announces it: `task.<state>` about a
 * `task_run`, carrying the fields `GET /studio-tasks/v1/runs/{id}` answers
 * with. Kept faithful because this fixture is what the next consumer copies.
 */
function event(seq: number, kind = 'task.succeeded') {
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq,
    kind,
    subject_type: 'task_run',
    subject_id: RUN_ID,
    source: 'studio-tasks',
    payload: { run_id: RUN_ID, task_type: 'artifact.ingest', state: kind.slice('task.'.length) },
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

  it('pages through a catch-up longer than one page, and stops at the first short page', async () => {
    const seen: number[] = [];
    const read = vi.fn(async (afterSeq: number, limit: number) => {
      seen.push(afterSeq);
      const events = Array.from({ length: afterSeq === 0 ? limit : 3 }, (_, i) => event(afterSeq + i + 1));
      return { events, latest_seq: 503 };
    });

    const replayed = await pageThrough(read, 0);

    expect(seen).toEqual([0, 500]);
    expect(replayed).toHaveLength(503);
    expect(replayed[replayed.length - 1]?.seq).toBe(503);
    expect(await pageThrough(async () => ({ events: [], latest_seq: 0 }), 7)).toEqual([]);
  });

  it('stops at the high-water mark of the first page, however full the pages stay', async () => {
    // A tenant publishing faster than the pages are read: every page full, and
    // `latest_seq` moving on. The replay ends at the mark it started with; the
    // rest is on the live stream.
    let published = 700;
    const read = vi.fn(async (afterSeq: number, limit: number) => {
      published += 500;
      return { events: Array.from({ length: limit }, (_, i) => event(afterSeq + i + 1)), latest_seq: published };
    });

    const replayed = await pageThrough(read, 0);

    expect(read).toHaveBeenCalledTimes(3);
    expect(replayed).toHaveLength(1500);
    expect(replayed[replayed.length - 1]?.seq).toBe(1500);
  });

  it('fails when the window was pruned past the cursor, so the events in between are gone', async () => {
    const read = vi.fn(async () => ({ events: [event(9), event(10)], latest_seq: 10 }));

    await expect(pageThrough(read, 3)).rejects.toThrow('events 4..8 are no longer retained');
  });

  // The cursor mechanics themselves — replaying the gap, dropping the overlap
  // — are the transport's, and are covered in
  // src/api/sse/__tests__/FetchEventSource.test.ts. Exercising them here would
  // only pull axios into a jsdom XHR that has nothing to answer it.
});
