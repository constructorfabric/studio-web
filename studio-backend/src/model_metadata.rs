//! Tenant documents a gear keeps, held as domain objects (ADR-0051 §8a).
//!
//! Several gears keep their records as one account-management metadata row
//! per tenant: an organization's environments, a project's kit installations,
//! the price list. Each such row is a list (or a map) of records plus a few
//! settings. [`wrap`] puts a client in front of account-management that keeps
//! the configured rows in the domain model instead: every record of the list
//! is an object of its own model type, so the domain query reads them and the
//! graph relates them, and the settings and the version sit on one
//! `tenant-document` object. The gear keeps calling `get_metadata` and
//! `upsert_metadata` and does not know which store answered.
//!
//! * **Moving.** The first read of a tenant's row copies it from
//!   account-management, with its version, and drops the row there, so it is
//!   not kept twice; a caller who may not drop it leaves it marked for the
//!   next writer. A deleted document keeps its `tenant-document` marked
//!   deleted, so the old row is not copied back.
//! * **Versions.** `expected_version` is checked against the model's version
//!   and refused with 409 `METADATA_VERSION_MISMATCH`, as account-management
//!   does. The check and the write are two steps, not one transaction.
//! * **Kept by the gear.** Every type is `held_by` its gear: the generic
//!   object writes refuse them, so only the gear's own rules change them.
//! * **Inheritance.** `resolve_metadata` walks the tenant and its ancestors,
//!   as account-management does.
//!
//! Rows of a type not configured here, and every other call, go to
//! account-management unchanged.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    UpdateTenantRequest, UpsertMetadataRequest,
};
use async_trait::async_trait;
use gts::GtsTypeId;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use toolkit::client_hub::ClientHub;
use toolkit_canonical_errors::{CanonicalError, resource_error};
use toolkit_odata::{ODataQuery, Page};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use crate::domain_model::port::{DomainObjects, OwnedObject, StoredObject, TypeNeed};

#[resource_error(gts_id!("cf.studio._.tenant_document.v1~"))]
pub struct StudioTenantDocumentError;

/// Where a gear's tenant documents live
/// (`gears.<gear>.config.storage.metadata`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataStorage {
    /// Domain objects (the default).
    #[default]
    Model,
    /// The account-management metadata row.
    Metadata,
}

/// One list (or map) inside a document, and the model type its records
/// become.
#[derive(Debug)]
pub struct Part {
    /// The document's field that holds the records.
    pub field: &'static str,
    pub entity: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// The record fields that identify it in the list; empty for a map,
    /// whose key does.
    pub key: &'static [&'static str],
}

/// A document kept in the model: its metadata type and its parts. Every
/// other field of the document is a setting, kept on its `tenant-document`.
#[derive(Debug)]
pub struct Kind {
    pub type_id: &'static str,
    /// The gear that keeps it, and so writes it.
    pub gear: &'static str,
    pub parts: &'static [Part],
}

const HEADER: &str = "tenant-document";
const TENANT: &str = "doc_tenant_id";
const POSITION: &str = "doc_position";
const KEY: &str = "doc_key";
/// A version claimed this long ago and never written was left by a writer
/// that died: the next writer takes it over.
const CLAIM_TTL: time::Duration = time::Duration::seconds(30);
/// How many released or abandoned versions a writer skips before it gives up.
const CLAIM_SKIPS: i64 = 8;
/// Namespace for a document's object id: v5 of its metadata type.
const DOC_NS: Uuid = Uuid::from_u128(0x6a1c_02e7_3b58_4f9d_8e41_c27b_95d0_3a16);

/// `inner`, with `kinds` kept in the domain model when `storage` says so.
pub fn wrap(
    inner: Arc<dyn AccountManagementClient>,
    hub: Arc<ClientHub>,
    storage: MetadataStorage,
    kinds: &'static [Kind],
) -> Arc<dyn AccountManagementClient> {
    build(inner, hub, storage, kinds)
}

fn build(
    inner: Arc<dyn AccountManagementClient>,
    hub: Arc<ClientHub>,
    storage: MetadataStorage,
    kinds: &'static [Kind],
) -> Arc<ModelMetadata> {
    Arc::new(ModelMetadata {
        inner,
        port: PortSource::Hub(hub),
        kinds,
        typed: Mutex::default(),
        // `metadata`: account-management keeps the documents, and what the
        // model still holds of them goes back there on first touch.
        returning: storage == MetadataStorage::Metadata,
        returned: Mutex::default(),
    })
}

