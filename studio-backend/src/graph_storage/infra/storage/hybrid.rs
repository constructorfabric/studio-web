//! Vector search, graph expansion and full-text filtering in one statement.
//!
//! # Why this shape and not the obvious one
//!
//! The natural way to write it is a `WITH seeds AS (... ORDER BY embedding <=>
//! $q LIMIT k)` feeding the pattern. `PostgreSQL` 19 rejects it:
//!
//! ```text
//! ERROR: subqueries within GRAPH_TABLE reference are not supported
//! ```
//!
//! A pattern cannot compute its own seeds, and neither `IN (SELECT ...)` nor
//! `= ANY(ARRAY(SELECT ...))` gets around it. `LATERAL` is also rejected before
//! `GRAPH_TABLE`. What does work is a **comma join with a correlated
//! reference** — an implicit lateral:
//!
//! ```sql
//! FROM (SELECT id FROM graph_node ORDER BY embedding <=> $q LIMIT $k) AS knn_seeds,
//!      GRAPH_TABLE (kb_pgq MATCH (a)-[e]->(b) WHERE a.id = knn_seeds.id ...) AS g
//! ```
//!
//! That single fact is what makes single-statement hybrid retrieval possible at
//! all on this release, so it is pinned by a test rather than left in a comment.
//!
//! # Scoping
//!
//! The same two layers as the plain hop (`traversal_pgq`): the seed search and
//! the pattern are candidate producers carrying the caller's tenant bound, and
//! the outer query is an ordinary scoped secure-ORM select that applies the
//! caller's whole `AccessScope` to what they propose. A scope narrower than a
//! tenant makes the inner half over-produce and the outer half remove the
//! surplus.

use sea_orm::sea_query::{Alias, Expr, ExprTrait, Order, Query, SelectStatement, TableRef};
use sea_orm::{EntityTrait, FromQueryResult, QueryOrder, QuerySelect, Value};
use toolkit_db::secure::{AccessScope, DBRunner, SecureEntityExt};

use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::entity::graph_node;
use crate::graph_storage::infra::storage::migrations::m20260818_000004_search_indexes::FTS_CONFIG;
use crate::graph_storage::infra::storage::pgq::{
    Direction, Graph, IdList, Output, Pattern, Property, Source, TenantBound, Var, tenant_bound,
};

/// What a hybrid retrieval asks for.
#[derive(Debug, Clone)]
pub struct HybridRequest<'a> {
    /// Query embedding; nearest nodes to it become the walk's seeds.
    pub query_vector: &'a [f32],
    /// Free text the reached nodes must match.
    pub text: &'a str,
    /// How many nearest neighbours seed the walk.
    pub seed_limit: u32,
    /// How many results to return.
    pub limit: u32,
}

/// One reached node and its distance from the query vector.
#[derive(Debug, Clone, PartialEq, FromQueryResult)]
pub struct HybridHit {
    /// Node identifier.
    pub id: i64,
    /// Cosine distance between the node's embedding and the query vector.
    pub distance: f64,
}

/// Column the distance expression is projected as.
const DISTANCE: &str = "distance";

/// Render a `vector` literal.
///
/// Only `f32` values reach the string, so no caller text can, and it binds as
/// one parameter regardless of dimension.
fn vector_literal(values: &[f32]) -> String {
    let joined = values
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("[{joined}]")
}

/// `embedding <=> $q` — cosine distance to the query vector.
///
/// `sea_query` has no vector operators, so the fragment is ours; the vector is
/// bound, and the column name is the entity's.
fn distance_expr(query_vector: &[f32]) -> sea_orm::sea_query::Expr {
    Expr::cust_with_values(
        "embedding <=> $1::vector",
        [Value::from(vector_literal(query_vector))],
    )
}

/// The nearest-neighbour seed set, as a derived table.
fn knn_seeds(tenants: &[uuid::Uuid], request: &HybridRequest<'_>) -> SelectStatement {
    Query::select()
        .column(graph_node::Column::Id)
        .from(graph_node::Entity)
        .and_where(Expr::cust_with_values(
            "tenant_id = ANY($1::uuid[])",
            [Value::from(IdList::Uuid(tenants.to_vec()).literal())],
        ))
        .and_where(Expr::col(Alias::new("embedding")).is_not_null())
        .order_by_expr(distance_expr(request.query_vector), Order::Asc)
        .limit(u64::from(request.seed_limit))
        .to_owned()
}

