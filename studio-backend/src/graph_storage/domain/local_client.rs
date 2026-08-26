//! In-process adapter implementing the SDK client trait over domain services.
//!
//! Registered in `ClientHub` so other gears can use the graph without going
//! through HTTP. It shares the same services — and, once the admission and
//! policy layers land, the same enforcement — as the REST surface, so the two
//! cannot diverge in what they allow.
//!
//! Every method is a straight delegation on purpose. Any behaviour that lived
//! here would be behaviour the REST surface does not have.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit_security::SecurityContext;

use crate::graph_storage::domain::service::GraphServices;
use crate::graph_storage::sdk::{
    DeleteResult, Direction, EdgeInput, EdgeView, GraphStats, GraphStorageClientV1,
    GraphStorageError, HybridHit, HybridQuery, IngestResult, NodeInput, NodeView, Page,
    PruneRequest, SearchQuery, Subgraph, TraversalQuery, TypeView,
};

/// `ClientHub` adapter for in-process consumers.
pub struct GraphStorageLocalClient {
    services: Arc<GraphServices>,
}

impl GraphStorageLocalClient {
    /// Wrap the domain services in an object-safe client.
    #[must_use]
    pub fn new(services: Arc<GraphServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl GraphStorageClientV1 for GraphStorageLocalClient {
    async fn stats(&self, ctx: &SecurityContext) -> Result<GraphStats, GraphStorageError> {
        Ok(self.services.stats(ctx).await?)
    }

    async fn register_type(
        &self,
        ctx: &SecurityContext,
        type_id: &str,
        kind: &str,
        json_schema: Option<&serde_json::Value>,
    ) -> Result<i32, GraphStorageError> {
        Ok(self
            .services
            .register_type(ctx, type_id, kind, json_schema)
            .await?)
    }

    async fn types(&self, ctx: &SecurityContext) -> Result<Vec<TypeView>, GraphStorageError> {
        Ok(self.services.types(ctx).await?)
    }

    async fn ingest(
        &self,
        ctx: &SecurityContext,
        nodes: &[NodeInput],
        edges: &[EdgeInput],
    ) -> Result<IngestResult, GraphStorageError> {
        Ok(self.services.ingest(ctx, nodes, edges).await?)
    }

    async fn delete_node(
        &self,
        ctx: &SecurityContext,
        node_key: &str,
    ) -> Result<DeleteResult, GraphStorageError> {
        Ok(self.services.delete_node(ctx, node_key).await?)
    }

    async fn delete_edge(
        &self,
        ctx: &SecurityContext,
        edge_id: i64,
    ) -> Result<DeleteResult, GraphStorageError> {
        Ok(self.services.delete_edge(ctx, edge_id).await?)
    }

    async fn prune(
        &self,
        ctx: &SecurityContext,
        request: &PruneRequest,
    ) -> Result<DeleteResult, GraphStorageError> {
        Ok(self.services.prune(ctx, request).await?)
    }

    async fn node_by_key(
        &self,
        ctx: &SecurityContext,
        node_key: &str,
        include_payload: bool,
    ) -> Result<Option<NodeView>, GraphStorageError> {
        Ok(self
            .services
            .node_by_key(ctx, node_key, include_payload)
            .await?)
    }

    async fn node_by_id(
        &self,
        ctx: &SecurityContext,
        id: i64,
        include_payload: bool,
    ) -> Result<Option<NodeView>, GraphStorageError> {
        Ok(self.services.node_by_id(ctx, id, include_payload).await?)
    }

    async fn list_nodes(
        &self,
        ctx: &SecurityContext,
        type_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
        include_payload: bool,
    ) -> Result<Page<NodeView>, GraphStorageError> {
        Ok(self
            .services
            .list_nodes(ctx, type_id, cursor, limit, include_payload)
            .await?)
    }

    async fn list_edges(
        &self,
        ctx: &SecurityContext,
        node_id: i64,
        direction: Direction,
        cursor: Option<&str>,
        limit: u32,
        include_payload: bool,
    ) -> Result<Page<EdgeView>, GraphStorageError> {
        Ok(self
            .services
            .list_edges(ctx, node_id, direction, cursor, limit, include_payload)
            .await?)
    }

    async fn neighbours(
        &self,
        ctx: &SecurityContext,
        query: &TraversalQuery<'_>,
    ) -> Result<Vec<i64>, GraphStorageError> {
        Ok(self.services.neighbours(ctx, query).await?)
    }

    async fn subgraph(
        &self,
        ctx: &SecurityContext,
        query: &TraversalQuery<'_>,
    ) -> Result<Subgraph, GraphStorageError> {
        Ok(self.services.subgraph(ctx, query).await?)
    }

    async fn search(
        &self,
        ctx: &SecurityContext,
        query: &SearchQuery<'_>,
    ) -> Result<Vec<NodeView>, GraphStorageError> {
        Ok(self.services.search(ctx, query).await?)
    }

    async fn hybrid(
        &self,
        ctx: &SecurityContext,
        query: &HybridQuery<'_>,
    ) -> Result<Vec<HybridHit>, GraphStorageError> {
        Ok(self.services.hybrid(ctx, query).await?)
    }
}
