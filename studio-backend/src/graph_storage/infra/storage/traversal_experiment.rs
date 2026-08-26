//! Reproduction of the single-statement traversal limitation.
//!
//! This module exists to keep the finding executable. It builds the hop the way
//! a gear would naturally write it — one scoped node query whose predicate
//! contains a subquery over the edge table — and demonstrates that the subquery
//! carries no tenant predicate.
//!
//! The outer query is scoped by the secure ORM. The inner one cannot be: the
//! only way to obtain a scope predicate as a reusable `Condition` is
//! `build_scope_condition`, which is `pub` inside the private module `cond`
//! (`libs/toolkit-db/src/secure/mod.rs:106`). A gear cannot name it.
//!
//! Because surrogate ids are allocated per tenant, `src_node_id = ANY($1)`
//! matches edges in every tenant that happens to have a node with that id, so
//! the walk follows foreign edges and reaches nodes that are not connected to
//! the seed in the caller's graph.

use sea_orm::sea_query::{Expr, ExprTrait, Query, SelectStatement};

use crate::graph_storage::infra::storage::entity::graph_edge;

/// Build the unscoped edge subquery a single-statement hop would need.
///
/// Returned for inspection by the finding test; it is deliberately not used by
/// the production traversal path.
#[must_use]
pub fn unscoped_edge_subquery(frontier: &[i64]) -> SelectStatement {
    Query::select()
        .column(graph_edge::Column::DstNodeId)
        .from(graph_edge::Entity)
        .and_where(Expr::col(graph_edge::Column::SrcNodeId).is_in(frontier.iter().copied()))
        .to_owned()
}

/// Render the subquery as `PostgreSQL` SQL, so a test can assert on its shape.
#[must_use]
pub fn unscoped_edge_subquery_sql(frontier: &[i64]) -> String {
    use sea_orm::sea_query::PostgresQueryBuilder;
    let (sql, _values) = unscoped_edge_subquery(frontier).build(PostgresQueryBuilder);
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The finding, pinned: a gear-built subquery over the edge table carries no
    /// tenant predicate, because the scope condition builder is unreachable from
    /// outside `toolkit-db`.
    ///
    /// If this assertion ever fails because the emitted SQL gained a tenant
    /// predicate, the scoped custom-query primitive has landed and the
    /// production traversal can collapse from two queries into one.
    #[test]
    fn gear_built_edge_subquery_has_no_tenant_predicate() {
        let sql = unscoped_edge_subquery_sql(&[1, 2, 3]);

        assert!(
            sql.contains("src_node_id"),
            "subquery should filter on the frontier: {sql}"
        );
        assert!(
            !sql.contains("tenant_id"),
            "a gear cannot scope a subquery today, yet this one is scoped: {sql}"
        );
    }
}
