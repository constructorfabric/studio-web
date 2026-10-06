# studio-scheduler

The thing that knows what time it is.

The design — why it only enqueues, why schedules are platform-level and UTC
only, how a tick fires once across replicas and why a re-fire is harmless, the
two policies, the routes and the table — is
[`docs/design/studio-scheduler.md`](../../../docs/design/studio-scheduler.md).
The operator's view of runs and schedules together is
[`docs/background-work.md`](../../docs/background-work.md). This README is what
you need to work in the directory.

## REST

| Method + path | Does |
|---|---|
| `GET`/`POST /schedules` | list and create |
| `GET`/`PATCH`/`DELETE /schedules/{id}` | one schedule |
| `POST /schedules/{id}/run-now` | fire it without waiting for the clock |

## In the assembly

- Gear `studio-scheduler`, capabilities `[rest, db, stateful]`, deps
  `account_management`.
- Config section `gears.studio-scheduler`: `owner_tenant_id` (must equal
  `account-management.bootstrap.root_id`), `tick_seconds` (60), `enabled`
  (true). No `database:` block means no automatic firing and a 503 from every
  route.
- The platform schedules — the tasks retention sweep and the session reaper
  ([`../studio_session`](../studio_session)) — are registered at `start`. A
  gear that contributes one adds a `platform_schedules()` and is chained in
  `register_platform_schedules`.
- Another gear keeps a schedule of its own through `port::Schedules`
  (`studio-reports` does).

## Where things are

- `cron.rs` — the 5-field evaluator and ISO-8601 intervals, written here rather
  than taken from a crate; the awkward cases (the day-of-month/day-of-week OR
  rule, February, a `*/n` step rolling over) are pinned by its tests.
- `policy.rs` — which instants a late tick enqueues.
- `ticker.rs` — the advisory lock and the loop.
