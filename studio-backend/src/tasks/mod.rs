//! studio-tasks — background work that survives the process running it.
//!
//! ## Why this gear exists
//!
//! Three gears in this assembly had already invented the same thing badly.
//! `connectors::graph_sync_tasks`, `artifact_ingest::tasks` and
//! `components_catalog::tasks` each kept a `Mutex<HashMap<String,
//! TaskRecord>>`, each defined its own `TaskStatus`, each capped its own
//! retention, and each served its own `GET …/tasks/{id}`. All three lost
//! everything on restart: a poll arriving a second after a redeploy answered
//! "no such task" about work that had really run. None could be cancelled and
//! none could be retried.
//!
//! This gear is one durable version of that: a run is a row, execution is a
//! queue entry, and the two are written in one transaction.
//!
//! ## What it is not
//!
//! It is not a scheduler — nothing here knows about time. `studio-scheduler`
//! owns schedules and only enqueues into this gear. Keeping them apart means
//! the scheduler can be switched off without taking background work with it,
//! and a bug in cron arithmetic cannot stop a repository import.
//!
//! It is also not a workflow engine: no steps, no branching, no compensation.
//! The platform's `serverless-runtime` design covers that ground (and delegates
//! it to Temporal-class backends); this gear runs one function to completion
//! and records what happened.
//!
//! ## The queue is `toolkit-db`'s
//!
//! Same substrate as `studio-notify`: the transactional outbox, with a leased
//! per-partition processor, exponential backoff on retry and a dead-letter
//! table. This gear supplies a dispatcher, a table prefix and a partition
//! count. See `docs/queued-notifications.md` for why that is PostgreSQL and
//! not Redis — the reasoning is the same one, and the deciding argument is
//! that the enqueue has to be part of the transaction that caused it.

mod dispatch;
mod entity;
mod migrations;
pub mod registry;
mod rest;
pub mod service;
mod sweep;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::{DatabaseCapability, RunnableCapability};
use toolkit::{Gear, GearCtx};
use toolkit_db::outbox::{
    LeaseConfig, Outbox, OutboxHandle, Partitions, outbox_migrations_with_prefix,
};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use dispatch::TaskDispatcher;
use service::{NewRun, TaskService};

/// Table-name prefix for this gear's outbox family.
const TABLE_PREFIX: &str = "studio_tasks_outbox";

/// The one queue. Task types share it and are told apart by the run row, so a
/// new task type needs no migration and no restart-time wiring.
const QUEUE: &str = "runs";

/// How many runs can be in flight at once. Eight rather than the notifier's
/// four: a task is long (a repository import is tens of seconds) and the
/// partition it occupies is blocked while it runs.
const PARTITIONS: u32 = 8;

/// How long a run may hold its partition before the queue takes the message
/// back and hands it to somebody else.
///
/// The default is 30 seconds, which is wrong for everything in this gear: the
/// queue cancels the handler at `LEASE - LEASE_HEADROOM` and redelivers, so a
/// repository import (tens of seconds) or a catalog sync (minutes) was cut
/// short and started again for ever — and because the queue counts an attempt
/// when it *hands over* a message, not when a handler answers, such an attempt
/// never reached the retry cap either.
///
/// Fifteen minutes is the other side of that trade: a lease is also how long
/// it takes to notice that the process holding a run has died, so this is the
/// worst-case delay before a crashed run is retried, and how long its
/// partition stays blocked (one of eight). Work that genuinely needs longer is
/// caught by the attempt cap in [`dispatch`] and dead-lettered with that
/// reason, rather than running unnoticed.
const LEASE: Duration = Duration::from_secs(15 * 60);

/// Time the queue keeps back, out of [`LEASE`], for the ack round-trip after a
/// handler returns. Ten seconds rather than the default two: this gear's acks
/// write the run row as well.
const LEASE_HEADROOM: Duration = Duration::from_secs(10);

/// Payload type on the queue.
const PAYLOAD_TYPE: &str = "cf.studio.tasks.run.v1";

/// The attempt cap a handler gets unless it overrides
/// [`registry::TaskHandler::max_attempts`]. Re-exported so a handler that
/// deliberately asks for more can say so against the default.
pub use dispatch::MAX_ATTEMPTS as DEFAULT_MAX_ATTEMPTS;