enum PortSource {
    Hub(Arc<ClientHub>),
    #[cfg(test)]
    Fixed(Arc<dyn DomainObjects>),
}

pub struct ModelMetadata {
    inner: Arc<dyn AccountManagementClient>,
    port: PortSource,
    kinds: &'static [Kind],
    /// `(tenant, entity|fields)` whose type is known to carry those fields.
    typed: Mutex<HashSet<(Uuid, String)>>,
    /// The strategy is `metadata`: documents live in account-management,
    /// and the model's copies move back.
    returning: bool,
    /// `(tenant, type)` already moved back, in this process.
    returned: Mutex<HashSet<(Uuid, &'static str)>>,
}

fn internal(e: &anyhow::Error) -> CanonicalError {
    if crate::domain_model::port::is_refusal(e) {
        return StudioTenantDocumentError::permission_denied()
            .with_reason("DOMAIN_OBJECT_ACCESS_DENIED")
            .create();
    }
    CanonicalError::internal(format!("tenant document in the domain model: {e:#}")).create()
}

fn not_found(type_id: &str, tenant: Uuid) -> CanonicalError {
    StudioTenantDocumentError::not_found(format!("no {type_id} on tenant {tenant}"))
        .with_resource(type_id.to_owned())
        .create()
}

fn header_id(tenant: Uuid, type_id: &str) -> String {
    format!(
        "{HEADER}:{tenant}:{}",
        Uuid::new_v5(&DOC_NS, type_id.as_bytes())
    )
}

fn item_id(entity: &str, tenant: Uuid, key: &str) -> String {
    format!("{entity}:{tenant}:{key}")
}

/// The record's key in its list: its key fields, joined.
fn key_of(record: &Value, part: &Part, position: usize) -> String {
    let parts: Vec<String> = part
        .key
        .iter()
        .map(|f| match record.get(*f) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => "-".to_owned(),
            Some(other) => other.to_string(),
        })
        .collect();
    if parts.iter().all(|p| p == "-") {
        position.to_string()
    } else {
        parts.join("|")
    }
}

/// The model type a value's JSON implies: optional, since a later record
/// may leave it out.
fn type_of(v: &Value) -> &'static str {
    match v {
        Value::String(_) => "string?",
        Value::Number(_) => "number?",
        Value::Bool(_) => "boolean?",
        _ => "JSON?",
    }
}

fn need(
    entity: &str,
    name: &str,
    description: &str,
    gear: &str,
    fields: Vec<(String, String)>,
) -> TypeNeed {
    TypeNeed {
        id: entity.to_owned(),
        name: name.to_owned(),
        description: description.to_owned(),
        extends: Some("record".to_owned()),
        bucket: Some("operations".to_owned()),
        fields: fields
            .into_iter()
            .map(|(n, t)| (n, t, String::new()))
            .collect(),
        relations: Vec::new(),
        held_by: Some(gear.to_owned()),
        searchable: false,
    }
}

fn header_need() -> TypeNeed {
    need(
        HEADER,
        "Tenant Document",
        "The settings and version of a gear's document on one tenant.",
        "studio-backend",
        vec![
            ("type_id".into(), "string".into()),
            (TENANT.into(), "string".into()),
            ("version".into(), "integer".into()),
            ("deleted".into(), "boolean?".into()),
            ("legacy".into(), "boolean?".into()),
            ("settings".into(), "JSON?".into()),
            ("updated_at".into(), "timestamp".into()),
        ],
    )
}

/// A document as the model keeps it: its settings, and its records by part.
struct Split {
    settings: Map<String, Value>,
    parts: Vec<Vec<(String, Value)>>,
}

impl ModelMetadata {
    #[cfg(test)]
    pub fn with_port(
        inner: Arc<dyn AccountManagementClient>,
        port: Arc<dyn DomainObjects>,
        kinds: &'static [Kind],
    ) -> Self {
        Self {
            inner,
            port: PortSource::Fixed(port),
            kinds,
            typed: Mutex::default(),
            returning: false,
            returned: Mutex::default(),
        }
    }

    #[cfg(test)]
    pub fn returning_with_port(
        inner: Arc<dyn AccountManagementClient>,
        port: Arc<dyn DomainObjects>,
        kinds: &'static [Kind],
    ) -> Self {
        Self {
            returning: true,
            ..Self::with_port(inner, port, kinds)
        }
    }

