# The studio-events vocabulary

Everything published on the assembly's one push channel
(`GET /cf/studio-events/v1/stream`, ADR-0026). This file is the registry rule E3
refers to: a new `subject_type` or a new `kind` lands here in the PR that starts
publishing it, and a consumer may rely on nothing that is not on this page.

The frame is always
`{ seq, at_ms, kind, subject_type, subject_id, source, payload }` — `seq` and
`at_ms` are assigned by the channel, the rest by the producer. How to consume it
is [`studio-frontend/docs/studio-events.md`](../../studio-frontend/docs/studio-events.md).

## Subject types

| `subject_type` | `subject_id` is | Read it back with |
| --- | --- | --- |
| `task_run` | the run id | `GET /studio-tasks/v1/runs/{id}` |
| `workspace` | the workspace (root project) id | `GET /studio-theia/v1/workspaces/{id}/status` |
| `review_request` | the review request id | `GET /studio-documents/v1/review-requests?project_id=` |

## `task_run` — background work

Published by `studio-tasks` (`source: "studio-tasks"`) from one place: the
dispatcher's `record` and its progress sink. Every background job in the
assembly — imports, catalogue syncs, notification deliveries, scheduled runs —
is announced here without the gear that owns the work knowing the channel
exists.

| `kind` | When | Payload fields |
| --- | --- | --- |
| `task.queued` | a run is enqueued, or put back after a failed attempt | `run_id`, `task_type`, `state`, `error` |
| `task.running` | the worker picked it up | `run_id`, `task_type`, `state`, `attempts`, `error` |
| `task.progress` | the handler reported a phase | `run_id`, `state`, `phase`, `result` |
| `task.succeeded` | terminal | `run_id`, `task_type`, `state`, `summary`, `result`, `asked_by_person` |
| `task.failed` | terminal | `run_id`, `task_type`, `state`, `error`, `asked_by_person` |
| `task.cancelled` | terminal, cancelled by a caller | `run_id`, `task_type`, `state`, `asked_by_person` |

The payload is a `StudioRunEvent`: the fields `GET /studio-tasks/v1/runs/{id}`
answers with (rule E4), so a view can be fed by either without a second
mapping. `asked_by_person` is the one addition, on the endings only: whether a
person started the run, which decides whether its ending is news to anyone.

**A field that is absent means unchanged, not cleared.** Each transition puts
only what it actually set into the payload, so a consumer merges into the run it
is holding rather than replacing it. Sending `null` for the fields a patch left
alone would tell a client the run had just lost its summary.

`task.progress` is as frequent as a handler reports — several a second for a
busy import. A consumer that reloads on it coalesces (300 ms is what the
prototype's run list uses).

## `review_request` — reviews of a project's documents

Published by `studio-documents` (`source: "studio-documents"`) when somebody asks
for a review, gives a verdict, or withdraws a request. The tenant is the
caller's, so everybody in the organization who is listening hears it; a client
keeps only what concerns its person (`reviewers`, `requested_by`) and reads
`GET /studio-documents/v1/review-requests` again — the event is a prompt (E5).

| `kind` | When | Payload fields |
| --- | --- | --- |
| `review_request.created` | a review was asked for | the request: `id`, `project_id`, `subject_id`, `title`, `state`, `requested_by`, `reviewers` (person ids), `outstanding`, `due_at` |
| `review_request.decided` | a reviewer gave a verdict | the same, as the request stands after it: `id`, `project_id`, `subject_id`, `title`, `state`, `requested_by`, `reviewers`, `outstanding`, `due_at` |
| `review_request.cancelled` | the person who asked withdrew it | the same: `id`, `project_id`, `subject_id`, `title`, `state`, `requested_by`, `reviewers`, `outstanding`, `due_at` |

## `workspace` — the IDE bridge

Published by `studio-theia` (`source: "studio-theia"`) when a session's Theia
container forwards an event. The bridge's own vocabulary stops at this
boundary — ADR-0026 §3 exists so that one producer's protocol does not become
the portal's contract.

| `kind` | Meaning | Payload fields |
| --- | --- | --- |
| `theia.operation` | an operation the IDE ran | `workspace_id`, `session_id`, `sequence`, `event` |
| `theia.audit` | an audit record from the session | `workspace_id`, `session_id`, `sequence`, `event` |
| `theia.repositories-changed` | the workspace's repository set changed | `workspace_id`, `session_id`, `sequence`, `event` |
| `theia.workspace-snapshot-changed` | the workspace snapshot changed | `workspace_id`, `session_id`, `sequence`, `event` |
| `theia.workspace-activity` | activity heartbeat | `workspace_id`, `session_id`, `sequence`, `event` |

`event` is the forwarded callback argument verbatim; `sequence` is `null` for
the kinds the bridge does not order. A kind the bridge forwards that is not in
this table is not republished (`studio_theia::sink::REPUBLISHED_KINDS`).

**These kinds break rule E2** — hyphens rather than snake_case, and a noun
(`theia.operation`) rather than a past-tense verb. They are pass-through from
the bridge and are the first thing to normalise when the Theia contract is
revisited; they are listed here so nobody copies the shape.

## This page is checked

`cargo test` reads this page, so its shape is part of it: a section about a
subject names its `subject_type` in backticks in its `## ` heading, and every
table whose first column is `kind` has a `Payload fields` column with the field
names in backticks. A section's line that starts `Published by` names the gear
that publishes its kinds, in backticks: `GET /studio-events/v1/catalog` serves
the page as the backend was built with it, and the Architecture page lists each
gear's kinds from it.

- **Against the producers.** Each producer's tests compare the kinds it can
  publish with the rows here for its prefix (`task.`, `review_request.`,
  `theia.`): a kind cannot ship undocumented, and a documented kind cannot
  quietly stop being sent.
- **Against itself, over time** (rule G4 in
  [`api-conventions.md`](../../docs/api-conventions.md#g-versioning)). Every subject type,
  kind and payload field listed here is recorded as accepted in
  `studio-backend/docs/api-contract-accepted.txt`. Adding one is accepted by
  regenerating that file; removing or renaming one, or moving a kind to another
  subject type, is a break that fails until it is recorded, with a reason, in
  `studio-backend/docs/api-contract-breaks.txt`. A rename is therefore done as
  an addition first: publish both kinds, then retire the old one with a
  recorded break once no consumer reads it.

## Adding a kind

1. Publish it — a `StudioEvent::new(...)` call, not an endpoint (rule E1).
2. Add the row here, and the `subject_type` row above if it is new, then run
   `cargo run --quiet -- api-contract --accept` in `studio-backend/`.
3. Give the payload a named DTO on the backend and an exported interface on the
   frontend; if the event is about a resource, its fields are that resource's
   `GET` fields (rule E4).
4. If a screen is to react to it, say so in that resource's page under
   `studio-frontend/docs/`.

A consumer must tolerate a `kind` it does not know: filter by `subject_type`
first, then by `kind`, and ignore the rest.
