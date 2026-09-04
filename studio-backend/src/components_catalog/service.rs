//! Catalog orchestration: crates.io → typed GTS nodes → graph store.
//!
//! A sync lists every crate under the configured keyword, fetches each crate's
//! detail (with its version history), normalizes them to `gear` and
//! `crate_version` nodes joined by `has_version`, and upserts them into a graph
//! store. Like artifact-ingest it prefers the real graph-storage gear and falls
//! back to an in-memory store so the pipeline still runs (and the portal still
//! shows a catalog) when the graph feature is off.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::anyhow;
use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::cratesio::{CrateDetail, CratesIoClient};
use super::gts::{self, GtsEdge, GtsNode};
use super::repo_enrich::{RepoEnricher, RepoGear, RepoMode};
use super::tasks::{TaskRecord, TaskRegistry};
use crate::connectors::service::ConnectorService;

/// Pause between crates.io detail calls — crates.io asks callers to stay near
/// ~1 request/second. One gear = one detail call, so this paces the whole sync.
const THROTTLE: Duration = Duration::from_millis(250);

// ── Graph sink ────────────────────────────────────────────────────────────

/// Where catalog nodes and edges are written and read. Two implementations: the
/// real graph-storage gear, and an in-memory fallback.
#[async_trait]
pub(crate) trait CatalogSink: Send + Sync {
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()>;
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> anyhow::Result<()>;
    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>>;
}

/// In-memory store, keyed by instance id so a re-sync upserts. Resets on
/// restart; the catalog is cheap to re-sync.
#[derive(Default)]
pub(crate) struct MemorySink {
    nodes: Mutex<HashMap<String, GtsNode>>,
}

#[async_trait]
impl CatalogSink for MemorySink {
    async fn register_types(&self, _ctx: &SecurityContext) -> anyhow::Result<()> {
        Ok(())
    }

    async fn upsert(
        &self,
        _ctx: &SecurityContext,
        nodes: &[GtsNode],
        _edges: &[GtsEdge],
    ) -> anyhow::Result<()> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        for n in nodes {
            map.insert(n.instance_id.clone(), n.clone());
        }
        Ok(())
    }

    async fn list(
        &self,
        _ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("catalog store lock poisoned"))?;
        Ok(map
            .values()
            .filter(|n| type_filter.is_none_or(|t| n.type_id.contains(t)))
            .cloned()
            .collect())
    }
}

