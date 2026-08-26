//! Read queries that render a graph for a human or hand it to a consumer:
//! lexical search, the subgraph around a set of seeds, single-node lookups and
//! paged listings.
//!
//! # Scoping
//!
//! Every query here goes through the secure ORM, so the caller's `AccessScope`
//! is applied by construction. The edge queries are deliberately restricted to
//! edges whose **both** endpoints are in the authorised node set: an edge to a
//! node the caller cannot see would otherwise render as a line into nothing,
//! and would leak the existence of that node.
//!
//! # Payloads are opt-in
//!
//! Attributes are fetched only when the caller asks. The drawing path pulls
//! hundreds of nodes to render names and types, and should not pay to transfer
//! payloads it will not display. That is why the projections come in pairs
//! rather than always selecting the payload column and discarding it.
//!
//! # Cursors
//!
//! Listings are keyset-paginated on the surrogate id, which is monotonic within
//! a tenant and already the primary key — so a page boundary cannot drift when
//! rows are inserted or removed, the way an `OFFSET` would.

use base64::Engine as _;
use sea_orm::sea_query::{Alias, Expr, Order};
use sea_orm::{ColumnTrait, Condition, EntityTrait, FromQueryResult, QueryOrder, QuerySelect};
use serde_json::Value;
use toolkit_db::secure::{AccessScope, DBRunner, SecureEntityExt};

use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::entity::{graph_edge, graph_node, graph_type};
use crate::graph_storage::infra::storage::migrations::m20260818_000004_search_indexes::FTS_CONFIG;
use crate::graph_storage::sdk::{EdgeView, NodeView, TypeView};

/// Column the lexical rank is projected as.
const RANK: &str = "rank";

fn storage_err(e: impl std::fmt::Display) -> DomainError {
    DomainError::Storage(e.to_string())
}

/// Node projection without attributes.
#[derive(Debug, FromQueryResult)]
struct NodeRowLite {
    id: i64,
    node_key: String,
    name: String,
    type_id: i32,
}

/// Node projection carrying attributes.
#[derive(Debug, FromQueryResult)]
struct NodeRowFull {
    id: i64,
    node_key: String,
    name: String,
    type_id: i32,
    payload: Value,
}

/// Edge projection without attributes.
#[derive(Debug, FromQueryResult)]
struct EdgeRowLite {
    id: i64,
    src_node_id: i64,
    dst_node_id: i64,
    type_id: i32,
}

/// Edge projection carrying attributes.
#[derive(Debug, FromQueryResult)]
struct EdgeRowFull {
    id: i64,
    src_node_id: i64,
    dst_node_id: i64,
    type_id: i32,
    payload: Value,
}

/// Either node projection, before interned type ids are resolved.
enum NodeRows {
    Lite(Vec<NodeRowLite>),
    Full(Vec<NodeRowFull>),
}

impl NodeRows {
    fn is_empty(&self) -> bool {
        match self {
            Self::Lite(r) => r.is_empty(),
            Self::Full(r) => r.is_empty(),
        }
    }

    fn last_id(&self) -> Option<i64> {
        match self {
            Self::Lite(r) => r.last().map(|n| n.id),
            Self::Full(r) => r.last().map(|n| n.id),
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Lite(r) => r.len(),
            Self::Full(r) => r.len(),
        }
    }

    fn into_views(self, types: &std::collections::HashMap<i32, String>) -> Vec<NodeView> {
        let name_of = |id: i32| types.get(&id).cloned().unwrap_or_else(|| id.to_string());
        match self {
            Self::Lite(rows) => rows
                .into_iter()
                .map(|r| NodeView {
                    id: r.id,
                    node_key: r.node_key,
                    name: r.name,
                    type_id: name_of(r.type_id),
                    payload: None,
                })
                .collect(),
            Self::Full(rows) => rows
                .into_iter()
                .map(|r| NodeView {
                    id: r.id,
                    node_key: r.node_key,
                    name: r.name,
                    type_id: name_of(r.type_id),
                    payload: Some(r.payload),
                })
                .collect(),
        }
    }
}

/// Encode a keyset cursor.
fn encode_cursor(last_id: i64) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(last_id.to_string())
}

