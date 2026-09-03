//! Catalog orchestration: crates.io → typed GTS nodes → graph store.
//!
//! A sync lists every crate under the configured keyword, fetches each crate's
//! detail (with its version history), normalizes them to `gear` and
//! `crate_version` nodes joined by `has_version`, and upserts them into a graph
//! store. Like artifact-ingest it prefers the real graph-storage gear and falls
//! back to an in-memory store so the pipeline still runs (and the portal still
//! shows a catalog) when the graph feature is off.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::anyhow;
use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::cratesio::{CrateDetail, CratesIoClient};
use super::gts::{self, GtsEdge, GtsNode};
use super::tasks::{TaskRecord, TaskRegistry};

/// Pause between crates.io detail calls — crates.io asks callers to stay near
/// ~1 request/second. One gear = one detail call, so this paces the whole sync.
const THROTTLE: Duration = Duration::from_millis(250);

// ── Graph sink ────────────────────────────────────────────────────────────

/// Where catalog nodes and edges are written and read. Two implementations: the
/// real graph-storage gear, and an in-memory fallback.
#[async_trait]
pub(crate) trait CatalogSink: Send + Sync {
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()>;
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> anyhow::Result<()>;
    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>>;
}

/// In-memory store, keyed by instance id so a re-sync upserts. Resets on
/// restart; the catalog is cheap to re-sync.
#[derive(Default)]
pub(crate) struct MemorySink {
    nodes: Mutex<HashMap<String, GtsNode>>,
}

#[async_trait]
impl CatalogSink for MemorySink {
    async fn register_types(&self, _ctx: &SecurityContext) -> anyhow::Result<()> {
        Ok(())
    }

    async fn upsert(
        &self,
        _ctx: &SecurityContext,
        nodes: &[GtsNode],
        _edges: &[GtsEdge],
    ) -> anyhow::Result<()> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        for n in nodes {
            map.insert(n.instance_id.clone(), n.clone());
        }
        Ok(())
    }

    async fn list(
        &self,
        _ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        Ok(map
            .values()
            .filter(|n| type_filter.is_none_or(|t| n.type_id.contains(t)))
            .cloned()
            .collect())
    }
}

/// Human name for a node, from the curated payload. Used by the graph backend.
#[cfg(feature = "graph")]
fn node_name(value: &Value) -> Option<String> {
    for key in ["title", "name"] {
        if let Some(s) = value.get(key).and_then(Value::as_str)
            && !s.trim().is_empty()
        {
            return Some(s.to_string());
        }
    }
    None
}

/// The real graph-storage backend. Behind the `graph` feature (the gear is).
///
/// The search text and the embedding input are the gear's to compose, from
/// the payload paths the catalog types declare (`gts::graph_node_type_schemas`),
/// so nothing here builds a `search_text` or a vector.
#[cfg(feature = "graph")]
pub(crate) struct GraphSink {
    client: Arc<dyn graph_storage_sdk::GraphStorageClientV1>,
}

#[cfg(feature = "graph")]
impl GraphSink {
    pub(crate) fn new(client: Arc<dyn graph_storage_sdk::GraphStorageClientV1>) -> Self {
        Self { client }
    }
}

