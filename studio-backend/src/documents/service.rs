//! studio-documents service: the three-level type catalogue (built-in,
//! organization, workspace), create from template, effective (inherited)
//! document lists, structural validation, and CRUD. Bridges the domain model
//! to the sea-orm rows the repo persists.

use std::collections::BTreeMap;
use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, Tenant};
use anyhow::{Context, Result, bail};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::classify::{classify, is_prose_path};
use super::entity::{analysis, capability, doc_type, document, document_binding, stage};
use super::intake::{self, Answer};
use super::model::{
    Analysis, AnalysisState, BindingState, Capability, CatalogEntry, DetectionSource, DocStatus,
    Document, DocumentBinding, DocumentType, Owner, Requirement, Stage, StageStatus, TYPE_GTS_ID,
    TemplateSpec, TypeCandidate, builtin_capabilities, builtin_stages, builtin_types,
};
use super::port::{ClassifiedCounts, DocumentClassifier, IngestedDocument};
use super::repo::{
    DocScope, DocumentsRepo, analysis_row_id, binding_row_id, capability_row_id, stage_row_id,
    type_row_id,
};
use super::validate::{ValidationReport, validate};
use crate::pagination::PageQuery;

pub struct DocumentsService {
    repo: Arc<DocumentsRepo>,
    account_management: Arc<dyn AccountManagementClient>,
}

impl DocumentsService {
    pub fn new(
        repo: Arc<DocumentsRepo>,
        account_management: Arc<dyn AccountManagementClient>,
    ) -> Self {
        Self {
            repo,
            account_management,
        }
    }

    /// Authorize the caller against a tenant from the request path. Resolving
    /// the tenant under the caller's `SecurityContext` both proves it exists and
    /// delegates hierarchy authorization to account-management — the same guard
    /// `studio-kits` puts in front of its project routes. Callers must run this
    /// before touching a workspace or project's documents.
    pub async fn authorize(&self, ctx: &SecurityContext, tenant_id: Uuid) -> Result<()> {
        self.resolve_tenant(ctx, tenant_id).await.map(|_| ())
    }

    /// The same guard as [`Self::authorize`], keeping what it read.
    async fn resolve_tenant(&self, ctx: &SecurityContext, tenant_id: Uuid) -> Result<Tenant> {
        self.account_management
            .get_tenant(ctx, tenant_id)
            .await
            .map_err(|e| anyhow::anyhow!("tenant {tenant_id} not accessible: {e}"))
    }

    /// The tenants whose rows make up a workspace's catalogue, in overlay
    /// order: the organization first, the workspace last, so the workspace wins.
    ///
    /// The organization is read from the WORKSPACE's own `parent_id` and never
    /// with a second `get_tenant(organization)`. AM answers `NotFound` for a
    /// tenant outside the caller's PDP-compiled subtree, and an ordinary
    /// workspace member has no scope on the organization -- inheriting a
    /// catalogue must not require permission to read the level that published
    /// it. A workspace directly under the platform root simply has a shorter
    /// chain.
    async fn owner_chain(&self, ctx: &SecurityContext, workspace_id: Uuid) -> Result<Vec<Uuid>> {
        let workspace = self.resolve_tenant(ctx, workspace_id).await?;
        Ok(match workspace.parent_id {
            Some(parent) => vec![parent.0, workspace_id],
            None => vec![workspace_id],
        })
    }

    // ── types ────────────────────────────────────────────────────────────────

