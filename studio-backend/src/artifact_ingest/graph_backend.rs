//! The real graph store: the vendored graph-storage gear.
//!
//! Adapts our [`GraphStore`] contract onto `GraphStorageClientV1` (in-process,
//! tenant-scoped). Artifact nodes become graph-storage nodes keyed on their
//! deterministic instance id, so a re-sync converges. File *content* never goes
//! into the graph — it is stripped here (the graph is not a blob store; the doc
//! caps a payload at 64 KiB) — only the metadata.
//!
//! Only compiled with the `graph` feature (the gear itself is behind it).

use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use toolkit_security::SecurityContext;

use std::collections::{HashMap, HashSet};

use super::graph::{GraphStore, GtsEdge, GtsEdgeView, GtsNode};
use super::gts;
use crate::graph_storage::sdk::{Direction, EdgeInput, GraphStorageClientV1, NodeInput};

/// Nodes per ingest batch. Under the gear's `ingest_max_nodes` (10k) with room
/// to spare, so a repo with many files still commits in a few atomic batches.
const INGEST_CHUNK: usize = 2_000;
/// Page size when reading nodes back for the portal.
const LIST_PAGE: u32 = 500;
/// Keep a node payload comfortably under the gear's 64 KiB ceiling; an oversized
/// one would fail the whole atomic batch.
const MAX_PAYLOAD_BYTES: usize = 60_000;

pub struct GraphStorageBackend {
    client: Arc<dyn GraphStorageClientV1>,
}

impl GraphStorageBackend {
    pub fn new(client: Arc<dyn GraphStorageClientV1>) -> Self {
        Self { client }
    }

    /// Register our artifact node and relation types (idempotent — the gear
    /// interns them). Nodes as `node`, relations as `edge`.
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        for t in gts::ALL_NODE_TYPES {
            self.client
                .register_type(ctx, &gts::graph_type_id(t), "node", None)
                .await
                .map_err(|e| anyhow::anyhow!("register type {t}: {e}"))?;
        }
        for t in gts::ALL_EDGE_TYPES {
            self.client
                .register_type(ctx, &gts::graph_type_id(t), "edge", None)
                .await
                .map_err(|e| anyhow::anyhow!("register edge type {t}: {e}"))?;
        }
        Ok(())
    }
}

/// A human name for the node, from the fields we normalize.
fn node_name(value: &Value) -> String {
    if let Some(t) = value.get("title").and_then(Value::as_str) {
        return t.to_string();
    }
    if let Some(p) = value.get("path").and_then(Value::as_str) {
        return p.to_string();
    }
    if let Some(f) = value.get("full_path").and_then(Value::as_str) {
        return f.to_string();
    }
    String::new()
}

/// Free text for lexical search: name plus a few searchable fields.
fn search_text(value: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for key in ["title", "path", "full_path", "state", "author"] {
        if let Some(s) = value.get(key).and_then(Value::as_str) {
            parts.push(s.to_string());
        }
    }
    if let Some(labels) = value.get("labels").and_then(Value::as_array) {
        for l in labels {
            if let Some(s) = l.as_str() {
                parts.push(s.to_string());
            }
        }
    }
    parts.join(" ")
}

/// The payload to store: the node value minus file content, bounded to the
/// gear's per-node ceiling (drop the free-text `body` if it pushes us over).
fn bounded_payload(value: &Value) -> Value {
    let mut obj = match value {
        Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };
    // File content is referenced by has_text, never stored in the graph.
    obj.remove("text");
    let too_big = |m: &serde_json::Map<String, Value>| {
        serde_json::to_vec(m).map(|v| v.len()).unwrap_or(0) > MAX_PAYLOAD_BYTES
    };
    if too_big(&obj) {
        obj.remove("body");
    }
    // Last resort: if still oversized (a giant title/label set), drop to the
    // identifying fields only so the batch never fails on one row.
    if too_big(&obj) {
        let keep = ["repo", "external_id", "number", "path", "url", "state"];
        obj.retain(|k, _| keep.contains(&k.as_str()));
    }
    Value::Object(obj)
}

fn to_node_input(n: &GtsNode) -> NodeInput {
    NodeInput {
        node_key: n.instance_id.clone(),
        type_id: gts::graph_type_id(n.type_id),
        name: node_name(&n.value),
        search_text: Some(search_text(&n.value)).filter(|s| !s.is_empty()),
        payload: Some(bounded_payload(&n.value)),
        embedding: None,
    }
}

fn to_edge_input(e: &GtsEdge) -> EdgeInput {
    EdgeInput {
        type_id: gts::graph_type_id(e.type_id),
        from: e.from.clone(),
        to: e.to.clone(),
        payload: None,
    }
}

/// Map a graph-storage edge type id back to our `gts.…` form (reverse of
/// [`gts::graph_type_id`]); fall back to the raw id if it is not one of ours.
fn our_edge_type(graph_type: &str) -> String {
    gts::ALL_EDGE_TYPES
        .into_iter()
        .find(|t| gts::graph_type_id(t) == graph_type)
        .map(str::to_string)
        .unwrap_or_else(|| graph_type.to_string())
}

