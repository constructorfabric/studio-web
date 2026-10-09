//! The store catalogue nodes live in: the graph-storage gear, or an in-memory
//! fallback when the `graph` feature is off.
//!
//! Shared by the gears that keep records in the catalogue graph:
//! `studio-components-catalog` (gears, versions, profiles, field schemas,
//! roadmap items, snapshots) and `studio-product` (a project's product and its
//! gear repository). Each gear builds its own [`CatalogSink`] with
//! [`build_sink`] and reads and writes only the node types it owns.

#[cfg(feature = "graph")]
use std::collections::BTreeSet;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use anyhow::anyhow;
use async_trait::async_trait;
use serde_json::Value;
#[cfg(feature = "graph")]
use serde_json::json;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;

use super::gts::{self, GtsEdge, GtsNode};

/// Resolve the store for `gear`. Prefers the real graph-storage gear (when the
/// `graph` feature is on and its client is published); otherwise the in-memory
/// fallback, so the gear still runs.
pub(crate) fn build_sink(hub: &ClientHub, gear: &str) -> Arc<dyn CatalogSink> {
    build(hub, gear, false)
}

/// [`build_sink`], answering every read with the context tenant's own nodes
/// alone.
///
/// graph-storage keeps the scope the PDP returned on a read, and Studio's
/// PDP admits the context tenant AND every organization the caller is a
/// member of (with their subtrees, where the hierarchy is asked for). That is
/// visibility, not ownership: a catalogue read in one tenant must not list a
/// node another tenant wrote under the same deterministic key. The
/// components catalogue keeps one catalogue per tenant and reads the
/// platform's beside an organization's (ADR-0042), so it asks for this.
pub(crate) fn build_sink_own_tenant(hub: &ClientHub, gear: &str) -> Arc<dyn CatalogSink> {
    build(hub, gear, true)
}

fn build(hub: &ClientHub, gear: &str, own_tenant_only: bool) -> Arc<dyn CatalogSink> {
    #[cfg(feature = "graph")]
    {
        match hub.get::<dyn graph_storage_sdk::GraphStorageClientV1>() {
            Ok(client) => {
                tracing::info!("{gear}: using the graph-storage gear as the catalog store");
                return Arc::new(GraphSink::new(client, own_tenant_only));
            }
            Err(e) => tracing::warn!(
                error = %e,
                "{gear}: graph-storage client unavailable — using the in-memory store"
            ),
        }
    }
    let _ = (hub, gear, own_tenant_only);
    Arc::new(MemorySink::default())
}

/// Where catalog nodes and edges are written and read. Two implementations: the
/// real graph-storage gear, and an in-memory fallback.
#[async_trait]
pub(crate) trait CatalogSink: Send + Sync {
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()>;
    /// Whether what one tenant writes is invisible to another, as in
    /// graph-storage. Only then can the catalogue read the platform's tier
    /// (ADR-0042) beside an organization's: a store that holds every tenant's
    /// nodes in one place would answer both reads with the same nodes.
    fn tenant_scoped(&self) -> bool {
        false
    }
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
    /// Write component snapshots (see `super::history`). Apart from
    /// [`Self::upsert`] because a snapshot is not a catalogue node: nothing
    /// that lists the catalogue may see one, and nothing in one is embedded.
    async fn write_snapshots(
        &self,
        _ctx: &SecurityContext,
        _nodes: &[GtsNode],
    ) -> anyhow::Result<()> {
        Ok(())
    }
    /// Snapshot payloads with `from_day <= day < to_day`, of one component
    /// or of every one. Unordered.
    async fn snapshots(
        &self,
        _ctx: &SecurityContext,
        _component: Option<&str>,
        _from_day: i64,
        _to_day: i64,
    ) -> anyhow::Result<Vec<Value>> {
        Ok(Vec::new())
    }
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
///
/// One map for every tenant by default -- the fallback a deployment without
/// graph-storage runs on. [`MemorySink::tenant_scoped`] keeps each tenant's
/// nodes apart, as graph-storage does, for what has to tell them apart (the
/// platform's tier beside an organization's, ADR-0042).
#[derive(Default)]
pub(crate) struct MemorySink {
    nodes: Mutex<HashMap<String, GtsNode>>,
    snapshots: Mutex<HashMap<String, Value>>,
    scoped: bool,
}

impl MemorySink {
    /// A store that keeps each tenant's nodes apart.
    #[allow(dead_code)]
    pub(crate) fn tenant_scoped() -> Self {
        Self {
            scoped: true,
            ..Self::default()
        }
    }

