//! Persistence for studio-documents over `toolkit_db` (sea-orm), scoped to the
//! workspace tenant. Mirrors the secure-CRUD shape of `studio-credstore-pg`:
//! `.secure().scope_with(..)` for reads, `.secure().scope_unchecked(..)` for
//! writes the gear has already authorized, and an `ON CONFLICT (id)` upsert.

use std::sync::Arc;

use anyhow::Result;
use sea_orm::{ColumnTrait, Condition, EntityTrait, IntoActiveModel, Order, QueryFilter};
use toolkit_db::DBProvider;
use toolkit_db::secure::{
    SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureInsertManyExt, SecureOnConflict,
    SecureUpdateExt,
};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::entity::{
    analysis, application_part, approval, capability, decision, delivery_history, delivery_limit,
    delivery_scope, doc_type, document, document_binding, review_request, spec_decision,
    spec_extraction, spec_judgement, spec_review, spec_term, stage,
};

/// UUIDv5 namespace for a document type's deterministic id — makes `(tenant,
/// key)` the primary key and gives `upsert_type` an idempotent conflict target.
const TYPE_NS: Uuid = Uuid::from_u128(0x7d0c_9f21_4b6a_5e88_9c14_a2f3_71b6_0d42);

/// The same for stages, deliberately a different namespace.
const STAGE_NS: Uuid = Uuid::from_u128(0x2f8e_41c7_9a35_4d10_b6e2_5c74_8801_ff93);

/// And for capabilities.
const CAPABILITY_NS: Uuid = Uuid::from_u128(0x8b41_7cd2_0e69_4a5f_9d38_1e07_c4b5_662a);

/// And for a detector's verdict on a document.
const ANALYSIS_NS: Uuid = Uuid::from_u128(0x5c93_a80f_6d17_4e22_ab44_7f95_2306_e1d8);

/// And for an ingested file's binding to a type. Keying on `(tenant, project,
/// node)` means re-classifying the same file updates one row instead of
/// appending a second opinion about it.
/// And for one extraction of a document revision.
const EXTRACTION_NS: Uuid = Uuid::from_u128(0x41d7_0c2e_93b8_4a65_8e1f_d26c_05a9_7b33);

/// The id of the extraction of `path` at `revision` by `extractor_version`.
pub fn extraction_id(
    project_id: Uuid,
    path: &str,
    revision: &str,
    extractor_version: &str,
) -> Uuid {
    Uuid::new_v5(
        &EXTRACTION_NS,
        format!("{project_id}{path}{revision}{extractor_version}").as_bytes(),
    )
}

/// And for a judgement of one candidate at its sides' revisions.
const JUDGEMENT_NS: Uuid = Uuid::from_u128(0x93c5_2e71_0b4d_4f86_a1e9_6d38_c27f_5014);

pub fn judgement_id(
    project_id: Uuid,
    fingerprint: &str,
    revisions: &str,
    judge_version: &str,
) -> Uuid {
    Uuid::new_v5(
        &JUDGEMENT_NS,
        format!("{project_id}\u{1f}{fingerprint}\u{1f}{revisions}\u{1f}{judge_version}").as_bytes(),
    )
}

/// And for a member's decision on one finding.
const SPEC_DECISION_NS: Uuid = Uuid::from_u128(0x6e08_d4a2_57c1_4b93_8f60_e1a7_3b29_c845);

pub fn spec_decision_id(project_id: Uuid, fingerprint: &str) -> Uuid {
    Uuid::new_v5(
        &SPEC_DECISION_NS,
        format!("{project_id}\u{1f}{fingerprint}").as_bytes(),
    )
}

/// And for a member's decision on one glossary entry.
const SPEC_REVIEW_NS: Uuid = Uuid::from_u128(0x5d2e_9b41_7c06_4a83_b1f5_3e8a_02c7_d914);

/// Deterministic id for a fact review: one per fact, the latest.
pub fn spec_review_id(project_id: Uuid, fact_key: &str) -> Uuid {
    Uuid::new_v5(
        &SPEC_REVIEW_NS,
        format!("{project_id}\u{1f}{fact_key}").as_bytes(),
    )
}

const SPEC_TERM_NS: Uuid = Uuid::from_u128(0x91c3_5e7a_2b04_4d18_a6f9_0c2e_87d1_b453);

pub fn spec_term_id(project_id: Uuid, term_key: &str) -> Uuid {
    Uuid::new_v5(
        &SPEC_TERM_NS,
        format!("{project_id}\u{1f}{term_key}").as_bytes(),
    )
}

const BINDING_NS: Uuid = Uuid::from_u128(0x2b41_e6c7_8d35_4f90_a7e2_5c18_93ab_f604);

