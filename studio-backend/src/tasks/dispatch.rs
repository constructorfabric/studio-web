//! The queue worker: takes a run off the outbox and executes its handler.
//!
//! ## Who the worker is
//!
//! A run is executed by a process that has no request — possibly minutes after
//! the one that asked, possibly after a restart, and for a scheduled run there
//! was never a request at all. So it cannot act as the person who asked, and
//! does not try: nothing persists a caller's bearer token. The worker acts as
//! `studio-tasks` itself ([`SERVICE_SUBJECT_ID`]), scoped to the tenant on the
//! run.
//!
//! Whatever authorization mattered belongs at enqueue time, against the
//! caller's own context, where there is still a request to answer with a 400.
//! A handler that needs a caller-specific permission must therefore check it
//! before enqueuing, not here.
//!
//! ## Cancellation is cooperative, and polled
//!
//! `POST /runs/{id}/cancel` sets a flag on the row. A queued run is refused
//! before it starts. A *running* run only stops if its handler looks at
//! [`TaskContext::cancelled`], so while a handler runs the dispatcher polls the
//! flag every [`CANCEL_POLL`] and flips the handler's token when it appears.
//! One small query per running task, which buys cancellation that works instead
//! of a flag nobody reads.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, EntityTrait};
use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;
use toolkit::client_hub::ClientHub;
use toolkit_db::Db;
use toolkit_db::outbox::{LeasedMessageHandler, MessageResult, OutboxMessage};
use toolkit_db::secure::{SecureEntityExt, SecureUpdateExt};
use toolkit_security::{AccessScope, SecurityContext};
use tracing::{info, warn};
use uuid::Uuid;

use super::registry::{ProgressSink, TaskContext, TaskOutcome};
use super::{PAYLOAD_TYPE, RunState, entity, registry};
use crate::studio_events::{StudioEvent, StudioEventPublisher};

/// The `source` every event this gear publishes carries.
const EVENT_SOURCE: &str = "studio-tasks";
/// The `subject_type` those events are about.
const EVENT_SUBJECT: &str = "task_run";

/// Announce a run's transition on the `studio-events` channel, so a portal
/// watching a run is told instead of polling for it.
///
/// The publisher is resolved per event rather than held: gear init order is not
/// guaranteed, and an assembly without the channel must lose nothing but the
/// announcement. Best-effort by contract — a run's outcome is the row, not this.
fn announce(hub: &ClientHub, tenant: Uuid, run_id: Uuid, kind: &str, payload: Value) {
    // Only what this transition actually set is in `payload`: a field that is
    // absent means "unchanged", and a consumer merges rather than overwrites.
    // Sending `null` for the fields a patch left alone would tell a client the
    // run had just lost its summary, or its counts.
    let Ok(events) = hub.get::<dyn StudioEventPublisher>() else {
        return;
    };
    events.publish(
        StudioEvent::new(
            tenant,
            kind,
            EVENT_SUBJECT,
            run_id.to_string(),
            EVENT_SOURCE,
        )
        .with_payload(payload),
    );
}

/// The identity the worker acts as. Fixed, because it appears in audit trails
/// and in every scoped read the handlers make.
pub const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x2c81_5ea7_39d4_4b1f_9a06_7d3e_51c8_2fb0);

/// How many times a run is attempted before it is dead-lettered, unless its
/// handler says otherwise ([`TaskHandler::max_attempts`]).
///
/// Five, because a task is usually expensive — a repository import is tens of
/// seconds — and something that has failed five times for a transient-looking
/// reason is not usually transient.
pub const MAX_ATTEMPTS: i16 = 5;

/// How often a running task's cancel flag is re-read.
const CANCEL_POLL: Duration = Duration::from_secs(5);

/// Writes a running task's phase — and the counts it reports along with it —
/// back to its row.
pub(super) struct DbProgress {
    pub(super) db: Db,
    /// Resolves the studio-events publisher per report; see [`announce`].
    pub(super) hub: Arc<ClientHub>,
}

