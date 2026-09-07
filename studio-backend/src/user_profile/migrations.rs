//! SeaORM migrations for the identity gear's four tables.
//!
//! Raw per-backend SQL (Postgres + SQLite), the same approach credstore_pg
//! takes. Primary keys are deterministic v5 UUIDs of the natural key, so the PK
//! itself enforces uniqueness of (provider, subject) / (user_id, org_id) /
//! (kind, external_id); secondary indexes cover the by-user and by-org reads.

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

    const UNSUPPORTED: &str = "studio-user migrations: only PostgreSQL and SQLite are supported";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_identity_tables"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    r"
CREATE TABLE IF NOT EXISTS identity_user (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    display_name TEXT,
    email TEXT,
    avatar_url TEXT,
    locale TEXT,
    merged_into UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS identity_login (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id UUID NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_identity_login_user ON identity_login (user_id);
CREATE TABLE IF NOT EXISTS identity_membership (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    org_id UUID NOT NULL,
    role TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_identity_membership_user ON identity_membership (user_id);
CREATE INDEX IF NOT EXISTS idx_identity_membership_org ON identity_membership (org_id);
CREATE TABLE IF NOT EXISTS identity_alias (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    user_id UUID NOT NULL,
    confidence TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_identity_alias_user ON identity_alias (user_id);
                    "
                }
                sea_orm::DatabaseBackend::Sqlite => {
                    r"
CREATE TABLE IF NOT EXISTS identity_user (
    id BLOB PRIMARY KEY NOT NULL,
    tenant_id BLOB NOT NULL,
    display_name TEXT,
    email TEXT,
    avatar_url TEXT,
    locale TEXT,
    merged_into BLOB,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS identity_login (
    id BLOB PRIMARY KEY NOT NULL,
    tenant_id BLOB NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id BLOB NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT 0,
    linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_identity_login_user ON identity_login (user_id);
CREATE TABLE IF NOT EXISTS identity_membership (
    id BLOB PRIMARY KEY NOT NULL,
    tenant_id BLOB NOT NULL,
    user_id BLOB NOT NULL,
    org_id BLOB NOT NULL,
    role TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_identity_membership_user ON identity_membership (user_id);
CREATE INDEX IF NOT EXISTS idx_identity_membership_org ON identity_membership (org_id);
CREATE TABLE IF NOT EXISTS identity_alias (
    id BLOB PRIMARY KEY NOT NULL,
    tenant_id BLOB NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    user_id BLOB NOT NULL,
    confidence TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_identity_alias_user ON identity_alias (user_id);
                    "
                }
                _ => return Err(DbErr::Custom(UNSUPPORTED.to_owned())),
            };
            manager.get_connection().execute_unprepared(sql).await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = "DROP TABLE IF EXISTS identity_alias; \
                       DROP TABLE IF EXISTS identity_membership; \
                       DROP TABLE IF EXISTS identity_login; \
                       DROP TABLE IF EXISTS identity_user;";
            manager.get_connection().execute_unprepared(sql).await?;
            Ok(())
        }
    }
}