/// Human name for a node, from the curated payload. Used by the graph backend.
#[cfg(feature = "graph")]
fn node_name(value: &Value) -> String {
    for key in ["title", "name"] {
        if let Some(s) = value.get(key).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    String::new()
}

/// The real graph-storage backend. Behind the `graph` feature (the gear is).
#[cfg(feature = "graph")]
pub(crate) struct GraphSink {
    client: Arc<dyn graph_storage_sdk::GraphStorageClientV1>,
}

#[cfg(feature = "graph")]
impl GraphSink {
    pub(crate) fn new(client: Arc<dyn graph_storage_sdk::GraphStorageClientV1>) -> Self {
        Self { client }
    }
}

#[cfg(feature = "graph")]
#[async_trait]
impl CatalogSink for GraphSink {
    /// One atomic batch, idempotent: a byte-identical re-registration
    /// converges. Each type derives from a graph-storage family — a free-form
    /// type has no chain to validate against and is refused.
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        use graph_storage_sdk::models::TypeRegistration;
        let batch: Vec<TypeRegistration> = gts::graph_node_type_schemas()
            .into_iter()
            .chain(gts::graph_edge_type_schemas())
            .map(|schema| TypeRegistration {
                type_id: schema
                    .get("$id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim_start_matches("gts://")
                    .to_string(),
                schema,
            })
            .collect();
        self.client
            .register_types(ctx, batch)
            .await
            .map_err(|e| anyhow!("register catalog types: {e}"))?;
        Ok(())
    }

    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> anyhow::Result<()> {
        use graph_storage_sdk::models::{EdgeSpec, IngestOptions, IngestRequest, NodeSpec};
        if nodes.is_empty() && edges.is_empty() {
            return Ok(());
        }
        let node_specs: Vec<NodeSpec> = nodes
            .iter()
            .map(|n| NodeSpec {
                node_key: n.instance_id.clone(),
                type_id: gts::graph_type_id(n.type_id),
                name: Some(node_name(&n.value)),
                payload: Some(n.value.clone()),
                expected_version: None,
            })
            .collect();
        let edge_specs: Vec<EdgeSpec> = edges
            .iter()
            .map(|e| EdgeSpec {
                type_id: gts::graph_type_id(e.type_id),
                src_node_key: e.from.clone(),
                dst_node_key: e.to.clone(),
                discriminator: None,
                payload: None,
            })
            .collect();
        // One atomic ingest: the gear upserts nodes then wires the edges to the
        // keys just written, so a gear and its versions commit together. No
        // phantoms: an edge whose endpoint is not in the batch is our bug.
        self.client
            .ingest(
                ctx,
                IngestRequest {
                    nodes: node_specs,
                    edges: edge_specs,
                    options: IngestOptions {
                        create_phantoms: Some(false),
                        report_per_item: false,
                        embed: Some(true),
                    },
                    replace_scope: None,
                    idempotency_key: None,
                },
            )
            .await
            .map_err(|e| anyhow!("graph-storage ingest: {e}"))?;
        Ok(())
    }

    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        use toolkit_odata::{CursorV1, ODataQuery};
        // The gear's `projection_max_page`; a larger `$top` is refused, not clamped.
        const PAGE: u64 = 200;
        let patterns: Vec<String> = gts::ALL_NODE_TYPES
            .into_iter()
            .filter(|t| type_filter.is_none_or(|f| t.contains(f)))
            .map(gts::graph_type_id)
            .collect();
        if patterns.is_empty() {
            return Ok(Vec::new());
        }
        let mut out: Vec<GtsNode> = Vec::new();
        let mut query = ODataQuery::default().with_limit(PAGE);
        loop {
            let page = self
                .client
                .project_nodes(ctx, &patterns, query.clone())
                .await
                .map_err(|e| anyhow!("graph-storage projection: {e}"))?;
            for row in page.items {
                let Some(type_id) = gts::our_type_from_graph(&row.type_id) else {
                    continue;
                };
                out.push(GtsNode {
                    type_id,
                    instance_id: row.node_key,
                    value: row.payload.unwrap_or_else(|| json!({})),
                });
            }
            let Some(next) = page.page_info.next_cursor else {
                break;
            };
            let cursor = CursorV1::decode(&next)
                .map_err(|e| anyhow!("graph-storage returned an undecodable cursor: {e}"))?;
            query = ODataQuery::default().with_limit(PAGE).with_cursor(cursor);
        }
        Ok(out)
    }
}
// ── Service ─────────────────────────────────────────────────────────────────

/// A repository source the caller selected on the Gears page.
#[derive(Clone, Debug)]
pub struct RepoSource {
    pub tenant: Uuid,
    pub connection_id: Option<Uuid>,
    pub repo: String,
    pub git_ref: String,
    /// "gears" (default) or "frontx".
    pub mode: String,
}

/// Which sources one sync should read. At least one should be set.
#[derive(Clone, Debug, Default)]
pub struct SyncSources {
    /// `Some(keyword)` enables crates.io with that keyword.
    pub crates_io: Option<String>,
    /// Repository sources (gears repo, FrontX repo, …).
    pub repos: Vec<RepoSource>,
}

pub struct CatalogService {
    crates: CratesIoClient,
    sink: Arc<dyn CatalogSink>,
    tasks: Arc<TaskRegistry>,
    keyword: String,
    connectors: Option<Arc<ConnectorService>>,
}

