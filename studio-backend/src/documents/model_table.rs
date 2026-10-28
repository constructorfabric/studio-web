//! A table of this gear kept as domain objects (ADR-0051 §8a): one row is one
//! object of a model type, its columns the object's fields.
//!
//! Every documents table that moves into the model goes through here, so the
//! rules are stated once:
//!
//! * **Ids.** A row's object is `"<entity>:<row id>"`, scoped to its project
//!   when it has one and to its owner (workspace or organization) otherwise,
//!   so the PDP narrows it like any other project object.
//! * **Upserts keep what SQL kept.** The tables' `ON CONFLICT` updated named
//!   columns and left the rest (`created_at`, who created it); [`ModelTable::put`]
//!   does the same, given the same names.
//! * **Size.** Graph-storage refuses a payload over 64 KiB. A row whose
//!   payload is larger has its longest fields cut into `record-chunk` objects
//!   (`{"$chunks": n}` stays in the row) and joined again on read, so a long
//!   document is still one object to the gear.
//! * **Moving** is the caller's (`data.rs`): an owner moves whole, and its
//!   rows are then dropped from the tables.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;
use tracing::warn;
use uuid::Uuid;

use crate::domain_model::port::{DomainObjects, OwnedObject, StoredObject, TypeNeed};

/// Where a kind of this gear's rows is kept.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableStorage {
    #[default]
    Model,
    Tables,
}

/// A payload above this many bytes has its longest fields cut into chunks:
/// under graph-storage's 64 KiB, with room for the identifiers.
const PAYLOAD_BUDGET: usize = 56 * 1024;
/// The bytes of text one chunk carries.
const CHUNK_BYTES: usize = 48 * 1024;
const CHUNK_TYPE: &str = "record-chunk";
const CHUNKS: &str = "$chunks";

/// A row of a table that moves into the model.
pub trait TableRow: Serialize + DeserializeOwned + Clone + Send + Sync + 'static {
    /// The model type its rows become.
    const ENTITY: &'static str;
    /// The gear that keeps them.
    const GEAR: &'static str;
    fn row_id(&self) -> Uuid;
    /// The tenant the row belongs to in its table (workspace or organization).
    fn owner(&self) -> Uuid;
    fn project(&self) -> Option<Uuid>;
    /// The type and the fields a query narrows by.
    fn need() -> TypeNeed;
}

pub fn object_id<T: TableRow>(row_id: Uuid) -> String {
    format!("{}:{row_id}", T::ENTITY)
}

/// `(name, type expression)` as a [`TypeNeed`] field.
pub fn field(name: &str, type_expr: &str) -> (String, String, String) {
    (name.to_string(), type_expr.to_string(), String::new())
}

/// The type a table's rows become, under `record`, kept by `gear`: its
/// records change through the gear's rules, never the generic object writes.
pub fn need(
    gear: &str,
    entity: &str,
    name: &str,
    description: &str,
    fields: &[(&str, &str)],
) -> TypeNeed {
    TypeNeed {
        held_by: Some(gear.to_string()),
        searchable: entity == "studio-document",
        id: entity.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        extends: Some("record".to_string()),
        bucket: Some("content".to_string()),
        fields: fields.iter().map(|(n, t)| field(n, t)).collect(),
        relations: Vec::new(),
    }
}

fn chunk_need(gear: &str) -> TypeNeed {
    need(
        gear,
        CHUNK_TYPE,
        "Record Chunk",
        "A slice of a long field of another gear record.",
        &[
            ("owner", "string"),
            ("field", "string"),
            ("ordinal", "integer"),
            ("text", "string"),
        ],
    )
}

/// Cut `s` into pieces of at most `CHUNK_BYTES`, on character boundaries.
fn pieces(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < s.len() {
        let mut end = (at + CHUNK_BYTES).min(s.len());
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        out.push(s[at..end].to_string());
        at = end;
    }
    out
}

