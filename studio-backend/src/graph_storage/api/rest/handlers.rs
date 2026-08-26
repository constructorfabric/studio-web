//! REST handlers. Thin: they parse query shapes, delegate to domain services
//! and map results. Every decision that matters lives in the service, so the
//! in-process client behaves identically.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Json};
use serde::Deserialize;
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;

use crate::graph_storage::api::rest::dto::{
    EdgeInputDto, GraphDeleteResultDto, GraphEdgeDto, GraphEdgePageDto, GraphHybridHitDto,
    GraphHybridReq, GraphHybridResultDto, GraphNodeDto, GraphNodePageDto, GraphPruneReq,
    GraphStatsDto, GraphTypeDto, GraphTypeListDto, IngestReq, IngestResultDto, NeighboursDto,
    NodeInputDto, RegisterTypeReq, RegisteredTypeDto, SearchResultDto, SubgraphDto,
};
use crate::graph_storage::api::rest::error::GraphResourceError;
use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::domain::service::GraphServices;
use crate::graph_storage::sdk::{
    Direction, EdgeInput, HybridQuery, NodeInput, PruneRequest, SearchQuery, TraversalQuery,
};

/// Handler result alias.
pub type ApiResult<T> = Result<T, CanonicalError>;

// ─────────────────────────── shared parsing ───────────────────────────

/// Parse a comma-separated id list, ignoring anything that is not a number.
fn parse_ids(raw: &str) -> Vec<i64> {
    raw.split(',')
        .filter_map(|s| s.trim().parse::<i64>().ok())
        .collect()
}

/// Parse a comma-separated GTS type list.
fn parse_types(raw: Option<&str>) -> Vec<String> {
    raw.map(|s| {
        s.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

/// Parse the `direction` query parameter.
///
/// An unrecognised value is refused rather than silently treated as `both`: a
/// typo that widens a traversal is the kind of bug that looks like data.
fn parse_direction(raw: Option<&str>) -> Result<Direction, CanonicalError> {
    match raw.map(str::trim) {
        None | Some("") | Some("both") => Ok(Direction::Both),
        Some("out") => Ok(Direction::Outgoing),
        Some("in") => Ok(Direction::Incoming),
        Some(other) => Err(GraphResourceError::invalid_argument()
            .with_field_violation(
                "direction",
                format!("'{other}' is not a direction; use out, in or both"),
                "DIRECTION_INVALID",
            )
            .create()),
    }
}

// ─────────────────────────────── stats ────────────────────────────────

/// Return coarse counters for the caller's graph.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn get_stats(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
) -> ApiResult<Json<GraphStatsDto>> {
    let stats = services.stats(&ctx).await?;
    Ok(Json(GraphStatsDto::from(stats)))
}

// ─────────────────────────────── types ────────────────────────────────

/// Register a GTS type for the caller's tenant.
#[tracing::instrument(skip(services, ctx, body), fields(user.id = %ctx.subject_id()))]
pub async fn register_type(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Json(body): Json<RegisterTypeReq>,
) -> ApiResult<Json<RegisteredTypeDto>> {
    let id = services
        .register_type(&ctx, &body.type_id, &body.kind, body.json_schema.as_ref())
        .await?;
    Ok(Json(RegisteredTypeDto { id }))
}

/// List every type the caller may see.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn list_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
) -> ApiResult<Json<GraphTypeListDto>> {
    let items = services.types(&ctx).await?;
    Ok(Json(GraphTypeListDto {
        items: items.into_iter().map(GraphTypeDto::from).collect(),
    }))
}

// ─────────────────────────────── ingest ───────────────────────────────

/// Upsert a batch of nodes and edges.
#[tracing::instrument(
    skip(services, ctx, body),
    fields(user.id = %ctx.subject_id(), nodes = body.nodes.len(), edges = body.edges.len())
)]
pub async fn ingest(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Json(body): Json<IngestReq>,
) -> ApiResult<Json<IngestResultDto>> {
    let nodes: Vec<NodeInput> = body.nodes.into_iter().map(node_input).collect();
    let edges: Vec<EdgeInput> = body.edges.into_iter().map(edge_input).collect();

    let result = services.ingest(&ctx, &nodes, &edges).await?;
    Ok(Json(IngestResultDto::from(result)))
}

fn node_input(n: NodeInputDto) -> NodeInput {
    NodeInput {
        node_key: n.node_key,
        type_id: n.type_id,
        name: n.name,
        search_text: n.search_text,
        payload: n.payload,
        embedding: n.embedding,
    }
}

fn edge_input(e: EdgeInputDto) -> EdgeInput {
    EdgeInput {
        type_id: e.type_id,
        from: e.from,
        to: e.to,
        payload: e.payload,
    }
}

