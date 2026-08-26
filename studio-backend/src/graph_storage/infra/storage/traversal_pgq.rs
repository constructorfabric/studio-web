//! One breadth-first hop through SQL/PGQ, scoped end to end.
//!
//! # The two layers
//!
//! The `GRAPH_TABLE` pattern is a **candidate producer**, not the authorization
//! boundary. It carries the caller's tenant bound so it cannot read another
//! tenant's rows, and it hands back node ids. Those ids are then authorized by
//! an ordinary scoped query through the secure ORM, which applies the caller's
//! whole `AccessScope` — including the parts a pattern cannot express, such as
//! resource-id lists and group subtrees.
//!
//! Splitting it this way keeps the security-critical half inside the secure ORM
//! and leaves the free-form half unable to do more than propose candidates. It
//! is the same shape as the CTE hop, and it is why a scope narrower than a
//! tenant does not need to be expressible in the pattern.
//!
//! Because the walk authorizes between hops, a node the caller may not see
//! never enters the next frontier, so the walk cannot pass *through*
//! unauthorized territory either.
//!
//! # Why both directions come back in one subquery
//!
//! An undirected hop is two directed patterns. Combining them as
//! `id IN (out) OR id IN (inc)` costs a sequential scan of the node table —
//! `PostgreSQL` cannot drive an index from two hashed subplans under an `OR`
//! (`dev/FINDINGS.md (F9)`). They are unioned into one subquery instead, so the
//! outer query keeps a single semi-join.

use sea_orm::sea_query::{Alias, Expr, ExprTrait, Query, UnionType};
use sea_orm::{EntityTrait, FromQueryResult, QuerySelect};
use toolkit_db::secure::{AccessScope, DBRunner, SecureEntityExt};

use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::entity::graph_node;
use crate::graph_storage::infra::storage::pgq::{
    Direction, Graph, IdList, Output, Pattern, Property, TenantBound, Var, tenant_bound,
};

#[derive(Debug, FromQueryResult)]
struct NodeId {
    id: i64,
}

/// Return the node ids one undirected hop away from `frontier`, through
/// `GRAPH_TABLE`.
///
/// Only endpoints the caller is authorized to see are returned, so the result
/// can be used directly as the next frontier.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails, and
/// [`DomainError::Storage`] carrying the refusal when the caller's scope cannot
/// be carried into a graph pattern — the request is refused rather than served
/// by a pattern that is not tenant-bounded.
pub async fn expand_frontier_pgq<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    frontier: &[i64],
    edge_type_ids: Option<&[i32]>,
    outgoing: Option<bool>,
) -> Result<Vec<i64>, DomainError> {
    if frontier.is_empty() {
        return Ok(Vec::new());
    }

    let tenants = match tenant_bound(scope).map_err(|e| DomainError::Storage(e.to_string()))? {
        TenantBound::Nothing => return Ok(Vec::new()),
        TenantBound::These(tenants) => tenants,
    };

    let candidates = directions(&tenants, frontier, edge_type_ids, outgoing);

    let mut authorised: Vec<i64> = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(
            sea_orm::Condition::all()
                .add(Expr::col(graph_node::Column::Id).in_subquery(candidates)),
        )
        .project_all(conn, |q| {
            q.select_only()
                .column(graph_node::Column::Id)
                .into_model::<NodeId>()
        })
        .await
        .map_err(|e| DomainError::Storage(e.to_string()))?
        .into_iter()
        .map(|n| n.id)
        .collect();

    authorised.sort_unstable();
    Ok(authorised)
}

/// Candidate ids from the requested direction, as **one** subquery.
///
/// When both directions are wanted the legs are unioned rather than left as
/// two, because `id IN (out) OR id IN (inc)` is the same set and a sequential
/// scan of the node table -- `PostgreSQL` cannot drive an index from two hashed
/// subplans under an `OR` (`dev/FINDINGS.md (F9)`).
///
/// A one-directional walk renders a single leg. This is not only narrower: the
/// undirected shorthand a pattern *could* express instead is catastrophic on
/// this release (735 ms for one element against ~1.5 ms directed), which is why
/// both legs are always written with an explicit arrow.
fn directions(
    tenants: &[uuid::Uuid],
    frontier: &[i64],
    edge_type_ids: Option<&[i32]>,
    outgoing: Option<bool>,
) -> sea_orm::sea_query::SelectStatement {
    let out = || direction_subquery(tenants, frontier, edge_type_ids, Direction::Outgoing);
    let inc = || direction_subquery(tenants, frontier, edge_type_ids, Direction::Incoming);
    match outgoing {
        Some(true) => out(),
        Some(false) => inc(),
        None => out().union(UnionType::Distinct, inc()).to_owned(),
    }
}