/// This gear's rows, kept as model objects.
pub struct ModelTable {
    hub: Option<Arc<toolkit::client_hub::ClientHub>>,
    /// A port handed in directly (tests).
    fixed: Option<Arc<dyn DomainObjects>>,
    storage: TableStorage,
    typed: Mutex<HashSet<(Uuid, &'static str)>>,
    /// Upserts that keep columns read the stored row and write it back; two
    /// at once on one row could each keep what the other changed. In one
    /// process they take turns.
    merging: tokio::sync::Mutex<()>,
}

impl ModelTable {
    pub fn new(storage: TableStorage, hub: Option<Arc<toolkit::client_hub::ClientHub>>) -> Self {
        Self {
            hub,
            fixed: None,
            storage,
            typed: Mutex::default(),
            merging: tokio::sync::Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn with_port(port: Arc<dyn DomainObjects>) -> Self {
        Self::with_port_storing(port, TableStorage::Model)
    }

    #[cfg(test)]
    pub fn with_port_storing(port: Arc<dyn DomainObjects>, storage: TableStorage) -> Self {
        Self {
            fixed: Some(port),
            ..Self::new(storage, None)
        }
    }

    /// The caller acting in the organization `owner` belongs to: where the
    /// owner's records live in the model. Unchanged without account-management.
    pub async fn in_org_of(&self, ctx: &SecurityContext, owner: Uuid) -> SecurityContext {
        let am = self.hub.as_ref().and_then(|h| {
            h.get::<dyn account_management_sdk::AccountManagementClient>()
                .ok()
        });
        match am {
            Some(am) => crate::org_scope::in_org_of(am.as_ref(), ctx, owner).await,
            None => ctx.clone(),
        }
    }

    /// Whether this kind of data is kept in the model.
    pub fn in_model(&self) -> bool {
        self.storage == TableStorage::Model
    }

    /// The model's port whatever the strategy: what moving data back out of
    /// it needs.
    pub fn any_port(&self) -> Option<Arc<dyn DomainObjects>> {
        if let Some(port) = &self.fixed {
            return Some(Arc::clone(port));
        }
        self.hub.as_ref()?.get::<dyn DomainObjects>().ok()
    }

    /// The model's port, when rows are kept there and it is available.
    pub fn port(&self) -> Option<Arc<dyn DomainObjects>> {
        if self.storage != TableStorage::Model {
            return None;
        }
        if let Some(port) = &self.fixed {
            return Some(Arc::clone(port));
        }
        let port = self.hub.as_ref()?.get::<dyn DomainObjects>().ok();
        if port.is_none() {
            warn!(
                "studio-documents: rows are kept in the domain model, but it is not available — using the tables"
            );
        }
        port
    }

    pub async fn ensure<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
    ) -> Result<()> {
        let tenant = ctx.subject_tenant_id();
        if self
            .typed
            .lock()
            .map(|t| t.contains(&(tenant, T::ENTITY)))
            .unwrap_or(false)
        {
            return Ok(());
        }
        port.ensure_type(ctx, &T::need()).await?;
        port.ensure_type(ctx, &chunk_need(T::GEAR)).await?;
        if let Ok(mut t) = self.typed.lock() {
            t.insert((tenant, T::ENTITY));
        }
        Ok(())
    }

    /// Write rows as they are, chunking what is too long.
    pub async fn write<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        rows: &[T],
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut objects = Vec::with_capacity(rows.len());
        let mut chunks = Vec::new();
        for row in rows {
            let id = object_id::<T>(row.row_id());
            let mut payload = serde_json::to_value(row)?;
            Self::cut(&id, &mut payload, &mut chunks);
            objects.push(OwnedObject {
                id,
                scope: row.project().unwrap_or_else(|| row.owner()).to_string(),
                payload,
            });
        }
        if !chunks.is_empty() {
            port.put_objects(ctx, CHUNK_TYPE, chunks).await?;
        }
        port.put_objects(ctx, T::ENTITY, objects).await?;
        Ok(())
    }

    /// Move the longest fields of an oversized payload into chunk objects.
    fn cut(id: &str, payload: &mut Value, chunks: &mut Vec<OwnedObject>) {
        let size = |v: &Value| serde_json::to_vec(v).map(|b| b.len()).unwrap_or(0);
        while size(payload) > PAYLOAD_BUDGET {
            let Some(obj) = payload.as_object_mut() else {
                return;
            };
            let Some((name, len)) = obj
                .iter()
                .filter(|(_, v)| !v.get(CHUNKS).is_some())
                .map(|(k, v)| (k.clone(), size(v)))
                .max_by_key(|(_, n)| *n)
            else {
                return;
            };
            if len < 1024 {
                return;
            }
            let value = obj.remove(&name).unwrap_or(Value::Null);
            let (text, is_json) = match value {
                Value::String(s) => (s, false),
                other => (other.to_string(), true),
            };
            let parts = pieces(&text);
            for (i, part) in parts.iter().enumerate() {
                chunks.push(OwnedObject {
                    id: format!("{id}#{name}#{i}"),
                    scope: String::new(),
                    payload: json!({"owner": id, "field": name, "ordinal": i, "text": part}),
                });
            }
            obj.insert(name, json!({CHUNKS: parts.len(), "json": is_json}));
        }
    }

    /// Join chunked fields back into their objects.
    async fn join(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        rows: &mut [StoredObject],
    ) -> Result<()> {
        let owners: Vec<Value> = rows
            .iter()
            .filter(|o| {
                o.payload
                    .as_object()
                    .is_some_and(|m| m.values().any(|v| v.get(CHUNKS).is_some()))
            })
            .map(|o| Value::String(o.instance_id.clone()))
            .collect();
        if owners.is_empty() {
            return Ok(());
        }
        let (parts, _) = port
            .query(
                ctx,
                json!({"type": CHUNK_TYPE, "where": {"owner": {"_in": owners}}}),
            )
            .await?;
        let mut by: HashMap<(String, String), Vec<(i64, String)>> = HashMap::new();
        for p in parts {
            let v = &p.payload;
            let key = (
                v["owner"].as_str().unwrap_or_default().to_string(),
                v["field"].as_str().unwrap_or_default().to_string(),
            );
            by.entry(key).or_default().push((
                v["ordinal"].as_i64().unwrap_or(0),
                v["text"].as_str().unwrap_or_default().to_string(),
            ));
        }
        for o in rows.iter_mut() {
            let Some(obj) = o.payload.as_object_mut() else {
                continue;
            };
            let names: Vec<String> = obj
                .iter()
                .filter(|(_, v)| v.get(CHUNKS).is_some())
                .map(|(k, _)| k.clone())
                .collect();
            for name in names {
                let is_json = obj[&name]
                    .get("json")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let count = obj[&name].get(CHUNKS).and_then(Value::as_i64).unwrap_or(0);
                let mut texts = by
                    .remove(&(o.instance_id.clone(), name.clone()))
                    .unwrap_or_default();
                // A field once longer keeps its old tail chunks; the count
                // says how many belong to this version.
                texts.retain(|(i, _)| *i < count);
                texts.sort_by_key(|(i, _)| *i);
                let text: String = texts.into_iter().map(|(_, t)| t).collect();
                let value = if is_json {
                    serde_json::from_str(&text).unwrap_or(Value::Null)
                } else {
                    Value::String(text)
                };
                obj.insert(name, value);
            }
        }
        Ok(())
    }

