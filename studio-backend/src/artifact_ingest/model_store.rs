//! The artifact graph kept as domain objects (ADR-0051 §8a, the target
//! scheme): `gears.studio-artifact-ingest.config.storage.artifacts: model`.
//!
//! What a sync writes — repositories, issues, pull requests, files, commits,
//! comments, CI runs, builds, releases, findings — becomes objects of the
//! domain model's types (`repository`, `work-item`, `pull-request`,
//! `repository-file`, `commit`, `comment`, `ci-run`, …) and its relations
//! become declared relations, so `POST /query` reads them like anything else
//! the model holds, and an administrator can extend them. The gear keeps no
//! store of its own: every [`GraphStore`] call is answered from the model.
//!
//! The payload is kept verbatim, so what a listing returns is what it
//! returned before. An object's id is the artifact's id with a prefix
//! ([`ID_PREFIX`]): the artifact's own node still holds that key in the graph
//! until a purge, and two nodes cannot share one.
//!
//! What a tenant already had moves once, in the background, the first time
//! the store is touched for it: every node and relation the old store lists
//! is written into the model, and a marker object records that it is done.
//! Until then reads are answered by the old store and writes go to both, so
//! nothing a sync writes during the move is lost. Relations the old store
//! does not list come back with the next sync of their repository.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::graph::{
    GraphStore, GtsEdge, GtsEdgeView, GtsNode, NodePage, NodePageQuery, ingested_file,
    page_of_nodes,
};
use super::gts;
use super::port::IngestedFile;
use crate::domain_model::port::{DomainObjects, OwnedObject, StoredObject, TypeNeed};

/// Where the artifact graph is kept (`config.storage.artifacts`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactStorage {
    /// Domain objects: the target scheme, and the default.
    #[default]
    Model,
    /// The gear's own graph types, as before.
    Graph,
}

/// What an artifact's id gets in front of it as a domain object's id.
pub const ID_PREFIX: &str = "art-";

/// The marker that a tenant's artifacts have moved.
const MOVED_MARKER: &str = "art-store-moved-v1";

/// Each artifact type and the model type it becomes.
const KINDS: [(&str, &str); 15] = [
    (gts::REPO_TYPE, "repository"),
    (gts::ISSUE_TYPE, "work-item"),
    (gts::PULL_REQUEST_TYPE, "pull-request"),
    (gts::FILE_TYPE, "repository-file"),
    (gts::USER_TYPE, "source-account"),
    (gts::SPEC_FINDING_TYPE, "finding"),
    (gts::COMMENT_TYPE, "comment"),
    (gts::COMMIT_TYPE, "commit"),
    (gts::FILE_CONTENT_TYPE, "text-content"),
    (gts::MAPPING_DECISION_TYPE, "mapping-decision"),
    (gts::WORKFLOW_RUN_TYPE, "ci-run"),
    (gts::WORKFLOW_JOB_TYPE, "ci-job"),
    (gts::BUILD_TYPE, "product-build"),
    (gts::BUILD_ARTIFACT_TYPE, "build-artifact"),
    (gts::RELEASE_TYPE, "release"),
];

/// Each artifact relation and the declared relation it becomes (declared on
/// `system-object`, so it holds between objects of any type).
const RELATIONS: [(&str, &str, &str, &str); 15] = [
    (
        gts::REL_ARTIFACT_OF,
        "in_repository",
        "repository",
        "references",
    ),
    (
        gts::REL_CONTAINS,
        "contains_file",
        "repository-file",
        "composes",
    ),
    (
        gts::REL_AUTHORED_BY,
        "authored_by_account",
        "source-account",
        "references",
    ),
    (
        gts::REL_MODIFIES,
        "modifies_file",
        "repository-file",
        "references",
    ),
    (
        gts::REL_DUPLICATES,
        "duplicates",
        "system-object",
        "references",
    ),
    (
        gts::REL_TRACES_TO,
        "traces_to",
        "system-object",
        "references",
    ),
    (
        gts::REL_FINDING_ON,
        "finding_on",
        "system-object",
        "references",
    ),
    (
        gts::REL_COMMENT_ON,
        "comment_on",
        "system-object",
        "references",
    ),
    (
        gts::REL_CONTENT_OF,
        "content_of",
        "repository-file",
        "references",
    ),
    (
        gts::REL_DECISION_ON,
        "decision_on",
        "system-object",
        "references",
    ),
    (
        gts::REL_REVIEWED_BY,
        "reviewed_by_account",
        "source-account",
        "references",
    ),
    (
        gts::REL_ASSIGNED_TO,
        "assigned_to_account",
        "source-account",
        "references",
    ),
    (gts::REL_CLOSES, "closes_item", "work-item", "references"),
    (
        gts::REL_REFERENCES,
        "mentions",
        "system-object",
        "references",
    ),
    (gts::REL_PART_OF, "part_of_item", "work-item", "references"),
];

