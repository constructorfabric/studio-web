//! SQL/PGQ property graph over the relational tables (`PostgreSQL` 19+).
//!
//! The property graph copies no data: `GRAPH_TABLE` patterns compile to joins
//! over `graph_node` and `graph_edge` and use their indexes. It exists so the
//! gear can experiment with the SQL/PGQ traversal backend and so operators can
//! run ad-hoc graph queries from psql.
//!
//! The element keys are composite — `(tenant_id, id)` — which matters beyond
//! partition-readiness: because the edge's source and destination keys carry
//! `tenant_id`, an edge structurally cannot join a node of another tenant, so
//! no pattern can cross a tenant boundary even before a scope predicate is
//! applied.

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
DROP PROPERTY GRAPH IF EXISTS kb_pgq;

CREATE PROPERTY GRAPH kb_pgq
  VERTEX TABLES (
    graph_node KEY (tenant_id, id)
      LABEL node PROPERTIES (tenant_id, id, node_key, type_id)
  )
  EDGE TABLES (
    graph_edge KEY (tenant_id, id)
      SOURCE KEY (tenant_id, src_node_id) REFERENCES graph_node (tenant_id, id)
      DESTINATION KEY (tenant_id, dst_node_id) REFERENCES graph_node (tenant_id, id)
      LABEL edge PROPERTIES (tenant_id, id, type_id)
  );
                ",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP PROPERTY GRAPH IF EXISTS kb_pgq;")
            .await?;
        Ok(())
    }
}
