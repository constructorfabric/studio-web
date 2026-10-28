//! The catalogue kept as domain objects (ADR-0051 §8a,
//! `gears.<gear>.config.storage.catalog`).
//!
//! Gears, their versions and profiles, the registry with its occurrences and
//! decisions, sources, field schemas, roadmap items and a project's product
//! are each a model type, kept by the gear that writes them (`held_by`), so
//! the domain query reads them beside everything else and the generic object
//! writes refuse them. The catalogue's own relations (a gear has versions, an
//! entry was found in a place, a decision was made about it) are model
//! relations.
//!
//! The first touch of a tenant copies what the graph store held — every node
//! and every snapshot — records it with a `sync-state` marker, and retires
//! the graph store's copies so nothing is kept twice. Relations are not
//! copied: nothing reads them through the store, and the next sync writes them
//! again.
//!
//! Which types are components is an organization's choice over the model's
//! types: [`CatalogSink::node_types`] answers with them.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Map, Value, json};
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::gts::{self as cgts, GtsEdge, GtsNode};
use super::sink::{CatalogNodeView, CatalogSink, GraphNodeType};
use crate::domain_model::port::{DomainObjects, OwnedObject, TypeNeed};

/// Each catalogue node type, the model type it becomes, and how it is named.
const TYPES: [(&str, &str, &str, &str); 16] = [
    (
        cgts::GEAR_TYPE,
        "gear",
        "Gear",
        "A gear: a published crate or one found in a repository.",
    ),
    (
        cgts::CRATE_VERSION_TYPE,
        "gear-version",
        "Gear Version",
        "One published version of a gear.",
    ),
    (
        cgts::GEAR_PROFILE_TYPE,
        "gear-profile",
        "Gear Profile",
        "What an organization says about a gear, kept apart from its source.",
    ),
    (
        cgts::PROJECT_GEAR_REPO_TYPE,
        "project-gear-repository",
        "Project Gear Repository",
        "Where a project's gears live and new ones are written.",
    ),
    (
        cgts::PROJECT_PRODUCT_TYPE,
        "project-product",
        "Project Product",
        "The product a project composes out of gears, and what the engine said of it.",
    ),
    (
        cgts::KIT_TYPE,
        "catalog-kit",
        "Catalog Kit",
        "A set of files a project installs into its repositories.",
    ),
    (
        cgts::FRONTX_TYPE,
        "frontx-package",
        "FrontX Package",
        "A FrontX micro-frontend package.",
    ),
    (
        cgts::FIELD_SCHEMA_TYPE,
        "component-field-schema",
        "Component Field Schema",
        "Which fields a page shows for one component type, and where each is read.",
    ),
    (
        cgts::COMPONENT_SNAPSHOT_TYPE,
        "component-snapshot",
        "Component Snapshot",
        "What one component's fields said on one day.",
    ),
    (
        cgts::ROADMAP_ITEM_TYPE,
        "roadmap-item",
        "Roadmap Item",
        "A gear on a roadmap board, planned whether or not it exists yet.",
    ),
    (
        cgts::SOURCE_TYPE,
        "catalog-source",
        "Catalog Source",
        "A repository an organization's catalogue reads, its ref and mode.",
    ),
    (
        cgts::REGISTRY_ENTRY_TYPE,
        "registry-entry",
        "Registry Entry",
        "A component of an organization's registry and where it is in its lifecycle.",
    ),
    (
        cgts::OCCURRENCE_TYPE,
        "registry-occurrence",
        "Registry Occurrence",
        "Where a registry entry was found: project, repository, ref, path.",
    ),
    (
        cgts::REGISTRY_READ_TYPE,
        "registry-read",
        "Registry Read",
        "One repository the registry walk read, and what it found unchanged.",
    ),
    (
        cgts::REGISTRY_SETTINGS_TYPE,
        "registry-settings",
        "Registry Settings",
        "An organization's registry settings: the projects its walk skips.",
    ),
    (
        cgts::REGISTRY_DECISION_TYPE,
        "registry-decision",
        "Registry Decision",
        "A decision a person made about a registry entry, and why.",
    ),
];

