//! Batch writes through the secure ORM.
//!
//! Ids come from database sequences, so a batch never reserves a range and
//! never reads back before writing. Conflicts resolve on the tenant-scoped
//! natural keys (`node_key`, `edge_key`), which is what makes a repeated batch
//! converge instead of duplicating.
//!
//! `SecureInsertMany` cannot validate rows against the scope one by one, so it
//! exposes `scope_unchecked`. The rows here are built by the caller with the
//! tenant of the security context, and every read path that observes them is
//! scoped, so the invariant holds — but it is worth naming: on the write side
//! the tenant column is set by this layer, not enforced by the compiler.
//!
//! ## Counts
//!
//! The upserts report what the statement's `RETURNING` clause produced, which is
//! the rows the database inserted or updated. For nodes the conflict action is
//! `DO UPDATE` and fires on every conflicting row, so a re-ingest of unchanged
//! nodes still counts them; for edges it is `DO NOTHING`, so only genuinely new
//! edges are counted. Neither is a change feed — `graph_revision` is what a
//! consumer polls to learn that something moved.

use sea_orm::entity::prelude::PgVector;
use sea_orm::sea_query::{Alias, Expr, ExprTrait, OnConflict};
use sea_orm::{ActiveValue::Set, DbErr, EntityTrait};
use serde_json::Value;
use time::OffsetDateTime;
use toolkit_db::secure::{AccessScope, DBRunner, ScopeError, SecureInsertManyExt};
use uuid::Uuid;

use crate::graph_storage::domain::error::DomainError;
use crate::graph_storage::infra::storage::entity::{
    graph_edge, graph_node, graph_revision, graph_type,
};

fn storage_err(e: impl std::fmt::Display) -> DomainError {
    DomainError::Storage(e.to_string())
}

/// Treat "the conflict clause matched every row" as success.
///
/// `ON CONFLICT DO NOTHING` that skips every row inserts nothing, and `SeaORM`
/// reports that as [`DbErr::RecordNotInserted`]. For an upsert keyed on a
/// natural key it is the success case, not a failure: the rows are already
/// there, which is exactly what the caller asked for. Without this, registering
/// an already-registered type answers 500, and re-ingesting an unchanged batch
/// of edges fails — which contradicts the convergence this module's own module
/// comment promises.
fn tolerate_nothing_inserted<T>(result: Result<T, ScopeError>) -> Result<Option<T>, DomainError> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(ScopeError::Db(DbErr::RecordNotInserted)) => Ok(None),
        Err(e) => Err(storage_err(e)),
    }
}

/// One node ready to write, with its type already interned.
#[derive(Debug, Clone)]
pub struct NodeRow {
    /// Tenant-scoped natural key.
    pub node_key: String,
    /// Interned type id.
    pub type_id: i32,
    /// Display name.
    pub name: String,
    /// Composed lexical-search text.
    pub search_text: String,
    /// Attributes; `None` leaves whatever is stored alone.
    pub payload: Option<Value>,
    /// Embedding of `search_text`; `None` leaves whatever is stored alone.
    pub embedding: Option<Vec<f32>>,
}

/// One edge ready to write, with its type interned and endpoints resolved.
#[derive(Debug, Clone)]
pub struct EdgeRow {
    /// Derived, tenant-scoped natural key.
    pub edge_key: String,
    /// Interned type id.
    pub type_id: i32,
    /// Source node id.
    pub src: i64,
    /// Destination node id.
    pub dst: i64,
    /// Attributes; `None` stores an empty object on insert.
    pub payload: Option<Value>,
}

