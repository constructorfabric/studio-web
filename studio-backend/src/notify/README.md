# studio-notify

Notifications that survive the thing that was going to send them.

## Why it exists

[`../connectors`](../connectors) can already post a message to Slack, Zulip or
Discord while a request waits for it. That is the right shape for "test this
connection" and the wrong shape for a notification: the caller is usually some
other piece of Studio that has just finished a job, the platform may be
rate-limiting or down, and an HTTP handler is a bad place to discover either. A
message dropped there is dropped for good.

So this gear validates a notification and **queues** it. Delivery happens
afterwards, with retries, and what cannot be delivered lands in a dead-letter
table instead of nowhere.

## The run is the record

This gear owns **no database**. The message is the payload of a
`notify.deliver` run in [`../tasks`](../tasks), and that run is the whole
history: its state, its attempts, its summary or last error.

That is what keeps accepting a notification a single transaction. This gear
used to keep its own `studio_notify_deliveries` table beside its own outbox,
which worked because both were in one database. Moving the queue to
`studio-tasks` and keeping the table would have meant writing the record in one
database and the queue entry in another — and a crash between those two writes
is exactly the lost notification the queue exists to prevent. One system of
record, one commit.

What that costs: "what happened to my notification" is
`GET /studio-tasks/v1/runs/{id}` rather than a route of this gear's own, and
what needs attention is
`GET /studio-tasks/v1/runs?task_type=notify.deliver&state=failed`.

## What is left here

Two things, and both have to be here rather than in the task gear:

- **the accept path** (`service.rs`) — resolves the connection with the
  *caller's* context and refuses up front what a background worker could not do
  later: a personal-scoped credential it will not be able to read, a missing
  channel, a channel sent to a webhook connection that has its own.
- **the handler** (`handler.rs`) — the `notify.deliver` task, which knows how to
  read a chat platform's refusal and decide whether it is worth another attempt.

## REST

| Method + path | Does |
|---|---|
| `POST /studio-notify/v1/messages` | validate, queue, and return the run id to follow |

## In the assembly

- Gear `studio-notify`, capabilities `[rest]`, deps `account_management`.
- Config section `gears.studio-notify`.
- See `docs/queued-notifications.md`.
