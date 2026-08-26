//! Per-tenant write counter backing `GraphStats::graph_revision`.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db_macros::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "graph_revision")]
// `no_resource`: the row is not a resource a caller can be granted access to
// individually — it is one counter per tenant, and the tenant predicate is the
// whole of its authorization.
#[secure(tenant_col = "tenant_id", no_resource, no_owner, no_type)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub tenant_id: Uuid,
    pub revision: i64,
    pub updated_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