/// Upsert a GTS type and return its interned id.
///
/// Idempotent: an already-registered type keeps its id. When `json_schema` is
/// supplied it replaces the stored one, which is how a type gains a schema
/// after the fact.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the write or the read-back fails.
pub async fn upsert_type<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    tenant: Uuid,
    type_id: &str,
    kind: &str,
    json_schema: Option<&Value>,
) -> Result<i32, DomainError> {
    // Deterministic rather than random, matching what the column's own
    // documentation says it holds: the same GTS identifier always interns to
    // the same UUID, so a retry cannot manufacture a second identity for one
    // type.
    let type_uuid = Uuid::new_v5(&Uuid::NAMESPACE_URL, type_id.as_bytes());

    let row = graph_type::ActiveModel {
        tenant_id: Set(tenant),
        type_uuid: Set(type_uuid),
        type_id: Set(type_id.to_owned()),
        kind: Set(kind.to_owned()),
        json_schema: Set(json_schema
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}))),
        created_at: Set(OffsetDateTime::now_utc()),
        ..Default::default()
    };

    let mut conflict =
        OnConflict::columns([graph_type::Column::TenantId, graph_type::Column::TypeId]);
    if json_schema.is_some() {
        conflict.update_columns([graph_type::Column::JsonSchema]);
    } else {
        conflict.do_nothing();
    }

    let inserted = graph_type::Entity::insert_many([row])
        .secure()
        .scope_unchecked(scope)
        .map_err(storage_err)?
        .on_conflict_raw(conflict.to_owned())
        .exec(conn)
        .await;
    tolerate_nothing_inserted(inserted)?;

    interned_type_id(conn, scope, type_id).await
}

/// Look up the interned id of an already registered type.
///
/// # Errors
/// Returns [`DomainError::UnknownType`] when the type is not registered.
pub async fn interned_type_id<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    type_id: &str,
) -> Result<i32, DomainError> {
    use sea_orm::{ColumnTrait, Condition};
    use toolkit_db::secure::SecureEntityExt;

    let found = graph_type::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(Condition::all().add(graph_type::Column::TypeId.eq(type_id)))
        .one(conn)
        .await
        .map_err(storage_err)?;

    found
        .map(|t| t.id)
        .ok_or_else(|| DomainError::UnknownType(type_id.to_owned()))
}