impl CatalogService {
    pub fn new(
        sink: Arc<dyn CatalogSink>,
        keyword: String,
        connectors: Option<Arc<ConnectorService>>,
    ) -> Self {
        Self {
            crates: CratesIoClient::new(),
            sink,
            tasks: Arc::new(TaskRegistry::default()),
            keyword,
            connectors,
        }
    }

    /// The default crates.io keyword, used when a sync request omits one.
    pub fn default_keyword(&self) -> &str {
        &self.keyword
    }

    /// Discover gears from a repository source (best-effort at the call site).
    async fn repo_gears(
        &self,
        ctx: &SecurityContext,
        source: &RepoSource,
    ) -> anyhow::Result<Vec<RepoGear>> {
        let connectors = self
            .connectors
            .clone()
            .ok_or_else(|| anyhow!("no connector service is available for repository sources"))?;
        let enricher = RepoEnricher::new(
            connectors,
            source.tenant,
            source.connection_id,
            source.repo.clone(),
            source.git_ref.clone(),
            RepoMode::parse(&source.mode),
        )
        .ok_or_else(|| anyhow!("invalid repository source"))?;
        enricher.enrich(ctx).await
    }

    pub fn task(&self, id: &str) -> Option<TaskRecord> {
        self.tasks.get(id)
    }

    /// Enqueue a background catalog sync and return its task id.
    pub fn enqueue_sync(self: &Arc<Self>, ctx: SecurityContext, sources: SyncSources) -> String {
        let id = Uuid::new_v4().to_string();
        self.tasks.create(&id);
        let svc = Arc::clone(self);
        let task_id = id.clone();
        tokio::spawn(async move {
            match svc.run_sync(&ctx, sources, Some(&task_id)).await {
                Ok((gears, versions, stored)) => {
                    svc.tasks
                        .succeed(&task_id, gears as u32, versions as u32, stored as u32)
                }
                Err(e) => svc.tasks.fail(&task_id, &format!("{e:#}")),
            }
        });
        id
    }

    /// Read the selected sources into gear + version nodes and upsert them.
    /// Repository gears are discovered from `gear.toml` directories; crates.io
    /// contributes published versions. The two merge by crate name. Returns
    /// (gears, versions, stored-nodes).
    pub async fn run_sync(
        &self,
        ctx: &SecurityContext,
        sources: SyncSources,
        task_id: Option<&str>,
    ) -> anyhow::Result<(usize, usize, usize)> {
        self.sink.register_types(ctx).await?;

        // Gear node value per crate name; version nodes/edges accumulate aside.
        let mut gear_values: BTreeMap<String, Value> = BTreeMap::new();
        let mut version_nodes: Vec<GtsNode> = Vec::new();
        let mut version_edges: Vec<GtsEdge> = Vec::new();
        let mut profile_nodes: Vec<GtsNode> = Vec::new();
        let mut versions_total = 0usize;

        // ── crates.io ────────────────────────────────────────────────────────
        if let Some(keyword) = sources.crates_io.as_deref() {
            self.report(task_id, "listing crates…", 0, 0, 0);
            let summaries = self.crates.list_by_keyword(keyword).await?;
            let total = summaries.len();
            tracing::info!(keyword = %keyword, gears = total, "components-catalog: listed crates");
            for (i, s) in summaries.iter().enumerate() {
                self.report(
                    task_id,
                    &format!("crates.io {} ({}/{})", s.name, i + 1, total),
                    i as u32,
                    versions_total as u32,
                    gear_values.len() as u32,
                );
                let detail = match self.crates.crate_detail(&s.name).await {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::warn!(crate = %s.name, error = %e, "components-catalog: detail fetch failed — skipping");
                        continue;
                    }
                };
                let (mut nodes, edges, vers) = build_gear(&detail);
                versions_total += vers;
                if !nodes.is_empty() {
                    let gear = nodes.remove(0);
                    gear_values.insert(s.name.clone(), gear.value);
                }
                version_nodes.extend(nodes);
                version_edges.extend(edges);
                tokio::time::sleep(THROTTLE).await;
            }
        }