#[async_trait]
impl ProgressSink for DbProgress {
    async fn set(&self, tenant: Uuid, run_id: Uuid, phase: String, detail: Option<Value>) {
        // Copies for the announcement: the write below moves both into the
        // statement it builds.
        let phase_line = phase.clone();
        let detail_for_event = detail.clone();
        let write = async {
            let conn = self.db.conn()?;
            let mut update = entity::Entity::update_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(tenant))
                .filter(Condition::all().add(entity::Column::Id.eq(run_id)))
                .col_expr(entity::Column::Progress, Expr::value(phase))
                .col_expr(
                    entity::Column::UpdatedAt,
                    Expr::value(OffsetDateTime::now_utc()),
                );
            // A run that counts as it goes puts those counts here, so a poll
            // endpoint reads live numbers out of the same field it reads the
            // final ones from. Left alone when the report is a phase only.
            if let Some(detail) = detail {
                update = update.col_expr(entity::Column::Result, Expr::value(detail));
            }
            update.exec(&conn).await?;
            Ok::<(), anyhow::Error>(())
        };
        // Progress is a convenience for whoever is watching. Losing a line of
        // it must not disturb the run.
        if let Err(e) = write.await {
            warn!(run_id = %run_id, "studio-tasks: could not record progress: {e:#}");
        }
        let mut event = serde_json::Map::new();
        event.insert("run_id".into(), json!(run_id));
        event.insert("state".into(), json!(RunState::Running.as_str()));
        event.insert("phase".into(), json!(phase_line));
        // Only when the report carried counts: a phase-only report leaves the
        // run's recorded result alone, and so must the announcement.
        if let Some(detail) = detail_for_event {
            event.insert("result".into(), detail);
        }
        announce(
            &self.hub,
            tenant,
            run_id,
            "task.progress",
            Value::Object(event),
        );
    }
}

/// Read one run's cancel flag.
///
/// Free-standing because the cancel poller runs in its own task and only needs
/// this one query — not a dispatcher.
async fn cancel_requested(db: &Db, tenant: Uuid, id: Uuid) -> bool {
    let read = async {
        let conn = db.conn()?;
        let row = entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await?;
        Ok::<bool, anyhow::Error>(row.is_some_and(|r| r.cancel_requested))
    };
    // A failed read is not a cancellation: keep going rather than stopping work
    // because the database blinked.
    read.await.unwrap_or(false)
}

pub struct TaskDispatcher {
    db: Db,
    progress: Arc<dyn ProgressSink>,
    /// Resolves the studio-events publisher per transition; see [`announce`].
    hub: Arc<ClientHub>,
    /// Cancelled when the gear stops, so a long handler is told to wind up
    /// instead of being dropped mid-write.
    shutdown: CancellationToken,
    /// Set once every gear has had its chance to register a handler — see the
    /// missing-handler branch in [`Self::handle`].
    ready: Arc<AtomicBool>,
}

impl TaskDispatcher {
    pub fn new(
        db: Db,
        shutdown: CancellationToken,
        ready: Arc<AtomicBool>,
        hub: Arc<ClientHub>,
    ) -> Self {
        Self {
            progress: Arc::new(DbProgress {
                db: db.clone(),
                hub: Arc::clone(&hub),
            }),
            db,
            shutdown,
            ready,
            hub,
        }
    }

