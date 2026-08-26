//! Transport-agnostic models exposed by the graph-storage contract.

use serde_json::Value;

/// Coarse counters describing the current state of a tenant's graph.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GraphStats {
    /// Number of nodes visible to the caller.
    pub nodes: u64,
    /// Number of edges visible to the caller.
    pub edges: u64,
    /// Monotonic revision, bumped whenever stored state changes.
    pub graph_revision: u64,
}

/// A node submitted for ingest, identified by its producer-supplied key.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeInput {
    /// Stable key, unique within the tenant. Re-ingesting a key updates it.
    pub node_key: String,
    /// GTS identifier of the node's registered type.
    pub type_id: String,
    /// Display name.
    pub name: String,
    /// Text fed to lexical search. `None` falls back to the display name, so a
    /// producer that supplies nothing is still findable by name rather than
    /// invisible — the column is `NOT NULL` and an empty one matches nothing.
    pub search_text: Option<String>,
    /// Attributes of this node, as a JSON **object**.
    ///
    /// `None` means "no opinion": whatever is stored is left alone, so a
    /// producer that knows only part of a node can upsert it without
    /// destroying attributes another producer wrote. `Some({})` clears them.
    /// A supplied payload **replaces** the stored one rather than merging into
    /// it — see `docs/graph-storage-api.md` for why.
    pub payload: Option<Value>,
    /// Embedding of the node's search text, if the producer computed one.
    ///
    /// The gear has no model and never computes embeddings itself. The length
    /// must match the column's dimension; a mismatch is refused at ingest
    /// rather than failing in the database.
    pub embedding: Option<Vec<f32>>,
}

/// An edge submitted for ingest, addressed by the node keys of its endpoints.
#[derive(Clone, Debug, PartialEq)]
pub struct EdgeInput {
    /// GTS identifier of the edge's registered type.
    pub type_id: String,
    /// Node key of the source endpoint.
    pub from: String,
    /// Node key of the target endpoint.
    pub to: String,
    /// Attributes of this edge. Same semantics as [`NodeInput::payload`].
    pub payload: Option<Value>,
}

/// Outcome of one ingest batch.
///
/// The counts are rows the database reported as inserted or updated, not the
/// size of the submitted batch: a re-ingest that changes nothing answers zero,
/// which is what makes them usable for drift detection.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IngestResult {
    /// Nodes inserted or updated.
    pub nodes_upserted: u64,
    /// Edges inserted or updated.
    pub edges_upserted: u64,
    /// Revision the graph reached once this batch committed.
    pub graph_revision: u64,
}

/// A node, resolved enough to list, draw, or inspect.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeView {
    /// Surrogate identifier, unique within the tenant. Not stable across
    /// tenants and not the producer's key.
    pub id: i64,
    /// Producer-supplied stable key.
    pub node_key: String,
    /// Display name.
    pub name: String,
    /// GTS identifier of the node's type.
    pub type_id: String,
    /// Attributes, present only when the caller asked for them.
    pub payload: Option<Value>,
}

/// An edge between two nodes the caller may see.
#[derive(Clone, Debug, PartialEq)]
pub struct EdgeView {
    /// Surrogate identifier of the edge itself.
    pub id: i64,
    /// Source node identifier.
    pub src: i64,
    /// Destination node identifier.
    pub dst: i64,
    /// GTS identifier of the edge's type.
    pub type_id: String,
    /// Attributes, present only when the caller asked for them.
    pub payload: Option<Value>,
}

/// A drawable neighbourhood: nodes plus the edges between them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Subgraph {
    /// Nodes reachable from the seeds within the requested depth.
    pub nodes: Vec<NodeView>,
    /// Edges whose **both** endpoints are in `nodes`.
    pub edges: Vec<EdgeView>,
    /// Whether the node budget truncated the result.
    pub truncated: bool,
}

/// A registered GTS type.
#[derive(Clone, Debug, PartialEq)]
pub struct TypeView {
    /// Interned identifier referenced by nodes and edges.
    pub id: i32,
    /// GTS identifier.
    pub type_id: String,
    /// `node`, `edge` or `attribute`.
    pub kind: String,
    /// Schema payloads of this type are validated against, when it has one.
    pub json_schema: Option<Value>,
}

/// Which way a traversal follows edges.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Direction {
    /// Follow edges out of the frontier.
    Outgoing,
    /// Follow edges into the frontier.
    Incoming,
    /// Follow edges either way.
    #[default]
    Both,
}

/// What a traversal asks for.
#[derive(Clone, Debug)]
pub struct TraversalQuery<'a> {
    /// Nodes the walk starts from.
    pub seeds: &'a [i64],
    /// How many hops; clamped to the configured maximum.
    pub depth: u8,
    /// Which way to follow edges.
    pub direction: Direction,
    /// GTS identifiers of edge types the walk may follow. Empty means any.
    pub edge_types: &'a [String],
    /// Whether reads carry node and edge attributes.
    pub include_payload: bool,
}

/// What a lexical search asks for.
#[derive(Clone, Debug)]
pub struct SearchQuery<'a> {
    /// Free text matched against the nodes' composed search text.
    pub text: &'a str,
    /// Maximum matches; clamped to the configured node budget.
    pub limit: u32,
    /// Whether matches carry their attributes.
    pub include_payload: bool,
}

/// What a hybrid retrieval asks for.
///
/// Vector similarity picks the seeds, the graph expands around them, and the
/// full-text predicate filters what is reached — one SQL statement.
#[derive(Clone, Debug)]
pub struct HybridQuery<'a> {
    /// Embedding of the caller's query. Nearest nodes to it seed the walk.
    pub query_vector: &'a [f32],
    /// Free text the reached nodes must match.
    pub text: &'a str,
    /// How many nearest neighbours seed the walk.
    pub seed_limit: u32,
    /// How many results to return.
    pub limit: u32,
}

/// One node reached by a hybrid retrieval.
#[derive(Clone, Debug, PartialEq)]
pub struct HybridHit {
    /// Node identifier.
    pub id: i64,
    /// Cosine distance between the node's embedding and the query vector.
    pub distance: f64,
}

/// A page of results and the cursor that continues it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Page<T> {
    /// The rows on this page.
    pub items: Vec<T>,
    /// Opaque cursor for the next page; `None` when this page is the last.
    pub next_cursor: Option<String>,
}

/// Which nodes a prune removes.
///
/// The filters are ANDed, and at least one must be present: a prune with no
/// filter at all would delete the tenant's whole graph, which is not an
/// operation this contract offers by accident.
#[derive(Clone, Debug, Default)]
pub struct PruneRequest {
    /// Only nodes of this GTS type.
    pub type_id: Option<String>,
    /// Only nodes whose key starts with this prefix — how an importer scopes a
    /// prune to the source it owns.
    pub node_key_prefix: Option<String>,
    /// Only nodes untouched since this instant, so the sweep after a re-import
    /// removes exactly what the import did not refresh.
    pub not_seen_since: Option<time::OffsetDateTime>,
}

/// What a delete or prune removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeleteResult {
    /// Nodes removed.
    pub nodes_deleted: u64,
    /// Edges removed, including those removed because an endpoint went away.
    pub edges_deleted: u64,
    /// Revision the graph reached once the deletion committed.
    pub graph_revision: u64,
}
