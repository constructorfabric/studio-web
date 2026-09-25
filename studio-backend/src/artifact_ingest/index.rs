//! The artifact index: every node's listing fields as Postgres columns.
//!
//! ── Why this exists ──────────────────────────────────────────────────────────
//!
//! Every listing of the artifact graph narrows by `scope` (a node's
//! `workspace_id` or `project_id`), often by `repo`, and orders by the
//! artifact's own `updated_at`. All three live in the node payload, and
//! graph-storage's projection can neither filter nor order on a payload path
//! (`docs/graph-storage-requests.md` §5). So each listing walked the tenant's
//! whole typed node set, one sequential page of 200 at a time: on studio-dev,
//! 24–33 thousand nodes and 12–20 seconds per walk, behind `/nodes`,
//! `/source-activity`, `/spec-rows` and `/specs-per-source`. The 60-second
//! cache in [`super::graph_backend`] could not save it: the node listing and
//! the file listing together are over its budget, so they evicted each other.
//!
//! This keeps what those reads need where they can be asked for it: one row
//! per node, the narrowing fields as indexed columns, and the payload a graph
//! read would return beside them — so a page is one query and never touches
//! the graph. The graph stays the source of truth; this is a mirror of it, and
//! it can always be rebuilt from it.
//!
//! ── How it stays true ────────────────────────────────────────────────────────
//!
//! Every change goes through this store: [`IndexedGraphStore::upsert_nodes`]
//! and [`IndexedGraphStore::delete_nodes`] (a re-sync forgetting files the
//! repository no longer has) change the graph first, then the rows.
//!
//! A tenant is served from here only once a FILL has copied its graph in and
//! written its `studio_artifact_index_fill` row. Until then — the first read
//! after this shipped, or after a failed write — reads go to the graph exactly
//! as they did before, and the fill runs in the background. A change that
//! reached the graph and not the index — a failed index write, or a delete
//! that failed on either side — leaves the rows behind the graph, so it
//! withdraws the tenant's fill row: readers fall back to the graph, and the
//! next read starts a fresh fill.
//!
//! A fill clears the tenant's rows, then inserts what it read from the graph
//! with `ON CONFLICT DO NOTHING`. A sync writing concurrently uses `DO
//! UPDATE`, and its row is always at least as new as what the fill read, so
//! whichever lands first, the newer payload is the one that stays.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sea_orm::sea_query::LikeExpr;
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

use super::entity::{fill, node};
use super::graph::{GraphStore, GtsEdge, GtsEdgeView, GtsNode, NodePage, NodePageQuery, PageStart};
use super::gts;
use super::port::IngestedFile;

/// Rows per insert statement. A multi-row insert binds one parameter per
/// column per row, and Postgres stops at 65,535 of them.
const ROWS_PER_STATEMENT: usize = 500;

/// How long a tenant whose fill failed waits before the next read retries it.
/// Without this, a broken index database would turn every read into a
/// background walk of the graph.
const FILL_RETRY_AFTER: Duration = Duration::from_secs(60);

/// The Postgres half: rows in, pages out. Knows nothing about the graph.
pub struct ArtifactIndex {
    db: Db,
}

/// A file row, read without its payload.
#[derive(Debug, FromQueryResult)]
struct FileRow {
    instance_id: String,
    path: String,
    repo: String,
}

impl ArtifactIndex {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Is this tenant's index complete?
    async fn is_filled(&self, tenant: Uuid) -> anyhow::Result<bool> {
        let conn = self.db.conn()?;
        Ok(fill::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .one(&conn)
            .await?
            .is_some())
    }