    fn worker_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
        SecurityContext::builder()
            .subject_id(SERVICE_SUBJECT_ID)
            .subject_type("service")
            .subject_tenant_id(tenant)
            .token_scopes(vec!["*".to_owned()])
            .build()
            .map_err(|e| anyhow::anyhow!("studio-tasks: cannot build a worker context: {e}"))
    }

    async fn run_row(&self, tenant: Uuid, id: Uuid) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await?)
    }

    /// Whether somebody has asked this run to stop.
    async fn cancel_requested(&self, tenant: Uuid, id: Uuid) -> bool {
        cancel_requested(&self.db, tenant, id).await
    }

    /// Apply a state transition to the row. Best-effort: the queue decides
    /// whether a message is done, this table only records it.
    async fn record(&self, tenant: Uuid, id: Uuid, task_type: &str, patch: Patch<'_>) {
        let kind = format!("task.{}", patch.state.as_str());
        let payload = {
            let mut event = serde_json::Map::new();
            event.insert("run_id".into(), json!(id));
            event.insert("task_type".into(), json!(task_type));
            event.insert("state".into(), json!(patch.state.as_str()));
            if let Some(attempts) = patch.attempts {
                event.insert("attempts".into(), json!(attempts));
            }
            if let Some(summary) = patch.summary {
                event.insert("summary".into(), json!(summary));
            }
            if let Some(error) = patch.error {
                event.insert("error".into(), json!(error));
            }
            if let Some(result) = patch.result {
                event.insert("result".into(), result.clone());
            }
            Value::Object(event)
        };
        let write = async {
            let conn = self.db.conn()?;
            let mut update = entity::Entity::update_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(tenant))
                .filter(Condition::all().add(entity::Column::Id.eq(id)))
                .col_expr(entity::Column::State, Expr::value(patch.state.as_str()))
                .col_expr(
                    entity::Column::UpdatedAt,
                    Expr::value(OffsetDateTime::now_utc()),
                );
            if let Some(attempts) = patch.attempts {
                update = update.col_expr(entity::Column::Attempts, Expr::value(attempts));
            }
            if patch.starting {
                update = update.col_expr(
                    entity::Column::StartedAt,
                    Expr::value(OffsetDateTime::now_utc()),
                );
            }
            if patch.state.is_terminal() {
                update = update.col_expr(
                    entity::Column::FinishedAt,
                    Expr::value(OffsetDateTime::now_utc()),
                );
            }
            if let Some(error) = patch.error {
                update = update.col_expr(entity::Column::LastError, Expr::value(cut(error)));
            }
            if let Some(summary) = patch.summary {
                update = update
                    .col_expr(entity::Column::Summary, Expr::value(cut(summary)))
                    .col_expr(entity::Column::LastError, Expr::value(None::<String>));
            }
            if let Some(result) = patch.result {
                update = update.col_expr(entity::Column::Result, Expr::value(result.clone()));
            }
            update.exec(&conn).await?;
            Ok::<(), anyhow::Error>(())
        };
        if let Err(e) = write.await {
            warn!(run_id = %id, "studio-tasks: could not record the run outcome: {e:#}");
        }
        announce(&self.hub, tenant, id, &kind, payload);
    }
}

/// The fields one transition touches. A struct because five positional
/// `Option`s at a call site is how the summary ends up in `last_error`.
struct Patch<'a> {
    state: RunState,
    attempts: Option<i16>,
    error: Option<&'a str>,
    summary: Option<&'a str>,
    /// The handler's structured result, written beside the summary. Replaces
    /// whatever the run last reported as progress detail, which has the same
    /// shape by convention — see [`registry::SyncReporter::set_with`].
    result: Option<&'a serde_json::Value>,
    starting: bool,
}

impl<'a> Patch<'a> {
    fn state(state: RunState) -> Self {
        Self {
            state,
            attempts: None,
            error: None,
            summary: None,
            result: None,
            starting: false,
        }
    }
}

/// Both `summary` and `last_error` are read by a person, and a handler can
/// hand us a page of provider HTML. Keep a sentence.
fn cut(text: &str) -> String {
    const LIMIT: usize = 500;
    if text.chars().count() <= LIMIT {
        return text.to_owned();
    }
    text.chars().take(LIMIT - 1).chain(['…']).collect()
}

