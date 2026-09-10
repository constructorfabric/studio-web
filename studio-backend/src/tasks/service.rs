//! Enqueuing runs, and the operator's verbs over them.
//!
//! The enqueue is one transaction — the run row and its queue entry commit
//! together or not at all, for the reason spelled out in
//! [`crate::notify::service`]: a queue the business transaction cannot commit
//! *with* disagrees with the database every time one of the two writes fails.
//!
//! Note what is deliberately absent: there is no REST route that enqueues an
//! arbitrary task type with an arbitrary payload. Runs are created by the gear
//! that owns the work, or by a schedule that already names both. A generic
//! "run this" endpoint would be a way to make any handler in the process do
//! anything, with no validation of the payload it is given.

use std::sync::Arc;

use anyhow::anyhow;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, Order};
use serde_json::Value;
use time::OffsetDateTime;
use toolkit_db::Db;
use toolkit_db::outbox::Outbox;
use toolkit_db::secure::{SecureEntityExt, SecureInsertExt, SecureUpdateExt};
use toolkit_security::{AccessScope, SecurityContext};
use uuid::Uuid;

use super::{PARTITIONS, PAYLOAD_TYPE, QUEUE, RunState, encode_payload, entity, registry};

/// One request to run something.
#[derive(Debug, Clone)]
pub struct NewRun<'a> {
    pub tenant: Uuid,
    /// Must be a registered task type; an enqueue of something nothing can run
    /// is refused rather than parked.
    pub task_type: &'a str,
    pub payload: Value,
    /// Anything that must not run concurrently with itself — a connection id,
    /// a repository path. Runs sharing a key share a partition and therefore
    /// run in order. `None` spreads by run id, i.e. maximum parallelism.
    pub partition_key: Option<&'a str>,
    /// Makes a repeated enqueue one run. The scheduler always sets it.
    pub idempotency_key: Option<&'a str>,
}

/// Filter for the run listing.
#[derive(Debug, Clone, Default)]
pub struct RunQuery {
    pub state: Option<RunState>,
    pub task_type: Option<String>,
    pub limit: u64,
}

pub struct TaskService {
    db: Db,
    outbox: Arc<Outbox>,
}

impl TaskService {
    pub fn new(db: Db, outbox: Arc<Outbox>) -> Arc<Self> {
        Arc::new(Self { db, outbox })
    }