/// Which documents a list call wants.
pub enum DocScope {
    /// Only workspace-level documents (`project_id IS NULL`).
    WorkspaceLevel,
    /// Effective set for a project: workspace-level (inherited) + the project's
    /// own (`project_id IS NULL OR project_id = pid`).
    Effective(Uuid),
    /// Everything recorded under the workspace tenant: its own rows and every
    /// project's. For a rollup that answers for the workspace as a whole --
    /// what its sources hold -- where "only the workspace's own" would read
    /// as zero, because a repository's files are bound in the project that
    /// synced them.
    Everything,
}

/// Deterministic id for a binding, so re-classification is an upsert.
pub fn binding_row_id(workspace_id: Uuid, project_id: Option<Uuid>, node_id: &str) -> Uuid {
    let project = project_id.map(|p| p.to_string()).unwrap_or_default();
    Uuid::new_v5(
        &BINDING_NS,
        format!("{workspace_id}|{project}|{node_id}").as_bytes(),
    )
}

/// Deterministic id for a tenant-defined type.
///
/// `owner_tenant_id` is an organization or a workspace: the two levels share
/// one table and one key shape, so the same key defined at both is two rows
/// that never collide, and the service decides which one wins (ADR-0014
/// section 4).
pub fn type_row_id(owner_tenant_id: Uuid, key: &str) -> Uuid {
    Uuid::new_v5(&TYPE_NS, format!("{owner_tenant_id}|{key}").as_bytes())
}

/// Deterministic id for a tenant-defined stage.
///
/// A namespace of its own, so a stage and a document type sharing a key under
/// the same tenant (`prd` is both) do not derive the same uuid.
pub fn stage_row_id(owner_tenant_id: Uuid, key: &str) -> Uuid {
    Uuid::new_v5(&STAGE_NS, format!("{owner_tenant_id}|{key}").as_bytes())
}

/// Deterministic id for a tenant-defined capability.
pub fn capability_row_id(owner_tenant_id: Uuid, key: &str) -> Uuid {
    Uuid::new_v5(
        &CAPABILITY_NS,
        format!("{owner_tenant_id}|{key}").as_bytes(),
    )
}

/// Deterministic id for one detector's verdict on one document, so re-running
/// an analysis replaces its answer instead of stacking another.
pub fn analysis_row_id(document_id: Uuid, detector: &str) -> Uuid {
    Uuid::new_v5(&ANALYSIS_NS, format!("{document_id}|{detector}").as_bytes())
}

pub struct DocumentsRepo {
    db: Arc<DBProvider<anyhow::Error>>,
}

impl DocumentsRepo {
    pub fn new(db: Arc<DBProvider<anyhow::Error>>) -> Self {
        Self { db }
    }

    // ── document types ──────────────────────────────────────────────────────

