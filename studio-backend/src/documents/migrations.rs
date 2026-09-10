//! `SeaORM` migrations for studio-documents.
//!
//! Raw SQL (not the schema builder) so the `CHECK`/`UNIQUE` constraints are
//! preserved verbatim.
//!
//! **PostgreSQL only.** The gear used to carry a parallel SQLite dialect so a
//! test could run without a server; the assembly runs a single Postgres for
//! every gear database (`graph-postgres` in `docker-compose.yml`), so a second
//! dialect bought nothing and cost a real bug: `ADD COLUMN IF NOT EXISTS` is a
//! Postgres extension SQLite does not have, and booleans default `FALSE` here
//! and `0` there. One dialect, one set of statements, and the tests run against
//! the database the product actually uses.

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
            Box::new(m0006::Migration),
        ]
    }
}

/// The backend a migration set refuses to run on. Kept as one message so every
/// migration reports the same thing.
const UNSUPPORTED: &str = "studio-documents migrations: PostgreSQL only (see the module docs)";

/// True when the connected backend is the one these statements are written for.
fn is_postgres(manager: &SchemaManager) -> bool {
    matches!(
        manager.get_database_backend(),
        toolkit_db::sea_orm_migration::sea_orm::DatabaseBackend::Postgres
    )
}

mod m0001 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_documents"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            // One statement per call: `execute_unprepared` runs raw SQL and not
            // every backend accepts several statements in one batch.
            for sql in [
                r"
CREATE TABLE IF NOT EXISTS studio_document_types (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    gts_type_id TEXT NOT NULL,
    template TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, key)
);",
                r"
CREATE TABLE IF NOT EXISTS studio_documents (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID,
    type_key TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    status SMALLINT NOT NULL DEFAULT 0,
    conforms BOOLEAN NOT NULL DEFAULT FALSE,
    validation TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_documents_tenant_project
    ON studio_documents (tenant_id, project_id);",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            for sql in [
                "DROP TABLE IF EXISTS studio_documents;",
                "DROP TABLE IF EXISTS studio_document_types;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}

/// A document type may hide the key it overrides instead of replacing it.
///
/// One column, because the table already carries everything else the
/// three-level catalogue needs: rows are keyed `(tenant_id, key)` and
/// `tenant_id` was never constrained to a workspace, so an organization-owned
/// entry is a row like any other (ADR-0014 section 4).
///
/// `DEFAULT FALSE` is what makes this a non-event for existing data: every row
/// written before this migration meant "replace", and that is what it keeps
/// meaning.
mod m0002 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0002_document_type_tombstones"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"ALTER TABLE studio_document_types
    ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    "ALTER TABLE studio_document_types DROP COLUMN IF EXISTS hidden;",
                )
                .await?;
            Ok(())
        }
    }
}

/// The journey-stage catalogue gets a table of its own.
///
/// Not a discriminator column on `studio_document_types`: the two catalogues
/// share resolution rules, not columns -- a stage has an order and a list of
/// required document types, a type has a template and a questionnaire, and
/// neither set is ever null for the other by accident.
mod m0003 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0003_process_stages"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"
CREATE TABLE IF NOT EXISTS studio_process_stages (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
    label TEXT NOT NULL,
    required BOOLEAN NOT NULL DEFAULT FALSE,
    ordinal INTEGER NOT NULL DEFAULT 0,
    requires TEXT NOT NULL DEFAULT '[]',
    hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, key)
);",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_process_stages;")
                .await?;
            Ok(())
        }
    }
}

/// The capability vocabulary gets a table, for the same reason stages did.
mod m0004 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0004_process_capabilities"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"
CREATE TABLE IF NOT EXISTS studio_process_capabilities (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
    label TEXT NOT NULL,
    terms TEXT NOT NULL DEFAULT '[]',
    hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, key)
);",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_process_capabilities;")
                .await?;
            Ok(())
        }
    }
}

/// A document records the capabilities it declares.
///
/// An INDEX over the document's own front matter, re-derived on every write --
/// not a second place to store them (see `intake`). It exists so the composer
/// can ask "which documents seed `billing`" without reading and parsing every
/// document body.
mod m0005 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0005_document_capabilities"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"ALTER TABLE studio_documents
    ADD COLUMN IF NOT EXISTS capabilities TEXT NOT NULL DEFAULT '[]';",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    "ALTER TABLE studio_documents DROP COLUMN IF EXISTS capabilities;",
                )
                .await?;
            Ok(())
        }
    }
}

/// Somewhere for a spec-quality verdict to live, and a way for a stage to
/// require one.
///
/// `studio-spec-quality` is a stateless passthrough: it submits to the upstream
/// and forwards the poll, and nothing kept the answer. So "the documentation
/// passed analysis" was not expressible in data and no stage could depend on it.
///
/// The foreign key is `ON DELETE CASCADE` on purpose. A verdict about a document
/// that no longer exists is not data, it is litter, and putting the rule in the
/// schema means it holds for every path that deletes a document rather than for
/// the one that remembered to.
mod m0006 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0006_document_analyses"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            for sql in [
                r"
CREATE TABLE IF NOT EXISTS studio_document_analyses (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    document_id UUID NOT NULL
        REFERENCES studio_documents (id) ON DELETE CASCADE,
    detector TEXT NOT NULL CHECK (length(detector) BETWEEN 1 AND 80),
    state TEXT NOT NULL,
    task_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (document_id, detector)
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_document_analyses_tenant
    ON studio_document_analyses (tenant_id, document_id);",
                r"ALTER TABLE studio_process_stages
    ADD COLUMN IF NOT EXISTS gates TEXT NOT NULL DEFAULT '[]';",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            for sql in [
                "DROP TABLE IF EXISTS studio_document_analyses;",
                "ALTER TABLE studio_process_stages DROP COLUMN IF EXISTS gates;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}
