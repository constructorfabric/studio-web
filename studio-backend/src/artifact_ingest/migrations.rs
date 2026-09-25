//! `SeaORM` migrations for the artifact index (see [`super::index`]).
//!
//! PostgreSQL only, like every gear database in this assembly: the ordering
//! the listing promises is byte order, which is spelled `COLLATE "C"` here and
//! would be a different promise on any other engine.

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
        "studio-artifact-ingest migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out: the name is a schema-history key and must survive a rename
    // of this module.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_artifact_index"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(ONLY_POSTGRES.to_owned()));
            }
            // One statement per call: `execute_unprepared` runs raw SQL and not
            // every driver accepts several statements in one batch.
            for sql in [
                r#"
-- One row per artifact node, carrying the payload fields the listings narrow
-- and order by as columns. The payload beside them is the one a graph read
-- would return, so a page is answered from here without touching the graph.
--
-- `COLLATE "C"` on the two ordering columns: the listing has always ordered
-- by byte comparison (instance ids, ISO-8601 timestamps), and a locale
-- collation ignores the dashes in a uuid at the first level, which would
-- reorder pages against what the in-process path returns.
CREATE TABLE IF NOT EXISTS studio_artifact_index (
    tenant_id    UUID    NOT NULL,
    instance_id  TEXT    COLLATE "C" NOT NULL,
    type_id      TEXT    NOT NULL,
    workspace_id TEXT    NOT NULL DEFAULT '',
    project_id   TEXT    NOT NULL DEFAULT '',
    repo         TEXT    NOT NULL DEFAULT '',
    path         TEXT    NOT NULL DEFAULT '',
    is_dir       BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TEXT    COLLATE "C" NOT NULL DEFAULT '',
    search_text  TEXT    NOT NULL DEFAULT '',
    payload      JSONB   NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_id, instance_id)
)
"#,
                // A scope is a workspace OR a project, so each half of that OR
                // gets its own index and the planner combines them.
                r"
CREATE INDEX IF NOT EXISTS studio_artifact_index_workspace
    ON studio_artifact_index (tenant_id, workspace_id, type_id)
",
                r"
CREATE INDEX IF NOT EXISTS studio_artifact_index_project
    ON studio_artifact_index (tenant_id, project_id, type_id)
",
                r"
-- Which tenants the index is complete for. Absent = not yet (or no longer)
-- trustworthy, and readers go to the graph until a fill writes this row.
CREATE TABLE IF NOT EXISTS studio_artifact_index_fill (
    tenant_id    UUID   PRIMARY KEY,
    filled_at_ms BIGINT NOT NULL,
    nodes        BIGINT NOT NULL
)
",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(ONLY_POSTGRES.to_owned()));
            }
            for sql in [
                "DROP TABLE IF EXISTS studio_artifact_index_fill",
                "DROP TABLE IF EXISTS studio_artifact_index",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}
