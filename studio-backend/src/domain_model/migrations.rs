//! `SeaORM` migrations for the domain read model (see [`super::mirror`]).
//!
//! PostgreSQL only, like every gear database in this assembly: the query
//! compiles to jsonb operators, and ids order by byte (`COLLATE "C"`), which is
//! how the in-memory path orders them.

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
        "studio-domain-model migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out: the name is a schema-history key and must survive a rename
    // of this module.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_domain_read_model"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(ONLY_POSTGRES.to_owned()));
            }
            for sql in [
                r#"
-- One row per live domain object: the payload a graph read returns, and the
-- columns a query narrows by before it reads one (ADR-0051 §1).
CREATE TABLE IF NOT EXISTS studio_domain_objects (
    tenant_id     UUID   NOT NULL,
    instance_id   TEXT   COLLATE "C" NOT NULL,
    type_id       TEXT   NOT NULL,
    owner_id      UUID   NOT NULL,
    scope         TEXT   NOT NULL DEFAULT '',
    payload       JSONB  NOT NULL DEFAULT '{}'::jsonb,
    updated_at_ms BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, instance_id)
)
"#,
                r"
CREATE INDEX IF NOT EXISTS studio_domain_objects_type
    ON studio_domain_objects (tenant_id, type_id, owner_id)
",
                r"
CREATE INDEX IF NOT EXISTS studio_domain_objects_payload
    ON studio_domain_objects USING GIN (payload jsonb_path_ops)
",
                r#"
-- One row per relation, with the declared relation it is, so two relations of
-- one verb stay apart and either end can be read by index.
CREATE TABLE IF NOT EXISTS studio_domain_edges (
    tenant_id    UUID NOT NULL,
    edge_type_id TEXT NOT NULL,
    src          TEXT COLLATE "C" NOT NULL,
    dst          TEXT COLLATE "C" NOT NULL,
    relation     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (tenant_id, edge_type_id, src, dst, relation)
)
"#,
                r"
CREATE INDEX IF NOT EXISTS studio_domain_edges_dst
    ON studio_domain_edges (tenant_id, edge_type_id, dst)
",
                r"
-- Which tenants the read model is complete for. Absent = read the graph.
CREATE TABLE IF NOT EXISTS studio_domain_fill (
    tenant_id    UUID   PRIMARY KEY,
    filled_at_ms BIGINT NOT NULL,
    objects      BIGINT NOT NULL,
    edges        BIGINT NOT NULL
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
                "DROP TABLE IF EXISTS studio_domain_fill",
                "DROP TABLE IF EXISTS studio_domain_edges",
                "DROP TABLE IF EXISTS studio_domain_objects",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}
