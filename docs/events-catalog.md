# The studio-events vocabulary

Everything published on the assembly's one push channel
(`GET /cf/studio-events/v1/stream`, ADR-0013). This file is the registry rule E3
refers to: a new `subject_type` or a new `kind` lands here in the PR that starts
publishing it, and a consumer may rely on nothing that is not on this page.

The frame is always
`{ seq, at_ms, kind, subject_type, subject_id, source, payload }` — `seq` and
`at_ms` are assigned by the channel, the rest by the producer. How to consume it
is [`studio-frontend/docs/studio-events.md`](../studio-frontend/docs/studio-events.md).

## Subject types

| `subject_type` | `subject_id` is | Read it back with |
| --- | --- | --- |
| `task_run` | the run id | `GET /studio-tasks/v1/runs/{id}` |
| `workspace` | the workspace (root project) id | `GET /studio-theia/v1/workspaces/{id}/status` |

## `task_run` — background work

Published by `studio-tasks` (`source: "studio-tasks"`) from one place: the
dispatcher's `record` and its progress sink. Every background job in the
assembly — imports, catalogue syncs, notification deliveries, scheduled runs —
is announced here without the gear that owns the work knowing the channel
exists.

| `kind` | When | Payload |
| --- | --- | --- |
| `task.queued` | a run is enqueued | `StudioRunEvent` |
| `task.running` | the worker picked it up | `StudioRunEvent` |
| `task.progress` | the handler reported a phase | `StudioRunEvent` with `phase`, sometimes `result` |
| `task.succeeded` | terminal, with `summary` and `result` | `StudioRunEvent` |
| `task.failed` | terminal, with `error` | `StudioRunEvent` |
| `task.cancelled` | terminal, cancelled by a caller | `StudioRunEvent` |

`StudioRunEvent` carries the fields `GET /studio-tasks/v1/runs/{id}` answers
with (rule E4), so a view can be fed by either without a second mapping:
`run_id`, `task_type`, `state`, `phase`, `summary`, `error`, `result`,
`attempts`.

**A field that is absent means unchanged, not cleared.** Each transition puts
only what it actually set into the payload, so a consumer merges into the run it
is holding rather than replacing it. Sending `null` for the fields a patch left
alone would tell a client the run had just lost its summary.

`task.progress` is as frequent as a handler reports — several a second for a
busy import. A consumer that reloads on it coalesces (300 ms is what the
prototype's run list uses).

## `workspace` — the IDE bridge

Published by `studio-theia` (`source: "studio-theia"`) when a session's Theia
container forwards an event. The bridge's own vocabulary stops at this
boundary — ADR-0013 §3 exists so that one producer's protocol does not become
the portal's contract.

| `kind` | Meaning |
| --- | --- |
| `theia.operation` | an operation the IDE ran |
| `theia.audit` | an audit record from the session |
| `theia.repositories-changed` | the workspace's repository set changed |
| `theia.workspace-snapshot-changed` | the workspace snapshot changed |
| `theia.workspace-activity` | activity heartbeat |

Payload is `{ workspace_id, session_id, sequence, event }`, where `event` is the
forwarded callback argument verbatim.

**These kinds break rule E2** — hyphens rather than snake_case, and a noun
(`theia.operation`) rather than a past-tense verb. They are pass-through from
the bridge and are the first thing to normalise when the Theia contract is
revisited; they are listed here so nobody copies the shape.

## Adding a kind

1. Publish it — a `StudioEvent::new(...)` call, not an endpoint (rule E1).
2. Add the row here, and the `subject_type` row above if it is new.
3. Give the payload a named DTO on the backend and an exported interface on the
   frontend; if the event is about a resource, its fields are that resource's
   `GET` fields (rule E4).
4. If a screen is to react to it, say so in that resource's page under
   `studio-frontend/docs/`.

A consumer must tolerate a `kind` it does not know: filter by `subject_type`
first, then by `kind`, and ignore the rest.