    /// Withdraw a tenant's fill row, so readers go back to the graph.
    async fn unfill(&self, tenant: Uuid) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        fill::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn mark_filled(&self, tenant: Uuid, nodes: usize) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        let row = fill::ActiveModel {
            tenant_id: ActiveValue::Set(tenant),
            filled_at_ms: ActiveValue::Set(now_ms()),
            nodes: ActiveValue::Set(i64::try_from(nodes).unwrap_or(i64::MAX)),
        };
        let on_conflict = SecureOnConflict::<fill::Entity>::columns([fill::Column::TenantId])
            .update_columns([fill::Column::FilledAtMs, fill::Column::Nodes])?;
        fill::Entity::insert(row)
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(tenant))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Drop every row of a tenant — the first step of a fill.
    async fn clear(&self, tenant: Uuid) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        node::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Write rows. `replace` is a sync's write (the row is newer than whatever
    /// is there); without it, an existing row wins (a fill's write, which may
    /// be older than a sync that raced it).
    async fn write(
        &self,
        tenant: Uuid,
        rows: Vec<node::Model>,
        replace: bool,
    ) -> anyhow::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        for chunk in rows.chunks(ROWS_PER_STATEMENT) {
            let on_conflict = SecureOnConflict::<node::Entity>::columns([
                node::Column::TenantId,
                node::Column::InstanceId,
            ]);
            let on_conflict = if replace {
                on_conflict.update_columns([
                    node::Column::TypeId,
                    node::Column::WorkspaceId,
                    node::Column::ProjectId,
                    node::Column::Repo,
                    node::Column::Path,
                    node::Column::IsDir,
                    node::Column::UpdatedAt,
                    node::Column::SearchText,
                    node::Column::Payload,
                ])?
            } else {
                let mut keep = on_conflict;
                keep.inner_mut().do_nothing();
                keep
            };
            let res = node::Entity::insert_many(
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
                Ok(_) => {}
                // `DO NOTHING` over rows that all exist inserts nothing, which
                // the ORM reports as an error. For a fill it is the expected
                // outcome of losing every race in the chunk.
                Err(ScopeError::Db(DbErr::RecordNotInserted)) if !replace => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    /// Drop the rows of nodes the graph has forgotten.
    async fn delete(&self, tenant: Uuid, ids: Vec<String>) -> anyhow::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.db.conn()?;
        for chunk in ids.chunks(ROWS_PER_STATEMENT) {
            node::Entity::delete_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(tenant))
                .filter(Condition::all().add(node::Column::InstanceId.is_in(chunk.iter().cloned())))
                .exec(&conn)
                .await?;
        }
        Ok(())
    }

    fn in_scope(query_types: &[&'static str], scope: &str) -> Condition {
        Condition::all()
            .add(node::Column::TypeId.is_in(query_types.iter().copied()))
            .add(
                Condition::any()
                    .add(node::Column::WorkspaceId.eq(scope))
                    .add(node::Column::ProjectId.eq(scope)),
            )
    }

    async fn list(
        &self,
        tenant: Uuid,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let types = gts::resolve_listable_types(type_filter);
        if types.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = node::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Self::in_scope(&types, scope))
            .all(&conn)
            .await?;
        Ok(rows.into_iter().filter_map(to_node).collect())
    }

    async fn count(
        &self,
        tenant: Uuid,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<u64> {
        let types = gts::resolve_listable_types(type_filter);
        if types.is_empty() {
            return Ok(0);
        }
        let conn = self.db.conn()?;
        Ok(node::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Self::in_scope(&types, scope))
            .count(&conn)
            .await?)
    }

    /// Files by their columns alone — the one read here that never needs a
    /// payload, over the largest type there is.
    async fn files(&self, tenant: Uuid, scope: &str) -> anyhow::Result<Vec<IngestedFile>> {
        let conn = self.db.conn()?;
        let rows: Vec<FileRow> = node::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Self::in_scope(&[gts::FILE_TYPE], scope)
                    .add(node::Column::IsDir.eq(false))
                    .add(node::Column::Path.ne("")),
            )
            .project_all(&conn, |q| {
                q.select_only()
                    .column(node::Column::InstanceId)
                    .column(node::Column::Path)
                    .column(node::Column::Repo)
                    .into_model::<FileRow>()
            })
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| IngestedFile {
                node_id: r.instance_id,
                path: r.path,
                repo: r.repo,
            })
            .collect())
    }

    async fn page(
        &self,
        tenant: Uuid,
        scope: &str,
        q: &NodePageQuery<'_>,
    ) -> anyhow::Result<NodePage> {
        let types = gts::resolve_listable_types(q.type_filter);
        if types.is_empty() {
            return Ok(NodePage {
                nodes: Vec::new(),
                total: 0,
                start: 0,
            });
        }
        let mut filter = Self::in_scope(&types, scope);
        if let Some(repo) = q.repo {
            filter = filter.add(node::Column::Repo.eq(repo));
        }
        if let Some(needle) = q.needle {
            let pattern = format!("%{}%", escape_like(needle));
            filter = filter.add(node::Column::SearchText.like(LikeExpr::new(pattern).escape('\\')));
        }
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        let scoped = |cond: Condition| {
            node::Entity::find()
                .secure()
                .scope_with(&scope)
                .filter(cond)
        };

        let total = scoped(filter.clone()).count(&conn).await?;
        let start = match q.start {
            PageStart::Offset(offset) => u64::try_from(offset).unwrap_or(u64::MAX).min(total),
            // Just after the cursor's own row — its position counted in the
            // page's order. A cursor the filter no longer contains starts at
            // the beginning, as the in-process path always did.
            PageStart::After(cursor) => {
                let at = scoped(filter.clone().add(node::Column::InstanceId.eq(cursor)))
                    .one(&conn)
                    .await?;
                match at {
                    None => 0,
                    Some(at) => {
                        let upto = if q.by_updated {
                            Condition::any()
                                .add(node::Column::UpdatedAt.gt(at.updated_at.clone()))
                                .add(
                                    Condition::all()
                                        .add(node::Column::UpdatedAt.eq(at.updated_at))
                                        .add(node::Column::InstanceId.lte(cursor)),
                                )
                        } else {
                            Condition::all().add(node::Column::InstanceId.lte(cursor))
                        };
                        scoped(filter.clone().add(upto)).count(&conn).await?
                    }
                }
            }
        };

        let mut select = scoped(filter);
        if q.by_updated {
            select = select.order_by(node::Column::UpdatedAt, Order::Desc);
        }
        let rows = select
            .order_by(node::Column::InstanceId, Order::Asc)
            .offset(start)
            .limit(u64::try_from(q.limit).unwrap_or(u64::MAX))
            .all(&conn)
            .await?;
        Ok(NodePage {
            nodes: rows.into_iter().filter_map(to_node).collect(),
            total,
            start,
        })
    }
}

