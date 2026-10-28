// Subscriber for the studio-events channel (`/cf/studio-events/v1/*`).
//
// The backend pushes one stream per tenant: task progress, task completion,
// and whatever else a gear publishes. This is the reference client for it —
// the prototype proves the wire here, and the same three rules are what the
// frontx transport in studio-frontend implements:
//
//   1. `EventSource` is unusable: it cannot send `Authorization`, and our
//      gateway takes no token from the query string. So the stream is read
//      with `fetch` + `ReadableStream`, framed by hand.
//   2. A dropped connection is normal (laptop sleeps, proxy recycles). On
//      reconnect the gap is replayed by cursor from
//      `/studio-events/v1/events?after_seq=`, and live frames are held back
//      until that page has been delivered — so a subscriber sees every event
//      once, in order.
//   3. Frames are unnamed (`data:` only); the event type is the JSON `kind`.
//      Lines starting with `:` are keep-alive comments and carry nothing.

import { ApiError, UNAUTHENTICATED_EVENT, apiUrl } from "./api";

/** One event as it arrives on the channel. */
export interface StudioEvent<P = unknown> {
  /** Monotonic per-tenant cursor. The resume point after a disconnect. */
  seq: number;
  /** Milliseconds since the Unix epoch. */
  at_ms: number;
  /** `task.queued` | `task.running` | `task.progress` | `task.succeeded` | `task.failed` | … */
  kind: string;
  /** What the event is about: `task_run`, `workspace`, … */
  subject_type: string;
  /** The subject's id — for a background run, its run id. */
  subject_id: string;
  /** The gear that published it. */
  source: string;
  payload: P;
}

/**
 * What a `task.*` event carries: one transition of a `studio-tasks` run.
 *
 * The same fields `GET /studio-tasks/v1/runs/{id}` answers with, so a view can
 * be fed by either without a second mapping. `phase` arrives on
 * `task.progress`; `summary` / `error` / `result` on the terminal ones.
 */
export interface RunEventPayload {
  run_id: string;
  /** `<gear>.<verb>` — `artifact.ingest`, `connector.graph_sync`, … */
  task_type?: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** The phase the handler last reported. */
  phase?: string | null;
  /** One line about what it did, once it succeeded. */
  summary?: string | null;
  /** Why it stopped, once it failed. */
  error?: string | null;
  /** The handler's structured result — counts, ids, whatever it reports. */
  result?: Record<string, unknown> | null;
  attempts?: number | null;
  /** On an ending: whether a person started the run. `false` for Studio's own
   *  work -- the scheduler's sweeps, a delivery a run queued -- whose ending is
   *  nobody's news. Absent from a backend that predates it. */
  asked_by_person?: boolean;
}

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface SubscribeOptions {
  onEvent: (event: StudioEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  /**
   * Start from this cursor instead of "only what arrives from now on".
   *
   * Read it with {@link currentCursor} *before* starting whatever you are
   * about to watch: a task can finish before the stream is even open, and
   * without a starting cursor those events are simply not seen. With one, they
   * are replayed on connect like any other gap.
   */
  fromSeq?: number;
  /** The organization to listen to; the caller's home tenant when absent. */
  organization?: string;
}

/** States a run never leaves. Polling past one is how a UI hangs. */
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** Reconnect backoff in ms; the last value repeats. */
const BACKOFF = [500, 1_000, 2_000, 5_000, 10_000];

/** One subscriber of a shared stream, with its own cursor. */
interface Subscriber {
  onEvent: (event: StudioEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  lastSeq: number;
  /** Live events held while this subscriber's gap is replayed. */
  held: StudioEvent[] | null;
}

/** One live connection per token, however many screens listen. */
interface Shared {
  subscribers: Set<Subscriber>;
  status: StreamStatus;
  stop: () => void;
}

const shared = new Map<string, Shared>();

/** The stream for the organization on screen: one connection per token and
 *  organization (`?organization_id=`, as the gears' own routes take it). */
function withOrg(path: string, org: string | undefined): string {
  if (!org) return path;
  return `${path}${path.includes("?") ? "&" : "?"}organization_id=${encodeURIComponent(org)}`;
}

function hand(sub: Subscriber, event: StudioEvent): void {
  if (event.seq <= sub.lastSeq) return;
  sub.lastSeq = event.seq;
  sub.onEvent(event);
}

/**
 * Subscribe to the tenant's event stream. Returns an unsubscribe function —
 * call it on unmount, nothing else stops the loop.
 *
 * Every subscriber with the same token shares ONE connection. A browser keeps
 * six HTTP/1.1 connections per host; a stream per widget (the run list, the
 * inbox, the notifications, the live domain changes …) took them all, and
 * every other request of the page queued behind them. A subscriber that asks
 * for a cursor replays its own gap first, then joins the shared stream.
 */
export function subscribeStudioEvents(
  token: string,
  { onEvent, onStatus, fromSeq = 0, organization }: SubscribeOptions,
): () => void {
  const key = `${token}\u0000${organization ?? ""}`;
  const sub: Subscriber = { onEvent, onStatus, lastSeq: fromSeq, held: fromSeq > 0 ? [] : null };
  let line = shared.get(key);
  if (!line) {
    const created: Shared = { subscribers: new Set(), status: "connecting", stop: () => {} };
    shared.set(key, created);
    created.stop = openStream(token, {
      organization,
      onEvent: (event) => {
        for (const s of [...created.subscribers]) {
          if (s.held) s.held.push(event);
          else hand(s, event);
        }
      },
      onStatus: (status) => {
        created.status = status;
        for (const s of [...created.subscribers]) s.onStatus?.(status);
      },
    });
    line = created;
  } else {
    onStatus?.(line.status);
  }
  line.subscribers.add(sub);
  if (sub.held) {
    void fetch(apiUrl(withOrg(`/studio-events/v1/events?after_seq=${fromSeq}`, organization)), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) return;
        const page = (await res.json()) as { events: StudioEvent[] };
        for (const event of page.events) hand(sub, event);
      })
      .catch(() => undefined)
      .finally(() => {
        const queued = sub.held ?? [];
        sub.held = null;
        for (const event of queued) hand(sub, event);
      });
  }
  const mine = line;
  return () => {
    mine.subscribers.delete(sub);
    if (mine.subscribers.size === 0) {
      mine.stop();
      if (shared.get(key) === mine) shared.delete(key);
    }
  };
}

