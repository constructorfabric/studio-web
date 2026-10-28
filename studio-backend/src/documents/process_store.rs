//! Where the process catalogue's own entries are kept — chosen by
//! configuration, not by the code that reads them (ADR-0051).
//!
//! The catalogue is the built-in stages and capabilities (in code) overlaid
//! with what an organization or a workspace defines, overrides or hides. Those
//! entries used to be rows in `studio_process_stages` and
//! `studio_process_capabilities`. With the `model` strategy they are domain
//! objects instead — `lifecycle-stage` and `capability`, scoped to the tenant
//! that owns them — so the domain query reads them, the model admin can extend
//! them, and the portal edits them through the one write. `tables` keeps the
//! rows, for a deployment that runs without the domain model.
//!
//! Moving is lazy and safe to repeat: the first read of an owner under
//! `model` copies that owner's rows into the model and then deletes them, so
//! an interrupted move re-copies (the same key upserts) rather than losing or
//! doubling anything.
//!
//! Both strategies hand the service the same row shapes
//! ([`stage::Model`], [`capability::Model`]), so the overlay, the ordering
//! and the stage gate do not know which one ran.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::entity::{capability, stage};
use super::repo::{DocumentsRepo, capability_row_id, stage_row_id};
use crate::domain_model::port::{DomainObjects, StoredObject, TypeNeed};

/// The configured strategy (`gears.studio-documents.config.storage.process`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStorage {
    /// Domain objects (the default): what this ADR moves the catalogue to.
    #[default]
    Model,
    /// The gear's own tables, as before.
    Tables,
}

const STAGE_TYPE: &str = "lifecycle-stage";
const CAPABILITY_TYPE: &str = "capability";

fn stage_need() -> TypeNeed {
    let f = |n: &str, t: &str, d: &str| (n.to_string(), t.to_string(), d.to_string());
    TypeNeed {
        id: STAGE_TYPE.to_string(),
        name: "Lifecycle Stage".to_string(),
        extends: Some("record".to_string()),
        bucket: Some("kit-management".to_string()),
        fields: vec![
            f("key", "string", "The stage's key in the process catalogue"),
            f("required", "boolean", "A project is incomplete without it"),
            f(
                "requires",
                "string[]",
                "Document-type keys the stage requires",
            ),
            f(
                "gates",
                "string[]",
                "Detectors every required document must pass",
            ),
            f(
                "checks",
                "string[]",
                "Checks beyond documents: code, tests, review",
            ),
            f(
                "hidden",
                "boolean",
                "Hides the entry of the same key from the level above",
            ),
        ],
        ..Default::default()
    }
}

fn capability_need() -> TypeNeed {
    let f = |n: &str, t: &str, d: &str| (n.to_string(), t.to_string(), d.to_string());
    TypeNeed {
        id: CAPABILITY_TYPE.to_string(),
        name: "Capability".to_string(),
        description:
            "Something a product can need, in the vocabulary its specs are mapped to gears with."
                .to_string(),
        extends: Some("record".to_string()),
        bucket: Some("kit-management".to_string()),
        fields: vec![
            f("key", "string", "The capability's key"),
            f("name", "string", "What people call it"),
            f("terms", "string[]", "Words a spec uses for it"),
            f(
                "contracts",
                "string[]",
                "Contracts a gear has to fill to provide it",
            ),
            f(
                "nonfunctional",
                "boolean",
                "Answered by the deployment profile, never by gears",
            ),
            f(
                "hidden",
                "boolean",
                "Hides the entry of the same key from the level above",
            ),
        ],
        relations: Vec::new(),
        held_by: None,
        searchable: false,
    }
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn stage_payload(row: &stage::Model) -> Result<Value> {
    let list =
        |s: &str| -> Result<Value> { Ok(serde_json::from_str::<Value>(s).unwrap_or(json!([]))) };
    Ok(json!({
        "key": row.key,
        "name": row.label,
        "ordinal": row.ordinal,
        "required": row.required,
        "requires": list(&row.requires)?,
        "gates": list(&row.gates)?,
        "checks": list(&row.checks)?,
        "hidden": row.hidden,
        "tenant_id": row.tenant_id.to_string(),
        "updated_at": now(),
    }))
}

fn stage_row(owner: Uuid, o: &StoredObject) -> stage::Model {
    let v = &o.payload;
    let key = text(v, "key");
    let at = OffsetDateTime::now_utc();
    stage::Model {
        id: stage_row_id(owner, &key),
        tenant_id: owner,
        label: text(v, "name"),
        required: flag(v, "required"),
        ordinal: v
            .get("ordinal")
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok())
            .unwrap_or_default(),
        requires: serde_json::to_string(&strings(v, "requires")).unwrap_or_else(|_| "[]".into()),
        gates: serde_json::to_string(&strings(v, "gates")).unwrap_or_else(|_| "[]".into()),
        checks: serde_json::to_string(&strings(v, "checks")).unwrap_or_else(|_| "[]".into()),
        hidden: flag(v, "hidden"),
        key,
        created_at: at,
        updated_at: at,
    }
}

