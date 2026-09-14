/**
 * FetchEventSource - an `EventSourceLike` backed by `fetch` + `ReadableStream`
 *
 * The native `EventSource` cannot carry an `Authorization` header, and the
 * gateway accepts no token from the query string, so every authenticated SSE
 * endpoint is out of its reach. This implements the same interface over
 * `fetch`, which can, and adds the two things the frontx SSE protocol does not
 * do for us:
 *
 * * **Reconnect.** `SseProtocol.attachHandlers` treats `onerror` as fatal and
 *   disconnects, which also defeats the native reconnect. So reconnection
 *   lives here, invisible to the protocol: a dropped connection is retried
 *   with backoff, and `onerror` is fired only when the session is over (401 /
 *   403) and retrying would just hammer the gateway.
 * * **Exactly-once, ordered redelivery.** With a `resume` policy, the gap
 *   opened by a disconnect is replayed from the server's catch-up endpoint,
 *   live frames are held until that replay has been delivered, and the overlap
 *   between the two is dropped by cursor. A consumer — `useApiStream`, an MFE —
 *   sees one ordered sequence and nothing about any of this.
 *
 * Only unnamed frames reach `onmessage`, which is what the protocol binds; a
 * named frame is dispatched to its `addEventListener` type (that is how the
 * protocol's `done` completion signal arrives).
 *
 * SDK Layer: L1 (Zero @gears-frontx dependencies)
 */

import type { EventSourceLike } from '@gears-frontx/api';

/** `EventSource.readyState` values, same numbering as the native one. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** Reconnect backoff in ms; the last value repeats. */
const BACKOFF = [500, 1_000, 2_000, 5_000, 10_000] as const;

/**
 * How to resume without gaps or duplicates after a disconnect.
 *
 * Supplying this is what turns "a stream that reconnects" into "a stream that
 * cannot lose an event": the cursor of the last delivered event is the resume
 * point, and everything published while the connection was down is fetched and
 * delivered before any newer live frame.
 */
export interface FetchEventSourceResume {
  /** This event's cursor, from its parsed payload. `undefined` = not cursored. */
  cursorOf: (event: unknown) => number | undefined;
  /** Everything published after `cursor`, oldest first. */
  gap: (cursor: number) => Promise<readonly unknown[]>;
  /**
   * Cursor to start from on the FIRST connect. Read it before triggering
   * whatever you are about to watch — a job can finish before the stream is
   * even open, and this is what replays those events.
   */
  from?: number;
}

export interface FetchEventSourceOptions {
  /**
   * Resolved before every (re)connect, so a refreshed token is picked up
   * without reopening anything from outside. `null` = send no header.
   */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Extra headers, e.g. whatever the plugin chain put on the context. */
  headers?: Readonly<Record<string, string>>;
  /** Send cookies (a cookie session rather than a bearer one). */
  withCredentials?: boolean;
  /** Gap-free resume policy. Without it a reconnect simply loses the gap. */
  resume?: FetchEventSourceResume;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class FetchEventSource implements EventSourceLike {
  readyState: number = CONNECTING;

  onopen: ((this: EventSource, ev: Event) => void) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => void) | null = null;
  onerror: ((this: EventSource, ev: Event | ErrorEvent) => void) | null = null;

  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private readonly abort = new AbortController();
  private readonly options: FetchEventSourceOptions;
  private readonly url: string;
  private readonly doFetch: typeof fetch;

  /** Highest cursor delivered. Resume point, and the replay deduplicator. */
  private cursor: number;
  /** Live frames parked while a gap replay is in flight; `null` = deliver now. */
  private held: MessageEvent[] | null = null;
  private attempt = 0;

  constructor(url: string, options: FetchEventSourceOptions = {}) {
    this.url = url;
    this.options = options;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.cursor = options.resume?.from ?? 0;
    // Yield first, like the native EventSource: `new` must return before any
    // event fires, or handlers assigned on the next line would miss `open`.
    void Promise.resolve().then(() => this.run());
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.abort.abort();
  }