/// Upsert nodes by their tenant-scoped natural key.
///
/// Returns the number of rows the statement inserted or updated.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the write fails.
pub async fn upsert_nodes<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    tenant: Uuid,
    rows: Vec<NodeRow>,
) -> Result<u64, DomainError> {
    if rows.is_empty() {
        return Ok(0);
    }
    let now = OffsetDateTime::now_utc();

    // Whether the batch carries attributes and embeddings at all decides the
    // conflict action: a batch that supplies none must not overwrite stored
    // ones with the empty defaults it had to put in the INSERT.
    let any_payload = rows.iter().any(|r| r.payload.is_some());
    let any_embedding = rows.iter().any(|r| r.embedding.is_some());

    let models: Vec<graph_node::ActiveModel> = rows
        .into_iter()
        .map(|r| graph_node::ActiveModel {
            tenant_id: Set(tenant),
            node_key: Set(r.node_key),
            type_id: Set(r.type_id),
            name: Set(r.name),
            payload: Set(r.payload.unwrap_or_else(|| serde_json::json!({}))),
            search_text: Set(r.search_text),
            embedding: Set(r.embedding.map(PgVector::from)),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .collect();

    let mut conflict =
        OnConflict::columns([graph_node::Column::TenantId, graph_node::Column::NodeKey]);
    conflict.update_columns([
        graph_node::Column::Name,
        graph_node::Column::TypeId,
        graph_node::Column::SearchText,
        graph_node::Column::UpdatedAt,
    ]);
    if any_payload {
        conflict.update_columns([graph_node::Column::Payload]);
    }
    if any_embedding {
        conflict.update_columns([graph_node::Column::Embedding]);
    }

    let written = graph_node::Entity::insert_many(models)
        .secure()
        .scope_unchecked(scope)
        .map_err(storage_err)?
        .on_conflict_raw(conflict.to_owned())
        .exec_with_returning(conn)
        .await
        .map_err(storage_err)?;

    Ok(written.len() as u64)
}

/// Resolve node keys to their surrogate ids, scoped to the caller.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the lookup fails.
pub async fn resolve_node_ids<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    keys: &[String],
) -> Result<std::collections::HashMap<String, i64>, DomainError> {
    use sea_orm::{ColumnTrait, Condition, FromQueryResult, QuerySelect};
    use toolkit_db::secure::SecureEntityExt;

    #[derive(FromQueryResult)]
    struct KeyId {
        node_key: String,
        id: i64,
    }

    if keys.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    // Projected rather than fetching whole models: the node row now carries an
    // embedding, and pulling a 384-float vector per endpoint to read two
    // columns would make every ingest pay for it.
    let found: Vec<KeyId> = graph_node::Entity::find()
        .secure()
        .scope_with(scope)
        .filter(Condition::all().add(graph_node::Column::NodeKey.is_in(keys.iter().cloned())))
        .project_all(conn, |q| {
            q.select_only()
                .column(graph_node::Column::NodeKey)
                .column(graph_node::Column::Id)
                .into_model::<KeyId>()
        })
        .await
        .map_err(storage_err)?;

    Ok(found.into_iter().map(|n| (n.node_key, n.id)).collect())
}

/// Upsert edges by their derived, tenant-scoped edge key.
///
/// Returns the number of rows the statement inserted. The conflict action is
/// `DO NOTHING`, so an edge that already exists is not counted — re-ingesting
/// an unchanged batch answers zero.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the write fails.
pub async fn upsert_edges<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    tenant: Uuid,
    rows: Vec<EdgeRow>,
) -> Result<u64, DomainError> {
    if rows.is_empty() {
        return Ok(0);
    }
    let now = OffsetDateTime::now_utc();
    let any_payload = rows.iter().any(|r| r.payload.is_some());

    let models: Vec<graph_edge::ActiveModel> = rows
        .into_iter()
        .map(|r| graph_edge::ActiveModel {
            tenant_id: Set(tenant),
            edge_key: Set(r.edge_key),
            type_id: Set(r.type_id),
            src_node_id: Set(r.src),
            dst_node_id: Set(r.dst),
            payload: Set(r.payload.unwrap_or_else(|| serde_json::json!({}))),
            created_at: Set(now),
            ..Default::default()
        })
        .collect();

    let mut conflict =
        OnConflict::columns([graph_edge::Column::TenantId, graph_edge::Column::EdgeKey]);
    // An edge's identity is its endpoints and type, all of which are in the
    // key — so there is nothing to update unless the caller sent attributes.
    if any_payload {
        conflict.update_columns([graph_edge::Column::Payload]);
    } else {
        conflict.do_nothing();
    }

    let written = graph_edge::Entity::insert_many(models)
        .secure()
        .scope_unchecked(scope)
        .map_err(storage_err)?
        .on_conflict_raw(conflict.to_owned())
        .exec_with_returning(conn)
        .await;

    Ok(tolerate_nothing_inserted(written)?.map_or(0, |rows| rows.len() as u64))
}

/// Bump the tenant's write counter and return its new value.
///
/// Called inside the same transaction as the write it describes, so a revision
/// a caller has observed always corresponds to committed data.
///
/// # Errors
/// Returns [`DomainError::Storage`] when the write fails.
pub async fn bump_revision<C: DBRunner>(
    conn: &C,
    scope: &AccessScope,
    tenant: Uuid,
) -> Result<u64, DomainError> {
    let row = graph_revision::ActiveModel {
        tenant_id: Set(tenant),
        revision: Set(1),
        updated_at: Set(OffsetDateTime::now_utc()),
    };

    let written = graph_revision::Entity::insert_many([row])
        .secure()
        .scope_unchecked(scope)
        .map_err(storage_err)?
        .on_conflict_raw(
            OnConflict::column(graph_revision::Column::TenantId)
                // Qualified with the table name on purpose: unqualified inside
                // `DO UPDATE` it would be ambiguous with `excluded`, which
                // always carries the literal 1 from the INSERT above.
                .value(
                    graph_revision::Column::Revision,
                    Expr::col((Alias::new("graph_revision"), Alias::new("revision"))).add(1),
                )
                .value(graph_revision::Column::UpdatedAt, Expr::current_timestamp())
                .to_owned(),
        )
        .exec_with_returning(conn)
        .await
        .map_err(storage_err)?;

    Ok(written
        .first()
        .map_or(0, |r| u64::try_from(r.revision).unwrap_or(0)))
}
