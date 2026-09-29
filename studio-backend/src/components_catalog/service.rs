//! Catalog orchestration: crates.io → typed GTS nodes → graph store.
//!
//! A sync lists every crate under the configured keyword, fetches each crate's
//! detail (with its version history), normalizes them to `gear` and
//! `crate_version` nodes joined by `has_version`, and upserts them into a graph
//! store. Like artifact-ingest it prefers the real graph-storage gear and falls
//! back to an in-memory store so the pipeline still runs (and the portal still
//! shows a catalog) when the graph feature is off.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::anyhow;
use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::cratesio::{CrateDetail, CratesIoClient};
use super::field_schema::{self, TypeFieldSchema};
use super::gts::{self, GtsEdge, GtsNode};
use super::repo_enrich::{RepoEnricher, RepoGear, RepoMode};
use super::roadmap::{self, RoadmapSource};
use crate::connectors::service::ConnectorService;
use crate::tasks::registry::SyncReporter;

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
    /// Remove one node by instance id. Reverting an override is deleting the
    /// node that carries it, so a catalogue that can only upsert is a
    /// catalogue whose overrides are one-way.
    ///
    /// A removed node must be writable again under the same key: catalogue
    /// keys are deterministic, and a component that returns to its source
    /// comes back under the id it had.
    async fn delete(&self, ctx: &SecurityContext, instance_id: &str) -> anyhow::Result<()>;
    /// Every node type the graph holds for this tenant — not only the ones
    /// this gear registered. Which of them are components is a judgement an
    /// organization makes, and it cannot make it over a list it cannot see.
    async fn node_types(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GraphNodeType>>;
    /// Nodes of arbitrary types, named by their graph-storage ids.
    ///
    /// The typed [`Self::list`] can only return the types this build knows,
    /// because a [`GtsNode`] carries a `&'static str`. Once an organization
    /// decides what a component is, that is no longer enough: the Components
    /// page has to list nodes of a type this build has never compiled in.
    ///
    /// Stops at `limit` and says so. A tenant can mark any type, including one
    /// with a hundred thousand instances, and a page that tried to render all
    /// of them would be a denial of service the organization aimed at itself.
    async fn list_of_types(
        &self,
        ctx: &SecurityContext,
        graph_types: &[String],
        limit: usize,
    ) -> anyhow::Result<(Vec<CatalogNodeView>, bool)>;
    /// How many nodes of one type the graph holds, counted up to `cap`.
    ///
    /// Counted, not asked for: graph-storage's contract has no count, and its
    /// `node` table is its own business, not ours to query. So this pages a
    /// projection and stops at `cap`, returning `(count, hit_the_cap)` — an
    /// exact number for the types a person is deciding about, and an honest
    /// floor for the ones with more nodes than a page could ever show.
    async fn count_of_type(
        &self,
        ctx: &SecurityContext,
        graph_type: &str,
        cap: usize,
    ) -> anyhow::Result<(usize, bool)>;
}

/// A node of any type, typed only by its id — what a catalogue that no longer
/// decides which types are components has to be able to return.
#[derive(Clone, Debug)]
pub struct CatalogNodeView {
    /// The leaf GTS id of the node's type.
    pub type_id: String,
    pub instance_id: String,
    pub value: Value,
}

/// One node type as graph-storage holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphNodeType {
    /// The id graph-storage stores it under, ancestry and all.
    pub type_id: String,
    /// The leaf of that id — how every other surface names the type, and the
    /// key the studio's per-type records use.
    pub leaf_id: String,
    /// The families and bases, which exist to be derived from and cannot hold
    /// an instance. Never a component; listed so the page can say why.
    pub is_abstract: bool,
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

    async fn delete(&self, _ctx: &SecurityContext, instance_id: &str) -> anyhow::Result<()> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        map.remove(instance_id);
        Ok(())
    }

    /// The types this store has actually seen. It has no ontology of its own,
    /// so "registered" and "has a node" are the same question here — which is
    /// the honest answer for a fallback store, not a smaller one.
    async fn node_types(&self, _ctx: &SecurityContext) -> anyhow::Result<Vec<GraphNodeType>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        let mut seen: BTreeMap<String, GraphNodeType> = BTreeMap::new();
        for node in map.values() {
            let type_id = gts::graph_type_id(node.type_id);
            seen.entry(type_id.clone()).or_insert(GraphNodeType {
                leaf_id: gts::leaf_type_id(&type_id),
                type_id,
                is_abstract: false,
            });
        }
        Ok(seen.into_values().collect())
    }

    async fn list_of_types(
        &self,
        _ctx: &SecurityContext,
        graph_types: &[String],
        limit: usize,
    ) -> anyhow::Result<(Vec<CatalogNodeView>, bool)> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        let wanted: std::collections::HashSet<&str> =
            graph_types.iter().map(String::as_str).collect();
        let mut out: Vec<CatalogNodeView> = map
            .values()
            .filter(|n| wanted.contains(gts::graph_type_id(n.type_id).as_str()))
            .map(|n| CatalogNodeView {
                type_id: n.type_id.to_string(),
                instance_id: n.instance_id.clone(),
                value: n.value.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
        let truncated = out.len() > limit;
        out.truncate(limit);
        Ok((out, truncated))
    }

    async fn count_of_type(
        &self,
        _ctx: &SecurityContext,
        graph_type: &str,
        cap: usize,
    ) -> anyhow::Result<(usize, bool)> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        let total = map
            .values()
            .filter(|n| gts::graph_type_id(n.type_id) == graph_type)
            .count();
        Ok((total.min(cap), total > cap))
    }
}

