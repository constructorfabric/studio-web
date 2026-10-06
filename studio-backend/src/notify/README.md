# studio-notify

Notifications that survive the thing that was going to send them.

The design — why a notification is queued rather than sent, why the run in
`studio-tasks` is the only record, what the accept path refuses and why there,
and how a failure is judged worth another attempt — is
[`docs/design/studio-notify.md`](../../../docs/design/studio-notify.md). Worked
examples are [`docs/queued-notifications.md`](../../docs/queued-notifications.md).
This README is what you need to work in the directory.

## REST

| Method + path | Does |
|---|---|
| `POST /studio-notify/v1/messages` | validate, queue, and return the run id to follow |

What happened to it is `GET /studio-tasks/v1/runs/{id}`; what needs attention
is `GET /studio-tasks/v1/runs?task_type=notify.deliver&state=failed`.

## In the assembly

- Gear `studio-notify`, capabilities `[rest]`, deps `account_management`.
- Config section `gears.studio-notify`; no database.
- Registers the task type `notify.deliver` (`max_attempts` 8) with
  [`../tasks`](../tasks). Renaming it orphans the notifications in flight.
- The `workspace_id` destination needs the `theia-bridge` feature and
  `studio-session.theia_control_enabled`.

## Where things are

- `service.rs` — the accept path, which resolves the connection with the
  *caller's* context and refuses up front what a background worker could not
  do later.
- `handler.rs` — the `notify.deliver` task and `classify`, the transient or
  permanent verdict. A new driver error shape that should not be retried goes
  into its `PERMANENT` list, with a test.
