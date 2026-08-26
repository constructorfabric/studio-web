//! Per-tenant write counter.
//!
//! `GraphStats::graph_revision` is documented as a monotonic revision bumped
//! whenever stored state changes, and until this migration it returned the
//! literal zero — a field a consumer could poll forever. The counter lives in
//! its own table rather than being derived from `max(updated_at)`, because a
//! deletion lowers that maximum and would make the revision go backwards.
//!
//! One row per tenant, created on first write. The row is bumped inside the
//! same transaction as the write it describes, so a revision a caller has
//! observed always corresponds to committed data.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::ConnectionTrait;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r"
CREATE TABLE IF NOT EXISTS graph_revision (
    tenant_id  UUID        NOT NULL PRIMARY KEY,
    revision   BIGINT      NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
                ",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS graph_revision;")
            .await?;
        Ok(())
    }
}