/// Human name for a node, from the curated payload. Used by the graph backend.
#[cfg(feature = "graph")]
fn node_name(value: &Value) -> String {
    for key in ["title", "name"] {
        if let Some(s) = value.get(key).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    String::new()
}

/// The real graph-storage backend. Behind the `graph` feature (the gear is).
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

/// The graph-storage gear embeds every node during ingest. A catalogue sync can
/// contain thousands of crate-version nodes, so one all-in-one request makes
/// the in-process ONNX provider retain an unbounded embedding batch and can
/// OOM an otherwise healthy backend. Keep the batch deliberately below the
/// artifact graph's generic ingest size: catalogue versions have no urgency
/// and bounded memory is more valuable than maximum throughput.
#[cfg(feature = "graph")]
const NODE_INGEST_CHUNK: usize = 32;

/// Edges are not embedded, so they can safely use a larger chunk after every
/// endpoint has been written.
#[cfg(feature = "graph")]
const EDGE_INGEST_CHUNK: usize = 256;

/// The payload of a catalogue node that is gone from its source.
///
/// Removing a catalogue node cannot be a graph-storage delete. The gear's
/// delete is a tombstone, and "a tombstoned `node_key` is not reusable before
/// purge" (graph-storage DESIGN § Soft Delete Contract, rule 4) — while v1 has
/// neither purge nor undelete (both p2). Every catalogue key is deterministic,
/// a uuid5 of the component's name, so a component that leaves its source and
/// comes back, or a field schema reverted and then saved again, needs the key
/// it had. After a tombstone that key can never be written again, and the
/// ingest that tries aborts its whole batch.
///
/// So the catalogue retires a node instead: it overwrites the payload with
/// this marker, keeping the key live, and every read of this sink skips it.
/// The next ingest of the key replaces the marker with the component again —
/// an ordinary upsert, which is exactly what the gear's contract offers.
#[cfg(feature = "graph")]
const RETIRED_MARKER: &str = "studio_catalog_retired";

#[cfg(feature = "graph")]
fn retired_payload() -> Value {
    json!({ RETIRED_MARKER: true })
}

/// Whether a payload read back is a retired node rather than a component.
#[cfg(feature = "graph")]
fn is_retired(payload: Option<&Value>) -> bool {
    payload
        .and_then(|p| p.get(RETIRED_MARKER))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The key graph-storage refused because it is tombstoned, when that is what
/// `error` says.
///
/// Keys this sink tombstoned before it learned to retire stay unwritable until
/// the gear can purge them. One of them must not keep the rest of a sync out
/// of the graph, so the sink skips it — and has to learn which key it was from
/// the detail, because the gear reports this refusal as a generic
/// `CAS_CONFLICT` abort with the key named only in the text.
#[cfg(feature = "graph")]
fn tombstoned_key(error: &toolkit_canonical_errors::CanonicalError) -> Option<String> {
    if !matches!(
        error,
        toolkit_canonical_errors::CanonicalError::Aborted { .. }
    ) {
        return None;
    }
    tombstoned_key_in(error.detail()).map(str::to_owned)
}

/// The backticked key in the gear's "node key `…` is tombstoned" detail.
#[cfg(feature = "graph")]
fn tombstoned_key_in(detail: &str) -> Option<&str> {
    if !detail.contains("is tombstoned") {
        return None;
    }
    let start = detail.find('`')? + 1;
    let len = detail[start..].find('`')?;
    Some(&detail[start..start + len]).filter(|k| !k.is_empty())
}

#[cfg(feature = "graph")]
fn node_batch(
    nodes: Vec<graph_storage_sdk::models::NodeSpec>,
    embed: bool,
) -> graph_storage_sdk::models::IngestRequest {
    use graph_storage_sdk::models::{IngestOptions, IngestRequest};
    IngestRequest {
        nodes,
        edges: Vec::new(),
        options: IngestOptions {
            create_phantoms: Some(false),
            report_per_item: false,
            embed: Some(embed),
        },
        replace_scope: None,
        idempotency_key: None,
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
        use crate::artifact_ingest::graph_backend::{str_without_nul, without_nul};
        use graph_storage_sdk::models::{EdgeSpec, IngestOptions, IngestRequest, NodeSpec};
        if nodes.is_empty() && edges.is_empty() {
            return Ok(());
        }
        // Nodes must be written before edges. With phantom creation disabled,
        // this preserves graph integrity even when the boundaries split a
        // gear from one of its many crate-version nodes. Re-running after a
        // transient failure is safe: both node keys and edge tuples upsert.
        let mut unwritable: BTreeSet<String> = BTreeSet::new();
        for chunk in nodes.chunks(NODE_INGEST_CHUNK) {
            let mut node_specs: Vec<NodeSpec> = chunk
                .iter()
                .map(|n| NodeSpec {
                    node_key: n.instance_id.clone(),
                    type_id: gts::graph_type_id(n.type_id),
                    name: Some(str_without_nul(node_name(&n.value))),
                    payload: Some(without_nul(n.value.clone())),
                    expected_version: None,
                })
                .collect();
            // A key tombstoned before this sink retired instead of deleting
            // aborts the batch it is in. Drop it and write the rest; the gear
            // names one key per refusal, so this loops at most once per node.
            while !node_specs.is_empty() {
                match self
                    .client
                    .ingest(ctx, node_batch(node_specs.clone(), true))
                    .await
                {
                    Ok(_) => break,
                    Err(e) => match tombstoned_key(&e) {
                        Some(key) if node_specs.iter().any(|s| s.node_key == key) => {
                            tracing::warn!(
                                node_key = %key,
                                "components-catalog: graph-storage holds this key tombstoned and \
                                 cannot re-ingest it before purge; skipped"
                            );
                            node_specs.retain(|s| s.node_key != key);
                            unwritable.insert(key);
                        }
                        _ => return Err(anyhow!("graph-storage node ingest: {e}")),
                    },
                }
            }
        }
        // An edge to a node that was not written would be refused (phantoms are
        // off) and would take its batch with it.
        let edges: Vec<&GtsEdge> = edges
            .iter()
            .filter(|e| !unwritable.contains(&e.from) && !unwritable.contains(&e.to))
            .collect();

        for chunk in edges.chunks(EDGE_INGEST_CHUNK) {
            let edge_specs: Vec<EdgeSpec> = chunk
                .iter()
                .map(|e| EdgeSpec {
                    type_id: gts::graph_type_id(e.type_id),
                    src_node_key: e.from.clone(),
                    dst_node_key: e.to.clone(),
                    discriminator: None,
                    payload: None,
                })
                .collect();
            self.client
                .ingest(
                    ctx,
                    IngestRequest {
                        nodes: Vec::new(),
                        edges: edge_specs,
                        options: IngestOptions {
                            create_phantoms: Some(false),
                            report_per_item: false,
                            embed: Some(false),
                        },
                        replace_scope: None,
                        idempotency_key: None,
                    },
                )
                .await
                .map_err(|e| anyhow!("graph-storage edge ingest: {e}"))?;
        }
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
                if is_retired(row.payload.as_ref()) {
                    continue;
                }
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

    /// A retire, not a graph-storage delete — see [`RETIRED_MARKER`] for why a
    /// tombstone would make the key unwritable. Idempotent: removing a node
    /// that is absent or already retired is what "revert to the built-in"
    /// means when it was never overridden, and a caller should not have to
    /// know which.
    async fn delete(&self, ctx: &SecurityContext, instance_id: &str) -> anyhow::Result<()> {
        use graph_storage_sdk::models::NodeSpec;
        let key = instance_id.to_string();
        // The type is needed to write the key again: a same-key ingest may not
        // change it.
        let view = match self.client.get_node(ctx, &key, Some(1)).await {
            Ok(view) => view,
            Err(toolkit_canonical_errors::CanonicalError::NotFound { .. }) => return Ok(()),
            Err(e) => return Err(anyhow!("graph-storage read before retire: {e}")),
        };
        if is_retired(view.payload.as_ref()) {
            return Ok(());
        }
        let spec = NodeSpec {
            node_key: key,
            type_id: view.type_id,
            name: None,
            payload: Some(retired_payload()),
            expected_version: None,
        };
        // Not embedded: the marker has nothing to find, and skipping the
        // embedding makes the old vector stale, so it no longer ranks.
        self.client
            .ingest(ctx, node_batch(vec![spec], false))
            .await
            .map_err(|e| anyhow!("graph-storage retire: {e}"))?;
        Ok(())
    }

    async fn node_types(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GraphNodeType>> {
        use graph_storage_sdk::models::{TypeKind, TypeQuery};
        // The ontology is hundreds of rows, not millions; a page this size
        // reads it in one or two calls without asking the gear for more than
        // its projection cap allows.
        const PAGE: u32 = 200;
        let mut out: Vec<GraphNodeType> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self
                .client
                .list_types(
                    ctx,
                    TypeQuery {
                        kind: Some(TypeKind::Node),
                        pattern: None,
                        top: Some(PAGE),
                        cursor: cursor.take(),
                    },
                )
                .await
                .map_err(|e| anyhow!("graph-storage list types: {e}"))?;
            for record in page.items {
                out.push(GraphNodeType {
                    leaf_id: gts::leaf_type_id(&record.type_id),
                    type_id: record.type_id,
                    is_abstract: record.is_abstract,
                });
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(out)
    }

    async fn list_of_types(
        &self,
        ctx: &SecurityContext,
        graph_types: &[String],
        limit: usize,
    ) -> anyhow::Result<(Vec<CatalogNodeView>, bool)> {
        use toolkit_odata::{CursorV1, ODataQuery};
        const PAGE: u64 = 200;
        if graph_types.is_empty() {
            return Ok((Vec::new(), false));
        }
        let mut out: Vec<CatalogNodeView> = Vec::new();
        let mut query = ODataQuery::default().with_limit(PAGE);
        loop {
            let page = self
                .client
                .project_nodes(ctx, graph_types, query.clone())
                .await
                .map_err(|e| anyhow!("graph-storage projection: {e}"))?;
            for row in page.items {
                if is_retired(row.payload.as_ref()) {
                    continue;
                }
                out.push(CatalogNodeView {
                    type_id: gts::leaf_type_id(&row.type_id),
                    instance_id: row.node_key,
                    value: row.payload.unwrap_or_else(|| json!({})),
                });
            }
            if out.len() > limit {
                out.truncate(limit);
                return Ok((out, true));
            }
            let Some(next) = page.page_info.next_cursor else {
                break;
            };
            let cursor = CursorV1::decode(&next)
                .map_err(|e| anyhow!("graph-storage returned an undecodable cursor: {e}"))?;
            query = ODataQuery::default().with_limit(PAGE).with_cursor(cursor);
        }
        Ok((out, false))
    }

    async fn count_of_type(
        &self,
        ctx: &SecurityContext,
        graph_type: &str,
        cap: usize,
    ) -> anyhow::Result<(usize, bool)> {
        use toolkit_odata::{CursorV1, ODataQuery};
        const PAGE: u64 = 200;
        let patterns = [graph_type.to_string()];
        let mut total = 0usize;
        let mut query = ODataQuery::default().with_limit(PAGE);
        loop {
            let page = self
                .client
                .project_nodes(ctx, &patterns, query.clone())
                .await
                .map_err(|e| anyhow!("graph-storage projection: {e}"))?;
            total += page
                .items
                .iter()
                .filter(|row| !is_retired(row.payload.as_ref()))
                .count();
            if total >= cap {
                return Ok((cap, true));
            }
            let Some(next) = page.page_info.next_cursor else {
                break;
            };
            let cursor = CursorV1::decode(&next)
                .map_err(|e| anyhow!("graph-storage returned an undecodable cursor: {e}"))?;
            query = ODataQuery::default().with_limit(PAGE).with_cursor(cursor);
        }
        Ok((total, false))
    }
}
// ── Service ─────────────────────────────────────────────────────────────────
/// How far a per-type count will page before it reports a floor instead of a
/// total.
///
/// Deliberately the same number as the list cap below. Counting past the point
/// where the page could show them buys a bigger number and nothing else, and
/// `2000+` is the more useful thing to read anyway: it says "more than this
/// page can hold", which is the decision the reader is actually making.
const TYPE_COUNT_CAP: usize = 2000;

/// How many nodes of one type the graph holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypeCount {
    pub leaf_id: String,
    /// Exact, unless `capped` — then it is a floor.
    pub count: usize,
    /// Whether the count stopped at the cap rather than at the end.
    pub capped: bool,
}

/// How many component nodes one read of the Components page will return.
///
/// A tenant can mark any type, and some types have six figures of instances.
/// The cap is what stops a tick box from turning into an outage; the flag it
/// travels with is what stops the truncation from being a lie.
const COMPONENT_LIST_CAP: usize = 2000;

/// Who authored the layout a type renders against, as the Objects page reports
/// it. A record with no groups describes nothing, whatever its `owner` says, so
/// it reads `none` rather than crediting a page that does not exist.
fn schema_owner(record: &TypeFieldSchema) -> &str {
    if record.groups.is_empty() {
        "none"
    } else {
        record.owner.as_str()
    }
}

/// One type as the Objects page sees it: what the graph holds, and what this
/// organization says about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogTypeView {
    /// The id graph-storage stores it under; empty when nothing has written a
    /// node of this type into this tenant's graph yet.
    pub type_id: String,
    /// The leaf id -- how the type is named everywhere else, and what a mark
    /// and a field schema are keyed on.
    pub leaf_id: String,
    /// A family or base: derived from, never instantiated, never a component.
    pub is_abstract: bool,
    /// Whether this organization treats the type as a component.
    pub component: bool,
    /// Who authored the field schema it renders against: `builtin`, `tenant`
    /// or `none`.
    pub schema: String,
}

/// A GTS type id as the grammar allows it: `gts.` then `~`-terminated
/// segments of five dot-separated tokens. Deliberately shape-only — the id
/// need not be a type this build knows, or the catalogue could never be given
/// a schema for a component kind it has not shipped support for.
fn is_gts_type_id(id: &str) -> bool {
    if !id.starts_with("gts.") || !id.ends_with('~') || id.len() > 512 {
        return false;
    }
    let segments: Vec<&str> = id
        .strip_prefix("gts.")
        .unwrap_or_default()
        .trim_end_matches('~')
        .split('~')
        .collect();
    !segments.is_empty()
        && segments.iter().all(|segment| {
            let tokens: Vec<&str> = segment.split('.').collect();
            tokens.len() == 5
                && tokens[4].starts_with('v')
                && tokens.iter().all(|t| {
                    !t.is_empty()
                        && t.chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                })
        })
}

/// A repository source the caller selected on the Gears page.
///
/// `Serialize` too: this is half of a `catalog.sync` run's payload.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RepoSource {
    pub tenant: Uuid,
    pub connection_id: Option<Uuid>,
    pub repo: String,
    pub git_ref: String,
    /// "gears" (default) or "frontx".
    pub mode: String,
}

/// Which sources one sync should read. At least one should be set — the
/// handler refuses a run that names none.
///
/// This is a `catalog.sync` run's payload, so it round-trips through the queue.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct SyncSources {
    /// `Some(keyword)` enables crates.io with that keyword.
    #[serde(default)]
    pub crates_io: Option<String>,
    /// Repository sources (gears repo, FrontX repo, …).
    #[serde(default)]
    pub repos: Vec<RepoSource>,
    /// Roadmap boards whose items say what stage each gear is at, when it is
    /// due and who is waiting for it.
    #[serde(default)]
    pub roadmaps: Vec<RoadmapSource>,
}

/// What a catalog sync has counted.
///
/// Reported live through the progress bridge as the sync runs, and again as the
/// run's final result when it finishes — one shape, so the poll endpoint reads
/// a half-finished sync and a completed one the same way.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
pub struct CatalogCounts {
    /// Gears (crates) discovered so far.
    #[serde(default)]
    pub gears: usize,
    /// Version nodes built so far.
    #[serde(default)]
    pub versions: usize,
    /// Nodes flushed to the graph store.
    #[serde(default)]
    pub stored: usize,
}

impl CatalogCounts {
    /// The counts recorded on a run, or zeroes when it has not reported any
    /// yet. Tolerant on purpose — see the artifact-ingest twin of this method.
    pub fn of_result(result: Option<Value>) -> Self {
        result
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// This value as a progress detail. Infallible in practice — three
    /// integers always serialize.
    fn as_detail(self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }
}

/// A workspace's (or project's) repositories, as sessions clone them.
const WORKSPACE_SETTINGS_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~";

/// Project attributes, including the repositories it was seeded from.
const PROJECT_CONFIG_TYPE: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~";

/// `(connection_id, full_path)` of each source in a project config, as the
/// portal writes them. An entry missing either is not one the portal could
/// read either.
fn project_sources(config: &Value) -> Vec<(Uuid, String)> {
    config
        .get("sources")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let text = |key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            };
            Some((
                Uuid::parse_str(text("connection_id")?).ok()?,
                text("full_path")?.to_owned(),
            ))
        })
        .collect()
}

#[cfg(test)]
mod project_source_tests {
    use super::*;

    #[test]
    fn a_source_names_its_connection_and_repository() {
        let id = Uuid::new_v4();
        let config = json!({
            "mode": "modernize",
            "sources": [
                { "connection_id": id.to_string(), "full_path": "acme/api", "clone_url": "https://github.com/acme/api.git" },
                { "connection_id": "not-a-uuid", "full_path": "acme/x" },
                { "connection_id": id.to_string(), "full_path": "  " },
                { "full_path": "acme/y" }
            ]
        });
        assert_eq!(project_sources(&config), [(id, "acme/api".to_owned())]);
        assert!(project_sources(&json!({ "mode": "greenfield" })).is_empty());
    }
}

pub struct CatalogService {
    crates: CratesIoClient,
    sink: Arc<dyn CatalogSink>,
    keyword: String,
    connectors: Option<Arc<ConnectorService>>,
    /// The Gearbox engine, when previews are configured: a sync writes what it
    /// knows about each gear into the gear's profile. Set once, after
    /// construction, because the engine is configured separately.
    gearbox: std::sync::OnceLock<Arc<super::gearbox::Gearbox>>,
    /// Reads a project's own sources, for a project with no gear repository.
    account_management:
        std::sync::OnceLock<Arc<dyn account_management_sdk::AccountManagementClient>>,
}

impl CatalogService {
    pub fn new(
        sink: Arc<dyn CatalogSink>,
        keyword: String,
        connectors: Option<Arc<ConnectorService>>,
    ) -> Self {
        Self {
            crates: CratesIoClient::new(),
            sink,
            keyword,
            connectors,
            gearbox: std::sync::OnceLock::new(),
            account_management: std::sync::OnceLock::new(),
        }
    }

    pub fn set_gearbox(&self, gearbox: Arc<super::gearbox::Gearbox>) {
        let _ = self.gearbox.set(gearbox);
    }

    pub fn set_account_management(
        &self,
        client: Arc<dyn account_management_sdk::AccountManagementClient>,
    ) {
        let _ = self.account_management.set(client);
    }

    /// The default crates.io keyword, used when a sync request omits one.
    pub fn default_keyword(&self) -> &str {
        &self.keyword
    }

    /// The catalogue's gears repository as a place the engine can check out:
    /// the same connection the repository scan reads through, its clone URL
    /// and credentials. `None` without a connection or a clonable host.
    async fn corpus_source(
        &self,
        ctx: &SecurityContext,
        source: &RepoSource,
    ) -> Option<super::gearbox::CorpusSource> {
        let connectors = self.connectors.as_ref()?;
        let id = match source.connection_id {
            Some(id) => id,
            None => {
                connectors
                    .list(ctx, source.tenant)
                    .await
                    .ok()?
                    .into_iter()
                    .find(|c| c.provider == "github")?
                    .id
            }
        };
        let (driver, auth, _conn) = connectors
            .driver_and_auth(ctx, source.tenant, id)
            .await
            .ok()?;
        let url = driver.clone_url(&auth.base_url, &source.repo).ok()?;
        let (username, token) = driver.clone_credentials(&auth.token);
        let git_ref = match source.git_ref.trim() {
            "" => "main".to_string(),
            r => r.to_string(),
        };
        Some(super::gearbox::CorpusSource {
            label: format!("{}@{git_ref}", source.repo),
            key: format!("catalogue-{id}"),
            repo: source.repo.clone(),
            url,
            username: username.to_string(),
            token: token.to_string(),
            git_ref,
        })
    }