/// Candidate ids: one hop out of every seed, in both directions.
///
/// The pattern correlates against the seed table rather than receiving a list,
/// because a pattern cannot contain a subquery.
fn expanded_from_seeds(tenants: &[uuid::Uuid], request: &HybridRequest<'_>) -> SelectStatement {
    // Both legs are built the same way and unioned, so the outer query keeps a
    // single semi-join (`dev/FINDINGS.md (F9)`).
    let mut combined: Option<SelectStatement> = None;

    for direction in [Direction::Outgoing, Direction::Incoming] {
        let pattern = Pattern::hop(Graph::Kb, direction, tenants.to_vec())
            .correlate(Var::Source, Property::Id, Source::KnnSeeds)
            .project(Var::Target, Property::Id, Output::Neighbour);

        let leg = Query::select()
            .column(Alias::new(Output::Neighbour.as_str()))
            .from(TableRef::SubQuery(
                Box::new(knn_seeds(tenants, request)),
                Alias::new(Source::KnnSeeds.alias()).into(),
            ))
            .from(pattern.to_source(direction.alias()))
            .to_owned();

        combined = Some(match combined {
            None => leg,
            Some(mut first) => first
                .union(sea_orm::sea_query::UnionType::Distinct, leg)
                .to_owned(),
        });
    }

    // The loop above always runs at least twice, so this is unreachable; it is
    // an expression rather than a panic because an empty candidate set is a
    // coherent answer and a crash is not.
    combined.unwrap_or_default()
}

/// Run vector search, graph expansion and full-text filtering as one statement.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails or when the caller's
/// scope cannot be reduced to a set of tenants.
pub async fn hybrid_neighbourhood<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    request: &HybridRequest<'_>,
) -> Result<Vec<HybridHit>, DomainError> {
    let tenants = match tenant_bound(scope).map_err(|e| DomainError::Storage(e.to_string()))? {
        TenantBound::Nothing => return Ok(Vec::new()),
        TenantBound::These(tenants) => tenants,
    };

    let limit = u64::from(request.limit);
    let distance = distance_expr(request.query_vector);

    graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(
            sea_orm::Condition::all()
                .add(
                    Expr::col(graph_node::Column::Id)
                        .in_subquery(expanded_from_seeds(&tenants, request)),
                )
                .add(fts_predicate(request.text)),
        )
        .project_all(conn, move |q| {
            q.select_only()
                .column(graph_node::Column::Id)
                .expr_as(distance, DISTANCE)
                .order_by(Expr::col(Alias::new(DISTANCE)), Order::Asc)
                .limit(limit)
                .into_model::<HybridHit>()
        })
        .await
        .map_err(|e| DomainError::Storage(e.to_string()))
}

/// `to_tsvector(<config>, search_text) @@ plainto_tsquery(<config>, $text)`.
///
/// The configuration name is the one the index is built on
/// (`m20260818_000004_search_indexes`). A different name here would still
/// return correct rows and silently stop using the index, so the two are read
/// from the same constant.
fn fts_predicate(text: &str) -> sea_orm::sea_query::Expr {
    let template =
        format!("to_tsvector('{FTS_CONFIG}', search_text) @@ plainto_tsquery('{FTS_CONFIG}', $1)");
    Expr::cust_with_values(template, [Value::from(text.to_owned())])
}

/// Render the statement without executing it, so tests can assert on its shape.
#[must_use]
pub fn hybrid_sql(scope: &AccessScope, request: &HybridRequest<'_>) -> String {
    use sea_orm::QueryTrait;
    use sea_orm::sea_query::PostgresQueryBuilder;

    let Ok(TenantBound::These(tenants)) = tenant_bound(scope) else {
        return String::new();
    };
    let limit = u64::from(request.limit);
    let distance = distance_expr(request.query_vector);

    graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(
            sea_orm::Condition::all()
                .add(
                    Expr::col(graph_node::Column::Id)
                        .in_subquery(expanded_from_seeds(&tenants, request)),
                )
                .add(fts_predicate(request.text)),
        )
        .into_inner()
        .select_only()
        .column(graph_node::Column::Id)
        .expr_as(distance, DISTANCE)
        .order_by(Expr::col(Alias::new(DISTANCE)), Order::Asc)
        .limit(limit)
        .into_query()
        .to_string(PostgresQueryBuilder)
}
