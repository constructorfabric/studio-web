//! `SeaORM` migrations for the `studio-tasks` gear.
//!
//! Only the run-history table. The queue's tables — the
//! `studio_tasks_outbox_*` family — are `toolkit-db`'s, created by
//! [`toolkit_db::outbox::outbox_migrations_with_prefix`] and listed alongside
//! these by the gear's `DatabaseCapability`. Both live in this gear's database,
//! which is what lets one transaction write a run and enqueue it together.
//!
//! PostgreSQL only, for the reason the outbox itself is: its partition locking
//! is `FOR UPDATE SKIP LOCKED`, which SQLite has nothing to offer.

use toolkit_db::sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m0001::Migration)]
    }
}

mod m0001 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const ONLY_POSTGRES: &str =
        "studio-tasks migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out: the name is a schema-history key and must survive a rename
    // of this module.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_tasks_runs"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(ONLY_POSTGRES.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"
CREATE TABLE IF NOT EXISTS studio_tasks_runs (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    task_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    partition_key TEXT,
    state TEXT NOT NULL
        CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    attempts SMALLINT NOT NULL DEFAULT 0,
    progress TEXT,
    summary TEXT,
    result JSONB,
    last_error TEXT,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    idempotency_key TEXT,
    requested_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

-- The listing every operator screen starts from: one tenant, newest first.
CREATE INDEX IF NOT EXISTS idx_studio_tasks_runs_tenant_created
    ON studio_tasks_runs (tenant_id, created_at DESC);

-- 'succeeded' is most of the table and the least interesting; the index that
-- answers 'what is stuck or broken' leaves it out.
CREATE INDEX IF NOT EXISTS idx_studio_tasks_runs_unfinished
    ON studio_tasks_runs (tenant_id, state)
    WHERE state <> 'succeeded';

-- 'how did this task type behave lately', per tenant.
CREATE INDEX IF NOT EXISTS idx_studio_tasks_runs_type
    ON studio_tasks_runs (tenant_id, task_type, created_at DESC);

-- What makes a repeated enqueue — a caller's retry, a scheduler firing twice
-- after a crash — one run instead of two. Partial, so opting out does not
-- collide with every other opt-out.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_tasks_runs_idempotency
    ON studio_tasks_runs (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
                    ",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(ONLY_POSTGRES.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_tasks_runs;")
                .await?;
            Ok(())
        }
    }
}