    /// What the Gearbox engine knows about each gear, keyed by crate name, as
    /// profile fields — after following the catalogue's own gears repository
    /// if it describes its gears, so the catalogue and the previews read one
    /// corpus. `None` when previews are not configured or the engine failed;
    /// a sync never fails because of it.
    async fn gearbox_facts(
        &self,
        ctx: &SecurityContext,
        sources: &SyncSources,
        progress: &SyncReporter,
    ) -> Option<BTreeMap<String, Value>> {
        let gearbox = self.gearbox.get()?;
        for source in sources
            .repos
            .iter()
            .filter(|s| RepoMode::parse(&s.mode) == RepoMode::Gears)
        {
            let Some(corpus) = self.corpus_source(ctx, source).await else {
                continue;
            };
            progress.set(format!("checking {} for gear.gdl", source.repo));
            let label = corpus.label.clone();
            match gearbox.adopt_if_described(corpus).await {
                Ok(true) => {
                    tracing::info!(corpus = %label, "components-catalog: the gears repository describes its gears; previews follow it")
                }
                Ok(false) => {
                    tracing::info!(repo = %label, kept = %gearbox.corpus_label(), "components-catalog: the gears repository has no gear.gdl yet; keeping the configured corpus")
                }
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), repo = %label, "components-catalog: could not check the gears repository out for the engine")
                }
            }
        }
        progress.set("asking the Gearbox engine about the gears…");
        match gearbox.facts().await {
            Ok((corpus, facts)) => {
                tracing::info!(corpus = %corpus, gears = facts.len(), "components-catalog: Gearbox facts");
                Some(facts)
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "components-catalog: Gearbox facts unavailable");
                None
            }
        }
    }

    /// Write what each roadmap board says about a gear into its profile.
    ///
    /// Best-effort, like the Gearbox facts: a board this connection cannot see
    /// costs the profiles their plan fields, never the sync. Every plan field is
    /// cleared first, so a gear that stopped matching an item stops showing a
    /// plan it no longer has.
    async fn apply_roadmaps(
        &self,
        ctx: &SecurityContext,
        roadmaps: &[RoadmapSource],
        profiles: &mut [GtsNode],
        progress: &SyncReporter,
    ) {
        let Some(connectors) = self.connectors.clone() else {
            tracing::warn!("components-catalog: no connector service; roadmap boards skipped");
            return;
        };
        let today = time::OffsetDateTime::now_utc().date().to_string();
        for node in profiles.iter_mut() {
            if let Some(Value::Object(auto)) = node.value.get_mut("auto") {
                for key in roadmap::ROADMAP_KEYS {
                    auto.remove(key);
                }
            }
        }
        for source in roadmaps {
            progress.set(format!(
                "reading roadmap {}/{}",
                source.owner, source.number
            ));
            let board = match roadmap::fetch(connectors.clone(), ctx, source).await {
                Ok(board) => board,
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), owner = %source.owner, number = source.number, "components-catalog: roadmap board unreadable");
                    continue;
                }
            };
            let gears: Vec<(String, Vec<String>, Option<u64>)> = profiles
                .iter()
                .filter_map(|n| {
                    let name = n.value.get("gear_name")?.as_str()?.to_string();
                    let pinned = n
                        .value
                        .pointer("/values/roadmap_item/v")
                        .and_then(Value::as_str)
                        .and_then(roadmap::pinned_number);
                    let words = roadmap::gear_words(&name);
                    Some((name, words, pinned))
                })
                .collect();
            let matches = roadmap::match_items(&gears, &board.items);
            tracing::info!(board = %board.title, items = board.items.len(), gears = gears.len(), matched = matches.len(), "components-catalog: roadmap board read");
            for node in profiles.iter_mut() {
                let Some(name) = node
                    .value
                    .get("gear_name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                let Some((ix, how)) = matches.get(&name) else {
                    continue;
                };
                let mut add = roadmap::item_fields(&board, &board.items[*ix], *how, source, &today);
                let lifecycle = node
                    .value
                    .pointer("/auto/lifecycle/b")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                roadmap::check_release(&mut add, lifecycle.as_deref());
                let Some(prof) = node.value.as_object_mut() else {
                    continue;
                };
                if let Value::Object(auto) = prof.entry("auto").or_insert_with(|| json!({})) {
                    auto.extend(add);
                }
            }
        }
    }

    /// Discover gears from a repository source (best-effort at the call site).
    async fn repo_gears(
        &self,
        ctx: &SecurityContext,
        source: &RepoSource,
    ) -> anyhow::Result<Vec<RepoGear>> {
        let connectors = self
            .connectors
            .clone()
            .ok_or_else(|| anyhow!("no connector service is available for repository sources"))?;
        let mode = RepoMode::parse(&source.mode);
        let mut enricher = RepoEnricher::new(
            connectors,
            source.tenant,
            source.connection_id,
            source.repo.clone(),
            source.git_ref.clone(),
            mode,
        )
        .ok_or_else(|| anyhow!("invalid repository source"))?;
        // A gears repository is read from the engine's checkout of it when
        // there is an engine: one download, shared with the previews, and
        // every file readable -- the source-code fields need all of them.
        // Without one, the scan reads through the API as it always has.
        if mode == RepoMode::Gears
            && let Some(gearbox) = self.gearbox.get()
            && let Some(corpus) = self.corpus_source(ctx, source).await
        {
            match gearbox.checkout(&corpus).await {
                Ok(dir) => enricher = enricher.with_checkout(dir),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), repo = %source.repo, "components-catalog: no checkout of the gears repository; reading it through the API")
                }
            }
        }
        enricher.enrich(ctx).await
    }

    /// Read the selected sources into gear + version nodes and upsert them.
    /// Repository gears are discovered from `gear.toml` directories; crates.io
    /// contributes published versions. The two merge by crate name. Each phase
    /// (and the counts so far) is reported to `progress`.
    pub async fn run_sync(
        &self,
        ctx: &SecurityContext,
        sources: SyncSources,
        progress: &SyncReporter,
    ) -> anyhow::Result<CatalogCounts> {
        self.sink.register_types(ctx).await?;

        // Gear node value per crate name; version nodes/edges accumulate aside.
        let mut gear_values: BTreeMap<String, Value> = BTreeMap::new();
        // Components that carry a model of their own, keyed by slug. Declared
        // beside the gears because they are upserted in the same breath.
        let mut kit_values: BTreeMap<String, Value> = BTreeMap::new();
        // Micro-frontends keep the gear payload shape and the editable profile
        // that renders their component page -- only their node type differs, so
        // the catalogue can be asked for them by type rather than by label.
        let mut frontx_values: BTreeMap<String, Value> = BTreeMap::new();
        let mut version_nodes: Vec<GtsNode> = Vec::new();
        let mut version_edges: Vec<GtsEdge> = Vec::new();
        let mut profile_nodes: Vec<GtsNode> = Vec::new();
        let mut versions_total = 0usize;

        // ── crates.io ────────────────────────────────────────────────────────
        if let Some(keyword) = sources.crates_io.as_deref() {
            progress.set("listing crates…");
            let summaries = self.crates.list_by_keyword(keyword).await?;
            let total = summaries.len();
            tracing::info!(keyword = %keyword, gears = total, "components-catalog: listed crates");
            for (i, s) in summaries.iter().enumerate() {
                report(
                    progress,
                    format!("crates.io {} ({}/{})", s.name, i + 1, total),
                    i,
                    versions_total,
                    gear_values.len(),
                );
                let detail = match self.crates.crate_detail(&s.name).await {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::warn!(crate = %s.name, error = %e, "components-catalog: detail fetch failed — skipping");
                        continue;
                    }
                };
                let (mut nodes, edges, vers) = build_gear(&detail);
                versions_total += vers;
                if !nodes.is_empty() {
                    let gear = nodes.remove(0);
                    gear_values.insert(s.name.clone(), gear.value);
                }
                version_nodes.extend(nodes);
                version_edges.extend(edges);
                tokio::time::sleep(THROTTLE).await;
            }
        }

        // ── repository sources → component profiles ─────────────────────────
        // Each repository (gears repo, FrontX repo, …) contributes components.
        // Their engineering data is written into each component's profile
        // (persistent, editable): `auto` and `uml` are refreshed every sync
        // while the hand-edited `values` are preserved.
        if !sources.repos.is_empty() {
            let existing: HashMap<String, serde_json::Map<String, Value>> = self
                .sink
                .list(ctx, Some("gear_profile"))
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|n| {
                    let obj = n.value.as_object()?.clone();
                    let name = obj.get("gear_name")?.as_str()?.to_string();
                    Some((name, obj))
                })
                .collect();
            let mut last_err: Option<anyhow::Error> = None;
            let mut any_ok = false;
            for source in &sources.repos {
                report(
                    progress,
                    format!("reading {} ({})", source.repo, source.mode),
                    gear_values.len(),
                    versions_total,
                    0,
                );
                match self.repo_gears(ctx, source).await {
                    Ok(repo_gears) => {
                        any_ok = true;
                        for rg in repo_gears {
                            // A component that carries its own model goes in as
                            // its own node type. It has no crates.io half to be
                            // merged with, and no profile: the fields a gear
                            // keeps in an editable profile are, for a kit, the
                            // manifest itself.
                            if let Some(mut payload) = rg.payload {
                                if let Some(obj) = payload.as_object_mut() {
                                    obj.insert(
                                        "synced_from".to_string(),
                                        Value::String(rg.source_repo.clone()),
                                    );
                                }
                                kit_values.insert(rg.crate_name.clone(), payload);
                                continue;
                            }
                            let kind = rg
                                .kind
                                .clone()
                                .unwrap_or_else(|| classify_kind(&rg.crate_name).to_string());
                            // Captured before `kind` is moved into the payload.
                            let is_frontx = kind == "frontx";
                            let entry = gear_values.entry(rg.crate_name.clone()).or_insert_with(
                                || json!({ "name": rg.crate_name, "title": rg.crate_name }),
                            );
                            // Whether this is a gear or a request for one.
                            let status = gear_status(&rg.fields);
                            if let Some(obj) = entry.as_object_mut() {
                                obj.insert("kind".to_string(), Value::String(kind));
                                // Which scan produced this, so a later run can
                                // tell "gone from the source" from "never came
                                // from a source at all".
                                obj.insert(
                                    "synced_from".to_string(),
                                    Value::String(rg.source_repo.clone()),
                                );
                                // Where in that repository, and which crates
                                // the directory declares: read, not derived
                                // from the name (see `RepoGear::dir`).
                                if let Some(dir) = &rg.dir {
                                    obj.insert("repo_path".to_string(), Value::String(dir.clone()));
                                }
                                if !rg.crates.is_empty() {
                                    obj.insert(
                                        "crate_names".to_string(),
                                        Value::Array(
                                            rg.crates.iter().cloned().map(Value::String).collect(),
                                        ),
                                    );
                                }
                                if let Some(status) = status {
                                    obj.insert(
                                        "status".to_string(),
                                        Value::String(status.to_string()),
                                    );
                                }
                                if let Some(c) = &rg.category {
                                    obj.insert("category".to_string(), Value::String(c.clone()));
                                }
                                if obj.get("description").map(Value::is_null).unwrap_or(true)
                                    && let Some(d) = &rg.description
                                {
                                    obj.insert("description".to_string(), Value::String(d.clone()));
                                }
                            }
                            // A micro-frontend is its own type. The payload and
                            // the profile are unchanged; it simply stops being
                            // filed as a gear that says it is not one.
                            if is_frontx && let Some(value) = gear_values.remove(&rg.crate_name) {
                                frontx_values.insert(rg.crate_name.clone(), value);
                            }
                            let mut prof =
                                existing.get(&rg.crate_name).cloned().unwrap_or_default();
                            prof.insert(
                                "gear_name".to_string(),
                                Value::String(rg.crate_name.clone()),
                            );
                            prof.insert("auto".to_string(), rg.fields);
                            if !rg.uml.is_empty() {
                                prof.insert("uml".to_string(), Value::Array(rg.uml));
                            }
                            prof.insert("source".to_string(), Value::String(source.mode.clone()));
                            if let Some(d) = &rg.description {
                                prof.entry("description".to_string())
                                    .or_insert_with(|| Value::String(d.clone()));
                            }
                            profile_nodes
                                .push(gts::gear_profile_node(&rg.crate_name, Value::Object(prof)));
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, repo = %source.repo, "components-catalog: repository source failed");
                        last_err = Some(e);
                    }
                }
            }
            // Surface the error when the repositories were the only source.
            if !any_ok
                && sources.crates_io.is_none()
                && let Some(e) = last_err
            {
                return Err(e);
            }
        }

        // ── what the Gearbox engine knows ────────────────────────────────────
        // Only when this run rebuilt the profiles from a repository: a
        // crates.io-only run leaves every profile as it was, facts included.
        if !profile_nodes.is_empty()
            && let Some(facts) = self.gearbox_facts(ctx, &sources, progress).await
        {
            for node in &mut profile_nodes {
                let Some(prof) = node.value.as_object_mut() else {
                    continue;
                };
                let Some(name) = prof
                    .get("gear_name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                let Some(Value::Object(add)) = facts.get(&name).cloned() else {
                    continue;
                };
                if let Some(Value::Object(auto)) = prof.get_mut("auto") {
                    auto.extend(add);
                }
            }
        }

        // ── what the roadmap boards plan ─────────────────────────────────────
        // A run that rebuilt no profile from a repository updates the profiles
        // the graph already holds: the plan moves weekly, the tree less often,
        // and refreshing one should not cost a full scan of the other.
        if !sources.roadmaps.is_empty() {
            if profile_nodes.is_empty() {
                profile_nodes = self
                    .sink
                    .list(ctx, Some("gear_profile"))
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|n| n.value.get("gear_name").is_some())
                    .collect();
            }
            self.apply_roadmaps(ctx, &sources.roadmaps, &mut profile_nodes, progress)
                .await;
        }

        // ── upsert ───────────────────────────────────────────────────────────
        let mut all_nodes: Vec<GtsNode> = gear_values
            .into_iter()
            .map(|(name, value)| gts::gear_node(&name, value))
            .collect();
        let gears_total = all_nodes.len();
        let kits_total = kit_values.len();
        all_nodes.extend(
            kit_values
                .into_iter()
                .map(|(slug, value)| gts::kit_node(slug.as_str(), value)),
        );
        let frontx_total = frontx_values.len();
        all_nodes.extend(
            frontx_values
                .into_iter()
                .map(|(name, value)| gts::frontx_node(name.as_str(), value)),
        );
        all_nodes.extend(version_nodes);
        all_nodes.extend(profile_nodes);
        let stored = all_nodes.len();
        self.sink.upsert(ctx, &all_nodes, &version_edges).await?;

        // A component removed from its source is removed from the catalogue.
        //
        // The sync only ever added before, so a node outlived whatever produced
        // it: `studio-kit-sdlc` and `studio-kits-pm` sat in the graph named
        // after their repositories long after the scan learned to name a kit
        // after itself, and the page showed four kits where there were two.
        //
        // Scoped to what this run actually read, in two ways, because a sync
        // may name any subset of its sources. A node is a candidate only if it
        // says it came from a repository THIS run read (`synced_from`), and it
        // is deleted only if this run did not produce it. A crates.io-only run
        // reads no repository and therefore deletes nothing.
        //
        // `synced_from` is what makes this safe rather than the `repository`
        // field, which looks like it would do: fifty-nine of the hundred and
        // eighteen gear nodes on this stand come from crates.io alone and still
        // name `gears-rust` as their repository. Pruning on that would delete
        // every one of them.
        let read_repos: BTreeSet<String> = sources
            .repos
            .iter()
            .map(|r| r.repo.trim().to_string())
            .collect();
        let mut pruned = 0usize;
        if !read_repos.is_empty() {
            let produced: BTreeSet<&str> =
                all_nodes.iter().map(|n| n.instance_id.as_str()).collect();
            // Which repository modes this run actually read. A run over the
            // gears repository must not clear kits it never looked for.
            let read_modes: BTreeSet<&str> = sources
                .repos
                .iter()
                .map(|r| match RepoMode::parse(&r.mode) {
                    RepoMode::Kits => "kits",
                    RepoMode::Frontx => "frontx",
                    RepoMode::Gears => "gears",
                })
                .collect();
            for (type_id, scan_only) in [
                (gts::GEAR_TYPE, false),
                (gts::KIT_TYPE, read_modes.contains("kits")),
                (gts::FRONTX_TYPE, read_modes.contains("frontx")),
            ] {
                let existing = match self.sink.list(ctx, Some(type_id)).await {
                    Ok(nodes) => nodes,
                    // A type the graph has never held is not an error, and a
                    // listing that fails must not fail the sync that already
                    // stored its results.
                    Err(error) => {
                        tracing::warn!(%error, type_id, "components-catalog: prune skipped a type");
                        continue;
                    }
                };
                let mut condemned = stale(&existing, &produced, &read_repos, scan_only);
                if type_id == gts::GEAR_TYPE && read_modes.contains("frontx") {
                    for node in misfiled_frontx(&existing, &produced) {
                        if !condemned.iter().any(|n| n.instance_id == node.instance_id) {
                            condemned.push(node);
                        }
                    }
                }
                for node in condemned {
                    let from = node
                        .value
                        .get("synced_from")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    match self.sink.delete(ctx, &node.instance_id).await {
                        Ok(()) => {
                            pruned += 1;
                            tracing::info!(
                                instance_id = %node.instance_id,
                                source = %from,
                                "components-catalog: pruned, gone from its source"
                            );
                        }
                        Err(error) => tracing::warn!(
                            %error,
                            instance_id = %node.instance_id,
                            "components-catalog: prune failed"
                        ),
                    }
                }
            }
        }

        tracing::info!(
            gears = gears_total,
            kits = kits_total,
            micro_frontends = frontx_total,
            versions = versions_total,
            stored,
            pruned,
            "components-catalog: sync stored"
        );
        let counts = CatalogCounts {
            gears: gears_total,
            versions: versions_total,
            stored,
        };
        progress.set_with("done", counts.as_detail());
        Ok(counts)
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

    /// The field schemas this tenant renders component pages against: the
    /// built-ins with the tenant's own laid over them.
    ///
    /// Best-effort on the read: a graph that will not answer costs the
    /// overrides, not the page. Falling back to the built-ins is the same
    /// behaviour a caller got before schemas were stored at all, so a degraded
    /// graph makes the Components page older, not broken.
    pub async fn list_field_schemas(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Vec<TypeFieldSchema>> {
        let stored = match self.sink.list(ctx, Some("field_schema")).await {
            Ok(nodes) => nodes,
            Err(e) => {
                tracing::warn!(
                    error = %format!("{e:#}"),
                    "components-catalog: field schemas unreadable — serving the built-ins"
                );
                Vec::new()
            }
        };
        let parsed: Vec<TypeFieldSchema> = stored
            .into_iter()
            .filter_map(
                |n| match serde_json::from_value::<TypeFieldSchema>(n.value) {
                    Ok(schema) if !schema.describes.trim().is_empty() => Some(schema),
                    // A stored schema that no longer parses is a schema this build
                    // cannot render. Skipping it falls back to the built-in, which
                    // is a page; refusing the whole list would be no page at all.
                    Ok(_) => None,
                    Err(e) => {
                        tracing::warn!(
                            node = %n.instance_id,
                            error = %e,
                            "components-catalog: skipping an unparseable field schema"
                        );
                        None
                    }
                },
            )
            .collect();
        Ok(field_schema::overlay(
            field_schema::builtin_schemas(),
            parsed,
        ))
    }

    /// How many nodes of each type the graph holds.
    ///
    /// Its own read, deliberately. A count is one projection per type and the
    /// list is hundreds of types, where [`Self::list_types`] is two reads; the
    /// Objects page shows its table first and fills the numbers in, rather
    /// than making every caller of the type list pay for arithmetic it did not
    /// ask for.
    ///
    /// Abstract types are skipped rather than counted: a family is derived
    /// from and never instantiated, so its count is zero by construction and
    /// asking the graph would be a query to learn nothing.
    pub async fn count_types(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<TypeCount>> {
        let types = self.sink.node_types(ctx).await?;
        let mut out = Vec::with_capacity(types.len());
        for t in types {
            if t.is_abstract {
                out.push(TypeCount {
                    leaf_id: t.leaf_id,
                    count: 0,
                    capped: false,
                });
                continue;
            }
            let (count, capped) = self
                .sink
                .count_of_type(ctx, &t.type_id, TYPE_COUNT_CAP)
                .await?;
            out.push(TypeCount {
                leaf_id: t.leaf_id,
                count,
                capped,
            });
        }
        Ok(out)
    }

    /// The nodes the Components page lists: every node of every type this
    /// organization marked as a component.
    ///
    /// This is where the mark stops being a label and starts deciding
    /// something. The list used to be "nodes of `catalog.gear.v1~`", which
    /// made "what is a component" a constant in this file; it is now a
    /// question the organization answers on the Objects page.
    ///
    /// Returns whether the cap cut the list short, because a page that
    /// silently shows some of a marked type is worse than one that says it is
    /// showing part of it.
    pub async fn list_component_nodes(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<(Vec<CatalogNodeView>, bool)> {
        let marked: Vec<String> = self
            .list_field_schemas(ctx)
            .await?
            .into_iter()
            .filter(|s| s.component)
            .map(|s| gts::graph_type_id(&s.describes))
            .collect();
        if marked.is_empty() {
            return Ok((Vec::new(), false));
        }
        self.sink
            .list_of_types(ctx, &marked, COMPONENT_LIST_CAP)
            .await
    }

    /// Every node type the graph holds, with what the studio says about each.
    ///
    /// The union of two lists, because neither alone is the answer: the graph
    /// knows which types exist, and the studio's records know which of them an
    /// organization treats as components. A type can appear in one and not the
    /// other -- a marked type whose gear has not written a node yet, an
    /// artifact type nobody has an opinion about -- and both belong on a page
    /// whose job is to let someone form that opinion.
    ///
    /// Abstract types (the families and bases) are listed and flagged rather
    /// than filtered out, so the page can say why one cannot be marked instead
    /// of leaving a reader to wonder where it went.
    pub async fn list_types(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<CatalogTypeView>> {
        let schemas = self.list_field_schemas(ctx).await?;
        let by_leaf: HashMap<&str, &TypeFieldSchema> =
            schemas.iter().map(|s| (s.describes.as_str(), s)).collect();

        let mut views: BTreeMap<String, CatalogTypeView> = BTreeMap::new();
        // Best-effort, like the schema read: a graph that will not list its
        // ontology still leaves the marked types visible, which is a degraded
        // page rather than none.
        let graph_types = match self.sink.node_types(ctx).await {
            Ok(types) => types,
            Err(e) => {
                tracing::warn!(
                    error = %format!("{e:#}"),
                    "components-catalog: the graph would not list its node types"
                );
                Vec::new()
            }
        };
        for t in graph_types {
            let record = by_leaf.get(t.leaf_id.as_str());
            views.insert(
                t.leaf_id.clone(),
                CatalogTypeView {
                    type_id: t.type_id,
                    leaf_id: t.leaf_id,
                    is_abstract: t.is_abstract,
                    component: record.is_some_and(|r| r.component),
                    schema: record.map_or("none", |r| schema_owner(r)).to_owned(),
                },
            );
        }
        for schema in &schemas {
            views
                .entry(schema.describes.clone())
                .or_insert_with(|| CatalogTypeView {
                    // Nothing has written a node of this type into this
                    // tenant's graph, so there is no stored id to report.
                    type_id: String::new(),
                    leaf_id: schema.describes.clone(),
                    is_abstract: false,
                    component: schema.component,
                    schema: schema_owner(schema).to_owned(),
                });
        }
        Ok(views.into_values().collect())
    }

    /// Mark a type as a component, or take the mark off.
    ///
    /// The Components page then lists it -- which is the whole mechanism: what
    /// counts as a component stops being what this build happened to sync and
    /// becomes what the organization says its building blocks are.
    ///
    /// Writes only a mark, never a layout, and a record that ends up agreeing
    /// with what the tenant would inherit is deleted rather than stored: an
    /// override that overrides nothing is a trap for whoever reads it next.
    pub async fn set_type_component(
        &self,
        ctx: &SecurityContext,
        describes: &str,
        component: bool,
    ) -> anyhow::Result<TypeFieldSchema> {
        let describes = describes.trim();
        if !is_gts_type_id(describes) {
            anyhow::bail!("`{describes}` is not a GTS type id");
        }
        let mut record = self
            .stored_field_schema(ctx, describes)
            .await?
            .unwrap_or_else(|| TypeFieldSchema::empty_for(describes));
        record.component = component;
        self.put_or_prune(ctx, record).await
    }

    /// This tenant's own record for one type, before any built-in is laid
    /// under it. The overlaid read cannot answer this: it cannot tell a
    /// built-in from a tenant record that happens to agree with it.
    async fn stored_field_schema(
        &self,
        ctx: &SecurityContext,
        describes: &str,
    ) -> anyhow::Result<Option<TypeFieldSchema>> {
        let want = gts::field_schema_instance_id(describes);
        let nodes = self.sink.list(ctx, Some("field_schema")).await?;
        Ok(nodes
            .into_iter()
            .find(|n| n.instance_id == want)
            .and_then(|n| serde_json::from_value::<TypeFieldSchema>(n.value).ok()))
    }

    /// Store a record, or delete it when it no longer differs from what the
    /// tenant inherits. Returns what a reader would now see for that type.
    async fn put_or_prune(
        &self,
        ctx: &SecurityContext,
        mut record: TypeFieldSchema,
    ) -> anyhow::Result<TypeFieldSchema> {
        let inherited = field_schema::builtin_component(&record.describes);
        if !record.adds_anything(inherited) {
            self.sink
                .delete(ctx, &gts::field_schema_instance_id(&record.describes))
                .await?;
            return Ok(field_schema::builtin_schemas()
                .into_iter()
                .find(|s| s.describes == record.describes)
                .unwrap_or_else(|| TypeFieldSchema {
                    component: inherited,
                    ..TypeFieldSchema::empty_for(&record.describes)
                }));
        }
        record.owner = if record.groups.is_empty() {
            // A mark carries no layout, so it does not make this tenant the
            // author of one -- the overlay says the same thing on the read side.
            "builtin".to_owned()
        } else {
            "tenant".to_owned()
        };
        let node = gts::field_schema_node(&record.describes, field_schema::to_payload(&record)?);
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(record)
    }

    /// Store this tenant's own schema for one component type, replacing
    /// whatever it inherited. `describes` is a GTS type id and is the identity:
    /// saving twice for the same type replaces rather than accumulates.
    ///
    /// The type need not be one this build knows. That is the point of storing
    /// schemas rather than shipping them: a deployment that catalogues a
    /// component kind we have never heard of can give it a page.
    pub async fn save_field_schema(
        &self,
        ctx: &SecurityContext,
        describes: &str,
        schema: Value,
    ) -> anyhow::Result<TypeFieldSchema> {
        let describes = describes.trim();
        if !is_gts_type_id(describes) {
            anyhow::bail!(
                "`describes` must be a GTS type id such as gts.cf.studio.catalog.gear.v1~, got `{describes}`"
            );
        }
        let mut schema: TypeFieldSchema = serde_json::from_value(schema)
            .map_err(|e| anyhow!("a field schema must be {{groups, composition, …}}: {e}"))?;
        // The path says which type this is for; a body that disagrees with it
        // would give one node two identities.
        schema.describes = describes.to_owned();
        // A layout and a mark are two statements about one type, and this
        // endpoint carries only the first. Whatever the organization already
        // decided about whether the type is a component survives writing a new
        // page for it.
        schema.component = match self.stored_field_schema(ctx, describes).await? {
            Some(stored) => stored.component,
            None => field_schema::builtin_component(describes),
        };
        self.put_or_prune(ctx, schema).await
    }

    /// Drop this tenant's own schema for a type, falling back to the built-in.
    ///
    /// Idempotent: reverting a type that was never overridden succeeds, because
    /// the caller is asking for a state ("this tenant has no schema of its
    /// own"), not for an event.
    pub async fn delete_field_schema(
        &self,
        ctx: &SecurityContext,
        describes: &str,
    ) -> anyhow::Result<()> {
        let describes = describes.trim();
        if !is_gts_type_id(describes) {
            anyhow::bail!("`describes` must be a GTS type id, got `{describes}`");
        }
        // Reverting a layout is not withdrawing an opinion about what the type
        // IS. If the organization marked it a component, it stays one -- and if
        // that mark is all that is left and it agrees with the built-in, the
        // record goes.
        match self.stored_field_schema(ctx, describes).await? {
            Some(stored) => {
                self.put_or_prune(ctx, stored.without_layout()).await?;
            }
            None => {
                self.sink
                    .delete(ctx, &gts::field_schema_instance_id(describes))
                    .await?;
            }
        }
        Ok(())
    }

    /// The gear repository connected to a project (where its gears live and where
    /// scaffolded gears are written), or `None` when none is connected yet.
    pub async fn get_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let want = gts::project_gear_repo_instance_id(project_id);
        let nodes = self.sink.list(ctx, Some("project_gear_repo")).await?;
        Ok(nodes.into_iter().find(|n| n.instance_id == want))
    }

    /// The project's code and every crate its Cargo manifests depend on:
    /// the gear repository when one is connected, the project's own sources
    /// otherwise. `None` when there is neither.
    pub async fn project_dependencies(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<(String, BTreeSet<String>)>> {
        let Some(node) = self.get_project_repo(ctx, project_id).await? else {
            return self.source_dependencies(ctx, project_id).await;
        };
        let v = &node.value;
        let text = |k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let repo = text("repo");
        if repo.is_empty() {
            return Ok(None);
        }
        let tenant = Uuid::parse_str(&text("tenant"))
            .map_err(|_| anyhow!("the project's gear repo names no tenant"))?;
        let connection_id = Uuid::parse_str(&text("connection_id")).ok();
        let connectors = self
            .connectors
            .clone()
            .ok_or_else(|| anyhow!("no connector service is available for repository sources"))?;
        let enricher = RepoEnricher::new(
            connectors,
            tenant,
            connection_id,
            repo.clone(),
            text("branch"),
            RepoMode::parse("gears"),
        )
        .ok_or_else(|| anyhow!("invalid gear repository for the project"))?;
        Ok(Some((repo, enricher.cargo_dependencies(ctx).await?)))
    }

    /// A gear repository is what a `new_gears` project writes into; every
    /// other project's code is the repositories it was seeded from, and those
    /// are in its workspace settings (and, from the wizard, its config). Read the same way, through the connection each one
    /// names. A source that cannot be read is skipped and logged, so one
    /// private repository does not hide what the others depend on.
    async fn source_dependencies(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<(String, BTreeSet<String>)>> {
        let (Some(am), Some(connectors)) = (self.account_management.get(), &self.connectors) else {
            return Ok(None);
        };
        let Ok(project) = Uuid::parse_str(project_id) else {
            return Ok(None);
        };
        // What to read: `(tenant of the connection, connection, repository,
        // branch)`. The workspace's settings first -- both portals write them and
        // every session clones from them, naming the connection by its token --
        // then the config's `sources`, which only the portal's wizard writes.
        let mut targets: Vec<(Uuid, Uuid, String, String)> = Vec::new();
        if let Ok(settings) = am
            .get_metadata(ctx, project, ::gts::GtsTypeId::new(WORKSPACE_SETTINGS_TYPE))
            .await
        {
            for source in crate::git_proxy::sources::sources_in(&settings.value) {
                let (Some(token_ref), Some(repo)) = (
                    source.token_ref.as_deref(),
                    crate::connectors::repo_path_of(&source.url),
                ) else {
                    continue;
                };
                match connectors.by_secret_ref(ctx, project, token_ref).await {
                    Some((tenant, c)) => {
                        targets.push((tenant, c.id, repo, source.branch.unwrap_or_default()))
                    }
                    None => tracing::info!(
                        project_id,
                        repo,
                        "studio-components-catalog: a project source's connection is not visible"
                    ),
                }
            }
        }
        if let Ok(config) = am
            .get_metadata(ctx, project, ::gts::GtsTypeId::new(PROJECT_CONFIG_TYPE))
            .await
        {
            for (connection_id, repo) in project_sources(&config.value) {
                match connectors.locate(ctx, project, connection_id).await {
                    Some(tenant) => targets.push((tenant, connection_id, repo, String::new())),
                    None => tracing::info!(
                        project_id,
                        repo,
                        "studio-components-catalog: a project source's connection is not visible"
                    ),
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        targets.retain(|(_, connection_id, repo, _)| {
            seen.insert((*connection_id, repo.to_ascii_lowercase()))
        });

        let mut read = Vec::new();
        let mut deps = BTreeSet::new();
        for (tenant, connection_id, repo, branch) in targets {
            let Some(enricher) = RepoEnricher::new(
                Arc::clone(connectors),
                tenant,
                Some(connection_id),
                repo.clone(),
                branch,
                RepoMode::parse("gears"),
            ) else {
                continue;
            };
            match enricher.cargo_dependencies(ctx).await {
                Ok(found) => {
                    deps.extend(found);
                    read.push(repo);
                }
                Err(e) => {
                    tracing::warn!(project_id, repo, error = %format!("{e:#}"), "studio-components-catalog: a project source could not be read");
                }
            }
        }
        if read.is_empty() {
            return Ok(None);
        }
        Ok(Some((read.join(", "), deps)))
    }

    /// Connect (or update) the gear repository for a project. `repo` is an open
    /// JSON object — `{connection_id, repo, branch}` — and the service stamps in
    /// the `project_id` identity before persisting.
    pub async fn set_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        repo: Value,
    ) -> anyhow::Result<GtsNode> {
        let mut value = repo
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("gear repo must be a JSON object"))?;
        value.insert(
            "project_id".to_owned(),
            Value::String(project_id.to_owned()),
        );
        let node = gts::project_gear_repo_node(project_id, Value::Object(value));
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(node)
    }

    /// The product a project is composing, or `None` before anything was picked.
    pub async fn get_project_product(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let want = gts::project_product_instance_id(project_id);
        let nodes = self.sink.list(ctx, Some("project_product")).await?;
        Ok(nodes.into_iter().find(|n| n.instance_id == want))
    }

    /// Merge `patch` into the project's product record and persist it. A merge,
    /// not a replace: the picks are saved as they change, the last preview when
    /// it runs, and neither write may erase the other's half.
    pub async fn update_project_product(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        patch: serde_json::Map<String, Value>,
    ) -> anyhow::Result<GtsNode> {
        let mut value = self
            .get_project_product(ctx, project_id)
            .await?
            .and_then(|n| n.value.as_object().cloned())
            .unwrap_or_default();
        for (k, v) in patch {
            value.insert(k, v);
        }
        value.insert(
            "project_id".to_owned(),
            Value::String(project_id.to_owned()),
        );
        value.insert(
            "updated_at".to_owned(),
            Value::String(
                time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default(),
            ),
        );
        let node = gts::project_product_node(project_id, Value::Object(value));
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(node)
    }

    /// Write a scaffolded gear into the project's connected gear repository: a
    /// branch off the connected base branch carrying the skeleton files, and an
    /// optional pull request. The connection token is resolved via the
    /// connectors service (it stays in credstore).
    pub async fn scaffold_into_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        slug: &str,
        files: Vec<super::scaffold::ScaffoldFile>,
        open_pr: bool,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        let pr_title = open_pr.then(|| format!("Scaffold {slug} gear"));
        self.write_to_project_repo(
            ctx,
            project_id,
            Some(&format!("scaffold/{slug}")),
            &files,
            &format!("scaffold: {slug} gear skeleton"),
            pr_title.as_deref(),
        )
        .await
    }

    /// Commit files into the project's connected gear repository: on a new
    /// `branch` off its base branch (which must not exist yet), with a pull
    /// request when `pr_title` is given, or with `branch: None` straight onto
    /// the base branch. Returns the branch the commit landed on.
    pub async fn write_to_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        branch: Option<&str>,
        files: &[super::scaffold::ScaffoldFile],
        message: &str,
        pr_title: Option<&str>,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        let node = self
            .get_project_repo(ctx, project_id)
            .await?
            .ok_or_else(|| anyhow!("no gear repository is connected to this project"))?;
        let v = node.value;
        let repo = v
            .get("repo")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("connected gear repo has no 'repo'"))?
            .to_string();
        let base_branch = v
            .get("branch")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("main")
            .to_string();
        let tenant: Uuid = v
            .get("tenant")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow!("connected gear repo has no 'tenant'"))?;
        let connection_id: Option<Uuid> = v
            .get("connection_id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok());

        let connectors = self
            .connectors
            .as_ref()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let id = match connection_id {
            Some(id) => id,
            None => {
                connectors
                    .list(ctx, tenant)
                    .await?
                    .into_iter()
                    .find(|c| c.provider == "github")
                    .ok_or_else(|| anyhow!("no GitHub connection for this tenant"))?
                    .id
            }
        };
        let (_driver, auth, _conn) = connectors.driver_and_auth(ctx, tenant, id).await?;

        let http = reqwest::Client::new();
        super::scaffold::write_scaffold(
            &http,
            &auth,
            &repo,
            &base_branch,
            branch.unwrap_or(&base_branch),
            files,
            message,
            pr_title,
        )
        .await
    }

    /// Create a new repository through the connector and record it as this
    /// project's gear repository. Returns the created repo's full name and URL.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
    ) -> anyhow::Result<super::scaffold::CreatedRepo> {
        let connectors = self
            .connectors
            .as_ref()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let id = match connection_id {
            Some(id) => id,
            None => {
                connectors
                    .list(ctx, tenant)
                    .await?
                    .into_iter()
                    .find(|c| c.provider == "github")
                    .ok_or_else(|| anyhow!("no GitHub connection for this tenant"))?
                    .id
            }
        };
        let (_driver, auth, _conn) = connectors.driver_and_auth(ctx, tenant, id).await?;
        let http = reqwest::Client::new();
        let created =
            super::scaffold::create_repo(&http, &auth, owner, is_org, name, private).await?;
        // Record it as the project's gear repository so scaffolds land here.
        let repo_val = json!({
            "tenant": tenant,
            "connection_id": connection_id,
            "repo": created.full_name,
            "branch": created.default_branch,
        });
        self.set_project_repo(ctx, project_id, repo_val).await?;
        Ok(created)
    }
}

/// One phase, with what has been counted when it starts. Free-standing because
/// it needs nothing from the service.
///
/// One database UPDATE per call, so this belongs on phase boundaries. The
/// per-crate loop qualifies only because crates.io is paced at roughly one
/// request a second — a report per item in a tight loop would not.
fn report(progress: &SyncReporter, phase: String, gears: usize, versions: usize, stored: usize) {
    progress.set_with(
        phase,
        CatalogCounts {
            gears,
            versions,
            stored,
        }
        .as_detail(),
    );
}

/// Build a gear node, its version nodes and the `has_version` edges from one
/// crate's detail. Returns (nodes, edges, version-count).
fn build_gear(detail: &CrateDetail) -> (Vec<GtsNode>, Vec<GtsEdge>, usize) {
    let name = detail.krate.name.clone();
    let gear_id = gts::gear_instance_id(&name);

    // The newest non-yanked version that declares a licence — surfaced on the
    // gear node so the catalogue's Licence field fills without a manual entry.
    let latest_license = detail
        .versions
        .iter()
        .find(|v| v.yanked != Some(true) && v.license.is_some())
        .or_else(|| detail.versions.first())
        .and_then(|v| v.license.clone());

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
        "license": latest_license,
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

/// Which of the catalogue's existing nodes this run has made stale.
///
/// A node qualifies on two counts, and both matter:
///
/// * it says it came from a repository THIS run read (`synced_from`), so a run
///   that names a subset of the sources cannot delete what it did not look at,
///   and a crates.io-only run — which reads no repository — deletes nothing;
/// * this run did not produce it, which is what "gone from its source" means.
///
/// A node with no `synced_from` is stale only when nothing BUT a repository
/// scan can have produced its type — `scan_only`. A gear can come from
/// crates.io, and on this stand fifty-nine of the hundred and eighteen do; they
/// name `gears-rust` as their repository, which is why the obvious key does not
/// work and why an unrecorded source must not condemn them. A kit and a
/// micro-frontend have no such half: crates.io produces neither, so an
/// unrecorded source there is a node written before the field existed, and the
/// run that reads its repository is the one that should clear it.
fn stale<'a>(
    existing: &'a [GtsNode],
    produced: &BTreeSet<&str>,
    read_repos: &BTreeSet<String>,
    scan_only: bool,
) -> Vec<&'a GtsNode> {
    existing
        .iter()
        .filter(|node| !produced.contains(node.instance_id.as_str()))
        .filter(|node| {
            match node
                .value
                .get("synced_from")
                .and_then(Value::as_str)
                .filter(|from| !from.is_empty())
            {
                Some(from) => read_repos.contains(from),
                // No source recorded. For a gear that is the crates.io half of
                // the catalogue and must be left alone. For a type only a
                // repository scan can produce it is a node from a scan that ran
                // before the field existed, and leaving it would mean the
                // catalogue never recovers from its own history.
                None => scan_only,
            }
        })
        .collect()
}