/// Each catalogue relation: its type, the model relation, source, target, verb.
const RELATIONS: [(&str, &str, &str, &str, &str); 3] = [
    (
        cgts::REL_HAS_VERSION,
        "has_version",
        "gear",
        "gear-version",
        "has",
    ),
    (
        cgts::REL_FOUND_IN,
        "found_in",
        "registry-entry",
        "registry-occurrence",
        "found in",
    ),
    (
        cgts::REL_DECIDED,
        "decided",
        "registry-entry",
        "registry-decision",
        "decided",
    ),
];

/// The catalogue's own id of a node, kept on its object.
const CATALOG_ID: &str = "catalog_id";
/// The tenant that wrote it: a read in one tenant answers with its own.
const CATALOG_TENANT: &str = "catalog_tenant";

fn entity_of(type_id: &str) -> Option<&'static str> {
    TYPES.iter().find(|t| t.0 == type_id).map(|t| t.1)
}

fn type_of_entity(entity: &str) -> Option<&'static str> {
    TYPES.iter().find(|t| t.1 == entity).map(|t| t.0)
}

fn object_id(instance_id: &str) -> String {
    format!("cat-{instance_id}")
}

pub(crate) struct ModelSink {
    legacy: Arc<dyn CatalogSink>,
    hub: Option<Arc<ClientHub>>,
    #[cfg(test)]
    fixed: Option<Arc<dyn DomainObjects>>,
    gear: String,
    /// The strategy went back to the graph store: what the model holds moves
    /// back on first touch, and the graph store answers.
    returning: bool,
    typed: Mutex<HashSet<Uuid>>,
    moved: Mutex<HashSet<Uuid>>,
}

