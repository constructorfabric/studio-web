//! The real graph store: the graph-storage gear, through its published SDK.
//!
//! Adapts our [`GraphStore`] contract onto `GraphStorageClientV1` (in-process,
//! tenant-scoped). Artifact nodes become graph-storage nodes keyed on their
//! deterministic instance id, so a re-sync converges. File *content* never goes
//! into the graph as such — the graph is not a blob store, and a payload is
//! capped at 64 KiB — only the metadata plus a bounded excerpt of the text,
//! which is what lexical and vector search index.
//!
//! Only compiled with the `graph` feature (the gear itself is behind it).

use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use toolkit_security::SecurityContext;

use std::collections::HashSet;

use toolkit_odata::ODataQuery;

use super::graph::{GraphStore, GtsEdge, GtsEdgeView, GtsNode};
use super::gts;
use graph_storage_sdk::GraphStorageClientV1;
use graph_storage_sdk::models::{
    AdjacencySide, EdgeSpec, IngestOptions, IngestRequest, NodeSpec, SearchMode, SearchRequest,
    TypeRegistration,
};

/// Nodes per ingest batch. Under the gear's `ingest_max_nodes` (10k) with room
/// to spare, so a repo with many files still commits in a few atomic batches.
const INGEST_CHUNK: usize = 2_000;
/// Page size when reading nodes back for the portal.
const LIST_PAGE: u32 = 500;
/// Incident edges to read per node. Above the fan-out of an issue or PR in
/// this graph (author, repo, changed files), and truncation is logged rather
/// than silently dropping relations.
const ADJACENCY_LIMIT: u32 = 100;
/// Keep a node payload comfortably under the gear's 64 KiB ceiling; an oversized
/// one would fail the whole atomic batch.
const MAX_PAYLOAD_BYTES: usize = 60_000;
/// How much of a file's text travels into the graph as `text_excerpt`. It is
/// what search — lexical and semantic — sees of a file's *content*; the whole
/// file stays in file storage. The gear itself caps the embedding input at its
/// `embedding_input_max_bytes` (8 KiB by default), so more than this would
/// bloat the lexical index without reaching the vector.
const MAX_TEXT_EXCERPT_CHARS: usize = 8_000;
/// Per-arm candidate count for hybrid search, before fusion.
const SEARCH_ARM_LIMIT: u32 = 50;

pub struct GraphStorageBackend {
    client: Arc<dyn GraphStorageClientV1>,
}

impl GraphStorageBackend {
    pub fn new(client: Arc<dyn GraphStorageClientV1>) -> Self {
        Self { client }
    }

