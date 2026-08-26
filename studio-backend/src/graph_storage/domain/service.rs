//! Domain services.
//!
//! Everything the gear can do, expressed once. The REST adapter and the
//! in-process client are both thin wrappers over this type, so the two surfaces
//! cannot drift in behaviour or in what they enforce.
//!
//! Scopes are derived from the caller's tenant. A PDP-issued scope replaces
//! that once the policy-enforcement layer lands; no call site changes, because
//! every repository already takes an `AccessScope`.

use std::sync::Arc;
use std::sync::Mutex;

use toolkit_db::{DBProvider, DbError};
use toolkit_security::{AccessScope, SecurityContext};

use crate::graph_storage::config::{GraphStorageConfig, HopStrategy};
use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::ingest_repo::{EdgeRow, NodeRow};
use crate::graph_storage::infra::storage::mutate::PruneFilter;
use crate::graph_storage::infra::storage::{
    counts, hybrid, ingest_repo, mutate, pgq, read_model, traversal, traversal_pgq, validate,
};
use crate::graph_storage::sdk::{
    DeleteResult, Direction, EdgeInput, EdgeView, GraphStats, HybridHit, HybridQuery, IngestResult,
    NodeInput, NodeView, Page, PruneRequest, SearchQuery, Subgraph, TraversalQuery, TypeView,
};

/// Composition of all domain services used by the gear.
pub struct GraphServices {
    config: GraphStorageConfig,
    db: Arc<DBProvider<DbError>>,
}

/// Translate a traversal direction into the storage layer's `outgoing` flag.
const fn outgoing_flag(direction: Direction) -> Option<bool> {
    match direction {
        Direction::Outgoing => Some(true),
        Direction::Incoming => Some(false),
        Direction::Both => None,
    }
}

impl GraphServices {
    /// Build the service composition from validated configuration.
    #[must_use]
    pub fn new(config: GraphStorageConfig, db: Arc<DBProvider<DbError>>) -> Self {
        Self { config, db }
    }

    /// Effective gear configuration.
    #[must_use]
    pub fn config(&self) -> &GraphStorageConfig {
        &self.config
    }

    fn scope_of(ctx: &SecurityContext) -> AccessScope {
        AccessScope::for_tenant(ctx.subject_tenant_id())
    }

    fn conn_err(e: impl std::fmt::Display) -> DomainError {
        DomainError::Storage(e.to_string())
    }

    /// Clamp a caller-supplied page size to the configured bounds.
    fn page_size(&self, requested: u32) -> u32 {
        if requested == 0 {
            self.config.default_page_size
        } else {
            requested.min(self.config.max_page_size)
        }
    }

    // ────────────────────────── counters ──────────────────────────

    /// Coarse counters for the caller's graph.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when the query fails.
    pub async fn stats(&self, ctx: &SecurityContext) -> Result<GraphStats, DomainError> {
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        counts::graph_stats(&conn, &scope).await
    }

    // ─────────────────────────── types ────────────────────────────

    /// Register a GTS type for the caller's tenant, returning its interned id.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when the write fails.
    pub async fn register_type(
        &self,
        ctx: &SecurityContext,
        type_id: &str,
        kind: &str,
        json_schema: Option<&serde_json::Value>,
    ) -> Result<i32, DomainError> {
        // A schema that cannot be compiled is rejected here rather than at the
        // first ingest, where it would read as the producer's fault.
        if let Some(schema) = json_schema
            && jsonschema::validator_for(schema).is_err()
        {
            return Err(DomainError::Storage(format!(
                "the schema supplied for {type_id} is not a usable JSON Schema"
            )));
        }

        let tenant = ctx.subject_tenant_id();
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        ingest_repo::upsert_type(&conn, &scope, tenant, type_id, kind, json_schema).await
    }

    /// Every type the caller may see.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when the query fails.
    pub async fn types(&self, ctx: &SecurityContext) -> Result<Vec<TypeView>, DomainError> {
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        read_model::types(&conn, &scope).await
    }

