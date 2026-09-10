//! Schedules: writing them, reading them, and firing the ones that are due.
//!
//! ## Schedules are platform-level, and that is a constraint, not a choice
//!
//! `toolkit-db`'s secure ORM has no cross-tenant read: `all()` and `one()` exist
//! only on a *scoped* select. That is deliberate, and it means the ticker —
//! one loop for the whole deployment — cannot scan "every tenant's due
//! schedules". So schedules live under one owning tenant (the platform root,
//! see [`super::Config`]), and a schedule that acts on some tenant's data names
//! that tenant in its payload; the *run* is then created there, which is where
//! the data and its authorization actually live.
//!
//! Per-tenant self-service schedules — a workspace configuring its own digest —
//! would need the ticker to iterate tenants from account-management. The table
//! is already keyed `(tenant_id, name)`, so that is an additive change to the
//! ticker and not to the schema.
//!
//! ## Firing is at-least-once, and the run is exactly-once
//!
//! The scheduler and `studio-tasks` are separate gears with separate databases,
//! so "enqueue the run" and "record that it fired" cannot be one transaction. A
//! crash between them re-fires on the next tick. That is made harmless rather
//! than prevented: every firing carries the idempotency key
//! `<schedule_id>:<scheduled_for>`, and `studio-tasks` turns a repeat of that
//! into the same run. The missed-schedule policy then falls out of which
//! `scheduled_for` values a tick enqueues at all.

use std::sync::Arc;

use anyhow::anyhow;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, Order};
use serde_json::Value;
use time::OffsetDateTime;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_db::Db;
use toolkit_db::secure::{SecureEntityExt, SecureInsertExt, SecureUpdateExt};
use toolkit_security::{AccessScope, SecurityContext};
use tracing::{info, warn};
use uuid::Uuid;

use crate::tasks::service::NewRun;
use crate::tasks::{TASK_QUEUE_INSTANCE_ID, TaskQueue};

use super::cron::{Expression, check_timezone, format_iso8601_duration};
use super::entity;
use super::policy::{Concurrency, MissedPolicy, plan};

/// One schedule to write.
#[derive(Debug, Clone)]
pub struct NewSchedule<'a> {
    pub name: &'a str,
    pub task_type: &'a str,
    pub payload: Value,
    /// `cron` | `interval`.
    pub expression_kind: &'a str,
    pub expression: &'a str,
    pub timezone: Option<&'a str>,
    pub concurrency: Option<&'a str>,
    pub missed_policy: Option<&'a str>,
    pub max_catch_up_runs: Option<i16>,
    pub enabled: bool,
}

/// The fields a `PATCH` may change. `None` leaves one alone.
#[derive(Debug, Clone, Default)]
pub struct ScheduleUpdate<'a> {
    pub expression_kind: Option<&'a str>,
    pub expression: Option<&'a str>,
    pub timezone: Option<&'a str>,
    pub concurrency: Option<&'a str>,
    pub missed_policy: Option<&'a str>,
    pub max_catch_up_runs: Option<i16>,
    pub enabled: Option<bool>,
    pub payload: Option<Value>,
}

pub struct SchedulerService {
    db: Db,
    hub: Arc<ClientHub>,
    /// The tenant schedules belong to. See the module note.
    owner: Uuid,
}

impl SchedulerService {
    pub fn new(db: Db, hub: Arc<ClientHub>, owner: Uuid) -> Arc<Self> {
        Arc::new(Self { db, hub, owner })
    }

    pub fn owner(&self) -> Uuid {
        self.owner
    }

    /// The task queue, resolved per use.
    ///
    /// Lazily rather than at init, which is what makes this gear independent of
    /// whether `studio-tasks` initialized first.
    fn queue(&self) -> anyhow::Result<Arc<dyn TaskQueue>> {
        self.hub
            .get_scoped::<dyn TaskQueue>(&ClientScope::gts_id(TASK_QUEUE_INSTANCE_ID))
            .map_err(|_| {
                anyhow!(
                    "the task queue is not available in this deployment \
                     (studio-tasks has no database configured), so nothing can be scheduled"
                )
            })
    }