/// A graph store with the index in front of its reads and behind its writes.
pub struct IndexedGraphStore {
    inner: Arc<dyn GraphStore>,
    index: Arc<ArtifactIndex>,
    fills: Arc<FillState>,
}

/// What this process knows about fills, beyond the table.
#[derive(Default)]
struct FillState {
    /// Tenants a fill is running for, so a burst of reads starts one.
    running: Mutex<HashSet<Uuid>>,
    /// When a tenant's last fill failed.
    failed_at: Mutex<HashMap<Uuid, Instant>>,
    /// Bumped whenever an index write fails. A fill that started under an
    /// older generation may have read the graph before the failed batch
    /// reached it, so it must not declare the tenant complete.
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

    /// Claim the fill for a tenant. `false` when one is running or the last
    /// failed too recently to try again.
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

impl IndexedGraphStore {
    pub fn new(inner: Arc<dyn GraphStore>, index: Arc<ArtifactIndex>) -> Self {
        Self {
            inner,
            index,
            fills: Arc::new(FillState::default()),
        }
    }

    /// Can this tenant be served from the index? When not, a fill is started
    /// in the background and the caller reads the graph.
    async fn ready(&self, ctx: &SecurityContext) -> bool {
        let tenant = ctx.subject_tenant_id();
        match self.index.is_filled(tenant).await {
            Ok(true) => return true,
            Ok(false) => {}
            Err(e) => {
                warn!(error = %format!("{e:#}"), "studio-artifact-ingest: index unreadable — reading the graph");
                return false;
            }
        }
        if self.fills.claim(tenant) {
            let inner = Arc::clone(&self.inner);
            let index = Arc::clone(&self.index);
            let fills = Arc::clone(&self.fills);
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let failed = match fill_tenant(&*inner, &index, &fills, &ctx).await {
                    Ok(()) => false,
                    Err(e) => {
                        warn!(error = %format!("{e:#}"), "studio-artifact-ingest: index fill failed — reads stay on the graph");
                        true
                    }
                };
                fills.release(ctx.subject_tenant_id(), failed);
            });
        }
        false
    }

    /// Stop serving a tenant from the index after a change reached the graph
    /// and not the index. Readers fall back to the graph, and the next read
    /// starts a fill; a fill already running must not declare the tenant
    /// complete, since it may have read the graph before this change.
    async fn withdraw(&self, tenant: Uuid, cause: &anyhow::Error) {
        self.fills.bump(tenant);
        warn!(error = %format!("{cause:#}"), "studio-artifact-ingest: the index missed a graph change — the tenant is read from the graph until it is refilled");
        if let Err(e) = self.index.unfill(tenant).await {
            warn!(error = %format!("{e:#}"), "studio-artifact-ingest: could not withdraw the index fill either");
        }
    }

    /// An index read that fell over is logged and answered from the graph: the
    /// index is an optimisation, and must not be what fails a listing.
    fn fell_back(e: &anyhow::Error) {
        warn!(error = %format!("{e:#}"), "studio-artifact-ingest: index read failed — reading the graph");
    }
}