/// Micro-frontends still filed as GEARS by a scan that predates their own
/// node type, and that this run did not produce.
///
/// Before `catalog.frontx.v1~` existed a FrontX package was written as a gear
/// node with `kind: "frontx"` and no `synced_from`, and [`stale`] must leave a
/// gear with no recorded source alone (that is the crates.io half). So those
/// nodes outlived every later scan: the catalogue showed each FrontX package
/// twice, once per type, plus the template placeholder
/// `@gears-frontx/{{mfeName}}-mfe` the old scan took for a package. crates.io
/// never produces `kind: "frontx"` (see [`classify_kind`]), so such a node can
/// only have come from a FrontX scan, and the run that reads FrontX is the one
/// that clears it.
fn misfiled_frontx<'a>(existing: &'a [GtsNode], produced: &BTreeSet<&str>) -> Vec<&'a GtsNode> {
    existing
        .iter()
        .filter(|node| !produced.contains(node.instance_id.as_str()))
        .filter(|node| node.value.get("kind").and_then(Value::as_str) == Some("frontx"))
        .filter(|node| {
            node.value
                .get("synced_from")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        })
        .collect()
}

/// Whether a scanned component is a gear or a request for one.
///
/// `draft` means a directory of documents: a `gear.toml`, maybe a PRD and a
/// DESIGN, and no crate under it. Ten of the forty-two gears in `gears-rust`
/// are in that state, `approval-service` and `graph-analytics` among them, and
/// interviewing Acronis (2026-09-18) that was the complaint, made while reading
/// the repository listing on screen: "тут есть документы, дизайн, но ничего
/// нету, реализации никакой нет. Вот как это считать?"
///
/// The catalogue answered that per consumer until now — each one derived it
/// from the crate count itself — so this computes it once, where the scan
/// already has the number.
///
/// ── Two things this deliberately does NOT do ─────────────────────────────
///
/// It does not read "or no tests", although the scenario draft defines `draft`
/// that way and the data looks available: `unitmods` counts `*_tests.rs` files
/// and `integfiles` counts `tests/*.rs`. Applying it would move five more gears
/// to `draft`, and three of those five — `llm-gateway`, `model-registry` and
/// `simple-user-settings` — are tested inline with `#[cfg(test)]` in their
/// source (five, nine and nine files respectively), which leaves no separate
/// test file to count. Seeing those would mean reading every `.rs` in every
/// gear rather than the file tree, which is a different cost class. Until the
/// scan can see an inline test, "no test file" is not "untested", and a status
/// that calls a working gear a request is worse than no status.
///
/// It does not emit `certified`. That rung of the ladder means an
/// expert-verified agent and granted approvals, and this deployment has
/// neither concept — there is no approval anywhere in the backend to read.
/// Emitting it from something else would put a word in the catalogue that
/// nothing backs.
/// `None` when the scan did not count crates for this component at all.
///
/// Absent is not zero. A component nobody walked has not been assessed, and
/// writing `draft` for it would put "cannot be plugged in" on something no
/// scan ever looked at. The consumer sees no status and says so, the same way
/// the matcher already distinguishes "no implementation" from "not scanned".
fn gear_status(fields: &Value) -> Option<&'static str> {
    let crates = fields
        .get("crates")
        .and_then(|v| v.get("n"))
        .and_then(Value::as_u64)?;
    Some(if crates == 0 { "draft" } else { "published" })
}

