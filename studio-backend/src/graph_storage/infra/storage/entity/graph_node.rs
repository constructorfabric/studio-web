//! Graph nodes. Owned entities and managed-object references share this table;
//! the distinction is carried by the GTS type, not by storage (ADR-0002).

use sea_orm::entity::prelude::PgVector;
use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db_macros::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "graph_node")]
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub tenant_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    /// Producer-supplied stable key, unique within the tenant.
    pub node_key: String,
    /// Reference into `graph_type`.
    pub type_id: i32,
    pub name: String,
    /// GTS-validated attributes, bounded by the payload ceiling.
    pub payload: Json,
    /// Composed text fed to lexical search and embedding.
    pub search_text: String,
    /// Embedding of `search_text`, supplied by the producer. The gear has no
    /// model and never computes one.
    pub embedding: Option<PgVector>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