/** The one connection behind {@link subscribeStudioEvents}. */
function openStream(
  token: string,
  { onEvent, onStatus, fromSeq = 0, organization }: SubscribeOptions,
): () => void {
  const abort = new AbortController();
  // Highest cursor handed to the caller: the resume point, and the
  // deduplicator — a replayed page and the live stream can overlap.
  let lastSeq = fromSeq;
  let attempt = 0;

  const deliver = (event: StudioEvent) => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    onEvent(event);
  };

  // Everything published while we were away, oldest first.
  const catchUp = async (): Promise<void> => {
    const res = await fetch(apiUrl(withOrg(`/studio-events/v1/events?after_seq=${lastSeq}`, organization)), {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    if (!res.ok) return; // the live stream still works; a missed gap is not fatal
    const page = (await res.json()) as { events: StudioEvent[]; latest_seq: number };
    for (const event of page.events) deliver(event);
  };

  const run = async () => {
    while (!abort.signal.aborted) {
      onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const res = await fetch(apiUrl(withOrg("/studio-events/v1/stream", organization)), {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (res.status === 401) {
          // The session is over; retrying would only loop against the gateway.
          window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
          throw new ApiError(401, undefined);
        }
        if (!res.ok || !res.body) throw new ApiError(res.status, undefined);

        attempt = 0;
        onStatus?.("open");

        // Live frames are held until the replayed gap has been handed over, so
        // the caller never sees seq 12 before seq 9.
        let held: StudioEvent[] | null = lastSeq > 0 ? [] : null;
        const replayed =
          held === null
            ? Promise.resolve()
            : catchUp()
                .catch(() => undefined)
                .then(() => {
                  const queued = held ?? [];
                  held = null;
                  for (const event of queued) deliver(event);
                });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const event = parseFrame(frame);
            if (event) {
              if (held) held.push(event);
              else deliver(event);
            }
            split = buffer.indexOf("\n\n");
          }
        }
        await replayed;
      } catch (e) {
        if (abort.signal.aborted) break;
        if (e instanceof ApiError && e.status === 401) break;
      }
      if (abort.signal.aborted) break;
      const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      attempt += 1;
      // Jitter: many tabs reconnecting after one proxy recycle should not
      // arrive together.
      await sleep(wait + Math.random() * 250, abort.signal);
    }
    onStatus?.("closed");
  };

  void run();
  return () => abort.abort();
}

/**
 * The tenant's current high-water mark.
 *
 * Read it before starting a background job and pass it as `fromSeq`: then
 * nothing the job publishes can be missed, however fast it finishes.
 */
export async function currentCursor(token: string): Promise<number> {
  const res = await fetch(apiUrl("/studio-events/v1/events?after_seq=0&limit=1"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 0;
  const page = (await res.json()) as { latest_seq: number };
  return page.latest_seq ?? 0;
}

/** One SSE frame to an event, or `null` for keep-alives and unparsable frames. */
function parseFrame(frame: string): StudioEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null; // `: keepalive`, or a frame with no data line
  try {
    return JSON.parse(data) as StudioEvent;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Bare timers rather than `window.*`: this module is unit-tested outside a
    // DOM, and nothing here needs the window object.
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Follow one `studio-tasks` run to its end over the event channel.
 *
 * Resolves on the terminal transition (`succeeded` / `failed` / `cancelled`);
 * `onProgress` fires for every event before that. Rejects on timeout, and on
 * `signal` — in both cases the run keeps going server-side, which is what the
 * two messages say. Stopping watching is not cancelling: ask the run itself to
 * stop (`POST /studio-tasks/v1/runs/{id}/cancel`) if that is what you mean.
 */
export function followRun(
  token: string,
  runId: string,
  onProgress: (payload: RunEventPayload) => void,
  {
    fromSeq,
    timeoutMs = 10 * 60 * 1000,
    signal,
  }: { fromSeq?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunEventPayload> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      settle();
    };
    // An AbortError rather than a custom sentinel: callers already treat it as
    // "the user stopped", and it is what every other abortable call here throws.
    const onAbort = () =>
      finish(() =>
        reject(new DOMException("stopped watching the run", "AbortError")),
      );
    // Already stopped: reject directly, because `finish` reads bindings that
    // the lines below have not created yet.
    if (signal?.aborted) {
      reject(new DOMException("stopped watching the run", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = subscribeStudioEvents(token, {
      fromSeq,
      onEvent: (event) => {
        if (event.subject_type !== "task_run" || event.subject_id !== runId) return;
        const payload = event.payload as RunEventPayload;
        if (TERMINAL.has(payload.state)) {
          finish(() => resolve(payload));
          return;
        }
        onProgress(payload);
      },
    });
    const timer = setTimeout(
      () => finish(() => reject(new Error("timed out — still running server-side"))),
      timeoutMs,
    );
  });
}
