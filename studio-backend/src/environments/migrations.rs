//! `SeaORM` migrations for `studio-environments`: what it records beyond the
//! metadata rows (ADR-0062): a project's immutable slug, the namespace each
//! project was given in each environment, the images and charts its builds
//! published or it imported, and how long they are kept.
//!
//! PostgreSQL only (studio-backend/AGENTS.md).

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
        "studio-environments migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out: the name is a schema-history key and must survive a rename
    // of this module.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_environments_records"
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
-- A project's slug: made from its name the first time it is needed, then
-- never changed, so a rename moves neither its images nor its namespaces.
-- Unique across every organization: a registry prefix or a cluster may be
-- shared, and two projects must never get one path or one namespace.
CREATE TABLE IF NOT EXISTS studio_env_project_slugs (
    organization_id UUID   NOT NULL,
    project_id      UUID   NOT NULL PRIMARY KEY,
    slug            TEXT   NOT NULL UNIQUE,
    created_at_ms   BIGINT NOT NULL
);

-- The namespace a project was given in an environment, recorded at the first
-- build or deploy that made or found it; every later one reads it.
CREATE TABLE IF NOT EXISTS studio_env_namespaces (
    organization_id       UUID   NOT NULL,
    project_id            UUID   NOT NULL,
    environment_id        UUID   NOT NULL,
    cluster_connection_id UUID   NOT NULL,
    namespace             TEXT   NOT NULL,
    build_namespace       TEXT   NOT NULL,
    assigned_by           TEXT   NOT NULL,
    assigned_at_ms        BIGINT NOT NULL,
    PRIMARY KEY (project_id, environment_id)
);
-- One namespace of one cluster is one project's.
CREATE UNIQUE INDEX IF NOT EXISTS studio_env_namespaces_one_owner
    ON studio_env_namespaces (cluster_connection_id, namespace);

-- An image or a chart a project's build published, a pipeline published, or
-- the project imported or promoted: what it is, where it came from, and
-- whether it is still there.
CREATE TABLE IF NOT EXISTS studio_env_images (
    id                     UUID    NOT NULL PRIMARY KEY,
    organization_id        UUID    NOT NULL,
    project_id             UUID    NOT NULL,
    registry_connection_id UUID,
    registry_host          TEXT    NOT NULL,
    repository             TEXT    NOT NULL,
    tags                   TEXT    NOT NULL DEFAULT '[]',
    digest                 TEXT    NOT NULL,
    media_type             TEXT,
    size_bytes             BIGINT,
    platforms              TEXT    NOT NULL DEFAULT '[]',
    build_id               TEXT,
    app                    TEXT,
    commit_sha             TEXT,
    description_revision   BIGINT,
    lock_hash              TEXT,
    pushed_by              TEXT,
    pushed_at_ms           BIGINT  NOT NULL,
    kind                   TEXT    NOT NULL,
    state                  TEXT    NOT NULL,
    pinned                 BOOLEAN NOT NULL DEFAULT FALSE,
    promoted_from          UUID,
    source_ref             TEXT
);
-- One record per digest in one repository of one registry.
CREATE UNIQUE INDEX IF NOT EXISTS studio_env_images_one_per_digest
    ON studio_env_images (registry_host, repository, digest);
CREATE INDEX IF NOT EXISTS studio_env_images_by_project
    ON studio_env_images (organization_id, project_id, pushed_at_ms DESC);

-- How long a project's images are kept: per project, else per organization.
-- `scope_id` is the organization for an organization's default.
CREATE TABLE IF NOT EXISTS studio_env_image_retention (
    organization_id UUID   NOT NULL,
    scope_id        UUID   NOT NULL PRIMARY KEY,
    keep_last       INT,
    keep_days       INT,
    updated_by      TEXT   NOT NULL,
    updated_at_ms   BIGINT NOT NULL
);
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
                .execute_unprepared(
                    "DROP TABLE IF EXISTS studio_env_image_retention; \
                     DROP TABLE IF EXISTS studio_env_images; \
                     DROP TABLE IF EXISTS studio_env_namespaces; \
                     DROP TABLE IF EXISTS studio_env_project_slugs;",
                )
                .await?;
            Ok(())
        }
    }
}