    /// Drop one tenant's own entry for `key`, so the level below it shows
    /// through again.
    ///
    /// Scoped to `owner_tenant_id`, which is the whole safety property: a
    /// workspace reverting `prd` must not be able to delete the organization's
    /// `prd` and take it away from every sibling workspace.
    pub async fn delete_type(&self, owner_tenant_id: Uuid, key: &str) -> Result<bool> {
        let conn = self.db.conn()?;
        let result = doc_type::Entity::delete_many()
            .filter(doc_type::Column::Key.eq(key))
            .secure()
            .scope_with(&AccessScope::for_tenant(owner_tenant_id))
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    // -- journey stages ------------------------------------------------------
    //
    // Same two calls as the type catalogue, against its own table. They are not
    // generic over the entity: SeaORM's `secure()` builder is typed per entity,
    // so a shared implementation would take more machinery than the sixteen
    // lines it saves.

    /// Tenant-defined stages for the given owners (built-ins are added by the
    /// service).
    pub async fn list_stages(&self, owner_tenant_ids: &[Uuid]) -> Result<Vec<stage::Model>> {
        if owner_tenant_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = stage::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenants(owner_tenant_ids.to_vec()))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Insert or replace a tenant-defined stage (organization or workspace).
    pub async fn upsert_stage(&self, model: stage::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let owner_tenant_id = model.tenant_id;
        let on_conflict = SecureOnConflict::<stage::Entity>::columns([stage::Column::Id])
            .update_columns([
                stage::Column::Label,
                stage::Column::Required,
                stage::Column::Ordinal,
                stage::Column::Requires,
                // `Gates` belongs here for the same reason `Requires` does: the
                // request names a desired state, and a column left out of the
                // conflict update makes the first write of a key permanent
                // however many edits follow it.
                stage::Column::Gates,
                stage::Column::Hidden,
                stage::Column::UpdatedAt,
            ])?;
        stage::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(owner_tenant_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Drop one tenant's own stage entry for `key`. Same scoping rule as
    /// [`Self::delete_type`].
    pub async fn delete_stage(&self, owner_tenant_id: Uuid, key: &str) -> Result<bool> {
        let conn = self.db.conn()?;
        let result = stage::Entity::delete_many()
            .filter(stage::Column::Key.eq(key))
            .secure()
            .scope_with(&AccessScope::for_tenant(owner_tenant_id))
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    /// Tenant-defined types for the given owners (built-ins are added by the
    /// service).
    ///
    /// One query over several tenants rather than one query each:
    /// `AccessScope::for_tenant` is itself `for_tenants(vec![id])`, an `IN`
    /// filter, so reading an organization's rows alongside a workspace's is the
    /// sanctioned shape of this API and not a widened scope.
    pub async fn list_types(&self, owner_tenant_ids: &[Uuid]) -> Result<Vec<doc_type::Model>> {
        if owner_tenant_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = doc_type::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenants(owner_tenant_ids.to_vec()))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Insert or replace a tenant-defined type (organization or workspace).
    pub async fn upsert_type(&self, model: doc_type::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let owner_tenant_id = model.tenant_id;
        let on_conflict = SecureOnConflict::<doc_type::Entity>::columns([doc_type::Column::Id])
            .update_columns([
                doc_type::Column::Name,
                doc_type::Column::Description,
                doc_type::Column::GtsTypeId,
                doc_type::Column::Template,
                doc_type::Column::Hidden,
                doc_type::Column::UpdatedAt,
            ])?;
        doc_type::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(owner_tenant_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    // -- analyses ------------------------------------------------------------

    /// Every recorded verdict for the given documents.
    ///
    /// Takes a list because the caller that needs them -- the stage gate -- has
    /// a project's whole document set in hand and would otherwise issue one
    /// query per document.
    pub async fn list_analyses(
        &self,
        workspace_id: Uuid,
        document_ids: &[Uuid],
    ) -> Result<Vec<analysis::Model>> {
        if document_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = analysis::Entity::find()
            .filter(analysis::Column::DocumentId.is_in(document_ids.to_vec()))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// The same, for verdicts about bound repository files.
    pub async fn list_binding_analyses(
        &self,
        workspace_id: Uuid,
        binding_ids: &[Uuid],
    ) -> Result<Vec<analysis::Model>> {
        if binding_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = analysis::Entity::find()
            .filter(analysis::Column::BindingId.is_in(binding_ids.to_vec()))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Record (or replace) one detector's verdict.
    pub async fn upsert_analysis(&self, model: analysis::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict = SecureOnConflict::<analysis::Entity>::columns([analysis::Column::Id])
            .update_columns([
                analysis::Column::State,
                analysis::Column::TaskId,
                analysis::Column::Summary,
                analysis::Column::UpdatedAt,
            ])?;
        analysis::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    // ── the spec model's extractions ────────────────────────────────────────

    /// Every extraction kept for a project, of any revision; the caller picks
    /// the ones of the documents' current revisions.
    pub async fn list_extractions(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_extraction::Model>> {
        let conn = self.db.conn()?;
        let rows = spec_extraction::Entity::find()
            .filter(spec_extraction::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Keep one extraction; a second one of the same revision replaces it
    /// (a retried document whose first attempt failed part-way).
    pub async fn put_extraction(&self, model: spec_extraction::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict =
            SecureOnConflict::<spec_extraction::Entity>::columns([spec_extraction::Column::Id])
                .update_columns([
                    spec_extraction::Column::Facts,
                    spec_extraction::Column::Dropped,
                    spec_extraction::Column::Error,
                    spec_extraction::Column::Provider,
                    spec_extraction::Column::Model,
                    spec_extraction::Column::CreatedAt,
                ])?;
        spec_extraction::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Every judgement kept for a project.
    pub async fn list_judgements(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_judgement::Model>> {
        let conn = self.db.conn()?;
        let rows = spec_judgement::Entity::find()
            .filter(spec_judgement::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    pub async fn put_judgement(&self, model: spec_judgement::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict =
            SecureOnConflict::<spec_judgement::Entity>::columns([spec_judgement::Column::Id])
                .update_columns([
                    spec_judgement::Column::Conflict,
                    spec_judgement::Column::Finding,
                    spec_judgement::Column::CreatedAt,
                ])?;
        spec_judgement::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Every decision on a project's glossary.
    pub async fn list_spec_terms(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_term::Model>> {
        let conn = self.db.conn()?;
        let rows = spec_term::Entity::find()
            .filter(spec_term::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Record a decision on a glossary entry; a later one replaces it.
    pub async fn put_spec_term(&self, model: spec_term::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict = SecureOnConflict::<spec_term::Entity>::columns([spec_term::Column::Id])
            .update_columns([
            spec_term::Column::Name,
            spec_term::Column::AliasOf,
            spec_term::Column::DecidedBy,
            spec_term::Column::DecidedAt,
        ])?;
        spec_term::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Every fact review in a project.
    pub async fn list_spec_reviews(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_review::Model>> {
        let conn = self.db.conn()?;
        let rows = spec_review::Entity::find()
            .filter(spec_review::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Record a review of one fact; a later one replaces it.
    pub async fn put_spec_review(&self, model: spec_review::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict =
            SecureOnConflict::<spec_review::Entity>::columns([spec_review::Column::Id])
                .update_columns([
                    spec_review::Column::State,
                    spec_review::Column::Path,
                    spec_review::Column::Revision,
                    spec_review::Column::Note,
                    spec_review::Column::DecidedBy,
                    spec_review::Column::DecidedAt,
                ])?;
        spec_review::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Withdraw a review: the fact is proposed again.
    pub async fn delete_spec_review(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
        fact_key: &str,
    ) -> Result<()> {
        let conn = self.db.conn()?;
        spec_review::Entity::delete_many()
            .filter(spec_review::Column::Id.eq(spec_review_id(project_id, fact_key)))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Record which entries an entry is a different thing from, leaving its
    /// name and alias decision as they are.
    pub async fn put_spec_term_distinct(&self, model: spec_term::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict = SecureOnConflict::<spec_term::Entity>::columns([spec_term::Column::Id])
            .update_columns([spec_term::Column::DistinctFrom])?;
        spec_term::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Every decision on a project's spec-model findings.
    pub async fn list_spec_decisions(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_decision::Model>> {
        let conn = self.db.conn()?;
        let rows = spec_decision::Entity::find()
            .filter(spec_decision::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Record a decision; a later one on the same finding replaces it.
    pub async fn put_spec_decision(&self, model: spec_decision::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict =
            SecureOnConflict::<spec_decision::Entity>::columns([spec_decision::Column::Id])
                .update_columns([
                    spec_decision::Column::Decision,
                    spec_decision::Column::DecidedBy,
                    spec_decision::Column::DecidedAt,
                    spec_decision::Column::Note,
                    spec_decision::Column::Snapshot,
                ])?;
        spec_decision::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    // ── review requests and approvals ───────────────────────────────────────

    /// Record a request, and mark every earlier open request on the same
    /// document in the same project superseded: one document has one current
    /// request per project, and no project's request ends another's.
    pub async fn put_review_request(&self, model: review_request::Model) -> Result<()> {
        use sea_orm::sea_query::Expr;
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(model.tenant_id);
        review_request::Entity::update_many()
            .secure()
            .scope_with(&scope)
            .filter(
                Condition::all()
                    .add(review_request::Column::ProjectId.eq(model.project_id))
                    .add(review_request::Column::SubjectId.eq(model.subject_id))
                    .add(review_request::Column::State.eq("open")),
            )
            .col_expr(review_request::Column::State, Expr::value("superseded"))
            .exec(&conn)
            .await?;
        review_request::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope)?
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// A project's requests, newest first; one document's when `subject_id`
    /// is given.
    pub async fn list_review_requests(
        &self,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        subject_id: Option<Uuid>,
    ) -> Result<Vec<review_request::Model>> {
        let conn = self.db.conn()?;
        let mut cond = Condition::all();
        if let Some(p) = project_id {
            cond = cond.add(review_request::Column::ProjectId.eq(p));
        }
        if let Some(sub) = subject_id {
            cond = cond.add(review_request::Column::SubjectId.eq(sub));
        }
        let rows = review_request::Entity::find()
            .filter(cond)
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .order_by(review_request::Column::CreatedAt, Order::Desc)
            .all(&conn)
            .await?;
        Ok(rows)
    }

    pub async fn get_review_request(
        &self,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<Option<review_request::Model>> {
        let conn = self.db.conn()?;
        let row = review_request::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .filter(Condition::all().add(review_request::Column::Id.eq(id)))
            .one(&conn)
            .await?;
        Ok(row)
    }

    pub async fn set_review_request_state(
        &self,
        workspace_id: Uuid,
        id: Uuid,
        state: &str,
    ) -> Result<()> {
        use sea_orm::sea_query::Expr;
        let conn = self.db.conn()?;
        review_request::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .filter(Condition::all().add(review_request::Column::Id.eq(id)))
            .col_expr(
                review_request::Column::State,
                Expr::value(state.to_string()),
            )
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Record a verdict. Insert only: an approval is never changed.
    pub async fn insert_approval(&self, model: approval::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(model.tenant_id);
        approval::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope)?
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// The verdicts on these requests, oldest first.
    pub async fn list_approvals(
        &self,
        workspace_id: Uuid,
        request_ids: &[Uuid],
    ) -> Result<Vec<approval::Model>> {
        if request_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = approval::Entity::find()
            .filter(approval::Column::RequestId.is_in(request_ids.iter().copied()))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .order_by(approval::Column::DecidedAt, Order::Asc)
            .all(&conn)
            .await?;
        Ok(rows)
    }

    // ── application parts ───────────────────────────────────────────────────

    pub async fn put_part(&self, model: application_part::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(model.tenant_id);
        let on_conflict =
            SecureOnConflict::<application_part::Entity>::columns([application_part::Column::Id])
                .update_columns([
                application_part::Column::Owner,
                application_part::Column::OwnerName,
                application_part::Column::DescriptionPath,
                application_part::Column::Boundary,
                application_part::Column::Related,
                application_part::Column::UpdatedBy,
                application_part::Column::UpdatedAt,
            ])?;
        application_part::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope)?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    pub async fn list_parts(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<application_part::Model>> {
        let conn = self.db.conn()?;
        Ok(application_part::Entity::find()
            .filter(application_part::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?)
    }

    // ── delivery scopes ─────────────────────────────────────────────────────

    /// Write a scope whole: insert, or replace the row with the same id.
    pub async fn put_scope(&self, model: delivery_scope::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(model.tenant_id);
        let on_conflict =
            SecureOnConflict::<delivery_scope::Entity>::columns([delivery_scope::Column::Id])
                .update_columns([
                    delivery_scope::Column::Title,
                    delivery_scope::Column::Outcome,
                    delivery_scope::Column::Owner,
                    delivery_scope::Column::OwnerName,
                    delivery_scope::Column::TargetDate,
                    delivery_scope::Column::Requirements,
                    delivery_scope::Column::Gears,
                    delivery_scope::Column::Acceptance,
                    delivery_scope::Column::State,
                    delivery_scope::Column::UpdatedBy,
                    delivery_scope::Column::UpdatedAt,
                ])?;
        delivery_scope::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope)?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    pub async fn list_scopes(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<delivery_scope::Model>> {
        let conn = self.db.conn()?;
        Ok(delivery_scope::Entity::find()
            .filter(delivery_scope::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .order_by(delivery_scope::Column::CreatedAt, Order::Asc)
            .all(&conn)
            .await?)
    }

    pub async fn delete_scope(&self, workspace_id: Uuid, id: Uuid) -> Result<()> {
        let conn = self.db.conn()?;
        delivery_scope::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .filter(Condition::all().add(delivery_scope::Column::Id.eq(id)))
            .exec(&conn)
            .await?;
        Ok(())
    }

    pub async fn insert_scope_history(&self, model: delivery_history::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(model.tenant_id);
        delivery_history::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope)?
            .exec(&conn)
            .await?;
        Ok(())
    }

    pub async fn list_scope_history(
        &self,
        workspace_id: Uuid,
        scope_id: Uuid,
    ) -> Result<Vec<delivery_history::Model>> {
        let conn = self.db.conn()?;
        Ok(delivery_history::Entity::find()
            .filter(delivery_history::Column::ScopeId.eq(scope_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .order_by(delivery_history::Column::ChangedAt, Order::Desc)
            .all(&conn)
            .await?)
    }

    pub async fn put_limit(&self, model: delivery_limit::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(model.tenant_id);
        let on_conflict =
            SecureOnConflict::<delivery_limit::Entity>::columns([delivery_limit::Column::Id])
                .update_columns([
                    delivery_limit::Column::Text,
                    delivery_limit::Column::Blocking,
                    delivery_limit::Column::DependsOn,
                    delivery_limit::Column::Resolution,
                    delivery_limit::Column::ResolvedBy,
                    delivery_limit::Column::ResolvedAt,
                ])?;
        delivery_limit::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope)?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    pub async fn list_limits(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<delivery_limit::Model>> {
        let conn = self.db.conn()?;
        Ok(delivery_limit::Entity::find()
            .filter(delivery_limit::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .order_by(delivery_limit::Column::CreatedAt, Order::Asc)
            .all(&conn)
            .await?)
    }

    /// Record a decision. Insert only.
    pub async fn insert_decision(&self, model: decision::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(model.tenant_id);
        decision::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope)?
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Every decision of a workspace, any project: what a move copies.
    pub async fn list_workspace_decisions(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<decision::Model>> {
        let conn = self.db.conn()?;
        let rows = decision::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// A project's decisions, newest first.
    pub async fn list_decisions(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<decision::Model>> {
        let conn = self.db.conn()?;
        let rows = decision::Entity::find()
            .filter(decision::Column::ProjectId.eq(project_id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .order_by(decision::Column::DecidedAt, Order::Desc)
            .all(&conn)
            .await?;
        Ok(rows)
    }

    // ── documents ───────────────────────────────────────────────────────────

    pub async fn get_doc(&self, workspace_id: Uuid, id: Uuid) -> Result<Option<document::Model>> {
        let conn = self.db.conn()?;
        let row = document::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .filter(Condition::all().add(document::Column::Id.eq(id)))
            .one(&conn)
            .await?;
        Ok(row)
    }

    // -- capabilities --------------------------------------------------------

    /// Tenant-defined capabilities for the given owners.
    pub async fn list_capabilities(
        &self,
        owner_tenant_ids: &[Uuid],
    ) -> Result<Vec<capability::Model>> {
        if owner_tenant_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = capability::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenants(owner_tenant_ids.to_vec()))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Insert or replace a tenant-defined capability.
    pub async fn upsert_capability(&self, model: capability::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let owner_tenant_id = model.tenant_id;
        let on_conflict = SecureOnConflict::<capability::Entity>::columns([capability::Column::Id])
            .update_columns([
                capability::Column::Label,
                capability::Column::Terms,
                capability::Column::Contracts,
                capability::Column::Nonfunctional,
                capability::Column::Hidden,
                capability::Column::UpdatedAt,
            ])?;
        capability::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(owner_tenant_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Drop one tenant's own capability entry for `key`.
    pub async fn delete_capability(&self, owner_tenant_id: Uuid, key: &str) -> Result<bool> {
        let conn = self.db.conn()?;
        let result = capability::Entity::delete_many()
            .filter(capability::Column::Key.eq(key))
            .secure()
            .scope_with(&AccessScope::for_tenant(owner_tenant_id))
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    /// Documents in scope, newest first, plus how many the filter matches.
    ///
    /// `LIMIT`/`OFFSET` are in the query rather than applied to a materialised
    /// `Vec`: a workspace accumulates documents forever and every row carries
    /// its full body, so an unbounded `SELECT` grows without limit. The
    /// `ORDER BY` is what makes an offset meaningful at all — `updated_at`
    /// alone is not unique, so the primary key breaks ties and keeps the
    /// sequence total.
    ///
    /// `limit: None` is the whole scope, for the callers that judge the set as
    /// a whole (stage readiness, analysis lookup) and never put it in a
    /// response body.
    pub async fn list_docs(
        &self,
        workspace_id: Uuid,
        scope: DocScope,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<(Vec<document::Model>, u64)> {
        let conn = self.db.conn()?;
        let filter = match scope {
            DocScope::WorkspaceLevel => Condition::all().add(document::Column::ProjectId.is_null()),
            DocScope::Effective(project_id) => Condition::any()
                .add(document::Column::ProjectId.is_null())
                .add(document::Column::ProjectId.eq(project_id)),
            DocScope::Everything => Condition::all(),
        };
        let scoped = || {
            document::Entity::find()
                .secure()
                .scope_with(&AccessScope::for_tenant(workspace_id))
                .filter(filter.clone())
        };
        let total = scoped().count(&conn).await?;
        let mut query = scoped()
            .order_by(document::Column::UpdatedAt, Order::Desc)
            .order_by(document::Column::Id, Order::Asc)
            .offset(offset);
        if let Some(limit) = limit {
            query = query.limit(limit);
        }
        let rows = query.all(&conn).await?;
        Ok((rows, total))
    }

    /// Create (fresh id → plain insert) or update (existing id → conflict
    /// updates the mutable columns; identity/provenance columns are left as they
    /// were, since the service passes them through unchanged).
    pub async fn upsert_doc(&self, model: document::Model) -> Result<()> {
        let conn = self.db.conn()?;
        let workspace_id = model.tenant_id;
        let on_conflict = SecureOnConflict::<document::Entity>::columns([document::Column::Id])
            .update_columns([
                document::Column::Title,
                document::Column::Content,
                document::Column::Status,
                document::Column::Conforms,
                document::Column::Validation,
                document::Column::Capabilities,
                document::Column::Requirements,
                document::Column::InferredCapabilities,
                document::Column::UpdatedAt,
            ])?;
        document::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(workspace_id))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Of `ids`, the documents that exist in this workspace tenant.
    pub async fn existing_doc_ids(
        &self,
        workspace_id: Uuid,
        ids: &[Uuid],
    ) -> Result<std::collections::HashSet<Uuid>> {
        if ids.is_empty() {
            return Ok(std::collections::HashSet::new());
        }
        let conn = self.db.conn()?;
        let rows = document::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .filter(Condition::all().add(document::Column::Id.is_in(ids.to_vec())))
            .all(&conn)
            .await?;
        Ok(rows.into_iter().map(|r| r.id).collect())
    }

    /// Delete a document within its workspace tenant scope.
    pub async fn delete_doc(&self, workspace_id: Uuid, id: Uuid) -> Result<bool> {
        let conn = self.db.conn()?;
        let result = document::Entity::delete_many()
            .filter(document::Column::Id.eq(id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }
}

impl DocumentsRepo {
    // ── document bindings (ingested files) ──────────────────────────────────

    /// Effective bindings for a scope, newest first, with the total across
    /// every page.
    pub async fn list_bindings(
        &self,
        workspace_id: Uuid,
        scope: DocScope,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<(Vec<document_binding::Model>, u64)> {
        let conn = self.db.conn()?;
        let filter = match scope {
            DocScope::WorkspaceLevel => {
                Condition::all().add(document_binding::Column::ProjectId.is_null())
            }
            DocScope::Effective(project_id) => Condition::any()
                .add(document_binding::Column::ProjectId.is_null())
                .add(document_binding::Column::ProjectId.eq(project_id)),
            DocScope::Everything => Condition::all(),
        };
        let scoped = || {
            document_binding::Entity::find()
                .secure()
                .scope_with(&AccessScope::for_tenant(workspace_id))
                .filter(filter.clone())
        };
        let total = scoped().count(&conn).await?;
        // By path, so the review queue reads like the repository it came from
        // rather than shuffling as verdicts are recorded.
        let mut query = scoped()
            .order_by(document_binding::Column::Path, Order::Asc)
            .order_by(document_binding::Column::Id, Order::Asc)
            .offset(offset);
        if let Some(limit) = limit {
            query = query.limit(limit);
        }
        Ok((query.all(&conn).await?, total))
    }

    /// The bindings in `scope` at any of `paths`, in path order.
    ///
    /// What the IDE asks when a file is opened: it knows the file's path and
    /// wants that one binding, and reading the whole list to find it was five
    /// pages and most of a megabyte on a project of a thousand files. Unpaged,
    /// because a path names at most a handful (one per repository).
    pub async fn list_bindings_at(
        &self,
        workspace_id: Uuid,
        scope: DocScope,
        paths: &[String],
    ) -> Result<Vec<document_binding::Model>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let filter = match scope {
            DocScope::WorkspaceLevel => {
                Condition::all().add(document_binding::Column::ProjectId.is_null())
            }
            DocScope::Effective(project_id) => Condition::any()
                .add(document_binding::Column::ProjectId.is_null())
                .add(document_binding::Column::ProjectId.eq(project_id)),
            DocScope::Everything => Condition::all(),
        };
        Ok(document_binding::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            // `all`, not `filter.add`: the effective scope is an `any`, and
            // a path added to it would widen the answer instead of narrowing it.
            .filter(
                Condition::all()
                    .add(filter)
                    .add(document_binding::Column::Path.is_in(paths.iter().cloned())),
            )
            .order_by(document_binding::Column::Path, Order::Asc)
            .order_by(document_binding::Column::Id, Order::Asc)
            .all(&conn)
            .await?)
    }

    pub async fn get_binding(
        &self,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<Option<document_binding::Model>> {
        let conn = self.db.conn()?;
        let row = document_binding::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .filter(Condition::all().add(document_binding::Column::Id.eq(id)))
            .one(&conn)
            .await?;
        Ok(row)
    }

    /// Insert or update one binding. `created_at` is left as it was on
    /// conflict, so a re-classified file keeps the date it first appeared.
    pub async fn upsert_binding(&self, model: document_binding::Model) -> Result<()> {
        self.upsert_bindings(std::slice::from_ref(&model)).await
    }

    /// Batch form — a classification run writes a whole repository at once.
    ///
    /// Split into bounded statements: a multi-row insert binds one parameter
    /// per column per row, and a repository with thousands of files would blow
    /// past Postgres's parameter ceiling in one statement.
    pub async fn upsert_bindings(&self, models: &[document_binding::Model]) -> Result<()> {
        const ROWS_PER_STATEMENT: usize = 500;

        let Some(first) = models.first() else {
            return Ok(());
        };
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(first.tenant_id);
        for chunk in models.chunks(ROWS_PER_STATEMENT) {
            let on_conflict = SecureOnConflict::<document_binding::Entity>::columns([
                document_binding::Column::Id,
            ])
            .update_columns([
                document_binding::Column::Path,
                document_binding::Column::TypeKey,
                document_binding::Column::State,
                document_binding::Column::Confidence,
                document_binding::Column::Source,
                document_binding::Column::Candidates,
                document_binding::Column::Conforms,
                document_binding::Column::Validation,
                document_binding::Column::Capabilities,
                document_binding::Column::Requirements,
                document_binding::Column::InferredCapabilities,
                document_binding::Column::ContentSha,
                document_binding::Column::UpdatedAt,
            ])?;
            document_binding::Entity::insert_many(
                chunk
                    .iter()
                    .cloned()
                    .map(IntoActiveModel::into_active_model),
            )
            .secure()
            .scope_unchecked(&scope)?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        }
        Ok(())
    }

    pub async fn delete_binding(&self, workspace_id: Uuid, id: Uuid) -> Result<bool> {
        let conn = self.db.conn()?;
        let result = document_binding::Entity::delete_many()
            .filter(document_binding::Column::Id.eq(id))
            .secure()
            .scope_with(&AccessScope::for_tenant(workspace_id))
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    /// Delete many bindings by id within one workspace tenant, returning how
    /// many rows went.
    ///
    /// Their verdicts go with them: `studio_document_analyses.binding_id` is
    /// `ON DELETE CASCADE` (m0008), the same way deleting a document takes its
    /// own. Chunked for the reason `upsert_bindings` is — an `IN` list binds
    /// one parameter per id.
    pub async fn delete_bindings(&self, workspace_id: Uuid, ids: &[Uuid]) -> Result<u64> {
        const IDS_PER_STATEMENT: usize = 1_000;

        if ids.is_empty() {
            return Ok(0);
        }
        let conn = self.db.conn()?;
        let mut deleted = 0u64;
        for chunk in ids.chunks(IDS_PER_STATEMENT) {
            let result = document_binding::Entity::delete_many()
                .filter(document_binding::Column::Id.is_in(chunk.to_vec()))
                .secure()
                .scope_with(&AccessScope::for_tenant(workspace_id))
                .exec(&conn)
                .await?;
            deleted += result.rows_affected;
        }
        Ok(deleted)
    }
}

/// UUIDv5 namespace for what is recorded about one application part.
const PART_NS: Uuid = Uuid::from_u128(0x2c71_95e4_8b0a_4f63_9d17_e6a3_04c8_51b2);

pub fn part_id(project_id: Uuid, repo: &str, kind: &str, reference: &str) -> Uuid {
    Uuid::new_v5(
        &PART_NS,
        format!("{project_id}\u{1f}{repo}\u{1f}{kind}\u{1f}{reference}").as_bytes(),
    )
}

/// One owner's every row of a table: what a move into the domain model copies
/// (ADR-0051 §8a). Unfiltered and unpaged on purpose: a move takes all of it.
macro_rules! owner_rows {
    ($($name:ident => $m:ident),* $(,)?) => {
        impl DocumentsRepo {
            $(
                pub async fn $name(&self, owner: Uuid) -> Result<Vec<$m::Model>> {
                    let conn = self.db.conn()?;
                    Ok($m::Entity::find()
                        .secure()
                        .scope_with(&AccessScope::for_tenant(owner))
                        .all(&conn)
                        .await?)
                }
            )*
        }
    };
}

owner_rows! {
    all_types => doc_type,
    all_analyses => analysis,
    all_extractions => spec_extraction,
    all_judgements => spec_judgement,
    all_spec_decisions => spec_decision,
    all_spec_reviews => spec_review,
    all_spec_terms => spec_term,
    all_docs => document,
    all_bindings => document_binding,
    all_parts => application_part,
    all_scopes => delivery_scope,
    all_limits => delivery_limit,
    all_scope_history => delivery_history,
}

/// Drop every row one owner has in the listed tables, in that order: what a
/// move into the domain model does once the model holds them, so nothing is
/// kept twice (ADR-0051 §8a). Dependents come first, so no cascade removes a
/// row before its own table is reached.
macro_rules! owner_purge {
    ($name:ident => [$($m:ident),* $(,)?]) => {
        impl DocumentsRepo {
            pub async fn $name(&self, owner: Uuid) -> Result<u64> {
                let conn = self.db.conn()?;
                let mut removed = 0u64;
                $(
                    removed += $m::Entity::delete_many()
                        .secure()
                        .scope_with(&AccessScope::for_tenant(owner))
                        .exec(&conn)
                        .await?
                        .rows_affected;
                )*
                Ok(removed)
            }
        }
    };
}

owner_purge!(purge_documents => [
    analysis,
    spec_extraction,
    spec_judgement,
    spec_decision,
    spec_review,
    spec_term,
    application_part,
    delivery_history,
    delivery_limit,
    delivery_scope,
    document_binding,
    document,
    doc_type,
]);

owner_purge!(purge_reviews => [approval, review_request, decision]);

/// Write rows back into their tables, as the model held them: what switching
/// a kind of data back to `tables` does (ADR-0051 §8a). Plain inserts — the
/// owner's rows left the tables when they moved.
macro_rules! rows_restore {
    ($($name:ident => $m:ident),* $(,)?) => {
        impl DocumentsRepo {
            $(
                pub async fn $name(&self, owner: Uuid, rows: Vec<$m::Model>) -> Result<usize> {
                    if rows.is_empty() {
                        return Ok(0);
                    }
                    let conn = self.db.conn()?;
                    let scope = AccessScope::for_tenant(owner);
                    let n = rows.len();
                    for chunk in rows.chunks(500) {
                        $m::Entity::insert_many(
                            chunk.iter().cloned().map(IntoActiveModel::into_active_model),
                        )
                        .secure()
                        .scope_unchecked(&scope)?
                        .exec(&conn)
                        .await?;
                    }
                    Ok(n)
                }
            )*
        }
    };
}

rows_restore! {
    restore_types => doc_type,
    restore_docs => document,
    restore_bindings => document_binding,
    restore_analyses => analysis,
    restore_extractions => spec_extraction,
    restore_judgements => spec_judgement,
    restore_spec_decisions => spec_decision,
    restore_spec_reviews => spec_review,
    restore_spec_terms => spec_term,
    restore_parts => application_part,
    restore_scopes => delivery_scope,
    restore_limits => delivery_limit,
    restore_scope_history => delivery_history,
    restore_review_requests => review_request,
    restore_approvals => approval,
    restore_decisions => decision,
}
