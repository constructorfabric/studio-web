//! Object-safe client trait registered in `ClientHub`.
//!
//! This is the whole contract an in-process consumer gets. It deliberately
//! mirrors the REST surface: a gear in the same binary should never have to
//! call the HTTP endpoints of its own process to read the graph.

use async_trait::async_trait;
use toolkit_security::SecurityContext;

use super::{
    DeleteResult, EdgeInput, EdgeView, GraphStats, GraphStorageError, HybridHit, HybridQuery,
    IngestResult, NodeInput, NodeView, Page, PruneRequest, SearchQuery, Subgraph, TraversalQuery,
    TypeView,
};

/// Object-safe client for in-process consumption by other gears (version 1).
#[async_trait]
pub trait GraphStorageClientV1: Send + Sync {
    // ── counters ──

    /// Return coarse counters for the caller's graph.
    async fn stats(&self, ctx: &SecurityContext) -> Result<GraphStats, GraphStorageError>;

    // ── types ──

    /// Register a GTS type so nodes and edges can reference it.
    ///
    /// Idempotent: registering an already-registered type returns its existing
    /// interned id. `json_schema` is optional; when present, payloads of this
    /// type are validated against it at ingest.
    async fn register_type(
        &self,
        ctx: &SecurityContext,
        type_id: &str,
        kind: &str,
        json_schema: Option<&serde_json::Value>,
    ) -> Result<i32, GraphStorageError>;

    /// Every type the caller may see.
    async fn types(&self, ctx: &SecurityContext) -> Result<Vec<TypeView>, GraphStorageError>;

    // ── write ──

    /// Upsert a batch of nodes and edges.
    ///
    /// Applied atomically: the whole batch commits or nothing does. Node keys
    /// and edge identities are derived, so repeating an identical batch
    /// converges instead of duplicating.
    async fn ingest(
        &self,
        ctx: &SecurityContext,
        nodes: &[NodeInput],
        edges: &[EdgeInput],
    ) -> Result<IngestResult, GraphStorageError>;

    /// Remove one node by its producer-supplied key, with its incident edges.
    async fn delete_node(
        &self,
        ctx: &SecurityContext,
        node_key: &str,
    ) -> Result<DeleteResult, GraphStorageError>;

    /// Remove one edge by its surrogate id.
    async fn delete_edge(
        &self,
        ctx: &SecurityContext,
        edge_id: i64,
    ) -> Result<DeleteResult, GraphStorageError>;

    /// Remove every node matching `request`, with their incident edges.
    ///
    /// This is the sweep an importer runs after a re-import: scope it by key
    /// prefix and `not_seen_since` and it removes exactly what the import did
    /// not refresh.
    async fn prune(
        &self,
        ctx: &SecurityContext,
        request: &PruneRequest,
    ) -> Result<DeleteResult, GraphStorageError>;

    // ── read ──

    /// One node by its producer-supplied key.
    async fn node_by_key(
        &self,
        ctx: &SecurityContext,
        node_key: &str,
        include_payload: bool,
    ) -> Result<Option<NodeView>, GraphStorageError>;

    /// One node by its surrogate id.
    async fn node_by_id(
        &self,
        ctx: &SecurityContext,
        id: i64,
        include_payload: bool,
    ) -> Result<Option<NodeView>, GraphStorageError>;

    /// A page of nodes, optionally of one type.
    async fn list_nodes(
        &self,
        ctx: &SecurityContext,
        type_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
        include_payload: bool,
    ) -> Result<Page<NodeView>, GraphStorageError>;

    /// A page of edges incident to one node.
    async fn list_edges(
        &self,
        ctx: &SecurityContext,
        node_id: i64,
        direction: super::Direction,
        cursor: Option<&str>,
        limit: u32,
        include_payload: bool,
    ) -> Result<Page<EdgeView>, GraphStorageError>;

    // ── traverse and search ──

    /// Node ids reachable from the seeds, bounded by depth and node budget.
    async fn neighbours(
        &self,
        ctx: &SecurityContext,
        query: &TraversalQuery<'_>,
    ) -> Result<Vec<i64>, GraphStorageError>;

    /// The same expansion, resolved into nodes and the edges between them.
    async fn subgraph(
        &self,
        ctx: &SecurityContext,
        query: &TraversalQuery<'_>,
    ) -> Result<Subgraph, GraphStorageError>;

    /// Rank nodes against free text, most relevant first.
    async fn search(
        &self,
        ctx: &SecurityContext,
        query: &SearchQuery<'_>,
    ) -> Result<Vec<NodeView>, GraphStorageError>;

    /// Vector similarity, graph expansion and full-text filtering in one
    /// statement.
    ///
    /// Requires nodes to carry embeddings; the gear never computes them.
    async fn hybrid(
        &self,
        ctx: &SecurityContext,
        query: &HybridQuery<'_>,
    ) -> Result<Vec<HybridHit>, GraphStorageError>;
}