#[async_trait]
impl GraphStore for GraphStorageBackend {
    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        if nodes.is_empty() {
            return Ok(());
        }
        self.register_types(ctx).await?;

        let inputs: Vec<NodeInput> = nodes.iter().map(to_node_input).collect();
        let mut upserted = 0u64;
        let mut revision = 0u64;
        for chunk in inputs.chunks(INGEST_CHUNK) {
            let res = self
                .client
                .ingest(ctx, chunk, &[])
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage ingest: {e}"))?;
            upserted += res.nodes_upserted;
            revision = res.graph_revision;
        }
        tracing::info!(
            batch = nodes.len(),
            nodes_upserted = upserted,
            graph_revision = revision,
            "studio-artifact-ingest: graph-storage upsert"
        );
        Ok(())
    }

    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        if edges.is_empty() {
            return Ok(());
        }
        self.register_types(ctx).await?;

        let inputs: Vec<EdgeInput> = edges.iter().map(to_edge_input).collect();
        let mut upserted = 0u64;
        for chunk in inputs.chunks(INGEST_CHUNK) {
            let res = self
                .client
                .ingest(ctx, &[], chunk)
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage edge ingest: {e}"))?;
            upserted += res.edges_upserted;
        }
        tracing::info!(
            batch = edges.len(),
            edges_upserted = upserted,
            "studio-artifact-ingest: graph-storage edge upsert"
        );
        Ok(())
    }

    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        // Ensure our types exist before filtering by them, so a read before the
        // first ingest returns empty rather than tripping on an unknown type.
        self.register_types(ctx).await?;

        // Which of our types to read: those whose id contains the filter
        // substring, or all of them.
        let types: Vec<&'static str> = gts::ALL_NODE_TYPES
            .into_iter()
            .filter(|t| type_filter.is_none_or(|f| t.contains(f)))
            .collect();

        let mut out: Vec<GtsNode> = Vec::new();
        for our_type in types {
            let graph_type = gts::graph_type_id(our_type);
            let mut cursor: Option<String> = None;
            loop {
                let page = self
                    .client
                    .list_nodes(ctx, Some(&graph_type), cursor.as_deref(), LIST_PAGE, true)
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage list_nodes: {e}"))?;
                for view in page.items {
                    let type_id = gts::our_type_from_graph(&view.type_id).unwrap_or(our_type);
                    out.push(GtsNode {
                        type_id,
                        instance_id: view.node_key,
                        value: view.payload.unwrap_or_else(|| json!({})),
                    });
                }
                match page.next_cursor {
                    Some(c) => cursor = Some(c),
                    None => break,
                }
            }
        }
        Ok(out)
    }

    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        self.register_types(ctx).await?;

        // One light pass over the nodes: a surrogate-id → instance-key map, and
        // the ids of issue/PR nodes — the sources of the cross-relations we show.
        let mut id_to_key: HashMap<i64, String> = HashMap::new();
        let mut seeds: Vec<i64> = Vec::new();
        for our_type in gts::ALL_NODE_TYPES {
            let graph_type = gts::graph_type_id(our_type);
            let is_seed = our_type == gts::ISSUE_TYPE || our_type == gts::PULL_REQUEST_TYPE;
            let mut cursor: Option<String> = None;
            loop {
                let page = self
                    .client
                    .list_nodes(ctx, Some(&graph_type), cursor.as_deref(), LIST_PAGE, false)
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage list_nodes: {e}"))?;
                for view in page.items {
                    if is_seed {
                        seeds.push(view.id);
                    }
                    id_to_key.insert(view.id, view.node_key);
                }
                match page.next_cursor {
                    Some(c) => cursor = Some(c),
                    None => break,
                }
            }
        }

        // The outgoing edges of each issue/PR: authored_by, artifact_of, modifies.
        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<GtsEdgeView> = Vec::new();
        for id in seeds {
            let mut cursor: Option<String> = None;
            loop {
                let page = self
                    .client
                    .list_edges(
                        ctx,
                        id,
                        Direction::Outgoing,
                        cursor.as_deref(),
                        LIST_PAGE,
                        false,
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage list_edges: {e}"))?;
                for e in page.items {
                    let (Some(from), Some(to)) = (id_to_key.get(&e.src), id_to_key.get(&e.dst))
                    else {
                        continue;
                    };
                    let type_id = our_edge_type(&e.type_id);
                    if seen.insert(format!("{type_id}|{from}|{to}")) {
                        out.push(GtsEdgeView {
                            type_id,
                            from: from.clone(),
                            to: to.clone(),
                        });
                    }
                }
                match page.next_cursor {
                    Some(c) => cursor = Some(c),
                    None => break,
                }
            }
        }
        Ok(out)
    }
}
