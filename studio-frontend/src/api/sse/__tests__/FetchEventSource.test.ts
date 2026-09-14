import { describe, expect, it, vi } from 'vitest';
import { FetchEventSource } from '../FetchEventSource';

/** An event as the studio-events backend serialises it. */
function event(seq: number, kind = 'task.running') {
  return { seq, at_ms: 1_700_000_000_000 + seq, kind, subject_type: 'task', subject_id: 't1' };
}

/** An SSE body: unnamed frames plus the keep-alive comment the server sends. */
function sseResponse(events: object[], { keepAlive = true } = {}): Response {
  const text =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') +
    (keepAlive ? ': keepalive\n\n' : '');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Two chunks split mid-frame, so the reader's buffering is exercised
      // rather than assumed.
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Never settles: parks the reconnect loop so a test can assert in peace. */
function pending(): Promise<Response> {
  return new Promise<Response>(() => {});
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('FetchEventSource', () => {
  it('sends the bearer, parses unnamed frames across chunks, and ignores keep-alives', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([event(1), event(2)]))
      .mockImplementation(pending);

    const source = new FetchEventSource('/cf/studio-events/v1/stream', {
      getToken: () => 'tok',
      fetchImpl,
    });
    const seen: string[] = [];
    source.onmessage = (e) => seen.push(e.data as string);

    await until(() => seen.length === 2, 'both frames');
    source.close();

    expect(seen.map((d) => JSON.parse(d).seq)).toEqual([1, 2]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer tok', Accept: 'text/event-stream' }),
    });
  });

  it('fires `open` only after the constructor returns, so handlers set on the next line still see it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(sseResponse([])));
    const source = new FetchEventSource('/stream', { fetchImpl });
    let opened = false;
    source.onopen = () => {
      opened = true;
    };

    await until(() => opened, 'the open event');
    source.close();
    expect(opened).toBe(true);
  });

  it('reconnects when the stream ends, without surfacing an error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([event(1)], { keepAlive: false }))
      .mockResolvedValueOnce(sseResponse([event(2)], { keepAlive: false }))
      .mockImplementation(pending);

    const source = new FetchEventSource('/stream', { fetchImpl });
    const seen: number[] = [];
    source.onmessage = (e) => seen.push(JSON.parse(e.data as string).seq);
    const errors: unknown[] = [];
    source.onerror = (e) => errors.push(e);

    await until(() => seen.length === 2, 'a frame from each connection');
    source.close();

    expect(seen).toEqual([1, 2]);
    // A dropped connection is not the consumer's problem: surfacing it as
    // `onerror` would make SseProtocol tear the connection down for good.
    expect(errors).toEqual([]);
  });

  it('replays the gap on reconnect and drops the overlap', async () => {
    // First connection delivers 1 and 2 and ends. The reconnect carries 4 and
    // 5 live while the catch-up page holds 3 and 4 — so 4 must not arrive
    // twice, and nothing may arrive out of order.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.includes('after_seq=')) {
        return Promise.resolve(jsonResponse({ events: [event(3), event(4)], latest_seq: 5 }));
      }
      return fetchImpl.mock.calls.filter(([u]) => !String(u).includes('after_seq=')).length === 1
        ? Promise.resolve(sseResponse([event(1), event(2)], { keepAlive: false }))
        : Promise.resolve(sseResponse([event(4), event(5)]));
    });

    const seen: number[] = [];
    const source = new FetchEventSource('/stream', {
      fetchImpl,
      resume: {
        cursorOf: (e) => (e as { seq: number }).seq,
        gap: async (cursor) => {
          const page = (await fetchImpl(`/events?after_seq=${cursor}`)) as Response;
          return ((await page.json()) as { events: unknown[] }).events;
        },
      },
    });
    source.onmessage = (e) => seen.push(JSON.parse(e.data as string).seq);

    await until(() => seen.length >= 5, 'both connections plus the replayed gap');
    source.close();

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives up on 401 instead of hammering the gateway, and reports it once', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 401 }));

    const source = new FetchEventSource('/stream', { fetchImpl });
    const errors: unknown[] = [];
    source.onerror = (e) => errors.push(e);

    await until(() => errors.length === 1, 'the error to surface');
    // Give the loop a chance to retry if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(source.readyState).toBe(2); // CLOSED
  });

  it('routes named frames to listeners, not to onmessage', async () => {
    const body = new Response(`event: done\ndata: {}\n\n`, { status: 200 });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(body).mockImplementation(pending);

    const source = new FetchEventSource('/stream', { fetchImpl });
    const messages: unknown[] = [];
    source.onmessage = (e) => messages.push(e.data);
    let done = false;
    source.addEventListener('done', () => {
      done = true;
    });

    await until(() => done, 'the completion frame');
    source.close();

    // `done` is the protocol's completion signal, not an event for consumers.
    expect(messages).toEqual([]);
  });
});
