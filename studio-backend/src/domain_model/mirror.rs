//! The domain read model: every live domain object and relation as Postgres
//! rows, so a query is answered by index instead of by reading a type into
//! memory (ADR-0051).
//!
//! ── Why this exists ──────────────────────────────────────────────────────────
//!
//! `POST /query` read at most 5 000 objects of a type out of the graph and
//! filtered, ordered, counted and paged them in the gear, because
//! graph-storage cannot filter on a payload path a type did not declare at
//! its first registration, and has no count, no offset and no traversal
//! direction (`docs/upstream/graph-storage-requests.md`, items 5, 6, 8, 9,
//! 10). Here the same question is one SQL statement, and a relation is read
//! from either end by index.
//!
//! ── How it stays true ────────────────────────────────────────────────────────
//!
//! The graph stays the source of truth. Every domain write goes through
//! [`IndexedDomainStore`], which changes the graph first and then the rows.
//! A tenant is served from here only once a fill has copied its graph in and
//! written its `studio_domain_fill` row; until then, or after a write the rows
//! could not follow, queries read the graph exactly as before and a fill runs
//! in the background. This is the artifact index's protocol
//! (`artifact_ingest/index.rs`), for the same reasons.
//!
//! Only live objects have rows: a write that marks an object deleted
//! ([`super::store::DELETED_FIELD`]) removes its row.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, IntoActiveModel,
    Order, QuerySelect,
};
use serde_json::Value;
use toolkit_db::Db;
use toolkit_db::secure::{
    ScopeError, SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureInsertManyExt,
    SecureOnConflict,
};
use toolkit_security::{AccessScope, SecurityContext};
use tracing::{info, warn};
use uuid::Uuid;

use super::entity::{edge, fill, object};
use super::gts;
use super::ontology::{EdgeType, NodeType, Ontology};
use super::store::{
    DomainStore, EdgeUpsert, EdgeView, Hop, Neighbourhood, NodeUpsert, ObjectNode, is_live,
};

/// Rows per insert statement, under Postgres's 65 535 bound parameters.
const ROWS_PER_STATEMENT: usize = 500;
/// Ids per `IN (…)` list.
const IDS_PER_STATEMENT: usize = 1_000;
/// How long a tenant whose fill failed waits before a read retries it.
const FILL_RETRY_AFTER: Duration = Duration::from_secs(60);

const OBJECT_TYPE_PREFIX: &str = "gts.cf.studio.domain.";
const RELATION_TYPE_PREFIX: &str = "gts.cf.studio.domainrel.";

/// A domain object's node type, not the meta layer's.
fn is_object_type(type_id: &str) -> bool {
    type_id.starts_with(OBJECT_TYPE_PREFIX)
}

/// A relation between objects, not a meta edge.
fn is_relation_type(type_id: &str) -> bool {
    type_id.starts_with(RELATION_TYPE_PREFIX)
}

/// The root of a query, compiled: what the SQL executor asks for.
pub struct RootSelect {
    pub type_ids: Vec<String>,
    /// `_scope` equality, as `GET /objects?scope=` has it.
    pub scope: Option<String>,
    pub filter: Option<Condition>,
    /// Sort keys in order; the executor appends the id tie-break.
    pub order: Vec<(Expr, Order)>,
    /// The owners the caller may read; `None` is everything in the tenant.
    pub owners: Option<Vec<Uuid>>,
}

/// One group of an aggregate: the grouping values in order, and how many.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub key: Vec<Value>,
    pub count: u64,
}

#[derive(Debug, FromQueryResult)]
struct OwnerRow {
    owner_id: Uuid,
}

#[derive(Debug, FromQueryResult)]
struct TypeCountRow {
    type_id: String,
    n: i64,
}

#[derive(Debug, FromQueryResult)]
struct GroupRow {
    key: Value,
    n: i64,
}

/// The Postgres half: rows in, answers out. Knows nothing about the graph.
pub struct DomainMirror {
    db: Db,
}

impl DomainMirror {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    async fn is_filled(&self, tenant: Uuid) -> anyhow::Result<bool> {
        let conn = self.db.conn()?;
        Ok(fill::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .one(&conn)
            .await?
            .is_some())
    }

