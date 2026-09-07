//! `SeaORM` migrations for studio-identity.
//!
//! Raw per-backend SQL (not the schema builder) so the `CHECK` constraints are
//! preserved verbatim — the same approach `studio-documents` and
//! `studio-credstore-pg` take, for the same reason.
//!
//! Two indexes, one per question the gear asks:
//!
//!   * `(tenant, provider, account)` — resolve one external account;
//!   * `(tenant, subject)` — the "my identities" view.
//!
//! Uniqueness of an act needs no index of its own: it is the primary key
//! (see `entity`).

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

    const UNSUPPORTED: &str = "studio-identity migrations: only PostgreSQL and SQLite are \
        supported (this migration set does not target MySQL)";

    pub struct Migration;

    // Spelled out rather than derived: the name is a schema-history key, so it
    // must not silently change if this module is renamed or moved.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_identity_claims"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let statements: [&str; 3] = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => [
                    r"
CREATE TABLE IF NOT EXISTS studio_identity_claims (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
    account TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 320),
    subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 320),
    kind SMALLINT NOT NULL CHECK (kind BETWEEN 0 AND 3),
    method TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '{}',
    author TEXT NOT NULL DEFAULT '',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                    r"CREATE INDEX IF NOT EXISTS idx_studio_identity_claims_account
    ON studio_identity_claims (tenant_id, provider, account);",
                    r"CREATE INDEX IF NOT EXISTS idx_studio_identity_claims_subject
    ON studio_identity_claims (tenant_id, subject);",
                ],
                sea_orm::DatabaseBackend::Sqlite => [
                    r"
CREATE TABLE IF NOT EXISTS studio_identity_claims (
    id BLOB PRIMARY KEY NOT NULL,
    tenant_id BLOB NOT NULL,
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
    account TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 320),
    subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 320),
    kind SMALLINT NOT NULL CHECK (kind BETWEEN 0 AND 3),
    method TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '{}',
    author TEXT NOT NULL DEFAULT '',
    observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                    r"CREATE INDEX IF NOT EXISTS idx_studio_identity_claims_account
    ON studio_identity_claims (tenant_id, provider, account);",
                    r"CREATE INDEX IF NOT EXISTS idx_studio_identity_claims_subject
    ON studio_identity_claims (tenant_id, subject);",
                ],
                // Postgres and SQLite are the only supported engines; MySQL and
                // any future backend fall through to the same error
                // (DatabaseBackend is #[non_exhaustive] in sea-orm 2.0).
                _ => return Err(DbErr::Custom(UNSUPPORTED.to_owned())),
            };

            // One statement per call: `execute_unprepared` runs raw SQL and not
            // every backend accepts several statements in one batch.
            for sql in statements {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if matches!(
                manager.get_database_backend(),
                sea_orm::DatabaseBackend::MySql
            ) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_identity_claims;")
                .await?;
            Ok(())
        }
    }
}