/// Decode a keyset cursor.
///
/// # Errors
/// Returns [`DomainError::BadCursor`] for anything this module did not issue.
pub fn decode_cursor(cursor: &str) -> Result<i64, DomainError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| DomainError::BadCursor)?;
    std::str::from_utf8(&bytes)
        .map_err(|_| DomainError::BadCursor)?
        .parse::<i64>()
        .map_err(|_| DomainError::BadCursor)
}

/// Rank nodes whose composed text matches `text`, most relevant first.
///
/// The predicate is written on the same expression the GIN index is built on
/// (`m20260818_000004_search_indexes`), read from the same constant: a
/// different configuration name would still return correct rows and silently
/// stop using the index.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn search<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    text: &str,
    limit: u32,
    include_payload: bool,
) -> Result<Vec<NodeView>, DomainError> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }

    let matches =
        format!("to_tsvector('{FTS_CONFIG}', search_text) @@ plainto_tsquery('{FTS_CONFIG}', $1)");
    let rank = format!(
        "ts_rank(to_tsvector('{FTS_CONFIG}', search_text), plainto_tsquery('{FTS_CONFIG}', $1))"
    );
    let value = sea_orm::Value::from(text.to_owned());
    let limit = u64::from(limit);

    let base = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(Condition::all().add(Expr::cust_with_values(matches, [value.clone()])));

    let rank_expr = Expr::cust_with_values(rank, [value]);
    let rows = if include_payload {
        NodeRows::Full(
            base.project_all(conn, move |q| {
                q.select_only()
                    .column(graph_node::Column::Id)
                    .column(graph_node::Column::NodeKey)
                    .column(graph_node::Column::Name)
                    .column(graph_node::Column::TypeId)
                    .column(graph_node::Column::Payload)
                    .expr_as(rank_expr, RANK)
                    .order_by(Expr::col(Alias::new(RANK)), Order::Desc)
                    .limit(limit)
                    .into_model::<NodeRowFull>()
            })
            .await
            .map_err(storage_err)?,
        )
    } else {
        NodeRows::Lite(
            base.project_all(conn, move |q| {
                q.select_only()
                    .column(graph_node::Column::Id)
                    .column(graph_node::Column::NodeKey)
                    .column(graph_node::Column::Name)
                    .column(graph_node::Column::TypeId)
                    .expr_as(rank_expr, RANK)
                    .order_by(Expr::col(Alias::new(RANK)), Order::Desc)
                    .limit(limit)
                    .into_model::<NodeRowLite>()
            })
            .await
            .map_err(storage_err)?,
        )
    };

    finish_nodes(conn, scope, rows).await
}

/// Fetch nodes by a filter, ordered by id, at most `limit` of them.
async fn nodes_where<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    cond: Condition,
    limit: u64,
    include_payload: bool,
) -> Result<NodeRows, DomainError> {
    let base = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(cond);

    if include_payload {
        Ok(NodeRows::Full(
            base.project_all(conn, move |q| {
                q.select_only()
                    .column(graph_node::Column::Id)
                    .column(graph_node::Column::NodeKey)
                    .column(graph_node::Column::Name)
                    .column(graph_node::Column::TypeId)
                    .column(graph_node::Column::Payload)
                    .order_by(Expr::col(graph_node::Column::Id), Order::Asc)
                    .limit(limit)
                    .into_model::<NodeRowFull>()
            })
            .await
            .map_err(storage_err)?,
        ))
    } else {
        Ok(NodeRows::Lite(
            base.project_all(conn, move |q| {
                q.select_only()
                    .column(graph_node::Column::Id)
                    .column(graph_node::Column::NodeKey)
                    .column(graph_node::Column::Name)
                    .column(graph_node::Column::TypeId)
                    .order_by(Expr::col(graph_node::Column::Id), Order::Asc)
                    .limit(limit)
                    .into_model::<NodeRowLite>()
            })
            .await
            .map_err(storage_err)?,
        ))
    }
}

/// Fetch the nodes with the given ids, in id order.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn nodes<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    ids: &[i64],
    include_payload: bool,
) -> Result<Vec<NodeView>, DomainError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let cond = Condition::all().add(graph_node::Column::Id.is_in(ids.iter().copied()));
    let rows = nodes_where(conn, scope, cond, ids.len() as u64, include_payload).await?;
    finish_nodes(conn, scope, rows).await
}

