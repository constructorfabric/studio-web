//! One breadth-first hop over the edge table, fully scoped.
//!
//! # Why this is two queries rather than one
//!
//! The natural single-statement shape is a scoped node query whose predicate
//! contains a subquery over the edge table:
//!
//! ```sql
//! SELECT n.id FROM graph_node n
//! WHERE <node scope> AND n.id IN (SELECT dst_node_id FROM graph_edge WHERE src_node_id = ANY($1))
//! ```
//!
//! A gear can build that with `sea_query`, but it cannot scope the subquery:
//! `build_scope_condition` is `pub` inside a private module
//! (`libs/toolkit-db/src/secure/mod.rs:106` declares `mod cond;`), so the scope
//! predicate is unobtainable outside `toolkit-db`. An unscoped edge subquery is
//! not merely imprecise — surrogate ids are per-tenant, so `src_node_id = 1`
//! matches an edge in every tenant that has a node 1, and the walk would follow
//! foreign edges. See `dev/FINDINGS.md (F1)`.
//!
//! Until a scoped custom-query primitive exists, each hop therefore runs two
//! scoped queries: edges first, then the authorised endpoints. Both go through
//! the secure ORM, so the tenant predicate is applied by construction.

use sea_orm::{ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QuerySelect};
use toolkit_db::secure::{AccessScope, DBRunner, SecureEntityExt};

use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::entity::{graph_edge, graph_node};

#[derive(Debug, FromQueryResult)]
struct EdgeEndpoints {
    src_node_id: i64,
    dst_node_id: i64,
}

#[derive(Debug, FromQueryResult)]
struct NodeId {
    id: i64,
}

/// The caller's scope projected onto the tenant dimension, for use on the edge
/// table.
///
/// # Why the edge table must not carry the whole scope
///
/// `graph_node` and `graph_edge` both map the `id` resource property to their
/// own primary key, so a scope naming node identifiers filters *edges by edge
/// id* — and a scope naming edge identifiers filters *nodes by node id* on the
/// second query. One resource list cannot satisfy both tables, so applying the
/// whole scope to both makes every resource-narrowed request return nothing.
/// Measured on the stand: a scope of ten node ids returned an empty hop where
/// two of the seed's neighbours were authorised.
///
/// # Why widening here is safe
///
/// The edge query contributes candidate identifiers, nothing else — the hop
/// reads `src_node_id` and `dst_node_id` and no other column. Those candidates
/// are then authorised by the node query under the caller's **whole** scope, so
/// a node the caller may not see cannot survive. This is the same split the
/// SQL/PGQ backend makes for the same reason: authorise where the identifiers
/// mean what the scope says they mean.
///
/// Tenant filters are kept as they are, including `InTenantSubtree`, which the
/// edge table can express because it carries `tenant_id`. A constraint with no
/// tenant filter at all bounds nothing here; because constraints are OR-ed, one
/// such constraint makes the projection unbounded.
fn edge_scope(scope: &AccessScope) -> AccessScope {
    use toolkit_security::access_scope::{ScopeConstraint, pep_properties};

    if scope.is_deny_all() {
        return AccessScope::deny_all();
    }
    if scope.is_unconstrained() {
        return AccessScope::allow_all();
    }

    let mut constraints = Vec::new();
    for constraint in scope.constraints() {
        let tenant_filters: Vec<_> = constraint
            .filters()
            .iter()
            .filter(|f| f.property() == pep_properties::OWNER_TENANT_ID)
            .cloned()
            .collect();
        if tenant_filters.is_empty() {
            return AccessScope::allow_all();
        }
        constraints.push(ScopeConstraint::new(tenant_filters));
    }
    AccessScope::from_constraints(constraints)
}

/// Whether every filter in `scope` is on the tenant property.
///
/// The CTE hop cannot serve a scope for which this is false. Its edge query is
/// a CTE body, and the safe-CTE API scopes every body with the outer query's
/// own `AccessScope` by construction — that is what makes mixing scopes in one
/// statement unrepresentable. The two-query hop projects the scope for its edge
/// query ([`edge_scope`]); a CTE body has no equivalent, so a resource-narrowed
/// scope filters edges by edge id and the hop returns nothing.
///
/// The port checks this and serves such requests on the two-query hop.
#[must_use]
pub fn is_tenant_only(scope: &AccessScope) -> bool {
    use toolkit_security::access_scope::pep_properties;

    scope.is_deny_all()
        || scope.is_unconstrained()
        || scope.constraints().iter().all(|constraint| {
            constraint
                .filters()
                .iter()
                .all(|f| f.property() == pep_properties::OWNER_TENANT_ID)
        })
}