    async fn unfill(&self, tenant: Uuid) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        fill::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn mark_filled(&self, tenant: Uuid, objects: usize, edges: usize) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        let row = fill::ActiveModel {
            tenant_id: ActiveValue::Set(tenant),
            filled_at_ms: ActiveValue::Set(now_ms()),
            objects: ActiveValue::Set(i64::try_from(objects).unwrap_or(i64::MAX)),
            edges: ActiveValue::Set(i64::try_from(edges).unwrap_or(i64::MAX)),
        };
        let on_conflict = SecureOnConflict::<fill::Entity>::columns([fill::Column::TenantId])
            .update_columns([
                fill::Column::FilledAtMs,
                fill::Column::Objects,
                fill::Column::Edges,
            ])?;
        fill::Entity::insert(row)
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(tenant))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Drop every row of a tenant: the first step of a fill.
    async fn clear(&self, tenant: Uuid) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        object::Entity::delete_many()
            .secure()
            .scope_with(&scope)
            .exec(&conn)
            .await?;
        edge::Entity::delete_many()
            .secure()
            .scope_with(&scope)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Upsert object rows. `replace` false is the fill's `DO NOTHING`: a row a
    /// concurrent write put there is at least as new as what the fill read.
    async fn write_objects(
        &self,
        tenant: Uuid,
        rows: Vec<object::Model>,
        replace: bool,
    ) -> anyhow::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        for chunk in rows.chunks(ROWS_PER_STATEMENT) {
            let on_conflict = SecureOnConflict::<object::Entity>::columns([
                object::Column::TenantId,
                object::Column::InstanceId,
            ]);
            let on_conflict = if replace {
                on_conflict.update_columns([
                    object::Column::TypeId,
                    object::Column::OwnerId,
                    object::Column::Scope,
                    object::Column::Payload,
                    object::Column::UpdatedAtMs,
                ])?
            } else {
                let mut keep = on_conflict;
                keep.inner_mut().do_nothing();
                keep
            };
            let res = object::Entity::insert_many(
                chunk
                    .iter()
                    .cloned()
                    .map(IntoActiveModel::into_active_model),
            )
            .secure()
            .scope_unchecked(&scope)?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await;
            match res {
                Ok(_) | Err(ScopeError::Db(DbErr::RecordNotInserted)) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    async fn write_edges(&self, tenant: Uuid, rows: Vec<edge::Model>) -> anyhow::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        for chunk in rows.chunks(ROWS_PER_STATEMENT) {
            let mut keep = SecureOnConflict::<edge::Entity>::columns([
                edge::Column::TenantId,
                edge::Column::EdgeTypeId,
                edge::Column::Src,
                edge::Column::Dst,
                edge::Column::Relation,
            ]);
            keep.inner_mut().do_nothing();
            let res = edge::Entity::insert_many(
                chunk
                    .iter()
                    .cloned()
                    .map(IntoActiveModel::into_active_model),
            )
            .secure()
            .scope_unchecked(&scope)?
            .on_conflict(keep)
            .exec(&conn)
            .await;
            match res {
                Ok(_) | Err(ScopeError::Db(DbErr::RecordNotInserted)) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    async fn delete_objects(&self, tenant: Uuid, ids: Vec<String>) -> anyhow::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.db.conn()?;
        for chunk in ids.chunks(IDS_PER_STATEMENT) {
            object::Entity::delete_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(tenant))
                .filter(
                    Condition::all().add(object::Column::InstanceId.is_in(chunk.iter().cloned())),
                )
                .exec(&conn)
                .await?;
        }
        Ok(())
    }

    /// The relations of objects that are gone: a deleted object's edges stay
    /// in the graph (its node does too, marked), but nothing should reach it.
    async fn delete_edges_of(&self, tenant: Uuid, ids: &[String]) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        for chunk in ids.chunks(IDS_PER_STATEMENT) {
            edge::Entity::delete_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(tenant))
                .filter(
                    Condition::any()
                        .add(edge::Column::Src.is_in(chunk.iter().cloned()))
                        .add(edge::Column::Dst.is_in(chunk.iter().cloned())),
                )
                .exec(&conn)
                .await?;
        }
        Ok(())
    }

    async fn delete_edge(
        &self,
        tenant: Uuid,
        edge_type_id: &str,
        from: &str,
        to: &str,
        relation: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut cond = Condition::all()
            .add(edge::Column::EdgeTypeId.eq(edge_type_id))
            .add(edge::Column::Src.eq(from))
            .add(edge::Column::Dst.eq(to));
        if let Some(r) = relation {
            cond = cond.add(edge::Column::Relation.is_in([r, ""]));
        }
        let conn = self.db.conn()?;
        edge::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(cond)
            .exec(&conn)
            .await?;
        Ok(())
    }

    fn root_condition(q: &RootSelect) -> Condition {
        let mut cond =
            Condition::all().add(object::Column::TypeId.is_in(q.type_ids.iter().cloned()));
        if let Some(s) = &q.scope {
            cond = cond.add(object::Column::Scope.eq(s.clone()));
        }
        if let Some(owners) = &q.owners {
            cond = cond.add(object::Column::OwnerId.is_in(owners.iter().copied()));
        }
        if let Some(f) = &q.filter {
            cond = cond.add(f.clone());
        }
        cond
    }

    /// Who owns the objects a query could return, before the PDP narrows:
    /// the few tenants whose admission is then asked once each.
    pub async fn owners(
        &self,
        tenant: Uuid,
        type_ids: &[String],
        scope: Option<&str>,
    ) -> anyhow::Result<Vec<Uuid>> {
        let mut cond = Condition::all().add(object::Column::TypeId.is_in(type_ids.iter().cloned()));
        if let Some(s) = scope {
            cond = cond.add(object::Column::Scope.eq(s));
        }
        let conn = self.db.conn()?;
        let rows: Vec<OwnerRow> = object::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(cond)
            .project_all(&conn, |q| {
                q.select_only()
                    .column(object::Column::OwnerId)
                    .distinct()
                    .into_model::<OwnerRow>()
            })
            .await?;
        Ok(rows.into_iter().map(|r| r.owner_id).collect())
    }

    /// One page of a query's root, and how many match across every page.
    /// `after` is the cursor's condition; it narrows the page, not the count.
    pub async fn root(
        &self,
        tenant: Uuid,
        q: &RootSelect,
        after: Option<Expr>,
        offset: u64,
        limit: u64,
    ) -> anyhow::Result<(Vec<ObjectNode>, u64)> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        let cond = Self::root_condition(q);
        let total = object::Entity::find()
            .secure()
            .scope_with(&scope)
            .filter(cond.clone())
            .count(&conn)
            .await?;
        let page = match after {
            Some(a) => cond.add(a),
            None => cond,
        };
        let mut select = object::Entity::find()
            .secure()
            .scope_with(&scope)
            .filter(page);
        for (expr, order) in &q.order {
            select = select.order_by(expr.clone(), order.clone());
        }
        let rows = select
            .order_by(object::Column::InstanceId, Order::Asc)
            .offset(offset)
            .limit(limit)
            .all(&conn)
            .await?;
        Ok((rows.into_iter().map(to_node).collect(), total))
    }

    /// Counts per distinct `key` (a `jsonb_build_array` of the grouped
    /// fields) over a query's root.
    /// How many objects of each type the tenant holds, by stored type id.
    pub async fn counts_by_type(&self, tenant: Uuid) -> anyhow::Result<Vec<(String, u64)>> {
        let conn = self.db.conn()?;
        let rows: Vec<TypeCountRow> = object::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .project_all(&conn, |s| {
                s.select_only()
                    .column(object::Column::TypeId)
                    .column_as(Expr::cust("COUNT(*)"), "n")
                    .group_by(object::Column::TypeId)
                    .into_model::<TypeCountRow>()
            })
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.type_id, u64::try_from(r.n).unwrap_or(0)))
            .collect())
    }

    pub async fn groups(
        &self,
        tenant: Uuid,
        q: &RootSelect,
        key: Expr,
    ) -> anyhow::Result<Vec<Group>> {
        let conn = self.db.conn()?;
        let rows: Vec<GroupRow> = object::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Self::root_condition(q))
            .project_all(&conn, |s| {
                // By position: the key binds its field names as parameters,
                // and Postgres does not see `payload -> $1` and `payload -> $3`
                // as the same expression.
                s.select_only()
                    .column_as(key, "key")
                    .column_as(Expr::cust("COUNT(*)"), "n")
                    .group_by(Expr::cust("1"))
                    .into_model::<GroupRow>()
            })
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| Group {
                key: match r.key {
                    Value::Array(items) => items,
                    other => vec![other],
                },
                count: u64::try_from(r.n).unwrap_or(0),
            })
            .collect())
    }

    /// Every relation of `names` in the tenant, as `(relation, from, to)`.
    pub async fn edges_named(
        &self,
        tenant: Uuid,
        names: &[&str],
    ) -> anyhow::Result<Vec<(String, String, String)>> {
        let conn = self.db.conn()?;
        let rows = edge::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(edge::Column::Relation.is_in(names.iter().copied())))
            .all(&conn)
            .await?;
        Ok(rows
            .into_iter()
            .map(|e| (e.relation, e.src, e.dst))
            .collect())
    }

    /// One hop of a query from the rows: the edges by index on whichever end
    /// the seeds are, then the objects they reach.
    pub async fn hop(
        &self,
        tenant: Uuid,
        seeds: &[String],
        hop: Hop<'_>,
    ) -> anyhow::Result<Neighbourhood> {
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        let mut out = Neighbourhood::default();
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for chunk in seeds.chunks(IDS_PER_STATEMENT) {
            let near = if hop.reverse {
                edge::Column::Dst
            } else {
                edge::Column::Src
            };
            let mut cond = Condition::all()
                .add(edge::Column::EdgeTypeId.eq(hop.edge_type_id))
                .add(near.is_in(chunk.iter().cloned()));
            if let Some(r) = hop.relation {
                cond = cond.add(edge::Column::Relation.is_in([r, ""]));
            }
            let rows = edge::Entity::find()
                .secure()
                .scope_with(&scope)
                .filter(cond)
                .all(&conn)
                .await?;
            for e in rows {
                let (from, to) = if hop.reverse {
                    (e.dst, e.src)
                } else {
                    (e.src, e.dst)
                };
                if seen.insert((from.clone(), to.clone())) {
                    out.edges.push(EdgeView {
                        type_id: e.edge_type_id,
                        from,
                        to,
                        relation: Some(e.relation).filter(|r| !r.is_empty()),
                        key: None,
                    });
                }
            }
        }
        let far: Vec<String> = out
            .edges
            .iter()
            .map(|e| e.to.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        for chunk in far.chunks(IDS_PER_STATEMENT) {
            let rows = object::Entity::find()
                .secure()
                .scope_with(&scope)
                .filter(
                    Condition::all()
                        .add(object::Column::InstanceId.is_in(chunk.iter().cloned()))
                        .add(object::Column::TypeId.is_in(hop.node_type_ids.iter().cloned())),
                )
                .all(&conn)
                .await?;
            out.nodes.extend(rows.into_iter().map(to_node));
        }
        Ok(out)
    }
}