/// One node by its producer-supplied key.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn node_by_key<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    node_key: &str,
    include_payload: bool,
) -> Result<Option<NodeView>, DomainError> {
    let cond = Condition::all().add(graph_node::Column::NodeKey.eq(node_key));
    let rows = nodes_where(conn, scope, cond, 1, include_payload).await?;
    Ok(finish_nodes(conn, scope, rows).await?.into_iter().next())
}

/// One node by its surrogate id.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn node_by_id<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    id: i64,
    include_payload: bool,
) -> Result<Option<NodeView>, DomainError> {
    let cond = Condition::all().add(graph_node::Column::Id.eq(id));
    let rows = nodes_where(conn, scope, cond, 1, include_payload).await?;
    Ok(finish_nodes(conn, scope, rows).await?.into_iter().next())
}

/// A page of nodes, optionally narrowed to one interned type.
///
/// Returns the page and the cursor that continues it, which is `None` once the
/// page came back short of `limit`.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn list_nodes<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    type_id: Option<i32>,
    after_id: Option<i64>,
    limit: u32,
    include_payload: bool,
) -> Result<(Vec<NodeView>, Option<String>), DomainError> {
    let mut cond = Condition::all();
    if let Some(t) = type_id {
        cond = cond.add(graph_node::Column::TypeId.eq(t));
    }
    if let Some(after) = after_id {
        cond = cond.add(graph_node::Column::Id.gt(after));
    }

    let rows = nodes_where(conn, scope, cond, u64::from(limit), include_payload).await?;
    let full_page = rows.len() == limit as usize;
    let next = if full_page { rows.last_id() } else { None };
    let views = finish_nodes(conn, scope, rows).await?;
    Ok((views, next.map(encode_cursor)))
}

/// Fetch the edges whose **both** endpoints are among `ids`.
///
/// Restricting both ends rather than one is what keeps the rendered graph
/// closed: an edge with one visible endpoint would draw a line to a node the
/// caller may not see, and disclose that it exists.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn edges_within<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    ids: &[i64],
    include_payload: bool,
) -> Result<Vec<EdgeView>, DomainError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let cond = Condition::all()
        .add(graph_edge::Column::SrcNodeId.is_in(ids.iter().copied()))
        .add(graph_edge::Column::DstNodeId.is_in(ids.iter().copied()));
    let (views, _) = edges_where(conn, scope, cond, u32::MAX, include_payload).await?;
    Ok(views)
}

/// A page of edges incident to one node.
///
/// `outgoing` selects the direction: `Some(true)` for edges leaving the node,
/// `Some(false)` for edges entering it, `None` for both.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn list_edges<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    node_id: i64,
    outgoing: Option<bool>,
    after_id: Option<i64>,
    limit: u32,
    include_payload: bool,
) -> Result<(Vec<EdgeView>, Option<String>), DomainError> {
    let incident = match outgoing {
        Some(true) => Condition::all().add(graph_edge::Column::SrcNodeId.eq(node_id)),
        Some(false) => Condition::all().add(graph_edge::Column::DstNodeId.eq(node_id)),
        None => Condition::any()
            .add(graph_edge::Column::SrcNodeId.eq(node_id))
            .add(graph_edge::Column::DstNodeId.eq(node_id)),
    };
    let mut cond = Condition::all().add(incident);
    if let Some(after) = after_id {
        cond = cond.add(graph_edge::Column::Id.gt(after));
    }
    edges_where(conn, scope, cond, limit, include_payload).await
}

