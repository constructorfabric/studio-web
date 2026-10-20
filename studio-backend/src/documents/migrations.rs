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
            Box::new(m0007::Migration),
            Box::new(m0008::Migration),
            Box::new(m0009::Migration),
            Box::new(m0010::Migration),
            Box::new(m0011::Migration),
            Box::new(m0012::Migration),
            Box::new(m0013::Migration),
            Box::new(m0014::Migration),
            Box::new(m0015::Migration),
            Box::new(m0016::Migration),
            Box::new(m0017::Migration),
            Box::new(m0018::Migration),
            Box::new(m0019::Migration),
            Box::new(m0020::Migration),
            Box::new(m0021::Migration),
            Box::new(m0022::Migration),
            Box::new(m0023::Migration),
            Box::new(m0024::Migration),
            Box::new(m0025::Migration),
            Box::new(m0026::Migration),
            Box::new(m0027::Migration),
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

/// Bindings between ingested graph files and document types: the repository
/// that already had documents in it when the project connected to it.
mod m0007 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0007_document_bindings"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            // `id` is uuid5 of (tenant, project, node_id), so the primary key
            // IS the uniqueness constraint — no UNIQUE over a nullable
            // project_id, whose NULLs Postgres treats as distinct.
            for sql in [
                r"
CREATE TABLE IF NOT EXISTS studio_document_bindings (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID,
    node_id TEXT NOT NULL,
    path TEXT NOT NULL,
    type_key TEXT,
    state TEXT NOT NULL
        CHECK (state IN ('detected','confirmed','manual','unknown','not_a_document')),
    confidence REAL,
    source TEXT
        CHECK (source IS NULL OR source IN ('front_matter','heuristic','spec_quality','manual')),
    candidates TEXT NOT NULL DEFAULT '[]',
    conforms BOOLEAN,
    validation TEXT NOT NULL DEFAULT '{}',
    content_sha TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_document_bindings_tenant_project
    ON studio_document_bindings (tenant_id, project_id);",
                // The review queue reads "everything still undecided" first.
                r"CREATE INDEX IF NOT EXISTS idx_studio_document_bindings_state
    ON studio_document_bindings (tenant_id, state);",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_document_bindings;")
                .await?;
            Ok(())
        }
    }
}

/// A detector's verdict is about a document — and a document is now either one
/// Studio holds or a repository file someone bound to a type. Same verdict,
/// same table, one nullable subject column each and a CHECK that exactly one of
/// them is set.
mod m0008 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0008_analyses_of_bound_files"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            for sql in [
                "ALTER TABLE studio_document_analyses ALTER COLUMN document_id DROP NOT NULL;",
                r"ALTER TABLE studio_document_analyses
    ADD COLUMN IF NOT EXISTS binding_id UUID
        REFERENCES studio_document_bindings (id) ON DELETE CASCADE;",
                // Exactly one subject. A row about both, or about neither, is
                // a verdict nothing can read back -- and it would still count
                // against a stage gate.
                r"ALTER TABLE studio_document_analyses
    DROP CONSTRAINT IF EXISTS studio_document_analyses_one_subject;",
                r"ALTER TABLE studio_document_analyses
    ADD CONSTRAINT studio_document_analyses_one_subject CHECK (
        (document_id IS NOT NULL AND binding_id IS NULL)
     OR (document_id IS NULL AND binding_id IS NOT NULL)
    );",
                // `UNIQUE (document_id, detector)` from m0006 still holds for
                // document rows; NULLs are distinct in Postgres, so it says
                // nothing about binding rows and they need their own.
                r"CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_document_analyses_binding_detector
    ON studio_document_analyses (binding_id, detector)
    WHERE binding_id IS NOT NULL;",
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
                "DROP INDEX IF EXISTS uq_studio_document_analyses_binding_detector;",
                r"ALTER TABLE studio_document_analyses
    DROP CONSTRAINT IF EXISTS studio_document_analyses_one_subject;",
                "DELETE FROM studio_document_analyses WHERE document_id IS NULL;",
                "ALTER TABLE studio_document_analyses DROP COLUMN IF EXISTS binding_id;",
                "ALTER TABLE studio_document_analyses ALTER COLUMN document_id SET NOT NULL;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}