#[cfg(feature = "graph")]
#[async_trait]
impl CatalogSink for GraphSink {
    /// One atomic batch, idempotent: a byte-identical re-registration
    /// converges. Each type derives from a graph-storage family — a free-form
    /// type has no chain to validate against and is refused.
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        use graph_storage_sdk::models::TypeRegistration;
        let batch: Vec<TypeRegistration> = gts::graph_node_type_schemas()
            .into_iter()
            .chain(gts::graph_edge_type_schemas())
            .map(|schema| TypeRegistration {
                type_id: schema
                    .get("$id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim_start_matches("gts://")
                    .to_string(),
                schema,
            })
            .collect();
        self.client
            .register_types(ctx, batch)
            .await
            .map_err(|e| anyhow!("register catalog types: {e}"))?;
        Ok(())
    }

    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> anyhow::Result<()> {
        use graph_storage_sdk::models::{EdgeSpec, IngestOptions, IngestRequest, NodeSpec};
        if nodes.is_empty() && edges.is_empty() {
            return Ok(());
        }
        let node_specs: Vec<NodeSpec> = nodes
            .iter()
            .map(|n| NodeSpec {
                node_key: n.instance_id.clone(),
                type_id: gts::graph_type_id(n.type_id),
                name: node_name(&n.value),
                payload: Some(n.value.clone()),
                expected_version: None,
            })
            .collect();
        let edge_specs: Vec<EdgeSpec> = edges
            .iter()
            .map(|e| EdgeSpec {
                type_id: gts::graph_type_id(e.type_id),
                src_node_key: e.from.clone(),
                dst_node_key: e.to.clone(),
                discriminator: None,
                payload: None,
            })
            .collect();
        // One atomic ingest: the gear upserts nodes then wires the edges to the
        // keys just written, so a gear and its versions commit together. No
        // phantoms: an edge whose endpoint is not in the batch is our bug.
        self.client
            .ingest(
                ctx,
                IngestRequest {
                    nodes: node_specs,
                    edges: edge_specs,
                    options: IngestOptions {
                        create_phantoms: Some(false),
                        report_per_item: false,
                        embed: Some(true),
                    },
                    replace_scope: None,
                    idempotency_key: None,
                },
            )
            .await
            .map_err(|e| anyhow!("graph-storage ingest: {e}"))?;
        Ok(())
    }

    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        use toolkit_odata::{CursorV1, ODataQuery};
        // The gear's `projection_max_page`; a larger `$top` is refused, not clamped.
        const PAGE: u64 = 200;
        let patterns: Vec<String> = gts::ALL_NODE_TYPES
            .into_iter()
            .filter(|t| type_filter.is_none_or(|f| t.contains(f)))
            .map(gts::graph_type_id)
            .collect();
        if patterns.is_empty() {
            return Ok(Vec::new());
        }
        let mut out: Vec<GtsNode> = Vec::new();
        let mut query = ODataQuery::default().with_limit(PAGE);
        loop {
            let page = self
                .client
                .project_nodes(ctx, &patterns, query.clone())
                .await
                .map_err(|e| anyhow!("graph-storage projection: {e}"))?;
            for row in page.items {
                let Some(type_id) = gts::our_type_from_graph(&row.type_id) else {
                    continue;
                };
                out.push(GtsNode {
                    type_id,
                    instance_id: row.node_key,
                    value: row.payload.unwrap_or_else(|| json!({})),
                });
            }
            let Some(next) = page.page_info.next_cursor else {
                break;
            };
            let cursor = CursorV1::decode(&next)
                .map_err(|e| anyhow!("graph-storage returned an undecodable cursor: {e}"))?;
            query = ODataQuery::default().with_limit(PAGE).with_cursor(cursor);
        }
        Ok(out)
    }
}

// ── Service ─────────────────────────────────────────────────────────────────

pub struct CatalogService {
    crates: CratesIoClient,
    sink: Arc<dyn CatalogSink>,
    tasks: Arc<TaskRegistry>,
    keyword: String,
}

impl CatalogService {
    pub fn new(sink: Arc<dyn CatalogSink>, keyword: String) -> Self {
        Self {
            crates: CratesIoClient::new(),
            sink,
            tasks: Arc::new(TaskRegistry::default()),
            keyword,
        }
    }

    pub fn task(&self, id: &str) -> Option<TaskRecord> {
        self.tasks.get(id)
    }

    /// Enqueue a background catalog sync and return its task id.
    pub fn enqueue_sync(self: &Arc<Self>, ctx: SecurityContext) -> String {
        let id = Uuid::new_v4().to_string();
        self.tasks.create(&id);
        let svc = Arc::clone(self);
        let task_id = id.clone();
        tokio::spawn(async move {
            match svc.run_sync(&ctx, Some(&task_id)).await {
                Ok((gears, versions, stored)) => {
                    svc.tasks
                        .succeed(&task_id, gears as u32, versions as u32, stored as u32)
                }
                Err(e) => svc.tasks.fail(&task_id, &format!("{e:#}")),
            }
        });
        id
    }

    /// List every crate under the keyword, fetch each one's detail, and upsert a
    /// gear node + its version nodes (joined by `has_version`) into the graph.
    /// Flushed per gear so objects appear as the sync runs. Returns
    /// (gears, versions, stored-nodes).
    pub async fn run_sync(
        &self,
        ctx: &SecurityContext,
        task_id: Option<&str>,
    ) -> anyhow::Result<(usize, usize, usize)> {
        self.sink.register_types(ctx).await?;
        self.report(task_id, "listing gears…", 0, 0, 0);

        let summaries = self.crates.list_by_keyword(&self.keyword).await?;
        let total = summaries.len();
        tracing::info!(keyword = %self.keyword, gears = total, "gears-catalog: listed crates");

        let mut versions_total = 0usize;
        let mut stored = 0usize;
        for (i, s) in summaries.iter().enumerate() {
            self.report(
                task_id,
                &format!("fetching {} ({}/{})", s.name, i + 1, total),
                i as u32,
                versions_total as u32,
                stored as u32,
            );

            let detail = match self.crates.crate_detail(&s.name).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(crate = %s.name, error = %e, "gears-catalog: detail fetch failed — skipping");
                    continue;
                }
            };