const RELATION_SOURCE: &str = "system-object";

fn entity_of(artifact_type: &str) -> Option<&'static str> {
    KINDS
        .iter()
        .find(|(a, _)| *a == artifact_type)
        .map(|(_, e)| *e)
}

fn artifact_of_entity(entity: &str) -> Option<&'static str> {
    KINDS.iter().find(|(_, e)| *e == entity).map(|(a, _)| *a)
}

fn object_id(artifact_id: &str) -> String {
    format!("{ID_PREFIX}{artifact_id}")
}

fn artifact_id(object_id: &str) -> String {
    object_id
        .strip_prefix(ID_PREFIX)
        .unwrap_or(object_id)
        .to_string()
}

/// The tenant an artifact belongs to: its project, else its workspace.
fn scope_of(value: &Value) -> String {
    ["project_id", "workspace_id"]
        .iter()
        .find_map(|k| value.get(*k).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// The fields every artifact type needs in the model to be queried the way
/// the listings narrow (scope, repository, order).
fn common_fields() -> Vec<(String, String, String)> {
    [
        (
            "workspace_id",
            "string",
            "The workspace the artifact belongs to",
        ),
        (
            "project_id",
            "string",
            "The project the artifact belongs to",
        ),
        ("repo", "string", "The repository the artifact came from"),
        ("path", "string", "Its path in the repository"),
        ("title", "string", "What it is called"),
        ("updated_at", "timestamp", "When the source last changed it"),
        ("url", "url", "Where it is in the source system"),
    ]
    .into_iter()
    .map(|(n, t, d)| (n.to_string(), t.to_string(), d.to_string()))
    .collect()
}

/// The gear that keeps the synced types (`TypeNeed::held_by`).
const GEAR: &str = "studio-artifact-ingest";

/// Kinds members also write themselves, left open to the generic writes.
const SHARED_KINDS: [&str; 3] = ["work-item", "comment", "finding"];

/// The types and relations the model needs before the first write.
fn needs() -> Vec<TypeNeed> {
    let new_type = |id: &str, name: &str, description: &str| TypeNeed {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        extends: Some("record".to_string()),
        bucket: Some("content".to_string()),
        fields: common_fields(),
        relations: Vec::new(),
        held_by: Some(GEAR.to_string()),
        searchable: true,
    };
    let mut out: Vec<TypeNeed> = vec![
        new_type(
            "source-account",
            "Source Account",
            "An account in a source system: who wrote or reviewed something there.",
        ),
        new_type(
            "mapping-decision",
            "Mapping Decision",
            "A member's decision on which gear covers a capability a document declares.",
        ),
        new_type(
            "ci-run",
            "CI Run",
            "One run of one CI workflow on one commit.",
        ),
        new_type("ci-job", "CI Job", "One job of a CI run's latest attempt."),
        new_type(
            "product-build",
            "Product Build",
            "A build of the project's product the IDE ran and reported.",
        ),
        new_type(
            "build-artifact",
            "Build Artifact",
            "A file a CI run uploaded.",
        ),
        new_type(
            "release",
            "Release",
            "A release of a repository: a tag and the files attached to it.",
        ),
    ];
    for (_, entity) in KINDS {
        if out.iter().any(|n| n.id == entity) {
            continue;
        }
        out.push(TypeNeed {
            id: entity.to_string(),
            fields: common_fields(),
            // What a sync writes is the source's, and the next sync would
            // overwrite an edit: those types are this gear's. Work items,
            // comments and findings are also what members write themselves.
            held_by: (!SHARED_KINDS.contains(&entity)).then(|| GEAR.to_string()),
            // Found by meaning: the artifact search runs over them.
            searchable: true,
            ..Default::default()
        });
    }
    out.push(TypeNeed {
        id: RELATION_SOURCE.to_string(),
        relations: RELATIONS
            .iter()
            .map(|(_, name, target, verb)| (name.to_string(), target.to_string(), verb.to_string()))
            .collect(),
        ..Default::default()
    });
    out
}

/// The artifact graph, answered from the domain model.
pub struct ModelGraphStore {
    /// The store the gear used before: answers until a tenant has moved.
    legacy: Arc<dyn GraphStore>,
    hub: Arc<toolkit::client_hub::ClientHub>,
    typed: Mutex<HashSet<Uuid>>,
    moved: Mutex<HashSet<Uuid>>,
    moving: Mutex<HashSet<Uuid>>,
}

impl ModelGraphStore {
    pub fn new(legacy: Arc<dyn GraphStore>, hub: Arc<toolkit::client_hub::ClientHub>) -> Self {
        Self {
            legacy,
            hub,
            typed: Mutex::default(),
            moved: Mutex::default(),
            moving: Mutex::default(),
        }
    }

    fn port(&self) -> anyhow::Result<Arc<dyn DomainObjects>> {
        self.hub
            .get::<dyn DomainObjects>()
            .map_err(|e| anyhow::anyhow!("the domain model is not available: {e}"))
    }

    async fn ensure_types(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
    ) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        if self
            .typed
            .lock()
            .map(|t| t.contains(&tenant))
            .unwrap_or(false)
        {
            return Ok(());
        }
        for need in needs() {
            port.ensure_type(ctx, &need).await?;
        }
        if let Ok(mut t) = self.typed.lock() {
            t.insert(tenant);
        }
        Ok(())
    }

    /// Has this tenant moved? Asked of the model once per process; a tenant
    /// that has not starts its move in the background.
    async fn ready(self: &Arc<Self>, ctx: &SecurityContext) -> bool {
        let tenant = ctx.subject_tenant_id();
        if self
            .moved
            .lock()
            .map(|m| m.contains(&tenant))
            .unwrap_or(false)
        {
            return true;
        }
        let Ok(port) = self.port() else {
            return false;
        };
        let marked = port
            .query(
                ctx,
                json!({"type": "sync-state", "where": {"id": {"_eq": MOVED_MARKER}}, "limit": 1}),
            )
            .await
            .map(|(rows, _)| {
                rows.first().is_some_and(|o| {
                    o.payload.get("status").and_then(Value::as_str) != Some("returned")
                })
            })
            .unwrap_or(false);
        if marked {
            if let Ok(mut m) = self.moved.lock() {
                m.insert(tenant);
            }
            return true;
        }
        let claimed = self
            .moving
            .lock()
            .map(|mut m| m.insert(tenant))
            .unwrap_or(false);
        if claimed {
            let this = Arc::clone(self);
            let ctx = ctx.clone();
            tokio::spawn(async move {
                match this.move_tenant(&ctx).await {
                    Ok(()) => {
                        if let Ok(mut m) = this.moved.lock() {
                            m.insert(ctx.subject_tenant_id());
                        }
                    }
                    Err(e) => {
                        warn!(error = %format!("{e:#}"), "studio-artifact-ingest: moving the artifacts into the domain model failed — reads stay on the old store");
                    }
                }
                if let Ok(mut m) = this.moving.lock() {
                    m.remove(&ctx.subject_tenant_id());
                }
            });
        }
        false
    }

    async fn move_tenant(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let port = self.port()?;
        self.ensure_types(ctx, port.as_ref()).await?;
        let mut moved: Vec<GtsNode> = Vec::new();
        for (artifact_type, _) in KINDS {
            let found = self.legacy.list(ctx, Some(artifact_type)).await?;
            self.write_nodes(ctx, port.as_ref(), &found).await?;
            moved.extend(found.iter().cloned());
        }
        let nodes = moved.len();
        let edges: Vec<GtsEdge> = self
            .legacy
            .list_relations(ctx)
            .await?
            .into_iter()
            .filter_map(|e| {
                let type_id = RELATIONS.iter().find(|(r, ..)| *r == e.type_id)?.0;
                Some(GtsEdge {
                    type_id,
                    from: e.from,
                    to: e.to,
                })
            })
            .collect();
        let (linked, skipped) = self.write_edges(ctx, port.as_ref(), &edges).await?;
        port.put_objects(
            ctx,
            "sync-state",
            vec![OwnedObject {
                id: MOVED_MARKER.to_string(),
                scope: String::new(),
                payload: json!({"status": "done", "message": "artifacts moved into the domain model"}),
            }],
        )
        .await?;
        // The model holds them now: the old store's copies go, so nothing is
        // kept twice (the graph nodes and the artifact index mirror). A failure
        // here leaves a copy nobody reads, not a loss.
        for chunk in moved.chunks(500) {
            if let Err(e) = self.legacy.delete_nodes(ctx, chunk).await {
                warn!(error = %e, "studio-artifact-ingest: the old store's copies could not all be removed");
                break;
            }
        }
        info!(
            nodes,
            relations = linked,
            skipped,
            "studio-artifact-ingest: artifacts moved into the domain model"
        );
        Ok(())
    }

    async fn write_nodes(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        nodes: &[GtsNode],
    ) -> anyhow::Result<()> {
        let mut by_entity: HashMap<&'static str, Vec<OwnedObject>> = HashMap::new();
        for n in nodes {
            let Some(entity) = entity_of(n.type_id) else {
                warn!(
                    type_id = n.type_id,
                    "studio-artifact-ingest: no model type for this artifact type — not stored"
                );
                continue;
            };
            by_entity.entry(entity).or_default().push(OwnedObject {
                id: object_id(&n.instance_id),
                scope: scope_of(&n.value),
                // What the graph kept is what the model keeps: file content
                // as a bounded excerpt, the whole under the per-object
                // ceiling graph-storage enforces (64 KiB).
                payload: bounded_payload(&n.value),
            });
        }
        for (entity, objects) in by_entity {
            port.put_objects(ctx, entity, objects).await?;
        }
        Ok(())
    }

    async fn write_edges(
        &self,
        ctx: &SecurityContext,
        port: &dyn DomainObjects,
        edges: &[GtsEdge],
    ) -> anyhow::Result<(usize, usize)> {
        let links: Vec<(String, String, String, String)> = edges
            .iter()
            .filter_map(|e| {
                let name = RELATIONS.iter().find(|(r, ..)| *r == e.type_id)?.1;
                Some((
                    RELATION_SOURCE.to_string(),
                    name.to_string(),
                    object_id(&e.from),
                    object_id(&e.to),
                ))
            })
            .collect();
        port.link_objects(ctx, links).await
    }

    fn to_node(artifact_type: &'static str, o: StoredObject) -> GtsNode {
        let mut value = o.payload;
        if let Some(obj) = value.as_object_mut() {
            obj.remove("_scope");
        }
        GtsNode {
            type_id: artifact_type,
            instance_id: artifact_id(&o.instance_id),
            value,
        }
    }

    /// The objects of the listable types `type_filter` names, narrowed by
    /// `where_`.
    async fn read(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        where_: Option<Value>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let port = self.port()?;
        let mut out = Vec::new();
        for artifact_type in gts::resolve_listable_types(type_filter) {
            let Some(entity) = entity_of(artifact_type) else {
                continue;
            };
            let mut body = json!({"type": entity});
            if let Some(w) = &where_ {
                body["where"] = w.clone();
            }
            let (rows, _) = port.query(ctx, body).await?;
            out.extend(rows.into_iter().map(|o| Self::to_node(artifact_type, o)));
        }
        Ok(out)
    }
}

/// The store the service holds: an `Arc` so the background move can keep it.
pub struct ModelGraph(pub Arc<ModelGraphStore>);

#[async_trait]
impl GraphStore for ModelGraph {
    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        let s = &self.0;
        let ready = s.ready(ctx).await;
        let port = s.port()?;
        s.ensure_types(ctx, port.as_ref()).await?;
        s.write_nodes(ctx, port.as_ref(), nodes).await?;
        if !ready {
            s.legacy.upsert_nodes(ctx, nodes).await?;
        }
        Ok(())
    }

    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        let s = &self.0;
        let ready = s.ready(ctx).await;
        let port = s.port()?;
        s.ensure_types(ctx, port.as_ref()).await?;
        s.write_edges(ctx, port.as_ref(), edges).await?;
        if !ready {
            s.legacy.upsert_edges(ctx, edges).await?;
        }
        Ok(())
    }

    async fn delete_nodes(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<usize> {
        let s = &self.0;
        let ready = s.ready(ctx).await;
        let port = s.port()?;
        let mut by_entity: HashMap<&'static str, Vec<String>> = HashMap::new();
        for n in nodes {
            if let Some(entity) = entity_of(n.type_id) {
                by_entity
                    .entry(entity)
                    .or_default()
                    .push(object_id(&n.instance_id));
            }
        }
        let mut removed = 0;
        for (entity, ids) in by_entity {
            removed += port.remove_objects(ctx, entity, ids).await?;
        }
        if !ready {
            return s.legacy.delete_nodes(ctx, nodes).await;
        }
        Ok(removed)
    }

    async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let s = &self.0;
        if !s.ready(ctx).await {
            return s.legacy.search(ctx, text, limit).await;
        }
        let port = s.port()?;
        let entities: Vec<&str> = KINDS.iter().map(|(_, e)| *e).collect();
        let hits = port.search(ctx, text, &entities, limit).await?;
        let mut out: Vec<GtsNode> = hits
            .into_iter()
            .filter_map(|(type_id, o)| {
                let leaf = type_id
                    .trim_end_matches('~')
                    .trim_end_matches(".v1")
                    .rsplit('.')
                    .next()
                    .unwrap_or_default()
                    .replace('_', "-");
                let artifact_type = artifact_of_entity(&leaf)?;
                Some(ModelGraphStore::to_node(artifact_type, o))
            })
            .collect();
        // A hit on a file's text answers as the file, as the old store did.
        let content: Vec<String> = out
            .iter()
            .filter(|n| n.type_id == gts::FILE_CONTENT_TYPE)
            .filter_map(|n| {
                n.value
                    .get("file")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        out.retain(|n| n.type_id != gts::FILE_CONTENT_TYPE);
        if !content.is_empty() {
            let have: HashSet<String> = out.iter().map(|n| n.instance_id.clone()).collect();
            let wanted: Vec<Value> = content
                .iter()
                .filter(|id| !have.contains(*id))
                .map(|id| Value::String(object_id(id)))
                .collect();
            if !wanted.is_empty() {
                let (rows, _) = port
                    .query(
                        ctx,
                        json!({"type": "repository-file", "where": {"id": {"_in": wanted}}}),
                    )
                    .await?;
                out.extend(
                    rows.into_iter()
                        .map(|o| ModelGraphStore::to_node(gts::FILE_TYPE, o)),
                );
            }
        }
        out.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(out)
    }

    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Arc<Vec<GtsNode>>> {
        let s = &self.0;
        if !s.ready(ctx).await {
            return s.legacy.list(ctx, type_filter).await;
        }
        Ok(Arc::new(s.read(ctx, type_filter, None).await?))
    }

    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        let s = &self.0;
        if !s.ready(ctx).await {
            return s.legacy.list_relations(ctx).await;
        }
        let names: Vec<&str> = RELATIONS.iter().map(|(_, n, ..)| *n).collect();
        let port = s.port()?;
        Ok(port
            .relations(ctx, &names)
            .await?
            .into_iter()
            .filter_map(|(name, from, to)| {
                let type_id = RELATIONS.iter().find(|(_, n, ..)| *n == name)?.0;
                Some(GtsEdgeView {
                    type_id: type_id.to_string(),
                    from: artifact_id(&from),
                    to: artifact_id(&to),
                })
            })
            .collect())
    }

    fn stored_payload(&self, value: &Value) -> Value {
        bounded_payload(value)
    }

    async fn list_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let s = &self.0;
        if !s.ready(ctx).await {
            return s.legacy.list_in_scope(ctx, type_filter, scope).await;
        }
        let w = json!({"_or": [{"workspace_id": {"_eq": scope}}, {"project_id": {"_eq": scope}}]});
        s.read(ctx, type_filter, Some(w)).await
    }

    async fn count_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<u64> {
        let n = self.list_in_scope(ctx, type_filter, scope).await?.len();
        Ok(u64::try_from(n).unwrap_or(u64::MAX))
    }

    async fn files_in_scope(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<IngestedFile>> {
        Ok(self
            .list_in_scope(ctx, Some(gts::FILE_TYPE), scope)
            .await?
            .iter()
            .filter_map(ingested_file)
            .collect())
    }

    async fn page(
        &self,
        ctx: &SecurityContext,
        query: &NodePageQuery<'_>,
    ) -> anyhow::Result<NodePage> {
        let s = &self.0;
        if !s.ready(ctx).await {
            return s.legacy.page(ctx, query).await;
        }
        let nodes = match query.scope {
            Some(scope) => self.list_in_scope(ctx, query.type_filter, scope).await?,
            None => s.read(ctx, query.type_filter, None).await?,
        };
        Ok(page_of_nodes(&nodes, query))
    }
}

