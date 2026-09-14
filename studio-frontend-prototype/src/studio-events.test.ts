import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentCursor,
  followRun,
  subscribeStudioEvents,
  type RunEventPayload,
  type StudioEvent,
} from "./studio-events";

/** One run transition as studio-tasks serialises it. */
function taskEvent(seq: number, state: RunEventPayload["state"], runId = "run-1") {
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq,
    kind: `task.${state}`,
    subject_type: "task_run",
    subject_id: runId,
    source: "studio-tasks",
    payload: { run_id: runId, task_type: "artifact.ingest", state, phase: null },
  };
}

/** An SSE body: unnamed frames plus the keep-alive comment the server sends. */
function sseBody(events: object[], { keepAlive = true } = {}): Response {
  const text =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (keepAlive ? ": keepalive\n\n" : "");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // One chunk per byte-range boundary that does NOT align with frames, so
      // the reader's buffering is exercised rather than assumed.
      const bytes = new TextEncoder().encode(text);
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function jsonBody(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Resolve once `predicate` holds, or fail the test by timing out. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("studio-events subscriber", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses unnamed frames, ignores keep-alives, and reads across chunk boundaries", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseBody([taskEvent(1, "queued"), taskEvent(2, "running")]))
      // The loop reconnects once the body ends; keep it quiet afterwards.
      .mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const seen: StudioEvent[] = [];
    const stop = subscribeStudioEvents("t", { onEvent: (e) => seen.push(e) });
    await until(() => seen.length === 2, "both events");
    stop();

    expect(seen.map((e) => e.kind)).toEqual(["task.queued", "task.running"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/cf/studio-events/v1/stream");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer t" },
    });
  });

  it("replays the gap from the cursor before delivering live frames, without duplicates", async () => {
    // The caller starts from seq 2. The stream immediately carries 4 and 5,
    // while the catch-up page holds 3, 4 — the overlap must not be delivered
    // twice, and nothing may arrive out of order.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/cf/studio-events/v1/stream")) {
        return Promise.resolve(sseBody([taskEvent(4, "running"), taskEvent(5, "succeeded")]));
      }
      return Promise.resolve(
        jsonBody({ events: [taskEvent(3, "running"), taskEvent(4, "running")], latest_seq: 5 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const seen: StudioEvent[] = [];
    const stop = subscribeStudioEvents("t", { fromSeq: 2, onEvent: (e) => seen.push(e) });
    await until(() => seen.length >= 3, "gap plus live frames");
    stop();

    expect(seen.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("after_seq=2"))).toBe(true);
  });

  it("stops for good on 401 rather than reconnecting against a dead session", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });

    const statuses: string[] = [];
    const stop = subscribeStudioEvents("t", { onEvent: () => {}, onStatus: (s) => statuses.push(s) });
    await until(() => statuses.includes("closed"), "the loop to give up");
    stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows one run to its terminal event and ignores other subjects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/cf/studio-events/v1/stream")) {
        return Promise.resolve(
          sseBody([
            taskEvent(1, "running", "other-run"),
            taskEvent(2, "running"),
            taskEvent(3, "succeeded"),
            taskEvent(4, "running", "other-run"),
          ]),
        );
      }
      return Promise.resolve(jsonBody({ events: [], latest_seq: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const progress: RunEventPayload[] = [];
    const done = await followRun("t", "run-1", (p: RunEventPayload) => progress.push(p));

    expect(done.state).toBe("succeeded");
    expect(progress.map((p) => p.run_id)).toEqual(["run-1"]);
  });

  it("reads the current cursor so a fast job can still be replayed", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonBody({ events: [], latest_seq: 7 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(currentCursor("t")).resolves.toBe(7);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/cf/studio-events/v1/events?after_seq=0");
  });
});
