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

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;

use super::mirror::DomainMirror;
use super::ontology::{EdgeType, NodeType, Ontology};

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
    /// Which declared relation the edge is (`delivers`), from its
    /// discriminator. `None` when it is not known — written without one, or
    /// read by a traversal, which does not report it — and then it answers
    /// for every relation of its verb.
    pub relation: Option<String>,
    /// The graph's key for the edge, when it came from the graph: with
    /// [`super::gts::relation_of_key`] it tells which relation the edge is.
    pub key: Option<String>,
}

/// One step of a query along a relation: what [`DomainStore::neighbours`]
/// follows.
#[derive(Debug, Clone, Copy)]
pub struct Hop<'a> {
    /// Our edge type id (`gts.cf.studio.domainrel.owns.v1~`).
    pub edge_type_id: &'a str,
    /// The declared relation's name. An edge naming another relation of the
    /// same verb is not followed; one naming none is.
    pub relation: Option<&'a str>,
    /// The types the far end may be.
    pub node_type_ids: &'a [String],
    /// Follow the edge from its target back to its source.
    pub reverse: bool,
}

impl Hop<'_> {
    /// Does `e` belong to this hop, leaving one of `seeds` in its direction?
    /// Answers the neighbour it reaches.
    pub fn reaches<'e>(&self, e: &'e EdgeView, seeds: &HashSet<&str>) -> Option<&'e str> {
        if e.type_id != self.edge_type_id {
            return None;
        }
        if let (Some(want), Some(is)) = (self.relation, e.relation.as_deref())
            && want != is
        {
            return None;
        }
        let (near, far) = if self.reverse {
            (&e.to, &e.from)
        } else {
            (&e.from, &e.to)
        };
        seeds.contains(near.as_str()).then_some(far.as_str())
    }
}

/// The payload field a deleted object carries. Graph-storage never lets a
/// deleted node's key be written again (its tombstone is permanent until a
/// purge that is not built), and an object's key is derived from its type and
/// key, so deleting the node would forbid ever creating that object again.
/// Deleting marks it instead, and every read leaves it out.
pub const DELETED_FIELD: &str = "_deleted";

