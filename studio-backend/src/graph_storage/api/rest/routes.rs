//! Route registration: one chain per endpoint describes the route, its
//! `OpenAPI` schema, authentication and every Problem status it can return.

use std::sync::Arc;

use axum::{Extension, Router};
use toolkit::api::OpenApiRegistry;
use toolkit::api::operation_builder::{
    CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature, OperationBuilder,
};

use crate::graph_storage::api::rest::{dto, handlers};
use crate::graph_storage::domain::service::GraphServices;

const API_TAG: &str = "Graph Storage";
const BASE: &str = "/graph-storage/v1";

pub(crate) struct License;

impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}

impl LicenseFeature for License {}

/// Register every REST route of the gear.
#[allow(clippy::too_many_lines)]
pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    services: Arc<GraphServices>,
) -> Router {
    // ── counters ──
    let router = OperationBuilder::get(format!("{BASE}/stats"))
        .operation_id("graph_storage.get_stats")
        .summary("Graph counters")
        .description(
            "Node and edge counts, plus the monotonic revision. Poll the \
             revision to learn that the graph changed — the upsert counts are \
             not a change feed.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .handler(handlers::get_stats)
        .json_response_with_schema::<dto::GraphStatsDto>(
            openapi,
            http::StatusCode::OK,
            "Graph counters",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── types ──
    let router = OperationBuilder::get(format!("{BASE}/types"))
        .operation_id("graph_storage.list_types")
        .summary("List registered types")
        .description("Every GTS type the caller may see, with its schema if it declares one")
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .handler(handlers::list_types)
        .json_response_with_schema::<dto::GraphTypeListDto>(
            openapi,
            http::StatusCode::OK,
            "Registered types",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post(format!("{BASE}/types"))
        .operation_id("graph_storage.register_type")
        .summary("Register a GTS type")
        .description(
            "Intern a node or edge type so ingested rows can reference it. \
             Idempotent. An optional JSON Schema makes payloads of this type \
             validated at ingest; sending one for an existing type replaces it.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<dto::RegisterTypeReq>(openapi, "Type to register")
        .handler(handlers::register_type)
        .json_response_with_schema::<dto::RegisteredTypeDto>(
            openapi,
            http::StatusCode::OK,
            "Interned type id",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── ingest ──
    let router = OperationBuilder::post(format!("{BASE}/ingest"))
        .operation_id("graph_storage.ingest")
        .summary("Upsert nodes and edges")
        .description(
            "Batch upsert keyed on tenant-scoped natural keys, so repeating an \
             identical batch converges instead of duplicating. Applied \
             atomically: the whole batch commits or nothing does.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<dto::IngestReq>(openapi, "Nodes and edges to upsert")
        .handler(handlers::ingest)
        .json_response_with_schema::<dto::IngestResultDto>(
            openapi,
            http::StatusCode::OK,
            "Counts of upserted rows and the new revision",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── nodes ──
    let router = OperationBuilder::get(format!("{BASE}/nodes"))
        .operation_id("graph_storage.list_nodes")
        .summary("List nodes, or fetch one by key")
        .description(
            "Keyset-paginated on the surrogate id. Pass `key` to fetch the \
             single node carrying a producer-supplied key instead.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param("type_id", false, "Only nodes of this GTS type")
        .query_param("key", false, "Fetch the node carrying this key")
        .query_param("cursor", false, "Cursor from a previous page")
        .query_param_typed("limit", false, "Page size", "integer")
        .query_param_typed("include_payload", false, "Include attributes", "boolean")
        .handler(handlers::list_nodes)
        .json_response_with_schema::<dto::GraphNodePageDto>(
            openapi,
            http::StatusCode::OK,
            "A page of nodes",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::delete(format!("{BASE}/nodes"))
        .operation_id("graph_storage.delete_node")
        .summary("Remove a node and its edges")
        .description(
            "Addressed by key rather than id, and by query parameter rather \
             than path segment: node keys carry slashes and colons. The \
             incident edges are detached in the same transaction.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param("key", true, "Key of the node to remove")
        .handler(handlers::delete_node)
        .json_response_with_schema::<dto::GraphDeleteResultDto>(
            openapi,
            http::StatusCode::OK,
            "What was removed",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get(format!("{BASE}/nodes/{{id}}"))
        .operation_id("graph_storage.get_node")
        .summary("Fetch one node by id")
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Surrogate node id")
        .query_param_typed("include_payload", false, "Include attributes", "boolean")
        .handler(handlers::get_node)
        .json_response_with_schema::<dto::GraphNodeDto>(openapi, http::StatusCode::OK, "The node")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get(format!("{BASE}/nodes/{{id}}/edges"))
        .operation_id("graph_storage.list_edges")
        .summary("List the edges of one node")
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Surrogate node id")
        .query_param("direction", false, "out | in | both (default)")
        .query_param("cursor", false, "Cursor from a previous page")
        .query_param_typed("limit", false, "Page size", "integer")
        .query_param_typed("include_payload", false, "Include attributes", "boolean")
        .handler(handlers::list_edges)
        .json_response_with_schema::<dto::GraphEdgePageDto>(
            openapi,
            http::StatusCode::OK,
            "A page of edges",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── edges ──
    let router = OperationBuilder::delete(format!("{BASE}/edges/{{id}}"))
        .operation_id("graph_storage.delete_edge")
        .summary("Remove one edge")
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Surrogate edge id")
        .handler(handlers::delete_edge)
        .json_response_with_schema::<dto::GraphDeleteResultDto>(
            openapi,
            http::StatusCode::OK,
            "What was removed",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── prune ──
    let router = OperationBuilder::post(format!("{BASE}/prune"))
        .operation_id("graph_storage.prune")
        .summary("Remove every node matching a filter")
        .description(
            "The sweep an importer runs after a re-import: scope it by key \
             prefix and `not_seen_since` and it removes exactly what the import \
             did not refresh. At least one filter is required — a prune with \
             none would take the tenant's whole graph.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<dto::GraphPruneReq>(openapi, "Which nodes to remove")
        .handler(handlers::prune)
        .json_response_with_schema::<dto::GraphDeleteResultDto>(
            openapi,
            http::StatusCode::OK,
            "What was removed",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── traverse ──
    let router = OperationBuilder::get(format!("{BASE}/neighbours"))
        .operation_id("graph_storage.get_neighbours")
        .summary("Bounded neighbourhood expansion")
        .description(
            "Breadth-first expansion around seed nodes, bounded by the \
             configured depth and node budget, restricted to the \
             caller-authorised subgraph",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param("seeds", true, "Comma-separated seed node ids")
        .query_param_typed("depth", false, "Traversal depth", "integer")
        .query_param("direction", false, "out | in | both (default)")
        .query_param(
            "edge_types",
            false,
            "Comma-separated GTS edge types to follow",
        )
        .handler(handlers::get_neighbours)
        .json_response_with_schema::<dto::NeighboursDto>(
            openapi,
            http::StatusCode::OK,
            "Reachable node ids",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get(format!("{BASE}/subgraph"))
        .operation_id("graph_storage.get_subgraph")
        .summary("Drawable neighbourhood")
        .description(
            "The same expansion as /neighbours, resolved into nodes with names \
             and types plus the edges between them, so a client can render it. \
             An edge is included only when both its endpoints are authorised.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param("seeds", true, "Comma-separated seed node ids")
        .query_param_typed("depth", false, "Traversal depth", "integer")
        .query_param("direction", false, "out | in | both (default)")
        .query_param(
            "edge_types",
            false,
            "Comma-separated GTS edge types to follow",
        )
        .query_param_typed("include_payload", false, "Include attributes", "boolean")
        .handler(handlers::get_subgraph)
        .json_response_with_schema::<dto::SubgraphDto>(
            openapi,
            http::StatusCode::OK,
            "Nodes and the edges between them",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── search ──
    let router = OperationBuilder::get(format!("{BASE}/search"))
        .operation_id("graph_storage.search")
        .summary("Lexical search")
        .description(
            "Rank the caller's nodes against a free-text query, most relevant \
             first, restricted to the caller-authorised subgraph",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param("q", true, "Free text to match")
        .query_param_typed("limit", false, "Maximum matches", "integer")
        .query_param_typed("include_payload", false, "Include attributes", "boolean")
        .handler(handlers::search)
        .json_response_with_schema::<dto::SearchResultDto>(
            openapi,
            http::StatusCode::OK,
            "Ranked matches",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post(format!("{BASE}/hybrid"))
        .operation_id("graph_storage.hybrid")
        .summary("Hybrid retrieval")
        .description(
            "Vector similarity picks the seeds, the graph expands around them, \
             and a full-text predicate filters what is reached — one SQL/PGQ \
             statement. Requires ingested nodes to carry embeddings; the gear \
             never computes them.",
        )
        .tag(API_TAG)
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<dto::GraphHybridReq>(openapi, "Query vector and text")
        .handler(handlers::hybrid)
        .json_response_with_schema::<dto::GraphHybridResultDto>(
            openapi,
            http::StatusCode::OK,
            "Reached nodes, nearest first",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(services))
}