#[async_trait]
impl LeasedMessageHandler for TaskDispatcher {
    async fn handle(&self, msg: &OutboxMessage) -> MessageResult {
        if msg.payload_type != PAYLOAD_TYPE {
            return MessageResult::Reject(format!(
                "studio-tasks: unexpected payload type '{}'",
                msg.payload_type
            ));
        }
        let Some((tenant, run_id)) = super::decode_payload(&msg.payload) else {
            return MessageResult::Reject(
                "studio-tasks: queue payload is not a tenant and a run id".to_owned(),
            );
        };

        let row = match self.run_row(tenant, run_id).await {
            Ok(Some(row)) => row,
            Ok(None) => {
                warn!(run_id = %run_id, "studio-tasks: queued run has no row — dropping");
                return MessageResult::Ok;
            }
            Err(e) => {
                warn!(run_id = %run_id, "studio-tasks: cannot read the run: {e:#}");
                return MessageResult::Retry;
            }
        };

        // At-least-once: this may be a redelivery of something that already
        // finished. Both terminal-and-done states are no-ops.
        if row.state == RunState::Succeeded.as_str() || row.state == RunState::Cancelled.as_str() {
            return MessageResult::Ok;
        }
        if row.cancel_requested {
            info!(run_id = %run_id, "studio-tasks: run cancelled before it started");
            self.record(
                tenant,
                run_id,
                &row.task_type,
                Patch::state(RunState::Cancelled),
            )
            .await;
            return MessageResult::Ok;
        }

        let attempt = msg.attempts.saturating_add(1);

        let Some(handler) = registry::handler(&row.task_type) else {
            // Handlers are registered by the gears that own the work, and two
            // of them can only do that in the REST phase — after this queue
            // starts (see the note in `super`). A run delivered in the first
            // moments of a process can therefore find its handler simply not
            // there yet, and that is not the run's fault: while the process is
            // still coming up, retry without spending an attempt on it.
            if !self.ready.load(Ordering::Relaxed) {
                info!(
                    run_id = %run_id,
                    task_type = %row.task_type,
                    "studio-tasks: handlers are still registering — putting this run back"
                );
                return MessageResult::Retry;
            }
            // Past that, either the gear that owns this task type is not linked
            // into this deployment or it failed to register. Retry, but not for
            // ever: a task type nothing here can run has to end up somewhere a
            // person will find it.
            let reason = format!(
                "no handler is registered for task type '{}' in this deployment",
                row.task_type
            );
            if attempt > MAX_ATTEMPTS {
                warn!(run_id = %run_id, "studio-tasks: {reason} — dead-lettering");
                self.record(
                    tenant,
                    run_id,
                    &row.task_type,
                    Patch {
                        error: Some(&reason),
                        ..Patch::state(RunState::Failed)
                    },
                )
                .await;
                return MessageResult::Reject(reason);
            }
            warn!(run_id = %run_id, "studio-tasks: {reason} — waiting");
            return MessageResult::Retry;
        };

        // The queue counts an attempt when it hands the message over, not when
        // a handler answers. So an attempt that never answered at all — cut
        // short when the lease ran out, or lost with the process running it —
        // is only ever caught here; the `Retry` arm below never sees one. This
        // is what stops work that outlives its lease from being redelivered
        // for ever.
        if attempt > handler.max_attempts() {
            let reason = format!(
                "gave up after {} deliveries, the last of which never reported back — \
                 the work is most likely longer than this queue's {}s lease",
                attempt - 1,
                super::LEASE.as_secs(),
            );
            warn!(run_id = %run_id, task_type = %row.task_type, "studio-tasks: {reason}");
            self.record(
                tenant,
                run_id,
                &row.task_type,
                Patch {
                    error: Some(&reason),
                    ..Patch::state(RunState::Failed)
                },
            )
            .await;
            return MessageResult::Reject(reason);
        }

        let security = match Self::worker_context(tenant) {
            Ok(ctx) => ctx,
            Err(e) => return MessageResult::Reject(format!("{e:#}")),
        };

        // A row that already reads `running` on a fresh delivery means the last
        // attempt never got to say anything. Record that on the row: otherwise
        // the only visible symptom is `attempts` climbing.
        let interrupted = (attempt > 1 && row.state == RunState::Running.as_str()).then(|| {
            format!(
                "attempt {} never reported back (its lease ran out, or its process stopped)",
                attempt - 1
            )
        });
        self.record(
            tenant,
            run_id,
            &row.task_type,
            Patch {
                attempts: Some(attempt),
                starting: true,
                error: interrupted.as_deref(),
                ..Patch::state(RunState::Running)
            },
        )
        .await;

        // The handler's token: cancelled by a shutdown, or by somebody asking
        // this run to stop. The poller lives exactly as long as the handler.
        let token = self.shutdown.child_token();
        let poller = {
            let token = token.clone();
            let db = self.db.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        () = token.cancelled() => break,
                        () = tokio::time::sleep(CANCEL_POLL) => {
                            if cancel_requested(&db, tenant, run_id).await {
                                token.cancel();
                                break;
                            }
                        }
                    }
                }
            })
        };

        let ctx = TaskContext {
            tenant,
            run_id,
            task_type: row.task_type.clone(),
            payload: row.payload.clone(),
            attempt,
            security,
            cancel: token.clone(),
            progress: Arc::clone(&self.progress),
        };

        let outcome = handler.run(&ctx).await;
        // Stop the poller whichever way the handler went.
        token.cancel();
        poller.abort();

        // A run somebody cancelled mid-flight is `cancelled`, not `failed`,
        // however the handler chose to return — the distinction is the whole
        // point of having asked.
        let cancelled = self.cancel_requested(tenant, run_id).await;

        // Checked before the outcome is read, not as a guard on every arm: a
        // guarded match cannot be proved exhaustive, and the rule is simpler
        // than the arms anyway — if it was cancelled, that is what happened,
        // whatever the handler returned on its way out.
        if cancelled {
            info!(run_id = %run_id, "studio-tasks: run stopped on request");
            self.record(
                tenant,
                run_id,
                &row.task_type,
                Patch::state(RunState::Cancelled),
            )
            .await;
            return MessageResult::Ok;
        }

        match outcome {
            TaskOutcome::Done { summary, result } => {
                info!(
                    run_id = %run_id,
                    task_type = %row.task_type,
                    attempt,
                    "studio-tasks: run succeeded"
                );
                self.record(
                    tenant,
                    run_id,
                    &row.task_type,
                    Patch {
                        summary: summary.as_deref(),
                        result: result.as_ref(),
                        ..Patch::state(RunState::Succeeded)
                    },
                )
                .await;
                MessageResult::Ok
            }
            TaskOutcome::Failed(reason) => {
                warn!(
                    run_id = %run_id,
                    task_type = %row.task_type,
                    attempt,
                    "studio-tasks: run failed permanently: {reason}"
                );
                self.record(
                    tenant,
                    run_id,
                    &row.task_type,
                    Patch {
                        error: Some(&reason),
                        ..Patch::state(RunState::Failed)
                    },
                )
                .await;
                MessageResult::Reject(reason)
            }
            TaskOutcome::Retry(reason) => {
                if attempt >= handler.max_attempts() {
                    warn!(
                        run_id = %run_id,
                        task_type = %row.task_type,
                        attempt,
                        "studio-tasks: out of attempts — dead-lettering: {reason}"
                    );
                    self.record(
                        tenant,
                        run_id,
                        &row.task_type,
                        Patch {
                            error: Some(&reason),
                            ..Patch::state(RunState::Failed)
                        },
                    )
                    .await;
                    MessageResult::Reject(reason)
                } else {
                    warn!(
                        run_id = %run_id,
                        task_type = %row.task_type,
                        attempt,
                        "studio-tasks: attempt failed, will retry: {reason}"
                    );
                    self.record(
                        tenant,
                        run_id,
                        &row.task_type,
                        Patch {
                            error: Some(&reason),
                            ..Patch::state(RunState::Queued)
                        },
                    )
                    .await;
                    MessageResult::Retry
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_message_is_cut_to_a_sentence_without_splitting_a_character() {
        assert_eq!(cut("short").as_str(), "short");
        let long = cut(&"я".repeat(900));
        assert_eq!(long.chars().count(), 500);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn only_the_finished_states_are_terminal() {
        assert!(RunState::Succeeded.is_terminal());
        assert!(RunState::Failed.is_terminal());
        assert!(RunState::Cancelled.is_terminal());
        // A retry puts a run back to `queued`, and `running` is mid-flight —
        // neither may stamp `finished_at`.
        assert!(!RunState::Queued.is_terminal());
        assert!(!RunState::Running.is_terminal());
    }
}
