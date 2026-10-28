//! Where this gear's own records are kept — chosen by configuration
//! (`gears.studio-documents.config.storage.documents`, ADR-0051 §8a).
//!
//! Documents, repository-file bindings, detector verdicts, what the spec
//! model read and what members decided about it, application parts and
//! delivery scopes. Under `model` (the default) every row is a domain object
//! ([`super::model_table`]): the domain query reads them, the model admin can
//! extend their types, and the graph relates them to the rest. `tables` keeps
//! the rows in this gear's database, for a deployment without the model.
//!
//! [`DocumentsData`] answers with the repository's calls and shapes, so the
//! service does not know which strategy ran. The stage catalogue and reviews
//! have stores of their own ([`super::process_store`], [`super::review_store`]).

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::entity::{
    analysis, application_part, delivery_history, delivery_limit, delivery_scope, doc_type,
    document, document_binding, spec_decision, spec_extraction, spec_judgement, spec_review,
    spec_term,
};
use super::model_table::{ModelTable, TableRow, TableStorage, need};
use super::repo::{DocScope, DocumentsRepo, spec_review_id};
use crate::domain_model::port::{DomainObjects, TypeNeed};

macro_rules! row {
    ($m:ident, $entity:literal, $name:literal, $desc:literal, $project:expr, [$(($f:literal, $t:literal)),* $(,)?]) => {
        impl TableRow for $m::Model {
            const ENTITY: &'static str = $entity;
            const GEAR: &'static str = "studio-documents";
            fn row_id(&self) -> Uuid {
                self.id
            }
            fn owner(&self) -> Uuid {
                self.tenant_id
            }
            fn project(&self) -> Option<Uuid> {
                let project: fn(&Self) -> Option<Uuid> = $project;
                project(self)
            }
            fn need() -> TypeNeed {
                need("studio-documents", $entity, $name, $desc, &[("tenant_id", "string"), $(($f, $t)),*])
            }
        }
    };
}