/// The rows for written nodes: live domain objects to upsert, and the ids of
/// those now marked deleted.
fn object_rows(tenant: Uuid, nodes: &[NodeUpsert]) -> (Vec<object::Model>, Vec<String>) {
    let mut live = Vec::new();
    let mut gone = Vec::new();
    for n in nodes.iter().filter(|n| is_object_type(&n.type_id)) {
        if is_live(&n.payload) {
            live.push(row_of(tenant, &n.type_id, &n.node_key, n.payload.clone()));
        } else {
            gone.push(n.node_key.clone());
        }
    }
    (live, gone)
}

fn row_of(tenant: Uuid, type_id: &str, instance_id: &str, payload: Value) -> object::Model {
    let payload = without_nul(payload);
    let scope = payload
        .get("_scope")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // The same reading as `Access::owner_of`: a scope that is a tenant id is
    // the owner; anything else belongs to the organization.
    let owner_id = Uuid::parse_str(scope.trim()).unwrap_or(tenant);
    object::Model {
        tenant_id: tenant,
        instance_id: instance_id.to_string(),
        type_id: type_id.to_string(),
        owner_id,
        scope,
        payload,
        updated_at_ms: now_ms(),
    }
}

fn edge_row(
    tenant: Uuid,
    type_id: &str,
    from: &str,
    to: &str,
    relation: Option<&str>,
) -> edge::Model {
    edge::Model {
        tenant_id: tenant,
        edge_type_id: type_id.to_string(),
        src: from.to_string(),
        dst: to.to_string(),
        relation: relation.unwrap_or_default().to_string(),
    }
}

