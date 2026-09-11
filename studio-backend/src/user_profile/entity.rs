//! SeaORM entities for the identity gear's own database.
//!
//! Four tables. The data is GLOBAL (a person spans organizations), so every row
//! carries the platform-root tenant id and is scoped to it — toolkit-db's secure
//! runner requires a tenant scope, and "one shared partition = the root tenant"
//! is exactly our model. Primary keys are deterministic v5 UUIDs of the natural
//! key so an upsert targets the PK and the key itself is the uniqueness
//! constraint; the `user` id is a fresh v4, the Studio-owned identifier.

use uuid::Uuid;

/// The single partition every identity row lives in.
pub const ROOT_TENANT: Uuid = Uuid::from_u128(1);

/// Namespace for deterministic v5 keys. Stable across releases; never secret.
pub const KEY_NS: Uuid = Uuid::from_u128(0xcf57_0000_0000_5000_9000_0000_0000_0001);

pub fn login_id(provider: &str, subject: &str) -> Uuid {
    Uuid::new_v5(&KEY_NS, format!("login|{provider}|{subject}").as_bytes())
}
pub fn membership_id(user_id: Uuid, org_id: Uuid) -> Uuid {
    Uuid::new_v5(&KEY_NS, format!("membership|{user_id}|{org_id}").as_bytes())
}
pub fn alias_id(kind: &str, external_id: &str) -> Uuid {
    Uuid::new_v5(&KEY_NS, format!("alias|{kind}|{external_id}").as_bytes())
}

pub mod user {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "identity_user")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub display_name: Option<String>,
        pub email: Option<String>,
        pub avatar_url: Option<String>,
        pub locale: Option<String>,
        pub merged_into: Option<Uuid>,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod login {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "identity_login")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// v5 of (provider, subject).
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub provider: String,
        pub subject: String,
        pub user_id: Uuid,
        pub verified: bool,
        pub linked_at: OffsetDateTime,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod membership {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "identity_membership")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// v5 of (user_id, org_id).
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub user_id: Uuid,
        pub org_id: Uuid,
        pub role: String,
        /// `active` or `suspended` (ADR-0011 §2). A membership that is not
        /// active is still a membership: the row says the person belongs here
        /// and what they would hold if reinstated, while granting nothing
        /// meanwhile. Leaving deletes the row; suspension does not.
        pub status: String,
        pub source: String,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod alias {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "identity_alias")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// v5 of (kind, external_id).
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub kind: String,
        pub external_id: String,
        pub user_id: Uuid,
        pub confidence: String,
        pub added_at: OffsetDateTime,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod invitation {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    /// A pending membership: an organization, an address, a role, and a secret
    /// that turns them into one.
    ///
    /// The token is stored as a digest, never as itself, so a read of this
    /// table yields nothing usable (see `invitations::mint_token`).
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "identity_invitation")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub org_id: Uuid,
        /// Normalized, and the only thing an acceptance is matched against.
        pub email: String,
        pub role: String,
        /// SHA-256 of the token. Unique, so a token identifies one invitation.
        pub token_digest: String,
        /// The person who sent it.
        pub invited_by: Uuid,
        pub created_at: OffsetDateTime,
        pub expires_at: OffsetDateTime,
        /// Set once, by the acceptance. Its presence is what makes an
        /// invitation single-use.
        pub accepted_at: Option<OffsetDateTime>,
        pub accepted_by: Option<Uuid>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}