/// One direction's candidate ids, as a subquery over `GRAPH_TABLE`.
fn direction_subquery(
    tenants: &[uuid::Uuid],
    frontier: &[i64],
    edge_type_ids: Option<&[i32]>,
    direction: Direction,
) -> sea_orm::sea_query::SelectStatement {
    let mut pattern = Pattern::hop(Graph::Kb, direction, tenants.to_vec())
        .restrict(Var::Source, Property::Id, IdList::BigInt(frontier.to_vec()))
        .project(Var::Target, Property::Id, Output::Neighbour);

    if let Some(types) = edge_type_ids {
        pattern = pattern.restrict(Var::Edge, Property::TypeId, IdList::Int(types.to_vec()));
    }

    Query::select()
        .column(Alias::new(Output::Neighbour.as_str()))
        .from(pattern.to_source(direction.alias()))
        .to_owned()
}

/// Render the scoped hop without executing it, so tests can assert on its shape.
#[must_use]
pub fn expand_frontier_pgq_sql(scope: &AccessScope, frontier: &[i64]) -> String {
    use sea_orm::QueryTrait;
    use sea_orm::sea_query::PostgresQueryBuilder;

    let Ok(TenantBound::These(tenants)) = tenant_bound(scope) else {
        return String::new();
    };

    let candidates = directions(&tenants, frontier, None, None);

    graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(
            sea_orm::Condition::all()
                .add(Expr::col(graph_node::Column::Id).in_subquery(candidates)),
        )
        .into_inner()
        .select_only()
        .column(graph_node::Column::Id)
        .into_query()
        .to_string(PostgresQueryBuilder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn sql() -> String {
        expand_frontier_pgq_sql(&AccessScope::for_tenant(Uuid::from_u128(0x1234)), &[5000])
    }

    /// The outer query must probe `graph_node` through a **single** semi-join.
    /// Both directions joined as `id IN (out) OR id IN (inc)` is logically the
    /// same and costs a sequential scan of the node table, because `PostgreSQL`
    /// cannot drive an index from two hashed subplans under an `OR`. See
    /// `dev/FINDINGS.md (F9)`.
    #[test]
    fn the_outer_query_probes_the_node_table_once() {
        let sql = sql();

        assert_eq!(
            sql.matches(" IN (SELECT ").count(),
            1,
            "the outer query must contain exactly one IN-subquery: {sql}"
        );
        assert!(
            sql.contains("UNION"),
            "the two directions were not unioned: {sql}"
        );
    }

    /// The outer query carries the caller's scope. It is what authorizes the
    /// candidates the pattern proposes, so losing it would turn the pattern's
    /// tenant bound into the only check — and the pattern cannot express a
    /// scope narrower than a tenant.
    #[test]
    fn the_outer_query_is_scoped() {
        let sql = sql();
        let outer_end = sql.find(" IN (SELECT ").unwrap_or(sql.len());

        assert!(
            sql[..outer_end].contains("\"graph_node\".\"tenant_id\""),
            "the outer query is unscoped: {sql}"
        );
    }

    /// Both directions reach the statement, each as its own pattern with its own
    /// alias. One alias for both would be a name collision, not a hop.
    #[test]
    fn both_directions_appear_with_distinct_aliases() {
        let sql = sql();

        assert!(
            sql.contains("(a IS node)-[e IS edge]->(b IS node)"),
            "{sql}"
        );
        assert!(
            sql.contains("(a IS node)<-[e IS edge]-(b IS node)"),
            "{sql}"
        );
        assert!(sql.contains(Direction::Outgoing.alias()), "{sql}");
        assert!(sql.contains(Direction::Incoming.alias()), "{sql}");
        assert_ne!(Direction::Outgoing.alias(), Direction::Incoming.alias());
    }

    /// A scope the pattern cannot bound renders nothing, so a caller that
    /// ignored the refusal still could not run an unbounded pattern.
    #[test]
    fn an_unbounded_scope_renders_no_statement() {
        assert!(expand_frontier_pgq_sql(&AccessScope::allow_all(), &[1]).is_empty());
    }
}
