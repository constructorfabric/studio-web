//! REST DTOs. Serialization lives here and nowhere else.
//!
//! Response types are named with a `Graph` prefix because the assembly shares
//! one `OpenAPI` schema registry: `NodeDto` is already taken by nodes-registry,
//! and a collision is a boot-time panic, not a warning.

use serde_json::Value;

use crate::graph_storage::sdk::{
    DeleteResult, EdgeView, GraphStats, HybridHit, IngestResult, NodeView, TypeView,
};

/// Coarse counters describing the caller's graph.
#[derive(Debug, Clone, Copy)]
#[toolkit_macros::api_dto(response)]
pub struct GraphStatsDto {
    /// Number of nodes visible to the caller.
    pub nodes: u64,
    /// Number of edges visible to the caller.
    pub edges: u64,
    /// Monotonic revision, bumped whenever stored state changes. Poll this to
    /// learn that the graph moved.
    pub graph_revision: u64,
}

impl From<GraphStats> for GraphStatsDto {
    fn from(value: GraphStats) -> Self {
        Self {
            nodes: value.nodes,
            edges: value.edges,
            graph_revision: value.graph_revision,
        }
    }
}

/// Result of a bounded neighbourhood expansion.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct NeighboursDto {
    /// Node ids reachable from the seeds within the requested depth,
    /// restricted to what the caller is authorised to see.
    pub nodes: Vec<i64>,
    /// Whether the node budget truncated the result.
    pub truncated: bool,
}

/// One node submitted for ingest.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request)]
pub struct NodeInputDto {
    /// Stable key, unique within the tenant.
    pub node_key: String,
    /// GTS identifier of a registered node type.
    pub type_id: String,
    /// Display name.
    pub name: String,
    /// Text fed to lexical search. Omitted means "index the display name".
    #[serde(default)]
    pub search_text: Option<String>,
    /// Attributes, as a JSON object. Omitted leaves stored attributes alone;
    /// `{}` clears them. A supplied payload replaces rather than merges.
    #[serde(default)]
    pub payload: Option<Value>,
    /// Embedding of the search text. The gear never computes one; its length
    /// must match the configured dimension.
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
}

/// One edge submitted for ingest, addressed by endpoint node keys.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request)]
pub struct EdgeInputDto {
    /// GTS identifier of a registered edge type.
    pub type_id: String,
    /// Node key of the source endpoint.
    pub from: String,
    /// Node key of the target endpoint.
    pub to: String,
    /// Attributes. Same semantics as a node's.
    #[serde(default)]
    pub payload: Option<Value>,
}

/// An ingest batch.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request)]
pub struct IngestReq {
    /// Nodes to upsert.
    #[serde(default)]
    pub nodes: Vec<NodeInputDto>,
    /// Edges to upsert.
    #[serde(default)]
    pub edges: Vec<EdgeInputDto>,
}

/// Outcome of an ingest batch.
#[derive(Debug, Clone, Copy)]
#[toolkit_macros::api_dto(response)]
pub struct IngestResultDto {
    /// Nodes the statement inserted or updated.
    pub nodes_upserted: u64,
    /// Edges the statement inserted.
    pub edges_upserted: u64,
    /// Revision the graph reached once this batch committed.
    pub graph_revision: u64,
}

impl From<IngestResult> for IngestResultDto {
    fn from(v: IngestResult) -> Self {
        Self {
            nodes_upserted: v.nodes_upserted,
            edges_upserted: v.edges_upserted,
            graph_revision: v.graph_revision,
        }
    }
}

/// Registration of a GTS type.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request)]
pub struct RegisterTypeReq {
    /// GTS identifier.
    pub type_id: String,
    /// `node`, `edge` or `attribute`.
    pub kind: String,
    /// Draft-07 JSON Schema payloads of this type are validated against.
    /// Omitted means the type declares no constraints.
    #[serde(default)]
    pub json_schema: Option<Value>,
}

/// Interned identifier assigned to a registered type.
#[derive(Debug, Clone, Copy)]
#[toolkit_macros::api_dto(response)]
pub struct RegisteredTypeDto {
    /// Interned id referenced by nodes and edges.
    pub id: i32,
}

/// One registered type.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GraphTypeDto {
    /// Interned id referenced by nodes and edges.
    pub id: i32,
    /// GTS identifier.
    pub type_id: String,
    /// `node`, `edge` or `attribute`.
    pub kind: String,
    /// Schema payloads are validated against, when the type declares one.
    pub json_schema: Option<Value>,
}

impl From<TypeView> for GraphTypeDto {
    fn from(v: TypeView) -> Self {
        Self {
            id: v.id,
            type_id: v.type_id,
            kind: v.kind,
            json_schema: v.json_schema,
        }
    }
}

/// Every type the caller may see.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GraphTypeListDto {
    /// The types.
    pub items: Vec<GraphTypeDto>,
}

