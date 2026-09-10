//! `SeaORM` entity for the `studio_scheduler_schedules` table.
//!
//! The field names follow the platform's own schedule shape
//! (`gts.cf.core.sless.schedule.v1~`, defined in `serverless-runtime`'s
//! `DESIGN_GTS_SCHEMAS.md`): a `{kind, value}` expression, an IANA `timezone`,
//! and the two policies that decide what happens when firings collide or are
//! missed. That gear is documents-only today and, by its own thin-host ADR,
//! delegates timing to a Temporal-class backend — so this table is not a
//! subset of it. Sharing its vocabulary is what makes a schedule written today
//! migrate later as data rather than as a redesign.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "studio_scheduler_schedules")]
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub tenant_id: Uuid,
    /// Human name, unique within the tenant — how an operator refers to a
    /// schedule, and what a platform-level schedule (a retention sweep) is
    /// looked up by on boot to avoid creating a second one.
    pub name: String,
    /// The task to enqueue. Validated against the handler registry when the
    /// schedule is written, so a typo is a 400 rather than a run that
    /// dead-letters every night.
    pub task_type: String,
    /// The payload the run gets, verbatim.
    pub payload: Json,
    /// `cron` | `interval`.
    pub expression_kind: String,
    /// A 5-field cron expression, or an ISO-8601 duration.
    pub expression: String,
    /// IANA name. Only `UTC` is evaluated today — see [`super::cron`].
    pub timezone: String,
    /// `allow` | `forbid` | `replace` — what to do when the previous run of
    /// this schedule has not finished.
    pub concurrency: String,
    /// `skip` | `catch_up` | `backfill` — what to do about firings that were
    /// due while nothing was running.
    pub missed_policy: String,
    /// Cap on `backfill`, so a week of downtime does not enqueue a week of
    /// nightly imports at once.
    pub max_catch_up_runs: i16,
    /// A disabled schedule keeps its row and its history and fires nothing.
    pub enabled: bool,
    /// When this schedule is next due. The ticker's whole query is "rows whose
    /// `next_run_at` has passed", so this is the index that matters.
    pub next_run_at: OffsetDateTime,
    pub last_fired_at: Option<OffsetDateTime>,
    /// The run the last firing produced, for the concurrency policy and for a
    /// one-hop link from a schedule to what it did.
    pub last_run_id: Option<Uuid>,
    pub created_by: Uuid,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