#[cfg(test)]
#[path = "model_store_tests.rs"]
mod tests;

/// The artifact graph kept in the old store again (`storage.artifacts:
/// graph`), with what the model holds moved back on a tenant's first touch:
/// the switch is never one-way, and nothing is kept twice. Synced artifacts
/// would come back with the next sync anyway; members' mapping decisions and
/// the IDE's builds would not.
pub struct ReturningGraph(pub Arc<ModelGraphStore>);

impl ModelGraphStore {
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
        let Ok(port) = self.port() else {
            return;
        };
        let p = port.as_ref();
        let result = async {
            let (marked, _) = p
                .query(ctx, json!({"type": "sync-state", "where": {"id": {"_eq": MOVED_MARKER}}, "limit": 1}))
                .await?;
            if !marked
                .first()
                .is_some_and(|o| o.payload.get("status").and_then(Value::as_str) != Some("returned"))
            {
                return anyhow::Ok(0usize);
            }
            let nodes = self.read(ctx, None, None).await?;
            let names: Vec<&str> = RELATIONS.iter().map(|(_, n, ..)| *n).collect();
            let edges: Vec<GtsEdge> = p
                .relations(ctx, &names)
                .await?
                .into_iter()
                .filter_map(|(name, from, to)| {
                    let type_id = RELATIONS.iter().find(|(_, n, ..)| *n == name)?.0;
                    Some(GtsEdge { type_id, from: artifact_id(&from), to: artifact_id(&to) })
                })
                .collect();
            self.legacy.upsert_nodes(ctx, &nodes).await?;
            self.legacy.upsert_edges(ctx, &edges).await?;
            let mut by_entity: HashMap<&'static str, Vec<String>> = HashMap::new();
            for n in &nodes {
                if let Some(entity) = entity_of(n.type_id) {
                    by_entity.entry(entity).or_default().push(object_id(&n.instance_id));
                }
            }
            for (entity, ids) in by_entity {
                for chunk in ids.chunks(500) {
                    p.remove_objects(ctx, entity, chunk.to_vec()).await?;
                }
            }
            p.put_objects(
                ctx,
                "sync-state",
                vec![OwnedObject {
                    id: MOVED_MARKER.to_string(),
                    scope: String::new(),
                    payload: json!({"status": "returned", "message": "artifacts moved back to the graph store"}),
                }],
            )
            .await?;
            anyhow::Ok(nodes.len())
        }
        .await;
        match result {
            Ok(n) => {
                if n > 0 {
                    info!(
                        nodes = n,
                        "studio-artifact-ingest: artifacts moved back to the graph store"
                    );
                }
                if let Ok(mut m) = self.moved.lock() {
                    m.insert(tenant);
                }
            }
            Err(e) => {
                warn!(error = %e, "studio-artifact-ingest: artifacts could not move back yet")
            }
        }
    }
}