/// One node, resolved enough to list or to draw.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GraphNodeDto {
    /// Surrogate identifier, unique within the tenant.
    pub id: i64,
    /// Producer-supplied stable key.
    pub node_key: String,
    /// Display name.
    pub name: String,
    /// GTS identifier of the node's type.
    pub type_id: String,
    /// Attributes, present only when `include_payload` was set.
    pub payload: Option<Value>,
}

impl From<NodeView> for GraphNodeDto {
    fn from(v: NodeView) -> Self {
        Self {
            id: v.id,
            node_key: v.node_key,
            name: v.name,
            type_id: v.type_id,
            payload: v.payload,
        }
    }
}

/// One edge between two nodes the caller may see.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GraphEdgeDto {
    /// Surrogate identifier of the edge.
    pub id: i64,
    /// Source node identifier.
    pub src: i64,
    /// Destination node identifier.
    pub dst: i64,
    /// GTS identifier of the edge's type.
    pub type_id: String,
    /// Attributes, present only when `include_payload` was set.
    pub payload: Option<Value>,
}

impl From<EdgeView> for GraphEdgeDto {
    fn from(v: EdgeView) -> Self {
        Self {
            id: v.id,
            src: v.src,
            dst: v.dst,
            type_id: v.type_id,
            payload: v.payload,
        }
    }
}

/// Ranked matches of a lexical search.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct SearchResultDto {
    /// Matching nodes, most relevant first.
    pub nodes: Vec<GraphNodeDto>,
}

/// A drawable neighbourhood: nodes plus the edges between them.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct SubgraphDto {
    /// Nodes reachable from the seeds within the requested depth.
    pub nodes: Vec<GraphNodeDto>,
    /// Edges whose both endpoints are in `nodes`.
    pub edges: Vec<GraphEdgeDto>,
    /// Whether the node budget truncated the result.
    pub truncated: bool,
}

/// A page of nodes.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GraphNodePageDto {
    /// The nodes on this page.
    pub items: Vec<GraphNodeDto>,
    /// Cursor for the next page; absent on the last page.
    pub next_cursor: Option<String>,
}

/// A page of edges.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GraphEdgePageDto {
    /// The edges on this page.
    pub items: Vec<GraphEdgeDto>,
    /// Cursor for the next page; absent on the last page.
    pub next_cursor: Option<String>,
}

/// What a delete or prune removed.
#[derive(Debug, Clone, Copy)]
#[toolkit_macros::api_dto(response)]
pub struct GraphDeleteResultDto {
    /// Nodes removed.
    pub nodes_deleted: u64,
    /// Edges removed, including those detached to make a node removable.
    pub edges_deleted: u64,
    /// Revision the graph reached once the deletion committed.
    pub graph_revision: u64,
}

impl From<DeleteResult> for GraphDeleteResultDto {
    fn from(v: DeleteResult) -> Self {
        Self {
            nodes_deleted: v.nodes_deleted,
            edges_deleted: v.edges_deleted,
            graph_revision: v.graph_revision,
        }
    }
}

/// Which nodes a prune removes. The filters are ANDed and at least one is
/// required — a prune with none would take the tenant's whole graph.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request)]
pub struct GraphPruneReq {
    /// Only nodes of this GTS type.
    #[serde(default)]
    pub type_id: Option<String>,
    /// Only nodes whose key starts with this prefix.
    #[serde(default)]
    pub node_key_prefix: Option<String>,
    /// Only nodes untouched since this RFC 3339 instant.
    #[serde(default)]
    pub not_seen_since: Option<String>,
}

/// What a hybrid retrieval asks for.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request)]
pub struct GraphHybridReq {
    /// Embedding of the caller's query; nearest nodes to it seed the walk.
    pub query_vector: Vec<f32>,
    /// Free text the reached nodes must match.
    #[serde(default)]
    pub text: String,
    /// How many nearest neighbours seed the walk.
    #[serde(default = "default_seed_limit")]
    pub seed_limit: u32,
    /// How many results to return.
    #[serde(default = "default_hybrid_limit")]
    pub limit: u32,
}

const fn default_seed_limit() -> u32 {
    50
}

const fn default_hybrid_limit() -> u32 {
    20
}

/// One node reached by a hybrid retrieval.
#[derive(Debug, Clone, Copy)]
#[toolkit_macros::api_dto(response)]
pub struct GraphHybridHitDto {
    /// Node identifier.
    pub id: i64,
    /// Cosine distance from the query vector.
    pub distance: f64,
}

impl From<HybridHit> for GraphHybridHitDto {
    fn from(v: HybridHit) -> Self {
        Self {
            id: v.id,
            distance: v.distance,
        }
    }
}

/// Results of a hybrid retrieval, nearest first.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GraphHybridResultDto {
    /// The reached nodes.
    pub nodes: Vec<GraphHybridHitDto>,
}
