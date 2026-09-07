//! The store the domain model's objects live in.
//!
//! The real store is the graph-storage gear ([`GraphStorageBackend`], behind the
//! `graph` feature); [`InMemoryDomainStore`] is the fallback when that gear is
//! not linked or its client is unavailable, so the create/read loop still runs.
//!
//! Every domain type is registered as a graph type derived from a graph-storage
//! family (see [`super::gts`]); an object is a node keyed on a deterministic
//! instance id, so creating "the same" object twice upserts. The registered
//! type is open, so an object may carry fields the ontology has not (yet)
//! declared — which is what makes extending a type a pure ontology edit.

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;

use super::ontology::{EdgeType, NodeType};

/// An object read back out of the store.
#[derive(Debug, Clone)]
pub struct ObjectNode {
    /// Our GTS node type id (`gts.cf.studio.domain.team.v1~`).
    pub type_id: String,
    /// Deterministic instance id.
    pub instance_id: String,
    /// The object payload.
    pub value: Value,
}

/// A node to upsert in a batch, addressed by an explicit key. `type_id` is our
/// type id; the store applies the graph-type derivation. Used by the model-graph
/// sync (object-type nodes) where keys are computed by the caller.
#[derive(Debug, Clone)]
pub struct NodeUpsert {
    pub type_id: String,
    pub node_key: String,
    pub name: Option<String>,
    pub payload: Value,
}

/// An edge to upsert in a batch, endpoints addressed by node key.
#[derive(Debug, Clone)]
pub struct EdgeUpsert {
    pub type_id: String,
    pub from: String,
    pub to: String,
    pub payload: Option<Value>,
}

/// An edge read back from the graph: our type id and endpoint node keys.
#[derive(Debug, Clone)]
pub struct EdgeView {
    pub type_id: String,
    pub from: String,
    pub to: String,
}

/// The domain-object store contract: register the types, create objects and
/// relations against them, and read the objects back.
#[async_trait]
pub trait DomainStore: Send + Sync {
    /// Register the domain node and edge types. Idempotent — a byte-identical
    /// re-registration converges — so it is safe to call before every write.
    async fn register_types(
        &self,
        ctx: &SecurityContext,
        node_types: &[NodeType],
        edge_types: &[EdgeType],
    ) -> anyhow::Result<()>;

    /// Create (or upsert) one object of `type_id` at `instance_id`.
    async fn create_object(
        &self,
        ctx: &SecurityContext,
        type_id: &str,
        instance_id: &str,
        name: Option<String>,
        payload: Value,
    ) -> anyhow::Result<()>;

    /// Create (or upsert) one relation between two existing objects.
    async fn create_relation(
        &self,
        ctx: &SecurityContext,
        edge_type_id: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<()>;

    /// The objects of the given (our) type ids.
    async fn list_objects(
        &self,
        ctx: &SecurityContext,
        type_ids: &[String],
    ) -> anyhow::Result<Vec<ObjectNode>>;

    /// Upsert a batch of nodes (any registered type), returning the count. Used
    /// by the model-graph sync to materialize object-type nodes.
    async fn upsert_nodes(
        &self,
        ctx: &SecurityContext,
        nodes: &[NodeUpsert],
    ) -> anyhow::Result<u64>;

    /// Upsert a batch of edges (any registered type), returning the count.
    async fn upsert_edges(
        &self,
        ctx: &SecurityContext,
        edges: &[EdgeUpsert],
    ) -> anyhow::Result<u64>;

    /// Read the outgoing edges of the given node keys back out of the graph, as
    /// endpoint-keyed [`EdgeView`]s. Used to read the model graph back.
    async fn read_edges(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
    ) -> anyhow::Result<Vec<EdgeView>>;
}

// ── In-memory fallback ────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::Mutex;

/// In-memory store: keyed by instance id, so a re-create upserts. Not
/// persistent — resets on restart. The fallback for a build without the
/// graph-storage gear.
#[derive(Default)]
pub struct InMemoryDomainStore {
    nodes: Mutex<HashMap<String, ObjectNode>>,
    /// Keyed by `type|from|to` so a re-create upserts rather than duplicates.
    edges: Mutex<HashMap<String, (String, String, String)>>,
}

#[async_trait]
impl DomainStore for InMemoryDomainStore {
    async fn register_types(
        &self,
        _ctx: &SecurityContext,
        node_types: &[NodeType],
        edge_types: &[EdgeType],
    ) -> anyhow::Result<()> {
        tracing::info!(
            nodes = node_types.len(),
            edges = edge_types.len(),
            "studio-domain-model: in-memory type registration (no-op)"
        );
        Ok(())
    }