    /// The strategy went back to `metadata`: a document the model holds is
    /// written to account-management again and leaves the model, so the
    /// switch is never one-way and nothing is kept twice. Best effort — a
    /// caller account-management refuses leaves it for the gear's own next
    /// write; account-management answers meanwhile.
    async fn back_to_am(&self, ctx: &SecurityContext, tenant: Uuid, kind: &'static Kind) {
        let ctx = &self.in_org_of(ctx, tenant).await;
        if self
            .returned
            .lock()
            .map(|r| r.contains(&(tenant, kind.type_id)))
            .unwrap_or(true)
        {
            return;
        }
        let Some(port) = self.port() else {
            return;
        };
        let port = port.as_ref();
        let result = async {
            let Some(entry) = self.read(ctx, port, tenant, kind).await? else {
                return anyhow::Ok(false);
            };
            self.inner
                .upsert_metadata(
                    ctx,
                    tenant,
                    UpsertMetadataRequest::new(GtsTypeId::new(kind.type_id), entry.value),
                )
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            for part in kind.parts {
                let (items, _) = port
                    .query(
                        ctx,
                        json!({"type": part.entity, "where": {"doc_tenant_id": {"_eq": tenant}}, "fields": [KEY]}),
                    )
                    .await?;
                let ids: Vec<String> = items.into_iter().map(|o| o.instance_id).collect();
                if !ids.is_empty() {
                    port.remove_objects(ctx, part.entity, ids).await?;
                }
            }
            if let Some(mut header) = self.header(ctx, port, tenant, kind.type_id).await? {
                header["deleted"] = Value::Bool(true);
                header["returned"] = Value::Bool(true);
                if let Some(m) = header.as_object_mut() {
                    m.remove("_scope");
                }
                port.put_objects(
                    ctx,
                    HEADER,
                    vec![OwnedObject {
                        id: header_id(tenant, kind.type_id),
                        scope: tenant.to_string(),
                        payload: header,
                    }],
                )
                .await?;
            }
            anyhow::Ok(true)
        }
        .await;
        match result {
            Ok(moved) => {
                if moved {
                    info!(type_id = kind.type_id, tenant = %tenant, "tenant document moved back to account-management");
                }
                if let Ok(mut r) = self.returned.lock() {
                    r.insert((tenant, kind.type_id));
                }
            }
            Err(e) => {
                warn!(type_id = kind.type_id, tenant = %tenant, error = %e, "a tenant document could not move back yet")
            }
        }
    }

    /// The caller acting in the organization `tenant` belongs to: where its
    /// documents live in the model.
    async fn in_org_of(&self, ctx: &SecurityContext, tenant: Uuid) -> SecurityContext {
        crate::org_scope::in_org_of(self.inner.as_ref(), ctx, tenant).await
    }