/// Classify a crate by name so the UI can group them: gear / sdk / plugin /
/// toolkit. Purely cosmetic — the graph keeps the full name.
pub(crate) fn classify_kind(name: &str) -> &'static str {
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

#[cfg(test)]
mod prune_tests {
    use super::*;

    fn node(id: &str, synced_from: Option<&str>) -> GtsNode {
        let value = match synced_from {
            Some(from) => json!({ "name": id, "synced_from": from }),
            None => json!({ "name": id }),
        };
        GtsNode {
            type_id: gts::GEAR_TYPE,
            instance_id: id.to_string(),
            value,
        }
    }

    fn repos(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|r| r.to_string()).collect()
    }

    #[test]
    fn a_component_gone_from_a_repository_this_run_read_is_stale() {
        let existing = vec![node(
            "kit:studio-kit-sdlc",
            Some("constructorfabric/studio-kit-sdlc"),
        )];
        let produced = BTreeSet::from(["kit:sdlc"]);
        let out = stale(
            &existing,
            &produced,
            &repos(&["constructorfabric/studio-kit-sdlc"]),
            false,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].instance_id, "kit:studio-kit-sdlc");
    }

    #[test]
    fn a_component_this_run_produced_is_not_stale() {
        let existing = vec![node("gear:a", Some("constructorfabric/gears-rust"))];
        let produced = BTreeSet::from(["gear:a"]);
        assert!(
            stale(
                &existing,
                &produced,
                &repos(&["constructorfabric/gears-rust"]),
                false,
            )
            .is_empty()
        );
    }

    #[test]
    fn a_crates_io_component_is_never_stale() {
        // Fifty-nine of the hundred and eighteen gear nodes on this stand come
        // from crates.io alone, and they name `gears-rust` as their repository.
        // Nothing but `synced_from` tells them apart from a scanned one.
        let existing = vec![node("gear:published-only", None)];
        let produced = BTreeSet::new();
        assert!(
            stale(
                &existing,
                &produced,
                &repos(&["constructorfabric/gears-rust"]),
                false,
            )
            .is_empty()
        );
    }

    #[test]
    fn a_run_that_did_not_read_the_repository_deletes_nothing_from_it() {
        // A sync may name any subset of its sources. One that reads only the
        // FrontX repository must not delete a gear it never looked for.
        let existing = vec![node("gear:a", Some("constructorfabric/gears-rust"))];
        let produced = BTreeSet::new();
        assert!(
            stale(
                &existing,
                &produced,
                &repos(&["constructorfabric/gears-frontx"]),
                false,
            )
            .is_empty()
        );
    }

    #[test]
    fn a_kit_written_before_the_field_existed_is_cleared_by_the_run_that_reads_its_repository() {
        // `studio-kit-sdlc` and `studio-kits-pm` were written by a scan that
        // named a kit after its repository and recorded no source. Nothing but
        // a repository scan produces a kit, so there is no crates.io half to
        // protect and leaving them would mean the catalogue never recovers.
        let existing = vec![node("kit:studio-kit-sdlc", None)];
        let produced = BTreeSet::from(["kit:sdlc"]);
        let out = stale(
            &existing,
            &produced,
            &repos(&["constructorfabric/studio-kit-sdlc"]),
            true,
        );
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn a_gear_with_no_recorded_source_survives_even_then() {
        // The flag is per type. A gear's unrecorded source means crates.io.
        let existing = vec![node("gear:published-only", None)];
        let produced = BTreeSet::new();
        assert!(
            stale(
                &existing,
                &produced,
                &repos(&["constructorfabric/gears-rust"]),
                false
            )
            .is_empty()
        );
    }

    #[test]
    fn a_frontx_package_left_filed_as_a_gear_is_misfiled() {
        let mut old = node("@gears-frontx/ui-kit", None);
        old.value["kind"] = json!("frontx");
        let mut placeholder = node("@gears-frontx/{{mfeName}}-mfe", None);
        placeholder.value["kind"] = json!("frontx");
        let crate_row = node("cf-gears-api-gateway", None);
        let mut scanned = node("@gears-frontx/api", Some("constructorfabric/gears-frontx"));
        scanned.value["kind"] = json!("frontx");
        let existing = vec![old, placeholder, crate_row, scanned];
        let out: Vec<&str> = misfiled_frontx(&existing, &BTreeSet::new())
            .into_iter()
            .map(|n| n.instance_id.as_str())
            .collect();
        assert_eq!(
            out,
            ["@gears-frontx/ui-kit", "@gears-frontx/{{mfeName}}-mfe"]
        );
    }

    #[test]
    fn a_frontx_node_this_run_produced_is_not_misfiled() {
        let mut n = node("@gears-frontx/ui-kit", None);
        n.value["kind"] = json!("frontx");
        let existing = vec![n];
        assert!(misfiled_frontx(&existing, &BTreeSet::from(["@gears-frontx/ui-kit"])).is_empty());
    }

    #[test]
    fn an_empty_source_name_is_not_a_match() {
        let existing = vec![node("gear:a", Some(""))];
        let produced = BTreeSet::new();
        assert!(stale(&existing, &produced, &repos(&[""]), false).is_empty());
    }
}