/// The catalogue narrowed to the five document types Spec Quality analyses, so
/// the two that are gone have to take their rows with them.
///
/// `app_spec` became `prd`: same questionnaire, same sections, the name the
/// rest of the industry uses — and, not incidentally, a name the detectors
/// know, which the intake document never had. `upstream_reqs` had no
/// questionnaire and no detector; what it recorded belongs in the PRD's
/// Overview, so its documents land there too rather than being deleted for
/// tidiness.
///
/// A workspace's OWN row for one of those keys is its customisation of a
/// built-in that no longer exists. It is re-keyed when the workspace has no
/// `prd` row of its own — losing somebody's edited template to a rename would
/// be the worse outcome — and dropped when it does, because then the
/// customisation it overrides is already there under the right name.
///
/// That first half was wrong: such a row SHADOWS the built-in rather than
/// sitting beside it, so the rename handed the workspace a `prd` that is not
/// one. `m0010` deletes what this re-keyed. This migration is left as it ran.
///
/// `down` cannot restore what a key meant, only what it was called, so it does
/// not try: the split of `prd` back into two types is not a migration, it is a
/// product decision that was made and then unmade.
mod m0009 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0009_five_document_types"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            for sql in [
                // The intake type first: where a workspace customised both, its
                // App Spec row is the one worth keeping under the new name.
                r"UPDATE studio_document_types t
    SET key = 'prd', updated_at = CURRENT_TIMESTAMP
  WHERE t.key = 'app_spec'
    AND NOT EXISTS (
        SELECT 1 FROM studio_document_types o
         WHERE o.tenant_id = t.tenant_id AND o.key = 'prd'
    );",
                r"UPDATE studio_document_types t
    SET key = 'prd', updated_at = CURRENT_TIMESTAMP
  WHERE t.key = 'upstream_reqs'
    AND NOT EXISTS (
        SELECT 1 FROM studio_document_types o
         WHERE o.tenant_id = t.tenant_id AND o.key = 'prd'
    );",
                "DELETE FROM studio_document_types WHERE key IN ('app_spec', 'upstream_reqs');",
                r"UPDATE studio_documents
    SET type_key = 'prd', updated_at = CURRENT_TIMESTAMP
  WHERE type_key IN ('app_spec', 'upstream_reqs');",
                // A binding's conformance was computed against the template it
                // named. That template is gone, so the verdict is about nothing
                // and is cleared rather than left to describe the wrong type;
                // the next decision or sync recomputes it.
                r"UPDATE studio_document_bindings
    SET type_key = 'prd', conforms = NULL, validation = '{}',
        updated_at = CURRENT_TIMESTAMP
  WHERE type_key IN ('app_spec', 'upstream_reqs');",
                // A stage gate that waits for a type nobody can produce any
                // more is a stage that never opens.
                r"UPDATE studio_process_stages
    SET requires = (
        SELECT COALESCE(
                   jsonb_agg(DISTINCT CASE
                       WHEN v IN ('app_spec', 'upstream_reqs') THEN 'prd' ELSE v
                   END),
                   '[]'::jsonb
               )::text
          FROM jsonb_array_elements_text(requires::jsonb) AS t(v)
    ),
        updated_at = CURRENT_TIMESTAMP
  WHERE requires::jsonb ?| array['app_spec', 'upstream_reqs'];",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
            Ok(())
        }
    }
}

/// `m0009` re-keyed a workspace's own row for a removed type instead of
/// dropping it, and that was the wrong call.
///
/// The reasoning there was that losing somebody's edited template to a rename
/// is worse than keeping it. It is not, because a row in this table does not
/// sit beside the built-in — it SHADOWS it. A workspace that had customised
/// `upstream_reqs` came out of that migration with a `prd` whose template is
/// Upstream Requirements: no questionnaire, no required PRD sections, and so
/// no capabilities for the Composer and nothing for `classify` to recognise a
/// real PRD by. Found by reading the live catalogue back off a stand after the
/// migration ran, where `prd` answered to the name "Upstream Requirements".
///
/// So those rows go. What is lost is a workspace's wording of a template for a
/// type that no longer exists; what is regained is the PRD every other part of
/// the product assumes. The name is what identifies them — no one names their
/// PRD "Upstream Requirements" — and both migrations are kept rather than
/// `m0009` being edited, because `m0009` has already run where this matters.
mod m0010 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0010_a_renamed_row_must_not_shadow_the_prd"
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
                    r"DELETE FROM studio_document_types
  WHERE key = 'prd' AND name IN ('Upstream Requirements', 'App Spec');",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
            Ok(())
        }
    }
}