    fn kind(&self, type_id: &GtsTypeId) -> Option<&'static Kind> {
        self.kinds.iter().find(|k| type_id == k.type_id)
    }

    fn port(&self) -> Option<Arc<dyn DomainObjects>> {
        match &self.port {
            PortSource::Hub(hub) => {
                let port = hub.get::<dyn DomainObjects>().ok();
                if port.is_none() {
                    warn!(
                        "tenant documents are kept in the domain model, but it is not available — using account-management"
                    );
                }
                port
            }
            #[cfg(test)]
            PortSource::Fixed(port) => Some(Arc::clone(port)),
        }
    }

    fn split(kind: &Kind, value: &Value) -> Split {
        let mut settings = value.as_object().cloned().unwrap_or_default();
        let mut parts = Vec::with_capacity(kind.parts.len());
        for part in kind.parts {
            let records = match settings.remove(part.field) {
                Some(Value::Array(items)) => items
                    .into_iter()
                    .enumerate()
                    .map(|(i, r)| (key_of(&r, part, i), r))
                    .collect(),
                Some(Value::Object(map)) => map.into_iter().collect(),
                _ => Vec::new(),
            };
            parts.push(records);
        }
        Split { settings, parts }
    }

    /// Make sure the model has the types and the fields these records use.
    async fn ensure(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        kind: &Kind,
        split: &Split,
    ) -> anyhow::Result<()> {
        let mut needs = vec![header_need()];
        for (part, records) in kind.parts.iter().zip(&split.parts) {
            let mut fields: BTreeMap<String, String> = BTreeMap::new();
            for (_, r) in records {
                if let Some(obj) = r.as_object() {
                    for (k, v) in obj {
                        if !v.is_null() {
                            fields
                                .entry(k.clone())
                                .or_insert_with(|| type_of(v).to_owned());
                        }
                    }
                }
            }
            fields.insert(TENANT.into(), "string".into());
            fields.insert(POSITION.into(), "integer".into());
            fields.insert(KEY.into(), "string".into());
            needs.push(need(
                part.entity,
                part.name,
                part.description,
                kind.gear,
                fields.into_iter().collect(),
            ));
        }
        for n in &needs {
            self.ensure_need(ctx, port, n).await?;
        }
        Ok(())
    }

    /// One type, its fields, once per tenant and field set.
    async fn ensure_need(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        n: &TypeNeed,
    ) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        {
            let mark = format!(
                "{}|{}",
                n.id,
                n.fields
                    .iter()
                    .map(|f| f.0.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            );
            if self
                .typed
                .lock()
                .map(|t| t.contains(&(tenant, mark.clone())))
                .unwrap_or(false)
            {
                return Ok(());
            }
            port.ensure_type(ctx, n).await?;
            if let Ok(mut t) = self.typed.lock() {
                t.insert((tenant, mark));
            }
        }
        Ok(())
    }

    async fn header(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        tenant: Uuid,
        type_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.ensure_need(ctx, port, &header_need()).await?;
        let (found, _) = port
            .query(
                ctx,
                json!({"type": HEADER, "where": {"id": {"_eq": header_id(tenant, type_id)}}, "limit": 1}),
            )
            .await?;
        Ok(found.into_iter().next().map(|o| o.payload))
    }

    /// The document as the model holds it, with its version and time; `None`
    /// when the model has none, or holds it deleted.
    async fn read(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        tenant: Uuid,
        kind: &Kind,
    ) -> anyhow::Result<Option<MetadataEntry>> {
        let Some(header) = self.header(ctx, port, tenant, kind.type_id).await? else {
            return Ok(None);
        };
        if header.get("deleted").and_then(Value::as_bool) == Some(true) {
            return Ok(None);
        }
        let mut doc = header
            .get("settings")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for part in kind.parts {
            let (records, _) = port
                .query(
                    ctx,
                    json!({
                        "type": part.entity,
                        "where": {"doc_tenant_id": {"_eq": tenant}},
                        "order_by": [{"field": POSITION}],
                    }),
                )
                .await?;
            let strip = |o: StoredObject| -> (String, Value) {
                let mut v = o.payload;
                let key = v
                    .get(KEY)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if let Some(m) = v.as_object_mut() {
                    for f in [TENANT, POSITION, KEY, "_scope"] {
                        m.remove(f);
                    }
                }
                (key, v)
            };
            let value = if part.key.is_empty() {
                Value::Object(records.into_iter().map(strip).collect())
            } else {
                Value::Array(records.into_iter().map(|o| strip(o).1).collect())
            };
            doc.insert(part.field.to_owned(), value);
        }
        let version = header.get("version").and_then(Value::as_i64).unwrap_or(1);
        let at = header
            .get("updated_at")
            .and_then(Value::as_str)
            .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
            .unwrap_or_else(OffsetDateTime::now_utc);
        Ok(Some(MetadataEntry::new(
            GtsTypeId::new(kind.type_id),
            Value::Object(doc),
            at,
            version,
        )))
    }

    /// Replace the document in the model: its records, then its header.
    #[allow(clippy::too_many_arguments)]
    async fn write(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        tenant: Uuid,
        kind: &Kind,
        value: &Value,
        version: i64,
        legacy: bool,
    ) -> anyhow::Result<MetadataEntry> {
        let split = Self::split(kind, value);
        self.ensure(ctx, port, kind, &split).await?;
        for (part, records) in kind.parts.iter().zip(&split.parts) {
            let keep: HashSet<String> = records
                .iter()
                .map(|(k, _)| item_id(part.entity, tenant, k))
                .collect();
            let (existing, _) = port
                .query(
                    ctx,
                    json!({"type": part.entity, "where": {"doc_tenant_id": {"_eq": tenant}}, "fields": [KEY]}),
                )
                .await?;
            let gone: Vec<String> = existing
                .into_iter()
                .map(|o| o.instance_id)
                .filter(|id| !keep.contains(id))
                .collect();
            if !gone.is_empty() {
                port.remove_objects(ctx, part.entity, gone).await?;
            }
            let objects: Vec<OwnedObject> = records
                .iter()
                .enumerate()
                .map(|(i, (key, r))| {
                    let mut payload = r.clone();
                    if let Some(m) = payload.as_object_mut() {
                        m.insert(TENANT.into(), json!(tenant));
                        m.insert(POSITION.into(), json!(i));
                        m.insert(KEY.into(), json!(key));
                    }
                    OwnedObject {
                        id: item_id(part.entity, tenant, key),
                        scope: tenant.to_string(),
                        payload,
                    }
                })
                .collect();
            for chunk in objects.chunks(500) {
                port.put_objects(ctx, part.entity, chunk.to_vec()).await?;
            }
        }
        let at = OffsetDateTime::now_utc();
        port.put_objects(
            ctx,
            HEADER,
            vec![OwnedObject {
                id: header_id(tenant, kind.type_id),
                scope: tenant.to_string(),
                payload: json!({
                    "name": kind.type_id,
                    "type_id": kind.type_id,
                    "doc_tenant_id": tenant,
                    "version": version,
                    "deleted": false,
                    // Account-management still holds the row it was moved
                    // from: dropped by the next writer who may.
                    "legacy": legacy,
                    "settings": Value::Object(split.settings),
                    "updated_at": at.format(&Rfc3339).unwrap_or_default(),
                }),
            }],
        )
        .await?;
        Ok(MetadataEntry::new(
            GtsTypeId::new(kind.type_id),
            value.clone(),
            at,
            version,
        ))
    }

    fn claim_id(tenant: Uuid, kind: &Kind, version: i64) -> String {
        format!("{}#v{version}", header_id(tenant, kind.type_id))
    }

    /// Claim the document's next version, after `live`: the version claimed,
    /// or `None` when another writer holds it. A claim is a node created only
    /// once, so of two writers on any replica one gets it. A graph node is
    /// never truly deleted, so a claim that was released (its write failed)
    /// or abandoned (older than [`CLAIM_TTL`]) is not taken back but skipped:
    /// the next version is claimed instead. Versions only ever rise.
    async fn claim_version(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        tenant: Uuid,
        kind: &Kind,
        live: i64,
    ) -> Result<Option<i64>, CanonicalError> {
        let at = OffsetDateTime::now_utc();
        let payload = json!({
            "status": "claimed",
            "message": kind.type_id,
            "updated_at": at.format(&Rfc3339).unwrap_or_default(),
        });
        for version in (live + 1)..=(live + CLAIM_SKIPS) {
            let id = Self::claim_id(tenant, kind, version);
            if port
                .claim(ctx, "sync-state", &id, payload.clone())
                .await
                .map_err(|e| internal(&e))?
            {
                return Ok(Some(version));
            }
            let (found, _) = port
                .query(
                    ctx,
                    json!({"type": "sync-state", "where": {"id": {"_eq": id}}, "limit": 1}),
                )
                .await
                .map_err(|e| internal(&e))?;
            let Some(held) = found.first().map(|o| &o.payload) else {
                return Ok(None);
            };
            let released = held.get("status").and_then(Value::as_str) == Some("released");
            let abandoned = held
                .get("updated_at")
                .and_then(Value::as_str)
                .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
                .is_some_and(|t| at - t > CLAIM_TTL);
            if !(released || abandoned) {
                return Ok(None);
            }
        }
        Ok(None)
    }

    /// Mark a claim whose write failed, so the next writer skips past it.
    async fn release(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        tenant: Uuid,
        kind: &Kind,
        version: i64,
    ) {
        if let Err(e) = port
            .put_objects(
                ctx,
                "sync-state",
                vec![OwnedObject {
                    id: Self::claim_id(tenant, kind, version),
                    scope: String::new(),
                    payload: json!({"status": "released", "message": kind.type_id}),
                }],
            )
            .await
        {
            warn!(type_id = kind.type_id, error = %e, "a version claim could not be released");
        }
    }

    /// Drop the account-management row a document was moved from, so it is
    /// not kept twice. Refused (the caller may read the row but not delete
    /// it), the row stays marked on the document and the next writer tries.
    async fn drop_legacy(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        tenant: Uuid,
        kind: &Kind,
    ) {
        match self
            .inner
            .delete_metadata(ctx, tenant, GtsTypeId::new(kind.type_id))
            .await
        {
            Ok(()) | Err(CanonicalError::NotFound { .. }) => {}
            Err(e) => {
                warn!(type_id = kind.type_id, tenant = %tenant, error = %e, "the account-management copy stays until a writer who may drops it");
                return;
            }
        }
        let Ok(Some(mut header)) = self.header(ctx, port, tenant, kind.type_id).await else {
            return;
        };
        header["legacy"] = Value::Bool(false);
        if let Some(m) = header.as_object_mut() {
            m.remove("_scope");
        }
        if let Err(e) = port
            .put_objects(
                ctx,
                HEADER,
                vec![OwnedObject {
                    id: header_id(tenant, kind.type_id),
                    scope: tenant.to_string(),
                    payload: header,
                }],
            )
            .await
        {
            warn!(type_id = kind.type_id, error = %e, "could not record that the account-management copy is gone");
        }
    }

    /// The model's copy of the document, after moving account-management's
    /// row into it if the model has never held one.
    async fn moved(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        tenant: Uuid,
        kind: &Kind,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        if self
            .header(ctx, port, tenant, kind.type_id)
            .await
            .map_err(|e| internal(&e))?
            // A document that went back to account-management moves in again.
            .is_some_and(|h| h.get("returned").and_then(Value::as_bool) != Some(true))
        {
            return self
                .read(ctx, port, tenant, kind)
                .await
                .map_err(|e| internal(&e));
        }
        match self
            .inner
            .get_metadata(ctx, tenant, GtsTypeId::new(kind.type_id))
            .await
        {
            Ok(entry) => {
                let written = self
                    .write(ctx, port, tenant, kind, &entry.value, entry.version, true)
                    .await
                    .map_err(|e| internal(&e))?;
                info!(type_id = kind.type_id, tenant = %tenant, "tenant document moved into the domain model");
                self.drop_legacy(ctx, port, tenant, kind).await;
                Ok(Some(written))
            }
            Err(CanonicalError::NotFound { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[async_trait]
impl AccountManagementClient for ModelMetadata {
    async fn get_metadata(
        &self,
        ctx: &SecurityContext,
        tenant_id: Uuid,
        type_id: GtsTypeId,
    ) -> Result<MetadataEntry, CanonicalError> {
        if self.returning {
            if let Some(kind) = self.kind(&type_id) {
                self.back_to_am(ctx, tenant_id, kind).await;
            }
            return self.inner.get_metadata(ctx, tenant_id, type_id).await;
        }
        let (Some(kind), Some(port)) = (self.kind(&type_id), self.port()) else {
            return self.inner.get_metadata(ctx, tenant_id, type_id).await;
        };
        let ctx = &self.in_org_of(ctx, tenant_id).await;
        self.moved(ctx, port.as_ref(), tenant_id, kind)
            .await?
            .ok_or_else(|| not_found(kind.type_id, tenant_id))
    }

    async fn resolve_metadata(
        &self,
        ctx: &SecurityContext,
        tenant_id: Uuid,
        type_id: GtsTypeId,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        if self.returning {
            if let Some(kind) = self.kind(&type_id) {
                // The tenant and every ancestor: what it inherits moves back too.
                let mut at = Some(tenant_id);
                let mut seen = HashSet::new();
                while let Some(tenant) = at.filter(|t| seen.insert(*t)) {
                    self.back_to_am(ctx, tenant, kind).await;
                    at = match self.inner.get_tenant(ctx, tenant).await {
                        Ok(t) => t.parent_id.map(|p| p.0),
                        Err(_) => None,
                    };
                }
            }
            return self.inner.resolve_metadata(ctx, tenant_id, type_id).await;
        }
        let (Some(kind), Some(port)) = (self.kind(&type_id), self.port()) else {
            return self.inner.resolve_metadata(ctx, tenant_id, type_id).await;
        };
        let mut at = Some(tenant_id);
        let mut seen = HashSet::new();
        while let Some(tenant) = at.filter(|t| seen.insert(*t)) {
            let ctx = &self.in_org_of(ctx, tenant).await;
            if let Some(entry) = self.moved(ctx, port.as_ref(), tenant, kind).await? {
                return Ok(Some(entry));
            }
            at = match self.inner.get_tenant(ctx, tenant).await {
                Ok(t) => t.parent_id.map(|p| p.0),
                Err(_) => None,
            };
        }
        Ok(None)
    }

    async fn list_metadata(
        &self,
        ctx: &SecurityContext,
        tenant_id: Uuid,
        query: &ODataQuery,
    ) -> Result<Page<MetadataEntry>, CanonicalError> {
        self.inner.list_metadata(ctx, tenant_id, query).await
    }

    async fn upsert_metadata(
        &self,
        ctx: &SecurityContext,
        tenant_id: Uuid,
        input: UpsertMetadataRequest,
    ) -> Result<MetadataEntry, CanonicalError> {
        if self.returning {
            if let Some(kind) = self.kind(&input.type_id) {
                self.back_to_am(ctx, tenant_id, kind).await;
            }
            return self.inner.upsert_metadata(ctx, tenant_id, input).await;
        }
        let (Some(kind), Some(port)) = (self.kind(&input.type_id), self.port()) else {
            return self.inner.upsert_metadata(ctx, tenant_id, input).await;
        };
        let ctx = &self.in_org_of(ctx, tenant_id).await;
        let current = self.moved(ctx, port.as_ref(), tenant_id, kind).await?;
        let (version, legacy) = match self
            .header(ctx, port.as_ref(), tenant_id, kind.type_id)
            .await
        {
            Ok(Some(h)) => (
                h.get("version").and_then(Value::as_i64).unwrap_or(0),
                h.get("legacy").and_then(Value::as_bool).unwrap_or(false),
            ),
            Ok(None) => (0, false),
            Err(e) => return Err(internal(&e)),
        };
        let live = if current.is_some() { version } else { 0 };
        if let Some(expected) = input.expected_version
            && expected != live
        {
            return Err(StudioTenantDocumentError::aborted(format!(
                "{} on tenant {tenant_id} is at version {live}, not {expected}",
                kind.type_id
            ))
            .with_reason("METADATA_VERSION_MISMATCH")
            .create());
        }
        // The next version is claimed before it is written: of two writers
        // on any replica, one gets it and the other is told, as
        // account-management's own version check would.
        let Some(next) = self
            .claim_version(ctx, port.as_ref(), tenant_id, kind, version)
            .await?
        else {
            return Err(StudioTenantDocumentError::aborted(format!(
                "{} on tenant {tenant_id} changed while it was written (past version {version})",
                kind.type_id
            ))
            .with_reason("METADATA_VERSION_MISMATCH")
            .create());
        };
        let written = self
            .write(
                ctx,
                port.as_ref(),
                tenant_id,
                kind,
                &input.value,
                next,
                legacy,
            )
            .await;
        if written.is_err() {
            self.release(ctx, port.as_ref(), tenant_id, kind, next)
                .await;
        }
        if legacy && written.is_ok() {
            self.drop_legacy(ctx, port.as_ref(), tenant_id, kind).await;
        }
        written.map_err(|e| internal(&e))
    }

    async fn delete_metadata(
        &self,
        ctx: &SecurityContext,
        tenant_id: Uuid,
        type_id: GtsTypeId,
    ) -> Result<(), CanonicalError> {
        if self.returning {
            if let Some(kind) = self.kind(&type_id) {
                self.back_to_am(ctx, tenant_id, kind).await;
            }
            return self.inner.delete_metadata(ctx, tenant_id, type_id).await;
        }
        let (Some(kind), Some(port)) = (self.kind(&type_id), self.port()) else {
            return self.inner.delete_metadata(ctx, tenant_id, type_id).await;
        };
        let ctx = &self.in_org_of(ctx, tenant_id).await;
        if self
            .moved(ctx, port.as_ref(), tenant_id, kind)
            .await?
            .is_none()
        {
            return Err(not_found(kind.type_id, tenant_id));
        }
        let version = self
            .header(ctx, port.as_ref(), tenant_id, kind.type_id)
            .await
            .map_err(|e| internal(&e))?
            .and_then(|h| h.get("version").and_then(Value::as_i64))
            .unwrap_or(0);
        // Empty, and marked deleted: the old row is not copied back.
        let empty = Value::Object(Map::new());
        self.write(
            ctx,
            port.as_ref(),
            tenant_id,
            kind,
            &empty,
            version + 1,
            false,
        )
        .await
        .map_err(|e| internal(&e))?;
        let mut header = self
            .header(ctx, port.as_ref(), tenant_id, kind.type_id)
            .await
            .map_err(|e| internal(&e))?
            .unwrap_or_default();
        header["deleted"] = Value::Bool(true);
        if let Some(m) = header.as_object_mut() {
            m.remove("_scope");
        }
        port.put_objects(
            ctx,
            HEADER,
            vec![OwnedObject {
                id: header_id(tenant_id, kind.type_id),
                scope: tenant_id.to_string(),
                payload: header,
            }],
        )
        .await
        .map_err(|e| internal(&e))?;
        Ok(())
    }

    // ── everything else is account-management's ─────────────────────────────

    async fn create_tenant(
        &self,
        ctx: &SecurityContext,
        req: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        self.inner.create_tenant(ctx, req).await
    }
    async fn get_tenant(&self, ctx: &SecurityContext, id: Uuid) -> Result<Tenant, CanonicalError> {
        self.inner.get_tenant(ctx, id).await
    }
    async fn list_children(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
        query: &ODataQuery,
    ) -> Result<Page<Tenant>, CanonicalError> {
        self.inner.list_children(ctx, id, query).await
    }
    async fn update_tenant(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
        req: UpdateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        self.inner.update_tenant(ctx, id, req).await
    }
    async fn suspend_tenant(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
    ) -> Result<Tenant, CanonicalError> {
        self.inner.suspend_tenant(ctx, id).await
    }
    async fn unsuspend_tenant(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
    ) -> Result<Tenant, CanonicalError> {
        self.inner.unsuspend_tenant(ctx, id).await
    }
    async fn delete_tenant(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
    ) -> Result<Tenant, CanonicalError> {
        self.inner.delete_tenant(ctx, id).await
    }
    async fn create_user(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        user: IdpNewUser,
    ) -> Result<IdpUser, CanonicalError> {
        self.inner.create_user(ctx, tenant, user).await
    }
    async fn get_user(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> Result<IdpUser, CanonicalError> {
        self.inner.get_user(ctx, tenant, id).await
    }
    async fn list_users(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        query: ListUsersQuery,
    ) -> Result<Page<IdpUser>, CanonicalError> {
        self.inner.list_users(ctx, tenant, query).await
    }
    async fn delete_user(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> Result<(), CanonicalError> {
        self.inner.delete_user(ctx, tenant, id).await
    }
    async fn update_user(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
        patch: IdpUserPatch,
    ) -> Result<IdpUser, CanonicalError> {
        self.inner.update_user(ctx, tenant, id, patch).await
    }
    async fn create_service_account(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        name: String,
        scopes: Vec<String>,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        self.inner
            .create_service_account(ctx, tenant, name, scopes)
            .await
    }
    async fn list_service_accounts(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> Result<Vec<IdpServiceAccountSummary>, CanonicalError> {
        self.inner.list_service_accounts(ctx, tenant).await
    }
    async fn rotate_service_account_secret(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        client_id: &str,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        self.inner
            .rotate_service_account_secret(ctx, tenant, client_id)
            .await
    }
    async fn revoke_service_account(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        client_id: &str,
    ) -> Result<(), CanonicalError> {
        self.inner
            .revoke_service_account(ctx, tenant, client_id)
            .await
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct GearStorage {
    storage: StorageSection,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct StorageSection {
    metadata: MetadataStorage,
}

/// The account-management client a gear keeping `kinds` uses: `am`, with
/// those documents where the gear's `storage.metadata` setting says.
pub fn client_for(
    ctx: &toolkit::GearCtx,
    am: Arc<dyn AccountManagementClient>,
    kinds: &'static [Kind],
) -> Arc<dyn AccountManagementClient> {
    let storage = storage_of(ctx);
    for kind in kinds {
        crate::data_places::note(
            kind.gear,
            "metadata",
            &crate::data_places::store_name(storage),
        );
        for part in kind.parts {
            crate::data_places::held(kind.gear, part.entity);
        }
    }
    let client = build(am, ctx.client_hub(), storage, kinds);
    crate::model_sweep::register(client.clone());
    client
}

#[async_trait]
impl crate::model_sweep::TenantMover for ModelMetadata {
    fn name(&self) -> &str {
        self.kinds.first().map_or("tenant documents", |k| k.gear)
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        let ctx = &self.in_org_of(ctx, tenant).await;
        for kind in self.kinds {
            if self.returning {
                self.back_to_am(ctx, tenant, kind).await;
            } else if let Some(port) = self.port() {
                self.moved(ctx, port.as_ref(), tenant, kind)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
        }
        Ok(())
    }
}

/// Whether `gear` keeps `kind` of its data in the domain model: its
/// `storage.<kind>` setting, `model` unless it names another store.
pub fn keeps_in_model(ctx: &toolkit::GearCtx, gear: &str, kind: &str) -> bool {
    let store = ctx
        .config_or_default::<AnyStorage>()
        .ok()
        .and_then(|c| {
            c.storage
                .get(kind)
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "model".to_owned());
    crate::data_places::note(gear, kind, &store);
    store == "model"
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct AnyStorage {
    storage: Map<String, Value>,
}

/// The gear's `storage.metadata` setting.
pub fn storage_of(ctx: &toolkit::GearCtx) -> MetadataStorage {
    ctx.config_or_default::<GearStorage>()
        .map(|c| c.storage.metadata)
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "model_metadata_tests.rs"]
mod tests;