/// Copy a tenant's graph into the index, then declare it complete.
async fn fill_tenant(
    inner: &dyn GraphStore,
    index: &ArtifactIndex,
    fills: &FillState,
    ctx: &SecurityContext,
) -> anyhow::Result<()> {
    let tenant = ctx.subject_tenant_id();
    let generation = fills.generation(tenant);
    let started = Instant::now();
    index.clear(tenant).await?;
    let mut written = 0usize;
    // Every node type, not the listable four: the activity feed, the finding
    // counts and the commit strip read the others.
    for type_id in gts::ALL_NODE_TYPES {
        let nodes = inner.list(ctx, Some(type_id)).await?;
        let rows: Vec<node::Model> = nodes
            .iter()
            .map(|n| row_of(tenant, n, n.value.clone()))
            .collect();
        written += rows.len();
        index.write(tenant, rows, false).await?;
    }
    if fills.generation(tenant) != generation {
        anyhow::bail!("an index write failed while the fill ran; it will be retried");
    }
    index.mark_filled(tenant, written).await?;
    info!(
        nodes = written,
        elapsed_ms = started.elapsed().as_millis(),
        "studio-artifact-ingest: index filled from the graph"
    );
    Ok(())
}

#[async_trait]
impl GraphStore for IndexedGraphStore {
    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        self.inner.upsert_nodes(ctx, nodes).await?;
        let tenant = ctx.subject_tenant_id();
        // Not a file's content: nothing lists it, and its excerpt is the
        // weight the file rows were split to shed (see `gts::is_listed`). The
        // fill skips it the same way, because the graph never lists it.
        let rows: Vec<node::Model> = nodes
            .iter()
            .filter(|n| gts::is_listed(n.type_id))
            .map(|n| row_of(tenant, n, self.inner.stored_payload(&n.value)))
            .collect();
        if let Err(e) = self.index.write(tenant, rows, true).await {
            // The graph has the batch and the index does not. Serving pages
            // from here would hide it. The sync itself succeeded.
            self.withdraw(tenant, &e).await;
        }
        Ok(())
    }

    async fn delete_nodes(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<usize> {
        let tenant = ctx.subject_tenant_id();
        let removed = match self.inner.delete_nodes(ctx, nodes).await {
            Ok(n) => n,
            Err(e) => {
                // A failure may come after part of the batch was retired, and
                // which part is not reported — so neither half of the index can
                // be trusted to match the graph for this tenant any more.
                self.withdraw(tenant, &e).await;
                return Err(e);
            }
        };
        // A fill running now may have read these nodes before the graph
        // forgot them, and its `DO NOTHING` insert would bring their rows
        // back after the delete below. It must not declare the tenant complete.
        self.fills.bump(tenant);
        let ids = nodes.iter().map(|n| n.instance_id.clone()).collect();
        if let Err(e) = self.index.delete(tenant, ids).await {
            // The graph forgot these and the index did not: pages served from
            // here would list files that are gone.
            self.withdraw(tenant, &e).await;
        }
        Ok(removed)
    }

    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        self.inner.upsert_edges(ctx, edges).await
    }

    async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.inner.search(ctx, text, limit).await
    }

    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Arc<Vec<GtsNode>>> {
        self.inner.list(ctx, type_filter).await
    }

    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        self.inner.list_relations(ctx).await
    }

    fn stored_payload(&self, value: &Value) -> Value {
        self.inner.stored_payload(value)
    }

    async fn list_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<Vec<GtsNode>> {
        if self.ready(ctx).await {
            match self
                .index
                .list(ctx.subject_tenant_id(), type_filter, scope)
                .await
            {
                Ok(nodes) => return Ok(nodes),
                Err(e) => Self::fell_back(&e),
            }
        }
        self.inner.list_in_scope(ctx, type_filter, scope).await
    }

    async fn count_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<u64> {
        if self.ready(ctx).await {
            match self
                .index
                .count(ctx.subject_tenant_id(), type_filter, scope)
                .await
            {
                Ok(n) => return Ok(n),
                Err(e) => Self::fell_back(&e),
            }
        }
        self.inner.count_in_scope(ctx, type_filter, scope).await
    }

    async fn files_in_scope(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<IngestedFile>> {
        if self.ready(ctx).await {
            match self.index.files(ctx.subject_tenant_id(), scope).await {
                Ok(files) => return Ok(files),
                Err(e) => Self::fell_back(&e),
            }
        }
        self.inner.files_in_scope(ctx, scope).await
    }

    async fn page(
        &self,
        ctx: &SecurityContext,
        query: &NodePageQuery<'_>,
    ) -> anyhow::Result<NodePage> {
        if let Some(scope) = query.scope
            && self.ready(ctx).await
        {
            match self.index.page(ctx.subject_tenant_id(), scope, query).await {
                Ok(page) => return Ok(page),
                Err(e) => Self::fell_back(&e),
            }
        }
        // Unscoped listings stay on the graph: nothing the portal draws asks
        // for one, and the index is keyed for the narrowing that everything does.
        self.inner.page(ctx, query).await
    }
}