/// A bound repository file records the capabilities it declares.
///
/// The same index `m0005` gave an authored document, for the same reason: the
/// Composer asks "what does this project need" of every document the project
/// has, and until now a PRD kept in the repository -- the ordinary case for a
/// team that writes its specs next to its code -- answered nothing, however
/// clearly its front matter said `capabilities: auth, storage`.
mod m0011 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0011_binding_capabilities"
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
                    r"ALTER TABLE studio_document_bindings
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
                    "ALTER TABLE studio_document_bindings DROP COLUMN IF EXISTS capabilities;",
                )
                .await?;
            Ok(())
        }
    }
}

/// A capability names the contracts that satisfy it.
///
/// The composer matches these against what the Gearbox engine reports each
/// gear as providing, before it searches gear prose with `terms`
/// (`cpt-studio-fr-spec-gear-mapping`). An empty array leaves the entry
/// matched by search alone, as it was before.
mod m0012 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0012_capability_contracts"
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
                    r"ALTER TABLE studio_process_capabilities
    ADD COLUMN IF NOT EXISTS contracts TEXT NOT NULL DEFAULT '[]';",
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
                    "ALTER TABLE studio_process_capabilities DROP COLUMN IF EXISTS contracts;",
                )
                .await?;
            Ok(())
        }
    }
}

/// A document, and a bound file, record the non-functional statements they make.
///
/// The same index `capabilities` is, and for the same reason: the composer
/// asks what a project needs of every document it has, and reading every body
/// for it would be the walk the index exists to avoid. What these statements
/// shape is the product's deployment profile, never its gears
/// (`cpt-studio-fr-nfr-to-profile`).
mod m0013 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0013_document_requirements"
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
    ADD COLUMN IF NOT EXISTS requirements TEXT NOT NULL DEFAULT '[]';
ALTER TABLE studio_document_bindings
    ADD COLUMN IF NOT EXISTS requirements TEXT NOT NULL DEFAULT '[]';
ALTER TABLE studio_process_capabilities
    ADD COLUMN IF NOT EXISTS nonfunctional BOOLEAN NOT NULL DEFAULT FALSE;",
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
                    "ALTER TABLE studio_documents DROP COLUMN IF EXISTS requirements;
ALTER TABLE studio_document_bindings DROP COLUMN IF EXISTS requirements;
ALTER TABLE studio_process_capabilities DROP COLUMN IF EXISTS nonfunctional;",
                )
                .await?;
            Ok(())
        }
    }
}

/// A document, and a bound file, record the capabilities their functional
/// requirements imply when their front matter declares none.
///
/// Most specs in a real repository carry no `capabilities:` line, so without
/// this the composer had nothing to ask about a project whose PRDs were plain
/// markdown (constructorfabric/insight on Dev, 2026-10-07: 11 PRDs, 0
/// capabilities). Kept apart from `capabilities` because it is a proposal, and
/// the screens say so.
mod m0014 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0014_inferred_capabilities"
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
    ADD COLUMN IF NOT EXISTS inferred_capabilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE studio_document_bindings
    ADD COLUMN IF NOT EXISTS inferred_capabilities TEXT NOT NULL DEFAULT '[]';",
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
                    "ALTER TABLE studio_documents DROP COLUMN IF EXISTS inferred_capabilities;
ALTER TABLE studio_document_bindings DROP COLUMN IF EXISTS inferred_capabilities;",
                )
                .await?;
            Ok(())
        }
    }
}

/// What a model read out of each document revision of a project
/// (`docs/spec-domain-model.md`). One row per (project, path, revision,
/// extractor version): an unchanged document is never asked about twice, and
/// a new prompt asks again.
mod m0015 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0015_spec_model_extractions"
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
CREATE TABLE IF NOT EXISTS studio_spec_model_extractions (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    path TEXT NOT NULL,
    revision TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    facts TEXT NOT NULL DEFAULT '[]',
    dropped INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, path, revision, extractor_version)
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_spec_model_extractions_project
    ON studio_spec_model_extractions (tenant_id, project_id);",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_spec_model_extractions;")
                .await?;
            Ok(())
        }
    }
}

/// What the judge said about each candidate of a project's spec model, per
/// revision of the documents on its sides, and what members decided about
/// the findings (`docs/spec-domain-model.md`).
mod m0016 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0016_spec_model_judgements_and_decisions"
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
CREATE TABLE IF NOT EXISTS studio_spec_model_judgements (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    fingerprint TEXT NOT NULL,
    revisions TEXT NOT NULL,
    judge_version TEXT NOT NULL,
    conflict BOOLEAN NOT NULL,
    finding TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, fingerprint, revisions, judge_version)
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_spec_model_judgements_project
    ON studio_spec_model_judgements (tenant_id, project_id);",
                r"