    /// Effective types for a workspace: the platform catalogue, overlaid by the
    /// organization's entries, overlaid by the workspace's, with tombstones
    /// removed last (ADR-0014 section 4).
    ///
    /// The overlay is applied in chain order rather than in row order. One
    /// query returns both levels and says nothing about which is which, so
    /// sorting by owner here is what makes "the workspace wins" true instead of
    /// incidental.
    ///
    /// Tombstones are dropped at the end, not skipped while overlaying: a
    /// hidden entry still has to overwrite the one it hides, or the level below
    /// would survive it.
    pub async fn list_types(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> Result<Vec<DocumentType>> {
        let chain = self.owner_chain(ctx, workspace_id).await?;
        self.resolve_types(&chain, Some(workspace_id)).await
    }

    /// What an organization itself publishes: the platform catalogue overlaid
    /// by its own entries, with no workspace level below it.
    ///
    /// This is the editing view, so it is deliberately NOT what any workspace
    /// sees -- a workspace may hide or replace any of it.
    pub async fn list_organization_types(
        &self,
        ctx: &SecurityContext,
        organization_id: Uuid,
    ) -> Result<Vec<DocumentType>> {
        self.authorize(ctx, organization_id).await?;
        self.resolve_types(&[organization_id], None).await
    }

    /// Overlay the platform catalogue with each level in `chain`, in order.
    ///
    /// `workspace_id` is the level that counts as "workspace" when labelling a
    /// row's owner; `None` means every row belongs to an organization, which is
    /// the organization's own editing view.
    async fn resolve_types(
        &self,
        chain: &[Uuid],
        workspace_id: Option<Uuid>,
    ) -> Result<Vec<DocumentType>> {
        let rows = self.repo.list_types(chain).await?;
        let entries = rows
            .into_iter()
            .map(|row| {
                let tenant = row.tenant_id;
                type_from_row(row, workspace_id).map(|t| (tenant, t))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(overlay(builtin_types(), chain, entries))
    }

    pub async fn get_type(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        key: &str,
    ) -> Result<Option<DocumentType>> {
        Ok(self
            .list_types(ctx, workspace_id)
            .await?
            .into_iter()
            .find(|t| t.key == key))
    }

    /// Define or replace a type owned by one tenant.
    ///
    /// `owner` decides which level the row lands on, and the route decides
    /// `owner`: publishing at organization level is authorized against the
    /// organization tenant, which is the whole access rule -- whoever may read
    /// the organization may change what every workspace under it inherits.
    pub async fn upsert_type(&self, owner: Owner, mut ty: DocumentType) -> Result<DocumentType> {
        let owner_tenant_id = owner_tenant(owner.clone())?;
        ty.key = normalize_key(&ty.key)?;
        ty.owner = owner;
        ty.gts_type_id = TYPE_GTS_ID.to_string();
        let now = OffsetDateTime::now_utc();
        let model = doc_type::Model {
            id: type_row_id(owner_tenant_id, &ty.key),
            tenant_id: owner_tenant_id,
            key: ty.key.clone(),
            name: ty.name.clone(),
            description: ty.description.clone(),
            gts_type_id: ty.gts_type_id.clone(),
            template: serde_json::to_string(&ty.template)?,
            hidden: ty.hidden,
            created_at: now,
            updated_at: now,
        };
        self.repo.upsert_type(model).await?;
        Ok(ty)
    }

    /// Drop this level's own entry for `key`, reverting to whatever the level
    /// below publishes.
    ///
    /// The counterpart to a tombstone, and not the same thing: hiding ADDS an
    /// entry that suppresses what it overrides, while this REMOVES one so the
    /// level below shows through. Without it an override is a one-way door --
    /// a workspace that once replaced `prd` could never go back to the
    /// organization's, which would make the whole overlay a trap rather than a
    /// setting (ADR-0014 section 4).
    pub async fn delete_type(&self, owner: Owner, key: &str) -> Result<bool> {
        self.repo.delete_type(owner_tenant(owner)?, key).await
    }

    // -- journey stages ------------------------------------------------------

    /// The stages a workspace's projects may pass through, in catalogue order.
    ///
    /// This is what `GET /studio-project/v1/stages` used to answer before that
    /// gear was retired and the catalogue became a constant in two frontends
    /// (ADR-0010, ADR-0014 section 7).
    pub async fn list_stages(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> Result<Vec<Stage>> {
        let chain = self.owner_chain(ctx, workspace_id).await?;
        self.resolve_stages(&chain, Some(workspace_id)).await
    }

    /// What an organization itself publishes, with no workspace level below it.
    pub async fn list_organization_stages(
        &self,
        ctx: &SecurityContext,
        organization_id: Uuid,
    ) -> Result<Vec<Stage>> {
        self.authorize(ctx, organization_id).await?;
        self.resolve_stages(&[organization_id], None).await
    }

    async fn resolve_stages(
        &self,
        chain: &[Uuid],
        workspace_id: Option<Uuid>,
    ) -> Result<Vec<Stage>> {
        let rows = self.repo.list_stages(chain).await?;
        let entries = rows
            .into_iter()
            .map(|row| {
                let tenant = row.tenant_id;
                stage_from_row(row, workspace_id).map(|st| (tenant, st))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut stages = overlay(builtin_stages(), chain, entries);
        // `overlay` returns key order, which is right for a catalogue nobody
        // walks in sequence and wrong for this one: stages ARE a sequence. Sort
        // by the declared position, and fall back to the key so a listing is
        // never arbitrary when two entries claim the same slot.
        stages.sort_by(|a, b| (a.position, &a.key).cmp(&(b.position, &b.key)));
        Ok(stages)
    }

    /// Define, replace or hide a stage at one level.
    pub async fn upsert_stage(&self, owner: Owner, mut st: Stage) -> Result<Stage> {
        let owner_tenant_id = owner_tenant(owner.clone())?;
        st.key = normalize_key(&st.key)?;
        st.owner = owner;
        let now = OffsetDateTime::now_utc();
        let model = stage::Model {
            id: stage_row_id(owner_tenant_id, &st.key),
            tenant_id: owner_tenant_id,
            key: st.key.clone(),
            label: st.label.clone(),
            required: st.required,
            ordinal: st.position,
            requires: serde_json::to_string(&st.requires)?,
            gates: serde_json::to_string(&st.gates)?,
            hidden: st.hidden,
            created_at: now,
            updated_at: now,
        };
        self.repo.upsert_stage(model).await?;
        Ok(st)
    }

    /// Drop this level's own stage entry for `key`. Same reasoning as
    /// [`Self::delete_type`].
    pub async fn delete_stage(&self, owner: Owner, key: &str) -> Result<bool> {
        self.repo.delete_stage(owner_tenant(owner)?, key).await
    }

    // -- capabilities --------------------------------------------------------

    /// The capability vocabulary a workspace's questionnaires may seed and its
    /// composer resolves against.
    pub async fn list_capabilities(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> Result<Vec<Capability>> {
        let chain = self.owner_chain(ctx, workspace_id).await?;
        self.resolve_capabilities(&chain, Some(workspace_id)).await
    }

    pub async fn list_organization_capabilities(
        &self,
        ctx: &SecurityContext,
        organization_id: Uuid,
    ) -> Result<Vec<Capability>> {
        self.authorize(ctx, organization_id).await?;
        self.resolve_capabilities(&[organization_id], None).await
    }

    async fn resolve_capabilities(
        &self,
        chain: &[Uuid],
        workspace_id: Option<Uuid>,
    ) -> Result<Vec<Capability>> {
        let rows = self.repo.list_capabilities(chain).await?;
        let entries = rows
            .into_iter()
            .map(|row| {
                let tenant = row.tenant_id;
                capability_from_row(row, workspace_id).map(|c| (tenant, c))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(overlay(builtin_capabilities(), chain, entries))
    }

    /// Define, replace or hide a capability at one level.
    pub async fn upsert_capability(&self, owner: Owner, mut cap: Capability) -> Result<Capability> {
        let owner_tenant_id = owner_tenant(owner.clone())?;
        cap.key = normalize_key(&cap.key)?;
        cap.owner = owner;
        let now = OffsetDateTime::now_utc();
        let model = capability::Model {
            id: capability_row_id(owner_tenant_id, &cap.key),
            tenant_id: owner_tenant_id,
            key: cap.key.clone(),
            label: cap.label.clone(),
            terms: serde_json::to_string(&cap.terms)?,
            hidden: cap.hidden,
            created_at: now,
            updated_at: now,
        };
        self.repo.upsert_capability(model).await?;
        Ok(cap)
    }

    /// Drop this level's own capability entry for `key`.
    pub async fn delete_capability(&self, owner: Owner, key: &str) -> Result<bool> {
        self.repo.delete_capability(owner_tenant(owner)?, key).await
    }

    // -- analyses and the stage gate ------------------------------------------

    /// Record one detector's verdict on a document.
    ///
    /// The gear does not run the analysis. `studio-spec-quality` is a
    /// passthrough whose task lifecycle the caller drives; this is where the
    /// answer lands afterwards, so that a stage can depend on it.
    pub async fn record_analysis(
        &self,
        workspace_id: Uuid,
        document_id: Uuid,
        detector: &str,
        state: AnalysisState,
        task_id: Option<String>,
        summary: String,
    ) -> Result<Analysis> {
        let detector = normalize_key(detector)?;
        // Refuse a verdict about a document this workspace does not have: the
        // row would be unreachable through every read path and would still
        // count against a stage gate.
        self.repo
            .get_doc(workspace_id, document_id)
            .await?
            .context("no such document")?;

        let now = OffsetDateTime::now_utc();
        let model = analysis::Model {
            id: analysis_row_id(document_id, &detector),
            tenant_id: workspace_id,
            document_id: Some(document_id),
            binding_id: None,
            detector: detector.clone(),
            state: state.as_str().to_string(),
            task_id: task_id.clone(),
            summary: summary.clone(),
            created_at: now,
            updated_at: now,
        };
        self.repo.upsert_analysis(model).await?;
        Ok(Analysis {
            document_id: Some(document_id),
            binding_id: None,
            detector,
            state,
            task_id,
            summary,
            updated_at: now.format(&Rfc3339)?,
        })
    }

    /// Every verdict recorded for a project's effective documents.
    pub async fn list_analyses(
        &self,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
    ) -> Result<Vec<Analysis>> {
        // A project's effective documents are both kinds now, so a listing that
        // read only one of them would answer half the question it is asked.
        let docs = self.all_documents(workspace_id, project_id).await?;
        let doc_ids: Vec<Uuid> = docs.iter().map(|d| d.id).collect();
        let (binding_rows, _) = self
            .repo
            .list_bindings(workspace_id, binding_scope(project_id), 0, None)
            .await?;
        let binding_ids: Vec<Uuid> = binding_rows.iter().map(|b| b.id).collect();

        let mut rows = self.repo.list_analyses(workspace_id, &doc_ids).await?;
        rows.extend(
            self.repo
                .list_binding_analyses(workspace_id, &binding_ids)
                .await?,
        );
        rows.into_iter().map(analysis_from_row).collect()
    }

    /// Record a detector's verdict about a bound repository file.
    ///
    /// The full finding lives in the artifact graph, joined to the file node;
    /// this row is the INDEX a stage gate reads, the same way a document's
    /// `capabilities` column indexes its own front matter. The gate needs one
    /// question answered cheaply — did this detector pass for this document —
    /// and walking the graph to answer it, per stage, per requirement, is not
    /// the shape of that question.
    pub async fn record_binding_analysis(
        &self,
        workspace_id: Uuid,
        binding_id: Uuid,
        detector: &str,
        state: AnalysisState,
        task_id: Option<String>,
        summary: String,
    ) -> Result<Analysis> {
        let detector = normalize_key(detector)?;
        // Refuse a verdict about a binding this workspace does not have, for
        // the same reason the document path does: the row would be unreachable
        // through every read and would still count against a stage gate.
        self.repo
            .get_binding(workspace_id, binding_id)
            .await?
            .context("no such document binding")?;

        let now = OffsetDateTime::now_utc();
        let model = analysis::Model {
            id: analysis_row_id(binding_id, &detector),
            tenant_id: workspace_id,
            document_id: None,
            binding_id: Some(binding_id),
            detector: detector.clone(),
            state: state.as_str().to_string(),
            task_id: task_id.clone(),
            summary: summary.clone(),
            created_at: now,
            updated_at: now,
        };
        self.repo.upsert_analysis(model).await?;
        Ok(Analysis {
            document_id: None,
            binding_id: Some(binding_id),
            detector,
            state,
            task_id,
            summary,
            updated_at: now.format(&Rfc3339)?,
        })
    }

    /// Where a project stands against the stages of its workspace.
    ///
    /// This is the gate the catalogue was for: a stage names the document types
    /// it cannot do without and the detectors those documents must pass, and
    /// this answers whether they do. It computes rather than stores -- a stored
    /// "complete" flag goes stale the moment a document is edited.
    pub async fn stage_status(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<StageStatus>> {
        let stages = self.list_stages(ctx, workspace_id).await?;
        let docs = self.all_documents(workspace_id, Some(project_id)).await?;
        let ids: Vec<Uuid> = docs.iter().map(|d| d.id).collect();
        let analyses = self.repo.list_analyses(workspace_id, &ids).await?;
        // Every binding in scope, not a page: a stage asks whether the project
        // has a document of some type at all, and a page would answer about
        // whichever ones happened to sort first.
        let (binding_rows, _) = self
            .repo
            .list_bindings(workspace_id, binding_scope(Some(project_id)), 0, None)
            .await?;
        let binding_ids: Vec<Uuid> = binding_rows.iter().map(|b| b.id).collect();
        let bindings = binding_rows
            .into_iter()
            .map(binding_from_row)
            .collect::<Result<Vec<_>>>()?;
        let binding_analyses = self
            .repo
            .list_binding_analyses(workspace_id, &binding_ids)
            .await?;

        Ok(stages
            .into_iter()
            .map(|stage| evaluate_stage(stage, &docs, &bindings, &analyses, &binding_analyses))
            .collect())
    }

    // ── documents ─────────────────────────────────────────────────────────────

    /// Create a document from a type. `project_id = None` makes it a
    /// workspace-level document inherited by every project.
    // Eight arguments, one over the lint: the security context joined the list
    // when the type catalogue became tenant-resolved, and the other seven are
    // the document's own fields. Bundling them into a struct would move the
    // same list one indirection away without making a call site clearer.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_document(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        type_key: &str,
        title: &str,
        content: Option<String>,
        answers: Option<Vec<Answer>>,
        created_by: String,
    ) -> Result<Document> {
        let ty = self
            .get_type(ctx, workspace_id, type_key)
            .await?
            .context("unknown document type")?;
        // Three ways to get a body, in the order they take precedence:
        // answers (composed here), explicit content, or the bare template.
        // Sending both answers and content is a caller confusion, not a
        // precedence question -- one of them would be silently discarded.
        if answers.is_some() && content.is_some() {
            bail!("send either `answers` or `content`, not both");
        }
        if let Some(answers) = answers.as_ref() {
            if ty.template.questionnaire.is_empty() {
                bail!("document type `{}` has no questionnaire to answer", ty.key);
            }
            let unknown: Vec<&str> = answers
                .iter()
                .map(|a| a.question_id.as_str())
                .filter(|id| !ty.template.questionnaire.iter().any(|q| q.id == *id))
                .collect();
            if !unknown.is_empty() {
                bail!("no such question in `{}`: {}", ty.key, unknown.join(", "));
            }
        }
        let body = match answers {
            Some(answers) => intake::generate(&ty, title, &answers),
            None => content.unwrap_or_else(|| ty.template.body.clone()),
        };
        let report = validate(&body, &ty.template);
        let capabilities = serde_json::to_string(&intake::declared_capabilities(&body))?;
        let now = OffsetDateTime::now_utc();
        let model = document::Model {
            id: Uuid::new_v4(),
            tenant_id: workspace_id,
            project_id,
            type_key: ty.key.clone(),
            title: title.trim().to_string(),
            content: body,
            status: DocStatus::Draft.rank() as i16,
            conforms: report.conforms,
            validation: serde_json::to_string(&report)?,
            capabilities: capabilities.clone(),
            created_by,
            created_at: now,
            updated_at: now,
        };
        self.repo.upsert_doc(model.clone()).await?;
        doc_from_row(model)
    }

    /// One page of the effective documents, plus how many the scope holds.
    ///
    /// Effective documents: for a project, its own plus the workspace-level
    /// ones it inherits; for a workspace (`project_id = None`), the
    /// workspace-level ones only.
    pub async fn list_documents(
        &self,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        page: PageQuery,
    ) -> Result<(Vec<Document>, u32)> {
        let (documents, total) = self
            .read_documents(
                workspace_id,
                project_id,
                page.offset() as u64,
                Some(page.limit() as u64),
            )
            .await?;
        Ok((documents, u32::try_from(total).unwrap_or(u32::MAX)))
    }

    /// Every effective document in scope.
    ///
    /// For the readiness computations that judge the set as a whole — a page
    /// of it would silently answer a different question. Nothing here reaches
    /// a response body, so the bound is the workspace rather than a page.
    async fn all_documents(
        &self,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
    ) -> Result<Vec<Document>> {
        Ok(self
            .read_documents(workspace_id, project_id, 0, None)
            .await?
            .0)
    }

    async fn read_documents(
        &self,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<(Vec<Document>, u64)> {
        let scope = match project_id {
            Some(pid) => DocScope::Effective(pid),
            None => DocScope::WorkspaceLevel,
        };
        let (rows, total) = self
            .repo
            .list_docs(workspace_id, scope, offset, limit)
            .await?;
        let documents = rows
            .into_iter()
            .map(doc_from_row)
            .collect::<Result<Vec<Document>>>()?;
        Ok((documents, total))
    }

    pub async fn get_document(&self, workspace_id: Uuid, id: Uuid) -> Result<Option<Document>> {
        match self.repo.get_doc(workspace_id, id).await? {
            Some(row) => Ok(Some(doc_from_row(row)?)),
            None => Ok(None),
        }
    }

    pub async fn update_document(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        status: Option<DocStatus>,
    ) -> Result<Document> {
        let mut row = self
            .repo
            .get_doc(workspace_id, id)
            .await?
            .context("no such document")?;
        if let Some(t) = title {
            row.title = t.trim().to_string();
        }
        if let Some(c) = content {
            row.content = c;
        }
        if let Some(next) = status {
            let current = status_from_i16(row.status);
            if !current.can_move_to(next) {
                bail!("status can only move forward");
            }
            row.status = next.rank() as i16;
        }
        // Re-validate against the (possibly workspace-overridden) type.
        let report = match self.get_type(ctx, workspace_id, &row.type_key).await? {
            Some(ty) => validate(&row.content, &ty.template),
            None => ValidationReport {
                conforms: false,
                sections: Vec::new(),
                issues: vec!["unknown document type".to_string()],
            },
        };
        row.conforms = report.conforms;
        row.validation = serde_json::to_string(&report)?;
        // Re-index rather than preserve: the front matter is the document's own
        // statement of what it declares, and an edit is allowed to change it.
        row.capabilities = serde_json::to_string(&intake::declared_capabilities(&row.content))?;
        row.updated_at = OffsetDateTime::now_utc();
        self.repo.upsert_doc(row.clone()).await?;
        doc_from_row(row)
    }

    pub async fn validate_document(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<ValidationReport> {
        let row = self
            .repo
            .get_doc(workspace_id, id)
            .await?
            .context("no such document")?;
        let ty = self
            .get_type(ctx, workspace_id, &row.type_key)
            .await?
            .context("unknown document type")?;
        Ok(validate(&row.content, &ty.template))
    }

    pub async fn delete_document(&self, workspace_id: Uuid, id: Uuid) -> Result<bool> {
        self.repo.delete_doc(workspace_id, id).await
    }
}

// ── domain ↔ row mapping ────────────────────────────────────────────────────

/// Overlay tenant entries onto the platform catalogue, level by level.
///
/// This is the whole of ADR-0014 section 4, and none of it needs a database or
/// an account-management round trip: given the chain and the rows, the
/// effective catalogue is a pure function. It is generic because document types
/// and stages resolve by identical rules -- one resolver, several catalogues --
/// and a second copy of this would be a second place for the ordering rule to
/// drift.
///
/// `rows` is `(owning tenant, entry)`; the caller has already turned storage
/// rows into entries, which is the only part that differs per catalogue.
///
/// Two details carry weight:
///
/// * levels are applied in CHAIN order, not row order. One `IN` query returns
///   every level at once and says nothing about which is which, so sorting here
///   is what makes "the lower level wins" true rather than incidental.
/// * tombstones are dropped at the END, not skipped while overlaying: a hidden
///   entry still has to overwrite the one it hides, or the level below would
///   survive it.
fn overlay<T: CatalogEntry>(builtins: Vec<T>, chain: &[Uuid], rows: Vec<(Uuid, T)>) -> Vec<T> {
    let mut by_key: BTreeMap<String, T> = builtins
        .into_iter()
        .map(|t| (t.key().to_string(), t))
        .collect();
    for owner in chain {
        for (_, entry) in rows.iter().filter(|(tenant, _)| tenant == owner) {
            by_key.insert(entry.key().to_string(), entry.clone());
        }
    }
    by_key.into_values().filter(|t| !t.is_hidden()).collect()
}

fn stage_from_row(row: stage::Model, workspace_id: Option<Uuid>) -> Result<Stage> {
    let requires: Vec<String> =
        serde_json::from_str(&row.requires).context("stage `requires` is malformed")?;
    Ok(Stage {
        key: row.key,
        label: row.label,
        required: row.required,
        position: row.ordinal,
        requires,
        gates: serde_json::from_str(&row.gates).context("stage `gates` is malformed")?,
        owner: owner_of(row.tenant_id, workspace_id),
        hidden: row.hidden,
    })
}

/// Whether one stage's conditions are met, given a project's documents and the
/// verdicts recorded for them.
///
/// Pure, and split out for that reason: this is the rule the whole catalogue
/// exists to serve, and it should be statable as examples rather than reachable
/// only through a database and two tenants.
///
/// Two judgements are deliberate:
///
/// * A gate is read from whichever subject answers for the document: a
///   Studio document's own verdicts, or the ones recorded against the binding
///   of a repository file. Neither opens a gate the detector has not passed.
/// * A gate on a document that does NOT exist reports nothing outstanding.
///   `present: false` already says what is wrong, and repeating it as four
///   failing detectors would bury the one fact that matters.
/// * Only `passed` opens a gate. Missing, pending, failed and anything this
///   build does not recognise all keep it shut -- a gate that opens on a value
///   we cannot interpret is worse than one that stays closed.
/// * A requirement is met by a document created in Studio **or** by a
///   repository file someone bound to that type. A project whose PRD has always
///   lived in its repository has a PRD, and a journey that called it missing
///   was reporting on where the file is kept rather than on the project.
/// * Only a binding a PERSON settled counts. `detected` is the classifier's
///   opinion, and a stage is a claim about the project -- opening one on an
///   unreviewed guess would make the journey say what nobody agreed to.
fn evaluate_stage(
    stage: Stage,
    docs: &[Document],
    bindings: &[DocumentBinding],
    analyses: &[analysis::Model],
    binding_analyses: &[analysis::Model],
) -> StageStatus {
    let requirements: Vec<Requirement> = stage
        .requires
        .iter()
        .map(|type_key| {
            let doc = docs.iter().find(|d| &d.type_key == type_key);
            let bound = bindings.iter().find(|b| {
                b.type_key.as_deref() == Some(type_key.as_str())
                    && matches!(b.state, BindingState::Confirmed | BindingState::Manual)
            });
            let analyses_outstanding = match doc {
                Some(doc) => stage
                    .gates
                    .iter()
                    .filter(|detector| {
                        !analyses.iter().any(|a| {
                            a.document_id == Some(doc.id)
                                && &a.detector == *detector
                                && a.state == AnalysisState::Passed.as_str()
                        })
                    })
                    .cloned()
                    .collect(),
                // A repository file answers for itself the same way, through
                // the verdicts recorded against its binding. Its gates open on
                // evidence or stay shut without it -- what they never do is
                // open because nobody could produce any.
                None => match bound {
                    Some(b) => stage
                        .gates
                        .iter()
                        .filter(|detector| {
                            !binding_analyses.iter().any(|a| {
                                a.binding_id == Some(b.id)
                                    && &a.detector == *detector
                                    && a.state == AnalysisState::Passed.as_str()
                            })
                        })
                        .cloned()
                        .collect(),
                    None => Vec::new(),
                },
            };
            Requirement {
                type_key: type_key.clone(),
                present: doc.is_some() || bound.is_some(),
                conforms: doc.is_some_and(|d| d.conforms)
                    || bound.is_some_and(|b| b.conforms == Some(true)),
                analyses_outstanding,
            }
        })
        .collect();

    StageStatus {
        complete: requirements
            .iter()
            .all(|r| r.present && r.conforms && r.analyses_outstanding.is_empty()),
        key: stage.key,
        label: stage.label,
        required: stage.required,
        requirements,
    }
}

fn analysis_from_row(row: analysis::Model) -> Result<Analysis> {
    Ok(Analysis {
        document_id: row.document_id,
        binding_id: row.binding_id,
        detector: row.detector,
        // An unrecognised state means the row was written by something newer
        // than this build. Reading it as pending is the safe choice: a gate
        // stays shut rather than opening on a value we cannot interpret.
        state: AnalysisState::parse(&row.state).unwrap_or(AnalysisState::Pending),
        task_id: row.task_id,
        summary: row.summary,
        updated_at: row.updated_at.format(&Rfc3339)?,
    })
}

fn capability_from_row(row: capability::Model, workspace_id: Option<Uuid>) -> Result<Capability> {
    let terms: Vec<String> =
        serde_json::from_str(&row.terms).context("capability `terms` is malformed")?;
    Ok(Capability {
        key: row.key,
        label: row.label,
        terms,
        owner: owner_of(row.tenant_id, workspace_id),
        hidden: row.hidden,
    })
}

/// The tenant a write lands on. `Builtin` has no row to write, which is what
/// makes the platform catalogue read-only rather than merely conventional.
fn owner_tenant(owner: Owner) -> Result<Uuid> {
    match owner {
        Owner::Organization { tenant_id } | Owner::Workspace { tenant_id } => Ok(tenant_id),
        Owner::Builtin => bail!("the platform catalogue is not writable"),
    }
}

/// Which level a row belongs to. `workspace_id` is what tells the two apart:
/// the query that produced the row asked for the organization and the workspace
/// at once, and the row itself only carries which tenant owns it. `None` is the
/// organization's own editing view, where nothing is a workspace.
fn owner_of(tenant_id: Uuid, workspace_id: Option<Uuid>) -> Owner {
    if workspace_id == Some(tenant_id) {
        Owner::Workspace { tenant_id }
    } else {
        Owner::Organization { tenant_id }
    }
}

/// `workspace_id` is what tells the two levels apart: the query that produced
/// this row asked for the organization and the workspace at once, and the row
/// itself only carries which tenant owns it.
fn type_from_row(row: doc_type::Model, workspace_id: Option<Uuid>) -> Result<DocumentType> {
    let template: TemplateSpec =
        serde_json::from_str(&row.template).context("document type template is malformed")?;
    let owner = owner_of(row.tenant_id, workspace_id);
    Ok(DocumentType {
        key: row.key,
        name: row.name,
        description: row.description,
        hidden: row.hidden,
        // Not `row.gts_type_id`: rows written before ADR-0014 carry a per-key
        // id (`gts.cf.studio.doc.{key}.v1~`) that was never registered
        // anywhere. Normalising on read makes the effective catalogue uniform
        // without a data migration, and the column stays for forensics.
        gts_type_id: TYPE_GTS_ID.to_string(),
        owner,
        template,
    })
}

fn doc_from_row(row: document::Model) -> Result<Document> {
    // A row written before m0005 carries the column default; parsing it as an
    // empty list is right, and the next write re-indexes it from the content.
    let capabilities: Vec<String> = serde_json::from_str(&row.capabilities).unwrap_or_default();
    Ok(Document {
        capabilities,
        id: row.id,
        tenant_id: row.tenant_id,
        project_id: row.project_id,
        type_key: row.type_key,
        title: row.title,
        content: row.content,
        status: status_from_i16(row.status),
        conforms: row.conforms,
        created_by: row.created_by,
        created_at: rfc3339(row.created_at),
        updated_at: rfc3339(row.updated_at),
    })
}

fn status_from_i16(value: i16) -> DocStatus {
    match value {
        1 => DocStatus::Review,
        2 => DocStatus::Approved,
        _ => DocStatus::Draft,
    }
}

// ── ingested documents ──────────────────────────────────────────────────────
// A document written in Studio knows its type — someone picked it. A document
// that was already in the repository does not, and its content stays where
// ingest put it: the artifact graph. A **binding** is the thin record that
// joins the two, so both kinds end up judged by the same templates.

/// UUIDv5 namespace for the content digest a binding records. A digest, not a
/// copy: it exists only to tell a current verdict from one computed against
/// content that has since been re-synced.
const CONTENT_NS: Uuid = Uuid::from_u128(0x9f38_71ea_4c02_4d6b_b5a1_0e77_cc92_38d5);

/// One file offered for classification: where it lives in the graph, what it is
/// called, and its current text. The text is read, never stored.
pub struct IngestedFile {
    pub node_id: String,
    pub path: String,
    pub content: String,
}

/// What a classification run did.
pub struct ClassifyOutcome {
    pub bindings: Vec<DocumentBinding>,
    /// Files whose path is not prose at all (source, images, lockfiles). They
    /// get no binding — there is nothing to be undecided about.
    pub skipped: usize,
}

#[async_trait::async_trait]
impl DocumentClassifier for DocumentsService {
    async fn classify_ingested(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        files: Vec<IngestedDocument>,
    ) -> Result<ClassifiedCounts> {
        let outcome = DocumentsService::classify_ingested(
            self,
            ctx,
            workspace_id,
            project_id,
            files
                .into_iter()
                .map(|f| IngestedFile {
                    node_id: f.node_id,
                    path: f.path,
                    content: f.content,
                })
                .collect(),
        )
        .await?;
        Ok(ClassifiedCounts {
            classified: outcome.bindings.len(),
            skipped: outcome.skipped,
        })
    }
}

/// Which decision is being made, rather than a soup of optional flags the
/// caller has to combine correctly.
pub enum BindingAction {
    /// Accept the proposed type as a person's decision.
    Confirm,
    /// Bind this type — a person's choice, or an external detector's verdict.
    Set { type_key: String },
    /// This file is not a document; stop proposing types for it.
    Reject,
    /// Back to undecided, so the classifier may propose again.
    Reset,
}

pub struct BindingDecision {
    pub action: BindingAction,
    /// Who decided. Defaults to a person ([`DetectionSource::Manual`]).
    pub source: Option<DetectionSource>,
    /// Confidence, for a detector's verdict.
    pub confidence: Option<f32>,
    /// The file's current text, to re-check conformance in the same call.
    pub content: Option<String>,
}

/// Whether a re-classification must leave this binding's verdict alone, and
/// the state it keeps.
///
/// Two reasons, and they are different reasons:
///
/// - **a person ruled on it.** Re-guessing would overwrite a decision, which is
///   the one thing a background pass must never do.
/// - **Spec Quality answered it.** That verdict cost an LLM round-trip, and
///   offline scoring already had its turn on this file and did not settle it.
///   Discarding the expensive answer to re-run the cheap one that failed is
///   strictly worse than keeping it — the proposal still waits for a person.
fn keep_existing_verdict(prior: &document_binding::Model) -> Option<BindingState> {
    let state = BindingState::parse(&prior.state)?;
    if state.is_settled() {
        return Some(state);
    }
    let detected_by_llm = prior
        .source
        .as_deref()
        .and_then(DetectionSource::parse)
        .is_some_and(|s| matches!(s, DetectionSource::SpecQuality));
    detected_by_llm.then_some(state)
}

/// Stable digest of a document's content.
fn content_digest(content: &str) -> String {
    Uuid::new_v5(&CONTENT_NS, content.as_bytes())
        .simple()
        .to_string()
}

fn binding_scope(project_id: Option<Uuid>) -> DocScope {
    match project_id {
        Some(pid) => DocScope::Effective(pid),
        None => DocScope::WorkspaceLevel,
    }
}

/// Validate content against a bound type, or `None` when nothing is bound — an
/// undetermined document has no template to be judged against.
fn report_for(
    types: &[DocumentType],
    type_key: Option<&str>,
    content: &str,
) -> Option<ValidationReport> {
    let key = type_key?;
    let ty = types.iter().find(|t| t.key == key)?;
    Some(validate(content, &ty.template))
}

/// Candidates are advisory; a row written by an older build (or edited by hand)
/// should cost the listing nothing more than an empty list.
fn parse_candidates(raw: &str) -> Vec<TypeCandidate> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn binding_from_row(row: document_binding::Model) -> Result<DocumentBinding> {
    Ok(DocumentBinding {
        id: row.id,
        tenant_id: row.tenant_id,
        project_id: row.project_id,
        node_id: row.node_id,
        path: row.path,
        type_key: row.type_key,
        state: BindingState::parse(&row.state)
            .with_context(|| format!("unknown binding state: {}", row.state))?,
        confidence: row.confidence,
        source: row.source.as_deref().and_then(DetectionSource::parse),
        candidates: parse_candidates(&row.candidates),
        conforms: row.conforms,
        validation: serde_json::from_str(&row.validation).ok(),
        content_sha: row.content_sha,
        created_at: rfc3339(row.created_at),
        updated_at: rfc3339(row.updated_at),
    })
}

impl DocumentsService {
    /// Classify ingested files against the workspace's effective type
    /// catalogue and record the result as bindings.
    ///
    /// A binding a person has already ruled on is never re-guessed: its type
    /// stands, and the run only refreshes conformance against the current
    /// content. Everything else is re-classified, so improving a type's
    /// template improves detection on the next run.
    pub async fn classify_ingested(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        files: Vec<IngestedFile>,
    ) -> Result<ClassifyOutcome> {
        let types = self.list_types(ctx, workspace_id).await?;
        // Every binding in scope, not a page of them: the run has to know
        // whether each file was already ruled on, and a page would silently
        // re-guess the rest.
        let (rows, _) = self
            .repo
            .list_bindings(workspace_id, binding_scope(project_id), 0, None)
            .await?;
        let existing: BTreeMap<Uuid, document_binding::Model> =
            rows.into_iter().map(|row| (row.id, row)).collect();

        let now = OffsetDateTime::now_utc();
        let mut written: Vec<document_binding::Model> = Vec::new();
        let mut skipped = 0usize;

        for file in files {
            if !is_prose_path(&file.path) {
                skipped += 1;
                continue;
            }
            let id = binding_row_id(workspace_id, project_id, &file.node_id);
            let prior = existing.get(&id);
            let sha = content_digest(&file.content);

            // A binding that already has a better answer than this run can
            // produce keeps it; only its conformance is refreshed against what
            // the file says today.
            let keep = prior.and_then(keep_existing_verdict);

            let (type_key, state, confidence, source, candidates) = match keep {
                Some(state) => (
                    prior.and_then(|p| p.type_key.clone()),
                    state,
                    prior.and_then(|p| p.confidence),
                    prior.and_then(|p| p.source.as_deref().and_then(DetectionSource::parse)),
                    prior
                        .map(|p| parse_candidates(&p.candidates))
                        .unwrap_or_default(),
                ),
                None => {
                    let c = classify(&file.path, &file.content, &types);
                    let state = if c.type_key.is_some() {
                        BindingState::Detected
                    } else {
                        BindingState::Unknown
                    };
                    let confidence = c.type_key.as_ref().map(|_| c.confidence);
                    let source = c.type_key.as_ref().map(|_| c.source);
                    (c.type_key, state, confidence, source, c.candidates)
                }
            };

            let report = report_for(&types, type_key.as_deref(), &file.content);
            written.push(document_binding::Model {
                id,
                tenant_id: workspace_id,
                project_id,
                node_id: file.node_id,
                path: file.path,
                type_key,
                state: state.as_str().to_string(),
                confidence,
                source: source.map(|s| s.as_str().to_string()),
                candidates: serde_json::to_string(&candidates)?,
                conforms: report.as_ref().map(|r| r.conforms),
                validation: match &report {
                    Some(r) => serde_json::to_string(r)?,
                    None => "{}".to_string(),
                },
                content_sha: sha,
                created_at: prior.map(|p| p.created_at).unwrap_or(now),
                updated_at: now,
            });
        }

        self.repo.upsert_bindings(&written).await?;
        let bindings = written
            .into_iter()
            .map(binding_from_row)
            .collect::<Result<Vec<_>>>()?;
        Ok(ClassifyOutcome { bindings, skipped })
    }

    /// Effective bindings: workspace-level ones, plus the project's own when a
    /// project is named — the same inheritance documents use.
    pub async fn list_bindings(
        &self,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        page: PageQuery,
    ) -> Result<(Vec<DocumentBinding>, u32)> {
        let (rows, total) = self
            .repo
            .list_bindings(
                workspace_id,
                binding_scope(project_id),
                page.offset() as u64,
                Some(page.limit() as u64),
            )
            .await?;
        let bindings = rows
            .into_iter()
            .map(binding_from_row)
            .collect::<Result<Vec<_>>>()?;
        Ok((bindings, u32::try_from(total).unwrap_or(u32::MAX)))
    }

    /// Rule on a binding: accept the proposal, set a type outright, say the
    /// file is not a document, or put it back in the undecided queue.
    ///
    /// `content` is optional and only affects conformance: pass the file's
    /// current text to have the new type's template applied immediately, omit
    /// it to leave the last verdict (and its `content_sha`) alone.
    pub async fn decide_binding(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
        decision: BindingDecision,
    ) -> Result<DocumentBinding> {
        let mut row = self
            .repo
            .get_binding(workspace_id, id)
            .await?
            .context("no such document binding")?;
        let types = self.list_types(ctx, workspace_id).await?;

        match decision.action {
            BindingAction::Confirm => {
                if row.type_key.is_none() {
                    bail!("nothing to confirm: this binding has no proposed type");
                }
                row.state = BindingState::Confirmed.as_str().to_string();
            }
            BindingAction::Set { type_key } => {
                if !types.iter().any(|t| t.key == type_key) {
                    bail!("unknown document type: {type_key}");
                }
                // A person's choice is `manual` and final; the Spec Quality
                // detector is one more opinion, so it stays `detected` and
                // still waits for someone to accept it.
                let source = decision.source.unwrap_or(DetectionSource::Manual);
                row.state = match source {
                    DetectionSource::Manual => BindingState::Manual,
                    _ => BindingState::Detected,
                }
                .as_str()
                .to_string();
                row.confidence = match source {
                    DetectionSource::Manual => Some(1.0),
                    _ => decision.confidence,
                };
                row.source = Some(source.as_str().to_string());
                row.type_key = Some(type_key);
            }
            BindingAction::Reject => {
                row.state = BindingState::NotADocument.as_str().to_string();
                row.type_key = None;
                row.confidence = None;
                row.source = Some(DetectionSource::Manual.as_str().to_string());
                row.conforms = None;
                row.validation = "{}".to_string();
            }
            BindingAction::Reset => {
                row.state = BindingState::Unknown.as_str().to_string();
                row.type_key = None;
                row.confidence = None;
                row.source = None;
                row.conforms = None;
                row.validation = "{}".to_string();
            }
        }

        if let Some(content) = decision.content {
            let report = report_for(&types, row.type_key.as_deref(), &content);
            row.conforms = report.as_ref().map(|r| r.conforms);
            row.validation = match &report {
                Some(r) => serde_json::to_string(r)?,
                None => "{}".to_string(),
            };
            row.content_sha = content_digest(&content);
        }
        row.updated_at = OffsetDateTime::now_utc();
        self.repo.upsert_binding(row.clone()).await?;
        binding_from_row(row)
    }

    pub async fn delete_binding(&self, workspace_id: Uuid, id: Uuid) -> Result<bool> {
        self.repo.delete_binding(workspace_id, id).await
    }
}

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

fn normalize_key(key: &str) -> Result<String> {
    let key = key.trim().to_ascii_lowercase();
    if key.is_empty()
        || key.len() > 80
        || !key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    {
        bail!("type key must be lowercase letters, digits, underscores or hyphens");
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    //! The catalogue overlay, which is where ADR-0014 section 4 actually lives.
    //!
    //! No database and no account-management: `overlay` takes the chain and the
    //! rows, so every rule about which level wins can be stated as an example.

    use super::*;
    use crate::documents::model::{Rules, TemplateSpec};
    use crate::documents::repo::stage_row_id;

    const ORG: Uuid = Uuid::from_u128(0x1111_1111_1111_4111_8111_1111_1111_1111);
    const WS: Uuid = Uuid::from_u128(0x2222_2222_2222_4222_8222_2222_2222_2222);

    fn row(tenant: Uuid, key: &str, name: &str, hidden: bool) -> doc_type::Model {
        let now = OffsetDateTime::now_utc();
        doc_type::Model {
            id: type_row_id(tenant, key),
            tenant_id: tenant,
            key: key.to_string(),
            name: name.to_string(),
            description: String::new(),
            gts_type_id: TYPE_GTS_ID.to_string(),
            template: serde_json::to_string(&TemplateSpec {
                body: String::new(),
                sections: Vec::new(),
                rules: Rules::default(),
                questionnaire: Vec::new(),
            })
            .expect("template serialises"),
            hidden,
            created_at: now,
            updated_at: now,
        }
    }

    fn find<'a>(types: &'a [DocumentType], key: &str) -> Option<&'a DocumentType> {
        types.iter().find(|t| t.key == key)
    }

    /// The conversion `resolve_types` does, minus the database.
    fn resolve(
        chain: &[Uuid],
        rows: &[doc_type::Model],
        workspace_id: Option<Uuid>,
    ) -> Vec<DocumentType> {
        let entries = rows
            .iter()
            .map(|r| {
                (
                    r.tenant_id,
                    type_from_row(r.clone(), workspace_id).expect("row converts"),
                )
            })
            .collect();
        overlay(builtin_types(), chain, entries)
    }

    #[test]
    fn a_builtin_is_visible_with_no_rows_at_all() {
        let types = resolve(&[ORG, WS], &[], Some(WS));
        assert_eq!(
            find(&types, "prd").map(|t| t.owner.clone()),
            Some(Owner::Builtin)
        );
    }

    #[test]
    fn an_organization_entry_replaces_a_builtin_for_every_workspace_under_it() {
        let rows = [row(ORG, "prd", "House PRD", false)];
        let types = resolve(&[ORG, WS], &rows, Some(WS));
        let prd = find(&types, "prd").expect("prd survives");
        assert_eq!(prd.name, "House PRD");
        assert_eq!(prd.owner, Owner::Organization { tenant_id: ORG });
    }

    #[test]
    fn a_workspace_entry_wins_over_the_organization() {
        let rows = [
            row(ORG, "prd", "House PRD", false),
            row(WS, "prd", "This team's PRD", false),
        ];
        let types = resolve(&[ORG, WS], &rows, Some(WS));
        let prd = find(&types, "prd").expect("prd survives");
        assert_eq!(prd.name, "This team's PRD");
        assert_eq!(prd.owner, Owner::Workspace { tenant_id: WS });
    }

    #[test]
    fn the_workspace_still_wins_when_the_query_returns_it_first() {
        // The rows arrive from one `IN` query that says nothing about order.
        // The overlay sorts by the chain, so this is not luck.
        let rows = [
            row(WS, "prd", "This team's PRD", false),
            row(ORG, "prd", "House PRD", false),
        ];
        let types = resolve(&[ORG, WS], &rows, Some(WS));
        assert_eq!(
            find(&types, "prd").map(|t| t.name.as_str()),
            Some("This team's PRD")
        );
    }

    #[test]
    fn an_organization_tombstone_removes_a_builtin() {
        let rows = [row(ORG, "adr", "unused", true)];
        let types = resolve(&[ORG, WS], &rows, Some(WS));
        assert!(find(&types, "adr").is_none());
        // and only that one
        assert!(find(&types, "prd").is_some());
    }

    #[test]
    fn a_workspace_tombstone_removes_what_the_organization_published() {
        let rows = [
            row(ORG, "house_brief", "House brief", false),
            row(WS, "house_brief", "unused", true),
        ];
        let types = resolve(&[ORG, WS], &rows, Some(WS));
        assert!(find(&types, "house_brief").is_none());
    }

    #[test]
    fn a_workspace_can_bring_back_what_the_organization_hid() {
        // Hiding is an override, so it is reversible from below: the workspace
        // overrides the tombstone the way it would override anything else.
        let rows = [
            row(ORG, "adr", "unused", true),
            row(WS, "adr", "We do use ADRs", false),
        ];
        let types = resolve(&[ORG, WS], &rows, Some(WS));
        let adr = find(&types, "adr").expect("adr is back");
        assert_eq!(adr.name, "We do use ADRs");
        assert_eq!(adr.owner, Owner::Workspace { tenant_id: WS });
    }

    #[test]
    fn a_workspace_with_no_organization_sees_only_its_own_level() {
        // A workspace directly under the platform root has a one-link chain.
        let rows = [
            row(ORG, "prd", "House PRD", false),
            row(WS, "prd", "This team's PRD", false),
        ];
        let types = resolve(&[WS], &rows, Some(WS));
        assert_eq!(
            find(&types, "prd").map(|t| t.name.as_str()),
            Some("This team's PRD")
        );
    }

    #[test]
    fn the_organizations_own_view_labels_every_row_as_its_own() {
        // `workspace_id = None` is the editing view: nothing here belongs to a
        // workspace, so a row must not be labelled as one.
        let rows = [row(ORG, "prd", "House PRD", false)];
        let types = resolve(&[ORG], &rows, None);
        assert_eq!(
            find(&types, "prd").map(|t| t.owner.clone()),
            Some(Owner::Organization { tenant_id: ORG })
        );
    }
    // -- stages --------------------------------------------------------------

    fn stage_row(tenant: Uuid, key: &str, label: &str, ordinal: i32, hidden: bool) -> stage::Model {
        let now = OffsetDateTime::now_utc();
        stage::Model {
            id: stage_row_id(tenant, key),
            tenant_id: tenant,
            key: key.to_string(),
            label: label.to_string(),
            required: false,
            ordinal,
            requires: "[]".to_string(),
            gates: "[]".to_string(),
            hidden,
            created_at: now,
            updated_at: now,
        }
    }

    /// The conversion and the sort `resolve_stages` does, minus the database.
    fn resolve_stages_of(
        chain: &[Uuid],
        rows: &[stage::Model],
        workspace_id: Option<Uuid>,
    ) -> Vec<Stage> {
        let entries = rows
            .iter()
            .map(|r| {
                (
                    r.tenant_id,
                    stage_from_row(r.clone(), workspace_id).expect("row converts"),
                )
            })
            .collect();
        let mut stages = overlay(builtin_stages(), chain, entries);
        stages.sort_by(|a, b| (a.position, &a.key).cmp(&(b.position, &b.key)));
        stages
    }

    fn keys(stages: &[Stage]) -> Vec<&str> {
        stages.iter().map(|s| s.key.as_str()).collect()
    }

    #[test]
    fn the_platform_journey_comes_back_in_order_not_alphabetically() {
        // `overlay` returns key order; stages are a sequence, so the sort is
        // what makes this list mean anything. Alphabetically `architecture`
        // would come first and `intent` fifth.
        let stages = resolve_stages_of(&[ORG, WS], &[], Some(WS));
        assert_eq!(
            keys(&stages),
            vec![
                "intent",
                "brd",
                "prd",
                "prd_spec",
                "architecture",
                "ui_design",
                "user_stories",
                "testing"
            ]
        );
    }

    #[test]
    fn intent_is_the_one_required_stage_the_platform_ships() {
        let stages = resolve_stages_of(&[WS], &[], Some(WS));
        let required: Vec<&str> = stages
            .iter()
            .filter(|s| s.required)
            .map(|s| s.key.as_str())
            .collect();
        assert_eq!(required, vec!["intent"]);
    }

    #[test]
    fn an_organization_can_insert_a_stage_between_two_built_ins() {
        // Built-in positions are spaced by ten precisely so this needs no
        // renumbering of anything the organization does not own.
        let rows = [stage_row(ORG, "discovery", "Discovery", 15, false)];
        let stages = resolve_stages_of(&[ORG, WS], &rows, Some(WS));
        let seen = keys(&stages);
        let at = seen
            .iter()
            .position(|k| *k == "discovery")
            .expect("inserted");
        assert_eq!(seen[at - 1], "intent", "after intent (position 10)");
        assert_eq!(seen[at + 1], "brd", "before brd (position 20)");
    }

    #[test]
    fn a_workspace_tombstone_drops_a_stage_the_platform_ships() {
        let rows = [stage_row(WS, "testing", "unused", 0, true)];
        let stages = resolve_stages_of(&[ORG, WS], &rows, Some(WS));
        assert!(!keys(&stages).contains(&"testing"));
        assert!(keys(&stages).contains(&"intent"));
    }

    #[test]
    fn a_workspace_relabelling_a_stage_keeps_its_place() {
        // Overriding replaces the whole entry, so a caller that forgets the
        // position moves the stage. This one keeps it, and the test says so.
        let rows = [stage_row(WS, "prd", "Product Requirements", 30, false)];
        let stages = resolve_stages_of(&[ORG, WS], &rows, Some(WS));
        let prd = stages.iter().find(|s| s.key == "prd").expect("prd");
        assert_eq!(prd.label, "Product Requirements");
        assert_eq!(keys(&stages)[2], "prd", "still third");
        assert_eq!(prd.owner, Owner::Workspace { tenant_id: WS });
    }

    #[test]
    fn a_stage_carries_the_document_types_it_requires() {
        let mut row = stage_row(ORG, "prd", "PRD", 30, false);
        row.requires = "[\"prd\",\"upstream_reqs\"]".to_string();
        let stages = resolve_stages_of(&[ORG, WS], &[row], Some(WS));
        let prd = stages.iter().find(|s| s.key == "prd").expect("prd");
        assert_eq!(prd.requires, vec!["prd", "upstream_reqs"]);
    }
    // -- capabilities --------------------------------------------------------

    fn cap_row(tenant: Uuid, key: &str, label: &str, hidden: bool) -> capability::Model {
        let now = OffsetDateTime::now_utc();
        capability::Model {
            id: capability_row_id(tenant, key),
            tenant_id: tenant,
            key: key.to_string(),
            label: label.to_string(),
            terms: "[\"custom\"]".to_string(),
            hidden,
            created_at: now,
            updated_at: now,
        }
    }

    fn resolve_caps(
        chain: &[Uuid],
        rows: &[capability::Model],
        workspace_id: Option<Uuid>,
    ) -> Vec<Capability> {
        let entries = rows
            .iter()
            .map(|r| {
                (
                    r.tenant_id,
                    capability_from_row(r.clone(), workspace_id).expect("row converts"),
                )
            })
            .collect();
        overlay(builtin_capabilities(), chain, entries)
    }

    #[test]
    fn every_capability_a_builtin_questionnaire_seeds_is_in_the_catalogue() {
        // The bug this catches, and it was real: the App Spec's first question
        // seeds `domain`, which the prototype's CAP_KEYWORDS table never had, so
        // every App Spec produced a tag the matcher could only score against its
        // own name. A questionnaire and a vocabulary that disagree are worse
        // than either being empty.
        let known: std::collections::BTreeSet<String> =
            builtin_capabilities().into_iter().map(|c| c.key).collect();
        let mut missing: Vec<String> = Vec::new();
        let mut checked = 0usize;
        for ty in builtin_types() {
            for q in &ty.template.questionnaire {
                if let Some(cap) = &q.capability {
                    checked += 1;
                    if !known.contains(cap) {
                        missing.push(format!("{}:{} seeds `{cap}`", ty.key, q.id));
                    }
                }
            }
        }
        assert!(
            checked > 0,
            "no built-in question seeds a capability -- this test would pass vacuously"
        );
        assert!(
            missing.is_empty(),
            "capabilities with no catalogue entry: {missing:?}"
        );
    }

    #[test]
    fn a_capability_carries_the_terms_that_find_a_component() {
        let caps = resolve_caps(&[WS], &[], Some(WS));
        let auth = caps.iter().find(|c| c.key == "auth").expect("auth");
        assert!(auth.terms.contains(&"keycloak".to_string()));
        assert_eq!(auth.owner, Owner::Builtin);
    }

    #[test]
    fn a_workspace_can_retune_a_capabilitys_terms() {
        let rows = [cap_row(WS, "auth", "Sign-in", false)];
        let caps = resolve_caps(&[ORG, WS], &rows, Some(WS));
        let auth = caps.iter().find(|c| c.key == "auth").expect("auth");
        assert_eq!(auth.label, "Sign-in");
        assert_eq!(auth.terms, vec!["custom"]);
        assert_eq!(auth.owner, Owner::Workspace { tenant_id: WS });
    }

    #[test]
    fn an_organization_tombstone_drops_a_capability_from_the_vocabulary() {
        let rows = [cap_row(ORG, "billing", "unused", true)];
        let caps = resolve_caps(&[ORG, WS], &rows, Some(WS));
        assert!(!caps.iter().any(|c| c.key == "billing"));
        assert!(caps.iter().any(|c| c.key == "auth"));
    }
    // -- the stage gate ------------------------------------------------------

    const DOC: Uuid = Uuid::from_u128(0x3333_3333_3333_4333_8333_3333_3333_3333);
    const BINDING: Uuid = Uuid::from_u128(0x4444_4444_4444_4444_8444_4444_4444_4444);

    fn stage_with(requires: &[&str], gates: &[&str]) -> Stage {
        Stage {
            key: "prd".to_string(),
            label: "PRD".to_string(),
            required: false,
            position: 30,
            requires: requires.iter().map(|k| (*k).to_string()).collect(),
            gates: gates.iter().map(|k| (*k).to_string()).collect(),
            owner: Owner::Builtin,
            hidden: false,
        }
    }

    fn doc(type_key: &str, conforms: bool) -> Document {
        Document {
            id: DOC,
            tenant_id: WS,
            project_id: None,
            type_key: type_key.to_string(),
            title: "A PRD".to_string(),
            content: String::new(),
            status: DocStatus::Draft,
            conforms,
            capabilities: Vec::new(),
            created_by: "someone".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// A verdict recorded against the bound repository file, not against a
    /// document Studio holds.
    fn binding_verdict(detector: &str, state: &str) -> analysis::Model {
        let mut row = verdict(detector, state);
        row.id = analysis_row_id(BINDING, detector);
        row.document_id = None;
        row.binding_id = Some(BINDING);
        row
    }

    fn verdict(detector: &str, state: &str) -> analysis::Model {
        let now = OffsetDateTime::now_utc();
        analysis::Model {
            id: analysis_row_id(DOC, detector),
            tenant_id: WS,
            document_id: Some(DOC),
            binding_id: None,
            detector: detector.to_string(),
            state: state.to_string(),
            task_id: None,
            summary: String::new(),
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn a_stage_that_requires_nothing_is_complete() {
        let status = evaluate_stage(stage_with(&[], &[]), &[], &[], &[], &[]);
        assert!(status.complete);
        assert!(status.requirements.is_empty());
    }

    #[test]
    fn a_missing_document_is_reported_once_not_as_four_failing_detectors() {
        // `present: false` is the fact that matters; listing every gate as
        // outstanding on top of it would bury it.
        let status = evaluate_stage(stage_with(&["prd"], &["bloat", "leak"]), &[], &[], &[], &[]);
        assert!(!status.complete);
        let req = &status.requirements[0];
        assert!(!req.present);
        assert!(req.analyses_outstanding.is_empty());
    }

    #[test]
    fn a_document_that_does_not_conform_does_not_complete_its_stage() {
        let status = evaluate_stage(
            stage_with(&["prd"], &[]),
            &[doc("prd", false)],
            &[],
            &[],
            &[],
        );
        assert!(!status.complete);
        assert!(status.requirements[0].present);
        assert!(!status.requirements[0].conforms);
    }

    #[test]
    fn structure_alone_completes_a_stage_that_gates_nothing() {
        let status = evaluate_stage(
            stage_with(&["prd"], &[]),
            &[doc("prd", true)],
            &[],
            &[],
            &[],
        );
        assert!(status.complete);
    }

    #[test]
    fn a_gate_with_no_verdict_stays_shut() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[doc("prd", true)],
            &[],
            &[],
            &[],
        );
        assert!(!status.complete);
        assert_eq!(status.requirements[0].analyses_outstanding, vec!["bloat"]);
    }

    #[test]
    fn a_failed_or_pending_verdict_keeps_the_gate_shut() {
        for state in ["failed", "pending"] {
            let status = evaluate_stage(
                stage_with(&["prd"], &["bloat"]),
                &[doc("prd", true)],
                &[],
                &[verdict("bloat", state)],
                &[],
            );
            assert!(!status.complete, "{state} should not open the gate");
        }
    }

    #[test]
    fn a_state_this_build_does_not_recognise_keeps_the_gate_shut() {
        // Written by something newer. Opening on a value we cannot interpret
        // would be the one failure mode a gate must not have.
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[doc("prd", true)],
            &[],
            &[verdict("bloat", "inconclusive")],
            &[],
        );
        assert!(!status.complete);
    }

    #[test]
    fn a_passed_verdict_opens_the_gate() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[doc("prd", true)],
            &[],
            &[verdict("bloat", "passed")],
            &[],
        );
        assert!(status.complete, "{:?}", status.requirements);
    }

    #[test]
    fn a_verdict_for_another_detector_does_not_open_this_gate() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[doc("prd", true)],
            &[],
            &[verdict("leak", "passed")],
            &[],
        );
        assert!(!status.complete);
        assert_eq!(status.requirements[0].analyses_outstanding, vec!["bloat"]);
    }

    fn bound(type_key: &str, state: BindingState, conforms: Option<bool>) -> DocumentBinding {
        DocumentBinding {
            id: BINDING,
            tenant_id: WS,
            project_id: None,
            node_id: "node".to_string(),
            path: "docs/prd.md".to_string(),
            type_key: Some(type_key.to_string()),
            state,
            confidence: Some(0.8),
            source: Some(DetectionSource::Heuristic),
            candidates: Vec::new(),
            conforms,
            validation: None,
            content_sha: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// A project whose PRD has always lived in its repository has a PRD.
    #[test]
    fn a_confirmed_binding_satisfies_a_required_type() {
        let status = evaluate_stage(
            stage_with(&["prd"], &[]),
            &[],
            &[bound("prd", BindingState::Confirmed, Some(true))],
            &[],
            &[],
        );
        assert!(status.requirements[0].present);
        assert!(status.requirements[0].conforms);
        assert!(status.complete);
    }

    #[test]
    fn a_binding_a_person_chose_counts_the_same_as_one_they_accepted() {
        let status = evaluate_stage(
            stage_with(&["prd"], &[]),
            &[],
            &[bound("prd", BindingState::Manual, Some(true))],
            &[],
            &[],
        );
        assert!(status.complete);
    }

    /// The classifier's own proposal is not a claim the project can make.
    #[test]
    fn an_unreviewed_proposal_does_not_open_a_stage() {
        for state in [
            BindingState::Detected,
            BindingState::Unknown,
            BindingState::NotADocument,
        ] {
            let status = evaluate_stage(
                stage_with(&["prd"], &[]),
                &[],
                &[bound("prd", state, Some(true))],
                &[],
                &[],
            );
            assert!(
                !status.requirements[0].present,
                "{state:?} must not satisfy a requirement"
            );
        }
    }

    #[test]
    fn a_bound_file_that_fails_its_checklist_does_not_complete_the_stage() {
        let status = evaluate_stage(
            stage_with(&["prd"], &[]),
            &[],
            &[bound("prd", BindingState::Confirmed, Some(false))],
            &[],
            &[],
        );
        assert!(status.requirements[0].present);
        assert!(!status.requirements[0].conforms);
        assert!(!status.complete);
    }

    /// A repository file carries no detector verdicts yet, so a gated stage
    /// stays shut on one — but it says which gates, rather than pretending the
    /// document is missing.
    #[test]
    fn a_gated_stage_stays_shut_on_a_document_that_has_no_verdicts_to_show() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat", "leak"]),
            &[],
            &[bound("prd", BindingState::Confirmed, Some(true))],
            &[],
            &[],
        );
        assert!(status.requirements[0].present);
        assert_eq!(
            status.requirements[0].analyses_outstanding,
            ["bloat", "leak"]
        );
        assert!(!status.complete);
    }

    /// A document in Studio still answers for itself: a binding of the same
    /// type must not smuggle a gate open on its behalf.
    #[test]
    fn a_studio_document_keeps_its_own_verdicts() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[doc("prd", true)],
            &[bound("prd", BindingState::Confirmed, Some(true))],
            &[verdict("bloat", "passed")],
            &[],
        );
        assert!(status.complete);
    }

    /// The point of the whole exercise: a repository file can now clear a gated
    /// stage, on the same terms a document in Studio does.
    #[test]
    fn a_passing_verdict_on_a_bound_file_opens_the_gate() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[],
            &[bound("prd", BindingState::Confirmed, Some(true))],
            &[],
            &[binding_verdict("bloat", "passed")],
        );
        assert!(status.requirements[0].analyses_outstanding.is_empty());
        assert!(status.complete);
    }

    /// And only `passed` does. Pending and failed keep it shut, as they do for
    /// a document — a gate that opens on a value we cannot interpret is worse
    /// than one that stays closed.
    #[test]
    fn only_a_passing_verdict_on_a_bound_file_opens_the_gate() {
        for state in ["pending", "failed", "something-new"] {
            let status = evaluate_stage(
                stage_with(&["prd"], &["bloat"]),
                &[],
                &[bound("prd", BindingState::Confirmed, Some(true))],
                &[],
                &[binding_verdict("bloat", state)],
            );
            assert_eq!(
                status.requirements[0].analyses_outstanding,
                ["bloat"],
                "{state} must not open the gate"
            );
        }
    }

    /// Verdicts do not cross between the two kinds of subject. A document's
    /// passing verdict says nothing about a repository file of the same type.
    #[test]
    fn a_documents_verdict_does_not_open_a_bound_files_gate() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[],
            &[bound("prd", BindingState::Confirmed, Some(true))],
            &[verdict("bloat", "passed")],
            &[],
        );
        assert_eq!(status.requirements[0].analyses_outstanding, ["bloat"]);
    }

    #[test]
    fn a_bound_files_verdict_does_not_open_a_documents_gate() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat"]),
            &[doc("prd", true)],
            &[],
            &[],
            &[binding_verdict("bloat", "passed")],
        );
        assert_eq!(status.requirements[0].analyses_outstanding, ["bloat"]);
    }

    /// A gate the detector has not been run for at all is still outstanding,
    /// and still names itself rather than reading as a missing document.
    #[test]
    fn a_gate_with_no_verdict_at_all_stays_outstanding() {
        let status = evaluate_stage(
            stage_with(&["prd"], &["bloat", "leak"]),
            &[],
            &[bound("prd", BindingState::Confirmed, Some(true))],
            &[],
            &[binding_verdict("bloat", "passed")],
        );
        assert!(status.requirements[0].present);
        assert_eq!(status.requirements[0].analyses_outstanding, ["leak"]);
        assert!(!status.complete);
    }
}