fn capability_payload(row: &capability::Model) -> Value {
    let list = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(json!([]));
    json!({
        "key": row.key,
        "name": row.label,
        "terms": list(&row.terms),
        "contracts": list(&row.contracts),
        "nonfunctional": row.nonfunctional,
        "hidden": row.hidden,
        "tenant_id": row.tenant_id.to_string(),
        "updated_at": now(),
    })
}

fn capability_row(owner: Uuid, o: &StoredObject) -> capability::Model {
    let v = &o.payload;
    let key = text(v, "key");
    let at = OffsetDateTime::now_utc();
    capability::Model {
        id: capability_row_id(owner, &key),
        tenant_id: owner,
        label: text(v, "name"),
        terms: serde_json::to_string(&strings(v, "terms")).unwrap_or_else(|_| "[]".into()),
        contracts: serde_json::to_string(&strings(v, "contracts")).unwrap_or_else(|_| "[]".into()),
        nonfunctional: flag(v, "nonfunctional"),
        hidden: flag(v, "hidden"),
        key,
        created_at: at,
        updated_at: at,
    }
}

/// The catalogue's entries, kept where the configuration says.
pub struct ProcessStore {
    repo: Arc<DocumentsRepo>,
    storage: ProcessStorage,
    /// Where the domain model's port is found.
    port: PortSource,
    /// Owners whose rows have moved in this process, per kind, so a read does
    /// not ask the tables again.
    moved: Mutex<HashSet<(&'static str, Uuid)>>,
    /// Tenants whose model has been given the two types, this process.
    typed: Mutex<HashSet<Uuid>>,
}

/// The domain model's port: looked up on the hub when used, because it is
/// registered in that gear's REST phase, after this gear's `init` built the
/// service; or handed in, in a test.
enum PortSource {
    None,
    Hub(Arc<toolkit::client_hub::ClientHub>),
    #[cfg(test)]
    Fixed(Arc<dyn DomainObjects>),
}

impl ProcessStore {
    pub fn new(
        repo: Arc<DocumentsRepo>,
        storage: ProcessStorage,
        hub: Option<Arc<toolkit::client_hub::ClientHub>>,
    ) -> Self {
        Self {
            repo,
            storage,
            port: hub.map_or(PortSource::None, PortSource::Hub),
            moved: Mutex::new(HashSet::new()),
            typed: Mutex::new(HashSet::new()),
        }
    }

    /// The model's port when the strategy is `model` and the port is there.
    /// Without it the tables answer, said once per call site in the log.
    fn model(&self) -> Option<Arc<dyn DomainObjects>> {
        if self.storage != ProcessStorage::Model {
            return None;
        }
        let port = match &self.port {
            PortSource::None => None,
            PortSource::Hub(hub) => hub.get::<dyn DomainObjects>().ok(),
            #[cfg(test)]
            PortSource::Fixed(port) => Some(Arc::clone(port)),
        };
        match port {
            Some(port) => Some(port),
            None => {
                warn!(
                    "studio-documents: process storage is `model` but the domain model is not available — using the tables"
                );
                None
            }
        }
    }

    async fn ensure_types(&self, ctx: &SecurityContext, port: &dyn DomainObjects) -> Result<()> {
        let tenant = ctx.subject_tenant_id();
        if self
            .typed
            .lock()
            .map(|t| t.contains(&tenant))
            .unwrap_or(false)
        {
            return Ok(());
        }
        port.ensure_type(ctx, &stage_need()).await?;
        port.ensure_type(ctx, &capability_need()).await?;
        if let Ok(mut t) = self.typed.lock() {
            t.insert(tenant);
        }
        Ok(())
    }

    fn has_moved(&self, kind: &'static str, owner: Uuid) -> bool {
        self.moved
            .lock()
            .map(|m| m.contains(&(kind, owner)))
            .unwrap_or(false)
    }

