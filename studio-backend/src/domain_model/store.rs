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
    /// Compare-and-set on the node's stored version. `Some(0)` means **the
    /// node must not exist**: a live node's version is 1 or more, so the store
    /// refuses the write when one is already there. That is the only mutual
    /// exclusion available here — graph-storage takes an expected version on
    /// write but reports none on read, so a read-then-write CAS cannot be
    /// formed. A refusal surfaces as [`VERSION_TAKEN`].
    pub expected_version: Option<i64>,
    pub type_id: String,
    pub node_key: String,
    pub name: Option<String>,
    pub payload: Value,
}

/// An edge to upsert in a batch, endpoints addressed by node key. The optional
/// `discriminator` distinguishes parallel edges of the same type between the
/// same endpoints (e.g. two named relations both `declares` A -> B), so they
/// are stored as distinct edges rather than collapsing to one.
#[derive(Debug, Clone)]
pub struct EdgeUpsert {
    pub type_id: String,
    pub from: String,
    pub to: String,
    pub discriminator: Option<String>,
    pub payload: Option<Value>,
}

/// An edge read back from the graph: our type id and endpoint node keys.
#[derive(Debug, Clone)]
pub struct EdgeView {
    pub type_id: String,
    pub from: String,
    pub to: String,
}

/// The marker an upsert refused by its compare-and-set carries, so a caller
/// can tell "another writer got there first" from a real failure without
/// matching on the storage gear's own wording.
pub const VERSION_TAKEN: &str = "domain-model: node version already taken";

/// True for the refusal above.
pub fn is_version_taken(e: &anyhow::Error) -> bool {
    e.to_string().contains(VERSION_TAKEN)
}

/// True when an object belongs to `scope`. `None` matches everything; the
/// scope is tagged on the payload as `_scope` when the object is created.
fn in_scope(value: &serde_json::Value, scope: Option<&str>) -> bool {
    match scope {
        None => true,
        Some(s) => value.get("_scope").and_then(serde_json::Value::as_str) == Some(s),
    }
}

/// The domain-object store contract: register the types, create objects and
/// relations against them, and read the objects back.
#[async_trait]
pub trait DomainStore: Send + Sync {
    /// Register only the meta layer (the model + object_type nodes and the
    /// inherits/declares edges). Split out of [`Self::register_types`] because
    /// the model is *read back* from those types before there is an ontology to
    /// register the domain types from — the bootstrap has to start somewhere.
    async fn register_meta_types(&self, ctx: &SecurityContext) -> anyhow::Result<()>;

    /// Register the domain node and edge types. Idempotent — a byte-identical
    /// re-registration converges — so it is safe to call before every write.
    ///
    /// Returns the type ids whose *stored* schema differs from the one this
    /// model would register. Graph-storage treats a registered type's schema as
    /// immutable, so those keep what they were first registered with; the
    /// difference is reported rather than being either silently swallowed or
    /// fatal. See [`crate::domain_model::service::DomainModelService`] on why a
    /// model edit can produce one.
    async fn register_types(
        &self,
        ctx: &SecurityContext,
        node_types: &[NodeType],
        edge_types: &[EdgeType],
    ) -> anyhow::Result<Vec<String>>;

    /// Create (or upsert) one relation between two existing objects.
    ///
    /// `discriminator` names *which* declared relation this is, so two
    /// relations of the same verb between the same pair stay distinct edges
    /// rather than collapsing into one.
    async fn create_relation(
        &self,
        ctx: &SecurityContext,
        edge_type_id: &str,
        from: &str,
        to: &str,
        discriminator: Option<&str>,
        payload: Option<Value>,
    ) -> anyhow::Result<()>;

    /// One object by its instance id, whatever its type. `None` when the graph
    /// has no such node. Used to type-check a relation's endpoints against the
    /// model before writing it.
    async fn get_object(
        &self,
        ctx: &SecurityContext,
        instance_id: &str,
    ) -> anyhow::Result<Option<ObjectNode>>;