// ─────────────────────────────── delete ───────────────────────────────

/// Query parameters that address a node by its producer-supplied key.
#[derive(Debug, Deserialize)]
pub struct NodeKeyParams {
    /// The node key. A query parameter rather than a path segment because keys
    /// carry slashes and colons — `file:owner/repo:src/main.rs` is a normal one.
    pub key: String,
}

/// Remove one node and its incident edges.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn delete_node(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Query(params): Query<NodeKeyParams>,
) -> ApiResult<Json<GraphDeleteResultDto>> {
    let result = services.delete_node(&ctx, &params.key).await?;
    Ok(Json(GraphDeleteResultDto::from(result)))
}

/// Remove one edge.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn delete_edge(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Path(id): Path<i64>,
) -> ApiResult<Json<GraphDeleteResultDto>> {
    let result = services.delete_edge(&ctx, id).await?;
    Ok(Json(GraphDeleteResultDto::from(result)))
}

/// Remove every node matching the request.
#[tracing::instrument(skip(services, ctx, body), fields(user.id = %ctx.subject_id()))]
pub async fn prune(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Json(body): Json<GraphPruneReq>,
) -> ApiResult<Json<GraphDeleteResultDto>> {
    let not_seen_since = match body.not_seen_since.as_deref() {
        None => None,
        Some(raw) => Some(
            time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
                .map_err(|_| {
                    GraphResourceError::invalid_argument()
                        .with_field_violation(
                            "not_seen_since",
                            "expected an RFC 3339 instant, e.g. 2026-08-20T10:00:00Z",
                            "TIMESTAMP_INVALID",
                        )
                        .create()
                })?,
        ),
    };

    let result = services
        .prune(
            &ctx,
            &PruneRequest {
                type_id: body.type_id,
                node_key_prefix: body.node_key_prefix,
                not_seen_since,
            },
        )
        .await?;
    Ok(Json(GraphDeleteResultDto::from(result)))
}

// ──────────────────────────────── read ────────────────────────────────

/// Query parameters of the node listing.
#[derive(Debug, Deserialize)]
pub struct ListNodesParams {
    /// Return only nodes of this GTS type.
    #[serde(default)]
    pub type_id: Option<String>,
    /// Return the single node carrying this key, if the caller may see it.
    #[serde(default)]
    pub key: Option<String>,
    /// Cursor from a previous page.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Page size; zero or absent means the configured default.
    #[serde(default)]
    pub limit: u32,
    /// Whether to include attributes.
    #[serde(default)]
    pub include_payload: bool,
}

/// List nodes, or fetch the one carrying a given key.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn list_nodes(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Query(params): Query<ListNodesParams>,
) -> ApiResult<Json<GraphNodePageDto>> {
    // A key lookup answers in the same shape as a listing, so a client that
    // renders pages does not need a second code path for one node.
    if let Some(key) = params.key {
        let found = services
            .node_by_key(&ctx, &key, params.include_payload)
            .await?;
        return Ok(Json(GraphNodePageDto {
            items: found.into_iter().map(GraphNodeDto::from).collect(),
            next_cursor: None,
        }));
    }

    let page = services
        .list_nodes(
            &ctx,
            params.type_id.as_deref(),
            params.cursor.as_deref(),
            params.limit,
            params.include_payload,
        )
        .await?;
    Ok(Json(GraphNodePageDto {
        items: page.items.into_iter().map(GraphNodeDto::from).collect(),
        next_cursor: page.next_cursor,
    }))
}

/// Query parameters that only choose whether attributes come along.
#[derive(Debug, Deserialize)]
pub struct PayloadParams {
    /// Whether to include attributes.
    #[serde(default)]
    pub include_payload: bool,
}

/// Fetch one node by its surrogate id.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn get_node(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Path(id): Path<i64>,
    Query(params): Query<PayloadParams>,
) -> ApiResult<Json<GraphNodeDto>> {
    let found = services
        .node_by_id(&ctx, id, params.include_payload)
        .await?
        .ok_or_else(|| CanonicalError::from(DomainError::NodeNotFound(id.to_string())))?;
    Ok(Json(GraphNodeDto::from(found)))
}

/// Query parameters of the edge listing.
#[derive(Debug, Deserialize)]
pub struct ListEdgesParams {
    /// `out`, `in` or `both` (default).
    #[serde(default)]
    pub direction: Option<String>,
    /// Cursor from a previous page.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Page size; zero or absent means the configured default.
    #[serde(default)]
    pub limit: u32,
    /// Whether to include attributes.
    #[serde(default)]
    pub include_payload: bool,
}