row!(
    doc_type,
    "document-type",
    "Document Type",
    "A document type an organization or a workspace defines, overrides or hides.",
    |_| None,
    [
        ("key", "string"),
        ("name", "string"),
        ("description", "string"),
        ("gts_type_id", "string"),
        ("template", "string"),
        ("hidden", "boolean"),
        ("created_at", "timestamp"),
        ("updated_at", "timestamp"),
    ]
);
row!(
    analysis,
    "document-analysis",
    "Document Analysis",
    "One detector's verdict on one document or repository file.",
    |_| None,
    [
        ("document_id", "string?"),
        ("binding_id", "string?"),
        ("detector", "string"),
        ("state", "pending | passed | failed"),
        ("task_id", "string?"),
        ("summary", "string"),
        ("created_at", "timestamp"),
        ("updated_at", "timestamp"),
    ]
);
row!(
    spec_extraction,
    "spec-extraction",
    "Spec Extraction",
    "What a model read out of one revision of one document.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("path", "string"),
        ("revision", "string"),
        ("extractor_version", "string"),
        ("facts", "JSON"),
        ("dropped", "integer"),
        ("error", "string?"),
        ("provider", "string"),
        ("model", "string"),
        ("created_at", "timestamp"),
    ]
);
row!(
    spec_judgement,
    "spec-judgement",
    "Spec Judgement",
    "What the judge said about one candidate contradiction at its sides' revisions.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("fingerprint", "string"),
        ("revisions", "string"),
        ("judge_version", "string"),
        ("conflict", "boolean"),
        ("finding", "JSON?"),
        ("created_at", "timestamp"),
    ]
);
row!(
    spec_decision,
    "finding-decision",
    "Finding Decision",
    "A member's confirm or dismiss on a spec-model finding.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("fingerprint", "string"),
        ("decision", "confirmed | dismissed"),
        ("decided_by", "string"),
        ("decided_at", "timestamp"),
        ("note", "string?"),
        ("snapshot", "JSON?"),
    ]
);
row!(
    spec_review,
    "fact-review",
    "Fact Review",
    "A member's accept or reject on one fact the model read.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("fact_key", "string"),
        ("state", "accepted | rejected"),
        ("path", "string"),
        ("revision", "string"),
        ("note", "string?"),
        ("decided_by", "string"),
        ("decided_at", "timestamp"),
    ]
);
row!(
    spec_term,
    "glossary-decision",
    "Glossary Decision",
    "A member's decision on one entry of a project's glossary.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("term_key", "string"),
        ("name", "string?"),
        ("alias_of", "string?"),
        ("distinct_from", "JSON"),
        ("decided_by", "string"),
        ("decided_at", "timestamp"),
    ]
);
row!(
    document,
    "studio-document",
    "Studio Document",
    "A document written in Studio: workspace-wide, or one project's.",
    |r| r.project_id,
    [
        ("project_id", "string?"),
        ("type_key", "string"),
        ("title", "string"),
        ("content", "TextContent"),
        ("status", "integer"),
        ("conforms", "boolean"),
        ("validation", "JSON"),
        ("capabilities", "JSON"),
        ("requirements", "JSON"),
        ("inferred_capabilities", "JSON"),
        ("created_by", "string"),
        ("created_at", "timestamp"),
        ("updated_at", "timestamp"),
    ]
);
row!(
    document_binding,
    "document-binding",
    "Document Binding",
    "A repository file and the document type Studio decided it is.",
    |r| r.project_id,
    [
        ("project_id", "string?"),
        ("node_id", "string"),
        ("path", "string"),
        ("type_key", "string?"),
        (
            "state",
            "detected | confirmed | manual | unknown | not_a_document"
        ),
        ("confidence", "number?"),
        ("source", "string?"),
        ("candidates", "JSON"),
        ("conforms", "boolean?"),
        ("validation", "JSON"),
        ("capabilities", "JSON"),
        ("requirements", "JSON"),
        ("inferred_capabilities", "JSON"),
        ("content_sha", "string"),
        ("created_at", "timestamp"),
        ("updated_at", "timestamp"),
    ]
);
row!(
    application_part,
    "application-part",
    "Application Part",
    "What a person records about one part of the application: owner, description, boundary.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("repo", "string"),
        ("kind", "string"),
        ("reference", "string"),
        ("owner", "string?"),
        ("owner_name", "string?"),
        ("description_path", "string?"),
        ("boundary", "string?"),
        ("related", "JSON"),
        ("updated_by", "string"),
        ("updated_at", "timestamp"),
    ]
);
row!(
    delivery_scope,
    "delivery-scope",
    "Delivery Scope",
    "A slice of a project to deliver: outcome, requirements, gears, acceptance.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("title", "string"),
        ("outcome", "string"),
        ("owner", "string?"),
        ("owner_name", "string?"),
        ("target_date", "string?"),
        ("requirements", "JSON"),
        ("gears", "JSON"),
        ("acceptance", "string"),
        ("state", "string"),
        ("created_by", "string"),
        ("created_at", "timestamp"),
        ("updated_by", "string"),
        ("updated_at", "timestamp"),
    ]
);
row!(
    delivery_limit,
    "delivery-limit",
    "Delivery Limit",
    "A limit on a delivery scope: a dependency, a risk, an open question.",
    |r| Some(r.project_id),
    [
        ("project_id", "string"),
        ("scope_id", "string"),
        ("kind", "string"),
        ("text", "string"),
        ("blocking", "boolean"),
        ("depends_on", "string?"),
        ("resolution", "string?"),
        ("resolved_by", "string?"),
        ("resolved_at", "timestamp?"),
        ("created_by", "string"),
        ("created_at", "timestamp"),
    ]
);
row!(
    delivery_history,
    "delivery-scope-version",
    "Delivery Scope Version",
    "The version of a delivery scope a change replaced.",
    |_| None,
    [
        ("scope_id", "string"),
        ("snapshot", "JSON"),
        ("changed_by", "string"),
        ("changed_at", "timestamp"),
    ]
);

fn ids(values: &[Uuid]) -> Value {
    Value::Array(values.iter().map(|v| json!(v)).collect())
}

/// `where` for a document-scoped list in one workspace.
fn in_scope(workspace_id: Uuid, scope: &DocScope) -> Value {
    match scope {
        DocScope::WorkspaceLevel => {
            json!({"tenant_id": {"_eq": workspace_id}, "project_id": {"_is_null": true}})
        }
        DocScope::Effective(project_id) => json!({
            "tenant_id": {"_eq": workspace_id},
            "_or": [{"project_id": {"_is_null": true}}, {"project_id": {"_eq": project_id}}],
        }),
        DocScope::Everything => json!({"tenant_id": {"_eq": workspace_id}}),
    }
}

pub struct DocumentsData {
    repo: Arc<DocumentsRepo>,
    table: ModelTable,
    /// Owners whose rows the model holds, in this process.
    moved: std::sync::Mutex<HashSet<Uuid>>,
}

/// The model's port, ready for one owner's rows; `None` reads and writes the
/// tables. The row type and its loader name the table the call is about.
macro_rules! at {
    ($self:ident, $ctx:expr, $row:ty, $owner:expr, $load:ident) => {{ $self.owner($ctx, $owner).await? }};
}
// Each call site binds the port and the caller acting in the owner's
// organization: `Some((port, ref ctx))`, shadowing the request's context.