    /// The map key of `instance_id` written in `ctx`'s tenant.
    fn key(&self, ctx: &SecurityContext, instance_id: &str) -> String {
        if self.scoped {
            format!("{}/{instance_id}", ctx.subject_tenant_id())
        } else {
            instance_id.to_owned()
        }
    }

    /// Whether a stored key is `ctx`'s tenant's.
    fn mine(&self, ctx: &SecurityContext, key: &str) -> bool {
        !self.scoped || key.starts_with(&format!("{}/", ctx.subject_tenant_id()))
    }
}

#[async_trait]
impl CatalogSink for MemorySink {
    async fn register_types(&self, _ctx: &SecurityContext) -> anyhow::Result<()> {
        Ok(())
    }

    fn tenant_scoped(&self) -> bool {
        self.scoped
    }

    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        _edges: &[GtsEdge],
    ) -> anyhow::Result<()> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        for n in nodes {
            map.insert(self.key(ctx, &n.instance_id), n.clone());
        }
        Ok(())
    }

    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        Ok(map
            .iter()
            .filter(|(k, _)| self.mine(ctx, k))
            .map(|(_, n)| n)
            .filter(|n| type_filter.is_none_or(|t| n.type_id.contains(t)))
            .cloned()
            .collect())
    }

    async fn delete(&self, ctx: &SecurityContext, instance_id: &str) -> anyhow::Result<()> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        map.remove(&self.key(ctx, instance_id));
        Ok(())
    }

    /// The types this store has actually seen. It has no ontology of its own,
    /// so "registered" and "has a node" are the same question here — which is
    /// the honest answer for a fallback store, not a smaller one.
    async fn node_types(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GraphNodeType>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        let mut seen: BTreeMap<String, GraphNodeType> = BTreeMap::new();
        for node in map
            .iter()
            .filter(|(k, _)| self.mine(ctx, k))
            .map(|(_, n)| n)
        {
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
        ctx: &SecurityContext,
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
            .iter()
            .filter(|(k, _)| self.mine(ctx, k))
            .map(|(_, n)| n)
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
        ctx: &SecurityContext,
        graph_type: &str,
        cap: usize,
    ) -> anyhow::Result<(usize, bool)> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        let total = map
            .iter()
            .filter(|(k, _)| self.mine(ctx, k))
            .map(|(_, n)| n)
            .filter(|n| gts::graph_type_id(n.type_id) == graph_type)
            .count();
        Ok((total.min(cap), total > cap))
    }

    async fn write_snapshots(
        &self,
        _ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<()> {
        let mut map = self
            .snapshots
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        for n in nodes {
            map.insert(n.instance_id.clone(), n.value.clone());
        }
        Ok(())
    }

    async fn snapshots(
        &self,
        _ctx: &SecurityContext,
        component: Option<&str>,
        from_day: i64,
        to_day: i64,
    ) -> anyhow::Result<Vec<Value>> {
        let map = self
            .snapshots
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        Ok(map
            .values()
            .filter(|v| {
                let day = v.get("day").and_then(Value::as_i64).unwrap_or(-1);
                (from_day..to_day).contains(&day)
                    && component
                        .is_none_or(|c| v.get("component").and_then(Value::as_str) == Some(c))
            })
            .cloned()
            .collect())
    }
}

/// A snapshot's node name: which component, which day.
#[cfg(feature = "graph")]
fn snapshot_name(value: &Value) -> String {
    let part = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default();
    format!("{} @ {}", part("component"), part("date"))
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
    /// Keep only the rows the context tenant owns (`build_sink_own_tenant`).
    own_tenant_only: bool,
}