    /// Validate an expression, a timezone and the two policies together.
    ///
    /// One place, because a schedule is only meaningful if all four agree — and
    /// because the error a person needs is "this cron field is wrong", not
    /// "insert failed".
    fn validate(
        &self,
        task_type: &str,
        kind: &str,
        expression: &str,
        timezone: &str,
        concurrency: &str,
        missed: &str,
    ) -> anyhow::Result<(Expression, Concurrency, MissedPolicy)> {
        if crate::tasks::registry::handler(task_type).is_none() {
            return Err(anyhow!(
                "no handler for task type '{task_type}' in this deployment (known: {})",
                crate::tasks::registry::known_task_types().join(", ")
            ));
        }
        check_timezone(timezone)?;
        Ok((
            Expression::parse(kind, expression)?,
            Concurrency::parse(concurrency)?,
            MissedPolicy::parse(missed)?,
        ))
    }

    pub async fn create(
        &self,
        ctx: &SecurityContext,
        req: NewSchedule<'_>,
    ) -> anyhow::Result<entity::Model> {
        let name = req.name.trim();
        if name.is_empty() {
            return Err(anyhow!("a schedule needs a name"));
        }
        let timezone = req.timezone.unwrap_or("UTC");
        let concurrency = req.concurrency.unwrap_or("allow");
        let missed = req.missed_policy.unwrap_or("skip");
        let (expression, _, _) = self.validate(
            req.task_type.trim(),
            req.expression_kind,
            req.expression,
            timezone,
            concurrency,
            missed,
        )?;

        if self.by_name(name).await?.is_some() {
            return Err(anyhow!(
                "a schedule named '{name}' already exists — patch it or pick another name"
            ));
        }

        let now = OffsetDateTime::now_utc();
        let row = entity::Model {
            id: Uuid::new_v4(),
            tenant_id: self.owner,
            name: name.to_owned(),
            task_type: req.task_type.trim().to_owned(),
            payload: req.payload,
            expression_kind: req.expression_kind.trim().to_lowercase(),
            expression: canonical(&expression, req.expression),
            timezone: timezone.trim().to_owned(),
            concurrency: Concurrency::parse(concurrency)?.as_str().to_owned(),
            missed_policy: MissedPolicy::parse(missed)?.as_str().to_owned(),
            max_catch_up_runs: req.max_catch_up_runs.unwrap_or(3).clamp(1, 100),
            enabled: req.enabled,
            // First firing is computed, never "now": creating a schedule must
            // not be a way to trigger a job. `POST …/run-now` is.
            next_run_at: expression.next_after(now, None)?,
            last_fired_at: None,
            last_run_id: None,
            created_by: ctx.subject_id(),
            created_at: now,
            updated_at: now,
        };

        let conn = self.db.conn()?;
        entity::Entity::insert(active(row.clone()))
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(self.owner))?
            .exec(&conn)
            .await?;
        info!(
            schedule = %row.name,
            task_type = %row.task_type,
            next_run_at = %row.next_run_at,
            "studio-scheduler: schedule created"
        );
        Ok(row)
    }

    /// Create a schedule if the deployment does not have it yet.
    ///
    /// For the schedules the platform owns — a retention sweep — which are
    /// registered at boot rather than by a person. Idempotent on the name, and
    /// deliberately does **not** overwrite an existing row: an operator who
    /// changed the cadence or disabled it should not have that undone by the
    /// next restart.
    pub async fn ensure(
        &self,
        ctx: &SecurityContext,
        req: NewSchedule<'_>,
    ) -> anyhow::Result<entity::Model> {
        if let Some(existing) = self.by_name(req.name.trim()).await? {
            return Ok(existing);
        }
        self.create(ctx, req).await
    }

    pub async fn patch(
        &self,
        _ctx: &SecurityContext,
        id: Uuid,
        patch: ScheduleUpdate<'_>,
    ) -> anyhow::Result<entity::Model> {
        let existing = self
            .get(id)
            .await?
            .ok_or_else(|| anyhow!("schedule {id} not found"))?;

        let kind = patch.expression_kind.unwrap_or(&existing.expression_kind);
        let expression = patch.expression.unwrap_or(&existing.expression);
        let timezone = patch.timezone.unwrap_or(&existing.timezone);
        let concurrency = patch.concurrency.unwrap_or(&existing.concurrency);
        let missed = patch.missed_policy.unwrap_or(&existing.missed_policy);
        let (parsed, _, _) = self.validate(
            &existing.task_type,
            kind,
            expression,
            timezone,
            concurrency,
            missed,
        )?;

        let now = OffsetDateTime::now_utc();
        // Changing the cadence moves the next firing; leaving the stored one
        // would keep the old grid until it fired once more.
        let next_run_at = if patch.expression.is_some() || patch.expression_kind.is_some() {
            parsed.next_after(now, existing.last_fired_at)?
        } else {
            existing.next_run_at
        };

        let stored = canonical(&parsed, expression);
        let conn = self.db.conn()?;
        let mut update = entity::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(self.owner))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .col_expr(entity::Column::ExpressionKind, Expr::value(kind))
            .col_expr(entity::Column::Expression, Expr::value(stored))
            .col_expr(entity::Column::Timezone, Expr::value(timezone))
            .col_expr(entity::Column::Concurrency, Expr::value(concurrency))
            .col_expr(entity::Column::MissedPolicy, Expr::value(missed))
            .col_expr(entity::Column::NextRunAt, Expr::value(next_run_at))
            .col_expr(entity::Column::UpdatedAt, Expr::value(now));
        if let Some(max) = patch.max_catch_up_runs {
            update = update.col_expr(
                entity::Column::MaxCatchUpRuns,
                Expr::value(max.clamp(1, 100)),
            );
        }
        if let Some(enabled) = patch.enabled {
            update = update.col_expr(entity::Column::Enabled, Expr::value(enabled));
        }
        if let Some(payload) = patch.payload {
            update = update.col_expr(entity::Column::Payload, Expr::value(payload));
        }
        update.exec(&conn).await?;

        // The read below takes its own connection from the pool; holding this
        // one until the end of the function is fine and keeps the borrow
        // obvious.
        self.get(id)
            .await?
            .ok_or_else(|| anyhow!("schedule {id} disappeared while being patched"))
    }

    pub async fn delete(&self, id: Uuid) -> anyhow::Result<bool> {
        use toolkit_db::secure::SecureDeleteExt;
        let conn = self.db.conn()?;
        let result = entity::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(self.owner))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    pub async fn get(&self, id: Uuid) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(self.owner))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await?)
    }

    pub async fn by_name(&self, name: &str) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(self.owner))
            .filter(Condition::all().add(entity::Column::Name.eq(name)))
            .one(&conn)
            .await?)
    }

    pub async fn list(&self) -> anyhow::Result<Vec<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(self.owner))
            .filter(Condition::all())
            .order_by(entity::Column::Name, Order::Asc)
            .limit(500)
            .all(&conn)
            .await?)
    }

    /// Enabled schedules whose next firing has passed.
    pub async fn due(&self, now: OffsetDateTime, limit: u64) -> anyhow::Result<Vec<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(self.owner))
            .filter(
                Condition::all()
                    .add(entity::Column::Enabled.eq(true))
                    .add(entity::Column::NextRunAt.lte(now)),
            )
            .order_by(entity::Column::NextRunAt, Order::Asc)
            .limit(limit)
            .all(&conn)
            .await?)
    }

    /// Enqueue whatever one due schedule owes, and advance it.
    ///
    /// Returns the run ids it created — empty is a legitimate answer: a
    /// `forbid` schedule whose previous run is still going fires nothing and
    /// still moves on.
    pub async fn fire(
        &self,
        ctx: &SecurityContext,
        schedule: &entity::Model,
        now: OffsetDateTime,
    ) -> anyhow::Result<Vec<Uuid>> {
        let expression = Expression::parse(&schedule.expression_kind, &schedule.expression)?;
        let policy = MissedPolicy::parse(&schedule.missed_policy)?;
        let concurrency = Concurrency::parse(&schedule.concurrency)?;
        let firings = plan(
            &expression,
            schedule.next_run_at,
            now,
            policy,
            schedule.max_catch_up_runs,
        )?;
        if firings.dropped > 0 {
            warn!(
                schedule = %schedule.name,
                dropped = firings.dropped,
                policy = policy.as_str(),
                "studio-scheduler: firings were due while nothing was running and were dropped \
                 by this schedule's missed-schedule policy"
            );
        }

        let queue = self.queue()?;
        let mut created = Vec::new();
        let mut blocked = false;

        for scheduled_for in &firings.scheduled_for {
            // Concurrency is judged against the run the last firing produced.
            if let Some(previous) = schedule.last_run_id
                && concurrency != Concurrency::Allow
                && let Some(run) = queue.run(self.owner, previous).await?
                && !run.state.is_terminal()
            {
                match concurrency {
                    Concurrency::Forbid => {
                        info!(
                            schedule = %schedule.name,
                            previous_run = %previous,
                            "studio-scheduler: previous run has not finished — skipping this \
                             firing (concurrency: forbid)"
                        );
                        blocked = true;
                        continue;
                    }
                    Concurrency::Replace => {
                        info!(
                            schedule = %schedule.name,
                            previous_run = %previous,
                            "studio-scheduler: asking the previous run to stop (concurrency: \
                             replace)"
                        );
                        // Not waited for: cancellation is cooperative, and a
                        // schedule that blocked until the old run noticed would
                        // be `forbid` with extra steps.
                        if let Err(e) = queue.request_cancel(self.owner, previous).await {
                            warn!(
                                schedule = %schedule.name,
                                "studio-scheduler: could not cancel the previous run: {e:#}"
                            );
                        }
                    }
                    Concurrency::Allow => unreachable!("filtered above"),
                }
            }

            let key = format!("{}:{}", schedule.id, format_instant(*scheduled_for));
            let run = queue
                .enqueue(
                    ctx,
                    NewRun {
                        tenant: self.owner,
                        task_type: &schedule.task_type,
                        payload: schedule.payload.clone(),
                        // One schedule's runs never overtake each other.
                        partition_key: Some(&schedule.id.to_string()),
                        idempotency_key: Some(&key),
                    },
                )
                .await?;
            created.push(run);
        }

        // The schedule advances whether or not it fired: a `forbid` that
        // blocked must not stay due and re-block every tick.
        let conn = self.db.conn()?;
        let mut update = entity::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(self.owner))
            .filter(Condition::all().add(entity::Column::Id.eq(schedule.id)))
            .col_expr(entity::Column::NextRunAt, Expr::value(firings.next_run_at))
            .col_expr(entity::Column::UpdatedAt, Expr::value(now));
        if let Some(last) = created.last() {
            update = update
                .col_expr(entity::Column::LastFiredAt, Expr::value(now))
                .col_expr(entity::Column::LastRunId, Expr::value(*last));
        }
        update.exec(&conn).await?;

        if !created.is_empty() {
            info!(
                schedule = %schedule.name,
                runs = created.len(),
                next_run_at = %firings.next_run_at,
                "studio-scheduler: fired"
            );
        } else if blocked {
            info!(
                schedule = %schedule.name,
                next_run_at = %firings.next_run_at,
                "studio-scheduler: nothing fired, schedule advanced"
            );
        }
        Ok(created)
    }

    /// Fire a schedule now, regardless of its cadence.
    ///
    /// The human entry point — "run the sweep now" — and the reason there is no
    /// generic "enqueue any task" route: the schedule already names the task
    /// type and the payload, both validated when it was written.
    pub async fn run_now(&self, ctx: &SecurityContext, id: Uuid) -> anyhow::Result<Uuid> {
        let schedule = self
            .get(id)
            .await?
            .ok_or_else(|| anyhow!("schedule {id} not found"))?;
        let queue = self.queue()?;
        let now = OffsetDateTime::now_utc();
        // A manual run gets its own idempotency key — it is a different event
        // from the scheduled firing, and asking twice means two runs.
        let key = format!("{}:manual:{}", schedule.id, format_instant(now));
        let run = queue
            .enqueue(
                ctx,
                NewRun {
                    tenant: self.owner,
                    task_type: &schedule.task_type,
                    payload: schedule.payload.clone(),
                    partition_key: Some(&schedule.id.to_string()),
                    idempotency_key: Some(&key),
                },
            )
            .await?;
        info!(schedule = %schedule.name, run_id = %run, "studio-scheduler: fired on request");
        Ok(run)
    }
}

