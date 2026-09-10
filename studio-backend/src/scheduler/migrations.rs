//! `SeaORM` migrations for the `studio-scheduler` gear.
//!
//! One table. This gear has no queue of its own — it enqueues into
//! `studio-tasks` — so there is no outbox family here.
//!
//! PostgreSQL only, like every other stateful gear in this assembly.

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
        "studio-scheduler migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_scheduler_schedules"
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
CREATE TABLE IF NOT EXISTS studio_scheduler_schedules (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    task_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    expression_kind TEXT NOT NULL CHECK (expression_kind IN ('cron', 'interval')),
    expression TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    concurrency TEXT NOT NULL
        CHECK (concurrency IN ('allow', 'forbid', 'replace')),
    missed_policy TEXT NOT NULL
        CHECK (missed_policy IN ('skip', 'catch_up', 'backfill')),
    max_catch_up_runs SMALLINT NOT NULL DEFAULT 3,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    next_run_at TIMESTAMPTZ NOT NULL,
    last_fired_at TIMESTAMPTZ,
    last_run_id UUID,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A schedule is addressed by name within its tenant: it is what an operator
-- types, and what a platform-level schedule is looked up by on boot so a
-- redeploy does not create a second copy of the nightly sweep.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_scheduler_schedules_name
    ON studio_scheduler_schedules (tenant_id, name);

-- The ticker's only query: enabled rows that are due. Deliberately NOT
-- tenant-scoped — the ticker is one loop for the whole deployment, and a
-- per-tenant index would make it scan.
CREATE INDEX IF NOT EXISTS idx_studio_scheduler_schedules_due
    ON studio_scheduler_schedules (next_run_at)
    WHERE enabled;
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
                .execute_unprepared("DROP TABLE IF EXISTS studio_scheduler_schedules;")
                .await?;
            Ok(())
        }
    }
}
