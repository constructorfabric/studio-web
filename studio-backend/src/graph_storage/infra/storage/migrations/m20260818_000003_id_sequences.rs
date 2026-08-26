//! Surrogate-id allocation.
//!
//! Ids are allocated by database sequences rather than by the gear, so a batch
//! insert does not have to reserve a range or read back before writing edges.
//! Sequences are global rather than per tenant: the primary key is
//! `(tenant_id, id)`, so uniqueness within a tenant is all the schema requires,
//! and a shared sequence keeps allocation lock-free.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::ConnectionTrait;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r"
CREATE SEQUENCE IF NOT EXISTS graph_type_id_seq AS INTEGER;
CREATE SEQUENCE IF NOT EXISTS graph_node_id_seq AS BIGINT;
CREATE SEQUENCE IF NOT EXISTS graph_edge_id_seq AS BIGINT;

ALTER TABLE graph_type ALTER COLUMN id SET DEFAULT nextval('graph_type_id_seq');
ALTER TABLE graph_node ALTER COLUMN id SET DEFAULT nextval('graph_node_id_seq');
ALTER TABLE graph_edge ALTER COLUMN id SET DEFAULT nextval('graph_edge_id_seq');
                ",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE graph_edge ALTER COLUMN id DROP DEFAULT; \
                 ALTER TABLE graph_node ALTER COLUMN id DROP DEFAULT; \
                 ALTER TABLE graph_type ALTER COLUMN id DROP DEFAULT; \
                 DROP SEQUENCE IF EXISTS graph_edge_id_seq; \
                 DROP SEQUENCE IF EXISTS graph_node_id_seq; \
                 DROP SEQUENCE IF EXISTS graph_type_id_seq;",
            )
            .await?;
        Ok(())
    }
}
