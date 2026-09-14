/**
 * Studio Events Domain - API Service
 *
 * The backend's push channel: one stream per tenant carrying everything the
 * assembly publishes — every `studio-tasks` run transition first among them.
 * Replaces polling `GET /studio-tasks/v1/runs/{id}` every second.
 *
 * Two surfaces, and they work together:
 *   * `events` — the live SSE stream, consumed with `useApiStream`;
 *   * `since` / `cursor` — the same events by cursor, which is how a gap is
 *     filled and how a job started before the stream opened is still seen.
 */

import {
  BaseApiService,
  RestEndpointProtocol,
  RestProtocol,
  SseProtocol,
  SseStreamProtocol,
} from '@gears-frontx/react';
// The shell's own transport, imported by path rather than by package name:
// this is the same package, and a relative import keeps the app runnable and
// testable without the `dist-lib` build step in between.
import { SseAuthPlugin } from '../../../src/api/plugins/SseAuthPlugin';

export const STUDIO_EVENTS_API_BASE_URL = '/cf/studio-events/v1';

/** One event as it arrives, live or replayed. */
export interface StudioEvent<P = unknown> {
  /** Monotonic per-tenant cursor: the resume point after a disconnect. */
  seq: number;
  /** Milliseconds since the Unix epoch. */
  at_ms: number;
  /** `task.queued` | `task.running` | `task.progress` | `task.succeeded` | `task.failed` | `task.cancelled` | … */
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
export interface StudioRunEvent {
  run_id: string;
  /** `<gear>.<verb>` — `artifact.ingest`, `connector.graph_sync`, … */
  task_type?: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** The phase the handler last reported. */
  phase?: string | null;
  /** One line about what it did, once it succeeded. */
  summary?: string | null;
  /** Why it stopped, once it failed. */
  error?: string | null;
  /** The handler's structured result — counts, ids, whatever it reports. */
  result?: Record<string, unknown> | null;
  attempts?: number | null;
}

/** A page of replayed events, oldest first. */
export interface StudioEventPage {
  events: StudioEvent[];
  /**
   * The tenant's high-water mark. Above the last returned `seq` means the
   * caller fell out of the server's retained window and lost events.
   */
  latest_seq: number;
}

export class StudioEventsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    const sseProtocol = new SseProtocol();
    const sseStreams = new SseStreamProtocol(sseProtocol);

    super(
      { baseURL: STUDIO_EVENTS_API_BASE_URL },
      restProtocol,
      restEndpoints,
      sseProtocol,
      sseStreams,
    );

    // Authenticated SSE with gap-free resume. The plugin replaces the native
    // EventSource (which could not send the bearer at all) and, on every
    // reconnect, replays what was published while the connection was down
    // before letting any newer frame through.
    //
    // Added to the PROTOCOL instance, not through `registerPlugin`: the latter
    // only records a plugin for the framework's mock-mode toggle to activate,
    // and this one has to be on for every connection.
    sseProtocol.plugins.add(
      new SseAuthPlugin({
        resume: {
          cursorOf: (event) => (event as StudioEvent | null)?.seq,
          gap: async (cursor) => {
            const page = await restProtocol.get<StudioEventPage>(
              `/events?after_seq=${cursor}`,
            );
            return page.events;
          },
        },
      }),
    );
  }

  /**
   * The live stream, from now on.
   *
   * For a job you are about to start, use {@link streamFrom} with a cursor
   * read beforehand — a task can finish before this connection is even open.
   */
  readonly events = this.protocol(SseStreamProtocol).stream<StudioEvent>('/stream');

  /** The retained window after `afterSeq`, oldest first. */
  readonly since = this.protocol(RestEndpointProtocol).queryWith<
    StudioEventPage,
    { afterSeq: number; limit?: number }
  >(({ afterSeq, limit }) => {
    const query = new URLSearchParams({ after_seq: String(afterSeq) });
    if (limit !== undefined) query.set('limit', String(limit));
    return `/events?${query.toString()}`;
  });

  /**
   * The tenant's current cursor, cheaply (one event at most).
   *
   * Read it BEFORE starting a background job and pass the result to
   * {@link streamFrom}: everything the job publishes is then replayed, however
   * fast it finishes.
   */
  readonly cursor = this.protocol(RestEndpointProtocol).query<StudioEventPage>(
    '/events?after_seq=0&limit=1',
  );

  /**
   * The live stream, resuming at `cursor` — anything published after it is
   * replayed first, in order, without duplicates.
   *
   * A distinct descriptor key per cursor, so `useApiStream` opens a fresh
   * connection when the starting point changes rather than reusing the old one.
   */
  streamFrom(cursor: number) {
    return this.protocol(SseStreamProtocol).stream<StudioEvent>(
      `/stream?resume_from=${cursor}`,
    );
  }
}
