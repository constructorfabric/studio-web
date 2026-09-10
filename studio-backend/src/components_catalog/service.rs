//! Catalog orchestration: crates.io → typed GTS nodes → graph store.
//!
//! A sync lists every crate under the configured keyword, fetches each crate's
//! detail (with its version history), normalizes them to `gear` and
//! `crate_version` nodes joined by `has_version`, and upserts them into a graph
//! store. Like artifact-ingest it prefers the real graph-storage gear and falls
//! back to an in-memory store so the pipeline still runs (and the portal still
//! shows a catalog) when the graph feature is off.

use std::collections::{BTreeMap, HashMap};
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
        // Nodes must be written before edges. With phantom creation disabled,
        // this preserves graph integrity even when the boundaries split a
        // gear from one of its many crate-version nodes. Re-running after a
        // transient failure is safe: both node keys and edge tuples upsert.
        for chunk in nodes.chunks(NODE_INGEST_CHUNK) {
            let node_specs: Vec<NodeSpec> = chunk
                .iter()
                .map(|n| NodeSpec {
                    node_key: n.instance_id.clone(),
                    type_id: gts::graph_type_id(n.type_id),
                    name: Some(node_name(&n.value)),
                    payload: Some(n.value.clone()),
                    expected_version: None,
                })
                .collect();
            self.client
                .ingest(
                    ctx,
                    IngestRequest {
                        nodes: node_specs,
                        edges: Vec::new(),
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
                .map_err(|e| anyhow!("graph-storage node ingest: {e}"))?;
        }

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

    /// A soft delete in graph-storage, and idempotent here: deleting a node
    /// that is already gone is what "revert to the built-in" means when it was
    /// never overridden, and a caller should not have to know which.
    async fn delete(&self, ctx: &SecurityContext, instance_id: &str) -> anyhow::Result<()> {
        match self.client.delete_node(ctx, &instance_id.to_string()).await {
            Ok(_) => Ok(()),
            Err(toolkit_canonical_errors::CanonicalError::NotFound { .. }) => Ok(()),
            Err(e) => Err(anyhow!("graph-storage delete: {e}")),
        }
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
            total += page.items.len();
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

pub struct CatalogService {
    crates: CratesIoClient,
    sink: Arc<dyn CatalogSink>,
    keyword: String,
    connectors: Option<Arc<ConnectorService>>,
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
        }
    }

    /// The default crates.io keyword, used when a sync request omits one.
    pub fn default_keyword(&self) -> &str {
        &self.keyword
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
        let enricher = RepoEnricher::new(
            connectors,
            source.tenant,
            source.connection_id,
            source.repo.clone(),
            source.git_ref.clone(),
            RepoMode::parse(&source.mode),
        )
        .ok_or_else(|| anyhow!("invalid repository source"))?;
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
                            if let Some(payload) = rg.payload {
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
                            if let Some(obj) = entry.as_object_mut() {
                                obj.insert("kind".to_string(), Value::String(kind));
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

        tracing::info!(
            gears = gears_total,
            kits = kits_total,
            micro_frontends = frontx_total,
            versions = versions_total,
            stored,
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

        let branch = format!("scaffold/{slug}");
        let message = format!("scaffold: {slug} gear skeleton");
        let pr_title = open_pr.then(|| format!("Scaffold {slug} gear"));
        let http = reqwest::Client::new();
        super::scaffold::write_scaffold(
            &http,
            &auth,
            &repo,
            &base_branch,
            &branch,
            &files,
            &message,
            pr_title.as_deref(),
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
        assert_eq!(gear.fields().count(), 62);
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
