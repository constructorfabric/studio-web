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
};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::entity::{analysis, capability, doc_type, document, document_binding, stage};

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
const BINDING_NS: Uuid = Uuid::from_u128(0x2b41_e6c7_8d35_4f90_a7e2_5c18_93ab_f604);

/// Which documents a list call wants.
pub enum DocScope {
    /// Only workspace-level documents (`project_id IS NULL`).
    WorkspaceLevel,
    /// Effective set for a project: workspace-level (inherited) + the project's
    /// own (`project_id IS NULL OR project_id = pid`).
    Effective(Uuid),
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
}
