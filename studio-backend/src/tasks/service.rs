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
use toolkit_db::outbox::{Outbox, Record};
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
    /// Hand back a run that is still waiting to start, instead of queueing a
    /// second one, when it has the same task type, partition key and payload.
    ///
    /// For work whose result depends only on when it runs, not on how often it
    /// was asked for: a repository sync asked for twice while the first is
    /// still queued produces the same graph once. Unlike `idempotency_key` it
    /// only ever joins a run that has not started, so asking again after one
    /// began still reads whatever changed meanwhile.
    ///
    /// With an `idempotency_key` too: a waiting run with no key is joined and
    /// takes this key, so a replay after it started still answers it; a
    /// waiting run under a different key is a different intent and is not
    /// joined.
    pub coalesce_queued: bool,
    /// Where to say so when this run ends, if anywhere: the workspace whose IDE
    /// session should be told.
    ///
    /// Carried, not derived. This gear does not read payloads — it runs work,
    /// it does not understand it — and a workspace is not something it could
    /// work out anyway: a run has a tenant, and a tenant is not a session. The
    /// caller knows which workspace its work was for, so the caller says.
    ///
    /// `None` means nobody is told, which is every run with no one waiting in
    /// an editor.
    pub notify_workspace_id: Option<Uuid>,
}

/// Filter for the run listing.
#[derive(Debug, Clone, Default)]
pub struct RunQuery {
    pub state: Option<RunState>,
    pub task_type: Option<String>,
    /// Zero-based index of the first row of the page. Pushed into the SQL, not
    /// applied to a materialised list.
    pub offset: u64,
    pub limit: u64,
}