    fn mark_moved(&self, kind: &'static str, owner: Uuid) {
        if let Ok(mut m) = self.moved.lock() {
            m.insert((kind, owner));
        }
    }

    /// Copy an owner's stage rows into the model, then delete them.
    async fn move_stages(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        owner: Uuid,
    ) -> Result<()> {
        if self.has_moved(STAGE_TYPE, owner) {
            return Ok(());
        }
        let rows = self.repo.list_stages(&[owner]).await?;
        for row in &rows {
            port.upsert_in(
                ctx,
                STAGE_TYPE,
                &row.key,
                &owner.to_string(),
                stage_payload(row)?,
            )
            .await
            .with_context(|| format!("moving stage `{}` into the domain model", row.key))?;
        }
        for row in &rows {
            self.repo.delete_stage(owner, &row.key).await?;
        }
        if !rows.is_empty() {
            info!(owner = %owner, stages = rows.len(), "studio-documents: process stages moved into the domain model");
        }
        self.mark_moved(STAGE_TYPE, owner);
        Ok(())
    }

    async fn move_capabilities(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        owner: Uuid,
    ) -> Result<()> {
        if self.has_moved(CAPABILITY_TYPE, owner) {
            return Ok(());
        }
        let rows = self.repo.list_capabilities(&[owner]).await?;
        for row in &rows {
            port.upsert_in(
                ctx,
                CAPABILITY_TYPE,
                &row.key,
                &owner.to_string(),
                capability_payload(row),
            )
            .await
            .with_context(|| format!("moving capability `{}` into the domain model", row.key))?;
        }
        for row in &rows {
            self.repo.delete_capability(owner, &row.key).await?;
        }
        if !rows.is_empty() {
            info!(owner = %owner, capabilities = rows.len(), "studio-documents: capabilities moved into the domain model");
        }
        self.mark_moved(CAPABILITY_TYPE, owner);
        Ok(())
    }

    /// The caller acting in the organization `owner` belongs to: where the
    /// owner's entries live in the model.
    async fn in_org_of(&self, ctx: &SecurityContext, owner: Uuid) -> SecurityContext {
        let am = match &self.port {
            PortSource::Hub(hub) => hub
                .get::<dyn account_management_sdk::AccountManagementClient>()
                .ok(),
            _ => None,
        };
        match am {
            Some(am) => crate::org_scope::in_org_of(am.as_ref(), ctx, owner).await,
            None => ctx.clone(),
        }
    }

    /// Storage switched back to `tables`: what the model holds for these
    /// owners moves back into the tables and leaves the model. Best effort;
    /// the tables answer meanwhile.
    async fn back_to_tables(&self, ctx: &SecurityContext, owners: &[Uuid]) {
        if self.storage == ProcessStorage::Model {
            return;
        }
        let port = match &self.port {
            PortSource::None => None,
            PortSource::Hub(hub) => hub.get::<dyn DomainObjects>().ok(),
            #[cfg(test)]
            PortSource::Fixed(port) => Some(Arc::clone(port)),
        };
        let Some(port) = port else {
            return;
        };
        for &owner in owners {
            if self.has_moved("back", owner) {
                continue;
            }
            let scope = owner.to_string();
            let ctx = &self.in_org_of(ctx, owner).await;
            let result = async {
                let mut n = 0;
                for o in port.list_in(ctx, STAGE_TYPE, &scope).await? {
                    self.repo.upsert_stage(stage_row(owner, &o)).await?;
                    port.delete(ctx, &o.instance_id).await?;
                    n += 1;
                }
                for o in port.list_in(ctx, CAPABILITY_TYPE, &scope).await? {
                    self.repo
                        .upsert_capability(capability_row(owner, &o))
                        .await?;
                    port.delete(ctx, &o.instance_id).await?;
                    n += 1;
                }
                anyhow::Ok(n)
            }
            .await;
            match result {
                Ok(n) => {
                    if n > 0 {
                        info!(owner = %owner, entries = n, "studio-documents: process entries moved back to the tables");
                    }
                    self.mark_moved("back", owner);
                }
                Err(e) => {
                    warn!(owner = %owner, error = %e, "studio-documents: could not move process entries back yet")
                }
            }
        }
    }

