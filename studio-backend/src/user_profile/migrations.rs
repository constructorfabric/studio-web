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
        vec![
            Box::new(m0001::Migration),
            Box::new(m0002::Migration),
            Box::new(m0003::Migration),
            Box::new(m0004::Migration),
            Box::new(m0005::Migration),
        ]
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

mod m0003 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const UNSUPPORTED: &str = "studio-user migrations: PostgreSQL only";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0003_membership_status"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    // DEFAULT 'active' rather than a nullable column: every row
                    // that exists was written when active was the only state
                    // there was, so that is what it means, and a NULL would
                    // leave every reader to decide what absence meant.
                    r"
ALTER TABLE identity_membership
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
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
                .execute_unprepared("ALTER TABLE identity_membership DROP COLUMN IF EXISTS status;")
                .await?;
            Ok(())
        }
    }
}

mod m0004 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const UNSUPPORTED: &str = "studio-user migrations: PostgreSQL only";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0004_user_ui_preferences"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    // Nullable, with no default: every existing user has made
                    // no UI choices, and NULL says that. An empty object would
                    // claim they had chosen the defaults on purpose, which
                    // matters the day a default changes.
                    r"
ALTER TABLE identity_user
    ADD COLUMN IF NOT EXISTS ui_preferences TEXT;
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
                .execute_unprepared(
                    "ALTER TABLE identity_user DROP COLUMN IF EXISTS ui_preferences;",
                )
                .await?;
            Ok(())
        }
    }
}

mod m0005 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const UNSUPPORTED: &str = "studio-user migrations: PostgreSQL only";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0005_people_profile"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    // Every column is nullable or defaulted: an existing row
                    // has none of these facts recorded, and NULL says so.
                    //
                    // - A sign-in's address is what the identity provider said
                    //   about that login, so one person with several logins has
                    //   several addresses.
                    // - The directory fields belong to the membership, not the
                    //   person: an organization describes its own people and
                    //   sees no other organization's description (ADR-0023).
                    // - The photo is stored here rather than linked, so it is
                    //   served under the same authority as the profile.
                    r"
ALTER TABLE identity_login
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE identity_user
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE identity_membership
    ADD COLUMN IF NOT EXISTS affiliation TEXT,
    ADD COLUMN IF NOT EXISTS department TEXT,
    ADD COLUMN IF NOT EXISTS title TEXT,
    ADD COLUMN IF NOT EXISTS reports_to UUID;
CREATE TABLE IF NOT EXISTS identity_avatar (
    user_id      UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL,
    content_type TEXT NOT NULL,
    bytes        BYTEA NOT NULL,
    digest       TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL
);
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
                .execute_unprepared(
                    r"
DROP TABLE IF EXISTS identity_avatar;
ALTER TABLE identity_membership
    DROP COLUMN IF EXISTS reports_to,
    DROP COLUMN IF EXISTS title,
    DROP COLUMN IF EXISTS department,
    DROP COLUMN IF EXISTS affiliation;
ALTER TABLE identity_user DROP COLUMN IF EXISTS last_seen_at;
ALTER TABLE identity_login
    DROP COLUMN IF EXISTS email_verified,
    DROP COLUMN IF EXISTS email;
                    ",
                )
                .await?;
            Ok(())
        }
    }
}
