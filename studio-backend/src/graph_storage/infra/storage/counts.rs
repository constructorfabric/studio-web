//! Scoped counting queries.
//!
//! Every read goes through the secure ORM: `.secure()` yields a query that
//! cannot be executed until `.scope_with()` has been applied, so a missing
//! tenant predicate is a compile error rather than a review finding.

use toolkit_db::secure::{DBRunner, SecureEntityExt};
use toolkit_security::AccessScope;

use crate::graph_storage::sdk::GraphStats;
use sea_orm::EntityTrait;

use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::entity::{graph_edge, graph_node};
use crate::graph_storage::infra::storage::mutate;

/// Count the nodes and edges visible under `scope`.
///
/// # Errors
/// Returns [`DomainError::Storage`] when either count fails.
pub async fn graph_stats<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
) -> Result<GraphStats, DomainError> {
    let nodes = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .count(conn)
        .await
        .map_err(|e| DomainError::Storage(e.to_string()))?;

    let edges = graph_edge::Entity::find()
        .secure()
        .scope_with(scope)
        .count(conn)
        .await
        .map_err(|e| DomainError::Storage(e.to_string()))?;

    // Read, never derived from `max(updated_at)`: a deletion lowers that
    // maximum and would make the revision go backwards.
    let graph_revision = mutate::current_revision(conn, scope).await?;

    Ok(GraphStats {
        nodes,
        edges,
        graph_revision,
    })
}