    async fn create_object(
        &self,
        _ctx: &SecurityContext,
        type_id: &str,
        instance_id: &str,
        _name: Option<String>,
        payload: Value,
    ) -> anyhow::Result<()> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        map.insert(
            instance_id.to_string(),
            ObjectNode {
                type_id: type_id.to_string(),
                instance_id: instance_id.to_string(),
                value: payload,
            },
        );
        Ok(())
    }

    async fn create_relation(
        &self,
        _ctx: &SecurityContext,
        edge_type_id: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<()> {
        let mut map = self
            .edges
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        map.insert(
            super::gts::edge_key(edge_type_id, from, to),
            (edge_type_id.to_string(), from.to_string(), to.to_string()),
        );
        Ok(())
    }

    async fn list_objects(
        &self,
        _ctx: &SecurityContext,
        type_ids: &[String],
    ) -> anyhow::Result<Vec<ObjectNode>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        Ok(map
            .values()
            .filter(|n| type_ids.iter().any(|t| t == &n.type_id))
            .cloned()
            .collect())
    }

    async fn upsert_nodes(
        &self,
        _ctx: &SecurityContext,
        nodes: &[NodeUpsert],
    ) -> anyhow::Result<u64> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        for n in nodes {
            map.insert(
                n.node_key.clone(),
                ObjectNode {
                    type_id: n.type_id.clone(),
                    instance_id: n.node_key.clone(),
                    value: n.payload.clone(),
                },
            );
        }
        Ok(nodes.len() as u64)
    }

    async fn upsert_edges(
        &self,
        _ctx: &SecurityContext,
        edges: &[EdgeUpsert],
    ) -> anyhow::Result<u64> {
        let mut map = self
            .edges
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        for e in edges {
            map.insert(
                super::gts::edge_key(&e.type_id, &e.from, &e.to),
                (e.type_id.clone(), e.from.clone(), e.to.clone()),
            );
        }
        Ok(edges.len() as u64)
    }

    async fn read_edges(
        &self,
        _ctx: &SecurityContext,
        seeds: &[String],
    ) -> anyhow::Result<Vec<EdgeView>> {
        let map = self
            .edges
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        Ok(map
            .values()
            .filter(|(_, from, _)| seeds.iter().any(|s| s == from))
            .map(|(type_id, from, to)| EdgeView {
                type_id: type_id.clone(),
                from: from.clone(),
                to: to.clone(),
            })
            .collect())
    }
}

// ── Real graph-storage backend ────────────────────────────────────────────

#[cfg(feature = "graph")]
mod graph_backend {
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde_json::Value;
    use toolkit_security::SecurityContext;

    use graph_storage_sdk::GraphStorageClientV1;
    use graph_storage_sdk::models::{
        AdjacencySide, EdgeSpec, IngestOptions, IngestRequest, NodeSpec, TypeRegistration,
    };
    use toolkit_odata::ODataQuery;

    use super::super::gts;
    use super::super::ontology::{EdgeType, NodeType};
    use super::{DomainStore, EdgeUpsert, EdgeView, NodeUpsert, ObjectNode};