  /** Connect, read, reconnect — until `close()` or a fatal status. */
  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.connectOnce();
      } catch (error) {
        if (this.abort.signal.aborted) break;
        if (error instanceof FatalStreamError) {
          this.readyState = CLOSED;
          this.dispatch('error', new Event('error'));
          return;
        }
        // Anything else is a dropped connection: retry, quietly. Surfacing it
        // as `onerror` would make the protocol tear the connection down.
      }
      if (this.abort.signal.aborted) break;
      this.readyState = CONNECTING;
      const wait = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
      this.attempt += 1;
      // Jitter: tabs dropped by one proxy recycle must not all come back at
      // the same instant.
      await sleep(wait + Math.random() * 250, this.abort.signal);
    }
  }

  /** One connection, from request to end of body. */
  private async connectOnce(): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(this.options.headers ?? {}),
    };
    const token = await this.options.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await this.doFetch(this.url, {
      headers,
      signal: this.abort.signal,
      credentials: this.options.withCredentials ? 'include' : 'same-origin',
    });

    if (response.status === 401 || response.status === 403) {
      throw new FatalStreamError(response.status);
    }
    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: HTTP ${response.status}`);
    }

    this.attempt = 0;
    this.readyState = OPEN;
    this.dispatch('open', new Event('open'));

    // Replay what was missed before any newer frame is handed over.
    const replayed = this.replayGap();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        this.handleFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
      }
    }
    await replayed;
    // A stream that ends on its own is a disconnect like any other: fall out
    // of here and let `run()` reconnect.
  }

  /**
   * Fetch and deliver everything published after `cursor`, holding live frames
   * until it is done. No resume policy, or nothing seen yet on a first
   * connect: nothing to replay.
   */
  private async replayGap(): Promise<void> {
    const resume = this.options.resume;
    if (!resume || this.cursor <= 0) return;

    this.held = [];
    try {
      const missed = await resume.gap(this.cursor);
      for (const event of missed) this.deliverParsed(event);
    } catch {
      // The live stream is up; a failed catch-up costs the gap, not the stream.
    } finally {
      const queued = this.held ?? [];
      this.held = null;
      for (const event of queued) this.deliverMessage(event);
    }
  }

  /** One SSE frame. Comments (`: keepalive`) and empty frames carry nothing. */
  private handleFrame(frame: string): void {
    let eventName = '';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) return;

    const payload = data.join('\n');
    if (eventName && eventName !== 'message') {
      // Named frames are not what the protocol reads on `onmessage`; they are
      // its control channel (`done`). Pass them to listeners only.
      this.dispatch(eventName, new MessageEvent(eventName, { data: payload }));
      return;
    }

    const message = new MessageEvent('message', { data: payload });
    if (this.held) this.held.push(message);
    else this.deliverMessage(message);
  }

  /** Deliver a live frame, minding the cursor when there is one. */
  private deliverMessage(message: MessageEvent): void {
    const resume = this.options.resume;
    if (resume) {
      const cursor = cursorOfRaw(resume, message.data as string);
      if (cursor !== undefined) {
        if (cursor <= this.cursor) return; // already delivered — replay overlap
        this.cursor = cursor;
      }
    }
    this.onmessage?.call(this as unknown as EventSource, message);
    this.dispatch('message', message);
  }

  /** Deliver one replayed event (an already-parsed value, not a frame). */
  private deliverParsed(event: unknown): void {
    const resume = this.options.resume;
    const cursor = resume?.cursorOf(event);
    if (cursor !== undefined) {
      if (cursor <= this.cursor) return;
      this.cursor = cursor;
    }
    const message = new MessageEvent('message', { data: JSON.stringify(event) });
    this.onmessage?.call(this as unknown as EventSource, message);
    this.dispatch('message', message);
  }

  private dispatch(type: string, event: Event | MessageEvent): void {
    this.listeners.get(type)?.forEach((listener) => {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    });
    if (type === 'open') this.onopen?.call(this as unknown as EventSource, event);
    else if (type === 'error') this.onerror?.call(this as unknown as EventSource, event);
  }
}

/** The session is over: reconnecting would only hammer the gateway. */
class FatalStreamError extends Error {
  constructor(readonly status: number) {
    super(`SSE stream rejected: HTTP ${status}`);
  }
}

/** The cursor of a raw `data:` payload, or `undefined` if it has none. */
function cursorOfRaw(resume: FetchEventSourceResume, raw: string): number | undefined {
  try {
    return resume.cursorOf(JSON.parse(raw));
  } catch {
    return undefined; // not JSON: no cursor, deliver as-is
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
