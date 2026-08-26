//! Deletions.
//!
//! A graph that mirrors an external source has to be able to forget. Every
//! deletion here goes through the secure ORM, so a caller can only remove what
//! their scope already lets them see.
//!
//! ## Why edges go first
//!
//! The endpoint foreign keys are `RESTRICT`, deliberately: removing a static
//! node must not silently destroy analysis edges attached to it. That makes
//! "delete this node" a two-step operation — detach its incident edges, then
//! remove the node — and both steps have to be in one transaction or a failure
//! leaves a node with half its edges. The caller supplies the transaction.

use sea_orm::{ColumnTrait, Condition, EntityTrait};
use toolkit_db::secure::{AccessScope, DBRunner, SecureDeleteExt, SecureEntityExt};

use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::entity::{graph_edge, graph_node};

fn storage_err(e: impl std::fmt::Display) -> DomainError {
    DomainError::Storage(e.to_string())
}

/// How many nodes and edges a deletion removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Removed {
    /// Nodes removed.
    pub nodes: u64,
    /// Edges removed, including those detached to make the node removable.
    pub edges: u64,
}

/// Remove the edges incident to any of `node_ids`, in either direction.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the delete fails.
pub async fn delete_incident_edges<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    node_ids: &[i64],
) -> Result<u64, DomainError> {
    if node_ids.is_empty() {
        return Ok(0);
    }
    let result = graph_edge::Entity::delete_many()
        .secure()
        .scope_with(scope)
        .filter(
            Condition::any()
                .add(graph_edge::Column::SrcNodeId.is_in(node_ids.iter().copied()))
                .add(graph_edge::Column::DstNodeId.is_in(node_ids.iter().copied())),
        )
        .exec(conn)
        .await
        .map_err(storage_err)?;
    Ok(result.rows_affected)
}

/// Remove one edge by its surrogate id.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the delete fails.
pub async fn delete_edge<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    edge_id: i64,
) -> Result<u64, DomainError> {
    let result = graph_edge::Entity::delete_many()
        .secure()
        .scope_with(scope)
        .filter(Condition::all().add(graph_edge::Column::Id.eq(edge_id)))
        .exec(conn)
        .await
        .map_err(storage_err)?;
    Ok(result.rows_affected)
}

/// Remove the nodes with the given ids, and the edges incident to them.
///
/// # Errors
/// Returns [`DomainError::Storage`] when either delete fails.
pub async fn delete_nodes<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    node_ids: &[i64],
) -> Result<Removed, DomainError> {
    if node_ids.is_empty() {
        return Ok(Removed::default());
    }

    let edges = delete_incident_edges(conn, scope, node_ids).await?;

    let result = graph_node::Entity::delete_many()
        .secure()
        .scope_with(scope)
        .filter(Condition::all().add(graph_node::Column::Id.is_in(node_ids.iter().copied())))
        .exec(conn)
        .await
        .map_err(storage_err)?;

    Ok(Removed {
        nodes: result.rows_affected,
        edges,
    })
}

/// Which nodes a prune selects, already resolved against the store.
#[derive(Debug, Clone, Default)]
pub struct PruneFilter {
    /// Interned type id.
    pub type_id: Option<i32>,
    /// Prefix the node key must start with.
    pub node_key_prefix: Option<String>,
    /// Only nodes whose `updated_at` is strictly older than this.
    pub not_seen_since: Option<time::OffsetDateTime>,
}

impl PruneFilter {
    /// Whether any filter is set. A prune with none would take the whole graph.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.type_id.is_none() && self.node_key_prefix.is_none() && self.not_seen_since.is_none()
    }
}

/// Ids of the nodes a prune would remove.
///
/// Resolved to ids first rather than deleted in one statement, because the
/// incident edges have to be detached by id and the two deletes must agree on
/// exactly the same set.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn prune_candidates<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    filter: &PruneFilter,
    limit: u64,
) -> Result<Vec<i64>, DomainError> {
    use sea_orm::{FromQueryResult, QuerySelect};

    #[derive(FromQueryResult)]
    struct NodeId {
        id: i64,
    }

    let mut cond = Condition::all();
    if let Some(type_id) = filter.type_id {
        cond = cond.add(graph_node::Column::TypeId.eq(type_id));
    }
    if let Some(prefix) = &filter.node_key_prefix {
        cond = cond.add(graph_node::Column::NodeKey.starts_with(prefix.as_str()));
    }
    if let Some(cutoff) = filter.not_seen_since {
        cond = cond.add(graph_node::Column::UpdatedAt.lt(cutoff));
    }

    let rows: Vec<NodeId> = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(cond)
        .project_all(conn, move |q| {
            q.select_only()
                .column(graph_node::Column::Id)
                .limit(limit)
                .into_model::<NodeId>()
        })
        .await
        .map_err(storage_err)?;

    Ok(rows.into_iter().map(|r| r.id).collect())
}

/// Ids of the nodes carrying the given keys.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn node_ids_for_keys<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    keys: &[String],
) -> Result<Vec<i64>, DomainError> {
    use sea_orm::{FromQueryResult, QuerySelect};

    #[derive(FromQueryResult)]
    struct NodeId {
        id: i64,
    }

    if keys.is_empty() {
        return Ok(Vec::new());
    }

    let rows: Vec<NodeId> = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(Condition::all().add(graph_node::Column::NodeKey.is_in(keys.iter().cloned())))
        .project_all(conn, |q| {
            q.select_only()
                .column(graph_node::Column::Id)
                .into_model::<NodeId>()
        })
        .await
        .map_err(storage_err)?;

    Ok(rows.into_iter().map(|r| r.id).collect())
}

/// Read the tenant's current write counter without changing it.
///
/// A tenant that has never been written has no row; that is revision zero.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the query fails.
pub async fn current_revision<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
) -> Result<u64, DomainError> {
    use crate::graph_storage::infra::storage::entity::graph_revision;

    let row = graph_revision::Entity::find()
        .secure()
        .scope_with(scope)
        .one(conn)
        .await
        .map_err(storage_err)?;

    Ok(row.map_or(0, |r| u64::try_from(r.revision).unwrap_or(0)))
}