/// ClientHub key under which the queue is published for other gears.
///
/// Not a plugin — nothing selects between implementations — so, like
/// `crate::connectors::NOTIFY_SENDER_INSTANCE_ID`, this id is the hub's scope
/// key and is not registered with the types-registry.
pub const TASK_QUEUE_INSTANCE_ID: &str = "cf.studio._.task_queue.v1~";

/// Enqueuing, for gears that produce work — including `studio-scheduler`.
///
/// Deliberately one method. A consumer may add work; reading, cancelling and
/// retrying runs belong to the operator's REST surface, not to a gear-to-gear
/// interface.
#[async_trait]
pub trait TaskQueue: Send + Sync + 'static {
    /// Record and queue one run, returning its id.
    async fn enqueue(&self, ctx: &SecurityContext, run: NewRun<'_>) -> anyhow::Result<Uuid>;

    /// One run, as another gear sees it — or `None` if it is gone.
    ///
    /// Here because a consumer that owns a task type has to answer for it: a
    /// scheduler's `forbid` policy is a statement about the run it produced
    /// last time, and a gear that kept its own poll endpoint has to serve it
    /// from the run rather than from a second copy of the truth.
    async fn run(&self, tenant: Uuid, run: Uuid) -> anyhow::Result<Option<RunView>>;

    /// Ask a run to stop, for a `replace` policy. Cooperative, like the REST
    /// verb it mirrors: it records the request and returns.
    async fn request_cancel(&self, tenant: Uuid, run: Uuid) -> anyhow::Result<()>;
}

#[async_trait]
impl TaskQueue for TaskService {
    async fn enqueue(&self, ctx: &SecurityContext, run: NewRun<'_>) -> anyhow::Result<Uuid> {
        TaskService::enqueue(self, ctx, run).await.map(|row| row.id)
    }

    async fn run(&self, tenant: Uuid, run: Uuid) -> anyhow::Result<Option<RunView>> {
        // A service identity, for the same reason the dispatcher builds one:
        // this is the gear's own bookkeeping, not a caller's read.
        let ctx = service_context(tenant)?;
        match TaskService::get(self, &ctx, tenant, run).await? {
            Some(row) => Ok(Some(RunView {
                state: RunState::parse(&row.state)?,
                payload: row.payload,
                progress: row.progress,
                summary: row.summary,
                result: row.result,
                last_error: row.last_error,
            })),
            None => Ok(None),
        }
    }

    async fn request_cancel(&self, tenant: Uuid, run: Uuid) -> anyhow::Result<()> {
        let ctx = service_context(tenant)?;
        TaskService::cancel(self, &ctx, tenant, run)
            .await
            .map(|_| ())
    }
}

/// The identity this gear uses for its own reads and writes when there is no
/// caller — the same subject the dispatcher runs as.
fn service_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(dispatch::SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow::anyhow!("studio-tasks: cannot build a service context: {e}"))
}

/// A schedule the deployment should always have, described by the gear that
/// owns the work.
///
/// `studio-scheduler` reads this at its `start` phase and `ensure`s each one,
/// which is how a platform maintenance job exists without an operator having
/// to create it — and without a redeploy undoing a cadence they changed.
pub struct PlatformSchedule {
    /// Unique within the platform tenant; also how `ensure` recognises it.
    pub name: &'static str,
    pub task_type: &'static str,
    /// A 5-field cron expression, evaluated in UTC.
    pub cron: &'static str,
    pub payload: serde_json::Value,
}

/// The schedules this gear asks for.
pub fn platform_schedules() -> Vec<PlatformSchedule> {
    vec![PlatformSchedule {
        name: "tasks-retention-sweep",
        task_type: sweep::TASK_TYPE,
        // 03:17 rather than 03:00: every deployment that picks a round hour
        // ends up firing everything at once, and this is the sweep — it can
        // run whenever nothing else does.
        cron: "17 3 * * *",
        payload: serde_json::json!({ "keep_days": 30 }),
    }]
}

/// One run as another gear sees it. Deliberately not the entity: a consumer
/// reads what a run *did*, not the bookkeeping around it.
#[derive(Debug, Clone)]
pub struct RunView {
    pub state: RunState,
    /// What the handler was given.
    pub payload: serde_json::Value,
    /// The phase it last reported.
    pub progress: Option<String>,
    /// One line for a person, once it succeeded.
    pub summary: Option<String>,
    /// The handler's structured result, where it has one.
    pub result: Option<serde_json::Value>,
    pub last_error: Option<String>,
}