#[cfg(test)]
mod reclassification_tests {
    //! Which verdicts a re-classification is allowed to overwrite.
    //!
    //! Pure: the rule is a function of one row, and getting it wrong either
    //! discards a person's decision or throws away an answer we paid an LLM for.
    #![allow(clippy::expect_used)]

    use time::OffsetDateTime;

    use super::*;

    fn row(state: &str, source: Option<&str>) -> document_binding::Model {
        let now = OffsetDateTime::now_utc();
        document_binding::Model {
            id: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            project_id: None,
            node_id: "node".into(),
            path: "docs/thing.md".into(),
            type_key: Some("prd".into()),
            state: state.into(),
            confidence: Some(0.6),
            source: source.map(str::to_string),
            candidates: "[]".into(),
            conforms: Some(false),
            validation: "{}".into(),
            content_sha: "sha".into(),
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn a_persons_ruling_is_never_re_guessed() {
        for state in ["confirmed", "manual", "not_a_document"] {
            assert!(
                keep_existing_verdict(&row(state, Some("manual"))).is_some(),
                "{state} must survive a re-scan"
            );
        }
    }

    /// Offline scoring already had its turn on this file and did not settle it.
    /// Re-running it to discard the answer that did would be strictly worse.
    #[test]
    fn a_detectors_verdict_outlives_the_scoring_that_could_not_place_the_file() {
        assert!(keep_existing_verdict(&row("detected", Some("spec_quality"))).is_some());
    }

    /// Our own earlier guess is exactly what a re-scan is for: improving a
    /// type's template has to be able to change it.
    #[test]
    fn our_own_guess_is_replaced() {
        assert!(keep_existing_verdict(&row("detected", Some("heuristic"))).is_none());
        assert!(keep_existing_verdict(&row("detected", Some("front_matter"))).is_none());
        assert!(keep_existing_verdict(&row("unknown", None)).is_none());
    }
}