        // ── repository sources → component profiles ─────────────────────────
        // Each repository (gears repo, FrontX repo, …) contributes components.
        // Their engineering data is written into each component's profile
        // (persistent, editable): `auto` and `uml` are refreshed every sync
        // while the hand-edited `values` are preserved.
        if !sources.repos.is_empty() {
            let existing: HashMap<String, serde_json::Map<String, Value>> = self
                .sink
                .list(ctx, Some("gear_profile"))
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|n| {
                    let obj = n.value.as_object()?.clone();
                    let name = obj.get("gear_name")?.as_str()?.to_string();
                    Some((name, obj))
                })
                .collect();
            let mut last_err: Option<anyhow::Error> = None;
            let mut any_ok = false;
            for source in &sources.repos {
                self.report(
                    task_id,
                    &format!("reading {} ({})", source.repo, source.mode),
                    gear_values.len() as u32,
                    versions_total as u32,
                    0,
                );
                match self.repo_gears(ctx, source).await {
                    Ok(repo_gears) => {
                        any_ok = true;
                        for rg in repo_gears {
                            let kind = rg
                                .kind
                                .clone()
                                .unwrap_or_else(|| classify_kind(&rg.crate_name).to_string());
                            let entry = gear_values.entry(rg.crate_name.clone()).or_insert_with(
                                || json!({ "name": rg.crate_name, "title": rg.crate_name }),
                            );
                            if let Some(obj) = entry.as_object_mut() {
                                obj.insert("kind".to_string(), Value::String(kind));
                                if let Some(c) = &rg.category {
                                    obj.insert("category".to_string(), Value::String(c.clone()));
                                }
                                if obj.get("description").map(Value::is_null).unwrap_or(true)
                                    && let Some(d) = &rg.description
                                {
                                    obj.insert("description".to_string(), Value::String(d.clone()));
                                }
                            }
                            let mut prof =
                                existing.get(&rg.crate_name).cloned().unwrap_or_default();
                            prof.insert(
                                "gear_name".to_string(),
                                Value::String(rg.crate_name.clone()),
                            );
                            prof.insert("auto".to_string(), rg.fields);
                            if !rg.uml.is_empty() {
                                prof.insert("uml".to_string(), Value::Array(rg.uml));
                            }
                            prof.insert("source".to_string(), Value::String(source.mode.clone()));
                            if let Some(d) = &rg.description {
                                prof.entry("description".to_string())
                                    .or_insert_with(|| Value::String(d.clone()));
                            }
                            profile_nodes
                                .push(gts::gear_profile_node(&rg.crate_name, Value::Object(prof)));
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, repo = %source.repo, "components-catalog: repository source failed");
                        last_err = Some(e);
                    }
                }
            }
            // Surface the error when the repositories were the only source.
            if !any_ok
                && sources.crates_io.is_none()
                && let Some(e) = last_err
            {
                return Err(e);
            }
        }

        // ── upsert ───────────────────────────────────────────────────────────
        let mut all_nodes: Vec<GtsNode> = gear_values
            .into_iter()
            .map(|(name, value)| gts::gear_node(&name, value))
            .collect();
        let gears_total = all_nodes.len();
        all_nodes.extend(version_nodes);
        all_nodes.extend(profile_nodes);
        let stored = all_nodes.len();
        self.sink.upsert(ctx, &all_nodes, &version_edges).await?;

        tracing::info!(
            gears = gears_total,
            versions = versions_total,
            stored,
            "components-catalog: sync stored"
        );
        self.report(
            task_id,
            "done",
            gears_total as u32,
            versions_total as u32,
            stored as u32,
        );
        Ok((gears_total, versions_total, stored))
    }

    /// Read back catalog nodes, optionally filtered by type substring
    /// (`gear`, `crate_version`).
    pub async fn list_nodes(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.sink.list(ctx, type_filter).await
    }

    /// Read the editable, Studio-owned metadata for all catalogued gears.
    pub async fn list_profiles(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsNode>> {
        self.sink.list(ctx, Some("gear_profile")).await
    }

    /// Upsert a gear profile without touching the crates.io-owned catalog node.
    /// The profile is deliberately an open JSON object: platform teams can add
    /// a field to their delivery model without a backend migration.
    pub async fn save_profile(
        &self,
        ctx: &SecurityContext,
        gear_name: &str,
        profile: Value,
    ) -> anyhow::Result<GtsNode> {
        let gear_name = gear_name.trim();
        if gear_name.is_empty()
            || gear_name.len() > 128
            || !gear_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            anyhow::bail!("gear name must be a crate-style identifier");
        }
        let mut value = profile
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("gear profile must be a JSON object"))?;
        value.insert("gear_name".to_owned(), Value::String(gear_name.to_owned()));
        value
            .entry("title".to_owned())
            .or_insert_with(|| Value::String(gear_name.to_owned()));
        let node = gts::gear_profile_node(gear_name, Value::Object(value));
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(node)
    }

    /// The gear repository connected to a project (where its gears live and where
    /// scaffolded gears are written), or `None` when none is connected yet.
    pub async fn get_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let want = gts::project_gear_repo_instance_id(project_id);
        let nodes = self.sink.list(ctx, Some("project_gear_repo")).await?;
        Ok(nodes.into_iter().find(|n| n.instance_id == want))
    }

    /// Connect (or update) the gear repository for a project. `repo` is an open
    /// JSON object — `{connection_id, repo, branch}` — and the service stamps in
    /// the `project_id` identity before persisting.
    pub async fn set_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        repo: Value,
    ) -> anyhow::Result<GtsNode> {
        let mut value = repo
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("gear repo must be a JSON object"))?;
        value.insert(
            "project_id".to_owned(),
            Value::String(project_id.to_owned()),
        );
        let node = gts::project_gear_repo_node(project_id, Value::Object(value));
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(node)
    }

    /// Write a scaffolded gear into the project's connected gear repository: a
    /// branch off the connected base branch carrying the skeleton files, and an
    /// optional pull request. The connection token is resolved via the
    /// connectors service (it stays in credstore).
    pub async fn scaffold_into_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        slug: &str,
        files: Vec<super::scaffold::ScaffoldFile>,
        open_pr: bool,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        let node = self
            .get_project_repo(ctx, project_id)
            .await?
            .ok_or_else(|| anyhow!("no gear repository is connected to this project"))?;
        let v = node.value;
        let repo = v
            .get("repo")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("connected gear repo has no 'repo'"))?
            .to_string();
        let base_branch = v
            .get("branch")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("main")
            .to_string();
        let tenant: Uuid = v
            .get("tenant")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow!("connected gear repo has no 'tenant'"))?;
        let connection_id: Option<Uuid> = v
            .get("connection_id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok());

        let connectors = self
            .connectors
            .as_ref()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let id = match connection_id {
            Some(id) => id,
            None => {
                connectors
                    .list(ctx, tenant)
                    .await?
                    .into_iter()
                    .find(|c| c.provider == "github")
                    .ok_or_else(|| anyhow!("no GitHub connection for this tenant"))?
                    .id
            }
        };
        let (_driver, auth, _conn) = connectors.driver_and_auth(ctx, tenant, id).await?;

        let branch = format!("scaffold/{slug}");
        let message = format!("scaffold: {slug} gear skeleton");
        let pr_title = open_pr.then(|| format!("Scaffold {slug} gear"));
        let http = reqwest::Client::new();
        super::scaffold::write_scaffold(
            &http,
            &auth,
            &repo,
            &base_branch,
            &branch,
            &files,
            &message,
            pr_title.as_deref(),
        )
        .await
    }

    /// Create a new repository through the connector and record it as this
    /// project's gear repository. Returns the created repo's full name and URL.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
    ) -> anyhow::Result<super::scaffold::CreatedRepo> {
        let connectors = self
            .connectors
            .as_ref()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let id = match connection_id {
            Some(id) => id,
            None => {
                connectors
                    .list(ctx, tenant)
                    .await?
                    .into_iter()
                    .find(|c| c.provider == "github")
                    .ok_or_else(|| anyhow!("no GitHub connection for this tenant"))?
                    .id
            }
        };
        let (_driver, auth, _conn) = connectors.driver_and_auth(ctx, tenant, id).await?;
        let http = reqwest::Client::new();
        let created =
            super::scaffold::create_repo(&http, &auth, owner, is_org, name, private).await?;
        // Record it as the project's gear repository so scaffolds land here.
        let repo_val = json!({
            "tenant": tenant,
            "connection_id": connection_id,
            "repo": created.full_name,
            "branch": created.default_branch,
        });
        self.set_project_repo(ctx, project_id, repo_val).await?;
        Ok(created)
    }

    fn report(&self, task_id: Option<&str>, message: &str, gears: u32, versions: u32, stored: u32) {
        if let Some(id) = task_id {
            self.tasks.report(id, message, gears, versions, stored);
        }
    }
}