    // ─────────────────────────── ingest ───────────────────────────

    /// Upsert a batch of nodes and edges, atomically.
    ///
    /// # Why the transaction is here and not in the repository
    ///
    /// A batch is several statements — interning types, writing nodes,
    /// resolving endpoints, writing edges, bumping the revision — and the
    /// contract says the whole batch commits or none of it does. Only this
    /// layer holds the provider, so only this layer can open the transaction.
    ///
    /// The provider's transaction closure must fail with `DbError` to roll
    /// back, which would flatten a domain error into a string and lose the
    /// difference between "your payload is malformed" (400) and "the database
    /// broke" (500). So the domain error travels out of the closure in its own
    /// channel and the returned `DbError` is only the rollback trigger.
    ///
    /// # Errors
    /// Returns [`DomainError::UnknownType`], [`DomainError::UnknownEndpoint`],
    /// [`DomainError::BatchTooLarge`], a payload error, or
    /// [`DomainError::Storage`].
    pub async fn ingest(
        &self,
        ctx: &SecurityContext,
        nodes: &[NodeInput],
        edges: &[EdgeInput],
    ) -> Result<IngestResult, DomainError> {
        if nodes.len() > self.config.ingest_max_nodes as usize {
            return Err(DomainError::BatchTooLarge {
                kind: "nodes",
                limit: self.config.ingest_max_nodes,
                requested: nodes.len(),
            });
        }
        if edges.len() > self.config.ingest_max_edges as usize {
            return Err(DomainError::BatchTooLarge {
                kind: "edges",
                limit: self.config.ingest_max_edges,
                requested: edges.len(),
            });
        }

        // Shape, ceiling and embedding checks need no database and are done
        // before a transaction is opened, so a malformed batch costs nothing.
        let ceiling = self.config.ingest_max_payload_bytes;
        let dims = self.config.embedding_dimensions;
        for n in nodes {
            if let Some(p) = &n.payload {
                validate::check_shape_and_size(&n.node_key, p, ceiling)?;
            }
            if let Some(e) = &n.embedding {
                validate::check_embedding(&n.node_key, e, dims)?;
            }
        }
        for e in edges {
            if let Some(p) = &e.payload {
                validate::check_shape_and_size(&edge_key(e), p, ceiling)?;
            }
        }

        let tenant = ctx.subject_tenant_id();
        let scope = Self::scope_of(ctx);

        // The provider's closure is `for<'a>`, so anything it captures has to
        // outlive every possible `'a` — references to locals do not. Everything
        // the body needs is therefore owned by the future, and the error
        // channel is an `Arc` rather than a borrow.
        let stash: Arc<Mutex<Option<DomainError>>> = Arc::new(Mutex::new(None));
        let stash_tx = Arc::clone(&stash);
        let scope_tx = scope.clone();
        let nodes_tx = nodes.to_vec();
        let edges_tx = edges.to_vec();

        let committed = self
            .db
            .transaction(move |tx| {
                Box::pin(async move {
                    match Self::ingest_in_tx(tx, &scope_tx, tenant, &nodes_tx, &edges_tx).await {
                        Ok(v) => Ok(v),
                        Err(e) => {
                            *stash_tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
                            Err(DbError::Other(anyhow::anyhow!(
                                "ingest rolled back; the reason travels outside this error"
                            )))
                        }
                    }
                })
            })
            .await;

        match committed {
            Ok(result) => Ok(result),
            Err(db_err) => {
                Err(take_stashed(&stash)
                    .unwrap_or_else(|| DomainError::Storage(db_err.to_string())))
            }
        }
    }

