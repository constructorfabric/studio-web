# studio-scheduler

The thing that knows what time it is.

## Why it is a gear of its own

It owns schedules and nothing else: on each tick it works out which are due and
enqueues runs into [`../tasks`](../tasks). It executes no work, so a bug in cron
arithmetic cannot stop a repository import — and a deployment that wants
background work without automatic firing simply drops this gear's `database:`
block. The queue keeps working; nothing fires on its own.

## What the platform already had, and why this still exists

Nothing in gears-rust schedules anything: 35 gears, no cron, no timer. The one
place a `Schedule` entity exists is `serverless-runtime`'s design — and that
gear ships no code at all, documents only, and its own thin-host ADR says the
host "runs no scheduler, polling loop, or timer mechanism", delegating timing to
a backend plugin over Temporal, EventBridge or Azure Durable. Adopting it for
cron would mean adopting Temporal.

So the vocabulary is borrowed and the mechanism is not. The expression shape
(`{kind: cron|interval, value}`), the IANA `timezone`, the concurrency policy
(`allow | forbid | replace`) and the missed-schedule policy
(`skip | catch_up | backfill`) are spelled exactly as
`gts.cf.core.sless.schedule.v1~` spells them — so a schedule written today moves
to that gear as data if it ever lands.

## Two properties worth knowing

- **One firer.** A tick runs under a PostgreSQL advisory lock, so a second
  replica does not double-fire (`ticker.rs`).
- **At-least-once firing, exactly-once runs.** The scheduler cannot commit its
  bookkeeping in the same transaction as an enqueue into another gear's
  database, so a crash mid-firing re-fires. Every firing carries the idempotency
  key `<schedule_id>:<scheduled_for>`, which makes the repeat the *same* run
  (`service.rs`).

## REST

| Method + path | Does |
|---|---|
| `GET`/`POST /schedules` | list and create |
| `GET`/`PATCH`/`DELETE /schedules/{id}` | one schedule |
| `POST /schedules/{id}/run-now` | fire it without waiting for the clock |

## In the assembly

- Gear `studio-scheduler`, capabilities `[rest, db, stateful]`, deps
  `account_management`.
- Config section `gears.studio-scheduler`; no `database:` block means no
  automatic firing.
- The session reaper ([`../studio_session`](../studio_session)) is one of its
  schedules.