#[cfg(test)]
mod gear_status_tests {
    use super::*;

    fn fields(crates: u64) -> Value {
        json!({ "crates": { "n": crates, "v": crates.to_string() } })
    }

    #[test]
    fn a_directory_of_documents_is_a_request_for_a_gear() {
        assert_eq!(gear_status(&fields(0)), Some("draft"));
    }

    #[test]
    fn a_gear_with_a_crate_under_it_is_published() {
        assert_eq!(gear_status(&fields(1)), Some("published"));
        assert_eq!(gear_status(&fields(3)), Some("published"));
    }

    #[test]
    fn a_component_the_scan_did_not_count_has_no_status_at_all() {
        // Absent is not zero. Writing `draft` here would put "cannot be
        // plugged in" on a component no scan ever looked at.
        assert_eq!(gear_status(&json!({})), None);
        assert_eq!(gear_status(&json!({ "crates": {} })), None);
    }
}

#[cfg(test)]
mod field_schema_tests {
    //! The service half of field schemas, over the in-memory sink: what the
    //! REST layer would do, minus the transport. The overlay itself is tested
    //! in [`super::field_schema`]; these pin the round trip.

    use super::*;
    use crate::components_catalog::gts::{FRONTX_TYPE, GEAR_TYPE};

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca7))
            .subject_type("service")
            .subject_tenant_id(Uuid::from_u128(0x7e4a47))
            .build()
            .expect("security context")
    }

    fn service() -> CatalogService {
        CatalogService::new(
            Arc::new(MemorySink::default()),
            "constructorfabric".to_string(),
            None,
        )
    }

    fn one_group() -> Value {
        json!({
            "groups": [{
                "id": "summary",
                "title": "Ours",
                "icon": "S",
                "fields": [{
                    "key": "shell",
                    "label": "Shell contract",
                    "kind": "text",
                    "lamp": false,
                    "source": { "class": "repo", "ref": "frontx.json" }
                }]
            }]
        })
    }

    #[tokio::test]
    async fn a_tenant_that_saved_nothing_gets_the_builtins() {
        let schemas = service()
            .list_field_schemas(&ctx())
            .await
            .expect("list schemas");
        assert_eq!(schemas.len(), field_schema::builtin_schemas().len());
        assert!(schemas.iter().all(|s| s.owner == "builtin"));
    }

    #[tokio::test]
    async fn a_saved_schema_replaces_the_builtin_and_a_revert_brings_it_back() {
        let service = service();
        let ctx = ctx();

        service
            .save_field_schema(&ctx, FRONTX_TYPE, one_group())
            .await
            .expect("save");

        let after_save = service.list_field_schemas(&ctx).await.expect("list");
        let frontx = after_save
            .iter()
            .find(|s| s.describes == FRONTX_TYPE)
            .expect("frontx schema");
        assert_eq!(frontx.owner, "tenant");
        assert_eq!(frontx.groups[0].title, "Ours");
        // and nothing else moved
        assert_eq!(
            after_save
                .iter()
                .find(|s| s.describes == GEAR_TYPE)
                .expect("gear schema")
                .owner,
            "builtin"
        );

        service
            .delete_field_schema(&ctx, FRONTX_TYPE)
            .await
            .expect("revert");

        let after_revert = service.list_field_schemas(&ctx).await.expect("list");
        let frontx = after_revert
            .iter()
            .find(|s| s.describes == FRONTX_TYPE)
            .expect("frontx schema is back");
        assert_eq!(frontx.owner, "builtin");
        assert_eq!(frontx.fields().count(), 11);
    }

    /// Reverting is a state, not an event: a caller asking for "no schema of
    /// my own" should not have to know whether it had one.
    #[tokio::test]
    async fn reverting_a_type_that_was_never_overridden_succeeds() {
        service()
            .delete_field_schema(&ctx(), GEAR_TYPE)
            .await
            .expect("revert with nothing stored");
    }

    /// The identity comes from the path. A body that names a different type
    /// would otherwise give one stored node two identities.
    #[tokio::test]
    async fn the_body_cannot_rename_the_type_the_schema_describes() {
        let mut body = one_group();
        body["describes"] = Value::String(GEAR_TYPE.to_string());
        let saved = service()
            .save_field_schema(&ctx(), FRONTX_TYPE, body)
            .await
            .expect("save");
        assert_eq!(saved.describes, FRONTX_TYPE);
    }

    #[tokio::test]
    async fn a_type_id_that_is_not_one_is_refused() {
        for bad in ["", "frontx", "gts.frontx.v1~", "cf.studio.catalog.gear.v1~"] {
            assert!(
                service()
                    .save_field_schema(&ctx(), bad, one_group())
                    .await
                    .is_err(),
                "`{bad}` was accepted as a GTS type id"
            );
        }
    }

    /// A deployment that catalogues a component kind this build has never
    /// heard of can still give it a page. That is the point of storing the
    /// schemas rather than shipping them.
    #[tokio::test]
    async fn a_schema_can_be_stored_for_a_type_this_build_does_not_know() {
        let service = service();
        let ctx = ctx();
        let novel = "gts.cf.acme.catalog.dataset.v1~";
        service
            .save_field_schema(&ctx, novel, one_group())
            .await
            .expect("save");
        let schemas = service.list_field_schemas(&ctx).await.expect("list");
        assert!(schemas.iter().any(|s| s.describes == novel));
    }

    // ── which types are components ────────────────────────────────────────

    /// The four the deployment ships a page for, and nothing else. A graph
    /// full of files and commits does not become a catalogue of components
    /// because it is a graph.
    #[tokio::test]
    async fn the_builtin_components_are_the_types_with_a_builtin_page() {
        let marked: Vec<String> = service()
            .list_types(&ctx())
            .await
            .expect("list types")
            .into_iter()
            .filter(|t| t.component)
            .map(|t| t.leaf_id)
            .collect();
        assert_eq!(marked.len(), 4, "{marked:?}");
        assert!(marked.iter().any(|m| m == GEAR_TYPE));
        assert!(marked.iter().any(|m| m == FRONTX_TYPE));
    }

    #[tokio::test]
    async fn marking_a_type_makes_it_a_component_and_unmarking_takes_it_back() {
        let service = service();
        let ctx = ctx();
        let novel = "gts.cf.acme.catalog.dataset.v1~";

        let marked = service
            .set_type_component(&ctx, novel, true)
            .await
            .expect("mark");
        assert!(marked.component);

        let listed = service.list_types(&ctx).await.expect("list");
        let dataset = listed
            .iter()
            .find(|t| t.leaf_id == novel)
            .expect("the marked type is listed");
        assert!(dataset.component);
        assert_eq!(dataset.schema, "none", "a mark is not a layout");

        service
            .set_type_component(&ctx, novel, false)
            .await
            .expect("unmark");
        let listed = service.list_types(&ctx).await.expect("list");
        assert!(
            !listed.iter().any(|t| t.leaf_id == novel && t.component),
            "the type is still a component after unmarking"
        );
    }

    /// The failure this rule exists to prevent: ticking a box on the Objects
    /// page must not blank a page that took sixty-two fields to describe.
    #[tokio::test]
    async fn unmarking_a_builtin_component_leaves_its_layout_alone() {
        let service = service();
        let ctx = ctx();
        service
            .set_type_component(&ctx, GEAR_TYPE, false)
            .await
            .expect("unmark");

        let schemas = service.list_field_schemas(&ctx).await.expect("schemas");
        let gear = schemas
            .iter()
            .find(|s| s.describes == GEAR_TYPE)
            .expect("gear schema survives");
        assert_eq!(gear.fields().count(), 81);
        assert!(!gear.component);
        assert_eq!(gear.owner, "builtin");
    }

    /// Two statements about one type, written by two endpoints, neither
    /// erasing the other.
    #[tokio::test]
    async fn a_layout_and_a_mark_do_not_overwrite_each_other() {
        let service = service();
        let ctx = ctx();
        let novel = "gts.cf.acme.catalog.dataset.v1~";

        service
            .set_type_component(&ctx, novel, true)
            .await
            .expect("mark");
        service
            .save_field_schema(&ctx, novel, one_group())
            .await
            .expect("layout");

        let schemas = service.list_field_schemas(&ctx).await.expect("schemas");
        let dataset = schemas
            .iter()
            .find(|s| s.describes == novel)
            .expect("record");
        assert!(dataset.component, "writing a layout dropped the mark");
        assert_eq!(dataset.groups[0].title, "Ours");
        assert_eq!(dataset.owner, "tenant");

        // And reverting the layout leaves the mark standing.
        service
            .delete_field_schema(&ctx, novel)
            .await
            .expect("revert the layout");
        let schemas = service.list_field_schemas(&ctx).await.expect("schemas");
        let dataset = schemas
            .iter()
            .find(|s| s.describes == novel)
            .expect("the mark outlives the layout");
        assert!(dataset.component);
        assert!(dataset.groups.is_empty());
    }

    /// A record that agrees with what the tenant would inherit is deleted, not
    /// stored: an override that overrides nothing is a trap for the next
    /// reader, and it would also outlive a change to the built-in it copies.
    #[tokio::test]
    async fn a_record_that_agrees_with_the_inheritance_is_not_kept() {
        let service = service();
        let ctx = ctx();
        service
            .set_type_component(&ctx, GEAR_TYPE, true)
            .await
            .expect("mark a type that is already a component");
        assert!(
            service
                .stored_field_schema(&ctx, GEAR_TYPE)
                .await
                .expect("read back")
                .is_none(),
            "a redundant record was stored"
        );
    }

    /// A type the graph holds but nobody has an opinion about still belongs on
    /// the page — that is where the opinion gets formed.
    #[tokio::test]
    async fn a_type_with_no_record_is_listed_as_neither_component_nor_described() {
        let service = service();
        let ctx = ctx();
        // A node of a type the catalogue syncs, so the store has seen it.
        service
            .save_profile(&ctx, "cf-gears-toolkit", json!({ "title": "Toolkit" }))
            .await
            .expect("a profile node");

        let listed = service.list_types(&ctx).await.expect("list");
        let profile = listed
            .iter()
            .find(|t| t.leaf_id == crate::components_catalog::gts::GEAR_PROFILE_TYPE)
            .expect("the profile type is listed");
        assert!(!profile.component);
        assert_eq!(profile.schema, "none");
    }

    #[test]
    fn a_derived_graph_type_id_is_still_a_type_id() {
        assert!(is_gts_type_id(&gts::graph_type_id(GEAR_TYPE)));
        assert!(is_gts_type_id(GEAR_TYPE));
        assert!(!is_gts_type_id("gts.cf.studio.catalog.gear.v1"));
        assert!(!is_gts_type_id("gts.cf.studio.gear.v1~"));
    }
}