fn to_node(row: object::Model) -> ObjectNode {
    ObjectNode {
        type_id: row.type_id,
        instance_id: row.instance_id,
        value: row.payload,
    }
}

/// Postgres refuses U+0000 in TEXT and JSONB.
fn without_nul(v: Value) -> Value {
    match v {
        Value::String(s) if s.contains('\0') => Value::String(s.replace('\0', "")),
        Value::Array(a) => Value::Array(a.into_iter().map(without_nul).collect()),
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| (k.replace('\0', ""), without_nul(v)))
                .collect(),
        ),
        other => other,
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(0)
}

// ── The store with the mirror behind its writes ───────────────────────────

/// What this process knows about fills, beyond the table.
#[derive(Default)]
struct FillState {
    running: Mutex<HashSet<Uuid>>,
    failed_at: Mutex<HashMap<Uuid, Instant>>,
    /// Bumped whenever a mirror write fails or a delete lands: a fill that
    /// started under an older generation may have read the graph before the
    /// change, so it must not declare the tenant complete.
    generation: Mutex<HashMap<Uuid, u64>>,
}

impl FillState {
    fn generation(&self, tenant: Uuid) -> u64 {
        self.generation
            .lock()
            .map(|g| g.get(&tenant).copied().unwrap_or(0))
            .unwrap_or(u64::MAX)
    }