/// Every table one owner's rows go back to, in one go.
macro_rules! move_back {
    ($self:ident, $ctx:expr, $port:expr, $owner:expr, [$($m:ident => $restore:ident),* $(,)?]) => {{
        let mut n = 0usize;
        $(
            let rows: Vec<$m::Model> = $self
                .table
                .list($ctx, $port, json!({"tenant_id": {"_eq": $owner}}), None)
                .await?;
            let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
            n += $self.repo.$restore($owner, rows).await?;
            $self.table.remove::<$m::Model>($ctx, $port, &ids).await?;
        )*
        anyhow::Ok(n)
    }};
}

/// Every table one owner's rows are moved from, in one go.
macro_rules! move_all {
    ($self:ident, $ctx:expr, $port:expr, $owner:expr, [$($m:ident => $load:ident),* $(,)?]) => {{
        let mut n = 0usize;
        $(
            $self.table.ensure::<$m::Model>($ctx, $port).await?;
            let rows = $self.repo.$load($owner).await?;
            n += rows.len();
            $self.table.write::<$m::Model>($ctx, $port, &rows).await?;
        )*
        anyhow::Ok(n)
    }};
}

impl DocumentsData {
    pub fn new(
        repo: Arc<DocumentsRepo>,
        storage: TableStorage,
        hub: Option<Arc<toolkit::client_hub::ClientHub>>,
    ) -> Self {
        Self {
            repo,
            table: ModelTable::new(storage, hub),
            moved: std::sync::Mutex::default(),
        }
    }

    /// The tables strategy, with the model still reachable to move back from.
    #[cfg(test)]
    pub fn back_to_tables_with(repo: Arc<DocumentsRepo>, port: Arc<dyn DomainObjects>) -> Self {
        Self {
            repo,
            table: ModelTable::with_port_storing(port, TableStorage::Tables),
            moved: std::sync::Mutex::default(),
        }
    }

    #[cfg(test)]
    pub fn with_port(repo: Arc<DocumentsRepo>, port: Arc<dyn DomainObjects>) -> Self {
        Self {
            repo,
            table: ModelTable::with_port(port),
            moved: std::sync::Mutex::default(),
        }
    }

    /// The model, holding everything `owner` (a workspace, or an
    /// organization for its document types) had in the tables.
    ///
    /// An owner moves whole, the first time any of its rows is touched: every
    /// table at once, then a marker, then its rows are dropped from the
    /// tables, so nothing is kept twice. Whole, because the tables cascade —
    /// a document's verdicts go with it — and moving one table at a time
    /// would let a cascade remove rows not yet moved. A caller who may not
    /// write the model reads the tables until somebody who may moves them.
    async fn owner(
        &self,
        ctx: &SecurityContext,
        owner: Uuid,
    ) -> Result<Option<(Arc<dyn DomainObjects>, SecurityContext)>> {
        // The owner's records live in its organization's model, whatever
        // tenant the caller's token names (a platform administrator, a member
        // of two organizations).
        let org_ctx = self.table.in_org_of(ctx, owner).await;
        let ctx = &org_ctx;
        if !self.table.in_model() {
            self.back_to_tables(ctx, owner).await;
            return Ok(None);
        }
        let Some(port) = self.table.port() else {
            return Ok(None);
        };
        if self
            .moved
            .lock()
            .map(|m| m.contains(&owner))
            .unwrap_or(false)
        {
            return Ok(Some((port, org_ctx)));
        }
        let marker = format!("documents-moved-v2:{owner}");
        if !Self::marked_done(ctx, port.as_ref(), &marker).await? {
            let p = port.as_ref();
            let moved = async {
                let n = move_all!(self, ctx, p, owner, [
                    doc_type => all_types,
                    analysis => all_analyses,
                    spec_extraction => all_extractions,
                    spec_judgement => all_judgements,
                    spec_decision => all_spec_decisions,
                    spec_review => all_spec_reviews,
                    spec_term => all_spec_terms,
                    document => all_docs,
                    document_binding => all_bindings,
                    application_part => all_parts,
                    delivery_scope => all_scopes,
                    delivery_limit => all_limits,
                    delivery_history => all_scope_history,
                ])?;
                p.put_objects(
                    ctx,
                    "sync-state",
                    vec![crate::domain_model::port::OwnedObject {
                        id: marker.clone(),
                        scope: owner.to_string(),
                        payload: json!({"status": "done", "message": "documents moved into the domain model"}),
                    }],
                )
                .await?;
                anyhow::Ok(n)
            }
            .await;
            match moved {
                Ok(n) => match self.repo.purge_documents(owner).await {
                    Ok(gone) => {
                        tracing::info!(owner = %owner, moved = n, removed = gone, "studio-documents: rows moved into the domain model and dropped from the tables")
                    }
                    Err(e) => {
                        tracing::warn!(owner = %owner, error = %e, "studio-documents: moved, but the tables' copies could not be dropped")
                    }
                },
                Err(e) => {
                    tracing::warn!(owner = %owner, error = %e, "studio-documents: the move did not run for this caller — reading the tables");
                    return Ok(None);
                }
            }
        }
        if let Ok(mut m) = self.moved.lock() {
            m.insert(owner);
        }
        Ok(Some((port, org_ctx)))
    }