    /// Nodes/edges per ingest batch, well under the gear's ceiling.
    const LIST_PAGE: u32 = 200;
    /// Outgoing edges read per node when reading the model graph back. The gear
    /// caps this at 100; the fan-out of a domain object type (its relations +
    /// one base) is well under that.
    const ADJACENCY_LIMIT: u32 = 100;

    pub struct GraphStorageBackend {
        client: Arc<dyn GraphStorageClientV1>,
    }

    impl GraphStorageBackend {
        pub fn new(client: Arc<dyn GraphStorageClientV1>) -> Self {
            Self { client }
        }
    }

    fn ingest_one(nodes: Vec<NodeSpec>, edges: Vec<EdgeSpec>) -> IngestRequest {
        IngestRequest {
            nodes,
            edges,
            options: IngestOptions {
                // An edge endpoint must already exist: a phantom would hide a
                // caller creating a relation before its objects.
                create_phantoms: Some(false),
                report_per_item: false,
                // Domain objects are small structured records; the graph can
                // still embed them for search, but it is not the point here.
                embed: Some(true),
            },
            replace_scope: None,
            idempotency_key: None,
        }
    }

    #[async_trait]
    impl DomainStore for GraphStorageBackend {
        async fn register_types(
            &self,
            ctx: &SecurityContext,
            node_types: &[NodeType],
            edge_types: &[EdgeType],
        ) -> anyhow::Result<()> {
            let mut batch: Vec<TypeRegistration> = Vec::new();
            for nt in node_types {
                batch.push(TypeRegistration {
                    type_id: gts::graph_type_id(&nt.type_id),
                    schema: gts::derived_schema(&nt.type_id),
                });
            }
            for et in edge_types {
                batch.push(TypeRegistration {
                    type_id: gts::graph_type_id(&et.type_id),
                    // Stable schema (no endpoint traits): a relation verb is
                    // reused across models with different endpoints, and
                    // graph-storage treats a registered type's schema as
                    // immutable — baking src/dst types in would make a model
                    // swap conflict. The endpoint typing is still computed and
                    // surfaced by GET /relations from the active ontology.
                    schema: gts::derived_schema(&et.type_id),
                });
            }
            // The meta layer: the object_type node + inherits/declares edges the
            // model-graph sync writes into.
            for (type_id, schema) in gts::meta_type_registrations() {
                batch.push(TypeRegistration { type_id, schema });
            }
            self.client
                .register_types(ctx, batch)
                .await
                .map_err(|e| anyhow::anyhow!("register domain types: {e}"))?;
            Ok(())
        }

        async fn create_object(
            &self,
            ctx: &SecurityContext,
            type_id: &str,
            instance_id: &str,
            name: Option<String>,
            payload: Value,
        ) -> anyhow::Result<()> {
            let node = NodeSpec {
                node_key: instance_id.to_string(),
                type_id: gts::graph_type_id(type_id),
                name: name.filter(|s| !s.is_empty()),
                payload: Some(payload),
                expected_version: None,
            };
            self.client
                .ingest(ctx, ingest_one(vec![node], Vec::new()))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage domain object ingest: {e}"))?;
            Ok(())
        }

        async fn create_relation(
            &self,
            ctx: &SecurityContext,
            edge_type_id: &str,
            from: &str,
            to: &str,
        ) -> anyhow::Result<()> {
            let edge = EdgeSpec {
                type_id: gts::graph_type_id(edge_type_id),
                src_node_key: from.to_string(),
                dst_node_key: to.to_string(),
                discriminator: None,
                payload: None,
            };
            self.client
                .ingest(ctx, ingest_one(Vec::new(), vec![edge]))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage domain relation ingest: {e}"))?;
            Ok(())
        }