    fn bump(&self, tenant: Uuid) {
        if let Ok(mut g) = self.generation.lock() {
            *g.entry(tenant).or_insert(0) += 1;
        }
    }

    fn claim(&self, tenant: Uuid) -> bool {
        if let Ok(failed) = self.failed_at.lock()
            && failed
                .get(&tenant)
                .is_some_and(|at| at.elapsed() < FILL_RETRY_AFTER)
        {
            return false;
        }
        self.running
            .lock()
            .map(|mut r| r.insert(tenant))
            .unwrap_or(false)
    }

    fn release(&self, tenant: Uuid, failed: bool) {
        if let Ok(mut r) = self.running.lock() {
            r.remove(&tenant);
        }
        if let Ok(mut f) = self.failed_at.lock() {
            if failed {
                f.insert(tenant, Instant::now());
            } else {
                f.remove(&tenant);
            }
        }
    }
}

/// A domain store with the mirror behind its writes and in front of its
/// queries.
pub struct IndexedDomainStore {
    inner: Arc<dyn DomainStore>,
    mirror: Arc<DomainMirror>,
    fills: Arc<FillState>,
}

impl IndexedDomainStore {
    pub fn new(inner: Arc<dyn DomainStore>, mirror: Arc<DomainMirror>) -> Self {
        Self {
            inner,
            mirror,
            fills: Arc::new(FillState::default()),
        }
    }

    /// Stop serving a tenant from the mirror after a change reached the graph
    /// and not the rows.
    async fn withdraw(&self, tenant: Uuid, cause: &anyhow::Error) {
        self.fills.bump(tenant);
        warn!(error = %format!("{cause:#}"), "studio-domain-model: the read model missed a graph change — queries read the graph until it is refilled");
        if let Err(e) = self.mirror.unfill(tenant).await {
            warn!(error = %format!("{e:#}"), "studio-domain-model: could not withdraw the read model's fill either");
        }
    }

    async fn after_nodes(&self, ctx: &SecurityContext, nodes: &[NodeUpsert]) {
        let tenant = ctx.subject_tenant_id();
        let (live, gone) = object_rows(tenant, nodes);
        if !gone.is_empty() {
            // A fill running now may have read these before they were marked;
            // its insert would bring them back after the delete below.
            self.fills.bump(tenant);
        }
        let res = async {
            self.mirror.write_objects(tenant, live, true).await?;
            self.mirror.delete_edges_of(tenant, &gone).await?;
            self.mirror.delete_objects(tenant, gone).await
        }
        .await;
        if let Err(e) = res {
            self.withdraw(tenant, &e).await;
        }
    }
}