    /// Whether the owner's move marker says the model holds its rows.
    async fn marked_done(
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        marker: &str,
    ) -> Result<bool> {
        let (found, _) = port
            .query(
                ctx,
                json!({"type": "sync-state", "where": {"id": {"_eq": marker}}, "limit": 1}),
            )
            .await?;
        Ok(found
            .first()
            .is_some_and(|o| o.payload.get("status").and_then(Value::as_str) == Some("done")))
    }

    /// Storage switched back to `tables`: an owner the model holds moves back,
    /// whole, and leaves the model — so switching is never one-way and
    /// nothing is kept twice. Best effort: a caller who cannot read the model
    /// leaves it for one who can, and the tables answer meanwhile.
    async fn back_to_tables(&self, ctx: &SecurityContext, owner: Uuid) {
        if self
            .moved
            .lock()
            .map(|m| m.contains(&owner))
            .unwrap_or(true)
        {
            return;
        }
        let Some(port) = self.table.any_port() else {
            return;
        };
        let marker = format!("documents-moved-v2:{owner}");
        let p = port.as_ref();
        let result = async {
            if !Self::marked_done(ctx, p, &marker).await? {
                return anyhow::Ok(0);
            }
            let n = move_back!(self, ctx, p, owner, [
                doc_type => restore_types,
                document => restore_docs,
                document_binding => restore_bindings,
                analysis => restore_analyses,
                spec_extraction => restore_extractions,
                spec_judgement => restore_judgements,
                spec_decision => restore_spec_decisions,
                spec_review => restore_spec_reviews,
                spec_term => restore_spec_terms,
                application_part => restore_parts,
                delivery_scope => restore_scopes,
                delivery_limit => restore_limits,
                delivery_history => restore_scope_history,
            ])?;
            p.put_objects(
                ctx,
                "sync-state",
                vec![crate::domain_model::port::OwnedObject {
                    id: marker.clone(),
                    scope: owner.to_string(),
                    payload: json!({"status": "returned", "message": "documents moved back to the tables"}),
                }],
            )
            .await?;
            anyhow::Ok(n)
        }
        .await;
        match result {
            Ok(n) => {
                if n > 0 {
                    tracing::info!(owner = %owner, rows = n, "studio-documents: rows moved back to the tables");
                }
                if let Ok(mut m) = self.moved.lock() {
                    m.insert(owner);
                }
            }
            Err(e) => {
                tracing::warn!(owner = %owner, error = %e, "studio-documents: could not move the rows back yet")
            }
        }
    }

    // ── document types ──────────────────────────────────────────────────────

    pub async fn list_types(
        &self,
        ctx: &SecurityContext,
        owners: &[Uuid],
    ) -> Result<Vec<doc_type::Model>> {
        if owners.is_empty() {
            return Ok(Vec::new());
        }
        let mut model = None;
        let mut tables = Vec::new();
        for &owner in owners {
            match at!(self, ctx, doc_type::Model, owner, all_types) {
                Some(found) => model = Some(found),
                None => tables.push(owner),
            }
        }
        let mut out = Vec::new();
        if let Some((port, ref ctx)) = model {
            let moved: Vec<Uuid> = owners
                .iter()
                .copied()
                .filter(|o| !tables.contains(o))
                .collect();
            out = self
                .table
                .list(
                    ctx,
                    port.as_ref(),
                    json!({"tenant_id": {"_in": ids(&moved)}}),
                    None,
                )
                .await?;
        }
        if !tables.is_empty() {
            out.extend(self.repo.list_types(&tables).await?);
        }
        Ok(out)
    }