/// Where a run has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    /// On the queue: never started, or failed an attempt and waiting for the
    /// next one.
    Queued,
    /// A handler has it now.
    Running,
    Succeeded,
    /// Given up on: a permanent refusal from the handler, or out of attempts.
    Failed,
    /// Somebody asked it to stop, and it stopped.
    Cancelled,
}

impl RunState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_lowercase().as_str() {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(anyhow::anyhow!(
                "unknown run state '{other}' \
                 (expected queued | running | succeeded | failed | cancelled)"
            )),
        }
    }

    /// Whether the run is over. Decides whether `finished_at` is stamped, and
    /// whether cancel and retry are allowed.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

/// The queue carries a tenant and a run id — never the payload, which would go
/// stale against the row a retry resets. The tenant rides along so the worker's
/// first read is already scoped; see `crate::notify` for the same reasoning.
fn encode_payload(tenant: Uuid, id: Uuid) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(tenant.as_bytes());
    out.extend_from_slice(id.as_bytes());
    out
}

fn decode_payload(payload: &[u8]) -> Option<(Uuid, Uuid)> {
    let bytes = <[u8; 32]>::try_from(payload).ok()?;
    let (tenant, id) = bytes.split_at(16);
    Some((
        Uuid::from_bytes(<[u8; 16]>::try_from(tenant).ok()?),
        Uuid::from_bytes(<[u8; 16]>::try_from(id).ok()?),
    ))
}

#[toolkit::gear(
    name = "studio-tasks",
    deps = [account_management],
    capabilities = [rest, db, stateful]
)]
#[derive(Default)]
pub struct StudioTasksGear {
    service: OnceLock<Option<Arc<TaskService>>>,
    queue: Mutex<Option<OutboxHandle>>,
    /// Cancelled in `stop`, so a handler mid-import is asked to wind up rather
    /// than dropped. Owned here because the pipeline starts in `init`, before
    /// the runtime hands out its own token.
    shutdown: OnceLock<CancellationToken>,
    /// False until the runtime's `start` phase, which is the first moment every
    /// gear has had its chance to register a handler. The dispatcher reads it
    /// to tell "nothing here can run this" from "not yet".
    ready: Arc<AtomicBool>,
}

#[async_trait]
impl Gear for StudioTasksGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let db = match ctx.db_required() {
            Ok(db) => db.db(),
            Err(e) => {
                warn!(
                    "studio-tasks: no database configured — gear stands down (the runs API \
                     answers 503 and nothing is queued until a `database:` section with \
                     server + dbname is added): {e}"
                );
                self.service
                    .set(None)
                    .map_err(|_| anyhow::anyhow!("studio-tasks already initialized"))?;
                return Ok(());
            }
        };

        let shutdown = CancellationToken::new();
        self.shutdown
            .set(shutdown.clone())
            .map_err(|_| anyhow::anyhow!("studio-tasks already initialized"))?;

        // Started here rather than in `RunnableCapability::start` because the
        // REST phase runs first and needs the queue handle to build the
        // service. Harmless: the processors find an empty queue until something
        // is enqueued, and the dispatcher resolves its handler per message, so
        // it does not race the gears that register them.
        let handle = Outbox::builder(db.clone())
            .table_prefix(TABLE_PREFIX)?
            .queue(
                QUEUE,
                Partitions::of(u16::try_from(PARTITIONS).unwrap_or(u16::MAX)),
            )
            // Leased, not transactional: a handler does real work — HTTP calls,
            // repository walks — and holding a partition lock across that would
            // pin a database transaction for as long as the work takes. The
            // cost is at-least-once, so handlers must be idempotent.
            .leased(TaskDispatcher::new(
                db.clone(),
                shutdown,
                Arc::clone(&self.ready),
                // For announcing transitions on `studio-events` (ADR-0013).
                // Resolved per event inside the dispatcher, so this does not
                // depend on which gear initialized first.
                ctx.client_hub(),
            ))
            .lease(LeaseConfig {
                duration: LEASE,
                headroom: LEASE_HEADROOM,
            })
            .start()
            .await?;

        let service = TaskService::new(db.clone(), Arc::clone(handle.outbox()));

        // The one handler this gear owns. Registered here rather than by a
        // consumer because the work — pruning this gear's own history — is
        // nobody else's.
        registry::register(Arc::new(sweep::RetentionSweep::new(
            db,
            Arc::clone(handle.outbox()),
        )))?;

        // Published in `init` for gears that resolve it in their own `init`;
        // `studio-scheduler` resolves it lazily per tick instead, which makes
        // the pair independent of initialization order.
        let queue: Arc<dyn TaskQueue> = service.clone();
        ctx.client_hub()
            .register_scoped::<dyn TaskQueue>(ClientScope::gts_id(TASK_QUEUE_INSTANCE_ID), queue);

        *self
            .queue
            .lock()
            .map_err(|_| anyhow::anyhow!("studio-tasks: queue lock poisoned"))? = Some(handle);
        self.service
            .set(Some(service))
            .map_err(|_| anyhow::anyhow!("studio-tasks already initialized"))?;

        info!(
            queue = QUEUE,
            partitions = PARTITIONS,
            lease_secs = LEASE.as_secs(),
            task_types = ?registry::known_task_types(),
            "studio-tasks: run queue running"
        );
        Ok(())
    }
}

