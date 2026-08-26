//! Interned GTS type registry.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db_macros::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "graph_type")]
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    /// Tenant scope; part of every key so the table stays partition-ready.
    #[sea_orm(primary_key, auto_increment = false)]
    pub tenant_id: Uuid,
    /// Interned identifier, unique within the tenant.
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i32,
    /// Deterministic `UUIDv5` of the GTS identifier.
    pub type_uuid: Uuid,
    /// Human-readable GTS identifier.
    pub type_id: String,
    /// `node`, `edge` or `attribute`.
    pub kind: String,
    /// Draft-07 JSON Schema with the gear's extension keywords.
    pub json_schema: Json,
    pub created_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