    /// The body of [`Self::ingest`], running inside the transaction.
    async fn ingest_in_tx<C: toolkit_db::secure::DBRunner>(
        conn: &C,
        scope: &AccessScope,
        tenant: uuid::Uuid,
        nodes: &[NodeInput],
        edges: &[EdgeInput],
    ) -> Result<IngestResult, DomainError> {
        // Resolve every referenced type before writing anything.
        let mut type_ids = std::collections::HashMap::new();
        for t in nodes
            .iter()
            .map(|n| n.type_id.as_str())
            .chain(edges.iter().map(|e| e.type_id.as_str()))
        {
            if !type_ids.contains_key(t) {
                let id = ingest_repo::interned_type_id(conn, scope, t).await?;
                type_ids.insert(t.to_owned(), id);
            }
        }

        // Validate payloads against the schema their type declares. Cached per
        // type: a batch of ten thousand files hits one schema, and compiling it
        // per row would dominate the ingest.
        let mut schemas: std::collections::HashMap<i32, Option<serde_json::Value>> =
            std::collections::HashMap::new();
        for n in nodes {
            let Some(payload) = &n.payload else { continue };
            let interned = type_ids[&n.type_id];
            let schema = match schemas.entry(interned) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(read_model::schema_for_type(conn, scope, interned).await?)
                }
            };
            if let Some(schema) = schema.as_ref() {
                validate::check_against_schema(&n.node_key, payload, schema)?;
            }
        }

        let node_rows: Vec<NodeRow> = nodes
            .iter()
            .map(|n| NodeRow {
                node_key: n.node_key.clone(),
                type_id: type_ids[&n.type_id],
                name: n.name.clone(),
                search_text: n.search_text.clone().unwrap_or_else(|| n.name.clone()),
                payload: n.payload.clone(),
                embedding: n.embedding.clone(),
            })
            .collect();
        let nodes_upserted = ingest_repo::upsert_nodes(conn, scope, tenant, node_rows).await?;

        // Endpoints may arrive in this batch or already exist, which is why
        // this read happens after the node write and inside the same
        // transaction.
        let mut endpoint_keys: Vec<String> = edges
            .iter()
            .flat_map(|e| [e.from.clone(), e.to.clone()])
            .collect();
        endpoint_keys.sort();
        endpoint_keys.dedup();
        let ids = ingest_repo::resolve_node_ids(conn, scope, &endpoint_keys).await?;

        let mut edge_rows = Vec::with_capacity(edges.len());
        for e in edges {
            let src = *ids
                .get(&e.from)
                .ok_or_else(|| DomainError::UnknownEndpoint(e.from.clone()))?;
            let dst = *ids
                .get(&e.to)
                .ok_or_else(|| DomainError::UnknownEndpoint(e.to.clone()))?;
            edge_rows.push(EdgeRow {
                edge_key: edge_key(e),
                type_id: type_ids[&e.type_id],
                src,
                dst,
                payload: e.payload.clone(),
            });
        }
        let edges_upserted = ingest_repo::upsert_edges(conn, scope, tenant, edge_rows).await?;

        let graph_revision = if nodes_upserted == 0 && edges_upserted == 0 {
            mutate::current_revision(conn, scope).await?
        } else {
            ingest_repo::bump_revision(conn, scope, tenant).await?
        };

        Ok(IngestResult {
            nodes_upserted,
            edges_upserted,
            graph_revision,
        })
    }

    // ─────────────────────────── delete ───────────────────────────

    /// Remove one node and its incident edges.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when a delete fails.
    pub async fn delete_node(
        &self,
        ctx: &SecurityContext,
        node_key: &str,
    ) -> Result<DeleteResult, DomainError> {
        let key = node_key.to_owned();
        self.delete_in_tx(ctx, move |conn, scope, tenant| {
            Box::pin(async move {
                let ids = mutate::node_ids_for_keys(conn, &scope, &[key]).await?;
                let removed = mutate::delete_nodes(conn, &scope, &ids).await?;
                finish_delete(conn, &scope, tenant, removed).await
            })
        })
        .await
    }

    /// Remove one edge.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when the delete fails.
    pub async fn delete_edge(
        &self,
        ctx: &SecurityContext,
        edge_id: i64,
    ) -> Result<DeleteResult, DomainError> {
        self.delete_in_tx(ctx, move |conn, scope, tenant| {
            Box::pin(async move {
                let edges = mutate::delete_edge(conn, &scope, edge_id).await?;
                finish_delete(conn, &scope, tenant, mutate::Removed { nodes: 0, edges }).await
            })
        })
        .await
    }

    /// Remove every node matching `request`, with their incident edges.
    ///
    /// # Errors
    /// Returns [`DomainError::PruneUnfiltered`] for a request with no filter,
    /// or [`DomainError::Storage`] when a delete fails.
    pub async fn prune(
        &self,
        ctx: &SecurityContext,
        request: &PruneRequest,
    ) -> Result<DeleteResult, DomainError> {
        if request.type_id.is_none()
            && request.node_key_prefix.is_none()
            && request.not_seen_since.is_none()
        {
            return Err(DomainError::PruneUnfiltered);
        }

        let request = request.clone();
        let budget = u64::from(self.config.ingest_max_nodes);
        self.delete_in_tx(ctx, move |conn, scope, tenant| {
            Box::pin(async move {
                let type_id = match &request.type_id {
                    Some(t) => Some(ingest_repo::interned_type_id(conn, &scope, t).await?),
                    None => None,
                };
                let filter = PruneFilter {
                    type_id,
                    node_key_prefix: request.node_key_prefix,
                    not_seen_since: request.not_seen_since,
                };
                let ids = mutate::prune_candidates(conn, &scope, &filter, budget).await?;
                let removed = mutate::delete_nodes(conn, &scope, &ids).await?;
                finish_delete(conn, &scope, tenant, removed).await
            })
        })
        .await
    }

    /// Run a deletion body in a transaction, carrying the domain error out.
    ///
    /// Same channel as [`Self::ingest`], for the same reason: detaching edges
    /// and removing nodes must commit together or a node keeps half its edges.
    async fn delete_in_tx<F>(
        &self,
        ctx: &SecurityContext,
        body: F,
    ) -> Result<DeleteResult, DomainError>
    where
        F: for<'a> FnOnce(
                &'a toolkit_db::secure::DbTx<'a>,
                AccessScope,
                uuid::Uuid,
            ) -> std::pin::Pin<
                Box<dyn Future<Output = Result<DeleteResult, DomainError>> + Send + 'a>,
            > + Send
            + 'static,
    {
        let tenant = ctx.subject_tenant_id();
        let scope = Self::scope_of(ctx);
        let stash: Arc<Mutex<Option<DomainError>>> = Arc::new(Mutex::new(None));
        let stash_tx = Arc::clone(&stash);

        let committed = self
            .db
            .transaction(move |tx| {
                Box::pin(async move {
                    match body(tx, scope, tenant).await {
                        Ok(v) => Ok(v),
                        Err(e) => {
                            *stash_tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
                            Err(DbError::Other(anyhow::anyhow!(
                                "deletion rolled back; the reason travels outside this error"
                            )))
                        }
                    }
                })
            })
            .await;

        match committed {
            Ok(result) => Ok(result),
            Err(db_err) => {
                Err(take_stashed(&stash)
                    .unwrap_or_else(|| DomainError::Storage(db_err.to_string())))
            }
        }
    }

    // ──────────────────────────── read ────────────────────────────

    /// One node by its producer-supplied key.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when the query fails.
    pub async fn node_by_key(
        &self,
        ctx: &SecurityContext,
        node_key: &str,
        include_payload: bool,
    ) -> Result<Option<NodeView>, DomainError> {
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        read_model::node_by_key(&conn, &scope, node_key, include_payload).await
    }

    /// One node by its surrogate id.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when the query fails.
    pub async fn node_by_id(
        &self,
        ctx: &SecurityContext,
        id: i64,
        include_payload: bool,
    ) -> Result<Option<NodeView>, DomainError> {
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        read_model::node_by_id(&conn, &scope, id, include_payload).await
    }

    /// A page of nodes, optionally of one type.
    ///
    /// # Errors
    /// Returns [`DomainError::BadCursor`] for a cursor this gear did not issue,
    /// or [`DomainError::Storage`] when the query fails.
    pub async fn list_nodes(
        &self,
        ctx: &SecurityContext,
        type_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
        include_payload: bool,
    ) -> Result<Page<NodeView>, DomainError> {
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;

        let interned = match type_id {
            Some(t) => Some(ingest_repo::interned_type_id(&conn, &scope, t).await?),
            None => None,
        };
        let after = cursor.map(read_model::decode_cursor).transpose()?;

        let (items, next_cursor) = read_model::list_nodes(
            &conn,
            &scope,
            interned,
            after,
            self.page_size(limit),
            include_payload,
        )
        .await?;
        Ok(Page { items, next_cursor })
    }

    /// A page of edges incident to one node.
    ///
    /// # Errors
    /// Returns [`DomainError::BadCursor`] or [`DomainError::Storage`].
    pub async fn list_edges(
        &self,
        ctx: &SecurityContext,
        node_id: i64,
        direction: Direction,
        cursor: Option<&str>,
        limit: u32,
        include_payload: bool,
    ) -> Result<Page<EdgeView>, DomainError> {
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        let after = cursor.map(read_model::decode_cursor).transpose()?;

        let (items, next_cursor) = read_model::list_edges(
            &conn,
            &scope,
            node_id,
            outgoing_flag(direction),
            after,
            self.page_size(limit),
            include_payload,
        )
        .await?;
        Ok(Page { items, next_cursor })
    }

    // ────────────────────── traverse and search ───────────────────

    /// Expand a breadth-first neighbourhood around the query's seeds.
    ///
    /// Depth is clamped to the configured maximum and the result to the node
    /// budget, so an unbounded request is rejected by construction rather than
    /// attempted. Only nodes the caller may see enter the frontier, so the walk
    /// stays inside the caller-authorised subgraph.
    ///
    /// # Errors
    /// Returns [`DomainError::UnknownType`] for an unregistered edge type, or
    /// [`DomainError::Storage`] when a hop query fails.
    pub async fn neighbours(
        &self,
        ctx: &SecurityContext,
        query: &TraversalQuery<'_>,
    ) -> Result<Vec<i64>, DomainError> {
        let depth = query.depth.min(self.config.traversal_max_depth);
        let budget = self.config.traversal_max_nodes as usize;
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;

        let mut edge_type_ids = Vec::with_capacity(query.edge_types.len());
        for t in query.edge_types {
            edge_type_ids.push(ingest_repo::interned_type_id(&conn, &scope, t).await?);
        }
        let edge_types = if edge_type_ids.is_empty() {
            None
        } else {
            Some(edge_type_ids.as_slice())
        };
        let outgoing = outgoing_flag(query.direction);

        // Resolved once for the whole walk rather than per hop: the scope does
        // not change between hops, and a per-hop decision would log the same
        // fallback once per level.
        let hop = Self::effective_hop(self.config.traversal_hop, &scope);

        let mut visited: Vec<i64> = query.seeds.to_vec();
        visited.sort_unstable();
        visited.dedup();
        let mut frontier = visited.clone();

        for _ in 0..depth {
            if frontier.is_empty() || visited.len() >= budget {
                break;
            }
            let neighbours = match hop {
                HopStrategy::TwoQuery => {
                    traversal::expand_frontier(&conn, &scope, &frontier, edge_types, outgoing)
                        .await?
                }
                HopStrategy::Cte => {
                    traversal::expand_frontier_cte(&conn, &scope, &frontier, edge_types, outgoing)
                        .await?
                }
                HopStrategy::Pgq => {
                    traversal_pgq::expand_frontier_pgq(
                        &conn, &scope, &frontier, edge_types, outgoing,
                    )
                    .await?
                }
            };
            frontier = neighbours
                .into_iter()
                .filter(|id| !visited.contains(id))
                .collect();
            visited.extend(frontier.iter().copied());
            visited.sort_unstable();
            visited.dedup();
        }

        visited.truncate(budget);
        Ok(visited)
    }

    /// The drawable neighbourhood: nodes and the edges between them.
    ///
    /// The node set is exactly what [`Self::neighbours`] returns, so the picture
    /// and the identifiers agree by construction and the traversal backend
    /// under test is the one being drawn.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when a query fails.
    pub async fn subgraph(
        &self,
        ctx: &SecurityContext,
        query: &TraversalQuery<'_>,
    ) -> Result<Subgraph, DomainError> {
        let ids = self.neighbours(ctx, query).await?;
        let truncated = ids.len() >= self.config.traversal_max_nodes as usize;

        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;

        let nodes = read_model::nodes(&conn, &scope, &ids, query.include_payload).await?;
        let edges = read_model::edges_within(&conn, &scope, &ids, query.include_payload).await?;
        Ok(Subgraph {
            nodes,
            edges,
            truncated,
        })
    }

    /// Rank the caller's nodes against a free-text query.
    ///
    /// Lexical only; [`Self::hybrid`] is the arm that also uses embeddings.
    ///
    /// # Errors
    /// Returns [`DomainError::Storage`] when the query fails.
    pub async fn search(
        &self,
        ctx: &SecurityContext,
        query: &SearchQuery<'_>,
    ) -> Result<Vec<NodeView>, DomainError> {
        let limit = query.limit.min(self.config.traversal_max_nodes);
        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        read_model::search(&conn, &scope, query.text, limit, query.include_payload).await
    }

    /// Vector similarity, graph expansion and full-text filtering in one
    /// statement.
    ///
    /// # Errors
    /// Returns [`DomainError::EmbeddingDimensionMismatch`] for a query vector
    /// of the wrong length, or [`DomainError::Storage`] when the query fails or
    /// the caller's scope cannot bound a graph pattern.
    pub async fn hybrid(
        &self,
        ctx: &SecurityContext,
        query: &HybridQuery<'_>,
    ) -> Result<Vec<HybridHit>, DomainError> {
        validate::check_embedding(
            "query",
            query.query_vector,
            self.config.embedding_dimensions,
        )?;

        let scope = Self::scope_of(ctx);
        let conn = self.db.conn().map_err(Self::conn_err)?;
        let request = hybrid::HybridRequest {
            query_vector: query.query_vector,
            text: query.text,
            seed_limit: query.seed_limit.min(self.config.traversal_max_nodes),
            limit: query.limit.min(self.config.traversal_max_nodes),
        };
        let hits = hybrid::hybrid_neighbourhood(&conn, &scope, &request).await?;
        Ok(hits
            .into_iter()
            .map(|h| HybridHit {
                id: h.id,
                distance: h.distance,
            })
            .collect())
    }
}