/// Return the node ids one undirected hop away from `frontier`.
///
/// Edges are traversed in both directions. Only endpoints the caller is
/// authorised to see are returned, so the result can be used directly as the
/// next frontier: the walk never crosses a node outside the caller's scope.
///
/// # Errors
/// Returns [`DomainError::Storage`] when either query fails.
pub async fn expand_frontier<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    frontier: &[i64],
    edge_type_ids: Option<&[i32]>,
    outgoing: Option<bool>,
) -> Result<Vec<i64>, DomainError> {
    if frontier.is_empty() {
        return Ok(Vec::new());
    }

    // 1. Scoped edge query: the edges incident to the frontier on the side the
    //    caller asked for.
    let mut incident = match outgoing {
        Some(true) => sea_orm::Condition::any()
            .add(graph_edge::Column::SrcNodeId.is_in(frontier.iter().copied())),
        Some(false) => sea_orm::Condition::any()
            .add(graph_edge::Column::DstNodeId.is_in(frontier.iter().copied())),
        None => sea_orm::Condition::any()
            .add(graph_edge::Column::SrcNodeId.is_in(frontier.iter().copied()))
            .add(graph_edge::Column::DstNodeId.is_in(frontier.iter().copied())),
    };
    if let Some(types) = edge_type_ids {
        incident = sea_orm::Condition::all()
            .add(incident)
            .add(graph_edge::Column::TypeId.is_in(types.iter().copied()));
    }

    let endpoints: Vec<EdgeEndpoints> = graph_edge::Entity::find()
        .secure()
        .scope_with(&edge_scope(scope))
        .filter(incident)
        .project_all(conn, |q| {
            q.select_only()
                .column(graph_edge::Column::SrcNodeId)
                .column(graph_edge::Column::DstNodeId)
                .into_model::<EdgeEndpoints>()
        })
        .await
        .map_err(|e| DomainError::Storage(e.to_string()))?;

    // 2. The endpoint on the far side of each incident edge.
    // A directed walk takes only the far side of the side it matched on.
    // Without this the query above would be narrowed correctly and the step
    // below would widen it again: an edge matched as outgoing whose *source*
    // also happens to be a frontier node would contribute both endpoints.
    let take_forward = outgoing != Some(false);
    let take_backward = outgoing != Some(true);
    let mut candidates: Vec<i64> = Vec::with_capacity(endpoints.len());
    for e in endpoints {
        if take_forward && frontier.contains(&e.src_node_id) {
            candidates.push(e.dst_node_id);
        }
        if take_backward && frontier.contains(&e.dst_node_id) {
            candidates.push(e.src_node_id);
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // 3. Scoped node query: keep only endpoints the caller may see.
    let mut authorised: Vec<i64> = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(sea_orm::Condition::all().add(graph_node::Column::Id.is_in(candidates)))
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

/// The endpoint on the far side of each incident edge, as one subquery over the
/// attached CTE.
///
/// Each leg carries the frontier predicate on the **opposite** column, which is
/// what makes this a hop rather than a neighbourhood: selecting both columns
/// unconditionally would return the frontier itself alongside its neighbours,
/// because every frontier node is an endpoint of its own incident edges. The
/// two-query hop has always worked this way; the CTE hop did not, and the
/// difference was invisible end to end because the traversal service filters
/// already-visited ids anyway. See `dev/FINDINGS.md (F15)`.
///
/// A frontier node still comes back when it is genuinely adjacent to another
/// frontier node, which is the correct answer and what the two-query hop does.
fn far_endpoints(frontier: &[i64], outgoing: Option<bool>) -> sea_orm::sea_query::SelectStatement {
    use sea_orm::sea_query::{Alias, Expr, ExprTrait, Query};

    let leg = |select: &str, matched: &str| {
        Query::select()
            .column(Alias::new(select))
            .from(Alias::new("scoped_edges"))
            .and_where(Expr::col(Alias::new(matched)).is_in(frontier.iter().copied()))
            .to_owned()
    };

    // Each leg selects the endpoint opposite the column it matched on, so a
    // one-directional walk is exactly one leg.
    match outgoing {
        Some(true) => leg("dst_node_id", "src_node_id"),
        Some(false) => leg("src_node_id", "dst_node_id"),
        None => leg("dst_node_id", "src_node_id")
            .union(
                sea_orm::sea_query::UnionType::Distinct,
                leg("src_node_id", "dst_node_id"),
            )
            .to_owned(),
    }
}

/// Single-statement variant of [`expand_frontier`], using a scoped CTE.
///
/// Both the CTE body and the outer query carry the caller's scope, so the
/// tenant predicate is present on the edge table and on the node table in one
/// statement. This is what the two-query hop collapses into once `toolkit-db`
/// exposes safe CTEs; it exists here to measure the difference.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn expand_frontier_cte<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    frontier: &[i64],
    edge_type_ids: Option<&[i32]>,
    outgoing: Option<bool>,
) -> Result<Vec<i64>, DomainError> {
    use sea_orm::sea_query::{Expr, ExprTrait};

    if frontier.is_empty() {
        return Ok(Vec::new());
    }

    let mut incident = match outgoing {
        Some(true) => sea_orm::Condition::any()
            .add(graph_edge::Column::SrcNodeId.is_in(frontier.iter().copied())),
        Some(false) => sea_orm::Condition::any()
            .add(graph_edge::Column::DstNodeId.is_in(frontier.iter().copied())),
        None => sea_orm::Condition::any()
            .add(graph_edge::Column::SrcNodeId.is_in(frontier.iter().copied()))
            .add(graph_edge::Column::DstNodeId.is_in(frontier.iter().copied())),
    };
    if let Some(types) = edge_type_ids {
        incident = sea_orm::Condition::all()
            .add(incident)
            .add(graph_edge::Column::TypeId.is_in(types.iter().copied()));
    }

    let mut ids: Vec<i64> =
        graph_node::Entity::find()
            .secure()
            .scope_with(scope)
            // The body is projected because a CTE referenced twice is materialised,
            // and the edge table carries a jsonb payload the hop never reads.
            .with_ctes()
            .cte::<graph_edge::Entity>("scoped_edges", |q| {
                q.select_only()
                    .column(graph_edge::Column::SrcNodeId)
                    .column(graph_edge::Column::DstNodeId)
                    .filter(incident)
            })
            // One `IN` over the union of both legs, not two `IN`s joined by `OR`:
            // the `OR` form costs a sequential scan of `graph_node`
            // (`dev/FINDINGS.md (F9)`).
            .filter(sea_orm::Condition::all().add(
                Expr::col(graph_node::Column::Id).in_subquery(far_endpoints(frontier, outgoing)),
            ))
            .select_only()
            .column(graph_node::Column::Id)
            .all_as::<NodeId>(conn)
            .await
            .map_err(|e| DomainError::Storage(e.to_string()))?
            .into_iter()
            .map(|n| n.id)
            .collect();

    ids.sort_unstable();
    Ok(ids)
}

#[cfg(test)]
mod cte_tests {
    use super::*;

    /// The hop must probe `graph_node` through a **single** semi-join. Two `IN`
    /// subqueries joined by `OR` are logically equivalent and make `PostgreSQL`
    /// sequentially scan the node table — 15.2 ms against 0.30 ms on the stand —
    /// so the shape is load-bearing, not stylistic. See `dev/FINDINGS.md (F9)`.
    ///
    /// Asserted on [`far_endpoints`] rather than on the whole statement, because
    /// `SecureCteSelect::build_statement` is `pub(crate)` in `toolkit-db`: a gear
    /// cannot render a CTE query without executing it. The invariants that live
    /// inside the statement — the scope predicate in every CTE body, the `WITH`
    /// clause surviving into execution — are tested there instead, and the
    /// behaviour they produce is covered by the cross-backend parity suite.
    #[test]
    fn the_candidate_subquery_is_one_union_not_two_predicates() {
        use sea_orm::sea_query::PostgresQueryBuilder;

        let sql = far_endpoints(&[1, 2, 3], None).to_string(PostgresQueryBuilder);

        assert!(
            sql.contains("UNION"),
            "the two legs were not unioned: {sql}"
        );
        assert_eq!(
            sql.matches("SELECT").count(),
            2,
            "expected exactly two legs: {sql}"
        );
    }

    /// Each leg matches the frontier on the column **opposite** the one it
    /// selects. Selecting both endpoint columns unconditionally returns the
    /// frontier alongside its neighbours, which is the defect the parity suite
    /// caught (`dev/FINDINGS.md (F15)`).
    #[test]
    fn each_leg_matches_on_the_opposite_column() {
        use sea_orm::sea_query::PostgresQueryBuilder;

        let sql = far_endpoints(&[7], None).to_string(PostgresQueryBuilder);

        assert!(
            sql.contains(r#"SELECT "dst_node_id" FROM "scoped_edges" WHERE "src_node_id" IN"#),
            "the outgoing leg does not match on the source column: {sql}"
        );
        assert!(
            sql.contains(r#"SELECT "src_node_id" FROM "scoped_edges" WHERE "dst_node_id" IN"#),
            "the incoming leg does not match on the destination column: {sql}"
        );
    }
}
