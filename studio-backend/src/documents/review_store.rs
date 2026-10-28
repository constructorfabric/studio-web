//! Review requests, the verdicts given on them, and the project's recorded
//! decisions — kept where the configuration says (ADR-0051 §8a):
//! `gears.studio-documents.config.storage.reviews: model | tables`.
//!
//! Under `model` they are `review-request`, `approval` and `decision` domain
//! objects, scoped to their project, so the domain query reads them and the
//! Home and Specs screens can ask for them like anything else. The service
//! keeps the same operations and row shapes as with the tables.
//!
//! What a workspace already had moves the first time it is touched: its rows
//! are written into the model, a marker records the move, and the tables'
//! copies are dropped, so nothing is kept twice. In the model an approval is
//! still never changed.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::entity::{approval, decision, review_request};
use super::repo::DocumentsRepo;
use crate::domain_model::port::{DomainObjects, OwnedObject, StoredObject, TypeNeed};

/// The configured strategy for reviews, verdicts and decisions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewStorage {
    #[default]
    Model,
    Tables,
}

const REQUEST: &str = "review-request";
const APPROVAL: &str = "approval";
const DECISION: &str = "decision";

fn f(n: &str, t: &str) -> (String, String, String) {
    (n.to_string(), t.to_string(), String::new())
}

fn needs() -> Vec<TypeNeed> {
    vec![
        TypeNeed {
            id: REQUEST.to_string(),
            held_by: Some("studio-documents".to_string()),
            fields: vec![
                f("workspace_id", "string"),
                f("project_id", "string"),
                f("subject_kind", "string"),
                f("subject_id", "string"),
                f("type_key", "string?"),
                f("title", "string"),
                f("version", "string"),
                f("requested_by", "string"),
                f("requested_by_name", "string?"),
                f("reviewers", "JSON"),
                f("due_at", "timestamp?"),
                f("state", "open | approved | superseded | withdrawn"),
                f("created_at", "timestamp"),
                f("reviewed_text", "string?"),
                f("stakeholders", "JSON"),
                f("rules_snapshot", "JSON?"),
            ],
            ..Default::default()
        },
        TypeNeed {
            id: APPROVAL.to_string(),
            held_by: Some("studio-documents".to_string()),
            fields: vec![
                f("workspace_id", "string"),
                f("project_id", "string"),
                f("request_id", "string"),
                f("subject_id", "string"),
                f("version", "string"),
                f("approver", "string"),
                f("approver_name", "string?"),
                f("verdict", "string"),
                f("security", "boolean"),
                f("note", "string?"),
                f("checks", "JSON"),
                f("decided_at", "timestamp"),
            ],
            ..Default::default()
        },
        TypeNeed {
            id: DECISION.to_string(),
            name: "Decision".to_string(),
            description: "A decision a project recorded: what was decided, about which requirements, by whom."
                .to_string(),
            extends: Some("record".to_string()),
            bucket: Some("collaboration".to_string()),
            fields: vec![
                f("workspace_id", "string"),
                f("project_id", "string"),
                f("statement", "string"),
                f("requirements", "JSON"),
                f("source_url", "url?"),
                f("source_kind", "string"),
                f("path", "string?"),
                f("decided_by", "string"),
                f("decided_by_name", "string?"),
                f("decided_at", "timestamp"),
            ],
            relations: Vec::new(),
            held_by: None,
            searchable: false,
        },
    ]
}

fn ts(t: OffsetDateTime) -> Value {
    Value::String(t.format(&Rfc3339).unwrap_or_default())
}

fn ts_opt(t: Option<OffsetDateTime>) -> Value {
    t.map_or(Value::Null, ts)
}

fn read_ts(v: &Value, k: &str) -> Option<OffsetDateTime> {
    v.get(k)
        .and_then(Value::as_str)
        .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
}

