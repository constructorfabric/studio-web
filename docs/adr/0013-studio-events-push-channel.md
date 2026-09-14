# ADR-0013: One push channel to the portal, and it is not anyone's protocol

Status: accepted · 2026-09-11 · Relates to ADR-0010

## Context

Background work in this assembly is durable and centralised: `studio-tasks`
owns a run per job, `studio-scheduler` enqueues into it, and everything from a
repository import to a notification delivery is a row whose state moves
`queued → running → succeeded | failed | cancelled`. What is not centralised is
finding out that it moved. Every consumer polls `GET /studio-tasks/v1/runs/{id}`
— the prototype's repository sync every 1.2 s for up to five minutes, its
Background work view every 4 s while anything is live — which is both wasteful
and slow to react: a run that fails in 300 ms still shows "queued…" until the
next tick.

The platform's answer to this is the `event-broker` gear, and it is not ready.
Its specification is complete — PRD, DESIGN, seven ADRs, an OpenAPI document,
and `features/0004-consumption-transport.md` defining both a
`multipart/mixed` stream and an opt-in `text/event-stream` one — and its SDK is
~21k lines of working producer and consumer code. The gear itself is a
skeleton: every REST handler in `gears/system/event-broker` is
`todo!("lands with #4346")`. Our own `studio-theia` bridge already carries an
`EventBrokerEventSink` written against that SDK which cannot publish anything
for the same reason.

Meanwhile the frontend has the consuming half ready — `useApiStream`,
`StreamDescriptor`, `SseProtocol` — and no stream to consume.

The tempting shortcut is to expose the one event source we already have.
`studio-theia`'s ingress receives `operation`, `audit`,
`repositories-changed`, `workspace-snapshot-changed` and `workspace-activity`
events from a session's Theia container, each with a session id and a
per-session sequence. Publishing *that* as the portal's stream would make one
producer's protocol — a bridge to an IDE container that most deployments do not
even run — the contract every other producer and the whole frontend then has to
live with.

## Decision

### 1. The assembly has exactly one push channel, and it is domain-neutral

A new in-crate gear, `studio-events`, owns it:

* `GET /cf/studio-events/v1/stream` — Server-Sent Events, scoped to the
  caller's tenant from the security context.
* `GET /cf/studio-events/v1/events?after_seq=&limit=` — the same events by
  cursor, oldest first, plus the tenant's high-water mark.

One event is `{ seq, at_ms, kind, subject_type, subject_id, source, payload }`.
A producer states **what happened** (`kind`, dotted and past-tense), **to what**
(`subject_type` + `subject_id`) and **who says so** (`source`); everything
type-specific goes in `payload` untouched. `seq` and `at_ms` are assigned by
the channel, so a producer cannot forge ordering or backdate an event.

Nothing in that shape knows about tasks, repositories or IDE sessions.

### 2. Producers publish through the ClientHub, and may be absent

`studio-events` registers `dyn StudioEventPublisher` in the ClientHub.
`publish` is synchronous and infallible by contract: producers call it from
inside locks and from paths that must not fail, and an event that cannot be
delivered must never fail the operation that produced it. The publisher is
resolved **lazily, per event** — gear init order is not guaranteed — and an
assembly without the channel loses the announcement and nothing else.

The first producer is `studio-tasks` itself, in one place: the dispatcher's
`record` (every state transition) and its progress sink (every phase report).
That covers every background job in the assembly — imports, catalogue syncs,
notification deliveries, scheduled runs — without a single gear that owns work
having to know this channel exists. Events are `task.<state>` and
`task.progress` about a `task_run`, carrying the same fields the run endpoint
answers with, so a view can be fed by either without a second mapping.

### 3. Theia is a producer, not the contract

`studio-theia`'s default sink becomes `StudioEventsSink`: it maps a forwarded
Theia event to `theia.<kind>` about a **workspace**, with session id, sequence
and the raw callback argument inside `payload`. The bridge's vocabulary stops
at that boundary. `EventBrokerEventSink` stays behind its feature flag for when
the broker lands.

### 4. Delivery is at-least-once, and the cursor is how a client recovers

The channel keeps a bounded per-tenant replay window (500 events by default) so
a client that reconnects replays the gap by cursor instead of guessing. A
subscriber reads the cursor **before** starting a job and resumes from it: a
task that finishes in 300 ms is otherwise over before the stream is even open.
`latest_seq` running ahead of the last delivered `seq` is how a client learns
it fell out of the window.

State is per-process and resets on restart, exactly like the task registries
that feed it. Fan-out is an in-process `SseBroadcaster` **per tenant**, so
tenant isolation is structural rather than a filter someone must remember.

### 5. The wire format is dictated by the frontend SDK

Frames are **unnamed** (`data:` only) and the event type lives in the JSON's
`kind`, because `SseProtocol.attachHandlers` binds only `onmessage`, which
never fires for a named frame. The completion signal the protocol does listen
for is an event named `done`.

Authenticated SSE needs a transport of its own: the native `EventSource`
cannot send `Authorization`, and the gateway accepts no token from the query
string. `SseAuthPlugin` short-circuits the protocol's `onConnect` with a
`fetch`-based `EventSourceLike` that also owns reconnect (the protocol treats
`onerror` as fatal) and gap-free resume. None of this is visible to
`useApiStream` or to an MFE.

### 6. This is built to be replaced

When `event-broker` lands, `studio-events` becomes a thin consumer→SSE bridge:
producers publish to the broker instead, and the two endpoints above do not
change. The broker's own `/v1/events:sse` is not exposed to browsers even
then — JOIN, SEEK, re-JOIN and topology frames are an SDK protocol, not a UI
one.

## Consequences

* The portal stops polling for task progress; reaction time goes from ~1.2 s to
  the publish itself.
* A single backend process is assumed for fan-out. `backend.replicas` is 1
  today; more than one requires sticky sessions or the broker, and the replay
  window is per-process either way.
* The retained window is a reconnect patch, not an event store. A client that
  is away longer than 500 events sees `latest_seq` jump and must reload state
  the ordinary way.
* A new kind of announcement is a `publish` call and no new endpoint. Adding an
  *endpoint* per producer is what this ADR exists to prevent.
* Progress announcements are as frequent as a handler reports — several a
  second for a busy import. A consumer that reloads on them should coalesce; the
  prototype's run list does, with a 300 ms window.
* The gateway's global 30 s request timeout does not affect an established
  stream (it is `tower::timeout`, which covers only producing the response).
  Verified on a running stack: the connection stayed open for minutes with
  keep-alives every 15 s.
