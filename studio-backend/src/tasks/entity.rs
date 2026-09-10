//! `SeaORM` entity for the `studio_tasks_runs` table.
//!
//! One row per unit of background work: what was asked, where it got to, and
//! why it stopped. This is the durable replacement for the three in-memory
//! `TaskRegistry` maps this gear absorbs (`connectors::graph_sync_tasks`,
//! `artifact_ingest::tasks`, `components_catalog::tasks`), each of which lost
//! everything on restart and answered "no such task" to a poll that arrived a
//! second after a redeploy.
//!
//! The queue is separate and is not ours: the `studio_tasks_outbox_*` family
//! belongs to `toolkit-db`. The queue payload carries a tenant and a run id;
//! everything a person or a handler needs to read is here.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "studio_tasks_runs")]
// `no_owner`: a run belongs to the tenant. `requested_by` is audit, not an
// authorization dimension — a colleague must be able to see why last night's
// import failed.
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub tenant_id: Uuid,
    /// `<gear>.<verb>`, resolved against the handler registry at dispatch.
    pub task_type: String,
    /// The handler's own input. Opaque here on purpose: this gear runs work, it
    /// does not understand it.
    pub payload: Json,
    /// What the queue partition was derived from, recorded so a support
    /// question about ordering can be answered without re-deriving it. `None`
    /// means the run id was used, i.e. no ordering was asked for.
    pub partition_key: Option<String>,
    /// `queued` | `running` | `succeeded` | `failed` | `cancelled`.
    pub state: String,
    pub attempts: i16,
    /// The phase a running task last reported. Kept after the run ends: the
    /// last phase before a failure is usually the whole diagnosis.
    pub progress: Option<String>,
    /// One line about what the run did, once it succeeded. For a person.
    pub summary: Option<String>,
    /// The handler's own structured result, if it has one — counts from an
    /// import, ids a caller needs. For a program: the shape belongs to the task
    /// type, not to this gear, which is why it is opaque here.
    pub result: Option<Json>,
    pub last_error: Option<String>,
    /// Set by the cancel endpoint. Cooperative — the dispatcher will not start
    /// a run that carries it, and a running handler sees it through its
    /// cancellation token, but a handler that never looks cannot be stopped.
    pub cancel_requested: bool,
    /// Makes a repeated enqueue a no-op. The scheduler sets it to
    /// `<schedule_id>:<scheduled_for>`, which is what turns an at-least-once
    /// firing into an exactly-once run.
    pub idempotency_key: Option<String>,
    pub requested_by: Uuid,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    /// When a handler first picked it up. `None` while queued.
    pub started_at: Option<OffsetDateTime>,
    pub finished_at: Option<OffsetDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
