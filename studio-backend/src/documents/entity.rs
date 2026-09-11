//! `SeaORM` entities for studio-documents.
//!
//! Documents are scoped by the **workspace** tenant. Document types are scoped
//! by their OWNING tenant, which is an organization or a workspace (ADR-0014
//! section 4): the effective catalogue for a workspace is read with an
//! `AccessScope::for_tenants([organization, workspace])` -- one query, not a
//! cross-tenant read.
//!
//! A document's `project_id` (NULL = workspace-level, inherited by every
//! project under the workspace) is a plain column, not a separate tenant — so
//! the secure scope stays single-tenant (`tenant_id` = workspace) and
//! inheritance is a cheap
//! `project_id IS NULL OR project_id = ?` filter rather than a cross-tenant read.

/// A tenant-defined document type. Built-in types live in code
/// ([`super::model::builtin_types`]); only overrides, additions and tombstones
/// are rows.
pub mod doc_type {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_document_types")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(tenant_id, key)` — the primary key is the
        /// uniqueness constraint on the type key and the `ON CONFLICT` target.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Tenant that owns this type: an organization or a workspace.
        pub tenant_id: Uuid,
        pub key: String,
        pub name: String,
        pub description: String,
        pub gts_type_id: String,
        /// JSON `TemplateSpec` — `{ body, sections, rules }`.
        pub template: String,
        /// A tombstone: hides the key this row overrides instead of replacing
        /// it. Defaults to false, so rows written before ADR-0014 keep meaning
        /// exactly what they meant.
        pub hidden: bool,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A tenant-defined journey stage. Built-in stages live in code
/// ([`super::model::builtin_stages`]); only overrides, additions and tombstones
/// are rows. Same shape and same scoping rules as [`doc_type`] -- one resolver
/// serves both (ADR-0014 section 5).
pub mod stage {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_process_stages")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(tenant_id, key)`, as for a document type.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Tenant that owns this stage: an organization or a workspace.
        pub tenant_id: Uuid,
        pub key: String,
        pub label: String,
        pub required: bool,
        /// Position in the catalogue. Named `ordinal` rather than `position`
        /// because the latter is a SQL function name, and a column that needs
        /// quoting to be read is a trap for the next raw statement.
        pub ordinal: i32,
        /// JSON array of document-type keys this stage requires.
        pub requires: String,
        /// JSON array of detector names every required document must pass.
        pub gates: String,
        /// A tombstone: hides the key this row overrides.
        pub hidden: bool,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A tenant-defined capability. Built-ins live in code
/// ([`super::model::builtin_capabilities`]); only overrides, additions and
/// tombstones are rows.
pub mod capability {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_process_capabilities")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Tenant that owns this capability: an organization or a workspace.
        pub tenant_id: Uuid,
        pub key: String,
        pub label: String,
        /// JSON array of search terms.
        pub terms: String,
        /// A tombstone: hides the key this row overrides.
        pub hidden: bool,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// One detector's verdict on one document. The gear records what the analysis
/// said; `studio-spec-quality` runs it and keeps nothing.
pub mod analysis {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_document_analyses")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(document_id, detector)`: one verdict per
        /// detector per document, replaced when the analysis is re-run.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Workspace tenant, as for the document itself.
        pub tenant_id: Uuid,
        pub document_id: Uuid,
        pub detector: String,
        /// `pending`, `passed` or `failed`.
        pub state: String,
        pub task_id: Option<String>,
        pub summary: String,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A document instance.
pub mod document {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_documents")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Workspace tenant (the scope).
        pub tenant_id: Uuid,
        /// NULL = workspace-level (inherited by projects); else the project id.
        pub project_id: Option<Uuid>,
        pub type_key: String,
        pub title: String,
        pub content: String,
        /// 0 = draft, 1 = review, 2 = approved.
        pub status: i16,
        pub conforms: bool,
        /// JSON `ValidationReport` from the last check.
        pub validation: String,
        /// JSON array of capability keys, indexed from the document's own front
        /// matter on every write.
        pub capabilities: String,
        /// Creator subject id (string principal).
        pub created_by: String,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// An ingested repository file bound to a document type.
///
/// The content is **not** here — it stays in the artifact graph, addressed by
/// `node_id`. This row only records what we decided the file is, how we decided
/// it, and how it fared against that type's template. Copying each `.md` into a
/// second table would leave two versions of one file to drift apart on every
/// re-sync, and buy nothing.
pub mod document_binding {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_document_bindings")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(tenant_id, project_id, node_id)` — one
        /// binding per graph node per scope, and the `ON CONFLICT` target.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Workspace tenant (the scope).
        pub tenant_id: Uuid,
        /// NULL = workspace-level; else the owning project id.
        pub project_id: Option<Uuid>,
        /// `gts.cf.studio.artifact.file` node instance id.
        pub node_id: String,
        pub path: String,
        /// NULL while the type is undetermined.
        pub type_key: Option<String>,
        /// `detected` | `confirmed` | `manual` | `unknown` | `not_a_document`.
        pub state: String,
        pub confidence: Option<f32>,
        /// `front_matter` | `heuristic` | `spec_quality` | `manual`.
        pub source: Option<String>,
        /// JSON array of `TypeCandidate`.
        pub candidates: String,
        /// NULL when never validated (no type bound yet).
        pub conforms: Option<bool>,
        /// JSON `ValidationReport` from the last check, `{}` when never run.
        pub validation: String,
        /// Digest of the content the verdicts above were computed from.
        pub content_sha: String,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
