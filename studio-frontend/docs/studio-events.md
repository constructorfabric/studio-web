# Studio events — how a screen is told instead of asking

The backend publishes one SSE stream per tenant, and every background run in
the assembly announces its transitions on it. A screen that needs to know when
work finished subscribes to that stream instead of re-reading
`GET /studio-tasks/v1/runs/{id}` on a timer.

The channel and its constraints are ADR-0026
([`docs/adr/0026-studio-events-push-channel.md`](../../docs/adr/0026-studio-events-push-channel.md)).
This page is the client half: what to call, and what bites.

- [The rule](#the-rule)
- [The service](#the-service)
- [Watch every background run](#watch-every-background-run)
- [Follow one run you just started](#follow-one-run-you-just-started)
- [Refresh a list without polling](#refresh-a-list-without-polling)
- [Fill a gap after the fact](#fill-a-gap-after-the-fact)
- [What the transport does for you](#what-the-transport-does-for-you)
- [Traps](#traps)

## The rule

**An operation that can outlast a request is a run.** Not a poll loop in a
screen, not a promise the tab has to stay open for: the gear that owns the work
records a `studio-tasks` run, and the portal follows it here. That is why one
vocabulary — `subject_type: task_run` — covers everything the assembly does in
the background, whichever gear is doing it:

| Task type | The long thing it owns |
|---|---|
| `artifact.ingest` | pulling a repository into the artifact graph |
| `connector.graph_sync` | a repository import |
| `session.await_ready` | waiting for a Theia session to answer |
| `spec_quality.analyze` | one detector analysis, to its verdict |
| `spec_quality.analyze_batch` | one detector over a document set |
| `notify.deliver` | a notification |
| `catalog.sync` | a component-catalogue sync |
| `session.reap`, `tasks.retention_sweep` | scheduled housekeeping |

The list grows; the vocabulary does not. If you are about to write a timer that
asks the backend whether something finished, the thing to add is a run, not a
poll.

**A run's `result` is broadcast whole.** `summary` and `last_error` are cut to
500 characters, but `result` is not capped, and every subscriber in the tenant
receives it. A handler with a large answer stores a pointer — that is why a
`spec_quality.analyze_batch` result names each document's upstream task instead
of carrying the verdicts, and why `session.await_ready` names a session rather
than its URL, which embeds a one-shot token. Read a result expecting a
reference, not always the payload.

## The service

`StudioEventsApiService` and `StudioTasksApiService` live in
`@constructor-studio/mfe-shared`. Every realm that uses them registers its own:
the shell in [`src-app/app/main.tsx`](../src-app/app/main.tsx), an MFE in its
`init.ts` (`projects-mfe` does). Module realms are isolated, so an MFE's stream
is its own connection — open one only while there is something to follow. Get
it the same way as any other service:

```tsx
import { apiRegistry } from '@gears-frontx/react';
import { StudioEventsApiService } from '@constructor-studio/mfe-shared';

const events = apiRegistry.getService(StudioEventsApiService);
```

It exposes four things:

| Member | What it is |
|---|---|
| `events` | the live stream, from now on |
| `streamFrom(cursor)` | the live stream, replaying everything after `cursor` first |
| `cursor` | the tenant's current high-water mark, one event at most |
| `since({ afterSeq, limit? })` | the retained window after a cursor, oldest first |

Every frame is a `StudioEvent`:

```ts
interface StudioEvent<P = unknown> {
  seq: number;          // monotonic per tenant — the resume point
  at_ms: number;
  kind: string;         // 'task.queued' | 'task.running' | 'task.progress' | 'task.succeeded' | …
  subject_type: string; // 'task_run', 'workspace', …
  subject_id: string;   // for a background run, its run id
  source: string;       // the gear that published it
  payload: P;
}
```

For `task.*` events the payload is a `StudioRunEvent`, carrying the same fields
`GET /studio-tasks/v1/runs/{id}` answers with — so one view can be fed by
either without a second mapping.

## Watch every background run

`useApiStream` connects on mount and disconnects on unmount. In the default
`'latest'` mode `data` is the most recent event:

```tsx
import { useApiStream, apiRegistry } from '@gears-frontx/react';
import { StudioEventsApiService, type StudioEvent, type StudioRunEvent } from '@constructor-studio/mfe-shared';

function RunTicker() {
  const service = apiRegistry.getService(StudioEventsApiService);
  const { data, status, error } = useApiStream(service.events);

  if (status === 'connecting') return <Spinner />;
  if (status === 'error') return <StreamError error={error} />;

  const event = data as StudioEvent<StudioRunEvent> | undefined;
  if (event?.subject_type !== 'task_run') return null;

  // `subject_id` is the run id and is always there; `task_type` is not — a
  // progress frame carries only what that transition set.
  return <span>{event.subject_id.slice(0, 8)}: {event.payload.state}</span>;
}
```

The stream carries everything the assembly publishes, not only runs — always
narrow by `subject_type` (and `kind`, if you care about one transition) before
reading `payload`.

## Follow one run you just started

A task can finish before your connection is even open, and a stream opened
"from now on" will never mention it. Read the cursor **before** starting the
job and resume from it:

```tsx
function useRunProgress() {
  const service = apiRegistry.getService(StudioEventsApiService);
  const [from, setFrom] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  async function start() {
    // Read the mark first: everything the job publishes is then replayed,
    // however fast it finishes.
    const { latest_seq } = await service.cursor.fetch();
    setFrom(latest_seq);
    const { run_id } = await startTheJob();
    setRunId(run_id);
  }

  const { data } = useApiStream(
    from === null ? service.events : service.streamFrom(from),
    { enabled: from !== null },
  );

  const event = data as StudioEvent<StudioRunEvent> | undefined;
  const mine =
    event?.subject_type === 'task_run' && event.subject_id === runId
      ? event.payload
      : undefined;

  return { start, state: mine?.state, phase: mine?.phase };
}
```

`streamFrom` builds a distinct descriptor key per cursor, so changing the
starting point opens a fresh connection rather than reusing the old one.

A cursor of `0` is a real starting point — sequences start at 1 — so a tenant
whose first events are the job's own gets them replayed too. And `streamFrom`
does not deliver past a hole: a catch-up it cannot make, or a stream refused
with 401/403, ends it, and `onComplete` fires. A catch-up whose first event is
not the one right after the cursor counts as one it cannot make: the server
keeps a tenant's last 500 events by default, and what was pruned is gone.
`seq` is not dense (a failed write skips a number), so a hole right at the
cursor ends the stream too — rarely, and the answer is the same. For
`streamFrom`, then, `onComplete` means "cut" as well as "finished"; answer it
by reading the job, and keep reading until it ends. `events`, opened without
a cursor, keeps running through a failed catch-up and logs the gap it lost.

## Follow runs from an effect

Outside React — an effect that starts runs and outlives the component that
asked — use `createRunFollower` from `@constructor-studio/mfe-shared`. It is
what the editor's session and the project import both use: one stream for
every run it follows, opened at the cursor you read before starting them; a
run that joins an open stream is read once with `GET /runs/{id}`; once the
stream ends or cannot open, or that one read fails, the runs are read every two
seconds until each settles. The stream closes when nothing is left to follow.

```ts
const cursor = await readCursor(events, 'my-effect'); // null: the runs are read on the interval
const follower = createRunFollower({
  events,
  tasks,
  onRun: (update) => {/* state, and whatever phase/summary/error/result it said */},
  onLost: (runId, error) => {/* 404, or five failed reads in a row */},
});
const { run_id } = await startTheJob();
follower.follow([run_id], cursor);
```

A field missing from an update did not change; a read fills them all.

## Refresh a list without polling

For a list, the event is a signal to reload, not the data itself. A busy run
reports progress several times a second, so coalesce:

```tsx
function useRunListRefresh(load: () => Promise<void>) {
  const service = apiRegistry.getService(StudioEventsApiService);
  const { data } = useApiStream(service.events);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const event = data as StudioEvent | undefined;
    if (event?.subject_type !== 'task_run') return;
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void load().catch(() => {
        /* a failed refresh keeps the last good list */
      });
    }, 300);
    return () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [data, load]);
}
```

The prototype's `studio-frontend-prototype/src/tasks.tsx` is the same shape
against a plain `EventSource`, and worth reading as a worked example.

## Fill a gap after the fact

`since` returns the retained window by cursor. A `latest_seq` above the last
returned `seq` means the caller fell out of that window and lost events — the
honest recovery is a full reload, not a longer replay:

```tsx
const { data } = useApiQuery(service.since({ afterSeq: lastSeen, limit: 200 }));

const lost =
  data && data.events.length > 0
    ? data.latest_seq > data.events[data.events.length - 1].seq
    : false;
```

## What the transport does for you

The shell replaces the framework's SSE transport with
[`SseAuthPlugin`](../src/api/plugins/SseAuthPlugin.ts) +
[`FetchEventSource`](../src/api/sse/FetchEventSource.ts), wired inside
`StudioEventsApiService`'s constructor. You get three things the stock
`SseProtocol` cannot give:

- **the bearer token on the connection.** The native `EventSource` can carry no
  `Authorization` header and the gateway takes no token from the query string,
  so without this an authenticated stream is simply unreachable.
- **reconnect.** `SseProtocolConfig.reconnectAttempts` is dead config; the
  retry loop lives in the transport.
- **gap-free resume.** On every reconnect the plugin replays what was published
  while the connection was down, in order, before letting a newer frame
  through.

## Traps

**Register an SSE plugin on the protocol instance.**
`BaseApiService.registerPlugin(protocol, plugin)` only records a plugin for the
framework's mock-mode toggle — it never runs. The call that works is
`sseProtocol.plugins.add(plugin)`. The TSDoc on `SseAuthPlugin` still says
`registerPlugin`; the constructor of `StudioEventsApiService` is the correct
reference.

**The server sends unnamed frames on purpose.** The framework binds only
`onmessage`, so a named event type never reaches a consumer — the kind lives
inside the JSON, in `kind`. Do not reach for
`addEventListener('task.succeeded', …)`.

**An absent field means "unchanged", not "cleared".** Events carry only what a
transition changed: `phase` rides on `task.progress`, `summary` / `error` on
the terminal ones, `result` on either — a progress report that carried counts
announces them, one that did not leaves the run's recorded result alone. Merge
into what you already hold; treating `undefined` as `null` tells a view a run
lost its counts.

**A deployment can run without the channel.** The publisher is resolved lazily,
and an absent one publishes nothing and breaks nothing — which means a screen
that only listens sits silent there. Keep a slow reload as a floor if the view
must be right without it; that is what the surviving `setInterval` in the
prototype's `tasks.tsx` is for.

**Do not confuse it with the `StudioEvents` inside `@gears-frontx/studio`.**
That `StudioEvents` is the canvas package's own event names and has nothing to
do with this channel.

**Retries produce repeats.** `studio-tasks` retries up to five times with a
requeue between attempts, so a failing run emits running/queued pairs before
its terminal state. Drive the view from `state`, not from a count of events.