    /// The objects of the given (our) type ids, optionally narrowed to one
    /// workspace/project `scope`. `limit` caps how many are returned; `None`
    /// drains every page, which is only safe where the caller knows the set is
    /// small (the model graph is one node per entity).
    ///
    /// The scope filter belongs here rather than at the caller: it has to be
    /// applied while paging, or a bounded read would filter one page instead of
    /// the set and answer nothing for a scope that starts further in.
    async fn list_objects(
        &self,
        ctx: &SecurityContext,
        type_ids: &[String],
        scope: Option<&str>,
        limit: Option<usize>,
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

    /// Read the edges incident to the given node keys back out of the graph, as
    /// endpoint-keyed [`EdgeView`]s. Used to read the model and object graphs
    /// back. Deduplicated: an edge between two seeds is returned once.
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
    async fn register_meta_types(&self, _ctx: &SecurityContext) -> anyhow::Result<()> {
        Ok(())
    }

    async fn register_types(
        &self,
        _ctx: &SecurityContext,
        node_types: &[NodeType],
        edge_types: &[EdgeType],
    ) -> anyhow::Result<Vec<String>> {
        tracing::info!(
            nodes = node_types.len(),
            edges = edge_types.len(),
            "studio-domain-model: in-memory type registration (no-op)"
        );
        Ok(Vec::new())
    }

    async fn create_relation(
        &self,
        _ctx: &SecurityContext,
        edge_type_id: &str,
        from: &str,
        to: &str,
        discriminator: Option<&str>,
        _payload: Option<Value>,
    ) -> anyhow::Result<()> {
        let mut map = self
            .edges
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        map.insert(
            format!(
                "{}|{}",
                super::gts::edge_key(edge_type_id, from, to),
                discriminator.unwrap_or("")
            ),
            (edge_type_id.to_string(), from.to_string(), to.to_string()),
        );
        Ok(())
    }

    async fn get_object(
        &self,
        _ctx: &SecurityContext,
        instance_id: &str,
    ) -> anyhow::Result<Option<ObjectNode>> {
        Ok(self
            .nodes
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?
            .get(instance_id)
            .cloned())
    }

    async fn list_objects(
        &self,
        _ctx: &SecurityContext,
        type_ids: &[String],
        scope: Option<&str>,
        limit: Option<usize>,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        let rows = map
            .values()
            .filter(|n| type_ids.iter().any(|t| t == &n.type_id))
            .filter(|n| in_scope(&n.value, scope))
            .cloned();
        Ok(match limit {
            Some(n) => rows.take(n).collect(),
            None => rows.collect(),
        })
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
            if n.expected_version == Some(0) && map.contains_key(&n.node_key) {
                return Err(anyhow::anyhow!("{VERSION_TAKEN}: {}", n.node_key));
            }
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
            let key = format!(
                "{}|{}",
                super::gts::edge_key(&e.type_id, &e.from, &e.to),
                e.discriminator.as_deref().unwrap_or("")
            );
            map.insert(key, (e.type_id.clone(), e.from.clone(), e.to.clone()));
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
        EdgeSpec, IngestOptions, IngestRequest, NodeSpec, TraverseRequest, TypeRegistration,
    };
    use toolkit_odata::ODataQuery;

    use super::super::gts;
    use super::super::ontology::{EdgeType, NodeType};
    use super::{DomainStore, EdgeUpsert, EdgeView, NodeUpsert, ObjectNode};

    /// Nodes/edges per ingest batch, well under the gear's ceiling.
    const LIST_PAGE: u32 = 200;
    /// Seeds per traversal when reading edges back. One request carries the
    /// whole chunk, so this trades request size against round trips rather than
    /// against work done per node.
    const TRAVERSE_SEEDS: usize = 250;

    pub struct GraphStorageBackend {
        client: Arc<dyn GraphStorageClientV1>,
    }

    impl GraphStorageBackend {
        pub fn new(client: Arc<dyn GraphStorageClientV1>) -> Self {
            Self { client }
        }
    }

    /// True for graph-storage's refusal to re-register a type id under a
    /// different schema — the one refusal that is a *state* of the deployment
    /// rather than a fault: the registered schema is immutable, so the type
    /// keeps the one it has until a migration replaces it.
    fn is_schema_conflict(e: &impl std::fmt::Display) -> bool {
        e.to_string()
            .contains("already registered with a different schema")
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
        async fn register_meta_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
            let batch: Vec<TypeRegistration> = gts::meta_type_registrations()
                .into_iter()
                .map(|(type_id, schema)| TypeRegistration { type_id, schema })
                .collect();
            self.client
                .register_types(ctx, batch)
                .await
                .map_err(|e| anyhow::anyhow!("register domain meta types: {e}"))?;
            Ok(())
        }

        async fn register_types(
            &self,
            ctx: &SecurityContext,
            node_types: &[NodeType],
            edge_types: &[EdgeType],
        ) -> anyhow::Result<Vec<String>> {
            let mut batch: Vec<TypeRegistration> = Vec::new();
            for nt in node_types {
                batch.push(TypeRegistration {
                    type_id: gts::graph_type_id(&nt.type_id),
                    schema: gts::derived_node_schema(&nt.type_id),
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
            // One batch is the fast path and the normal one. It aborts whole,
            // though, and one immutable-schema refusal in it would otherwise
            // take down every write for the whole model — so a failed batch
            // falls back to registering type by type, which isolates the
            // refusals to the types that actually drifted.
            match self.client.register_types(ctx, batch.clone()).await {
                Ok(_) => Ok(Vec::new()),
                Err(batch_err) => {
                    let mut pinned: Vec<String> = Vec::new();
                    for one in batch {
                        let type_id = one.type_id.clone();
                        if let Err(e) = self.client.register_types(ctx, vec![one]).await {
                            if is_schema_conflict(&e) {
                                pinned.push(type_id);
                            } else {
                                return Err(anyhow::anyhow!("register domain types: {e}"));
                            }
                        }
                    }
                    if pinned.is_empty() {
                        // The batch failed for a reason no single registration
                        // reproduces; report the original rather than "fine".
                        return Err(anyhow::anyhow!("register domain types: {batch_err}"));
                    }
                    Ok(pinned)
                }
            }
        }

        async fn create_relation(
            &self,
            ctx: &SecurityContext,
            edge_type_id: &str,
            from: &str,
            to: &str,
            discriminator: Option<&str>,
            payload: Option<Value>,
        ) -> anyhow::Result<()> {
            let edge = EdgeSpec {
                type_id: gts::graph_type_id(edge_type_id),
                src_node_key: from.to_string(),
                dst_node_key: to.to_string(),
                discriminator: discriminator.map(str::to_string),
                payload,
            };
            self.client
                .ingest(ctx, ingest_one(Vec::new(), vec![edge]))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage domain relation ingest: {e}"))?;
            Ok(())
        }

        async fn get_object(
            &self,
            ctx: &SecurityContext,
            instance_id: &str,
        ) -> anyhow::Result<Option<ObjectNode>> {
            // The caller wants the node's type and payload, not its edges;
            // one is the smallest adjacency the gear accepts (0 is refused).
            match self
                .client
                .get_node(ctx, &instance_id.to_string(), Some(1))
                .await
            {
                Ok(view) => Ok(Some(ObjectNode {
                    type_id: gts::our_type_from_graph(&view.type_id),
                    instance_id: view.node_key,
                    value: view.payload.unwrap_or_else(|| serde_json::json!({})),
                })),
                Err(toolkit_canonical_errors::CanonicalError::NotFound { .. }) => Ok(None),
                Err(e) => Err(anyhow::anyhow!("graph-storage node read: {e}")),
            }
        }

        async fn list_objects(
            &self,
            ctx: &SecurityContext,
            type_ids: &[String],
            scope: Option<&str>,
            limit: Option<usize>,
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
            // Ask for no more than what is still wanted, so a bounded read costs
            // one page rather than draining the type.
            let page_size = |taken: usize| -> u32 {
                match limit {
                    // With a scope filter a page yields fewer rows than it
                    // costs, so narrowing the request would just add round
                    // trips: ask for full pages and stop on the count instead.
                    Some(_) if scope.is_some() => LIST_PAGE,
                    Some(n) => u32::try_from(n.saturating_sub(taken))
                        .unwrap_or(LIST_PAGE)
                        .clamp(1, LIST_PAGE),
                    None => LIST_PAGE,
                }
            };
            let mut query = ODataQuery::default().with_limit(u64::from(page_size(0)));
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
                    let value = row.payload.unwrap_or_else(|| serde_json::json!({}));
                    if !super::in_scope(&value, scope) {
                        continue;
                    }
                    out.push(ObjectNode {
                        type_id: our_type.clone(),
                        instance_id: row.node_key,
                        value,
                    });
                }
                if limit.is_some_and(|n| out.len() >= n) {
                    break;
                }
                let Some(next) = page.page_info.next_cursor else {
                    break;
                };
                let cursor = toolkit_odata::CursorV1::decode(&next).map_err(|e| {
                    anyhow::anyhow!("graph-storage returned an undecodable cursor: {e}")
                })?;
                query = ODataQuery::default()
                    .with_limit(u64::from(page_size(out.len())))
                    .with_cursor(cursor);
            }
            if let Some(n) = limit {
                out.truncate(n);
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
                    expected_version: n.expected_version,
                })
                .collect();
            let res = self
                .client
                .ingest(ctx, ingest_one(specs, Vec::new()))
                .await
                .map_err(|e| {
                    // A compare-and-set refusal is a race, not a fault: the
                    // caller retries against the new state. Everything else is
                    // reported as itself.
                    if e.to_string().contains("expected version") {
                        anyhow::anyhow!("{}: {e}", super::VERSION_TAKEN)
                    } else {
                        anyhow::anyhow!("graph-storage node batch ingest: {e}")
                    }
                })?;
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
                    discriminator: e.discriminator.clone(),
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

        /// One depth-1 traversal per chunk of seeds, not one node read per seed.
        ///
        /// This used to be a `get_node` per seed, which made the read cost one
        /// round trip per object: on 14 657 objects the instance-graph endpoint
        /// spent 26 s, effectively all of it waiting. The gear takes the whole
        /// seed set in a single `traverse` and answers 1 000 nodes with their
        /// edges in ~117 ms, so the batch primitive is what this should have
        /// used from the start.
        async fn read_edges(
            &self,
            ctx: &SecurityContext,
            seeds: &[String],
        ) -> anyhow::Result<Vec<EdgeView>> {
            let mut out: Vec<EdgeView> = Vec::new();
            // An edge between two seeds is reachable from both, and two seeds
            // can land in different chunks, so identical edges are collapsed.
            let mut seen: std::collections::HashSet<(String, String, String)> =
                std::collections::HashSet::new();
            for chunk in seeds.chunks(TRAVERSE_SEEDS) {
                let res = self
                    .client
                    .traverse(
                        ctx,
                        TraverseRequest {
                            seeds: chunk.to_vec(),
                            depth: 1,
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage traversal: {e}"))?;
                if let Some(reason) = res.truncated {
                    tracing::warn!(
                        seeds = chunk.len(),
                        ?reason,
                        "studio-domain-model: traversal truncated; some edges not shown"
                    );
                }
                for e in res.edges {
                    let view = EdgeView {
                        type_id: gts::our_type_from_graph(&e.edge_type_id),
                        from: e.src,
                        to: e.dst,
                    };
                    if seen.insert((view.type_id.clone(), view.from.clone(), view.to.clone())) {
                        out.push(view);
                    }
                }
            }
            Ok(out)
        }
    }
}

#[cfg(feature = "graph")]
pub use graph_backend::GraphStorageBackend;