/// Shared edge projection and type resolution.
async fn edges_where<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    cond: Condition,
    limit: u32,
    include_payload: bool,
) -> Result<(Vec<EdgeView>, Option<String>), DomainError> {
    let base = graph_edge::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(cond);
    let limit64 = u64::from(limit);

    let types = interned_types(conn, scope).await?;
    let name_of = |id: i32| types.get(&id).cloned().unwrap_or_else(|| id.to_string());

    let (views, last_id, len) = if include_payload {
        let rows: Vec<EdgeRowFull> = base
            .project_all(conn, move |q| {
                q.select_only()
                    .column(graph_edge::Column::Id)
                    .column(graph_edge::Column::SrcNodeId)
                    .column(graph_edge::Column::DstNodeId)
                    .column(graph_edge::Column::TypeId)
                    .column(graph_edge::Column::Payload)
                    .order_by(Expr::col(graph_edge::Column::Id), Order::Asc)
                    .limit(limit64)
                    .into_model::<EdgeRowFull>()
            })
            .await
            .map_err(storage_err)?;
        let last = rows.last().map(|r| r.id);
        let len = rows.len();
        (
            rows.into_iter()
                .map(|r| EdgeView {
                    id: r.id,
                    src: r.src_node_id,
                    dst: r.dst_node_id,
                    type_id: name_of(r.type_id),
                    payload: Some(r.payload),
                })
                .collect::<Vec<_>>(),
            last,
            len,
        )
    } else {
        let rows: Vec<EdgeRowLite> = base
            .project_all(conn, move |q| {
                q.select_only()
                    .column(graph_edge::Column::Id)
                    .column(graph_edge::Column::SrcNodeId)
                    .column(graph_edge::Column::DstNodeId)
                    .column(graph_edge::Column::TypeId)
                    .order_by(Expr::col(graph_edge::Column::Id), Order::Asc)
                    .limit(limit64)
                    .into_model::<EdgeRowLite>()
            })
            .await
            .map_err(storage_err)?;
        let last = rows.last().map(|r| r.id);
        let len = rows.len();
        (
            rows.into_iter()
                .map(|r| EdgeView {
                    id: r.id,
                    src: r.src_node_id,
                    dst: r.dst_node_id,
                    type_id: name_of(r.type_id),
                    payload: None,
                })
                .collect::<Vec<_>>(),
            last,
            len,
        )
    };

    let next = if len == limit as usize {
        last_id.map(encode_cursor)
    } else {
        None
    };
    Ok((views, next))
}

/// Every type the caller may see.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn types<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
) -> Result<Vec<TypeView>, DomainError> {
    let rows = graph_type::Entity::find()
        .secure()
        .scope_with(scope)
        .all(conn)
        .await
        .map_err(storage_err)?;

    Ok(rows
        .into_iter()
        .map(|t| TypeView {
            id: t.id,
            type_id: t.type_id,
            kind: t.kind,
            json_schema: non_empty_object(t.json_schema),
        })
        .collect())
}

/// The schema registered for one interned type, if it declares one.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn schema_for_type<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    type_id: i32,
) -> Result<Option<Value>, DomainError> {
    let row = graph_type::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(Condition::all().add(graph_type::Column::Id.eq(type_id)))
        .one(conn)
        .await
        .map_err(storage_err)?;

    Ok(row.and_then(|t| non_empty_object(t.json_schema)))
}

/// An empty schema is "no constraints declared", which is different from a type
/// that carries one — the distinction is what tells a producer whether its
/// payloads are being checked at all.
fn non_empty_object(value: Value) -> Option<Value> {
    match value {
        Value::Object(ref m) if m.is_empty() => None,
        other => Some(other),
    }
}

/// Resolve interned type ids on a set of node rows.
async fn finish_nodes<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    rows: NodeRows,
) -> Result<Vec<NodeView>, DomainError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let types = interned_types(conn, scope).await?;
    Ok(rows.into_views(&types))
}

/// Every type the caller may see, as `interned id -> GTS identifier`.
///
/// One lookup for the whole batch rather than a join: `graph_type` holds one
/// row per registered type per tenant, so it is small, and joining would put
/// the scope predicate on two tables whose `id` means different things.
async fn interned_types<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
) -> Result<std::collections::HashMap<i32, String>, DomainError> {
    let rows = graph_type::Entity::find()
        .secure()
        .scope_with(scope)
        .all(conn)
        .await
        .map_err(storage_err)?;
    Ok(rows.into_iter().map(|t| (t.id, t.type_id)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cursor has to survive the round trip, and nothing else may pass — a
    /// forged one could otherwise page into rows the endpoint never offered.
    #[test]
    fn cursors_round_trip_and_reject_forgeries() {
        let c = encode_cursor(4_294_967_296);
        assert_eq!(decode_cursor(&c).unwrap(), 4_294_967_296);
        assert!(matches!(
            decode_cursor("not-a-cursor"),
            Err(DomainError::BadCursor)
        ));
        assert!(matches!(decode_cursor(""), Err(DomainError::BadCursor)));
    }
}
