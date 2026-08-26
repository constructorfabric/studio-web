//! Graph edges. Endpoint foreign keys are RESTRICT: removing a static node
//! must never cascade into analysis edges.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db_macros::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "graph_edge")]
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub tenant_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    /// Deterministic hash of type, endpoints and discriminator.
    pub edge_key: String,
    pub type_id: i32,
    pub src_node_id: i64,
    pub dst_node_id: i64,
    pub payload: Json,
    pub created_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