/// Take the domain error a rolled-back transaction left behind.
fn take_stashed(stash: &Arc<Mutex<Option<DomainError>>>) -> Option<DomainError> {
    stash.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// The derived, tenant-scoped natural key of an edge.
///
/// Type and endpoints, in that order: an edge's identity is what it connects
/// and how, so re-ingesting the same relation converges on one row.
fn edge_key(e: &EdgeInput) -> String {
    format!("{}|{}|{}", e.type_id, e.from, e.to)
}

/// Bump the revision if anything went away, and report what did.
async fn finish_delete<C: toolkit_db::secure::DBRunner>(
    conn: &C,
    scope: &AccessScope,
    tenant: uuid::Uuid,
    removed: mutate::Removed,
) -> Result<DeleteResult, DomainError> {
    let graph_revision = if removed.nodes == 0 && removed.edges == 0 {
        mutate::current_revision(conn, scope).await?
    } else {
        ingest_repo::bump_revision(conn, scope, tenant).await?
    };
    Ok(DeleteResult {
        nodes_deleted: removed.nodes,
        edges_deleted: removed.edges,
        graph_revision,
    })
}

impl GraphServices {
    /// Which hop implementation actually serves a request under `scope`.
    ///
    /// The `GRAPH_TABLE` backend needs the caller's scope reduced to a set of
    /// tenants, because a pattern with no tenant bound reads whichever tenant
    /// owns the ids it is given. Not every scope reduces that way — `allow_all`
    /// and tenant-subtree scopes do not — and those requests are served by the
    /// two-query hop instead of being refused.
    ///
    /// Falling back rather than refusing is the port's existing contract, not a
    /// concession: ADR-0001 already has the port choosing a backend per request
    /// shape, and the stand suite pins that both backends return the same ids
    /// for the same seeds and scope. What the fallback must not do is happen
    /// quietly — a deployment configured for `pgq` and silently served by
    /// `two_query` would make any measurement taken from it meaningless — so it
    /// is logged with the reason.
    fn effective_hop(configured: HopStrategy, scope: &AccessScope) -> HopStrategy {
        if configured == HopStrategy::Cte && !traversal::is_tenant_only(scope) {
            tracing::warn!(
                "scope carries filters a CTE body cannot express; serving this request with the two-query hop"
            );
            return HopStrategy::TwoQuery;
        }
        if configured != HopStrategy::Pgq {
            return configured;
        }
        match pgq::tenant_bound(scope) {
            Ok(_) => HopStrategy::Pgq,
            Err(reason) => {
                tracing::warn!(
                    %reason,
                    "scope cannot bound a graph pattern; serving this request with the two-query hop"
                );
                HopStrategy::TwoQuery
            }
        }
    }
}

#[cfg(test)]
mod hop_selection_tests {
    use super::*;
    use uuid::Uuid;

    /// A scope the pattern can bound is served by the configured backend.
    #[test]
    fn a_tenant_scope_keeps_the_pgq_hop() {
        let scope = AccessScope::for_tenant(Uuid::from_u128(1));
        assert_eq!(
            GraphServices::effective_hop(HopStrategy::Pgq, &scope),
            HopStrategy::Pgq
        );
    }

    /// A scope with no tenant bound falls back rather than failing the request.
    #[test]
    fn an_unbounded_scope_falls_back_to_the_two_query_hop() {
        assert_eq!(
            GraphServices::effective_hop(HopStrategy::Pgq, &AccessScope::allow_all()),
            HopStrategy::TwoQuery
        );
    }

    /// The fallback is specific to the pattern backend. The two-query hop
    /// expresses any scope the secure ORM can, so nothing about it is
    /// conditional.
    #[test]
    fn the_two_query_backend_is_never_substituted() {
        for scope in [
            AccessScope::allow_all(),
            AccessScope::deny_all(),
            AccessScope::for_tenant(Uuid::from_u128(1)),
        ] {
            assert_eq!(
                GraphServices::effective_hop(HopStrategy::TwoQuery, &scope),
                HopStrategy::TwoQuery
            );
        }
    }

    /// `deny_all` bounds a pattern to nothing, which is a bound — the hop is
    /// kept and answers with an empty set, rather than falling back to prove
    /// the same thing more slowly.
    #[test]
    fn deny_all_keeps_the_pattern_backend() {
        assert_eq!(
            GraphServices::effective_hop(HopStrategy::Pgq, &AccessScope::deny_all()),
            HopStrategy::Pgq
        );
    }

    /// A directed walk maps onto the storage layer's flag, and "both" must be
    /// the absence of a constraint rather than a third query shape.
    #[test]
    fn direction_maps_to_the_storage_flag() {
        assert_eq!(outgoing_flag(Direction::Outgoing), Some(true));
        assert_eq!(outgoing_flag(Direction::Incoming), Some(false));
        assert_eq!(outgoing_flag(Direction::Both), None);
    }
}
