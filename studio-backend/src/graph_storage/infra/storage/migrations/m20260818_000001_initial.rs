//! Initial graph schema.
//!
//! `PostgreSQL` only: `tsvector`, JSONB indexing, pgvector and SQL/PGQ are all
//! load-bearing for this gear, so there is no portable fallback (see
//! `docs/DESIGN.md`, constraint `postgres-pgvector`).
//!
//! Every key contract carries `tenant_id` from day one — composite primary
//! keys, tenant-scoped uniqueness and tenant-carrying foreign keys — so that
//! adopting table partitioning at scale stays a physical reorganisation rather
//! than an identity migration.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::ConnectionTrait;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let backend = manager.get_database_backend();
        if backend != sea_orm::DatabaseBackend::Postgres {
            return Err(DbErr::Custom(format!(
                "graph-storage requires PostgreSQL; refusing to migrate {backend:?}"
            )));
        }

        manager
            .get_connection()
            .execute_unprepared(
                r"
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;

-- Interned GTS types. Types are rows, not enums: registering a node or edge
-- type is an API call, never a migration.
CREATE TABLE IF NOT EXISTS graph_type (
    tenant_id   UUID        NOT NULL,
    id          INTEGER     NOT NULL,
    type_uuid   UUID        NOT NULL,
    type_id     TEXT        NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN ('node', 'edge', 'attribute')),
    json_schema JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, type_uuid),
    UNIQUE (tenant_id, type_id)
);

CREATE TABLE IF NOT EXISTS graph_node (
    tenant_id   UUID        NOT NULL,
    id          BIGINT      NOT NULL,
    node_key    TEXT        NOT NULL,
    type_id     INTEGER     NOT NULL,
    name        TEXT        NOT NULL DEFAULT '',
    payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    search_text TEXT        NOT NULL DEFAULT '',
    embedding   VECTOR(384),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, node_key),
    FOREIGN KEY (tenant_id, type_id) REFERENCES graph_type (tenant_id, id)
);

-- Endpoint foreign keys are RESTRICT, never CASCADE: deleting a static node
-- must not silently destroy analysis edges attached to it.
CREATE TABLE IF NOT EXISTS graph_edge (
    tenant_id   UUID        NOT NULL,
    id          BIGINT      NOT NULL,
    edge_key    TEXT        NOT NULL,
    type_id     INTEGER     NOT NULL,
    src_node_id BIGINT      NOT NULL,
    dst_node_id BIGINT      NOT NULL,
    payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, edge_key),
    FOREIGN KEY (tenant_id, type_id) REFERENCES graph_type (tenant_id, id),
    FOREIGN KEY (tenant_id, src_node_id) REFERENCES graph_node (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, dst_node_id) REFERENCES graph_node (tenant_id, id) ON DELETE RESTRICT
);

-- Traversal backbone: one composite index per direction.
CREATE INDEX IF NOT EXISTS idx_graph_edge_src ON graph_edge (tenant_id, src_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edge_dst ON graph_edge (tenant_id, dst_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edge_type ON graph_edge (tenant_id, type_id);
CREATE INDEX IF NOT EXISTS idx_graph_node_type ON graph_node (tenant_id, type_id);
                ",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP TABLE IF EXISTS graph_edge; \
                 DROP TABLE IF EXISTS graph_node; \
                 DROP TABLE IF EXISTS graph_type;",
            )
            .await?;
        Ok(())
    }
}