    pub async fn list_stages(
        &self,
        ctx: &SecurityContext,
        owners: &[Uuid],
    ) -> Result<Vec<stage::Model>> {
        let Some(port) = self.model() else {
            self.back_to_tables(ctx, owners).await;
            return self.repo.list_stages(owners).await;
        };
        let org_ctx = match owners.first() {
            Some(o) => self.in_org_of(ctx, *o).await,
            None => ctx.clone(),
        };
        let ctx = &org_ctx;
        self.ensure_types(ctx, port.as_ref()).await?;
        let mut out = Vec::new();
        for owner in owners {
            self.move_stages(ctx, port.as_ref(), *owner).await?;
            for o in port.list_in(ctx, STAGE_TYPE, &owner.to_string()).await? {
                out.push(stage_row(*owner, &o));
            }
        }
        Ok(out)
    }

    pub async fn upsert_stage(&self, ctx: &SecurityContext, row: stage::Model) -> Result<()> {
        let Some(port) = self.model() else {
            return self.repo.upsert_stage(row).await;
        };
        let ctx = &self.in_org_of(ctx, row.tenant_id).await;
        self.ensure_types(ctx, port.as_ref()).await?;
        self.move_stages(ctx, port.as_ref(), row.tenant_id).await?;
        port.upsert_in(
            ctx,
            STAGE_TYPE,
            &row.key,
            &row.tenant_id.to_string(),
            stage_payload(&row)?,
        )
        .await?;
        Ok(())
    }

    pub async fn delete_stage(
        &self,
        ctx: &SecurityContext,
        owner: Uuid,
        key: &str,
    ) -> Result<bool> {
        let Some(port) = self.model() else {
            return self.repo.delete_stage(owner, key).await;
        };
        let ctx = &self.in_org_of(ctx, owner).await;
        self.move_stages(ctx, port.as_ref(), owner).await?;
        self.delete_keyed(ctx, port.as_ref(), STAGE_TYPE, owner, key)
            .await
    }

    pub async fn list_capabilities(
        &self,
        ctx: &SecurityContext,
        owners: &[Uuid],
    ) -> Result<Vec<capability::Model>> {
        let Some(port) = self.model() else {
            self.back_to_tables(ctx, owners).await;
            return self.repo.list_capabilities(owners).await;
        };
        let org_ctx = match owners.first() {
            Some(o) => self.in_org_of(ctx, *o).await,
            None => ctx.clone(),
        };
        let ctx = &org_ctx;
        self.ensure_types(ctx, port.as_ref()).await?;
        let mut out = Vec::new();
        for owner in owners {
            self.move_capabilities(ctx, port.as_ref(), *owner).await?;
            for o in port
                .list_in(ctx, CAPABILITY_TYPE, &owner.to_string())
                .await?
            {
                out.push(capability_row(*owner, &o));
            }
        }
        Ok(out)
    }

    pub async fn upsert_capability(
        &self,
        ctx: &SecurityContext,
        row: capability::Model,
    ) -> Result<()> {
        let Some(port) = self.model() else {
            return self.repo.upsert_capability(row).await;
        };
        let ctx = &self.in_org_of(ctx, row.tenant_id).await;
        self.ensure_types(ctx, port.as_ref()).await?;
        self.move_capabilities(ctx, port.as_ref(), row.tenant_id)
            .await?;
        port.upsert_in(
            ctx,
            CAPABILITY_TYPE,
            &row.key,
            &row.tenant_id.to_string(),
            capability_payload(&row),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_capability(
        &self,
        ctx: &SecurityContext,
        owner: Uuid,
        key: &str,
    ) -> Result<bool> {
        let Some(port) = self.model() else {
            return self.repo.delete_capability(owner, key).await;
        };
        let ctx = &self.in_org_of(ctx, owner).await;
        self.move_capabilities(ctx, port.as_ref(), owner).await?;
        self.delete_keyed(ctx, port.as_ref(), CAPABILITY_TYPE, owner, key)
            .await
    }

    /// Delete the owner's own object of `kind` for `key`, answering whether
    /// there was one — the level above then shows through again.
    async fn delete_keyed(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        kind: &str,
        owner: Uuid,
        key: &str,
    ) -> Result<bool> {
        let found = port
            .list_in(ctx, kind, &owner.to_string())
            .await?
            .into_iter()
            .find(|o| o.payload.get("key").and_then(Value::as_str) == Some(key));
        match found {
            Some(o) => {
                port.delete(ctx, &o.instance_id).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

#[cfg(test)]
#[path = "process_store_tests.rs"]
mod tests;

#[async_trait::async_trait]
impl crate::model_sweep::TenantMover for ProcessStore {
    fn name(&self) -> &str {
        "studio-documents process"
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> Result<()> {
        self.list_stages(ctx, &[tenant]).await?;
        self.list_capabilities(ctx, &[tenant]).await?;
        Ok(())
    }
}