impl DatabaseCapability for StudioTasksGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        let mut all = migrations::Migrator::migrations();
        match outbox_migrations_with_prefix(TABLE_PREFIX) {
            Ok(mut outbox) => all.append(&mut outbox),
            // The prefix is a validated compile-time constant, so this needs an
            // edit to it. Loud rather than silent: without these tables there
            // is no queue.
            Err(e) => panic!("studio-tasks: invalid outbox table prefix {TABLE_PREFIX}: {e}"),
        }
        all
    }
}

#[async_trait]
impl RunnableCapability for StudioTasksGear {
    /// The pipeline itself came up in `init` (see the note there). What happens
    /// here is that the dispatcher stops excusing an unknown task type: this
    /// phase runs after every gear's `init` *and* REST registration, so from
    /// now on a task type with no handler really has none.
    async fn start(&self, _cancel: CancellationToken) -> anyhow::Result<()> {
        self.ready.store(true, Ordering::Relaxed);
        info!(
            task_types = ?registry::known_task_types(),
            "studio-tasks: every handler is registered"
        );
        Ok(())
    }

    /// Tell running handlers to wind up, then let the queue drain its acks.
    ///
    /// Skipping this loses no work — an unacked leased run is redelivered once
    /// its lease expires — but it would turn every deploy into a handful of
    /// tasks that run twice.
    async fn stop(&self, _deadline: CancellationToken) -> anyhow::Result<()> {
        if let Some(shutdown) = self.shutdown.get() {
            shutdown.cancel();
        }
        let handle = self
            .queue
            .lock()
            .map_err(|_| anyhow::anyhow!("studio-tasks: queue lock poisoned"))?
            .take();
        if let Some(handle) = handle {
            handle.stop().await;
            info!("studio-tasks: run queue stopped");
        }
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioTasksGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        Ok(rest::register_routes(
            router,
            openapi,
            self.service.get().cloned().flatten(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_survives_the_queue_round_trip() {
        let tenant = Uuid::new_v4();
        let id = Uuid::new_v4();
        assert_eq!(
            decode_payload(&encode_payload(tenant, id)),
            Some((tenant, id))
        );
    }

    #[test]
    fn the_two_ids_do_not_get_swapped() {
        let payload = encode_payload(Uuid::from_u128(1), Uuid::from_u128(2));
        assert_eq!(&payload[..16], Uuid::from_u128(1).as_bytes());
        assert_eq!(&payload[16..], Uuid::from_u128(2).as_bytes());
    }

    #[test]
    fn a_payload_that_is_not_a_run_is_refused_rather_than_guessed() {
        assert!(decode_payload(b"").is_none());
        assert!(decode_payload(&[0u8; 16]).is_none());
        assert!(decode_payload(&[0u8; 33]).is_none());
    }

    #[test]
    fn every_state_round_trips_through_its_wire_form() {
        for state in [
            RunState::Queued,
            RunState::Running,
            RunState::Succeeded,
            RunState::Failed,
            RunState::Cancelled,
        ] {
            assert_eq!(RunState::parse(state.as_str()).unwrap(), state);
        }
        assert!(RunState::parse("done").is_err());
    }
}
