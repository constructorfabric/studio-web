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

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
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
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        #[serde(with = "crate::documents::stamp")]
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

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
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
        /// JSON array of the checks beyond documents (`code`, `tests`, `review`).
        pub checks: String,
        /// A tombstone: hides the key this row overrides.
        pub hidden: bool,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        #[serde(with = "crate::documents::stamp")]
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

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
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
        /// JSON array of contracts (`m0012`).
        pub contracts: String,
        /// Answered by the deployment profile, never by gears (`m0013`).
        pub nonfunctional: bool,
        /// A tombstone: hides the key this row overrides.
        pub hidden: bool,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        #[serde(with = "crate::documents::stamp")]
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

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_document_analyses")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(subject, detector)`: one verdict per
        /// detector per document, replaced when the analysis is re-run.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Workspace tenant, as for the document itself.
        pub tenant_id: Uuid,
        /// The Studio document this is about. NULL when it is about a bound
        /// repository file instead — exactly one of the two is set, which the
        /// database checks.
        pub document_id: Option<Uuid>,
        /// The ingested-file binding this is about, for a document that lives
        /// in the repository rather than in `studio_documents`.
        pub binding_id: Option<Uuid>,
        pub detector: String,
        /// `pending`, `passed` or `failed`.
        pub state: String,
        pub task_id: Option<String>,
        pub summary: String,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        #[serde(with = "crate::documents::stamp")]
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// What a model read out of one document revision (`spec_model::extract`).
pub mod spec_extraction {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_spec_model_extractions")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(project, path, revision, extractor
        /// version)`.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Workspace tenant, as for the bindings.
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub path: String,
        /// The text's hash (`extract::revision`).
        pub revision: String,
        pub extractor_version: String,
        /// `Vec<extract::Fact>` as JSON.
        pub facts: String,
        /// Facts the model gave that the text did not bear out.
        pub dropped: i32,
        /// Why a piece could not be read; the facts of the other pieces are
        /// kept, and the document is asked again on the next build.
        pub error: Option<String>,
        pub provider: String,
        pub model: String,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// What the judge said about one candidate at its sides' revisions.
pub mod spec_judgement {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_spec_model_judgements")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(project, fingerprint, revisions, judge
        /// version)`.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub fingerprint: String,
        /// The sides' document revisions, sorted and joined: a judgement is
        /// about the text as it was.
        pub revisions: String,
        pub judge_version: String,
        pub conflict: bool,
        /// `finding::Finding` as JSON when `conflict`.
        pub finding: Option<String>,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A member's ✓ or ✗ on a spec-model finding.
pub mod spec_decision {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_spec_model_decisions")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(project, fingerprint)`: one decision per
        /// finding, the latest.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub fingerprint: String,
        /// `confirmed` (a real problem) or `dismissed` (not one).
        pub decision: String,
        pub decided_by: Uuid,
        #[serde(with = "crate::documents::stamp")]
        pub decided_at: OffsetDateTime,
        /// Why, in the member's words.
        pub note: Option<String>,
        /// The finding as it stood when decided: `{rule, message, sides}`.
        #[sea_orm(column_type = "JsonBinary", nullable)]
        pub snapshot: Option<serde_json::Value>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A member's accept or reject on one fact the model read.
pub mod spec_review {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_spec_model_reviews")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(project, fact_key)`: the latest review.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        /// The fact as the tab keys it: kind, subject, aspect and the quote,
        /// folded and hashed, so a reading keeps its review while its passage
        /// says the same.
        pub fact_key: String,
        /// `accepted` or `rejected`.
        pub state: String,
        /// Where the fact was read, and at which revision, when reviewed.
        pub path: String,
        pub revision: String,
        /// Why, in the member's words: the reason an obligation is excluded.
        pub note: Option<String>,
        pub decided_by: Uuid,
        #[serde(with = "crate::documents::stamp")]
        pub decided_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A member's decision on one entry of a project's glossary.
pub mod spec_term {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_spec_model_terms")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// Deterministic v5 UUID of `(project, term_key)`: one decision per
        /// entry, the latest.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        /// The entry's key: its subject folded (`rules::subject_key`).
        pub term_key: String,
        /// The name the project uses for it, when a member chose one.
        pub name: Option<String>,
        /// The key of the entry this one is another name of.
        pub alias_of: Option<String>,
        /// The keys of the entries a member said are different things from
        /// this one, as a JSON array: never offered as one thing again.
        pub distinct_from: String,
        pub decided_by: Uuid,
        #[serde(with = "crate::documents::stamp")]
        pub decided_at: OffsetDateTime,
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

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
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
        /// JSON array of the non-functional statements its NFR, operational
        /// and deployment sections make (`m0013`), indexed on every write.
        pub requirements: String,
        /// JSON array of `InferredCapability`: what its functional requirements
        /// imply when its front matter declares nothing (`m0014`).
        pub inferred_capabilities: String,
        /// Creator subject id (string principal).
        pub created_by: String,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        #[serde(with = "crate::documents::stamp")]
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