fn read_str(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn read_opt(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn read_uuid(v: &Value, k: &str) -> Uuid {
    v.get(k)
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or_default()
}

fn request_payload(r: &review_request::Model) -> Value {
    json!({
        "workspace_id": r.tenant_id.to_string(),
        "project_id": r.project_id.to_string(),
        "row_id": r.id.to_string(),
        "subject_kind": r.subject_kind,
        "subject_id": r.subject_id.to_string(),
        "type_key": r.type_key,
        "title": r.title,
        "version": r.version,
        "requested_by": r.requested_by,
        "requested_by_name": r.requested_by_name,
        "reviewers": r.reviewers,
        "due_at": ts_opt(r.due_at),
        "state": r.state,
        "created_at": ts(r.created_at),
        "reviewed_text": r.reviewed_text,
        "stakeholders": r.stakeholders,
        "rules_snapshot": r.rules_snapshot,
    })
}

fn request_row(o: &StoredObject) -> review_request::Model {
    let v = &o.payload;
    review_request::Model {
        id: read_uuid(v, "row_id"),
        tenant_id: read_uuid(v, "workspace_id"),
        project_id: read_uuid(v, "project_id"),
        subject_kind: read_str(v, "subject_kind"),
        subject_id: read_uuid(v, "subject_id"),
        type_key: read_opt(v, "type_key"),
        title: read_str(v, "title"),
        version: read_str(v, "version"),
        requested_by: read_str(v, "requested_by"),
        requested_by_name: read_opt(v, "requested_by_name"),
        reviewers: v.get("reviewers").cloned().unwrap_or(json!([])),
        due_at: read_ts(v, "due_at"),
        state: read_str(v, "state"),
        created_at: read_ts(v, "created_at").unwrap_or(OffsetDateTime::UNIX_EPOCH),
        reviewed_text: read_opt(v, "reviewed_text"),
        stakeholders: v.get("stakeholders").cloned().unwrap_or(json!([])),
        rules_snapshot: v.get("rules_snapshot").cloned().filter(|s| !s.is_null()),
    }
}

fn approval_payload(a: &approval::Model) -> Value {
    json!({
        "workspace_id": a.tenant_id.to_string(),
        "project_id": a.project_id.to_string(),
        "row_id": a.id.to_string(),
        "request_id": a.request_id.to_string(),
        "subject_id": a.subject_id.to_string(),
        "version": a.version,
        "approver": a.approver,
        "approver_name": a.approver_name,
        "verdict": a.verdict,
        "security": a.security,
        "note": a.note,
        "checks": a.checks,
        "decided_at": ts(a.decided_at),
    })
}

fn approval_row(o: &StoredObject) -> approval::Model {
    let v = &o.payload;
    approval::Model {
        id: read_uuid(v, "row_id"),
        tenant_id: read_uuid(v, "workspace_id"),
        project_id: read_uuid(v, "project_id"),
        request_id: read_uuid(v, "request_id"),
        subject_id: read_uuid(v, "subject_id"),
        version: read_str(v, "version"),
        approver: read_str(v, "approver"),
        approver_name: read_opt(v, "approver_name"),
        verdict: read_str(v, "verdict"),
        security: v.get("security").and_then(Value::as_bool).unwrap_or(false),
        note: read_opt(v, "note"),
        checks: v.get("checks").cloned().unwrap_or(json!([])),
        decided_at: read_ts(v, "decided_at").unwrap_or(OffsetDateTime::UNIX_EPOCH),
    }
}

fn decision_payload(d: &decision::Model) -> Value {
    json!({
        "workspace_id": d.tenant_id.to_string(),
        "project_id": d.project_id.to_string(),
        "row_id": d.id.to_string(),
        "statement": d.statement,
        "requirements": d.requirements,
        "source_url": d.source_url,
        "source_kind": d.source_kind,
        "path": d.path,
        "decided_by": d.decided_by,
        "decided_by_name": d.decided_by_name,
        "decided_at": ts(d.decided_at),
    })
}

fn decision_row(o: &StoredObject) -> decision::Model {
    let v = &o.payload;
    decision::Model {
        id: read_uuid(v, "row_id"),
        tenant_id: read_uuid(v, "workspace_id"),
        project_id: read_uuid(v, "project_id"),
        statement: read_str(v, "statement"),
        requirements: v.get("requirements").cloned().unwrap_or(json!([])),
        source_url: read_opt(v, "source_url"),
        source_kind: read_str(v, "source_kind"),
        path: read_opt(v, "path"),
        decided_by: read_str(v, "decided_by"),
        decided_by_name: read_opt(v, "decided_by_name"),
        decided_at: read_ts(v, "decided_at").unwrap_or(OffsetDateTime::UNIX_EPOCH),
    }
}

fn id_of(kind: &str, row: Uuid) -> String {
    format!("{kind}:{row}")
}

/// Reviews, verdicts and decisions, kept where the configuration says.
pub struct ReviewStore {
    repo: Arc<DocumentsRepo>,
    storage: ReviewStorage,
    hub: Option<Arc<toolkit::client_hub::ClientHub>>,
    typed: Mutex<HashSet<Uuid>>,
    moved: Mutex<HashSet<Uuid>>,
}

impl ReviewStore {
    pub fn new(
        repo: Arc<DocumentsRepo>,
        storage: ReviewStorage,
        hub: Option<Arc<toolkit::client_hub::ClientHub>>,
    ) -> Self {
        Self {
            repo,
            storage,
            hub,
            typed: Mutex::default(),
            moved: Mutex::default(),
        }
    }

    /// The model's port, once the workspace's rows have moved into it.
    async fn model(
        &self,
        ctx: &SecurityContext,
        workspace: Uuid,
    ) -> Result<Option<(Arc<dyn DomainObjects>, SecurityContext)>> {
        // The workspace's reviews live in its organization's model.
        let org_ctx = match self.hub.as_ref().and_then(|h| {
            h.get::<dyn account_management_sdk::AccountManagementClient>()
                .ok()
        }) {
            Some(am) => crate::org_scope::in_org_of(am.as_ref(), ctx, workspace).await,
            None => ctx.clone(),
        };
        let ctx = &org_ctx;
        if self.storage != ReviewStorage::Model {
            self.back_to_tables(ctx, workspace).await;
            return Ok(None);
        }
        let Some(port) = self
            .hub
            .as_ref()
            .and_then(|h| h.get::<dyn DomainObjects>().ok())
        else {
            warn!(
                "studio-documents: reviews are kept in the model, but the domain model is not available — using the tables"
            );
            return Ok(None);
        };
        let tenant = ctx.subject_tenant_id();
        if !self
            .typed
            .lock()
            .map(|t| t.contains(&tenant))
            .unwrap_or(false)
        {
            for need in needs() {
                port.ensure_type(ctx, &need).await?;
            }
            if let Ok(mut t) = self.typed.lock() {
                t.insert(tenant);
            }
        }
        if !self
            .moved
            .lock()
            .map(|m| m.contains(&workspace))
            .unwrap_or(false)
        {
            self.move_workspace(ctx, port.as_ref(), workspace).await?;
            if let Ok(mut m) = self.moved.lock() {
                m.insert(workspace);
            }
        }
        Ok(Some((port, org_ctx)))
    }

    async fn move_workspace(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        ws: Uuid,
    ) -> Result<()> {
        let marker = format!("reviews-moved-v1:{ws}");
        let (done, _) = port
            .query(
                ctx,
                json!({"type": "sync-state", "where": {"id": {"_eq": marker}}, "limit": 1}),
            )
            .await?;
        if done
            .first()
            .is_some_and(|o| o.payload.get("status").and_then(Value::as_str) == Some("done"))
        {
            return Ok(());
        }
        let requests = self.repo.list_review_requests(ws, None, None).await?;
        let ids: Vec<Uuid> = requests.iter().map(|r| r.id).collect();
        let approvals = self.repo.list_approvals(ws, &ids).await?;
        let decisions = self.repo.list_workspace_decisions(ws).await?;
        let put = |kind: &str, row: Uuid, project: Uuid, payload: Value| OwnedObject {
            id: id_of(kind, row),
            scope: project.to_string(),
            payload,
        };
        port.put_objects(
            ctx,
            REQUEST,
            requests
                .iter()
                .map(|r| put(REQUEST, r.id, r.project_id, request_payload(r)))
                .collect(),
        )
        .await?;
        port.put_objects(
            ctx,
            APPROVAL,
            approvals
                .iter()
                .map(|a| put(APPROVAL, a.id, a.project_id, approval_payload(a)))
                .collect(),
        )
        .await?;
        port.put_objects(
            ctx,
            DECISION,
            decisions
                .iter()
                .map(|d| put(DECISION, d.id, d.project_id, decision_payload(d)))
                .collect(),
        )
        .await?;
        port.put_objects(
            ctx,
            "sync-state",
            vec![OwnedObject {
                id: marker,
                scope: ws.to_string(),
                payload: json!({"status": "done", "message": "reviews moved into the domain model"}),
            }],
        )
        .await?;
        if let Err(e) = self.repo.purge_reviews(ws).await {
            warn!(workspace = %ws, error = %e, "studio-documents: reviews moved, but the tables' copies could not be dropped");
        }
        if !(requests.is_empty() && decisions.is_empty()) {
            info!(workspace = %ws, requests = requests.len(), approvals = approvals.len(), decisions = decisions.len(), "studio-documents: reviews moved into the domain model");
        }
        Ok(())
    }

    /// Storage switched back to `tables`: a workspace whose reviews the model
    /// holds gets them back, and the model keeps no copy. Best effort; the
    /// tables answer meanwhile.
    async fn back_to_tables(&self, ctx: &SecurityContext, ws: Uuid) {
        if self.moved.lock().map(|m| m.contains(&ws)).unwrap_or(true) {
            return;
        }
        let Some(port) = self
            .hub
            .as_ref()
            .and_then(|h| h.get::<dyn DomainObjects>().ok())
        else {
            return;
        };
        let marker = format!("reviews-moved-v1:{ws}");
        let p = port.as_ref();
        let result = async {
            let (done, _) = p
                .query(ctx, json!({"type": "sync-state", "where": {"id": {"_eq": marker}}, "limit": 1}))
                .await?;
            if !done
                .first()
                .is_some_and(|o| o.payload.get("status").and_then(Value::as_str) == Some("done"))
            {
                return anyhow::Ok(0usize);
            }
            let mine = json!({"workspace_id": {"_eq": ws}});
            let requests = p.query(ctx, json!({"type": REQUEST, "where": mine})).await?.0;
            let approvals = p.query(ctx, json!({"type": APPROVAL, "where": mine})).await?.0;
            let decisions = p.query(ctx, json!({"type": DECISION, "where": mine})).await?.0;
            let n = requests.len() + approvals.len() + decisions.len();
            self.repo
                .restore_review_requests(ws, requests.iter().map(request_row).collect())
                .await?;
            self.repo
                .restore_approvals(ws, approvals.iter().map(approval_row).collect())
                .await?;
            self.repo
                .restore_decisions(ws, decisions.iter().map(decision_row).collect())
                .await?;
            for (kind, rows) in [(REQUEST, &requests), (APPROVAL, &approvals), (DECISION, &decisions)] {
                let ids: Vec<String> = rows.iter().map(|o| o.instance_id.clone()).collect();
                if !ids.is_empty() {
                    p.remove_objects(ctx, kind, ids).await?;
                }
            }
            p.put_objects(
                ctx,
                "sync-state",
                vec![OwnedObject {
                    id: marker.clone(),
                    scope: ws.to_string(),
                    payload: json!({"status": "returned", "message": "reviews moved back to the tables"}),
                }],
            )
            .await?;
            anyhow::Ok(n)
        }
        .await;
        match result {
            Ok(n) => {
                if n > 0 {
                    info!(workspace = %ws, rows = n, "studio-documents: reviews moved back to the tables");
                }
                if let Ok(mut m) = self.moved.lock() {
                    m.insert(ws);
                }
            }
            Err(e) => {
                warn!(workspace = %ws, error = %e, "studio-documents: could not move reviews back yet")
            }
        }
    }

    async fn rows(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        body: Value,
    ) -> Result<Vec<StoredObject>> {
        Ok(port.query(ctx, body).await?.0)
    }

    pub async fn put_review_request(
        &self,
        ctx: &SecurityContext,
        model: review_request::Model,
    ) -> Result<()> {
        let Some((port, ref ctx)) = self.model(ctx, model.tenant_id).await? else {
            return self.repo.put_review_request(model).await;
        };
        // An open request on the same document is superseded by the new one.
        let open = self
            .rows(
                port.as_ref(),
                ctx,
                json!({"type": REQUEST, "where": {
                    "project_id": {"_eq": model.project_id.to_string()},
                    "subject_id": {"_eq": model.subject_id.to_string()},
                    "state": {"_eq": "open"},
                }}),
            )
            .await?;
        let mut objects: Vec<OwnedObject> = open
            .iter()
            .map(|o| {
                let mut row = request_row(o);
                row.state = "superseded".to_string();
                OwnedObject {
                    id: o.instance_id.clone(),
                    scope: row.project_id.to_string(),
                    payload: request_payload(&row),
                }
            })
            .collect();
        objects.push(OwnedObject {
            id: id_of(REQUEST, model.id),
            scope: model.project_id.to_string(),
            payload: request_payload(&model),
        });
        port.put_objects(ctx, REQUEST, objects).await?;
        Ok(())
    }

    pub async fn list_review_requests(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        subject_id: Option<Uuid>,
    ) -> Result<Vec<review_request::Model>> {
        let Some((port, ref ctx)) = self.model(ctx, workspace_id).await? else {
            return self
                .repo
                .list_review_requests(workspace_id, project_id, subject_id)
                .await;
        };
        let mut w = json!({"workspace_id": {"_eq": workspace_id.to_string()}});
        if let Some(p) = project_id {
            w["project_id"] = json!({"_eq": p.to_string()});
        }
        if let Some(s) = subject_id {
            w["subject_id"] = json!({"_eq": s.to_string()});
        }
        let rows = self
            .rows(
                port.as_ref(),
                ctx,
                json!({"type": REQUEST, "where": w, "order_by": [{"field": "created_at", "direction": "desc"}]}),
            )
            .await?;
        Ok(rows.iter().map(request_row).collect())
    }

    pub async fn get_review_request(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
    ) -> Result<Option<review_request::Model>> {
        let Some((port, ref ctx)) = self.model(ctx, workspace_id).await? else {
            return self.repo.get_review_request(workspace_id, id).await;
        };
        let rows = self
            .rows(
                port.as_ref(),
                ctx,
                json!({"type": REQUEST, "where": {"id": {"_eq": id_of(REQUEST, id)}}}),
            )
            .await?;
        Ok(rows
            .first()
            .map(request_row)
            .filter(|r| r.tenant_id == workspace_id))
    }

    pub async fn set_review_request_state(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        id: Uuid,
        state: &str,
    ) -> Result<()> {
        let Some((port, ref ctx)) = self.model(ctx, workspace_id).await? else {
            return self
                .repo
                .set_review_request_state(workspace_id, id, state)
                .await;
        };
        if let Some(mut row) = self.get_review_request(ctx, workspace_id, id).await? {
            row.state = state.to_string();
            port.put_objects(
                ctx,
                REQUEST,
                vec![OwnedObject {
                    id: id_of(REQUEST, id),
                    scope: row.project_id.to_string(),
                    payload: request_payload(&row),
                }],
            )
            .await?;
        }
        Ok(())
    }

    pub async fn insert_approval(
        &self,
        ctx: &SecurityContext,
        model: approval::Model,
    ) -> Result<()> {
        let Some((port, ref ctx)) = self.model(ctx, model.tenant_id).await? else {
            return self.repo.insert_approval(model).await;
        };
        port.put_objects(
            ctx,
            APPROVAL,
            vec![OwnedObject {
                id: id_of(APPROVAL, model.id),
                scope: model.project_id.to_string(),
                payload: approval_payload(&model),
            }],
        )
        .await?;
        Ok(())
    }

    pub async fn list_approvals(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        request_ids: &[Uuid],
    ) -> Result<Vec<approval::Model>> {
        if request_ids.is_empty() {
            return Ok(Vec::new());
        }
        let Some((port, ref ctx)) = self.model(ctx, workspace_id).await? else {
            return self.repo.list_approvals(workspace_id, request_ids).await;
        };
        let ids: Vec<String> = request_ids.iter().map(Uuid::to_string).collect();
        let rows = self
            .rows(
                port.as_ref(),
                ctx,
                json!({"type": APPROVAL,
                       "where": {"workspace_id": {"_eq": workspace_id.to_string()}, "request_id": {"_in": ids}},
                       "order_by": [{"field": "decided_at"}]}),
            )
            .await?;
        Ok(rows.iter().map(approval_row).collect())
    }

    pub async fn insert_decision(
        &self,
        ctx: &SecurityContext,
        model: decision::Model,
    ) -> Result<()> {
        let Some((port, ref ctx)) = self.model(ctx, model.tenant_id).await? else {
            return self.repo.insert_decision(model).await;
        };
        port.put_objects(
            ctx,
            DECISION,
            vec![OwnedObject {
                id: id_of(DECISION, model.id),
                scope: model.project_id.to_string(),
                payload: decision_payload(&model),
            }],
        )
        .await?;
        Ok(())
    }

    pub async fn list_decisions(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> Result<Vec<decision::Model>> {
        let Some((port, ref ctx)) = self.model(ctx, workspace_id).await? else {
            return self.repo.list_decisions(workspace_id, project_id).await;
        };
        let rows = self
            .rows(
                port.as_ref(),
                ctx,
                json!({"type": DECISION,
                       "where": {"workspace_id": {"_eq": workspace_id.to_string()}, "project_id": {"_eq": project_id.to_string()}},
                       "order_by": [{"field": "decided_at", "direction": "desc"}]}),
            )
            .await?;
        Ok(rows.iter().map(decision_row).collect())
    }
}

#[async_trait::async_trait]
impl crate::model_sweep::TenantMover for ReviewStore {
    fn name(&self) -> &str {
        "studio-documents reviews"
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> Result<()> {
        self.model(ctx, tenant).await.map(|_| ())
    }
}