    pub async fn upsert_type(&self, ctx: &SecurityContext, m: doc_type::Model) -> Result<()> {
        if let Some((port, ref ctx)) = at!(self, ctx, doc_type::Model, m.tenant_id, all_types) {
            const UPDATE: &[&str] = &[
                "name",
                "description",
                "gts_type_id",
                "template",
                "hidden",
                "updated_at",
            ];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.upsert_type(m).await
    }

    pub async fn delete_type(&self, ctx: &SecurityContext, owner: Uuid, key: &str) -> Result<bool> {
        if let Some((port, ref ctx)) = at!(self, ctx, doc_type::Model, owner, all_types) {
            let found: Vec<doc_type::Model> = self
                .table
                .list(
                    ctx,
                    port.as_ref(),
                    json!({"tenant_id": {"_eq": owner}, "key": {"_eq": key}}),
                    None,
                )
                .await?;
            let ids: Vec<Uuid> = found.iter().map(|r| r.id).collect();
            return Ok(self
                .table
                .remove::<doc_type::Model>(ctx, port.as_ref(), &ids)
                .await?
                > 0);
        }
        self.repo.delete_type(owner, key).await
    }

    // ── analyses ────────────────────────────────────────────────────────────

    async fn analyses_by(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        field: &str,
        subjects: &[Uuid],
    ) -> Result<Option<Vec<analysis::Model>>> {
        let Some((port, ref ctx)) = at!(self, ctx, analysis::Model, workspace_id, all_analyses)
        else {
            return Ok(None);
        };
        let mut w = json!({"tenant_id": {"_eq": workspace_id}});
        w[field] = json!({"_in": ids(subjects)});
        Ok(Some(self.table.list(ctx, port.as_ref(), w, None).await?))
    }

    pub async fn list_analyses(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        document_ids: &[Uuid],
    ) -> Result<Vec<analysis::Model>> {
        if document_ids.is_empty() {
            return Ok(Vec::new());
        }
        match self
            .analyses_by(ctx, workspace_id, "document_id", document_ids)
            .await?
        {
            Some(rows) => Ok(rows),
            None => self.repo.list_analyses(workspace_id, document_ids).await,
        }
    }

    pub async fn list_binding_analyses(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        binding_ids: &[Uuid],
    ) -> Result<Vec<analysis::Model>> {
        if binding_ids.is_empty() {
            return Ok(Vec::new());
        }
        match self
            .analyses_by(ctx, workspace_id, "binding_id", binding_ids)
            .await?
        {
            Some(rows) => Ok(rows),
            None => {
                self.repo
                    .list_binding_analyses(workspace_id, binding_ids)
                    .await
            }
        }
    }

    pub async fn upsert_analysis(&self, ctx: &SecurityContext, m: analysis::Model) -> Result<()> {
        if let Some((port, ref ctx)) = at!(self, ctx, analysis::Model, m.tenant_id, all_analyses) {
            const UPDATE: &[&str] = &["state", "task_id", "summary", "updated_at"];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.upsert_analysis(m).await
    }

    /// The verdicts on these subjects go with them, as the table's
    /// `ON DELETE CASCADE` takes them.
    async fn drop_analyses(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        workspace_id: Uuid,
        field: &str,
        subjects: &[Uuid],
    ) -> Result<()> {
        if let Some(rows) = self.analyses_by(ctx, workspace_id, field, subjects).await? {
            let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
            self.table
                .remove::<analysis::Model>(ctx, port, &ids)
                .await?;
        }
        Ok(())
    }

    // ── the spec model ──────────────────────────────────────────────────────

    pub async fn list_extractions(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_extraction::Model>> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_extraction::Model,
            workspace_id,
            all_extractions
        ) {
            return self
                .in_project(ctx, port.as_ref(), workspace_id, project_id)
                .await;
        }
        self.repo.list_extractions(workspace_id, project_id).await
    }

    pub async fn put_extraction(
        &self,
        ctx: &SecurityContext,
        m: spec_extraction::Model,
    ) -> Result<()> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_extraction::Model,
            m.tenant_id,
            all_extractions
        ) {
            const UPDATE: &[&str] = &[
                "facts",
                "dropped",
                "error",
                "provider",
                "model",
                "created_at",
            ];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_extraction(m).await
    }