/// Which declared relation each graph edge is, from its key: the graph does
/// not report an edge's discriminator, so each of the model's relations of the
/// edge's verb is tried. An edge none of them derives keeps no name.
fn named(e: EdgeView, by_verb: &HashMap<String, Vec<String>>) -> EdgeView {
    if e.relation.is_some() {
        return e;
    }
    let Some(key) = e.key.as_deref() else {
        return e;
    };
    let candidates = by_verb
        .get(&e.type_id)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let relation = gts::relation_of_key(
        &e.type_id,
        &e.from,
        &e.to,
        key,
        candidates.iter().map(String::as_str),
    )
    .filter(|r| !r.is_empty())
    .map(str::to_string);
    EdgeView { relation, ..e }
}

/// Copy a tenant's live objects and their relations into the mirror, then
/// declare it complete.
async fn fill_tenant(
    inner: &dyn DomainStore,
    mirror: &DomainMirror,
    fills: &FillState,
    ctx: &SecurityContext,
    ontology: &Ontology,
) -> anyhow::Result<()> {
    let type_ids: Vec<String> = ontology
        .node_types()
        .into_iter()
        .map(|n| n.type_id)
        .collect();
    let mut by_verb: HashMap<String, Vec<String>> = HashMap::new();
    for d in ontology.declared_relations() {
        let names = by_verb.entry(gts::edge_type_id(&d.verb)).or_default();
        if !names.contains(&d.name) {
            names.push(d.name);
        }
    }
    let tenant = ctx.subject_tenant_id();
    let generation = fills.generation(tenant);
    let started = Instant::now();
    mirror.clear(tenant).await?;
    let objects = inner.list_objects(ctx, &type_ids, None, None).await?;
    let ids: Vec<String> = objects.iter().map(|o| o.instance_id.clone()).collect();
    let rows: Vec<object::Model> = objects
        .into_iter()
        .map(|o| row_of(tenant, &o.type_id, &o.instance_id, o.value))
        .collect();
    let written = rows.len();
    mirror.write_objects(tenant, rows, false).await?;
    let edges: Vec<edge::Model> = inner
        .read_edges(ctx, &ids)
        .await?
        .into_iter()
        .filter(|e| is_relation_type(&e.type_id))
        .map(|e| named(e, &by_verb))
        .map(|e| edge_row(tenant, &e.type_id, &e.from, &e.to, e.relation.as_deref()))
        .collect();
    let related = edges.len();
    mirror.write_edges(tenant, edges).await?;
    if fills.generation(tenant) != generation {
        anyhow::bail!("the read model missed a write while the fill ran; it will be retried");
    }
    mirror.mark_filled(tenant, written, related).await?;
    info!(
        objects = written,
        edges = related,
        elapsed_ms = started.elapsed().as_millis(),
        "studio-domain-model: read model filled from the graph"
    );
    Ok(())
}