    /// Which partition a run goes to. FNV-1a, not `DefaultHasher`: the standard
    /// hasher is not stable across builds, and a partition assignment that
    /// moved on upgrade would reorder work across a restart.
    fn partition_of(key: &str) -> u32 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in key.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        u32::try_from(hash % u64::from(PARTITIONS)).unwrap_or(0)
    }

    /// Record a run and queue it.
    pub async fn enqueue(
        &self,
        ctx: &SecurityContext,
        req: NewRun<'_>,
    ) -> anyhow::Result<entity::Model> {
        let task_type = req.task_type.trim();
        if registry::handler(task_type).is_none() {
            return Err(anyhow!(
                "no handler for task type '{task_type}' in this deployment (known: {})",
                registry::known_task_types().join(", ")
            ));
        }

        let key = req
            .idempotency_key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned);
        if let Some(key) = key.as_deref()
            && let Some(existing) = self.find_by_idempotency_key(req.tenant, key).await?
        {
            return Ok(existing);
        }

        let id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        let partition_key = req
            .partition_key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned);
        let row = entity::Model {
            id,
            tenant_id: req.tenant,
            task_type: task_type.to_owned(),
            payload: req.payload,
            partition_key: partition_key.clone(),
            state: RunState::Queued.as_str().to_owned(),
            attempts: 0,
            progress: None,
            summary: None,
            result: None,
            last_error: None,
            cancel_requested: false,
            idempotency_key: key,
            requested_by: ctx.subject_id(),
            created_at: now,
            updated_at: now,
            started_at: None,
            finished_at: None,
        };
        let partition = Self::partition_of(partition_key.as_deref().unwrap_or(&id.to_string()));

        let outbox = Arc::clone(&self.outbox);
        let payload = encode_payload(req.tenant, id);
        let tenant = req.tenant;
        let stored = row.clone();
        self.db
            .transaction_ref_mapped::<_, (), anyhow::Error>(move |tx| {
                Box::pin(async move {
                    entity::Entity::insert(active(stored))
                        .secure()
                        // scope_unchecked: the row does not exist yet, so there
                        // is nothing to clamp against, and the tenant is the
                        // one the caller was authorized for.
                        .scope_unchecked(&AccessScope::for_tenant(tenant))?
                        .exec(tx)
                        .await?;
                    outbox
                        .enqueue(tx, QUEUE, partition, payload, PAYLOAD_TYPE)
                        .await?;
                    Ok(())
                })
            })
            .await?;
        // Wake the sequencer rather than letting a quiet queue wait out its
        // idle interval.
        self.outbox.flush();
        Ok(row)
    }

    /// Ask a run to stop.
    ///
    /// Sets a flag; it does not kill anything. A queued run will not start, and
    /// a running one stops only where its handler checks — see
    /// [`super::dispatch`]. Reported honestly by the endpoint rather than
    /// claimed as done.
    pub async fn cancel(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<entity::Model> {
        let row = self
            .get(ctx, tenant, id)
            .await?
            .ok_or_else(|| anyhow!("run {id} not found"))?;
        let state = RunState::parse(&row.state)?;
        if state.is_terminal() {
            return Err(anyhow!(
                "run {id} already finished as '{}' — there is nothing to cancel",
                row.state
            ));
        }
        // Scoped so the connection is returned before the read below, without
        // a `drop` of something that has no `Drop`.
        {
            let conn = self.db.conn()?;
            entity::Entity::update_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(tenant))
                .filter(Condition::all().add(entity::Column::Id.eq(id)))
                .col_expr(entity::Column::CancelRequested, Expr::value(true))
                .col_expr(
                    entity::Column::UpdatedAt,
                    Expr::value(OffsetDateTime::now_utc()),
                )
                .exec(&conn)
                .await?;
        }
        self.get(ctx, tenant, id)
            .await?
            .ok_or_else(|| anyhow!("run {id} disappeared while being cancelled"))
    }

    /// Put a finished-but-unsuccessful run back on the queue.
    pub async fn retry(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<entity::Model> {
        let row = self
            .get(ctx, tenant, id)
            .await?
            .ok_or_else(|| anyhow!("run {id} not found"))?;
        match RunState::parse(&row.state)? {
            RunState::Succeeded => {
                return Err(anyhow!(
                    "run {id} already succeeded — retrying it would do the work twice"
                ));
            }
            RunState::Queued | RunState::Running => {
                return Err(anyhow!(
                    "run {id} is still {} — it has not given up yet",
                    row.state
                ));
            }
            RunState::Failed | RunState::Cancelled => {}
        }

        // Reset and re-enqueue together: a row that says `queued` with nothing
        // on the queue is work that will never move again.
        let outbox = Arc::clone(&self.outbox);
        let partition = Self::partition_of(row.partition_key.as_deref().unwrap_or(&id.to_string()));
        let payload = encode_payload(tenant, id);
        self.db
            .transaction_ref_mapped::<_, (), anyhow::Error>(move |tx| {
                Box::pin(async move {
                    entity::Entity::update_many()
                        .secure()
                        .scope_with(&AccessScope::for_tenant(tenant))
                        .filter(Condition::all().add(entity::Column::Id.eq(id)))
                        .col_expr(
                            entity::Column::State,
                            Expr::value(RunState::Queued.as_str()),
                        )
                        .col_expr(entity::Column::Attempts, Expr::value(0_i16))
                        .col_expr(entity::Column::LastError, Expr::value(None::<String>))
                        .col_expr(entity::Column::CancelRequested, Expr::value(false))
                        .col_expr(
                            entity::Column::StartedAt,
                            Expr::value(None::<OffsetDateTime>),
                        )
                        .col_expr(
                            entity::Column::FinishedAt,
                            Expr::value(None::<OffsetDateTime>),
                        )
                        .col_expr(
                            entity::Column::UpdatedAt,
                            Expr::value(OffsetDateTime::now_utc()),
                        )
                        .exec(tx)
                        .await?;
                    outbox
                        .enqueue(tx, QUEUE, partition, payload, PAYLOAD_TYPE)
                        .await?;
                    Ok(())
                })
            })
            .await?;
        self.outbox.flush();
        self.get(ctx, tenant, id)
            .await?
            .ok_or_else(|| anyhow!("run {id} disappeared while being re-queued"))
    }

    pub async fn get(
        &self,
        _ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await?)
    }

    async fn find_by_idempotency_key(
        &self,
        tenant: Uuid,
        key: &str,
    ) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::IdempotencyKey.eq(key)))
            .one(&conn)
            .await?)
    }

    pub async fn list(
        &self,
        _ctx: &SecurityContext,
        tenant: Uuid,
        query: &RunQuery,
    ) -> anyhow::Result<Vec<entity::Model>> {
        let mut filter = Condition::all();
        if let Some(state) = query.state {
            filter = filter.add(entity::Column::State.eq(state.as_str()));
        }
        if let Some(task_type) = query.task_type.as_deref() {
            filter = filter.add(entity::Column::TaskType.eq(task_type));
        }
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(filter)
            .order_by(entity::Column::CreatedAt, Order::Desc)
            .limit(query.limit.max(1))
            .all(&conn)
            .await?)
    }
}

/// The full row as an `ActiveModel`. Spelled out rather than derived so a new
/// column cannot be silently left unset on insert.
fn active(row: entity::Model) -> entity::ActiveModel {
    entity::ActiveModel {
        id: ActiveValue::Set(row.id),
        tenant_id: ActiveValue::Set(row.tenant_id),
        task_type: ActiveValue::Set(row.task_type),
        payload: ActiveValue::Set(row.payload),
        partition_key: ActiveValue::Set(row.partition_key),
        state: ActiveValue::Set(row.state),
        attempts: ActiveValue::Set(row.attempts),
        progress: ActiveValue::Set(row.progress),
        summary: ActiveValue::Set(row.summary),
        result: ActiveValue::Set(row.result),
        last_error: ActiveValue::Set(row.last_error),
        cancel_requested: ActiveValue::Set(row.cancel_requested),
        idempotency_key: ActiveValue::Set(row.idempotency_key),
        requested_by: ActiveValue::Set(row.requested_by),
        created_at: ActiveValue::Set(row.created_at),
        updated_at: ActiveValue::Set(row.updated_at),
        started_at: ActiveValue::Set(row.started_at),
        finished_at: ActiveValue::Set(row.finished_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_key_always_lands_on_the_same_partition() {
        let first = TaskService::partition_of("connection-42");
        assert_eq!(first, TaskService::partition_of("connection-42"));
        assert!(first < PARTITIONS);
    }

    #[test]
    fn partitions_are_actually_used() {
        // A hash that mapped everything onto one partition would serialize
        // every tenant's work behind a single processor and still pass the
        // test above.
        let seen: std::collections::BTreeSet<u32> = (0..500)
            .map(|n| TaskService::partition_of(&format!("key-{n}")))
            .collect();
        assert_eq!(seen.len() as u32, PARTITIONS);
    }
}
