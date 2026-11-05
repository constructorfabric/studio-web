//! `SeaORM` migrations for the `studio-product` gear: a product's description
//! by revision (ADR-0053 §1, [`super::descriptions`]).
//!
//! PostgreSQL only (studio-backend/AGENTS.md).

use toolkit_db::sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m0001::Migration), Box::new(m0002::Migration)]
    }
}

mod m0001 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const ONLY_POSTGRES: &str =
        "studio-product migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out: the name is a schema-history key and must survive a rename
    // of this module.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_product_descriptions"
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
-- One row per revision of a project's product description. The primary key is
-- also the save's lock: two saves made against the same revision both try the
-- same next number, and the second is refused.
CREATE TABLE IF NOT EXISTS studio_product_descriptions (
    tenant_id     UUID   NOT NULL,
    project_id    UUID   NOT NULL,
    revision      BIGINT NOT NULL,
    text          TEXT   NOT NULL,
    author        TEXT   NOT NULL,
    created_at_ms BIGINT NOT NULL,
    sha256        TEXT   NOT NULL,
    source        TEXT   NOT NULL DEFAULT 'studio',
    PRIMARY KEY (tenant_id, project_id, revision)
);
-- The reads -- the latest, one revision, the list newest first -- are all
-- `WHERE tenant_id AND project_id ORDER BY revision`, which the key answers.
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
                .execute_unprepared("DROP TABLE IF EXISTS studio_product_descriptions;")
                .await?;
            Ok(())
        }
    }
}

/// Each revision's lock: the commit of every source its text uses, taken at
/// save (ADR-0060 §3).
mod m0002 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0002_studio_product_descriptions_sources_lock"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(
                    "studio-product migrations: only PostgreSQL is supported".to_owned(),
                ));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    "ALTER TABLE studio_product_descriptions ADD COLUMN IF NOT EXISTS sources_lock TEXT NULL;",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared(
                    "ALTER TABLE studio_product_descriptions DROP COLUMN IF EXISTS sources_lock;",
                )
                .await?;
            Ok(())
        }
    }
}