/// False for an object marked deleted.
pub fn is_live(value: &Value) -> bool {
    !value
        .get(DELETED_FIELD)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The objects one hop out of a set of seeds along one edge type, with the
/// edges that reach them — what [`DomainStore::neighbours`] answers.
#[derive(Debug, Clone, Default)]
pub struct Neighbourhood {
    /// The hop's edges, deduplicated, each turned to run from the seed to the
    /// neighbour (so a reverse hop's edges read target → source).
    pub edges: Vec<EdgeView>,
    /// The objects those edges reach, of the asked node types only.
    pub nodes: Vec<ObjectNode>,
    /// The graph stopped early (a traversal budget), so some neighbours are
    /// missing.
    pub truncated: bool,
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

    /// [`Self::upsert_nodes`] for a rewrite that changes no prose: the stored
    /// vectors are kept rather than recomputed.
    ///
    /// Renaming a payload key across ten thousand objects would otherwise
    /// re-embed every one of them, for a change that touches none of the paths
    /// that are embedded. The lexical index is rebuilt either way — that one is
    /// composed from the payload on every write.
    async fn upsert_nodes_keeping_vectors(
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

    /// The objects of the hop's node types reached from `seeds` by one edge
    /// of the hop, with those edges. One call per relation and nesting level
    /// of a query, for every row at once, rather than one read per row.
    ///
    /// The default reads the edges and then each endpoint. The graph backend
    /// answers it with one typed traversal, which returns the payloads too.
    async fn neighbours(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
        hop: Hop<'_>,
    ) -> anyhow::Result<Neighbourhood> {
        let from: HashSet<&str> = seeds.iter().map(String::as_str).collect();
        let mut edges: Vec<EdgeView> = Vec::new();
        let mut seen_edges: HashSet<(String, String)> = HashSet::new();
        for e in self.read_edges(ctx, seeds).await? {
            let Some(far) = hop.reaches(&e, &from) else {
                continue;
            };
            let near = if hop.reverse { &e.to } else { &e.from };
            if seen_edges.insert((near.clone(), far.to_string())) {
                edges.push(EdgeView {
                    type_id: e.type_id.clone(),
                    from: near.clone(),
                    to: far.to_string(),
                    relation: e.relation.clone(),
                    key: e.key.clone(),
                });
            }
        }
        let mut nodes: Vec<ObjectNode> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for e in &edges {
            if !seen.insert(e.to.as_str()) {
                continue;
            }
            if let Some(n) = self.get_object(ctx, &e.to).await?
                && hop.node_type_ids.contains(&n.type_id)
            {
                nodes.push(n);
            }
        }
        Ok(Neighbourhood {
            edges,
            nodes,
            truncated: false,
        })
    }

    /// Remove the relation `from` → `to` of `edge_type_id`. With `relation`,
    /// only the edge naming that declared relation (or naming none). Answers
    /// whether an edge was there to remove.
    async fn delete_relation(
        &self,
        _ctx: &SecurityContext,
        _edge_type_id: &str,
        _from: &str,
        _to: &str,
        _relation: Option<&str>,
    ) -> anyhow::Result<bool> {
        anyhow::bail!("this domain store cannot remove relations")
    }

    /// Objects of `type_ids` the text finds, best first. The graph runs its
    /// hybrid search; a store without one finds nothing.
    async fn search(
        &self,
        _ctx: &SecurityContext,
        _text: &str,
        _type_ids: &[String],
        _limit: u32,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        Ok(Vec::new())
    }

    /// The Postgres mirror that answers queries for the caller's tenant, when
    /// one is there and complete (ADR-0051). `None` means "read the graph";
    /// a store with a mirror starts filling it then, from the objects of
    /// `ontology` (the tenant's model), so a later read finds it.
    async fn read_model(
        &self,
        _ctx: &SecurityContext,
        _ontology: &Ontology,
    ) -> Option<Arc<DomainMirror>> {
        None
    }
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
    /// Keyed by `type|from|to|relation` so a re-create upserts rather than
    /// duplicates.
    edges: Mutex<HashMap<String, EdgeView>>,
}

impl InMemoryDomainStore {
    fn edge_entry(
        type_id: &str,
        from: &str,
        to: &str,
        relation: Option<&str>,
    ) -> (String, EdgeView) {
        (
            format!(
                "{}|{}",
                super::gts::edge_key(type_id, from, to),
                relation.unwrap_or("")
            ),
            EdgeView {
                type_id: type_id.to_string(),
                from: from.to_string(),
                to: to.to_string(),
                relation: relation.map(str::to_string),
                key: None,
            },
        )
    }
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
        let (key, edge) = Self::edge_entry(edge_type_id, from, to, discriminator);
        self.edges
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?
            .insert(key, edge);
        Ok(())
    }

    async fn delete_relation(
        &self,
        _ctx: &SecurityContext,
        edge_type_id: &str,
        from: &str,
        to: &str,
        relation: Option<&str>,
    ) -> anyhow::Result<bool> {
        let mut map = self
            .edges
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        let before = map.len();
        map.retain(|_, e| {
            !(e.type_id == edge_type_id
                && e.from == from
                && e.to == to
                && (relation.is_none()
                    || e.relation.is_none()
                    || e.relation.as_deref() == relation))
        });
        Ok(map.len() != before)
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
            .filter(|n| is_live(&n.value))
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
            .filter(|n| in_scope(&n.value, scope) && is_live(&n.value))
            .cloned();
        Ok(match limit {
            Some(n) => rows.take(n).collect(),
            None => rows.collect(),
        })
    }

    async fn upsert_nodes_keeping_vectors(
        &self,
        ctx: &SecurityContext,
        nodes: &[NodeUpsert],
    ) -> anyhow::Result<u64> {
        self.upsert_nodes(ctx, nodes).await
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
            let (key, edge) =
                Self::edge_entry(&e.type_id, &e.from, &e.to, e.discriminator.as_deref());
            map.insert(key, edge);
        }
        Ok(edges.len() as u64)
    }

    /// Incident either way, as the graph's depth-1 traversal is.
    async fn read_edges(
        &self,
        _ctx: &SecurityContext,
        seeds: &[String],
    ) -> anyhow::Result<Vec<EdgeView>> {
        let seeds: HashSet<&str> = seeds.iter().map(String::as_str).collect();
        let map = self
            .edges
            .lock()
            .map_err(|_| anyhow::anyhow!("domain store lock poisoned"))?;
        Ok(map
            .values()
            .filter(|e| seeds.contains(e.from.as_str()) || seeds.contains(e.to.as_str()))
            .cloned()
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
    use super::{DomainStore, EdgeUpsert, EdgeView, Neighbourhood, NodeUpsert, ObjectNode};

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

        /// One node batch. `embed` false keeps the stored vectors, for a
        /// rewrite that changes nothing they are computed from.
        async fn write_nodes(
            &self,
            ctx: &SecurityContext,
            nodes: &[NodeUpsert],
            embed: bool,
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
                .ingest(ctx, ingest_with(specs, Vec::new(), embed))
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
        ingest_with(nodes, edges, true)
    }

    fn ingest_with(nodes: Vec<NodeSpec>, edges: Vec<EdgeSpec>, embed: bool) -> IngestRequest {
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
                // `false` keeps the stored vectors rather than clearing them.
                embed: Some(embed),
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
            self.client.register_types(ctx, batch).await.map_err(|e| {
                anyhow::anyhow!(
                    "register domain meta types: {}",
                    crate::graph_error::explain(&e)
                )
            })?;
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

        /// The edge is found by a depth-1 walk from its source, because a
        /// delete names the edge's key and only a read reports it. A deleted
        /// edge comes back when the same relation is created again.
        async fn delete_relation(
            &self,
            ctx: &SecurityContext,
            edge_type_id: &str,
            from: &str,
            to: &str,
            relation: Option<&str>,
        ) -> anyhow::Result<bool> {
            let res = self
                .client
                .traverse(
                    ctx,
                    TraverseRequest {
                        seeds: vec![from.to_string()],
                        depth: 1,
                        edge_type_patterns: vec![gts::graph_type_id(edge_type_id)],
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage traversal: {e}"))?;
            let mut removed = false;
            for e in res.edges {
                // The named relation, or an edge that names none.
                let same_relation = match relation {
                    None => true,
                    Some(r) => {
                        gts::relation_of_key(edge_type_id, from, to, &e.edge_key, [r]).is_some()
                    }
                };
                if e.src != from || e.dst != to || !same_relation {
                    continue;
                }
                self.client
                    .delete_edge(ctx, &e.edge_key)
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage edge delete: {e}"))?;
                removed = true;
            }
            Ok(removed)
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
                // Only this tenant's, as in `list_objects`.
                Ok(view) if view.envelope.tenant_id != ctx.subject_tenant_id() => Ok(None),
                Ok(view) => Ok(Some(ObjectNode {
                    type_id: gts::our_type_from_graph(&view.type_id),
                    instance_id: view.node_key,
                    value: view.payload.unwrap_or_else(|| serde_json::json!({})),
                })
                .filter(|n| super::is_live(&n.value))),
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
                    // The projection answers every tenant the caller reaches
                    // (a platform administrator reaches them all, a member of
                    // two organizations both), but a tenant's model and records
                    // are its own: another tenant's node with the same key
                    // would stand in for this one's.
                    if row.envelope.tenant_id != ctx.subject_tenant_id() {
                        continue;
                    }
                    let Some((_, our_type)) = reverse.iter().find(|(g, _)| *g == row.type_id)
                    else {
                        continue;
                    };
                    let value = row.payload.unwrap_or_else(|| serde_json::json!({}));
                    if !super::in_scope(&value, scope) || !super::is_live(&value) {
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

        async fn upsert_nodes_keeping_vectors(
            &self,
            ctx: &SecurityContext,
            nodes: &[NodeUpsert],
        ) -> anyhow::Result<u64> {
            self.write_nodes(ctx, nodes, false).await
        }

        async fn upsert_nodes(
            &self,
            ctx: &SecurityContext,
            nodes: &[NodeUpsert],
        ) -> anyhow::Result<u64> {
            self.write_nodes(ctx, nodes, true).await
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
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
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
                // The relation is left unknown: the key says which one an
                // edge is, for whoever has the candidates to try.
                for e in res.edges {
                    if seen.insert(e.edge_key.clone()) {
                        out.push(EdgeView {
                            type_id: gts::our_type_from_graph(&e.edge_type_id),
                            from: e.src,
                            to: e.dst,
                            relation: None,
                            key: Some(e.edge_key),
                        });
                    }
                }
            }
            Ok(out)
        }

        async fn search(
            &self,
            ctx: &SecurityContext,
            text: &str,
            type_ids: &[String],
            limit: u32,
        ) -> anyhow::Result<Vec<ObjectNode>> {
            use graph_storage_sdk::models::{SearchMode, SearchRequest};
            let response = self
                .client
                .search(
                    ctx,
                    SearchRequest {
                        mode: SearchMode::Hybrid,
                        query: Some(text.to_owned()),
                        arm_limit: limit.max(50),
                        limit,
                        type_patterns: type_ids.iter().map(|t| gts::graph_type_id(t)).collect(),
                    },
                )
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage search: {e}"))?;
            let mut out = Vec::with_capacity(response.hits.len());
            for hit in response.hits {
                if let Some(node) = self.get_object(ctx, &hit.node_key).await? {
                    out.push(node);
                }
            }
            Ok(out)
        }

        /// One traversal per chunk of seeds, restricted to the edge type and
        /// the target node types, so the graph walks only the relation asked
        /// for and hands the payloads back with it.
        async fn neighbours(
            &self,
            ctx: &SecurityContext,
            seeds: &[String],
            hop: super::Hop<'_>,
        ) -> anyhow::Result<Neighbourhood> {
            let edge_type_id = hop.edge_type_id;
            let node_type_ids = hop.node_type_ids;
            let edge_pattern = gts::graph_type_id(edge_type_id);
            let node_patterns: Vec<String> = node_type_ids
                .iter()
                .map(|t| gts::graph_type_id(t))
                .collect();
            let mut out = Neighbourhood::default();
            let mut seen_edges: std::collections::HashSet<(String, String)> =
                std::collections::HashSet::new();
            let mut seen_nodes: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            for chunk in seeds.chunks(TRAVERSE_SEEDS) {
                let from: std::collections::HashSet<&str> =
                    chunk.iter().map(String::as_str).collect();
                let res = self
                    .client
                    .traverse(
                        ctx,
                        TraverseRequest {
                            seeds: chunk.to_vec(),
                            depth: 1,
                            edge_type_patterns: vec![edge_pattern.clone()],
                            node_type_patterns: node_patterns.clone(),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!("graph-storage traversal: {e}"))?;
                out.truncated |= res.truncated.is_some();
                // The walk follows an edge either way; the hop says which end
                // the seed has to be on, and which relation the edge has to be.
                let mut reached: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                for e in res.edges {
                    let type_id = gts::our_type_from_graph(&e.edge_type_id);
                    // Which relation the edge is, from its key: the wanted one,
                    // none (an edge written without a discriminator answers
                    // for every relation of its verb), or another one.
                    let relation = match hop.relation {
                        None => None,
                        Some(want) => {
                            match gts::relation_of_key(
                                &type_id,
                                &e.src,
                                &e.dst,
                                &e.edge_key,
                                [want],
                            ) {
                                Some("") => None,
                                Some(r) => Some(r.to_string()),
                                None => Some(String::new()),
                            }
                        }
                    };
                    let view = EdgeView {
                        type_id,
                        from: e.src,
                        to: e.dst,
                        relation,
                        key: Some(e.edge_key),
                    };
                    let Some(far) = hop.reaches(&view, &from) else {
                        continue;
                    };
                    let far = far.to_string();
                    let near = if hop.reverse {
                        view.to.clone()
                    } else {
                        view.from.clone()
                    };
                    reached.insert(far.clone());
                    if seen_edges.insert((near.clone(), far.clone())) {
                        out.edges.push(EdgeView {
                            type_id: edge_type_id.to_string(),
                            from: near,
                            to: far,
                            relation: view.relation,
                            key: view.key,
                        });
                    }
                }
                // Seeds survive the node-type filter, so a node is kept only
                // when an edge reached it and its type is one that was asked.
                for n in res.nodes {
                    if !reached.contains(&n.node_key)
                        || !node_type_ids.contains(&gts::our_type_from_graph(&n.type_id))
                        || !seen_nodes.insert(n.node_key.clone())
                    {
                        continue;
                    }
                    let value = n.payload.unwrap_or_else(|| serde_json::json!({}));
                    if !super::is_live(&value) {
                        continue;
                    }
                    out.nodes.push(ObjectNode {
                        type_id: gts::our_type_from_graph(&n.type_id),
                        instance_id: n.node_key,
                        value,
                    });
                }
            }
            Ok(out)
        }
    }
}

#[cfg(feature = "graph")]
pub use graph_backend::GraphStorageBackend;