    /// The rows `where_` matches, in `order_by` when given.
    pub async fn list<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        where_: Value,
        order_by: Option<Value>,
    ) -> Result<Vec<T>> {
        Ok(self.page(ctx, port, where_, order_by, 0, None).await?.0)
    }

    /// One page of what `where_` matches, with the total across every page.
    pub async fn page<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        where_: Value,
        order_by: Option<Value>,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<(Vec<T>, u64)> {
        let mut body = json!({"type": T::ENTITY, "where": where_});
        if let Some(o) = order_by {
            body["order_by"] = o;
        }
        if offset > 0 {
            body["offset"] = json!(offset);
        }
        if let Some(limit) = limit {
            body["limit"] = json!(limit);
        }
        let (mut rows, total) = port.query(ctx, body).await?;
        self.join(ctx, port, &mut rows).await?;
        let rows = rows
            .into_iter()
            .filter_map(|o| {
                let mut v = o.payload;
                if let Some(obj) = v.as_object_mut() {
                    obj.remove("_scope");
                }
                match serde_json::from_value::<T>(v) {
                    Ok(row) => Some(row),
                    Err(e) => {
                        warn!(entity = T::ENTITY, id = %o.instance_id, error = %e, "studio-documents: a stored row does not read back — skipped");
                        None
                    }
                }
            })
            .collect();
        Ok((rows, total as u64))
    }

    /// The rows with these ids.
    pub async fn get<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        ids: &[Uuid],
    ) -> Result<Vec<T>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<Value> = ids
            .iter()
            .map(|id| Value::String(object_id::<T>(*id)))
            .collect();
        self.list(ctx, port, json!({"id": {"_in": ids}}), None)
            .await
    }

    /// Upsert rows. With `update`, a row that exists keeps every column not
    /// named there — what the table's `ON CONFLICT … UPDATE` did.
    pub async fn put<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        rows: Vec<T>,
        update: Option<&[&str]>,
    ) -> Result<()> {
        let Some(update) = update else {
            return self.write(ctx, port, &rows).await;
        };
        let _turn = self.merging.lock().await;
        let ids: Vec<Uuid> = rows.iter().map(TableRow::row_id).collect();
        let existing: HashMap<Uuid, T> = self
            .get::<T>(ctx, port, &ids)
            .await?
            .into_iter()
            .map(|r| (r.row_id(), r))
            .collect();
        let mut merged = Vec::with_capacity(rows.len());
        for row in rows {
            match existing.get(&row.row_id()) {
                None => merged.push(row),
                Some(old) => {
                    let mut base = serde_json::to_value(old)?;
                    let new = serde_json::to_value(&row)?;
                    if let (Some(b), Value::Object(n)) = (base.as_object_mut(), new) {
                        merge(b, n, update);
                    }
                    merged.push(serde_json::from_value(base)?);
                }
            }
        }
        self.write(ctx, port, &merged).await
    }

    /// Delete rows by id, answering how many there were.
    pub async fn remove<T: TableRow>(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        ids: &[Uuid],
    ) -> Result<usize> {
        let found = self.get::<T>(ctx, port, ids).await?;
        if found.is_empty() {
            return Ok(0);
        }
        let ids: Vec<String> = found.iter().map(|r| object_id::<T>(r.row_id())).collect();
        let owners: Vec<Value> = ids.iter().cloned().map(Value::String).collect();
        let (chunks, _) = port
            .query(ctx, json!({"type": CHUNK_TYPE, "where": {"owner": {"_in": owners}}, "fields": ["owner"]}))
            .await?;
        if !chunks.is_empty() {
            port.remove_objects(
                ctx,
                CHUNK_TYPE,
                chunks.into_iter().map(|c| c.instance_id).collect(),
            )
            .await?;
        }
        port.remove_objects(ctx, T::ENTITY, ids).await
    }
}

fn merge(base: &mut Map<String, Value>, new: Map<String, Value>, update: &[&str]) {
    for (k, v) in new {
        if update.contains(&k.as_str()) {
            base.insert(k, v);
        }
    }
}