CREATE TABLE IF NOT EXISTS studio_spec_model_decisions (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    fingerprint TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'dismissed')),
    decided_by UUID NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, fingerprint)
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_spec_model_decisions_project
    ON studio_spec_model_decisions (tenant_id, project_id);",
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
                "DROP TABLE IF EXISTS studio_spec_model_decisions;",
                "DROP TABLE IF EXISTS studio_spec_model_judgements;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}

/// What members decided about a project's glossary: the name an entry goes
/// by, and which entry is another name of which
/// (`docs/project-and-product.md`, "The project's words").
mod m0017 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0017_spec_model_terms"
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
CREATE TABLE IF NOT EXISTS studio_spec_model_terms (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    term_key TEXT NOT NULL,
    name TEXT,
    alias_of TEXT,
    decided_by UUID NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, term_key)
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_spec_model_terms_project
    ON studio_spec_model_terms (tenant_id, project_id);",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_spec_model_terms;")
                .await?;
            Ok(())
        }
    }
}

/// Review requests and the approvals given on them (`approvals.rs`). An
/// approval is a record: there is no update path, and the table has no
/// column a later verdict would overwrite.
mod m0018 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0018_review_requests_and_approvals"
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
CREATE TABLE IF NOT EXISTS studio_review_requests (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('document', 'binding')),
    subject_id UUID NOT NULL,
    type_key TEXT,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_by_name TEXT,
    reviewers JSONB NOT NULL,
    due_at TIMESTAMPTZ,
    state TEXT NOT NULL CHECK (state IN ('open', 'approved', 'superseded', 'withdrawn')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_review_requests_project
    ON studio_review_requests (tenant_id, project_id, subject_id);",
                r"
CREATE TABLE IF NOT EXISTS studio_approvals (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    request_id UUID NOT NULL REFERENCES studio_review_requests (id) ON DELETE CASCADE,
    subject_id UUID NOT NULL,
    version TEXT NOT NULL,
    approver TEXT NOT NULL,
    approver_name TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'changes_requested')),
    note TEXT,
    checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_approvals_request
    ON studio_approvals (tenant_id, request_id);",
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
                "DROP TABLE IF EXISTS studio_approvals;",
                "DROP TABLE IF EXISTS studio_review_requests;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}

/// Decisions recorded on requirements (`remarks.rs`). Insert only, like an
/// approval: a decision changed is a new decision.
mod m0019 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0019_decisions"
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
CREATE TABLE IF NOT EXISTS studio_decisions (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    statement TEXT NOT NULL,
    requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_url TEXT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('review_thread', 'meeting', 'chat', 'other')),
    path TEXT,
    decided_by TEXT NOT NULL,
    decided_by_name TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_decisions_project
    ON studio_decisions (tenant_id, project_id, decided_at);",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_decisions;")
                .await?;
            Ok(())
        }
    }
}

/// A stage's checks beyond documents (issue #782).
mod m0020 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0020_stage_checks"
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
                    "ALTER TABLE studio_process_stages ADD COLUMN IF NOT EXISTS checks TEXT NOT NULL DEFAULT '[]';",
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
                    "ALTER TABLE studio_process_stages DROP COLUMN IF EXISTS checks;",
                )
                .await?;
            Ok(())
        }
    }
}

/// Delivery scopes, their limits and their history (issue #784).
mod m0021 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0021_delivery_scopes"
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
CREATE TABLE IF NOT EXISTS studio_delivery_scopes (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    title TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT '',
    owner TEXT,
    owner_name TEXT,
    target_date TEXT,
    requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
    gears JSONB NOT NULL DEFAULT '[]'::jsonb,
    acceptance TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('planned', 'in_progress', 'delivered', 'dropped')),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_delivery_scopes_project
    ON studio_delivery_scopes (tenant_id, project_id);",
                r"