/// The row for a node, from the payload the graph keeps for it.
fn row_of(tenant: Uuid, n: &GtsNode, payload: Value) -> node::Model {
    // Postgres refuses U+0000 in both TEXT and JSONB. The graph backend strips
    // it already; the in-memory store does not, and one such file must not
    // take a tenant's index down with it.
    let payload = without_nul(payload);
    let text = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    node::Model {
        tenant_id: tenant,
        instance_id: n.instance_id.clone(),
        type_id: n.type_id.to_owned(),
        workspace_id: text("workspace_id"),
        project_id: text("project_id"),
        repo: text("repo"),
        path: text("path"),
        is_dir: payload.get("is_dir").and_then(Value::as_bool) == Some(true),
        updated_at: text("updated_at"),
        search_text: search_text(&payload),
        payload,
    }
}

/// What the listing's `q` matches: the four human-facing fields joined by a
/// space and lower-cased, then the number. The separator keeps a needle from
/// matching across the end of the text and the start of the number, which
/// the in-process filter (two separate `contains`) never did.
fn search_text(v: &Value) -> String {
    let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    let hay = [
        field("title"),
        field("author"),
        field("path"),
        field("full_path"),
    ]
    .join(" ")
    .to_lowercase();
    let num = v
        .get("number")
        .and_then(Value::as_i64)
        .map(|n| n.to_string())
        .unwrap_or_default();
    format!("{hay}\u{1}{num}")
}

/// `%`, `_` and the escape character itself, escaped for a `LIKE` pattern.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

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

/// A row back as a node. A type this binary does not know is skipped rather
/// than guessed at — it can only be a row written by a newer build.
fn to_node(row: node::Model) -> Option<GtsNode> {
    let type_id = gts::ALL_NODE_TYPES
        .into_iter()
        .find(|t| *t == row.type_id)?;
    Some(GtsNode {
        type_id,
        instance_id: row.instance_id,
        value: row.payload,
    })
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

#[cfg(test)]
#[path = "index_tests.rs"]
mod tests;