    #[derive(
        Clone, Debug, PartialEq, DeriveEntityModel, Scopable, serde::Serialize, serde::Deserialize,
    )]
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
        /// JSON array of the capability keys the file's front matter declares
        /// (`capabilities: a, b`), `[]` when it declares none. An index over
        /// the file, re-derived on every scan, like `studio_documents`'.
        pub capabilities: String,
        /// JSON array of the file's non-functional statements (`m0013`),
        /// re-derived on every scan like `capabilities`.
        pub requirements: String,
        /// JSON array of `InferredCapability`, as for a document (`m0014`).
        pub inferred_capabilities: String,
        /// Digest of the content the verdicts above were computed from.
        pub content_sha: String,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        #[serde(with = "crate::documents::stamp")]
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A request to review one version of one document (`approvals.rs`).
pub mod review_request {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_review_requests")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// The workspace.
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        /// `document` (written in Studio) or `binding` (a repository file).
        pub subject_kind: String,
        pub subject_id: Uuid,
        pub type_key: Option<String>,
        pub title: String,
        /// The version asked about: a commit sha, a revision, as the caller
        /// names it.
        pub version: String,
        /// Canonical person id.
        pub requested_by: String,
        pub requested_by_name: Option<String>,
        /// `[{person, name, required}]`.
        #[sea_orm(column_type = "JsonBinary")]
        pub reviewers: serde_json::Value,
        #[serde(with = "crate::documents::stamp::option")]
        pub due_at: Option<OffsetDateTime>,
        /// `open`, `approved`, `superseded` (a later request on the same
        /// document) or `withdrawn`.
        pub state: String,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        /// The text asked about, kept at request time (at most 256 KiB).
        pub reviewed_text: Option<String>,
        /// The stakeholders that must approve, as the requester named them.
        #[sea_orm(column_type = "JsonBinary")]
        pub stakeholders: serde_json::Value,
        /// The type's review rules when the review was asked for
        /// (`review_guide::RulesSnapshot`). `None` for an older request.
        #[sea_orm(column_type = "JsonBinary", nullable)]
        pub rules_snapshot: Option<serde_json::Value>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// One verdict on a review request. Inserted, never updated.
pub mod approval {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_approvals")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub request_id: Uuid,
        pub subject_id: Uuid,
        pub version: String,
        /// Canonical person id.
        pub approver: String,
        pub approver_name: Option<String>,
        /// `approved` or `changes_requested`.
        pub verdict: String,
        /// The changes asked for are a security concern: they hold the stage
        /// whatever the document's maturity (`approvals::holding`).
        pub security: bool,
        pub note: Option<String>,
        /// The detectors that had passed on the document when the verdict
        /// was given.
        #[sea_orm(column_type = "JsonBinary")]
        pub checks: serde_json::Value,
        #[serde(with = "crate::documents::stamp")]
        pub decided_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A decision recorded on a project's requirements: what was decided, by
/// whom, where it was taken (`remarks.rs`).
pub mod decision {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_decisions")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub statement: String,
        /// The requirement identifiers it closes, `["cpt-…"]`.
        #[sea_orm(column_type = "JsonBinary")]
        pub requirements: serde_json::Value,
        /// Where it was taken: a review thread, a meeting note, a chat message.
        pub source_url: Option<String>,
        /// `review_thread`, `meeting`, `chat` or `other`.
        pub source_kind: String,
        /// The document it is about, when one.
        pub path: Option<String>,
        pub decided_by: String,
        pub decided_by_name: Option<String>,
        #[serde(with = "crate::documents::stamp")]
        pub decided_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A delivery scope inside a project (`delivery.rs`).
pub mod delivery_scope {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_delivery_scopes")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub title: String,
        pub outcome: String,
        pub owner: Option<String>,
        pub owner_name: Option<String>,
        pub target_date: Option<String>,
        #[sea_orm(column_type = "JsonBinary")]
        pub requirements: serde_json::Value,
        #[sea_orm(column_type = "JsonBinary")]
        pub gears: serde_json::Value,
        pub acceptance: String,
        pub state: String,
        pub created_by: String,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
        pub updated_by: String,
        #[serde(with = "crate::documents::stamp")]
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A limit on a delivery scope.
pub mod delivery_limit {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_delivery_limits")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub scope_id: Uuid,
        pub kind: String,
        pub text: String,
        pub blocking: bool,
        pub depends_on: Option<String>,
        pub resolution: Option<String>,
        pub resolved_by: Option<String>,
        #[serde(with = "crate::documents::stamp::option")]
        pub resolved_at: Option<OffsetDateTime>,
        pub created_by: String,
        #[serde(with = "crate::documents::stamp")]
        pub created_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// The version of a scope a change replaced.
pub mod delivery_history {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_delivery_scope_history")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub scope_id: Uuid,
        #[sea_orm(column_type = "JsonBinary")]
        pub snapshot: serde_json::Value,
        pub changed_by: String,
        #[serde(with = "crate::documents::stamp")]
        pub changed_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// What a person records about one application part (`parts.rs`).
pub mod application_part {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(
        Clone,
        Debug,
        PartialEq,
        Eq,
        DeriveEntityModel,
        Scopable,
        serde::Serialize,
        serde::Deserialize,
    )]
    #[sea_orm(table_name = "studio_application_parts")]
    #[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        /// v5 of `(project, repo, kind, reference)`.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub tenant_id: Uuid,
        pub project_id: Uuid,
        pub repo: String,
        pub kind: String,
        pub reference: String,
        pub owner: Option<String>,
        pub owner_name: Option<String>,
        /// The document that describes it, repo-relative.
        pub description_path: Option<String>,
        /// What it covers and what it does not.
        pub boundary: Option<String>,
        /// References of related parts.
        #[sea_orm(column_type = "JsonBinary")]
        pub related: serde_json::Value,
        pub updated_by: String,
        #[serde(with = "crate::documents::stamp")]
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
