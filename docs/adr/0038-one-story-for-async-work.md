---
type: adr
status: proposed
date: 2026-10-08
---

# ADR-0038: One story for async work: a run does the work, an event says it happened

**ID**: `cpt-studio-adr-one-story-for-async-work`

Status: proposed · 2026-10-08 · Builds on ADR-0026 · Companion to [ADR-0037](0037-one-model-for-a-project.md)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Work that does not finish inside a request has four names in this backend:
`studio-tasks`, `studio-scheduler`, `studio-notify`, `studio-events`, and a
fifth, the platform's `event-broker`, in one corner of `studio-theia`. Each was
argued for on its own ([background-work](../background-work.md),
[queued notifications](../queued-notifications.md), ADR-0026), and each argument
holds. What is missing is the one page that says which to reach for, and what
the overlaps between them cost.

### What each one is, in the code

| Mechanism | What it is for | Where its state lives | Code |
|---|---|---|---|
| `studio-tasks` | Work that must happen even if the process dies: a run per job, leased, retried with backoff, dead-lettered, cancellable | database `studio_tasks`: `studio_tasks_runs` and the `toolkit-db` outbox family `studio_tasks_outbox_*`, written in one transaction | `src/tasks/` (`dispatch.rs`, `registry.rs`, `sweep.rs`) |
| `studio-scheduler` | Deciding *when*. It only enqueues runs, with the idempotency key `<schedule_id>:<scheduled_for>` | database `studio_scheduler`; no outbox of its own (`src/scheduler/migrations.rs`) | `src/scheduler/` (`ticker.rs` under a PostgreSQL advisory lock) |
| `studio-notify` | Reaching a person outside the portal: a chat channel, or the IDE of whoever has a workspace open | none. A notification is the payload of a `notify.deliver` run (`max_attempts` 8), and the run is its history | `src/notify/` (`service.rs` the accept path, `handler.rs` the delivery) |
| `studio-events` | Telling the portal that something happened, now: one SSE stream per tenant and a replay page by cursor | database `studio_events`: `studio_events_log` (the last 500 per tenant) and `studio_events_cursor` | `src/studio_events/` (`hub.rs`, `pump.rs`) |
| `event-broker` | The platform's event bus. Here: `EventBrokerEventSink`, an alternative sink for events the Theia bridge receives | none in this assembly | `src/studio_theia/sink.rs`, behind the `theia-event-broker` feature |