impl ModelSink {
    pub(crate) fn new(legacy: Arc<dyn CatalogSink>, hub: Arc<ClientHub>, gear: &str) -> Self {
        Self {
            legacy,
            hub: Some(hub),
            #[cfg(test)]
            fixed: None,
            gear: gear.to_owned(),
            returning: false,
            typed: Mutex::default(),
            moved: Mutex::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_port(
        legacy: Arc<dyn CatalogSink>,
        port: Arc<dyn DomainObjects>,
        gear: &str,
    ) -> Self {
        Self {
            legacy,
            hub: None,
            fixed: Some(port),
            gear: gear.to_owned(),
            returning: false,
            typed: Mutex::default(),
            moved: Mutex::default(),
        }
    }

    fn port(&self) -> Option<Arc<dyn DomainObjects>> {
        #[cfg(test)]
        if let Some(port) = &self.fixed {
            return Some(Arc::clone(port));
        }
        let port = self.hub.as_ref()?.get::<dyn DomainObjects>().ok();
        if port.is_none() {
            warn!(gear = %self.gear, "the catalogue is kept in the domain model, but it is not available — using the graph store");
        }
        port
    }

    /// Whether this gear writes nodes of `type_id`: the product its two,
    /// the catalogue the rest. Only those are moved and held by it.
    fn owns(&self, type_id: &str) -> bool {
        (self.gear == "studio-product") == cgts::PRODUCT_NODE_TYPES.contains(&type_id)
    }

    fn needs(&self) -> Vec<TypeNeed> {
        TYPES
            .iter()
            .map(|(type_id, entity, name, description)| TypeNeed {
                id: (*entity).to_owned(),
                name: (*name).to_owned(),
                description: (*description).to_owned(),
                extends: Some("record".to_owned()),
                bucket: Some("catalog".to_owned()),
                fields: vec![
                    (CATALOG_ID.to_owned(), "string".to_owned(), String::new()),
                    (
                        CATALOG_TENANT.to_owned(),
                        "string".to_owned(),
                        String::new(),
                    ),
                    ("day".to_owned(), "integer?".to_owned(), String::new()),
                    ("component".to_owned(), "string?".to_owned(), String::new()),
                ],
                relations: RELATIONS
                    .iter()
                    .filter(|r| r.2 == *entity)
                    .map(|r| (r.1.to_owned(), r.3.to_owned(), r.4.to_owned()))
                    .collect(),
                held_by: self.owns(type_id).then(|| self.gear.clone()),
                searchable: matches!(
                    *entity,
                    "gear" | "catalog-kit" | "frontx-package" | "registry-entry" | "roadmap-item"
                ),
            })
            .collect()
    }

    /// The model, ready for `ctx`'s tenant: its types, and what the graph
    /// store held for it. `None` keeps the graph store for this call.
    /// The graph store, with the model's catalogue moved back into it first
    /// (`storage.catalog` set back): never one-way, never kept twice.
    pub(crate) fn returning(legacy: Arc<dyn CatalogSink>, hub: Arc<ClientHub>, gear: &str) -> Self {
        Self {
            returning: true,
            ..Self::new(legacy, hub, gear)
        }
    }

    #[cfg(test)]
    pub(crate) fn returning_with_port(
        legacy: Arc<dyn CatalogSink>,
        port: Arc<dyn DomainObjects>,
        gear: &str,
    ) -> Self {
        Self {
            returning: true,
            ..Self::with_port(legacy, port, gear)
        }
    }

    /// Move what the model holds of this gear's catalogue for the caller's
    /// tenant back into the graph store, and out of the model.
    async fn back_to_graph(&self, ctx: &SecurityContext) {
        let tenant = ctx.subject_tenant_id();
        if self
            .moved
            .lock()
            .map(|m| m.contains(&tenant))
            .unwrap_or(true)
        {
            return;
        }
        let Some(port) = self.port() else {
            return;
        };
        let marker = format!("catalog-moved-v1:{}:{tenant}", self.gear);
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
            let entities: Vec<&str> = TYPES.iter().filter(|t| self.owns(t.0)).map(|t| t.1).collect();
            let rows = self.read(ctx, p, &entities, None).await?;
            let mut nodes = Vec::new();
            let mut snapshots = Vec::new();
            for (entity, instance_id, value) in rows {
                let Some(type_id) = type_of_entity(&entity) else { continue };
                let node = GtsNode { type_id, instance_id, value };
                if type_id == cgts::COMPONENT_SNAPSHOT_TYPE {
                    snapshots.push(node);
                } else {
                    nodes.push(node);
                }
            }
            self.legacy.upsert(ctx, &nodes, &[]).await?;
            if !snapshots.is_empty() {
                self.legacy.write_snapshots(ctx, &snapshots).await?;
            }
            for entity in &entities {
                let ids: Vec<String> = nodes
                    .iter()
                    .chain(&snapshots)
                    .filter(|n| entity_of(n.type_id) == Some(*entity))
                    .map(|n| object_id(&n.instance_id))
                    .collect();
                if !ids.is_empty() {
                    p.remove_objects(ctx, entity, ids).await?;
                }
            }
            p.put_objects(
                ctx,
                "sync-state",
                vec![OwnedObject {
                    id: marker.clone(),
                    scope: String::new(),
                    payload: json!({"status": "returned", "message": format!("{} catalogue moved back to the graph store", self.gear)}),
                }],
            )
            .await?;
            anyhow::Ok(nodes.len() + snapshots.len())
        }
        .await;
        match result {
            Ok(n) => {
                if n > 0 {
                    info!(gear = %self.gear, tenant = %tenant, nodes = n, "catalogue moved back to the graph store");
                }
                if let Ok(mut m) = self.moved.lock() {
                    m.insert(tenant);
                }
            }
            Err(e) => warn!(gear = %self.gear, error = %e, "the catalogue could not move back yet"),
        }
    }

    async fn ready(&self, ctx: &SecurityContext) -> Result<Option<Arc<dyn DomainObjects>>> {
        if self.returning {
            self.back_to_graph(ctx).await;
            return Ok(None);
        }
        let Some(port) = self.port() else {
            return Ok(None);
        };
        let tenant = ctx.subject_tenant_id();
        if !self
            .typed
            .lock()
            .map(|t| t.contains(&tenant))
            .unwrap_or(false)
        {
            // Relations name their targets, so every type is there first.
            let needs = self.needs();
            for n in &needs {
                let plain = TypeNeed {
                    relations: Vec::new(),
                    ..n.clone()
                };
                port.ensure_type(ctx, &plain).await?;
            }
            for n in needs.iter().filter(|n| !n.relations.is_empty()) {
                port.ensure_type(ctx, n).await?;
            }
            if let Ok(mut t) = self.typed.lock() {
                t.insert(tenant);
            }
        }
        if self
            .moved
            .lock()
            .map(|m| m.contains(&tenant))
            .unwrap_or(false)
        {
            return Ok(Some(port));
        }
        let marker = format!("catalog-moved-v1:{}:{tenant}", self.gear);
        let (done, _) = port
            .query(
                ctx,
                json!({"type": "sync-state", "where": {"id": {"_eq": marker}}, "limit": 1}),
            )
            .await?;
        let done = done
            .first()
            .is_some_and(|o| o.payload.get("status").and_then(Value::as_str) == Some("done"));
        if !done {
            let mut nodes = self.legacy.list(ctx, None).await?;
            nodes.retain(|n| self.owns(n.type_id));
            let snapshots = if self.owns(cgts::COMPONENT_SNAPSHOT_TYPE) {
                self.legacy
                    .snapshots(ctx, None, i64::MIN, i64::MAX)
                    .await
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            self.write(ctx, port.as_ref(), &nodes).await?;
            let snaps: Vec<GtsNode> = snapshots
                .into_iter()
                .map(|v| GtsNode {
                    type_id: cgts::COMPONENT_SNAPSHOT_TYPE,
                    instance_id: format!(
                        "snapshot:{}:{}",
                        v.get("component")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        v.get("day").and_then(Value::as_i64).unwrap_or_default()
                    ),
                    value: v,
                })
                .collect();
            self.write(ctx, port.as_ref(), &snaps).await?;
            port.put_objects(
                ctx,
                "sync-state",
                vec![OwnedObject {
                    id: marker,
                    scope: String::new(),
                    payload: json!({"status": "done", "message": format!("{} catalogue moved into the domain model", self.gear)}),
                }],
            )
            .await?;
            info!(gear = %self.gear, tenant = %tenant, nodes = nodes.len(), "catalogue moved into the domain model");
            // The graph store's copies go, so nothing is kept twice. Retiring
            // a node is a read and a write each, and a catalogue has thousands
            // of versions, so it runs behind the call.
            let legacy = Arc::clone(&self.legacy);
            let retire_ctx = ctx.clone();
            let ids: Vec<String> = nodes.iter().map(|n| n.instance_id.clone()).collect();
            tokio::spawn(async move {
                for id in ids {
                    if let Err(e) = legacy.delete(&retire_ctx, &id).await {
                        warn!(error = %e, "the graph store's catalogue copies could not all be retired");
                        break;
                    }
                }
            });
        }
        if let Ok(mut m) = self.moved.lock() {
            m.insert(tenant);
        }
        Ok(Some(port))
    }

    async fn write(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        nodes: &[GtsNode],
    ) -> Result<()> {
        let tenant = ctx.subject_tenant_id();
        let mut by: std::collections::BTreeMap<&'static str, Vec<OwnedObject>> = Default::default();
        for n in nodes {
            let Some(entity) = entity_of(n.type_id) else {
                continue;
            };
            let mut payload = match &n.value {
                Value::Object(m) => Value::Object(m.clone()),
                other => json!({"value": other}),
            };
            payload[CATALOG_ID] = json!(n.instance_id);
            payload[CATALOG_TENANT] = json!(tenant);
            by.entry(entity).or_default().push(OwnedObject {
                id: object_id(&n.instance_id),
                scope: String::new(),
                payload,
            });
        }
        for (entity, objects) in by {
            for chunk in objects.chunks(500) {
                port.put_objects(ctx, entity, chunk.to_vec()).await?;
            }
        }
        Ok(())
    }

    /// The nodes of `entities` the tenant wrote, as the catalogue names them.
    async fn read(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        entities: &[&str],
        limit: Option<usize>,
    ) -> Result<Vec<(String, String, Value)>> {
        let tenant = ctx.subject_tenant_id();
        let mut out = Vec::new();
        for entity in entities {
            let mut body = json!({
                "type": entity,
                "where": {"catalog_tenant": {"_eq": tenant}},
                "order_by": [{"field": "id"}],
            });
            if type_of_entity(entity).is_none() {
                // A model type the catalogue did not write: every object.
                body["where"] = json!({});
            }
            if let Some(l) = limit {
                body["limit"] = json!(l + 1);
            }
            let (rows, _) = port.query(ctx, body).await?;
            for o in rows {
                let mut v = o.payload;
                let id = v
                    .get(CATALOG_ID)
                    .and_then(Value::as_str)
                    .map_or_else(|| o.instance_id.clone(), str::to_owned);
                if let Some(m) = v.as_object_mut() {
                    for f in [CATALOG_ID, CATALOG_TENANT, "_scope"] {
                        m.remove(f);
                    }
                }
                out.push(((*entity).to_owned(), id, v));
            }
        }
        Ok(out)
    }
}

#[async_trait]
impl CatalogSink for ModelSink {
    async fn register_types(&self, ctx: &SecurityContext) -> Result<()> {
        if self.ready(ctx).await?.is_none() {
            return self.legacy.register_types(ctx).await;
        }
        Ok(())
    }

    fn tenant_scoped(&self) -> bool {
        true
    }

    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> Result<()> {
        let Some(port) = self.ready(ctx).await? else {
            return self.legacy.upsert(ctx, nodes, edges).await;
        };
        self.write(ctx, port.as_ref(), nodes).await?;
        let links: Vec<(String, String, String, String)> = edges
            .iter()
            .filter_map(|e| {
                let r = RELATIONS.iter().find(|r| r.0 == e.type_id)?;
                Some((
                    r.2.to_owned(),
                    r.1.to_owned(),
                    object_id(&e.from),
                    object_id(&e.to),
                ))
            })
            .collect();
        if !links.is_empty() {
            port.link_objects(ctx, links).await?;
        }
        Ok(())
    }

    async fn list(&self, ctx: &SecurityContext, type_filter: Option<&str>) -> Result<Vec<GtsNode>> {
        let Some(port) = self.ready(ctx).await? else {
            return self.legacy.list(ctx, type_filter).await;
        };
        let entities: Vec<&str> = TYPES
            .iter()
            .filter(|t| t.0 != cgts::COMPONENT_SNAPSHOT_TYPE)
            .filter(|t| type_filter.is_none_or(|f| t.0.contains(f)))
            .map(|t| t.1)
            .collect();
        Ok(self
            .read(ctx, port.as_ref(), &entities, None)
            .await?
            .into_iter()
            .filter_map(|(entity, instance_id, value)| {
                Some(GtsNode {
                    type_id: type_of_entity(&entity)?,
                    instance_id,
                    value,
                })
            })
            .collect())
    }

    async fn delete(&self, ctx: &SecurityContext, instance_id: &str) -> Result<()> {
        let Some(port) = self.ready(ctx).await? else {
            return self.legacy.delete(ctx, instance_id).await;
        };
        let id = object_id(instance_id);
        for (_, entity, ..) in TYPES {
            let (found, _) = port
                .query(
                    ctx,
                    json!({"type": entity, "where": {"id": {"_eq": id}}, "limit": 1}),
                )
                .await?;
            if !found.is_empty() {
                port.remove_objects(ctx, entity, vec![id]).await?;
                return Ok(());
            }
        }
        Ok(())
    }

    async fn node_types(&self, ctx: &SecurityContext) -> Result<Vec<GraphNodeType>> {
        let Some(port) = self.ready(ctx).await? else {
            return self.legacy.node_types(ctx).await;
        };
        Ok(port
            .entity_types(ctx)
            .await?
            .into_iter()
            .map(|(entity, is_abstract)| GraphNodeType {
                type_id: entity.clone(),
                leaf_id: entity,
                is_abstract,
            })
            .collect())
    }

    async fn list_of_types(
        &self,
        ctx: &SecurityContext,
        graph_types: &[String],
        limit: usize,
    ) -> Result<(Vec<CatalogNodeView>, bool)> {
        let Some(port) = self.ready(ctx).await? else {
            return self.legacy.list_of_types(ctx, graph_types, limit).await;
        };
        let entities: Vec<String> = graph_types
            .iter()
            .map(|t| {
                TYPES
                    .iter()
                    .find(|x| cgts::graph_type_id(x.0) == *t || x.0 == t)
                    .map_or_else(|| t.clone(), |x| x.1.to_owned())
            })
            .collect();
        let refs: Vec<&str> = entities.iter().map(String::as_str).collect();
        let mut out: Vec<CatalogNodeView> = self
            .read(ctx, port.as_ref(), &refs, Some(limit))
            .await?
            .into_iter()
            .map(|(entity, instance_id, value)| CatalogNodeView {
                type_id: type_of_entity(&entity).map_or(entity, str::to_owned),
                instance_id,
                value,
            })
            .collect();
        out.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
        let truncated = out.len() > limit;
        out.truncate(limit);
        Ok((out, truncated))
    }

    async fn count_of_type(
        &self,
        ctx: &SecurityContext,
        graph_type: &str,
        cap: usize,
    ) -> Result<(usize, bool)> {
        let Some(port) = self.ready(ctx).await? else {
            return self.legacy.count_of_type(ctx, graph_type, cap).await;
        };
        let entity = TYPES
            .iter()
            .find(|x| cgts::graph_type_id(x.0) == graph_type || x.0 == graph_type)
            .map_or(graph_type, |x| x.1);
        let mut body = json!({"type": entity, "limit": 1});
        if type_of_entity(entity).is_some() {
            body["where"] = json!({"catalog_tenant": {"_eq": ctx.subject_tenant_id()}});
        }
        let (_, total) = port.query(ctx, body).await?;
        Ok((total.min(cap), total > cap))
    }

    async fn write_snapshots(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> Result<()> {
        let Some(port) = self.ready(ctx).await? else {
            return self.legacy.write_snapshots(ctx, nodes).await;
        };
        self.write(ctx, port.as_ref(), nodes).await
    }

    async fn snapshots(
        &self,
        ctx: &SecurityContext,
        component: Option<&str>,
        from_day: i64,
        to_day: i64,
    ) -> Result<Vec<Value>> {
        let Some(port) = self.ready(ctx).await? else {
            return self
                .legacy
                .snapshots(ctx, component, from_day, to_day)
                .await;
        };
        let mut w = Map::new();
        w.insert(
            CATALOG_TENANT.into(),
            json!({"_eq": ctx.subject_tenant_id()}),
        );
        if let Some(c) = component {
            w.insert("component".into(), json!({"_eq": c}));
        }
        let days = json!([{"day": {"_gte": from_day}}, {"day": {"_lt": to_day}}]);
        w.insert("_and".into(), days);
        let (rows, _) = port
            .query(
                ctx,
                json!({"type": "component-snapshot", "where": Value::Object(w)}),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|o| {
                let mut v = o.payload;
                if let Some(m) = v.as_object_mut() {
                    for f in [CATALOG_ID, CATALOG_TENANT, "_scope"] {
                        m.remove(f);
                    }
                }
                v
            })
            .collect())
    }
}

#[async_trait]
impl crate::model_sweep::TenantMover for ModelSink {
    fn name(&self) -> &str {
        &self.gear
    }
    /// The catalogue is per organization: only the organization's own visit.
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> Result<()> {
        if tenant == ctx.subject_tenant_id() {
            self.ready(ctx).await?;
        }
        Ok(())
    }
}
