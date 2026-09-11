//! SeaORM migrations for the identity gear's four tables.
//!
//! Raw SQL, the same approach credstore_pg takes. Primary keys are
//! deterministic v5 UUIDs of the natural key, so the PK itself enforces
//! uniqueness of (provider, subject) / (user_id, org_id) / (kind,
//! external_id); secondary indexes cover the by-user and by-org reads.
//!
//! **PostgreSQL only.** A parallel SQLite dialect used to sit beside this one
//! so `dev.yaml` could run the gear without a server. Nothing executed it in
//! production and no test covered it, and it had already drifted: `verified`
//! defaulted `FALSE` in one spelling and `0` in the other. That is the drift
//! that cost studio-documents a migration, found there and not here only
//! because there it was tested.

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

    const UNSUPPORTED: &str = "studio-user migrations: PostgreSQL only";

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

mod m0002 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const UNSUPPORTED: &str = "studio-user migrations: PostgreSQL only";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0002_invitation"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    // The digest is UNIQUE because a token must identify exactly
                    // one invitation; the index is also the lookup an acceptance
                    // does. The org index is "what have I sent", which is the
                    // only other way this table is read.
                    r"
CREATE TABLE IF NOT EXISTS identity_invitation (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    org_id UUID NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_digest TEXT NOT NULL,
    invited_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    accepted_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_invitation_token
    ON identity_invitation (token_digest);
CREATE INDEX IF NOT EXISTS idx_identity_invitation_org
    ON identity_invitation (org_id);
CREATE INDEX IF NOT EXISTS idx_identity_invitation_email
    ON identity_invitation (email);
                    "
                }
                _ => return Err(DbErr::Custom(UNSUPPORTED.to_owned())),
            };
            manager.get_connection().execute_unprepared(sql).await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS identity_invitation;")
                .await?;
            Ok(())
        }
    }
}
