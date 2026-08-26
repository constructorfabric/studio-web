//! `SeaORM` migrations for the `studio-credstore-pg` gear.
//!
//! Raw per-backend `SQL` (not the schema builder) so the `CHECK` constraint is
//! preserved verbatim — the same approach credstore's own `m0001` takes, for
//! the same reason.

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

    const MYSQL_NOT_SUPPORTED: &str = "studio-credstore-pg migrations: MySQL is not supported \
        (this migration set targets PostgreSQL/SQLite)";

    pub struct Migration;

    // Spelled out rather than derived: the name is a schema-history key, so it
    // must not silently change if this module is ever renamed or moved.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_credstore_values"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    r"
CREATE TABLE IF NOT EXISTS studio_credstore_values (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 255),
    owner_id UUID NOT NULL,
    nonce BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
                    "
                }
                sea_orm::DatabaseBackend::Sqlite => {
                    r"
CREATE TABLE IF NOT EXISTS studio_credstore_values (
    id BLOB PRIMARY KEY NOT NULL,
    tenant_id BLOB NOT NULL,
    reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 255),
    owner_id BLOB NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
                    "
                }
                // Postgres and Sqlite are the only supported engines; MySQL and any
                // future backend fall through to the same unsupported-engine error
                // (DatabaseBackend is #[non_exhaustive] in sea-orm 2.0).
                _ => {
                    return Err(DbErr::Custom(MYSQL_NOT_SUPPORTED.to_owned()));
                }
            };

            manager.get_connection().execute_unprepared(sql).await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let backend = manager.get_database_backend();
            if matches!(backend, sea_orm::DatabaseBackend::MySql) {
                return Err(DbErr::Custom(MYSQL_NOT_SUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_credstore_values;")
                .await?;
            Ok(())
        }
    }
}