#[cfg(test)]
mod component_list_tests {
    //! What the Components page lists, now that an organization decides it.

    use super::*;
    use crate::components_catalog::gts::{FRONTX_TYPE, GEAR_TYPE};

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca8))
            .subject_type("service")
            .subject_tenant_id(Uuid::from_u128(0x7e4a48))
            .build()
            .expect("security context")
    }

    async fn with_two_kinds_of_node() -> CatalogService {
        let service = CatalogService::new(
            Arc::new(MemorySink::default()),
            "constructorfabric".to_string(),
            None,
        );
        let ctx = ctx();
        // One gear, one micro-frontend, one profile: three types, of which two
        // ship as components and one does not.
        let nodes = vec![
            gts::gear_node("cf-gears-toolkit", json!({ "name": "cf-gears-toolkit" })),
            gts::frontx_node("@cf/shell", json!({ "name": "@cf/shell" })),
            gts::gear_profile_node(
                "cf-gears-toolkit",
                json!({ "gear_name": "cf-gears-toolkit" }),
            ),
        ];
        service.sink.upsert(&ctx, &nodes, &[]).await.expect("seed");
        service
    }

    #[tokio::test]
    async fn the_list_is_the_marked_types_and_not_the_gear_type() {
        let service = with_two_kinds_of_node().await;
        let (nodes, truncated) = service
            .list_component_nodes(&ctx())
            .await
            .expect("list components");
        assert!(!truncated);
        let types: Vec<&str> = nodes.iter().map(|n| n.type_id.as_str()).collect();
        assert!(types.contains(&GEAR_TYPE), "{types:?}");
        assert!(
            types.contains(&FRONTX_TYPE),
            "a micro-frontend is a component and was not listed: {types:?}"
        );
        assert!(
            !types.iter().any(|t| t.contains("gear_profile")),
            "a profile is not a component: {types:?}"
        );
    }

    /// The mark decides the list. That is the whole feature, stated once.
    #[tokio::test]
    async fn unmarking_a_type_takes_its_nodes_off_the_page() {
        let service = with_two_kinds_of_node().await;
        let ctx = ctx();
        service
            .set_type_component(&ctx, FRONTX_TYPE, false)
            .await
            .expect("unmark");
        let (nodes, _) = service
            .list_component_nodes(&ctx)
            .await
            .expect("list components");
        assert!(!nodes.iter().any(|n| n.type_id == FRONTX_TYPE));
        assert!(nodes.iter().any(|n| n.type_id == GEAR_TYPE));
    }

    /// And marking one puts nodes of a type nothing shipped a page for on it.
    #[tokio::test]
    async fn marking_a_type_puts_its_nodes_on_the_page() {
        let service = with_two_kinds_of_node().await;
        let ctx = ctx();
        let profile_type = crate::components_catalog::gts::GEAR_PROFILE_TYPE;
        service
            .set_type_component(&ctx, profile_type, true)
            .await
            .expect("mark");
        let (nodes, _) = service
            .list_component_nodes(&ctx)
            .await
            .expect("list components");
        assert!(
            nodes.iter().any(|n| n.type_id == profile_type),
            "the newly marked type contributed nothing"
        );
    }

    /// A tenant that marks nothing gets an empty page rather than a wrong one.
    #[tokio::test]
    async fn a_tenant_that_marks_nothing_lists_nothing() {
        let service = with_two_kinds_of_node().await;
        let ctx = ctx();
        for schema in field_schema::builtin_schemas() {
            service
                .set_type_component(&ctx, &schema.describes, false)
                .await
                .expect("unmark");
        }
        let (nodes, truncated) = service
            .list_component_nodes(&ctx)
            .await
            .expect("list components");
        assert!(nodes.is_empty(), "{nodes:?}");
        assert!(!truncated);
    }
}

#[cfg(test)]
mod type_count_tests {
    //! What the Objects page puts in its "Objects" column.

    use super::*;
    use crate::components_catalog::gts::{FRONTX_TYPE, GEAR_TYPE};

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca9))
            .subject_type("service")
            .subject_tenant_id(Uuid::from_u128(0x7e4a49))
            .build()
            .expect("security context")
    }

    async fn seeded(gears: usize) -> CatalogService {
        let service = CatalogService::new(
            Arc::new(MemorySink::default()),
            "constructorfabric".to_string(),
            None,
        );
        let mut nodes: Vec<GtsNode> = (0..gears)
            .map(|i| gts::gear_node(&format!("gear-{i}"), json!({ "name": format!("gear-{i}") })))
            .collect();
        nodes.push(gts::frontx_node(
            "@cf/shell",
            json!({ "name": "@cf/shell" }),
        ));
        service
            .sink
            .upsert(&ctx(), &nodes, &[])
            .await
            .expect("seed");
        service
    }

    #[tokio::test]
    async fn a_type_is_counted_per_type_and_not_in_total() {
        let counts = seeded(3)
            .await
            .count_types(&ctx())
            .await
            .expect("count types");
        let by_type: std::collections::HashMap<&str, &TypeCount> =
            counts.iter().map(|c| (c.leaf_id.as_str(), c)).collect();
        assert_eq!(by_type[GEAR_TYPE].count, 3);
        assert_eq!(by_type[FRONTX_TYPE].count, 1);
        assert!(counts.iter().all(|c| !c.capped));
    }

    /// The number a reader sees must be a total or say that it is not. A
    /// capped count reported as a total is the page lying about their graph.
    #[tokio::test]
    async fn a_count_past_the_cap_reports_a_floor_and_says_so() {
        let service = CatalogService::new(
            Arc::new(MemorySink::default()),
            "constructorfabric".to_string(),
            None,
        );
        let ctx = ctx();
        let graph_type = gts::graph_type_id(GEAR_TYPE);
        let nodes: Vec<GtsNode> = (0..5)
            .map(|i| gts::gear_node(&format!("gear-{i}"), json!({ "name": format!("gear-{i}") })))
            .collect();
        service.sink.upsert(&ctx, &nodes, &[]).await.expect("seed");

        let (count, capped) = service
            .sink
            .count_of_type(&ctx, &graph_type, 2)
            .await
            .expect("count");
        assert_eq!(count, 2);
        assert!(
            capped,
            "five nodes counted under a cap of two read as exact"
        );

        let (count, capped) = service
            .sink
            .count_of_type(&ctx, &graph_type, 50)
            .await
            .expect("count");
        assert_eq!(count, 5);
        assert!(!capped);
    }

    /// A store that reports one abstract type and refuses to be asked how many
    /// instances it has — because a family is derived from and never
    /// instantiated, so that query can only ever return zero.
    struct FamilyOnlySink;

    const FAMILY: &str = "gts.cf.core.graph.owned_node.v1~";

    #[async_trait]
    impl CatalogSink for FamilyOnlySink {
        async fn register_types(&self, _ctx: &SecurityContext) -> anyhow::Result<()> {
            Ok(())
        }
        async fn upsert(
            &self,
            _ctx: &SecurityContext,
            _nodes: &[GtsNode],
            _edges: &[GtsEdge],
        ) -> anyhow::Result<()> {
            Ok(())
        }
        async fn list(
            &self,
            _ctx: &SecurityContext,
            _type_filter: Option<&str>,
        ) -> anyhow::Result<Vec<GtsNode>> {
            Ok(Vec::new())
        }
        async fn delete(&self, _ctx: &SecurityContext, _instance_id: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn node_types(&self, _ctx: &SecurityContext) -> anyhow::Result<Vec<GraphNodeType>> {
            Ok(vec![GraphNodeType {
                type_id: FAMILY.to_string(),
                leaf_id: FAMILY.to_string(),
                is_abstract: true,
            }])
        }
        async fn list_of_types(
            &self,
            _ctx: &SecurityContext,
            _graph_types: &[String],
            _limit: usize,
        ) -> anyhow::Result<(Vec<CatalogNodeView>, bool)> {
            Ok((Vec::new(), false))
        }
        async fn count_of_type(
            &self,
            _ctx: &SecurityContext,
            graph_type: &str,
            _cap: usize,
        ) -> anyhow::Result<(usize, bool)> {
            panic!("the graph was asked to count instances of the abstract {graph_type}");
        }
    }

    #[tokio::test]
    async fn an_abstract_type_is_reported_as_empty_without_asking_the_graph() {
        let service = CatalogService::new(
            Arc::new(FamilyOnlySink),
            "constructorfabric".to_string(),
            None,
        );
        let counts = service.count_types(&ctx()).await.expect("count types");
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].leaf_id, FAMILY);
        assert_eq!(counts[0].count, 0);
        assert!(!counts[0].capped);
    }
}

