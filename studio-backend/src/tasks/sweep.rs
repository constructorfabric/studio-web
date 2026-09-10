//! The one task type this gear owns: pruning its own history.
//!
//! Every other task type belongs to the gear that does the work. This one is
//! the exception because the growth is this gear's own: a scheduler firing a
//! nightly job writes a run row every night forever, and `docs/` promised a
//! sweep that did not exist.
//!
//! ## It prunes one tenant, and that is the toolkit's rule
//!
//! `toolkit-db`'s secure ORM has no cross-tenant write — a delete needs a
//! scope, and a scope names tenants. So this sweep prunes the tenant its run
//! belongs to, which for the platform schedule means the platform tenant: the
//! one where every *scheduled* run accumulates. Runs created by a gear inside
//! some workspace's tenant are not touched, and pruning those needs either a
//! tenant enumeration from account-management or a schedule per tenant.
//! Deliberately not worked around: the scoping rule is protecting something
//! real, and a maintenance job is not a good reason to be the first code that
//! steps over it.

use async_trait::async_trait;
use sea_orm::{ColumnTrait, Condition, EntityTrait};
use std::sync::Arc;
use time::{Duration, OffsetDateTime};
use toolkit_db::Db;
use toolkit_db::outbox::{DeadLetterScope, Outbox};
use toolkit_db::secure::SecureDeleteExt;
use toolkit_security::AccessScope;
use tracing::info;

use super::entity;
use super::registry::{TaskContext, TaskHandler, TaskOutcome};

/// Task type, and the name of the schedule that fires it.
pub const TASK_TYPE: &str = "tasks.retention_sweep";

/// How long a finished run is kept when the payload does not say.
const DEFAULT_KEEP_DAYS: i64 = 30;

pub struct RetentionSweep {
    db: Db,
    outbox: Arc<Outbox>,
}

impl RetentionSweep {
    pub fn new(db: Db, outbox: Arc<Outbox>) -> Self {
        Self { db, outbox }
    }
}

#[async_trait]
impl TaskHandler for RetentionSweep {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        // A payload that names `keep_days` as something other than a number is
        // a mistake in a schedule, not a transient fault: retrying it four more
        // times would just be four more log lines. Absent is fine and means
        // the default.
        let keep_days = match ctx.payload.get("keep_days") {
            None => DEFAULT_KEEP_DAYS,
            Some(value) => match value.as_i64() {
                Some(days) => days.clamp(1, 3650),
                None => {
                    return TaskOutcome::Failed(format!(
                        "keep_days must be a whole number of days, got {value}"
                    ));
                }
            },
        };
        let cutoff = OffsetDateTime::now_utc() - Duration::days(keep_days);

        // Checked before the delete rather than after: this is the cheap
        // moment to honour a cancellation, and the sweep has nothing partial
        // to leave behind if it stops here.
        if ctx.cancelled() {
            return TaskOutcome::done("cancelled before pruning anything");
        }

        ctx.progress(format!("pruning runs finished before {cutoff}"))
            .await;
        let pruned = match self.prune_runs(ctx, cutoff).await {
            Ok(n) => n,
            // The database being unavailable is the definition of transient,
            // and a sweep that missed a night costs nothing.
            Err(e) => {
                return TaskOutcome::Retry(format!(
                    "could not prune runs (attempt {}): {e:#}",
                    ctx.attempt
                ));
            }
        };

        ctx.progress("cleaning up resolved dead letters").await;
        let dead_letters = match self.prune_dead_letters().await {
            Ok(n) => n,
            Err(e) => {
                // The run half already succeeded; report it rather than
                // re-running the whole sweep for the smaller half.
                info!("studio-tasks: dead-letter cleanup skipped this pass: {e:#}");
                0
            }
        };

        TaskOutcome::done_with(
            format!(
                "kept {keep_days} days: pruned {pruned} run(s),                  {dead_letters} resolved dead letter(s)"
            ),
            serde_json::json!({
                "keep_days": keep_days,
                "runs_pruned": pruned,
                "dead_letters_pruned": dead_letters,
            }),
        )
    }
}

impl RetentionSweep {
    /// Delete finished runs older than `cutoff`.
    ///
    /// Only terminal states: a `queued` run older than the cutoff is a run the
    /// queue still owns, and deleting it would leave a queue entry pointing at
    /// nothing. `running` is likewise excluded, which is also what keeps the
    /// sweep from deleting itself.
    async fn prune_runs(&self, ctx: &TaskContext, cutoff: OffsetDateTime) -> anyhow::Result<u64> {
        let conn = self.db.conn()?;
        let result = entity::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(ctx.tenant))
            .filter(
                Condition::all()
                    .add(entity::Column::FinishedAt.lt(cutoff))
                    .add(
                        Condition::any()
                            .add(entity::Column::State.eq(super::RunState::Succeeded.as_str()))
                            .add(entity::Column::State.eq(super::RunState::Failed.as_str()))
                            .add(entity::Column::State.eq(super::RunState::Cancelled.as_str())),
                    ),
            )
            .exec(&conn)
            .await?;
        Ok(result.rows_affected)
    }

    /// Delete dead letters an operator has already dealt with.
    ///
    /// `dead_letter_cleanup` removes only `resolved` and `discarded` rows, so a
    /// `pending` dead letter — one nobody has looked at — survives every sweep.
    /// That is the right default: those are the ones worth keeping.
    async fn prune_dead_letters(&self) -> anyhow::Result<u64> {
        let conn = self.db.conn()?;
        Ok(self
            .outbox
            .dead_letter_cleanup(&conn, &DeadLetterScope::default())
            .await?)
    }
}
