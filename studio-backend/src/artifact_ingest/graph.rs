//! The graph-store contract for artifact ingest.
//!
//! Artifacts are normalized into typed GTS nodes and handed to a
//! [`GraphStore`]. The real store is the graph-storage gear (see
//! `graph_backend::GraphStorageBackend`); [`InMemoryGraphStore`] is the
//! fallback when that gear is not linked (the `graph` Cargo feature is off) or
//! its client is not available.
//!
//! Every operation carries the caller's [`SecurityContext`] because the real
//! store is tenant-scoped; the in-memory fallback ignores it.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;

/// A GTS node to persist: its type id (`gts.cf.studio.artifact.*`), a
/// deterministic instance id (uuid5 of a stable key — idempotent across
/// syncs), and the payload.
#[derive(Debug, Clone)]
pub struct GtsNode {
    pub type_id: &'static str,
    pub instance_id: String,
    pub value: Value,
}

/// A GTS edge to persist: its type id (`gts.cf.studio.rel.*`) and the instance
/// ids of its endpoints (the same ids nodes are keyed on). Idempotent by
/// `(type, from, to)`, so re-syncing the same relation upserts.
#[derive(Debug, Clone)]
pub struct GtsEdge {
    pub type_id: &'static str,
    pub from: String,
    pub to: String,
}

/// A relation read back for the UI: endpoints resolved to node instance ids, so
/// the portal can match them against the nodes it already holds.
#[derive(Debug, Clone)]
pub struct GtsEdgeView {
    pub type_id: String,
    pub from: String,
    pub to: String,
}

/// The graph store contract. Batched, idempotent by instance id, and readable
/// back so the UI can list what was ingested.
#[async_trait]
pub trait GraphStore: Send + Sync {
    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()>;

    /// Upsert relations between already-upserted nodes. Endpoints are addressed
    /// by node instance id; a batch with a dangling endpoint is the caller's
    /// bug, so implementations may drop or reject such an edge.
    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()>;

    /// All stored nodes, optionally filtered to those whose type id contains
    /// `type_filter` (e.g. `issue`, `pull_request`, `file`, `repo`).
    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>>;

    /// The relations the UI draws — authored_by / modifies / artifact_of /
    /// contains — as endpoint instance-id pairs.
    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>>;
}

/// In-memory store: keyed by instance id, so a re-sync upserts. Not persistent
/// — it resets when the backend restarts. Swap for the real graph-storage
/// adapter once its API lands.
#[derive(Default)]
pub struct InMemoryGraphStore {
    nodes: Mutex<HashMap<String, GtsNode>>,
    /// Keyed by `type|from|to` so a re-sync upserts rather than duplicates.
    edges: Mutex<HashMap<String, GtsEdge>>,
}

#[async_trait]
impl GraphStore for InMemoryGraphStore {
    async fn upsert_nodes(&self, _ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        let total = {
            let mut map = self
                .nodes
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            for n in nodes {
                map.insert(n.instance_id.clone(), n.clone());
            }
            map.len()
        };
        tracing::info!(
            batch = nodes.len(),
            total,
            "studio-artifact-ingest: in-memory graph upsert"
        );
        Ok(())
    }

    async fn upsert_edges(&self, _ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        let total = {
            let mut map = self
                .edges
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            for e in edges {
                map.insert(format!("{}|{}|{}", e.type_id, e.from, e.to), e.clone());
            }
            map.len()
        };
        tracing::info!(
            batch = edges.len(),
            total,
            "studio-artifact-ingest: in-memory graph edge upsert"
        );
        Ok(())
    }

    async fn list(
        &self,
        _ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let out = {
            let map = self
                .nodes
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            map.values()
                .filter(|n| type_filter.is_none_or(|t| n.type_id.contains(t)))
                .cloned()
                .collect()
        };
        Ok(out)
    }

    async fn list_relations(&self, _ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        let out = {
            let map = self
                .edges
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            map.values()
                .map(|e| GtsEdgeView {
                    type_id: e.type_id.to_string(),
                    from: e.from.clone(),
                    to: e.to.clone(),
                })
                .collect()
        };
        Ok(out)
    }
}