    /// Register our artifact node and relation types.
    ///
    /// One atomic batch, idempotent: a byte-identical re-registration
    /// converges, so this runs before every write without cost. Each type
    /// derives from a graph-storage family — a free-form type has no chain to
    /// validate against and is refused.
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
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
            .map_err(|e| anyhow::anyhow!("register artifact types: {e}"))?;
        Ok(())
    }

    /// A node with its payload, by key. The search surface returns keys and
    /// names only; the portal wants the normalized value too.
    async fn node_by_key(
        &self,
        ctx: &SecurityContext,
        key: &str,
        type_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let Some(our_type) = gts::our_type_from_graph(type_id) else {
            return Ok(None);
        };
        let view = self
            .client
            .get_node(ctx, &key.to_owned(), Some(1))
            .await
            .map_err(|e| anyhow::anyhow!("graph-storage node read: {e}"))?;
        Ok(Some(GtsNode {
            type_id: our_type,
            instance_id: view.node_key,
            value: view.payload.unwrap_or_else(|| json!({})),
        }))
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

/// Truncate `s` to at most `max_chars` characters.
fn excerpt(s: &str, max_chars: usize) -> String {
    let end = s
        .char_indices()
        .map(|(i, _)| i)
        .nth(max_chars)
        .unwrap_or(s.len());
    s[..end].to_string()
}

/// The payload to store: the node value minus file content, plus a bounded
/// `text_excerpt` of that content, all under the gear's per-node ceiling
/// (drop the free-text `body` if it pushes us over).
fn bounded_payload(value: &Value) -> Value {
    let mut obj = match value {
        Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };
    // File content is referenced by has_text, never stored whole in the graph.
    // What search sees of it is the excerpt, which the type declares as a
    // searchable and vectorizable path.
    if let Some(text) = obj.remove("text").as_ref().and_then(Value::as_str)
        && !text.trim().is_empty()
    {
        obj.insert(
            "text_excerpt".to_string(),
            Value::String(excerpt(text, MAX_TEXT_EXCERPT_CHARS)),
        );
    }
    let too_big = |m: &serde_json::Map<String, Value>| {
        serde_json::to_vec(m).map(|v| v.len()).unwrap_or(0) > MAX_PAYLOAD_BYTES
    };
    if too_big(&obj) {
        obj.remove("text_excerpt");
    }
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

/// The searchable text and the embedding input are composed by the gear from
/// the payload paths the type declares, so neither is supplied per node.
fn to_node_spec(n: &GtsNode) -> NodeSpec {
    NodeSpec {
        node_key: n.instance_id.clone(),
        type_id: gts::graph_type_id(n.type_id),
        name: Some(node_name(&n.value)).filter(|s| !s.is_empty()),
        payload: Some(bounded_payload(&n.value)),
        expected_version: None,
    }
}

fn to_edge_spec(e: &GtsEdge) -> EdgeSpec {
    EdgeSpec {
        type_id: gts::graph_type_id(e.type_id),
        src_node_key: e.from.clone(),
        dst_node_key: e.to.clone(),
        discriminator: None,
        payload: None,
    }
}

/// One ingest batch. Phantom endpoints are disabled: an edge whose endpoint is
/// missing is a bug in the pipeline's ordering, and a phantom would hide it.
/// Nodes are embedded by the gear on write.
fn batch(nodes: Vec<NodeSpec>, edges: Vec<EdgeSpec>) -> IngestRequest {
    IngestRequest {
        nodes,
        edges,
        options: IngestOptions {
            create_phantoms: Some(false),
            report_per_item: false,
            embed: Some(true),
        },
        replace_scope: None,
        idempotency_key: None,
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

        let specs: Vec<NodeSpec> = nodes.iter().map(to_node_spec).collect();
        let mut upserted = 0u64;
        let mut revision = 0i64;
        for chunk in specs.chunks(INGEST_CHUNK) {
            let res = self
                .client
                .ingest(ctx, batch(chunk.to_vec(), Vec::new()))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage ingest: {e}"))?;
            upserted += res.counts.nodes_inserted + res.counts.nodes_updated;
            revision = res.revision.revision;
        }
        tracing::info!(
            batch = nodes.len(),
            nodes_upserted = upserted,
            graph_revision = revision,
            "studio-artifact-ingest: graph-storage upsert"
        );
        Ok(())
    }

    /// Hybrid retrieval: the gear embeds the query with the deployment's
    /// provider, ranks the vector and lexical arms and fuses them. Hits carry
    /// keys and names; the payload comes from a node read per hit.
    async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.register_types(ctx).await?;
        let patterns: Vec<String> = gts::ALL_NODE_TYPES
            .into_iter()
            .map(gts::graph_type_id)
            .collect();
        let response = self
            .client
            .search(
                ctx,
                SearchRequest {
                    mode: SearchMode::Hybrid,
                    query: Some(text.to_owned()),
                    arm_limit: SEARCH_ARM_LIMIT.max(limit),
                    limit,
                    type_patterns: patterns,
                },
            )
            .await
            .map_err(|e| anyhow::anyhow!("graph-storage search: {e}"))?;
        let mut out = Vec::with_capacity(response.hits.len());
        for hit in response.hits {
            if let Some(node) = self.node_by_key(ctx, &hit.node_key, &hit.type_id).await? {
                out.push(node);
            }
        }
        Ok(out)
    }

    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        if edges.is_empty() {
            return Ok(());
        }
        self.register_types(ctx).await?;

        let specs: Vec<EdgeSpec> = edges.iter().map(to_edge_spec).collect();
        let mut upserted = 0u64;
        for chunk in specs.chunks(INGEST_CHUNK) {
            let res = self
                .client
                .ingest(ctx, batch(Vec::new(), chunk.to_vec()))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage edge ingest: {e}"))?;
            upserted += res.counts.edges_inserted + res.counts.edges_updated;
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
        // Ensure our types exist before narrowing by them, so a read before the
        // first ingest returns empty rather than tripping on an unknown type.
        self.register_types(ctx).await?;

        let patterns: Vec<String> = gts::ALL_NODE_TYPES
            .into_iter()
            .filter(|t| type_filter.is_none_or(|f| t.contains(f)))
            .map(gts::graph_type_id)
            .collect();
        if patterns.is_empty() {
            return Ok(Vec::new());
        }

        let mut out: Vec<GtsNode> = Vec::new();
        let mut query = ODataQuery::default().with_limit(u64::from(LIST_PAGE));
        loop {
            let page = self
                .client
                .project_nodes(ctx, &patterns, query.clone())
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage projection: {e}"))?;
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
            query = ODataQuery::default()
                .with_limit(u64::from(LIST_PAGE))
                .with_cursor(parse_cursor(&next)?);
        }
        Ok(out)
    }

    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        self.register_types(ctx).await?;

        // The sources of the cross-relations the portal draws. Their outgoing
        // edges come back with the node itself: a node read carries bounded
        // adjacency, so the relations need no separate edge listing. Users are
        // only edge targets; files are excluded to avoid a per-file read on
        // large repos (file↔file duplicate links are the one relation this
        // omits — a known follow-up).
        let seeds: Vec<String> = self
            .list(ctx, None)
            .await?
            .into_iter()
            .filter(|n| n.type_id != gts::USER_TYPE && n.type_id != gts::FILE_TYPE)
            .map(|n| n.instance_id)
            .collect();

        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<GtsEdgeView> = Vec::new();
        for key in seeds {
            let view = self
                .client
                .get_node(ctx, &key, Some(ADJACENCY_LIMIT))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage node read: {e}"))?;
            if view.adjacency_truncated {
                tracing::warn!(
                    node = %key,
                    limit = ADJACENCY_LIMIT,
                    "studio-artifact-ingest: adjacency truncated; some relations are not shown"
                );
            }
            for entry in view.adjacency {
                if entry.side != AdjacencySide::Outgoing {
                    continue;
                }
                let type_id = our_edge_type(&entry.edge_type_id);
                let to = entry.neighbor_key;
                if seen.insert(format!("{type_id}|{key}|{to}")) {
                    out.push(GtsEdgeView {
                        type_id,
                        from: key.clone(),
                        to,
                    });
                }
            }
        }
        Ok(out)
    }
}

/// Decode a `CursorV1` continuation token handed back by the projection.
fn parse_cursor(raw: &str) -> anyhow::Result<toolkit_odata::CursorV1> {
    toolkit_odata::CursorV1::decode(raw)
        .map_err(|e| anyhow::anyhow!("graph-storage returned an undecodable cursor: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_text_becomes_a_bounded_excerpt() {
        let long = "x".repeat(MAX_TEXT_EXCERPT_CHARS + 100);
        let payload = bounded_payload(&json!({ "path": "a.md", "text": long, "has_text": true }));
        assert!(payload.get("text").is_none());
        assert_eq!(
            payload["text_excerpt"].as_str().map(str::len),
            Some(MAX_TEXT_EXCERPT_CHARS)
        );
        assert_eq!(payload["path"], "a.md");
    }

    #[test]
    fn an_empty_text_leaves_no_excerpt() {
        let payload = bounded_payload(&json!({ "path": "a.bin", "text": "  " }));
        assert!(payload.get("text_excerpt").is_none());
    }
}
