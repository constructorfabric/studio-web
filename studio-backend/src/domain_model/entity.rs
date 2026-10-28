//! `SeaORM` entities for the domain read model (see [`super::mirror`]).

use sea_orm::entity::prelude::*;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

pub mod object {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_domain_objects")]
    // Keyed by tenant and nothing narrower, like the graph it mirrors: the
    // project narrowing is the PDP's answer, applied on `owner_id` per query.
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub instance_id: String,
        /// Our node type id (`gts.cf.studio.domain.team.v1~`).
        pub type_id: String,
        /// Whom the object belongs to for authorization: its project when
        /// `_scope` names one, the organization otherwise (ADR-0035 §3).
        pub owner_id: Uuid,
        /// The payload's `_scope`, or `''`.
        pub scope: String,
        #[sea_orm(column_type = "JsonBinary")]
        pub payload: Json,
        pub updated_at_ms: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_domain_objects has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod edge {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_domain_edges")]
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        /// Our edge type id (`gts.cf.studio.domainrel.owns.v1~`).
        #[sea_orm(primary_key, auto_increment = false)]
        pub edge_type_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub src: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub dst: String,
        /// The declared relation the edge is (`delivers`), or `''` for an edge
        /// written without one.
        #[sea_orm(primary_key, auto_increment = false)]
        pub relation: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_domain_edges has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod fill {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_domain_fill")]
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        pub filled_at_ms: i64,
        /// What the fill copied, for the log.
        pub objects: i64,
        pub edges: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_domain_fill has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