CREATE TABLE IF NOT EXISTS studio_delivery_limits (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    scope_id UUID NOT NULL REFERENCES studio_delivery_scopes (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('limitation', 'open_question', 'dependency')),
    text TEXT NOT NULL,
    blocking BOOLEAN NOT NULL DEFAULT FALSE,
    depends_on TEXT,
    resolution TEXT,
    resolved_by TEXT,
    resolved_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_delivery_limits_project
    ON studio_delivery_limits (tenant_id, project_id);",
                r"
CREATE TABLE IF NOT EXISTS studio_delivery_scope_history (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    scope_id UUID NOT NULL REFERENCES studio_delivery_scopes (id) ON DELETE CASCADE,
    snapshot JSONB NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_delivery_scope_history_scope
    ON studio_delivery_scope_history (tenant_id, scope_id, changed_at);",
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
                "DROP TABLE IF EXISTS studio_delivery_scope_history;",
                "DROP TABLE IF EXISTS studio_delivery_limits;",
                "DROP TABLE IF EXISTS studio_delivery_scopes;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}

/// What people record about an application's parts (issue #786).
mod m0022 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0022_application_parts"
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
CREATE TABLE IF NOT EXISTS studio_application_parts (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    repo TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('configuration', 'storage', 'deployment')),
    reference TEXT NOT NULL,
    owner TEXT,
    owner_name TEXT,
    description_path TEXT,
    boundary TEXT,
    related JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_application_parts_project
    ON studio_application_parts (tenant_id, project_id);",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_application_parts;")
                .await?;
            Ok(())
        }
    }
}

/// What a review was asked about, and why a finding was decided (the
/// prototype's review card and document comparisons).
/// A member's accept or reject on one fact the model read: what the model
/// proposes becomes the project's reading only once somebody accepts it.
mod m0025 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0025_spec_model_fact_reviews"
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
CREATE TABLE IF NOT EXISTS studio_spec_model_reviews (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    project_id UUID NOT NULL,
    fact_key TEXT NOT NULL,
    state TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    revision TEXT NOT NULL DEFAULT '',
    note TEXT,
    decided_by UUID NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, fact_key)
);",
                r"CREATE INDEX IF NOT EXISTS idx_studio_spec_model_reviews_project
    ON studio_spec_model_reviews (tenant_id, project_id);",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_spec_model_reviews;")
                .await?;
            Ok(())
        }
    }
}

/// Two glossary entries a member said are different things: kept on each
/// entry, so the pair is not offered as one thing again.
mod m0024 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0024_glossary_distinct_terms"
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
                    "ALTER TABLE studio_spec_model_terms ADD COLUMN IF NOT EXISTS distinct_from TEXT NOT NULL DEFAULT '[]';",
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
                    "ALTER TABLE studio_spec_model_terms DROP COLUMN IF EXISTS distinct_from;",
                )
                .await?;
            Ok(())
        }
    }
}

mod m0023 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0023_review_text_and_decision_notes"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            for sql in [
                "ALTER TABLE studio_review_requests ADD COLUMN IF NOT EXISTS reviewed_text TEXT;",
                "ALTER TABLE studio_spec_model_decisions ADD COLUMN IF NOT EXISTS note TEXT;",
                "ALTER TABLE studio_spec_model_decisions ADD COLUMN IF NOT EXISTS snapshot JSONB;",
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
                "ALTER TABLE studio_spec_model_decisions DROP COLUMN IF EXISTS snapshot;",
                "ALTER TABLE studio_spec_model_decisions DROP COLUMN IF EXISTS note;",
                "ALTER TABLE studio_review_requests DROP COLUMN IF EXISTS reviewed_text;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}

/// A verdict that asks for changes may mark them a security concern, which
/// holds a stage at every maturity (`approvals::holding`). Every verdict
/// recorded before is not one.
mod m0026 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0026_security_verdicts"
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
                    "ALTER TABLE studio_approvals ADD COLUMN IF NOT EXISTS security BOOLEAN NOT NULL DEFAULT false;",
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
                .execute_unprepared("ALTER TABLE studio_approvals DROP COLUMN IF EXISTS security;")
                .await?;
            Ok(())
        }
    }
}

/// A review request names the stakeholders that must approve it, and keeps
/// the rules it is judged by as they were when it was asked for
/// (`approvals`). Every earlier request requires none and kept none.
mod m0027 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    use super::{UNSUPPORTED, is_postgres};

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0027_review_stakeholders_and_rules"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !is_postgres(manager) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            for sql in [
                "ALTER TABLE studio_review_requests ADD COLUMN IF NOT EXISTS stakeholders JSONB NOT NULL DEFAULT '[]'::jsonb;",
                "ALTER TABLE studio_review_requests ADD COLUMN IF NOT EXISTS rules_snapshot JSONB;",
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
                "ALTER TABLE studio_review_requests DROP COLUMN IF EXISTS rules_snapshot;",
                "ALTER TABLE studio_review_requests DROP COLUMN IF EXISTS stakeholders;",
            ] {
                manager.get_connection().execute_unprepared(sql).await?;
            }
            Ok(())
        }
    }
}