/// The form an expression is stored in.
///
/// An interval is normalized (`pt30m` becomes `PT30M`) so the value read back
/// is the one this gear will evaluate, and two schedules that mean the same
/// cadence read the same. A cron expression is stored verbatim: its fields are
/// already canonical, and rewriting `*/15` into a list would be a worse
/// answer than the one the operator typed.
fn canonical(parsed: &Expression, raw: &str) -> String {
    match parsed {
        Expression::Interval(every) => format_iso8601_duration(*every),
        Expression::Cron(_) => raw.trim().to_owned(),
    }
}

/// The instant as it appears in an idempotency key. Second precision, RFC 3339,
/// so the key is stable and readable in a support conversation.
fn format_instant(at: OffsetDateTime) -> String {
    at.replace_nanosecond(0)
        .unwrap_or(at)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| at.unix_timestamp().to_string())
}

fn active(row: entity::Model) -> entity::ActiveModel {
    entity::ActiveModel {
        id: ActiveValue::Set(row.id),
        tenant_id: ActiveValue::Set(row.tenant_id),
        name: ActiveValue::Set(row.name),
        task_type: ActiveValue::Set(row.task_type),
        payload: ActiveValue::Set(row.payload),
        expression_kind: ActiveValue::Set(row.expression_kind),
        expression: ActiveValue::Set(row.expression),
        timezone: ActiveValue::Set(row.timezone),
        concurrency: ActiveValue::Set(row.concurrency),
        missed_policy: ActiveValue::Set(row.missed_policy),
        max_catch_up_runs: ActiveValue::Set(row.max_catch_up_runs),
        enabled: ActiveValue::Set(row.enabled),
        next_run_at: ActiveValue::Set(row.next_run_at),
        last_fired_at: ActiveValue::Set(row.last_fired_at),
        last_run_id: ActiveValue::Set(row.last_run_id),
        created_by: ActiveValue::Set(row.created_by),
        created_at: ActiveValue::Set(row.created_at),
        updated_at: ActiveValue::Set(row.updated_at),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use time::{Date, Month};

    fn utc(y: i32, m: u8, d: u8, h: u8, min: u8, s: u8) -> OffsetDateTime {
        Date::from_calendar_date(y, Month::try_from(m).unwrap(), d)
            .unwrap()
            .with_hms(h, min, s)
            .unwrap()
            .assume_utc()
    }

    #[test]
    fn an_idempotency_instant_is_stable_and_readable() {
        let at = utc(2026, 9, 9, 3, 0, 0);
        assert_eq!(format_instant(at), "2026-09-09T03:00:00Z");
    }

    #[test]
    fn sub_second_jitter_does_not_change_the_key() {
        // Two ticks a few milliseconds apart must produce the same key for the
        // same scheduled instant, or a re-fire would create a second run.
        let at = utc(2026, 9, 9, 3, 0, 0);
        let jittered = at + time::Duration::milliseconds(400);
        assert_eq!(format_instant(at), format_instant(jittered));
    }
}
