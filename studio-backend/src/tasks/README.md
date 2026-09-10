# studio-tasks

Background work that survives the process running it.

## Why it exists

Three gears in this assembly had already invented the same thing badly.
`connectors::graph_sync_tasks`, `artifact_ingest::tasks` and
`components_catalog::tasks` each kept a `Mutex<HashMap<String, TaskRecord>>`,
each defined its own `TaskStatus`, each capped its own retention, and each
served its own `GET …/tasks/{id}`. All three lost everything on restart: a poll
arriving a second after a redeploy answered "no such task" about work that had
really run. None could be cancelled and none could be retried.

This gear is one durable version of that: a run is a row, execution is a queue
entry, and the two are written **in one transaction**.

## What it is not

It is not a scheduler — nothing here knows about time.
[`../scheduler`](../scheduler) owns schedules and only enqueues into this gear.
Keeping them apart means the scheduler can be switched off without taking
background work with it, and a bug in cron arithmetic cannot stop a repository
import.

It is also not a workflow engine: no steps, no branching, no compensation. The
platform's `serverless-runtime` design covers that ground (and delegates it to
Temporal-class backends); this gear runs one function to completion and records
what happened.

## The queue is toolkit-db's

Same substrate as [`../notify`](../notify): the transactional outbox, with a
leased per-partition processor, exponential backoff on retry and a dead-letter
table. This gear supplies a dispatcher, a table prefix and a partition count.
`docs/queued-notifications.md` explains why that is PostgreSQL and not Redis —
the deciding argument being that the enqueue has to be part of the transaction
that caused it.

## Two things to know about the worker

- **Who it is.** A run executes with no request behind it — possibly minutes
  after the one that asked, possibly after a restart, and for a scheduled run
  there was never a request at all. So the worker acts as `studio-tasks` itself,
  scoped to the run's tenant. Whatever authorization mattered belongs at
  **enqueue** time, where there is still a request to answer with a 400.
- **Cancellation is cooperative.** `POST /runs/{id}/cancel` sets a flag. A
  queued run is refused before it starts; a running one stops where its handler
  looks at `TaskContext::cancelled`, which the dispatcher flips when it sees the
  flag.

## REST

| Method + path | Does |
|---|---|
| `GET /runs` | the history, filterable by `task_type` and `state` |
| `GET /runs/{id}` | one run: state, attempts, phase, summary or last error |
| `POST /runs/{id}/cancel` | ask it to stop |
| `POST /runs/{id}/retry` | run a failed or cancelled one again |
| `GET /task-types` | which handlers this deployment has registered |

## In the assembly

- Gear `studio-tasks`, capabilities `[rest, db, stateful]`, deps
  `account_management`.
- Config section `gears.studio-tasks`.
- Handlers are registered by the gears that own the work — `notify.deliver`,
  `artifact.ingest`, `session.reap` and the catalogue/graph syncs.