/// Task types that run on a partition of their own — long, and about a whole
/// tenant rather than one thing in it (see [`TaskService::partition_for`]).
const SOLO_TASK_TYPES: &[&str] = &["catalog.sync"];

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
        // Partition 0 is kept for `SOLO_TASK_TYPES`; every other key spreads
        // over the rest.
        1 + u32::try_from(hash % u64::from(PARTITIONS - 1)).unwrap_or(0)
    }

    /// The partition a run of `task_type` on `key` goes to.
    ///
    /// A partition runs one thing at a time, so two unrelated keys that hash
    /// together wait for each other. For most work that costs seconds. For a
    /// component catalog sync it cost a project's repository sync minutes: on
    /// studio-dev `catalog` and `…:constructorfabric/studio-web` both landed on
    /// partition 0, and a Re-sync sat `queued` for as long as the catalog read
    /// gears-rust. The long, tenant-wide task types get a partition of their
    /// own, so they can hold up nothing but themselves.
    fn partition_for(task_type: &str, key: &str) -> u32 {
        if SOLO_TASK_TYPES.contains(&task_type) {
            0
        } else {
            Self::partition_of(key)
        }
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
        if req.coalesce_queued
            && let Some(existing) = self
                .find_waiting(req.tenant, task_type, req.partition_key, &req.payload)
                .await?
        {
            match (key.as_deref(), existing.idempotency_key.as_deref()) {
                // Nobody asked for repeat-safety: joining is the whole point.
                (None, _) => return Ok(existing),
                (Some(ours), Some(theirs)) if ours == theirs => return Ok(existing),
                // A waiting run that answers to a different key is a different
                // intent. Joining it would leave this key pointing nowhere, so
                // a replay of THIS request would start yet another run.
                (Some(_), Some(_)) => {}
                // Join it and make it answer to our key too, so a replay after
                // it started still finds it by key rather than by waiting.
                (Some(ours), None) => {
                    if let Some(joined) = self.attach_key(req.tenant, existing, ours).await? {
                        return Ok(joined);
                    }
                    // Lost a race for the key: whoever won it — very likely our
                    // own concurrent retry — holds the run to answer with.
                    if let Some(winner) = self.find_by_idempotency_key(req.tenant, ours).await? {
                        return Ok(winner);
                    }
                }
            }
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
            notify_workspace_id: req.notify_workspace_id,
            requested_by: ctx.subject_id(),
            created_at: now,
            updated_at: now,
            started_at: None,
            finished_at: None,
        };
        let partition = Self::partition_for(
            task_type,
            partition_key.as_deref().unwrap_or(&id.to_string()),
        );

        let outbox = Arc::clone(&self.outbox);
        let payload = encode_payload(req.tenant, id);
        let tenant = req.tenant;
        let stored = row.clone();
        let inserted = self
            .db
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
                    let record = Record::to(QUEUE, partition)
                        .payload(payload, PAYLOAD_TYPE)
                        .build()?;
                    outbox.enqueue(tx, record).await?;
                    Ok(())
                })
            })
            .await;
        if let Err(e) = inserted {
            // Two requests with one new key, both past the lookup above (a
            // retry sent while the first was still running): the unique index
            // on (tenant_id, idempotency_key) refuses the second insert. The
            // winner's run is the answer the key promises, not a 500.
            if let Some(k) = row.idempotency_key.as_deref()
                && let Some(winner) = self.find_by_idempotency_key(row.tenant_id, k).await?
            {
                return Ok(winner);
            }
            return Err(e);
        }
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
        let partition = Self::partition_for(
            &row.task_type,
            row.partition_key.as_deref().unwrap_or(&id.to_string()),
        );
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
                    let record = Record::to(QUEUE, partition)
                        .payload(payload, PAYLOAD_TYPE)
                        .build()?;
                    outbox.enqueue(tx, record).await?;
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

    /// A run of `task_type` on `partition_key` with this very payload that has
    /// not started yet, if there is one — see [`NewRun::coalesce_queued`].
    async fn find_waiting(
        &self,
        tenant: Uuid,
        task_type: &str,
        partition_key: Option<&str>,
        payload: &Value,
    ) -> anyhow::Result<Option<entity::Model>> {
        let Some(partition_key) = partition_key.map(str::trim).filter(|k| !k.is_empty()) else {
            return Ok(None);
        };
        let conn = self.db.conn()?;
        let waiting = entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(entity::Column::TaskType.eq(task_type))
                    .add(entity::Column::PartitionKey.eq(partition_key))
                    .add(entity::Column::State.eq(RunState::Queued.as_str()))
                    .add(entity::Column::CancelRequested.eq(false)),
            )
            .all(&conn)
            .await?;
        // A run that answers to no key first: it is the one a keyed request can
        // join (see `enqueue`), and for an unkeyed request any of them will do.
        Ok(waiting
            .into_iter()
            .filter(|run| run.payload == *payload)
            .min_by_key(|run| run.idempotency_key.is_some()))
    }

    /// Give a run that has no idempotency key this one, and hand it back.
    ///
    /// Guarded by `idempotency_key IS NULL`, so a run is never re-keyed: of two
    /// requests racing to attach, one wins and the other gets `None`. The
    /// unique index on `(tenant_id, idempotency_key)` refuses a key another run
    /// already holds, which is also `None` here — the caller then looks the key
    /// up and answers with that run.
    async fn attach_key(
        &self,
        tenant: Uuid,
        run: entity::Model,
        key: &str,
    ) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        let updated = entity::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(entity::Column::Id.eq(run.id))
                    .add(entity::Column::IdempotencyKey.is_null()),
            )
            .col_expr(entity::Column::IdempotencyKey, Expr::value(key))
            .col_expr(
                entity::Column::UpdatedAt,
                Expr::value(OffsetDateTime::now_utc()),
            )
            .exec(&conn)
            .await;
        match updated {
            Ok(result) if result.rows_affected == 1 => Ok(Some(entity::Model {
                idempotency_key: Some(key.to_owned()),
                ..run
            })),
            Ok(_) => Ok(None),
            Err(e) => {
                tracing::warn!(run = %run.id, "studio-tasks: idempotency key not attached ({e:#})");
                Ok(None)
            }
        }
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

    /// One page of runs, newest first, and how many match the filter in total.
    ///
    /// Both halves are SQL. The count is a `COUNT(*)` over the same scoped
    /// filter rather than the length of a list this process built, because the
    /// run table is the one collection here that only ever grows — every
    /// background run this deployment has ever performed is a row — and a
    /// handler that reads it all to answer "how many" would get slower every
    /// day it stays up.
    pub async fn list(
        &self,
        _ctx: &SecurityContext,
        tenant: Uuid,
        query: &RunQuery,
    ) -> anyhow::Result<(Vec<entity::Model>, u64)> {
        let mut filter = Condition::all();
        if let Some(state) = query.state {
            filter = filter.add(entity::Column::State.eq(state.as_str()));
        }
        if let Some(task_type) = query.task_type.as_deref() {
            filter = filter.add(entity::Column::TaskType.eq(task_type));
        }
        let conn = self.db.conn()?;
        // One scoped query, used twice: the clone keeps the tenant scope and
        // the filter identical between the count and the page, which is the
        // property that makes `total` mean anything.
        let scoped = entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(filter);
        let total = scoped.clone().count(&conn).await?;
        let rows = scoped
            .order_by(entity::Column::CreatedAt, Order::Desc)
            .offset(query.offset)
            .limit(query.limit.max(1))
            .all(&conn)
            .await?;
        Ok((rows, total))
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
        notify_workspace_id: ActiveValue::Set(row.notify_workspace_id),
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
        // test above. Every partition but the solo one is in use.
        let seen: std::collections::BTreeSet<u32> = (0..500)
            .map(|n| TaskService::partition_of(&format!("key-{n}")))
            .collect();
        assert_eq!(seen.len() as u32, PARTITIONS - 1);
        assert!(!seen.contains(&0));
    }

    /// The collision that held a Re-sync behind a catalog sync on studio-dev:
    /// both keys hashed to partition 0. A catalog sync now has partition 0 to
    /// itself, and nothing else can land there.
    #[test]
    fn a_catalog_sync_never_shares_a_partition_with_other_work() {
        let catalog = TaskService::partition_for("catalog.sync", "catalog");
        assert_eq!(catalog, 0);
        let studio_web = "github:studio-connection-ddff5557-2231-4b27-bbf5-312805d5934e:\
                          349c7f25-2566-42eb-87a2-4b490bbbaab6:constructorfabric/studio-web";
        for key in ["catalog", studio_web, "connection-42"] {
            assert_ne!(TaskService::partition_for("artifact.ingest", key), catalog);
        }
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod pg_tests;