/// The graph-storage sink against a fake of the gear that keeps its
/// soft-delete rule: a tombstoned key refuses re-ingest before purge.
#[cfg(all(test, feature = "graph"))]
mod graph_sink_tests {
    use super::super::rest::StudioComponentsCatalogError;
    use super::*;
    use graph_storage_sdk::GraphStorageClientV1;
    use graph_storage_sdk::models::{
        DeleteOutcome, EdgeKey, ElementEnvelope, GraphRevision, GtsTypeId, IngestCounts,
        IngestOutcome, IngestRequest, NeighborhoodRequest, NodeKey, NodeRow, NodeView, Page,
        SearchRequest, SearchResponse, Subject, TraversalResponse, TraverseRequest, TypeQuery,
        TypeRecord, TypeRegistration,
    };
    use toolkit_canonical_errors::CanonicalError;

    #[derive(Clone)]
    struct Row {
        type_id: String,
        payload: Value,
        tombstoned: bool,
    }

    #[derive(Default)]
    struct FakeGraph {
        nodes: Mutex<BTreeMap<String, Row>>,
        edges: Mutex<Vec<(String, String)>>,
        deletes: Mutex<usize>,
    }

    impl FakeGraph {
        fn tombstone(&self, key: &str, type_id: &str) {
            self.nodes.lock().unwrap().insert(
                key.to_owned(),
                Row {
                    type_id: type_id.to_owned(),
                    payload: json!({}),
                    tombstoned: true,
                },
            );
        }
    }

    fn envelope(key: &str) -> ElementEnvelope {
        let subject = Subject {
            subject_id: Uuid::nil(),
            subject_type: None,
        };
        ElementEnvelope {
            tenant_id: Uuid::nil(),
            key: key.to_owned(),
            created_at: time::OffsetDateTime::UNIX_EPOCH,
            created_by: subject.clone(),
            updated_at: time::OffsetDateTime::UNIX_EPOCH,
            updated_by: subject,
            deleted_at: None,
            deleted_by: None,
            graph_revision: GraphRevision {
                source_epoch: 0,
                revision: 0,
            },
        }
    }

    fn revision() -> GraphRevision {
        GraphRevision {
            source_epoch: 0,
            revision: 0,
        }
    }

    fn not_found(key: &str) -> CanonicalError {
        StudioComponentsCatalogError::not_found("not found")
            .with_resource(key.to_owned())
            .create()
    }

    #[async_trait]
    impl GraphStorageClientV1 for FakeGraph {
        async fn register_types(
            &self,
            _ctx: &SecurityContext,
            _batch: Vec<TypeRegistration>,
        ) -> Result<Vec<TypeRecord>, CanonicalError> {
            Ok(Vec::new())
        }
        async fn get_type(
            &self,
            _ctx: &SecurityContext,
            _type_id: &GtsTypeId,
        ) -> Result<TypeRecord, CanonicalError> {
            unimplemented!()
        }
        async fn list_types(
            &self,
            _ctx: &SecurityContext,
            _query: TypeQuery,
        ) -> Result<Page<TypeRecord>, CanonicalError> {
            unimplemented!()
        }

        /// Atomic like the gear: one tombstoned key and nothing is written.
        async fn ingest(
            &self,
            _ctx: &SecurityContext,
            request: IngestRequest,
        ) -> Result<IngestOutcome, CanonicalError> {
            let mut nodes = self.nodes.lock().unwrap();
            for spec in &request.nodes {
                if nodes.get(&spec.node_key).is_some_and(|r| r.tombstoned) {
                    return Err(StudioComponentsCatalogError::aborted(format!(
                        "node key `{}` is tombstoned and cannot be re-ingested before purge",
                        spec.node_key
                    ))
                    .with_reason("CAS_CONFLICT")
                    .create());
                }
                assert!(
                    !nodes
                        .get(&spec.node_key)
                        .is_some_and(|r| r.type_id != spec.type_id),
                    "a same-key ingest may not change the type"
                );
                if let Some(payload) = &spec.payload {
                    assert!(!payload.to_string().contains("\\u0000"));
                }
            }
            for spec in &request.edges {
                for end in [&spec.src_node_key, &spec.dst_node_key] {
                    assert!(
                        nodes.get(end).is_some_and(|r| !r.tombstoned),
                        "edge endpoint `{end}` is not a live node"
                    );
                }
            }
            for spec in request.nodes {
                nodes.insert(
                    spec.node_key,
                    Row {
                        type_id: spec.type_id,
                        payload: spec.payload.unwrap_or_else(|| json!({})),
                        tombstoned: false,
                    },
                );
            }
            self.edges.lock().unwrap().extend(
                request
                    .edges
                    .into_iter()
                    .map(|e| (e.src_node_key, e.dst_node_key)),
            );
            Ok(IngestOutcome {
                revision: revision(),
                replayed: false,
                counts: IngestCounts::default(),
                per_item_nodes: None,
                per_item_edges: None,
            })
        }

        async fn delete_node(
            &self,
            _ctx: &SecurityContext,
            node_key: &NodeKey,
        ) -> Result<DeleteOutcome, CanonicalError> {
            *self.deletes.lock().unwrap() += 1;
            let mut nodes = self.nodes.lock().unwrap();
            let row = nodes.get_mut(node_key).ok_or_else(|| not_found(node_key))?;
            row.tombstoned = true;
            Ok(DeleteOutcome {
                revision: revision(),
                tombstoned_nodes: 1,
                tombstoned_edges: 0,
            })
        }
        async fn delete_edge(
            &self,
            _ctx: &SecurityContext,
            _edge_key: &EdgeKey,
        ) -> Result<DeleteOutcome, CanonicalError> {
            unimplemented!()
        }

        async fn get_node(
            &self,
            _ctx: &SecurityContext,
            node_key: &NodeKey,
            _adjacency_limit: Option<u32>,
        ) -> Result<NodeView, CanonicalError> {
            let nodes = self.nodes.lock().unwrap();
            let row = nodes
                .get(node_key)
                .filter(|r| !r.tombstoned)
                .ok_or_else(|| not_found(node_key))?;
            Ok(NodeView {
                node_key: node_key.clone(),
                type_id: row.type_id.clone(),
                name: None,
                payload: Some(row.payload.clone()),
                has_embedding: false,
                labels: Vec::new(),
                adjacency: Vec::new(),
                adjacency_truncated: false,
                envelope: envelope(node_key),
            })
        }

        async fn project_nodes(
            &self,
            _ctx: &SecurityContext,
            type_patterns: &[String],
            _query: toolkit_odata::ODataQuery,
        ) -> Result<toolkit_odata::Page<NodeRow>, CanonicalError> {
            let nodes = self.nodes.lock().unwrap();
            let items = nodes
                .iter()
                .filter(|(_, r)| !r.tombstoned && type_patterns.contains(&r.type_id))
                .map(|(k, r)| NodeRow {
                    node_key: k.clone(),
                    type_id: r.type_id.clone(),
                    name: None,
                    payload: Some(r.payload.clone()),
                    envelope: envelope(k),
                })
                .collect();
            Ok(toolkit_odata::Page::new(
                items,
                toolkit_odata::PageInfo {
                    next_cursor: None,
                    prev_cursor: None,
                    limit: 200,
                },
            ))
        }

        async fn search(
            &self,
            _ctx: &SecurityContext,
            _request: SearchRequest,
        ) -> Result<SearchResponse, CanonicalError> {
            unimplemented!()
        }
        async fn traverse(
            &self,
            _ctx: &SecurityContext,
            _request: TraverseRequest,
        ) -> Result<TraversalResponse, CanonicalError> {
            unimplemented!()
        }
        async fn neighborhood(
            &self,
            _ctx: &SecurityContext,
            _request: NeighborhoodRequest,
        ) -> Result<TraversalResponse, CanonicalError> {
            unimplemented!()
        }
        async fn revision(&self, _ctx: &SecurityContext) -> Result<GraphRevision, CanonicalError> {
            Ok(revision())
        }
    }

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca9))
            .subject_type("service")
            .subject_tenant_id(Uuid::from_u128(0x7e4a49))
            .build()
            .expect("security context")
    }

    fn sink() -> (Arc<FakeGraph>, GraphSink) {
        let fake = Arc::new(FakeGraph::default());
        (fake.clone(), GraphSink::new(fake))
    }

    fn gear(name: &str) -> GtsNode {
        gts::gear_node(name, json!({ "name": name, "synced_from": "org/gears" }))
    }

    async fn names(sink: &GraphSink) -> Vec<String> {
        let mut names: Vec<String> = sink
            .list(&ctx(), Some(gts::GEAR_TYPE))
            .await
            .unwrap()
            .into_iter()
            .map(|n| n.value["name"].as_str().unwrap_or_default().to_owned())
            .collect();
        names.sort();
        names
    }

    /// The failure on the stand: a pruned component that came back to its
    /// source aborted every later sync, because its key had been tombstoned.
    #[tokio::test]
    async fn a_pruned_component_that_comes_back_is_stored_again() {
        let (fake, sink) = sink();
        let ctx = ctx();
        sink.upsert(&ctx, &[gear("alpha"), gear("beta")], &[])
            .await
            .unwrap();

        sink.delete(&ctx, &gts::gear_instance_id("alpha"))
            .await
            .unwrap();
        assert_eq!(names(&sink).await, vec!["beta".to_owned()]);
        assert_eq!(
            *fake.deletes.lock().unwrap(),
            0,
            "a catalogue removal must never tombstone the key"
        );

        sink.upsert(&ctx, &[gear("alpha"), gear("beta")], &[])
            .await
            .unwrap();
        assert_eq!(
            names(&sink).await,
            vec!["alpha".to_owned(), "beta".to_owned()]
        );
    }

    #[tokio::test]
    async fn a_retired_node_is_neither_counted_nor_listed_by_type() {
        let (_, sink) = sink();
        let ctx = ctx();
        sink.upsert(&ctx, &[gear("alpha"), gear("beta")], &[])
            .await
            .unwrap();
        sink.delete(&ctx, &gts::gear_instance_id("alpha"))
            .await
            .unwrap();
        let graph_type = gts::graph_type_id(gts::GEAR_TYPE);
        assert_eq!(
            sink.count_of_type(&ctx, &graph_type, 100).await.unwrap(),
            (1, false)
        );
        let (views, truncated) = sink
            .list_of_types(&ctx, std::slice::from_ref(&graph_type), 100)
            .await
            .unwrap();
        assert!(!truncated);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].value["name"], "beta");
    }

    #[tokio::test]
    async fn removing_an_absent_or_retired_node_is_a_no_op() {
        let (_, sink) = sink();
        let ctx = ctx();
        sink.delete(&ctx, "never-written").await.unwrap();
        sink.upsert(&ctx, &[gear("alpha")], &[]).await.unwrap();
        let key = gts::gear_instance_id("alpha");
        sink.delete(&ctx, &key).await.unwrap();
        sink.delete(&ctx, &key).await.unwrap();
        assert!(names(&sink).await.is_empty());
    }

    /// A key tombstoned before this sink retired instead stays unwritable
    /// until the gear can purge it. It must cost that one component, not the
    /// whole sync.
    #[tokio::test]
    async fn a_key_already_tombstoned_is_skipped_with_its_edges_and_the_rest_is_stored() {
        let (fake, sink) = sink();
        let ctx = ctx();
        let dead = gear("dead");
        fake.tombstone(&dead.instance_id, &gts::graph_type_id(gts::GEAR_TYPE));
        let live = gear("live");
        let edges = vec![
            GtsEdge {
                type_id: gts::REL_HAS_VERSION,
                from: live.instance_id.clone(),
                to: dead.instance_id.clone(),
            },
            GtsEdge {
                type_id: gts::REL_HAS_VERSION,
                from: live.instance_id.clone(),
                to: live.instance_id.clone(),
            },
        ];
        sink.upsert(&ctx, &[dead, live.clone()], &edges)
            .await
            .unwrap();
        assert_eq!(names(&sink).await, vec!["live".to_owned()]);
        assert_eq!(
            *fake.edges.lock().unwrap(),
            vec![(live.instance_id.clone(), live.instance_id)]
        );
    }

    #[tokio::test]
    async fn a_nul_in_a_catalogue_payload_is_dropped_before_the_gear() {
        let (_, sink) = sink();
        let node = gts::gear_node("n", json!({ "name": "n", "description": "a\u{0}b" }));
        sink.upsert(&ctx(), &[node], &[]).await.unwrap();
        let listed = sink.list(&ctx(), Some(gts::GEAR_TYPE)).await.unwrap();
        assert_eq!(listed[0].value["description"], "ab");
    }

    #[test]
    fn the_tombstoned_key_is_read_from_the_gears_detail() {
        assert_eq!(
            tombstoned_key_in(
                "node key `78ad2322-2729-5c23-8770-c8a7074326a5` is tombstoned and cannot be \
                 re-ingested before purge"
            ),
            Some("78ad2322-2729-5c23-8770-c8a7074326a5")
        );
        assert_eq!(
            tombstoned_key_in("same source generation with different content"),
            None
        );
        assert_eq!(tombstoned_key_in("node key `` is tombstoned"), None);
    }

    #[test]
    fn only_an_abort_names_a_tombstoned_key() {
        let detail = "node key `k` is tombstoned and cannot be re-ingested before purge";
        let aborted = StudioComponentsCatalogError::aborted(detail)
            .with_reason("CAS_CONFLICT")
            .create();
        assert_eq!(tombstoned_key(&aborted).as_deref(), Some("k"));
        let other = StudioComponentsCatalogError::not_found(detail)
            .with_resource("k".to_owned())
            .create();
        assert_eq!(tombstoned_key(&other), None);
    }
}