#[async_trait]
impl GraphStore for ReturningGraph {
    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.upsert_nodes(ctx, nodes).await
    }
    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.upsert_edges(ctx, edges).await
    }
    async fn delete_nodes(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<usize> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.delete_nodes(ctx, nodes).await
    }
    async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.search(ctx, text, limit).await
    }
    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Arc<Vec<GtsNode>>> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.list(ctx, type_filter).await
    }
    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.list_relations(ctx).await
    }
    fn stored_payload(&self, value: &Value) -> Value {
        self.0.legacy.stored_payload(value)
    }
    async fn list_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.list_in_scope(ctx, type_filter, scope).await
    }
    async fn count_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<u64> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.count_in_scope(ctx, type_filter, scope).await
    }
    async fn files_in_scope(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<IngestedFile>> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.files_in_scope(ctx, scope).await
    }
    async fn page(
        &self,
        ctx: &SecurityContext,
        query: &NodePageQuery<'_>,
    ) -> anyhow::Result<NodePage> {
        self.0.back_to_graph(ctx).await;
        self.0.legacy.page(ctx, query).await
    }
}

/// The artifact store's part in the start-up sweep: per organization.
pub struct ArtifactMover {
    pub store: Arc<ModelGraphStore>,
    pub returning: bool,
}

#[async_trait]
impl crate::model_sweep::TenantMover for ArtifactMover {
    fn name(&self) -> &str {
        "studio-artifact-ingest"
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        if tenant != ctx.subject_tenant_id() {
            return Ok(());
        }
        if self.returning {
            self.store.back_to_graph(ctx).await;
        } else {
            self.store.ready(ctx).await;
        }
        Ok(())
    }
}

/// What the graph keeps of a node's payload (`graph_backend`); a build
/// without graph-storage has no graph to bound it for.
#[cfg(feature = "graph")]
fn bounded_payload(value: &Value) -> Value {
    super::graph_backend::bounded_payload(value)
}

#[cfg(not(feature = "graph"))]
fn bounded_payload(value: &Value) -> Value {
    value.clone()
}