/// List the edges incident to one node.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn list_edges(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Path(id): Path<i64>,
    Query(params): Query<ListEdgesParams>,
) -> ApiResult<Json<GraphEdgePageDto>> {
    let direction = parse_direction(params.direction.as_deref())?;
    let page = services
        .list_edges(
            &ctx,
            id,
            direction,
            params.cursor.as_deref(),
            params.limit,
            params.include_payload,
        )
        .await?;
    Ok(Json(GraphEdgePageDto {
        items: page.items.into_iter().map(GraphEdgeDto::from).collect(),
        next_cursor: page.next_cursor,
    }))
}

// ───────────────────────── traverse and search ────────────────────────

/// Query parameters of the traversal endpoints.
#[derive(Debug, Deserialize)]
pub struct TraversalParams {
    /// Comma-separated seed node ids.
    pub seeds: String,
    /// Requested depth; clamped to the configured maximum.
    #[serde(default = "default_depth")]
    pub depth: u8,
    /// `out`, `in` or `both` (default).
    #[serde(default)]
    pub direction: Option<String>,
    /// Comma-separated GTS edge types the walk may follow. Absent means any.
    #[serde(default)]
    pub edge_types: Option<String>,
    /// Whether to include attributes.
    #[serde(default)]
    pub include_payload: bool,
}

const fn default_depth() -> u8 {
    2
}

/// Expand a bounded neighbourhood around the given seeds.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn get_neighbours(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Query(params): Query<TraversalParams>,
) -> ApiResult<Json<NeighboursDto>> {
    let seeds = parse_ids(&params.seeds);
    let edge_types = parse_types(params.edge_types.as_deref());
    let direction = parse_direction(params.direction.as_deref())?;

    let budget = services.config().traversal_max_nodes as usize;
    let nodes = services
        .neighbours(
            &ctx,
            &TraversalQuery {
                seeds: &seeds,
                depth: params.depth,
                direction,
                edge_types: &edge_types,
                include_payload: false,
            },
        )
        .await?;
    let truncated = nodes.len() >= budget;

    Ok(Json(NeighboursDto { nodes, truncated }))
}

/// Return the drawable neighbourhood around the given seeds.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn get_subgraph(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Query(params): Query<TraversalParams>,
) -> ApiResult<Json<SubgraphDto>> {
    let seeds = parse_ids(&params.seeds);
    let edge_types = parse_types(params.edge_types.as_deref());
    let direction = parse_direction(params.direction.as_deref())?;

    let result = services
        .subgraph(
            &ctx,
            &TraversalQuery {
                seeds: &seeds,
                depth: params.depth,
                direction,
                edge_types: &edge_types,
                include_payload: params.include_payload,
            },
        )
        .await?;

    Ok(Json(SubgraphDto {
        nodes: result.nodes.into_iter().map(GraphNodeDto::from).collect(),
        edges: result.edges.into_iter().map(GraphEdgeDto::from).collect(),
        truncated: result.truncated,
    }))
}

/// Query parameters of the search endpoint.
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    /// Free text to match against the nodes' composed search text.
    pub q: String,
    /// Maximum number of matches; clamped to the configured node budget.
    #[serde(default = "default_search_limit")]
    pub limit: u32,
    /// Whether to include attributes.
    #[serde(default)]
    pub include_payload: bool,
}

const fn default_search_limit() -> u32 {
    20
}

/// Rank the caller's nodes against a free-text query.
#[tracing::instrument(skip(services, ctx), fields(user.id = %ctx.subject_id()))]
pub async fn search(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Query(params): Query<SearchParams>,
) -> ApiResult<Json<SearchResultDto>> {
    let nodes = services
        .search(
            &ctx,
            &SearchQuery {
                text: &params.q,
                limit: params.limit,
                include_payload: params.include_payload,
            },
        )
        .await?;
    Ok(Json(SearchResultDto {
        nodes: nodes.into_iter().map(GraphNodeDto::from).collect(),
    }))
}

/// Vector similarity, graph expansion and full-text filtering in one statement.
#[tracing::instrument(
    skip(services, ctx, body),
    fields(user.id = %ctx.subject_id(), dimensions = body.query_vector.len())
)]
pub async fn hybrid(
    Extension(ctx): Extension<SecurityContext>,
    Extension(services): Extension<Arc<GraphServices>>,
    Json(body): Json<GraphHybridReq>,
) -> ApiResult<Json<GraphHybridResultDto>> {
    let hits = services
        .hybrid(
            &ctx,
            &HybridQuery {
                query_vector: &body.query_vector,
                text: &body.text,
                seed_limit: body.seed_limit,
                limit: body.limit,
            },
        )
        .await?;
    Ok(Json(GraphHybridResultDto {
        nodes: hits.into_iter().map(GraphHybridHitDto::from).collect(),
    }))
}