#[cfg(feature = "graph")]
impl GraphSink {
    pub(crate) fn new(
        client: Arc<dyn graph_storage_sdk::GraphStorageClientV1>,
        own_tenant_only: bool,
    ) -> Self {
        Self {
            client,
            own_tenant_only,
        }
    }

    /// Whether a row a read returned is one this read should answer with.
    fn owned(&self, ctx: &SecurityContext, row: &graph_storage_sdk::models::NodeRow) -> bool {
        !self.own_tenant_only || row.envelope.tenant_id == ctx.subject_tenant_id()
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
    fn tenant_scoped(&self) -> bool {
        self.own_tenant_only
    }

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
        self.client.register_types(ctx, batch).await.map_err(|e| {
            anyhow!(
                "register catalog types: {}",
                crate::graph_error::explain(&e)
            )
        })?;
        Ok(())
    }

    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> anyhow::Result<()> {
        use crate::artifact_ingest::sdk::{str_without_nul, without_nul};
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
                .map_err(|e| {
                    anyhow!(
                        "graph-storage edge ingest: {}",
                        crate::graph_error::explain(&e)
                    )
                })?;
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
                if is_retired(row.payload.as_ref()) || !self.owned(ctx, &row) {
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
                if is_retired(row.payload.as_ref()) || !self.owned(ctx, &row) {
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
                .filter(|row| !is_retired(row.payload.as_ref()) && self.owned(ctx, row))
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

    async fn write_snapshots(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<()> {
        use crate::artifact_ingest::sdk::{str_without_nul, without_nul};
        use graph_storage_sdk::models::NodeSpec;
        for chunk in nodes.chunks(NODE_INGEST_CHUNK) {
            let specs: Vec<NodeSpec> = chunk
                .iter()
                .map(|n| NodeSpec {
                    node_key: n.instance_id.clone(),
                    type_id: gts::graph_type_id(n.type_id),
                    name: Some(str_without_nul(snapshot_name(&n.value))),
                    payload: Some(without_nul(n.value.clone())),
                    expected_version: None,
                })
                .collect();
            self.client
                .ingest(ctx, node_batch(specs, false))
                .await
                .map_err(|e| {
                    anyhow!(
                        "graph-storage snapshot ingest: {}",
                        crate::graph_error::explain(&e)
                    )
                })?;
        }
        Ok(())
    }

    /// Filtered by the graph, on the two paths the snapshot type indexes, so a
    /// read costs the snapshots it asks for rather than every one ever taken.
    async fn snapshots(
        &self,
        ctx: &SecurityContext,
        component: Option<&str>,
        from_day: i64,
        to_day: i64,
    ) -> anyhow::Result<Vec<Value>> {
        use toolkit_odata::{CursorV1, ODataQuery};
        const PAGE: u64 = 200;
        let mut raw = format!("payload/day ge {from_day} and payload/day lt {to_day}");
        if let Some(name) = component {
            // OData quotes a quote by doubling it.
            raw.push_str(&format!(
                " and payload/component eq '{}'",
                name.replace('\'', "''")
            ));
        }
        let filter = toolkit_odata::parse_filter_string(&raw)
            .map_err(|e| anyhow!("snapshot filter `{raw}`: {e}"))?
            .into_expr();
        let patterns = [gts::graph_type_id(gts::COMPONENT_SNAPSHOT_TYPE)];
        let mut out: Vec<Value> = Vec::new();
        // A cursor is bound to the filter it was minted under, so every page
        // sends the filter again.
        let mut query = ODataQuery::default()
            .with_filter(filter.clone())
            .with_limit(PAGE);
        loop {
            let page = self
                .client
                .project_nodes(ctx, &patterns, query.clone())
                .await
                .map_err(|e| anyhow!("graph-storage snapshot projection: {e}"))?;
            out.extend(page.items.into_iter().filter_map(|row| row.payload));
            let Some(next) = page.page_info.next_cursor else {
                break;
            };
            let cursor = CursorV1::decode(&next)
                .map_err(|e| anyhow!("graph-storage returned an undecodable cursor: {e}"))?;
            query = ODataQuery::default()
                .with_filter(filter.clone())
                .with_limit(PAGE)
                .with_cursor(cursor);
        }
        Ok(out)
    }
}

/// The graph-storage sink against a fake of the gear that keeps its
/// soft-delete rule: a tombstoned key refuses re-ingest before purge.
#[cfg(all(test, feature = "graph"))]
mod graph_sink_tests {
    use super::*;
    use graph_storage_sdk::GraphStorageClientV1;
    use graph_storage_sdk::models::{
        DeleteOutcome, EdgeKey, ElementEnvelope, GraphRevision, GtsTypeId, IngestCounts,
        IngestOutcome, IngestRequest, NeighborhoodRequest, NodeKey, NodeRow, NodeView, Page,
        SearchRequest, SearchResponse, Subject, TraversalResponse, TraverseRequest, TypeQuery,
        TypeRecord, TypeRegistration,
    };
    use toolkit_canonical_errors::CanonicalError;
    use uuid::Uuid;

    /// Any resource error; the sink only reads its message.
    #[toolkit_canonical_errors::resource_error(gts_id!("cf.studio._.components_catalog.v1~"))]
    struct StudioComponentsCatalogError;

    #[derive(Clone)]
    struct Row {
        type_id: String,
        payload: Value,
        tombstoned: bool,
        /// The tenant that wrote it, as the gear's envelope records it.
        tenant: Uuid,
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
                    tenant: Uuid::nil(),
                },
            );
        }
    }

    fn envelope(key: &str, tenant: Uuid) -> ElementEnvelope {
        let subject = Subject {
            subject_id: Uuid::nil(),
            subject_type: None,
        };
        ElementEnvelope {
            tenant_id: tenant,
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
            ctx: &SecurityContext,
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
                        tenant: ctx.subject_tenant_id(),
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
                envelope: envelope(node_key, row.tenant),
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
                    envelope: envelope(k, r.tenant),
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
        (fake.clone(), GraphSink::new(fake, false))
    }

    fn in_tenant(tenant: u128) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca9))
            .subject_type("service")
            .subject_tenant_id(Uuid::from_u128(tenant))
            .build()
            .expect("security context")
    }

    /// The PDP admits more than the context tenant on a read -- every
    /// organization the caller is a member of -- and the fake answers every
    /// row, as such a scope would. A sink asked for its own tenant's nodes
    /// lists those alone; the shared one keeps what the scope admitted.
    #[tokio::test]
    async fn an_own_tenant_sink_lists_only_what_its_tenant_wrote() {
        let fake = Arc::new(FakeGraph::default());
        let own = GraphSink::new(fake.clone(), true);
        let shared = GraphSink::new(fake.clone(), false);
        assert!(own.tenant_scoped() && !shared.tenant_scoped());
        let (root, org) = (in_tenant(1), in_tenant(0xc31));
        own.upsert(&root, &[gear("cf-gears-ledger")], &[])
            .await
            .unwrap();
        own.upsert(&org, &[gear("acme-billing")], &[])
            .await
            .unwrap();

        async fn listed(sink: &GraphSink, ctx: &SecurityContext) -> Vec<String> {
            let mut names: Vec<String> = sink
                .list(ctx, Some(gts::GEAR_TYPE))
                .await
                .unwrap()
                .into_iter()
                .map(|n| n.value["name"].as_str().unwrap_or_default().to_owned())
                .collect();
            names.sort();
            names
        }
        assert_eq!(listed(&own, &root).await, vec!["cf-gears-ledger"]);
        assert_eq!(listed(&own, &org).await, vec!["acme-billing"]);
        assert_eq!(
            listed(&shared, &org).await,
            vec!["acme-billing", "cf-gears-ledger"]
        );
        let types = [gts::graph_type_id(gts::GEAR_TYPE)];
        let (of_type, _) = own.list_of_types(&org, &types, 10).await.unwrap();
        assert_eq!(of_type.len(), 1);
        assert_eq!(of_type[0].value["name"], "acme-billing");
        assert_eq!(
            own.count_of_type(&root, &types[0], 10).await.unwrap(),
            (1, false)
        );
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