/// Build a gear node, its version nodes and the `has_version` edges from one
/// crate's detail. Returns (nodes, edges, version-count).
fn build_gear(detail: &CrateDetail) -> (Vec<GtsNode>, Vec<GtsEdge>, usize) {
    let name = detail.krate.name.clone();
    let gear_id = gts::gear_instance_id(&name);

    // The newest non-yanked version that declares a licence — surfaced on the
    // gear node so the catalogue's Licence field fills without a manual entry.
    let latest_license = detail
        .versions
        .iter()
        .find(|v| v.yanked != Some(true) && v.license.is_some())
        .or_else(|| detail.versions.first())
        .and_then(|v| v.license.clone());

    let gear_value = json!({
        "title": name,
        "name": name,
        "kind": classify_kind(&name),
        "description": detail.krate.description,
        "max_version": detail.krate.max_version,
        "newest_version": detail.krate.newest_version,
        "max_stable_version": detail.krate.max_stable_version,
        "num_versions": detail.krate.num_versions,
        "downloads": detail.krate.downloads,
        "recent_downloads": detail.krate.recent_downloads,
        "created_at": detail.krate.created_at,
        "updated_at": detail.krate.updated_at,
        "repository": detail.krate.repository,
        "documentation": detail.krate.documentation,
        "homepage": detail.krate.homepage,
        "keywords": detail.keywords,
        "categories": detail.categories,
        "license": latest_license,
    });

    let mut nodes: Vec<GtsNode> = Vec::with_capacity(detail.versions.len() + 1);
    let mut edges: Vec<GtsEdge> = Vec::with_capacity(detail.versions.len());
    nodes.push(gts::gear_node(&name, gear_value));

    for v in &detail.versions {
        let published_by = v
            .published_by
            .as_ref()
            .and_then(|p| p.name.clone().or_else(|| p.login.clone()));
        let vvalue = json!({
            "title": format!("{name}@{}", v.num),
            "crate": name,
            "num": v.num,
            "created_at": v.created_at,
            "updated_at": v.updated_at,
            "yanked": v.yanked,
            "yank_message": v.yank_message,
            "license": v.license,
            "rust_version": v.rust_version,
            "edition": v.edition,
            "crate_size": v.crate_size,
            "downloads": v.downloads,
            "has_lib": v.has_lib,
            "published_by": published_by,
        });
        let vnode = gts::crate_version_node(&name, &v.num, vvalue);
        edges.push(gts::has_version_edge(&gear_id, &vnode.instance_id));
        nodes.push(vnode);
    }

    let vers = detail.versions.len();
    (nodes, edges, vers)
}

/// Classify a crate by name so the UI can group them: gear / sdk / plugin /
/// toolkit. Purely cosmetic — the graph keeps the full name.
fn classify_kind(name: &str) -> &'static str {
    if name.contains("toolkit") {
        "toolkit"
    } else if name.ends_with("-sdk") {
        "sdk"
    } else if name.contains("-plugin") {
        "plugin"
    } else {
        "gear"
    }
}