#[async_trait]
impl DomainStore for IndexedDomainStore {
    async fn register_meta_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        self.inner.register_meta_types(ctx).await
    }

    async fn register_types(
        &self,
        ctx: &SecurityContext,
        node_types: &[NodeType],
        edge_types: &[EdgeType],
    ) -> anyhow::Result<Vec<String>> {
        self.inner.register_types(ctx, node_types, edge_types).await
    }

    async fn create_relation(
        &self,
        ctx: &SecurityContext,
        edge_type_id: &str,
        from: &str,
        to: &str,
        discriminator: Option<&str>,
        payload: Option<Value>,
    ) -> anyhow::Result<()> {
        self.inner
            .create_relation(ctx, edge_type_id, from, to, discriminator, payload)
            .await?;
        if is_relation_type(edge_type_id) {
            let tenant = ctx.subject_tenant_id();
            let row = edge_row(tenant, edge_type_id, from, to, discriminator);
            if let Err(e) = self.mirror.write_edges(tenant, vec![row]).await {
                self.withdraw(tenant, &e).await;
            }
        }
        Ok(())
    }

    async fn delete_relation(
        &self,
        ctx: &SecurityContext,
        edge_type_id: &str,
        from: &str,
        to: &str,
        relation: Option<&str>,
    ) -> anyhow::Result<bool> {
        let tenant = ctx.subject_tenant_id();
        let removed = match self
            .inner
            .delete_relation(ctx, edge_type_id, from, to, relation)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                self.withdraw(tenant, &e).await;
                return Err(e);
            }
        };
        self.fills.bump(tenant);
        if let Err(e) = self
            .mirror
            .delete_edge(tenant, edge_type_id, from, to, relation)
            .await
        {
            self.withdraw(tenant, &e).await;
        }
        Ok(removed)
    }

    async fn get_object(
        &self,
        ctx: &SecurityContext,
        instance_id: &str,
    ) -> anyhow::Result<Option<ObjectNode>> {
        self.inner.get_object(ctx, instance_id).await
    }

    async fn list_objects(
        &self,
        ctx: &SecurityContext,
        type_ids: &[String],
        scope: Option<&str>,
        limit: Option<usize>,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        self.inner.list_objects(ctx, type_ids, scope, limit).await
    }

    async fn upsert_nodes(
        &self,
        ctx: &SecurityContext,
        nodes: &[NodeUpsert],
    ) -> anyhow::Result<u64> {
        let n = self.inner.upsert_nodes(ctx, nodes).await?;
        self.after_nodes(ctx, nodes).await;
        Ok(n)
    }

    async fn upsert_nodes_keeping_vectors(
        &self,
        ctx: &SecurityContext,
        nodes: &[NodeUpsert],
    ) -> anyhow::Result<u64> {
        let n = self.inner.upsert_nodes_keeping_vectors(ctx, nodes).await?;
        self.after_nodes(ctx, nodes).await;
        Ok(n)
    }

    async fn upsert_edges(
        &self,
        ctx: &SecurityContext,
        edges: &[EdgeUpsert],
    ) -> anyhow::Result<u64> {
        let n = self.inner.upsert_edges(ctx, edges).await?;
        let tenant = ctx.subject_tenant_id();
        let rows: Vec<edge::Model> = edges
            .iter()
            .filter(|e| is_relation_type(&e.type_id))
            .map(|e| {
                edge_row(
                    tenant,
                    &e.type_id,
                    &e.from,
                    &e.to,
                    e.discriminator.as_deref(),
                )
            })
            .collect();
        if let Err(e) = self.mirror.write_edges(tenant, rows).await {
            self.withdraw(tenant, &e).await;
        }
        Ok(n)
    }

    async fn read_edges(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
    ) -> anyhow::Result<Vec<EdgeView>> {
        self.inner.read_edges(ctx, seeds).await
    }

    async fn neighbours(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
        hop: Hop<'_>,
    ) -> anyhow::Result<Neighbourhood> {
        self.inner.neighbours(ctx, seeds, hop).await
    }

    async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        type_ids: &[String],
        limit: u32,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        self.inner.search(ctx, text, type_ids, limit).await
    }

    async fn read_model(
        &self,
        ctx: &SecurityContext,
        ontology: &Ontology,
    ) -> Option<Arc<DomainMirror>> {
        let tenant = ctx.subject_tenant_id();
        match self.mirror.is_filled(tenant).await {
            Ok(true) => return Some(Arc::clone(&self.mirror)),
            Ok(false) => {}
            Err(e) => {
                warn!(error = %format!("{e:#}"), "studio-domain-model: read model unreadable — querying the graph");
                return None;
            }
        }
        if self.fills.claim(tenant) {
            let inner = Arc::clone(&self.inner);
            let mirror = Arc::clone(&self.mirror);
            let fills = Arc::clone(&self.fills);
            let ctx = ctx.clone();
            let ontology = ontology.clone();
            tokio::spawn(async move {
                let failed = match fill_tenant(&*inner, &mirror, &fills, &ctx, &ontology).await {
                    Ok(()) => false,
                    Err(e) => {
                        warn!(error = %format!("{e:#}"), "studio-domain-model: read model fill failed — queries stay on the graph");
                        true
                    }
                };
                fills.release(ctx.subject_tenant_id(), failed);
            });
        }
        None
    }
}

#[cfg(test)]
#[path = "mirror_tests.rs"]
mod tests;