            let (nodes, edges, vers) = build_gear(&detail);
            versions_total += vers;
            self.sink.upsert(ctx, &nodes, &edges).await?;
            stored += nodes.len();

            self.report(
                task_id,
                &format!("stored {} ({}/{})", s.name, i + 1, total),
                (i + 1) as u32,
                versions_total as u32,
                stored as u32,
            );
            // Be gentle with crates.io (≈1 req/s guidance; detail is one call).
            tokio::time::sleep(THROTTLE).await;
        }

        tracing::info!(
            gears = total,
            versions = versions_total,
            stored,
            "gears-catalog: sync stored"
        );
        Ok((total, versions_total, stored))
    }

    /// Read back catalog nodes, optionally filtered by type substring
    /// (`gear`, `crate_version`).
    pub async fn list_nodes(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.sink.list(ctx, type_filter).await
    }

    /// Read the editable, Studio-owned metadata for all catalogued gears.
    pub async fn list_profiles(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsNode>> {
        self.sink.list(ctx, Some("gear_profile")).await
    }

    /// Upsert a gear profile without touching the crates.io-owned catalog node.
    /// The profile is deliberately an open JSON object: platform teams can add
    /// a field to their delivery model without a backend migration.
    pub async fn save_profile(
        &self,
        ctx: &SecurityContext,
        gear_name: &str,
        profile: Value,
    ) -> anyhow::Result<GtsNode> {
        let gear_name = gear_name.trim();
        if gear_name.is_empty()
            || gear_name.len() > 128
            || !gear_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            anyhow::bail!("gear name must be a crate-style identifier");
        }
        let mut value = profile
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("gear profile must be a JSON object"))?;
        value.insert("gear_name".to_owned(), Value::String(gear_name.to_owned()));
        value
            .entry("title".to_owned())
            .or_insert_with(|| Value::String(gear_name.to_owned()));
        let node = gts::gear_profile_node(gear_name, Value::Object(value));
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(node)
    }

    fn report(&self, task_id: Option<&str>, message: &str, gears: u32, versions: u32, stored: u32) {
        if let Some(id) = task_id {
            self.tasks.report(id, message, gears, versions, stored);
        }
    }
}

/// Build a gear node, its version nodes and the `has_version` edges from one
/// crate's detail. Returns (nodes, edges, version-count).
fn build_gear(detail: &CrateDetail) -> (Vec<GtsNode>, Vec<GtsEdge>, usize) {
    let name = detail.krate.name.clone();
    let gear_id = gts::gear_instance_id(&name);

    let gear_value = json!({
        "title": name,
        "name": name,
        "kind": classify_kind(&name),
        "description": detail.krate.description,
        "max_version": detail.krate.max_version,
        "newest_version": detail.krate.newest_version,
        "max_stable_version": detail.krate.max_stable_version,
        "num_versions": detail.krate.num_versions,
        "downloads": detail.krate.downloads,
        "recent_downloads": detail.krate.recent_downloads,
        "created_at": detail.krate.created_at,
        "updated_at": detail.krate.updated_at,
        "repository": detail.krate.repository,
        "documentation": detail.krate.documentation,
        "homepage": detail.krate.homepage,
        "keywords": detail.keywords,
        "categories": detail.categories,
    });

    let mut nodes: Vec<GtsNode> = Vec::with_capacity(detail.versions.len() + 1);
    let mut edges: Vec<GtsEdge> = Vec::with_capacity(detail.versions.len());
    nodes.push(gts::gear_node(&name, gear_value));

    for v in &detail.versions {
        let published_by = v
            .published_by
            .as_ref()
            .and_then(|p| p.name.clone().or_else(|| p.login.clone()));
        let vvalue = json!({
            "title": format!("{name}@{}", v.num),
            "crate": name,
            "num": v.num,
            "created_at": v.created_at,
            "updated_at": v.updated_at,
            "yanked": v.yanked,
            "yank_message": v.yank_message,
            "license": v.license,
            "rust_version": v.rust_version,
            "edition": v.edition,
            "crate_size": v.crate_size,
            "downloads": v.downloads,
            "has_lib": v.has_lib,
            "published_by": published_by,
        });
        let vnode = gts::crate_version_node(&name, &v.num, vvalue);
        edges.push(gts::has_version_edge(&gear_id, &vnode.instance_id));
        nodes.push(vnode);
    }

    let vers = detail.versions.len();
    (nodes, edges, vers)
}

/// Classify a crate by name so the UI can group them: gear / sdk / plugin /
/// toolkit. Purely cosmetic — the graph keeps the full name.
fn classify_kind(name: &str) -> &'static str {
    if name.contains("toolkit") {
        "toolkit"
    } else if name.ends_with("-sdk") {
        "sdk"
    } else if name.contains("-plugin") {
        "plugin"
    } else {
        "gear"
    }
}