So the four are already fewer than they look. `studio-scheduler` and
`studio-notify` ride on `studio-tasks`: the scheduler enqueues runs, and notify
gave up its own table and outbox to be a task type (`src/notify/mod.rs`, "The run
is the record"). Two mechanisms carry everything that runs today, a durable work
queue and a push channel. The broker is a third that carries nothing.

### Where they meet, and what that costs

**The broker sink is code no build compiles.** The `event-broker` gear is not
linked (`src/registered_gears.rs` has no `use event_broker`). The
`theia-event-broker` feature that compiles the sink is enabled by no build: the
release builds `--features graph,theia-bridge`, compose builds
`--features theia-bridge`, and CI's clippy and test jobs use `theia-bridge`
(`.github/workflows/studio-delivery.yml`). Its GTS ids are marked placeholders.
It still pins the optional `event-broker-sdk` dependency in `Cargo.toml`, and
`assembly/manifest.rs` reports the feature.

**A run's announcement can be lost, and one client waits on it alone.** The
dispatcher writes the run row, then announces the transition
(`record` in `src/tasks/dispatch.rs`). The two are different databases, so they
cannot be one transaction. `publish` is infallible by contract (ADR-0026 §2):
it hands the event to a bounded queue with `try_send` and counts a drop
(`src/studio_events/hub.rs`). The dispatcher's own comment says what follows
from that: "a run's outcome is the row, not this". The prototype's background
work list honours it and keeps a poll as a floor (`tasks.tsx`). Its repository
sync does not: `followRun` resolves only on a terminal event
(`studio-frontend-prototype/src/studio-events.ts`), and the sync's comment says
"there is nothing to poll" (`artifact-sync.ts`). A dropped `task.succeeded`
leaves the sync line waiting until its five-minute deadline.

**Tasks and notify each reach into the other.** `notify` enqueues through
`crate::tasks::TaskQueue`. The dispatcher, when a run addressed to a workspace
ends, builds `crate::notify::service::NotifyService` directly and queues a
delivery to the IDE (`tell_the_editor`); `studio_tasks_runs` has a
`notify_workspace_id` column for it (`src/tasks/migrations.rs`). The `studio-tasks` gear declares only
`account_management` as a dependency.

**One ending, two routes to people.** A run that ends is announced on
`studio-events`, where the prototype's work inbox shows it unless
`asked_by_person` is false (`work-inbox.tsx`), and, if it was addressed to a
workspace, also queued as a `notify.deliver` run to the IDE. These are two
audiences, the portal and the IDE, so it is not duplication. It is a decision
nobody wrote down.

**Gear-to-gear reactions have no mechanism, and use runs.** When a push goes
through the Git proxy, `git_proxy/refresh.rs` builds an `artifact.ingest`
payload and enqueues it. When documents sync, `studio-documents` enqueues Spec
Quality batch runs through `TaskQueue`. There is no in-process subscription.
That works, and it is undocumented.

**Some work is neither.** `mirror_in_background` (`src/reports/rest.rs`) mirrors a
saved plan into the domain model with a bare `tokio::spawn`. A failure is a log
line, and a restart in between loses the mirror. (The catalogue's
`refresh_engine_later` and `studio-user`'s boot-time seeding also spawn, but they
refresh a cache and retry at the next boot. They are not work someone is owed.)

**The Theia kinds break the catalogue's own rule.** `theia.operation`,
`theia.repositories-changed` and the rest use hyphens and nouns, which rule E2
forbids ([events catalog](../events-catalog.md)). No screen in either portal
subscribes to a `theia.*` kind.

## Considered Options

- **Everything on `event-broker`.** Work as consumers of topics, notifications as
  a consumer, browsers through a bridge. It is the platform's answer. But the
  gear is not linked here, ADR-0026 found its REST handlers to be `todo!` and
  this ADR has not checked again (open question 1), and a topic has no state a
  person can read, cancel or retry, which is what a run is for.
- **Everything on `studio-tasks`.** Announcements as runs, the stream as a view
  of the runs table. A run has one consumer under a lease; an announcement has
  every open browser of a tenant. Theia's events are not work. It would turn the
  push channel into polling of the runs table.
- **Merge the two PostgreSQL logs.** `studio_events_log` and the tasks outbox are
  both ordered rows in PostgreSQL. They answer different questions: the outbox
  delivers each message once to a leaseholder and remembers failures; the log
  delivers every event to every reader and forgets after 500. Sharing tables
  would share neither semantics.
- **Two mechanisms, a rule for choosing, and nothing third.** Keep the work
  queue and the push channel, write down which question each answers, layer
  everything else on them, and delete what carries nothing. Chosen.

## Decision Outcome

### 1. Two mechanisms, chosen by the question

| The question | The mechanism | Shape |
|---|---|---|
| Must this happen, even across a restart? | a run in `studio-tasks` | `TaskHandler`, idempotent, leased |
| Must it happen at a time? | a schedule in `studio-scheduler` that enqueues a run | `port::Schedules` or `platform_schedules()` |
| Must a person outside the portal be told? | a `notify.deliver` run, accepted by `studio-notify` | `NotifyService::accept` |
| Must another gear react? | a run of *that* gear's task type, enqueued by this one | the consumer's payload type and `TaskQueue` |
| Should the portal know now? | an event on `studio-events` | `StudioEventPublisher::publish` |

Nothing else starts work that must happen. A bare `tokio::spawn` is for a cache
or a best-effort refresh, never for work somebody is owed.

### 2. An event is a hint, and the row is the truth

`publish` stays infallible and lossy, as ADR-0026 §2 decided. What changes is
the rule for consumers: a client that waits for an outcome reads the resource
itself when it subscribes and after every reconnect, and treats events as a
reason to update what it read. `followRun` reads `GET /studio-tasks/v1/runs/{id}`
once the stream is open and again on each reconnect, and resolves from whichever
says the run ended first. No event is promised to arrive.

This puts the guarantee where it already is. A run's state is written in its
own database's transaction. The event is written afterwards, in another
database, and a design that pretended otherwise would need a cross-database
outbox for an announcement.

### 3. Notify is a task type with a front door, and tasks call it through a port

`studio-notify` stays a gear for the reason it was made one: the accept path
checks what a background worker could not check later, with the caller's own
context (`src/notify/service.rs`). Its queue is `studio-tasks` and stays so.

The dispatcher's completion notice reaches notify through a port on the
ClientHub, resolved per use like the events publisher, instead of naming
`crate::notify::service`. `studio-tasks` then knows that a notifier may exist,
not what one is. Whether the IDE should hear about a finished run through
notify at all is open question 2.

### 4. Theia stays on `studio-events`; the broker sink is deleted

The bridge already publishes onto `studio-events` by default (ADR-0026 §3).
`EventBrokerEventSink`, the `theia-event-broker` feature, the optional
`event-broker-sdk` dependency and the feature's line in the assembly manifest
are removed. The `TheiaEventSink` trait stays, so a broker sink is one file
again when there is a broker to sink into.

The `theia.*` kinds are renamed to rule E2 in the same change
(`theia.operation_ran`, `theia.audit_recorded`, `theia.repositories_changed`,
`theia.workspace_snapshot_changed`, `theia.workspace_active`), with the events
catalog. No consumer exists to break.

### 5. When `event-broker` lands, it goes underneath, not beside

ADR-0026 §6 already says this for the push channel. The broker replaces
`studio_events_log`, `studio_events_cursor` and the pump, and the two endpoints
and every producer stay as they are, because producers only see
`StudioEventPublisher`. The broker does not become a second channel to the
portal. It may later become the way gears react to each other, once a reaction
has more than one consumer; that needs its own ADR, and runs stay the way work
is done either way.

### Consequences

- A contributor has one page to ask "which one". The table in §1 goes into
  [background-work](../background-work.md).
- **A lost event costs a reconnect's worth of delay, not five minutes.** Every
  client helper that follows a run makes one extra read per subscription.
- **Less code.** The broker sink, a feature flag and an optional dependency go,
  along with the part of the build matrix that never ran.
- **A port instead of a path.** The dispatcher and notify stop depending on each
  other's modules. An assembly without `studio-notify` keeps its runs and loses
  only the IDE notice, as one without `studio-events` loses only the
  announcement.
- The reports mirror becomes a run, so a failed mirror is visible on the
  Background work page and can be retried (shared with ADR-0037, step 7).
- Nothing changes for the scheduler, for chat delivery, for a run's lifecycle,
  or for the stream's wire format.

## More Information

### Migration, one pull request each

| # | Step |
|---|---|
| 1 | **Read the run, not only the stream.** `followRun` in `studio-frontend-prototype/src/studio-events.ts` reads the run on subscribe and on reconnect. `artifact-sync.ts` loses "nothing to poll". |
| 2 | **Delete the broker sink**: `EventBrokerEventSink`, the `theia-event-broker` feature and `event-broker-sdk` in `Cargo.toml`, the feature in `assembly/manifest.rs`, the compose comment, and the paragraph in `src/studio_theia/README.md`. |
| 3 | **Rename the `theia.*` kinds** to rule E2, in `sink.rs` and the [events catalog](../events-catalog.md). |
| 4 | **A notify port**: `studio-notify` publishes its accept path on the ClientHub; the dispatcher resolves it per use. |
| 5 | **`reports.mirror` as a task type**, replacing `mirror_in_background`. |
| 6 | **Write the rule down**: the table in §1 in [background-work](../background-work.md), and a line in `studio-backend/AGENTS.md` that work somebody is owed is a run. |

### Open questions

1. **Where is `event-broker` today?** ADR-0026 (2026-09-11) found the gear a
   skeleton. Step 2 does not depend on the answer, but §5's timing does.
2. **Should the IDE learn that a run ended from the stream instead of a
   notification?** A session could subscribe to its workspace's events, and
   runs would lose `notify_workspace_id`. It would also lose the retry and the
   record a `notify.deliver` run gives, and a session's backend would hold a
   stream open. Not decided here; §3's port keeps both open.
3. **Should the replay window be pruned by a scheduled run** rather than by
   every replica's pump? It works as it is. The question is only whether
   housekeeping should all look the same.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md), [studio-tasks](../design/studio-tasks.md), [studio-scheduler](../design/studio-scheduler.md), [studio-notify](../design/studio-notify.md), [studio-events](../design/studio-events.md), [studio-theia](../design/studio-theia.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-tasks`
* `cpt-studio-component-scheduler`
* `cpt-studio-component-notify`
* `cpt-studio-component-events`
* `cpt-studio-component-theia-bridge`
* `cpt-studio-principle-one-push-channel`
* `cpt-studio-fr-background-runs`
* `cpt-studio-fr-push-channel`
* `cpt-studio-nfr-durable-work`