    pub async fn list_judgements(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_judgement::Model>> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_judgement::Model,
            workspace_id,
            all_judgements
        ) {
            return self
                .in_project(ctx, port.as_ref(), workspace_id, project_id)
                .await;
        }
        self.repo.list_judgements(workspace_id, project_id).await
    }

    pub async fn put_judgement(
        &self,
        ctx: &SecurityContext,
        m: spec_judgement::Model,
    ) -> Result<()> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_judgement::Model,
            m.tenant_id,
            all_judgements
        ) {
            const UPDATE: &[&str] = &["conflict", "finding", "created_at"];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_judgement(m).await
    }

    pub async fn list_spec_terms(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_term::Model>> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, spec_term::Model, workspace_id, all_spec_terms)
        {
            return self
                .in_project(ctx, port.as_ref(), workspace_id, project_id)
                .await;
        }
        self.repo.list_spec_terms(workspace_id, project_id).await
    }

    pub async fn put_spec_term(&self, ctx: &SecurityContext, m: spec_term::Model) -> Result<()> {
        if let Some((port, ref ctx)) = at!(self, ctx, spec_term::Model, m.tenant_id, all_spec_terms)
        {
            const UPDATE: &[&str] = &["name", "alias_of", "decided_by", "decided_at"];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_spec_term(m).await
    }

    pub async fn put_spec_term_distinct(
        &self,
        ctx: &SecurityContext,
        m: spec_term::Model,
    ) -> Result<()> {
        if let Some((port, ref ctx)) = at!(self, ctx, spec_term::Model, m.tenant_id, all_spec_terms)
        {
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(&["distinct_from"]))
                .await;
        }
        self.repo.put_spec_term_distinct(m).await
    }

    pub async fn list_spec_reviews(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_review::Model>> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_review::Model,
            workspace_id,
            all_spec_reviews
        ) {
            return self
                .in_project(ctx, port.as_ref(), workspace_id, project_id)
                .await;
        }
        self.repo.list_spec_reviews(workspace_id, project_id).await
    }

    pub async fn put_spec_review(
        &self,
        ctx: &SecurityContext,
        m: spec_review::Model,
    ) -> Result<()> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, spec_review::Model, m.tenant_id, all_spec_reviews)
        {
            const UPDATE: &[&str] = &[
                "state",
                "path",
                "revision",
                "note",
                "decided_by",
                "decided_at",
            ];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_spec_review(m).await
    }

    pub async fn delete_spec_review(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
        fact_key: &str,
    ) -> Result<()> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_review::Model,
            workspace_id,
            all_spec_reviews
        ) {
            self.table
                .remove::<spec_review::Model>(
                    ctx,
                    port.as_ref(),
                    &[spec_review_id(project_id, fact_key)],
                )
                .await?;
            return Ok(());
        }
        self.repo
            .delete_spec_review(workspace_id, project_id, fact_key)
            .await
    }

    pub async fn list_spec_decisions(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<spec_decision::Model>> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_decision::Model,
            workspace_id,
            all_spec_decisions
        ) {
            return self
                .in_project(ctx, port.as_ref(), workspace_id, project_id)
                .await;
        }
        self.repo
            .list_spec_decisions(workspace_id, project_id)
            .await
    }

    pub async fn put_spec_decision(
        &self,
        ctx: &SecurityContext,
        m: spec_decision::Model,
    ) -> Result<()> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            spec_decision::Model,
            m.tenant_id,
            all_spec_decisions
        ) {
            const UPDATE: &[&str] = &["decision", "decided_by", "decided_at", "note", "snapshot"];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_spec_decision(m).await
    }

    async fn in_project<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<T>> {
        self.table
            .list(
                ctx,
                port,
                json!({"tenant_id": {"_eq": workspace_id}, "project_id": {"_eq": project_id}}),
                None,
            )
            .await
    }

    // ── application parts ───────────────────────────────────────────────────

    pub async fn put_part(&self, ctx: &SecurityContext, m: application_part::Model) -> Result<()> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, application_part::Model, m.tenant_id, all_parts)
        {
            const UPDATE: &[&str] = &[
                "owner",
                "owner_name",
                "description_path",
                "boundary",
                "related",
                "updated_by",
                "updated_at",
            ];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_part(m).await
    }

    pub async fn list_parts(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<application_part::Model>> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, application_part::Model, workspace_id, all_parts)
        {
            return self
                .in_project(ctx, port.as_ref(), workspace_id, project_id)
                .await;
        }
        self.repo.list_parts(workspace_id, project_id).await
    }

    // ── delivery scopes ─────────────────────────────────────────────────────

    pub async fn put_scope(&self, ctx: &SecurityContext, m: delivery_scope::Model) -> Result<()> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, delivery_scope::Model, m.tenant_id, all_scopes)
        {
            const UPDATE: &[&str] = &[
                "title",
                "outcome",
                "owner",
                "owner_name",
                "target_date",
                "requirements",
                "gears",
                "acceptance",
                "state",
                "updated_by",
                "updated_at",
            ];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_scope(m).await
    }

    pub async fn list_scopes(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<delivery_scope::Model>> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, delivery_scope::Model, workspace_id, all_scopes)
        {
            return self
                .table
                .list(
                    ctx,
                    port.as_ref(),
                    json!({"tenant_id": {"_eq": workspace_id}, "project_id": {"_eq": project_id}}),
                    Some(json!([{"field": "created_at"}])),
                )
                .await;
        }
        self.repo.list_scopes(workspace_id, project_id).await
    }

    pub async fn delete_scope(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<()> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, delivery_scope::Model, workspace_id, all_scopes)
        {
            self.table
                .remove::<delivery_scope::Model>(ctx, port.as_ref(), &[id])
                .await?;
            return Ok(());
        }
        self.repo.delete_scope(workspace_id, id).await
    }

    pub async fn insert_scope_history(
        &self,
        ctx: &SecurityContext,
        m: delivery_history::Model,
    ) -> Result<()> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            delivery_history::Model,
            m.tenant_id,
            all_scope_history
        ) {
            return self.table.put(ctx, port.as_ref(), vec![m], None).await;
        }
        self.repo.insert_scope_history(m).await
    }

    pub async fn list_scope_history(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        scope_id: Uuid,
    ) -> Result<Vec<delivery_history::Model>> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            delivery_history::Model,
            workspace_id,
            all_scope_history
        ) {
            return self
                .table
                .list(
                    ctx,
                    port.as_ref(),
                    json!({"tenant_id": {"_eq": workspace_id}, "scope_id": {"_eq": scope_id}}),
                    Some(json!([{"field": "changed_at", "direction": "desc"}])),
                )
                .await;
        }
        self.repo.list_scope_history(workspace_id, scope_id).await
    }

    pub async fn put_limit(&self, ctx: &SecurityContext, m: delivery_limit::Model) -> Result<()> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, delivery_limit::Model, m.tenant_id, all_limits)
        {
            const UPDATE: &[&str] = &[
                "text",
                "blocking",
                "depends_on",
                "resolution",
                "resolved_by",
                "resolved_at",
            ];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.put_limit(m).await
    }

    pub async fn list_limits(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<delivery_limit::Model>> {
        if let Some((port, ref ctx)) =
            at!(self, ctx, delivery_limit::Model, workspace_id, all_limits)
        {
            return self
                .table
                .list(
                    ctx,
                    port.as_ref(),
                    json!({"tenant_id": {"_eq": workspace_id}, "project_id": {"_eq": project_id}}),
                    Some(json!([{"field": "created_at"}])),
                )
                .await;
        }
        self.repo.list_limits(workspace_id, project_id).await
    }

    // ── documents ───────────────────────────────────────────────────────────

    pub async fn get_doc(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<Option<document::Model>> {
        if let Some((port, ref ctx)) = at!(self, ctx, document::Model, workspace_id, all_docs) {
            let found: Vec<document::Model> = self.table.get(ctx, port.as_ref(), &[id]).await?;
            return Ok(found.into_iter().find(|d| d.tenant_id == workspace_id));
        }
        self.repo.get_doc(workspace_id, id).await
    }

    /// Documents in scope, newest first, plus how many the filter matches.
    pub async fn list_docs(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        scope: DocScope,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<(Vec<document::Model>, u64)> {
        if let Some((port, ref ctx)) = at!(self, ctx, document::Model, workspace_id, all_docs) {
            return self
                .table
                .page(
                    ctx,
                    port.as_ref(),
                    in_scope(workspace_id, &scope),
                    Some(json!([{"field": "updated_at", "direction": "desc"}, {"field": "id"}])),
                    offset,
                    limit,
                )
                .await;
        }
        self.repo
            .list_docs(workspace_id, scope, offset, limit)
            .await
    }

    pub async fn upsert_doc(&self, ctx: &SecurityContext, m: document::Model) -> Result<()> {
        if let Some((port, ref ctx)) = at!(self, ctx, document::Model, m.tenant_id, all_docs) {
            const UPDATE: &[&str] = &[
                "title",
                "content",
                "status",
                "conforms",
                "validation",
                "capabilities",
                "requirements",
                "inferred_capabilities",
                "updated_at",
            ];
            return self
                .table
                .put(ctx, port.as_ref(), vec![m], Some(UPDATE))
                .await;
        }
        self.repo.upsert_doc(m).await
    }

    pub async fn existing_doc_ids(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        ids: &[Uuid],
    ) -> Result<HashSet<Uuid>> {
        if ids.is_empty() {
            return Ok(HashSet::new());
        }
        if let Some((port, ref ctx)) = at!(self, ctx, document::Model, workspace_id, all_docs) {
            let found: Vec<document::Model> = self.table.get(ctx, port.as_ref(), ids).await?;
            return Ok(found
                .into_iter()
                .filter(|d| d.tenant_id == workspace_id)
                .map(|d| d.id)
                .collect());
        }
        self.repo.existing_doc_ids(workspace_id, ids).await
    }

    pub async fn delete_doc(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<bool> {
        if let Some((port, ref ctx)) = at!(self, ctx, document::Model, workspace_id, all_docs) {
            if self.get_doc(ctx, workspace_id, id).await?.is_none() {
                return Ok(false);
            }
            self.drop_analyses(ctx, port.as_ref(), workspace_id, "document_id", &[id])
                .await?;
            return Ok(self
                .table
                .remove::<document::Model>(ctx, port.as_ref(), &[id])
                .await?
                > 0);
        }
        self.repo.delete_doc(workspace_id, id).await
    }

    // ── document bindings ───────────────────────────────────────────────────

    pub async fn list_bindings(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        scope: DocScope,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<(Vec<document_binding::Model>, u64)> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            document_binding::Model,
            workspace_id,
            all_bindings
        ) {
            return self
                .table
                .page(
                    ctx,
                    port.as_ref(),
                    in_scope(workspace_id, &scope),
                    Some(json!([{"field": "path"}, {"field": "id"}])),
                    offset,
                    limit,
                )
                .await;
        }
        self.repo
            .list_bindings(workspace_id, scope, offset, limit)
            .await
    }

    pub async fn list_bindings_at(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        scope: DocScope,
        paths: &[String],
    ) -> Result<Vec<document_binding::Model>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            document_binding::Model,
            workspace_id,
            all_bindings
        ) {
            let w = json!({"_and": [in_scope(workspace_id, &scope), {"path": {"_in": paths}}]});
            return self
                .table
                .list(
                    ctx,
                    port.as_ref(),
                    w,
                    Some(json!([{"field": "path"}, {"field": "id"}])),
                )
                .await;
        }
        self.repo.list_bindings_at(workspace_id, scope, paths).await
    }

    pub async fn get_binding(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<Option<document_binding::Model>> {
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            document_binding::Model,
            workspace_id,
            all_bindings
        ) {
            let found: Vec<document_binding::Model> =
                self.table.get(ctx, port.as_ref(), &[id]).await?;
            return Ok(found.into_iter().find(|b| b.tenant_id == workspace_id));
        }
        self.repo.get_binding(workspace_id, id).await
    }

    pub async fn upsert_binding(
        &self,
        ctx: &SecurityContext,
        m: document_binding::Model,
    ) -> Result<()> {
        if self.table.port().is_none() {
            return self.repo.upsert_binding(m).await;
        }
        self.upsert_bindings(ctx, std::slice::from_ref(&m)).await
    }

    /// `created_at` is left as it was, so a re-classified file keeps the date
    /// it first appeared.
    pub async fn upsert_bindings(
        &self,
        ctx: &SecurityContext,
        models: &[document_binding::Model],
    ) -> Result<()> {
        let Some(first) = models.first() else {
            return Ok(());
        };
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            document_binding::Model,
            first.tenant_id,
            all_bindings
        ) {
            const UPDATE: &[&str] = &[
                "path",
                "type_key",
                "state",
                "confidence",
                "source",
                "candidates",
                "conforms",
                "validation",
                "capabilities",
                "requirements",
                "inferred_capabilities",
                "content_sha",
                "updated_at",
            ];
            for chunk in models.chunks(500) {
                self.table
                    .put(ctx, port.as_ref(), chunk.to_vec(), Some(UPDATE))
                    .await?;
            }
            return Ok(());
        }
        self.repo.upsert_bindings(models).await
    }

    pub async fn delete_binding(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<bool> {
        if self.table.port().is_none() {
            return self.repo.delete_binding(workspace_id, id).await;
        }
        Ok(self.delete_bindings(ctx, workspace_id, &[id]).await? > 0)
    }

    /// Their verdicts go with them, as the table's cascade takes them.
    pub async fn delete_bindings(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        ids: &[Uuid],
    ) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        if let Some((port, ref ctx)) = at!(
            self,
            ctx,
            document_binding::Model,
            workspace_id,
            all_bindings
        ) {
            let mut deleted = 0u64;
            for chunk in ids.chunks(1_000) {
                let found: Vec<document_binding::Model> =
                    self.table.get(ctx, port.as_ref(), chunk).await?;
                let mine: Vec<Uuid> = found
                    .iter()
                    .filter(|b| b.tenant_id == workspace_id)
                    .map(|b| b.id)
                    .collect();
                if mine.is_empty() {
                    continue;
                }
                self.drop_analyses(ctx, port.as_ref(), workspace_id, "binding_id", &mine)
                    .await?;
                deleted += self
                    .table
                    .remove::<document_binding::Model>(ctx, port.as_ref(), &mine)
                    .await? as u64;
            }
            return Ok(deleted);
        }
        self.repo.delete_bindings(workspace_id, ids).await
    }
}

#[async_trait::async_trait]
impl crate::model_sweep::TenantMover for DocumentsData {
    fn name(&self) -> &str {
        "studio-documents"
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> Result<()> {
        self.owner(ctx, tenant).await.map(|_| ())
    }
}