        async fn list_objects(
            &self,
            ctx: &SecurityContext,
            type_ids: &[String],
        ) -> anyhow::Result<Vec<ObjectNode>> {
            if type_ids.is_empty() {
                return Ok(Vec::new());
            }
            // Map each requested our-type-id to its graph type, keeping the
            // reverse so a row's graph type resolves back to our id.
            let patterns: Vec<String> = type_ids.iter().map(|t| gts::graph_type_id(t)).collect();
            let reverse: Vec<(String, String)> = type_ids
                .iter()
                .map(|t| (gts::graph_type_id(t), t.clone()))
                .collect();

            let mut out: Vec<ObjectNode> = Vec::new();
            let mut query = ODataQuery::default().with_limit(u64::from(LIST_PAGE));
            loop {
                let page = self
                    .client
                    .project_nodes(ctx, &patterns, query.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage domain projection: {e}"))?;
                for row in page.items {
                    let Some((_, our_type)) = reverse.iter().find(|(g, _)| *g == row.type_id)
                    else {
                        continue;
                    };
                    out.push(ObjectNode {
                        type_id: our_type.clone(),
                        instance_id: row.node_key,
                        value: row.payload.unwrap_or_else(|| serde_json::json!({})),
                    });
                }
                let Some(next) = page.page_info.next_cursor else {
                    break;
                };
                let cursor = toolkit_odata::CursorV1::decode(&next).map_err(|e| {
                    anyhow::anyhow!("graph-storage returned an undecodable cursor: {e}")
                })?;
                query = ODataQuery::default()
                    .with_limit(u64::from(LIST_PAGE))
                    .with_cursor(cursor);
            }
            Ok(out)
        }

        async fn upsert_nodes(
            &self,
            ctx: &SecurityContext,
            nodes: &[NodeUpsert],
        ) -> anyhow::Result<u64> {
            if nodes.is_empty() {
                return Ok(0);
            }
            let specs: Vec<NodeSpec> = nodes
                .iter()
                .map(|n| NodeSpec {
                    node_key: n.node_key.clone(),
                    type_id: gts::graph_type_id(&n.type_id),
                    name: n.name.clone().filter(|s| !s.is_empty()),
                    payload: Some(n.payload.clone()),
                    expected_version: None,
                })
                .collect();
            let res = self
                .client
                .ingest(ctx, ingest_one(specs, Vec::new()))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage node batch ingest: {e}"))?;
            Ok(res.counts.nodes_inserted + res.counts.nodes_updated)
        }

        async fn upsert_edges(
            &self,
            ctx: &SecurityContext,
            edges: &[EdgeUpsert],
        ) -> anyhow::Result<u64> {
            if edges.is_empty() {
                return Ok(0);
            }
            let specs: Vec<EdgeSpec> = edges
                .iter()
                .map(|e| EdgeSpec {
                    type_id: gts::graph_type_id(&e.type_id),
                    src_node_key: e.from.clone(),
                    dst_node_key: e.to.clone(),
                    discriminator: None,
                    payload: e.payload.clone(),
                })
                .collect();
            let res = self
                .client
                .ingest(ctx, ingest_one(Vec::new(), specs))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage edge batch ingest: {e}"))?;
            Ok(res.counts.edges_inserted + res.counts.edges_updated)
        }

        async fn read_edges(
            &self,
            ctx: &SecurityContext,
            seeds: &[String],
        ) -> anyhow::Result<Vec<EdgeView>> {
            let mut out: Vec<EdgeView> = Vec::new();
            for seed in seeds {
                let view = self
                    .client
                    .get_node(ctx, seed, Some(ADJACENCY_LIMIT))
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage node read: {e}"))?;
                if view.adjacency_truncated {
                    tracing::warn!(
                        node = %seed,
                        limit = ADJACENCY_LIMIT,
                        "studio-domain-model: adjacency truncated; some model edges not shown"
                    );
                }
                for entry in view.adjacency {
                    if entry.side != AdjacencySide::Outgoing {
                        continue;
                    }
                    out.push(EdgeView {
                        type_id: gts::our_type_from_graph(&entry.edge_type_id),
                        from: seed.clone(),
                        to: entry.neighbor_key,
                    });
                }
            }
            Ok(out)
        }
    }
}

#[cfg(feature = "graph")]
pub use graph_backend::GraphStorageBackend;
