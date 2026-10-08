//! REST surface for artifact ingest.
//!
//! `POST /studio-artifact-ingest/v1/sync` enqueues a background sync (issues,
//! pull requests and files) and answers `202` with a `run_id`.
//!
//! The sync is an `artifact.ingest` run on `studio-tasks`:
//! `GET /studio-tasks/v1/runs/{run_id}` is how it is polled (its
//! `result` carries the counts per phase), and the sync survives the process
//! that accepted it. This gear used to answer the same poll a second time
//! under its own path.

use std::sync::Arc;

use axum::extract::Query;
use axum::http::HeaderMap;
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::graph::{NodePageQuery, PageStart};
use super::ingest_task::{IngestPayload, TASK_TYPE};
use super::service::{IngestService, KeptRepo, ProjectArtifact};
use crate::pagination::{PageQuery, page_of};

/// Errors attributable to an artifact-ingest resource (e.g. an unknown task).
/// Five tokens in the segment (`vendor.package.namespace.type.vN`); `_` is the
/// empty namespace slot.
#[resource_error(gts_id!("cf.studio._.artifact_ingest.v1~"))]
pub struct StudioArtifactIngestError;

/// Service handle, plus the hub the sync routes resolve the task queue
/// through.
#[derive(Clone)]
pub struct Ingest {
    /// `None` = the gear booted without any connector driver linked; the route
    /// stays mounted and answers 503 with the reason.
    service: Option<Arc<IngestService>>,
    /// Resolved per request rather than held: a sync is a run now, and both the
    /// enqueue and the poll endpoint read through here — lazily, so this gear
    /// does not care whether `studio-tasks` initialized first.
    hub: Arc<ClientHub>,
}

impl Ingest {
    pub fn new(service: Option<Arc<IngestService>>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }

    fn get(&self) -> ApiResult<&Arc<IngestService>> {
        self.service.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "artifact ingest is not available in this deployment \
                     (no connector driver plugin is registered)",
                )
                .create()
        })
    }

    /// What each ingested file was decided to be called, for the feed.
    ///
    /// Best-effort by design and by signature: it answers a map, empty when
    /// the documents gear is not here or the project's parent cannot be
    /// resolved. A feed reading by path is worse than one reading by name and
    /// very much better than no feed.
    async fn binding_names(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> std::collections::HashMap<String, String> {
        let Ok(id) = uuid::Uuid::parse_str(project_id.trim()) else {
            return std::collections::HashMap::new();
        };
        let Ok(names) = self.hub.get::<dyn crate::documents::port::BindingNames>() else {
            return std::collections::HashMap::new();
        };
        names.names_for(ctx, id).await.unwrap_or_default()
    }

    fn queue(&self) -> ApiResult<Arc<dyn crate::tasks::TaskQueue>> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "repository syncs are not available in this deployment \
                         (studio-tasks has no database configured)",
                    )
                    .create()
            })
    }
}

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SyncRequest {
    /// Driver key: `github` (gitlab/bitbucket land as drivers implement them).
    pub provider: String,
    /// Installation root; omitted = the provider's default.
    #[serde(default)]
    pub base_url: Option<String>,
    /// credstore reference holding the connector token.
    pub secret_ref: String,
    /// Namespaced repository path, e.g. `org/repo`.
    pub repo_full_path: String,
    /// RFC 3339 lower bound for incremental sync (optional).
    #[serde(default)]
    pub since: Option<String>,
    /// Workspace tenant this repo belongs to (the parent of `project_id`).
    /// Tagged onto every stored node so a workspace-level graph can show every
    /// project's artifacts. Omitted = not scoped to a workspace.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Project tenant this repo belongs to. Tagged onto every stored node so a
    /// project-level graph shows only its own artifacts, and used (in
    /// preference to `workspace_id`) to locate the IDE's shared checkout —
    /// `{workspaces_root}/{project_id}/{repo_dir}` — so ingest reads the same
    /// clone the IDE opened instead of cloning its own. Omitted = fall back to
    /// `workspace_id`, then own-clone / tree API.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Directory name of this repo under the checkout root (the source's
    /// `target`, or its `name`). Pairs with `project_id`/`workspace_id`.
    #[serde(default)]
    pub repo_dir: Option<String>,
}

/// Acknowledgement that a sync was accepted and is running in the background.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SyncEnqueued {
    /// The studio-tasks run doing the sync: poll `GET /studio-tasks/v1/runs/{run_id}`
    /// for the outcome; its `result` carries the counts as they tick up.
    pub run_id: String,
    /// `queued` at enqueue time.
    pub status: String,
}

/// One repository a reconcile keeps — the same pair a sync of it is sent.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AttachedRepo {
    /// credstore reference of the connection the repository is attached
    /// through (the sync's `secret_ref`).
    pub secret_ref: String,
    /// Namespaced repository path, e.g. `org/repo`.
    pub repo_full_path: String,
}

/// Which attachment scope to reconcile, and what it has attached now.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReconcileRequest {
    /// Same meaning as on [`SyncRequest`]: the scope a sync stamps is the
    /// project when one is named, else the workspace.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Every repository the scope has attached now. Any other repository
    /// synced into the scope is forgotten, with everything synced from it.
    pub keep: Vec<AttachedRepo>,
}

/// What a reconcile forgot.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReconcileResponse {
    /// Repository nodes forgotten.
    pub repos: usize,
    /// Issues, pull requests, files, comments and commits forgotten with them.
    pub nodes: usize,
    /// Document bindings dropped for those files.
    pub bindings: usize,
}

#[derive(Debug, serde::Deserialize)]
pub struct NodesQuery {
    /// Filter to one artifact type by its full GTS id
    /// (`gts.cf.studio.artifact.issue.v1~`); the bare leaf (`issue`) also works.
    /// Omitted = the four first-class artifacts (repo, file, issue,
    /// pull_request).
    #[serde(default)]
    pub r#type: Option<String>,
    /// Tenant scope: keep only nodes whose `workspace_id` OR `project_id`
    /// equals this. Pass a workspace tenant to see every project under it, or a
    /// project tenant to see just that project. Omitted = no scoping.
    #[serde(default)]
    pub scope: Option<String>,
    /// Filter to one repository — the repo node's instance id (the `repo`
    /// field carried by issue/pull_request/file/comment/commit nodes).
    #[serde(default)]
    pub repo: Option<String>,
    /// Sort order: `updated` (newest `updated_at` first) or the default stable
    /// order by instance id.
    #[serde(default)]
    pub sort: Option<String>,
    /// Case-insensitive substring search over title / author / path / number.
    /// Applied before pagination, so `total` reflects the matches.
    #[serde(default)]
    pub q: Option<String>,
    /// Zero-based offset for classic paginator pagination (page = offset/limit).
    /// Takes precedence over `cursor` when both are present.
    #[serde(default)]
    pub offset: Option<usize>,
    /// Opaque continuation cursor returned by the preceding response (legacy;
    /// `offset` is preferred).
    #[serde(default)]
    pub cursor: Option<String>,
    /// Number of nodes to return. Defaults to 50 and is capped at 200.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize)]
pub struct EdgesQuery {
    /// Tenant scope (see [`NodesQuery::scope`]): keep only edges whose both
    /// endpoints are in-scope nodes. Omitted = every relation.
    #[serde(default)]
    pub scope: Option<String>,
    /// `?offset=&limit=` — see [`crate::pagination`]. A client that lays the
    /// whole graph out (the portal, the IDE graph widget) walks the pages.
    #[serde(flatten)]
    pub page: PageQuery,
}

/// True when a node's `value` is inside `scope` — i.e. its `workspace_id` or
/// its `project_id` equals `scope`. Used to keep a project's (or workspace's)
/// graph to its own artifacts. A `None` scope admits everything.
pub(super) fn node_in_scope(value: &Value, scope: Option<&str>) -> bool {
    let Some(scope) = scope else {
        return true;
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return false,
    };
    let matches = |key: &str| obj.get(key).and_then(Value::as_str) == Some(scope);
    matches("workspace_id") || matches("project_id")
}

/// One ingested artifact node.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct ArtifactNodeDto {
    /// GTS type id, e.g. `gts.cf.studio.artifact.issue.v1~`.
    pub type_id: String,
    /// Deterministic instance id (uuid5 of a stable key).
    pub instance_id: String,
    /// The normalized artifact payload.
    #[schema(value_type = Object)]
    pub value: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ArtifactNodeListResponse {
    pub nodes: Vec<ArtifactNodeDto>,
    /// Total number of artifacts matching the type/scope filter across every
    /// page, so a caller can show "N of M" without walking the whole cursor.
    pub total: u32,
    /// Present when another page is available. Pass it as `cursor` unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// One relation between two artifact nodes, endpoints addressed by instance id.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ArtifactEdgeDto {
    /// GTS relation type id, e.g. `gts.cf.studio.rel.modifies.v1~`.
    pub type_id: String,
    /// Instance id of the source node.
    pub from: String,
    /// Instance id of the target node.
    pub to: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ArtifactEdgeListResponse {
    pub edges: Vec<ArtifactEdgeDto>,
    /// Relations matching the scope filter across every page, so a caller
    /// laying out the whole graph knows how many pages to walk: another page
    /// exists exactly when `offset + edges.len() < total`.
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct RepoFilesQuery {
    /// Workspace the repo belongs to.
    pub workspace_id: String,
    /// The repo's directory under the workspace root (its `target`/`name`).
    pub repo_dir: String,
}

/// One text file from the repository checkout.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RepoFileDto {
    pub path: String,
    pub text: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RepoFilesResponse {
    pub files: Vec<RepoFileDto>,
}

/// One spec-quality finding to persist (portal-parsed from a detector result).
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct QualityFindingDto {
    /// `bloat` | `traceability` | `leak` | `purpose`.
    pub detector: String,
    /// Instance id of the document node the finding is about.
    pub subject: String,
    /// Document path/name, for display.
    #[serde(default)]
    pub path: Option<String>,
    /// Verdict/severity label (detector-specific).
    #[serde(default)]
    pub severity: Option<String>,
    /// One-line human summary of the finding.
    #[serde(default)]
    pub summary: Option<String>,
    /// Optional numeric score (e.g. duplication ratio).
    #[serde(default)]
    pub score: Option<f64>,
    /// The raw detector detail object, stored verbatim.
    #[serde(default)]
    #[schema(value_type = Object)]
    pub details: Value,
}

/// A derived relation between two document nodes (endpoints by instance id).
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct QualityLinkDto {
    pub from: String,
    pub to: String,
}

/// Batch of spec-quality results to materialize into the graph.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct QualityFindingsRequest {
    #[serde(default)]
    pub findings: Vec<QualityFindingDto>,
    /// Bloat near-duplicate pairs → `duplicates` edges.
    #[serde(default)]
    pub duplicates: Vec<QualityLinkDto>,
    /// Traceability links → `traces_to` edges.
    #[serde(default)]
    pub traces: Vec<QualityLinkDto>,
    /// Workspace tenant these findings belong to — tagged onto each finding
    /// node so it survives a workspace-level graph scope (see the `scope` param
    /// on `/nodes`). Omitted = the findings are unscoped.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Project tenant these findings belong to — tagged onto each finding node
    /// so it survives a project-level graph scope. Omitted = workspace-only.
    #[serde(default)]
    pub project_id: Option<String>,
}

/// Count of graph objects upserted.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct QualityFindingsResponse {
    pub nodes: u32,
    pub edges: u32,
}

/// A search over the artifact graph. Semantic (hybrid) when an embedder is
/// wired, lexical otherwise — the request shape is the same either way.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SearchRequest {
    /// Free-text query.
    pub text: String,
    /// Maximum matches (default 20, capped at 200).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// A durable file-storage reference. Artifact Graph stores this metadata, not
/// the object bytes.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ArtifactObjectRefRequest {
    pub storage: String,
    pub file_id: String,
    pub version_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    #[serde(default)]
    pub checksum: Option<String>,
}

/// A manually-added or Studio-generated project file to register in the graph.
/// Its bytes must already be available through file-storage.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ManualFileRequest {
    /// Organization owning the workspace/project hierarchy.
    pub organization_id: String,
    /// Workspace tenant this file belongs to (the parent of `project_id`).
    /// Tagged onto the node so a workspace-level graph shows it. Also keys the
    /// node's identity, so re-uploading the same name upserts.
    pub workspace_id: String,
    /// Project tenant this file belongs to. Tagged onto the node so a
    /// project-level graph shows only its own files. Omitted = workspace-only.
    #[serde(default)]
    pub project_id: String,
    /// `manual` for a user upload, `generated` for Studio-produced output.
    pub origin: String,
    /// File name or relative path.
    pub path: String,
    pub size: u64,
    /// Reference returned by file-storage after the signed upload finalized.
    pub object_ref: ArtifactObjectRefRequest,
}

/// The stored file node's id.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ManualFileResponse {
    pub instance_id: String,
}

async fn sync(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    headers: HeaderMap,
    Json(req): Json<SyncRequest>,
) -> ApiResult<(StatusCode, JsonBody<SyncEnqueued>)> {
    let idempotency_key = crate::idempotency::key(&headers)?;
    let svc = ingest.get()?;
    let queue = ingest.queue()?;

    let provider = req.provider.trim().to_string();
    let secret_ref = req.secret_ref.trim().to_string();
    let repo_full_path = req.repo_full_path.trim().to_string();
    if repo_full_path.is_empty() {
        return Err(StudioArtifactIngestError::invalid_argument()
            .with_constraint("repo_full_path must not be empty")
            .create());
    }
    // Resolved here and thrown away: the run resolves its own token per attempt
    // (a queue row is no place for one). What this call is for is the errors —
    // a malformed reference, or a credstore that cannot answer — which belong
    // on this request rather than in a run that dead-letters where nobody is
    // looking.
    //
    // A reference that resolves to nothing is deliberately NOT one of them. A
    // public repository syncs and clones without credentials, and answering 500
    // because a token is missing refuses work that would have succeeded — it is
    // how this environment ended up with a Specs tab that could not scan a
    // public repo. The run logs that it is unauthenticated; a private
    // repository still fails, at the provider, with the provider's reason.
    if svc
        .resolve_token(&ctx, &secret_ref)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .is_none()
    {
        tracing::warn!(
            secret_ref = %secret_ref,
            repo = %repo_full_path,
            "studio-artifact-ingest: no readable token — the sync will run without credentials"
        );
    }

    let trimmed = |v: Option<&str>| {
        v.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let workspace_id = trimmed(req.workspace_id.as_deref());
    let project_id = trimmed(req.project_id.as_deref());
    let run = IngestPayload {
        provider,
        base_url: trimmed(req.base_url.as_deref()),
        secret_ref,
        repo_full_path,
        since: trimmed(req.since.as_deref()),
        workspace_id,
        project_id: project_id.clone(),
        repo_dir: trimmed(req.repo_dir.as_deref()),
    };
    let partition_key = run.partition_key();
    let payload = serde_json::to_value(run)
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::sdk::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: TASK_TYPE,
                payload,
                partition_key: Some(&partition_key),
                idempotency_key: idempotency_key.as_deref(),
                coalesce_queued: true,
                // A sync is the long job someone waits for, and the project it
                // was asked for is the session they are waiting in. A
                // workspace-scoped sync addresses nobody: a workspace tenant is
                // not a session, and guessing one would notify a window that
                // has nothing to do with this.
                notify_workspace_id: project_id.as_deref().and_then(|p| Uuid::parse_str(p).ok()),
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    Ok((
        StatusCode::ACCEPTED,
        Json(SyncEnqueued {
            run_id: run_id.to_string(),
            status: "queued".to_string(),
        }),
    ))
}

async fn reconcile(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Json(req): Json<ReconcileRequest>,
) -> ApiResult<JsonBody<ReconcileResponse>> {
    let svc = ingest.get()?;
    let trimmed = |v: Option<&str>| {
        v.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let workspace_id = trimmed(req.workspace_id.as_deref());
    let project_id = trimmed(req.project_id.as_deref());
    // Refused rather than read as "the unscoped graph": a caller that lost its
    // ids would otherwise forget every repository nobody scoped.
    if workspace_id.is_none() && project_id.is_none() {
        return Err(StudioArtifactIngestError::invalid_argument()
            .with_constraint("workspace_id or project_id is required")
            .create());
    }
    let keep: Vec<KeptRepo> = req
        .keep
        .into_iter()
        .map(|k| KeptRepo {
            connector_id: k.secret_ref.trim().to_string(),
            repo_full_path: k.repo_full_path.trim().to_string(),
        })
        .collect();
    let summary = svc
        .prune_detached(&ctx, workspace_id.as_deref(), project_id.as_deref(), &keep)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ReconcileResponse {
        repos: summary.repos,
        nodes: summary.nodes,
        bindings: summary.bindings,
    }))
}

async fn list_nodes(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(q): Query<NodesQuery>,
) -> ApiResult<JsonBody<ArtifactNodeListResponse>> {
    let svc = ingest.get()?;
    let trimmed = |v: &Option<String>| -> Option<String> {
        v.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let (filter, scope, repo) = (trimmed(&q.r#type), trimmed(&q.scope), trimmed(&q.repo));
    let needle = trimmed(&q.q).map(|s| s.to_lowercase());
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    // Offset wins when present (classic paginator); otherwise the legacy cursor
    // resolves to the position just after it.
    let start = match (q.offset, q.cursor.as_deref()) {
        (Some(offset), _) => PageStart::Offset(offset),
        (None, Some(cursor)) => PageStart::After(cursor),
        (None, None) => PageStart::Offset(0),
    };
    let page = svc
        .page_nodes(
            &ctx,
            &NodePageQuery {
                type_filter: filter.as_deref(),
                scope: scope.as_deref(),
                repo: repo.as_deref(),
                needle: needle.as_deref(),
                by_updated: q.sort.as_deref() == Some("updated"),
                start,
                limit,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let end = page.start + page.nodes.len() as u64;
    let next_cursor = (end < page.total)
        .then(|| page.nodes.last().map(|node| node.instance_id.clone()))
        .flatten();
    let nodes = page
        .nodes
        .into_iter()
        .map(|n| {
            // A file's text is its content node, which is not listed, so a
            // file here has none (`has_text` still flags it). Dropped anyway,
            // so no node that does carry one ever makes a listing heavy. A
            // dedicated content endpoint can serve the body when needed.
            let mut value = n.value;
            if let Some(obj) = value.as_object_mut() {
                obj.remove("text");
            }
            ArtifactNodeDto {
                type_id: n.type_id.to_string(),
                instance_id: n.instance_id,
                value,
            }
        })
        .collect();
    Ok(Json(ArtifactNodeListResponse {
        nodes,
        total: u32::try_from(page.total).unwrap_or(u32::MAX),
        next_cursor,
    }))
}

async fn list_edges(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(q): Query<EdgesQuery>,
) -> ApiResult<JsonBody<ArtifactEdgeListResponse>> {
    let svc = ingest.get()?;
    let scope = q.scope.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // When scoped, an edge is kept only if BOTH endpoints are in-scope nodes.
    // Build that id set from the (scope-filtered) node list first; endpoints
    // reference nodes by instance id.
    let in_scope: Option<std::collections::HashSet<String>> = match scope {
        Some(scope) => Some(
            svc.list_in_scope(&ctx, None, scope)
                .await
                .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
                .into_iter()
                .map(|n| n.instance_id)
                .collect(),
        ),
        None => None,
    };
    let edges = svc
        .list_relations(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let mut edges: Vec<ArtifactEdgeDto> = edges
        .into_iter()
        .filter(|e| {
            in_scope
                .as_ref()
                .map(|set| set.contains(&e.from) && set.contains(&e.to))
                .unwrap_or(true)
        })
        .map(|e| ArtifactEdgeDto {
            type_id: e.type_id,
            from: e.from,
            to: e.to,
        })
        .collect();
    // Same reason `/nodes` sorts: the graph adapters return storage pages in no
    // particular order, and paging an unordered sequence would let one page
    // repeat an edge the previous page already carried. Endpoints plus type
    // make a total order — a pair can be joined by more than one relation.
    edges.sort_by(|a, b| {
        a.from
            .cmp(&b.from)
            .then_with(|| a.to.cmp(&b.to))
            .then_with(|| a.type_id.cmp(&b.type_id))
    });
    let (edges, total) = page_of(edges, q.page);
    Ok(Json(ArtifactEdgeListResponse { edges, total }))
}

async fn repo_files(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(q): Query<RepoFilesQuery>,
) -> ApiResult<JsonBody<RepoFilesResponse>> {
    let svc = ingest.get()?;
    let files = svc
        .read_repo_files(q.workspace_id.trim(), q.repo_dir.trim())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(RepoFilesResponse {
        files: files
            .into_iter()
            .map(|(path, text)| RepoFileDto { path, text })
            .collect(),
    }))
}

async fn save_quality(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Json(req): Json<QualityFindingsRequest>,
) -> ApiResult<JsonBody<QualityFindingsResponse>> {
    let svc = ingest.get()?;
    let findings: Vec<super::service::QualityFinding> = req
        .findings
        .into_iter()
        .map(|f| super::service::QualityFinding {
            detector: f.detector,
            subject: f.subject,
            path: f.path,
            severity: f.severity,
            summary: f.summary,
            score: f.score,
            details: f.details,
        })
        .collect();
    let to_link = |l: QualityLinkDto| super::service::QualityLink {
        from: l.from,
        to: l.to,
    };
    let duplicates: Vec<super::service::QualityLink> =
        req.duplicates.into_iter().map(to_link).collect();
    let traces: Vec<super::service::QualityLink> = req.traces.into_iter().map(to_link).collect();
    let workspace_id = req
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let project_id = req
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let (nodes, edges) = svc
        .upsert_quality(
            &ctx,
            &findings,
            &duplicates,
            &traces,
            workspace_id.as_deref(),
            project_id.as_deref(),
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(QualityFindingsResponse {
        nodes: nodes as u32,
        edges: edges as u32,
    }))
}

async fn search(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Json(req): Json<SearchRequest>,
) -> ApiResult<JsonBody<ArtifactNodeListResponse>> {
    let svc = ingest.get()?;
    let limit = req.limit.unwrap_or(20).clamp(1, 200);
    let nodes = svc
        .search(&ctx, req.text.trim(), limit)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let items: Vec<ArtifactNodeDto> = nodes
        .into_iter()
        .map(|n| {
            let mut value = n.value;
            if let Some(obj) = value.as_object_mut() {
                obj.remove("text");
            }
            ArtifactNodeDto {
                type_id: n.type_id.to_string(),
                instance_id: n.instance_id,
                value,
            }
        })
        .collect();
    Ok(Json(ArtifactNodeListResponse {
        total: items.len() as u32,
        nodes: items,
        next_cursor: None,
    }))
}

async fn add_file(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Json(req): Json<ManualFileRequest>,
) -> ApiResult<JsonBody<ManualFileResponse>> {
    let svc = ingest.get()?;
    let organization_id = req.organization_id.trim().to_string();
    let workspace_id = req.workspace_id.trim().to_string();
    let project_id = req.project_id.trim().to_string();
    let origin = req.origin.trim().to_ascii_lowercase();
    let path = req.path.trim().to_string();
    if organization_id.is_empty()
        || workspace_id.is_empty()
        || project_id.is_empty()
        || path.is_empty()
    {
        return Err(CanonicalError::internal(
            "organization_id, workspace_id, project_id and path are required",
        )
        .create());
    }
    if !matches!(origin.as_str(), "manual" | "generated") {
        return Err(CanonicalError::internal("origin must be 'manual' or 'generated'").create());
    }
    if req.object_ref.storage != "file-storage"
        || uuid::Uuid::parse_str(&req.object_ref.file_id).is_err()
        || uuid::Uuid::parse_str(&req.object_ref.version_id).is_err()
    {
        return Err(CanonicalError::internal(
            "object_ref must contain valid file-storage file_id and version_id values",
        )
        .create());
    }
    if req.size != req.object_ref.size {
        return Err(CanonicalError::internal("size must match object_ref.size").create());
    }
    let object_ref = serde_json::json!({
        "storage": req.object_ref.storage,
        "file_id": req.object_ref.file_id,
        "version_id": req.object_ref.version_id,
        "name": req.object_ref.name,
        "mime": req.object_ref.mime,
        "size": req.object_ref.size,
        "checksum": req.object_ref.checksum,
    });
    let instance_id = svc
        .upsert_project_artifact(
            &ctx,
            ProjectArtifact {
                organization_id: &organization_id,
                workspace_id: &workspace_id,
                project_id: &project_id,
                origin: &origin,
                path: &path,
                size: req.size,
                object_ref,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ManualFileResponse { instance_id }))
}

// ── what has been happening, folded here rather than in a page ───────────────

/// How many days of movement the Sources table asks for when it says nothing.
const ACTIVITY_DAYS_DEFAULT: u32 = 7;
/// The longest window offered. Beyond this the daily buckets stop being a
/// shape anybody can read, and the answer is a different question.
const ACTIVITY_DAYS_MAX: u32 = 90;

#[derive(Debug, serde::Deserialize)]
pub struct SourceActivityQuery {
    /// Workspace or project tenant whose repositories these are.
    pub scope: String,
    /// Days of movement to count, ending today. Defaults to 7.
    pub days: Option<u32>,
}

#[derive(Debug, serde::Deserialize)]
pub struct FeedQuery {
    /// The project whose feed this is.
    pub project_id: String,
}

/// One repository's movement over the window.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RepoActivityDto {
    /// Instance id of the repo node these numbers are about.
    pub repo: String,
    /// Pull requests open RIGHT NOW, however old. Deliberately not windowed:
    /// one opened three weeks ago and still open is the one most worth seeing.
    pub open: u32,
    /// Pull requests merged inside the window — a rate, so it is windowed.
    pub merged: u32,
    /// Commits inside the window, for the same reason.
    pub commits: u32,
    /// One bucket per day, oldest first, always `days` long, so a sparkline
    /// never has to guess its own axis and a quiet repository draws a flat
    /// line rather than nothing.
    pub days: Vec<u32>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SourceActivityListDto {
    pub items: Vec<RepoActivityDto>,
    pub total: u32,
    /// The window these numbers cover, in days.
    pub days: u32,
}

/// One thing that happened.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ActivityEventDto {
    pub id: String,
    /// `check` or `comment`.
    pub kind: String,
    /// What happened, in the product's words.
    pub event: String,
    /// What it happened to — a document, or the issue a comment is on.
    pub subject: String,
    /// Who or what did it. A detector is a "who" here.
    pub by: String,
    /// RFC 3339, or null when the node carries no time. An undated row sorts
    /// LAST rather than first.
    pub recorded: Option<String>,
    /// The detector's own word for how it went, when there is one.
    pub severity: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ActivityFeedListDto {
    pub items: Vec<ActivityEventDto>,
    pub total: u32,
}

/// GET /studio-artifact-ingest/v1/source-activity — a week per repository.
async fn source_activity(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(query): Query<SourceActivityQuery>,
) -> ApiResult<JsonBody<SourceActivityListDto>> {
    let days = query.days.unwrap_or(ACTIVITY_DAYS_DEFAULT);
    if !(1..=ACTIVITY_DAYS_MAX).contains(&days) {
        return Err(StudioArtifactIngestError::invalid_argument()
            .with_field_violation(
                "days",
                format!("must be between 1 and {ACTIVITY_DAYS_MAX}, got {days}"),
                "INVALID",
            )
            .create());
    }
    let scope = query.scope.trim();
    if scope.is_empty() {
        return Err(StudioArtifactIngestError::invalid_argument()
            .with_field_violation("scope", "must name a tenant".to_owned(), "INVALID")
            .create());
    }
    let service = ingest.get()?;

    let pulls = scoped_values(service, &ctx, "pull_request", scope).await?;
    let commits = scoped_values(service, &ctx, "commit", scope).await?;
    // One instant for every row: a render spanning midnight would otherwise
    // put two repositories on different axes.
    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(0);

    let items: Vec<RepoActivityDto> =
        super::activity::repo_activity(&pulls, &commits, now, days as usize)
            .into_iter()
            .map(|(repo, a)| RepoActivityDto {
                repo,
                open: a.open,
                merged: a.merged,
                commits: a.commits,
                days: a.days,
            })
            .collect();
    Ok(Json(SourceActivityListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        days,
    }))
}

/// GET /studio-artifact-ingest/v1/activity — what was checked and what was said.
async fn activity_feed(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(query): Query<FeedQuery>,
) -> ApiResult<JsonBody<ActivityFeedListDto>> {
    let project_id = query.project_id.trim();
    if project_id.is_empty() {
        return Err(StudioArtifactIngestError::invalid_argument()
            .with_field_violation("project_id", "must name a project".to_owned(), "INVALID")
            .create());
    }
    let service = ingest.get()?;

    let findings = scoped_entries(service, &ctx, "spec_finding", project_id).await?;
    let comments = scoped_entries(service, &ctx, "comment", project_id).await?;

    // The names the bindings gave these files. Best-effort on purpose: losing
    // them leaves rows reading by path, which is worse than a name and very
    // much better than no feed.
    let names = ingest.binding_names(&ctx, project_id).await;
    let name_of = |id: &str| names.get(id).cloned();

    let items: Vec<ActivityEventDto> =
        super::activity::activity_feed(&findings, &comments, &name_of)
            .into_iter()
            .map(|e| ActivityEventDto {
                id: e.id,
                kind: e.kind.as_str().to_owned(),
                event: e.event,
                subject: e.subject,
                by: e.by,
                recorded: e.recorded,
                severity: e.severity,
            })
            .collect();
    Ok(Json(ActivityFeedListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

// ── who the open pull requests are waiting on ────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct OpenPullRequestsQuery {
    /// The project whose pull requests these are.
    pub project_id: String,
    #[serde(flatten)]
    pub page: PageQuery,
}

/// An account a pull request names, read as a person where it can be.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct PullRequestPersonDto {
    /// The account's login on the provider, as the provider spells it.
    pub login: String,
    /// The organization member this account is confirmed as belonging to
    /// (their canonical person id), or null.
    pub user_id: Option<String>,
    /// That member's name, when their profile carries one.
    pub display_name: Option<String>,
    /// `true` for a member of the project's organization, `false` for an
    /// account nobody in it has confirmed as theirs, and null when the member
    /// directory could not be asked — which says nothing either way.
    pub in_organization: Option<bool>,
}

/// One reviewer and where they stand.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PullRequestReviewerDto {
    pub person: PullRequestPersonDto,
    /// `pending` (asked and not answered, or asked again), `approved`,
    /// `changes_requested` or `commented`.
    pub state: String,
}

/// One open pull request, and who it is waiting on.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct WaitingPullRequestDto {
    /// Instance id of the `pull_request` node.
    pub id: String,
    /// The repository, as `owner/name`, when its repo node is in the project.
    pub repo: Option<String>,
    /// The provider key of that repository (`github`, …).
    pub provider: Option<String>,
    pub number: i64,
    pub title: String,
    /// The pull request on the provider's site.
    pub url: Option<String>,
    pub author: Option<PullRequestPersonDto>,
    /// The one bucket it is in: `review`, `author`, `merge`, `draft` or
    /// `nobody`.
    pub waiting: String,
    /// Who it is waiting on: the reviewers still owing a review for `review`,
    /// the author for `author`, `merge` and `draft`, nobody for `nobody`.
    pub waiting_on: Vec<PullRequestPersonDto>,
    /// Teams still owing a review, by name (only for `review`).
    pub waiting_on_teams: Vec<String>,
    /// Why, in one plain sentence.
    pub reason: String,
    /// `approved`, `changes_requested`, `review_required`, or null when the
    /// reviews were not read or nobody was asked.
    pub review_decision: Option<String>,
    /// Everyone asked to review it or who did, with where they stand.
    pub reviewers: Vec<PullRequestReviewerDto>,
    pub assignees: Vec<PullRequestPersonDto>,
    pub draft: bool,
    /// Unresolved review conversations, or null when the provider cannot say.
    pub open_threads: Option<u32>,
    /// RFC 3339, as the provider reported it.
    pub created_at: Option<String>,
    /// RFC 3339, the last time anything happened on it.
    pub updated_at: Option<String>,
    /// Whole days since it was opened.
    pub days_open: Option<u32>,
    /// Whole days since anything happened on it.
    pub days_since_update: Option<u32>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct WaitingPullRequestListDto {
    pub items: Vec<WaitingPullRequestDto>,
    pub total: u32,
    /// Whether accounts were matched against the organization's members. False
    /// when the member directory or the project's organization could not be
    /// read; every `in_organization` is then null.
    pub members_known: bool,
}

/// The organization a project hangs under (project → workspace →
/// organization), read as the caller, so a caller learns nothing about an
/// organization their scope does not reach. `None` when any step fails or the
/// grandparent is not an organization.
async fn organization_of_project(
    am: &dyn account_management_sdk::AccountManagementClient,
    ctx: &SecurityContext,
    project_id: Uuid,
) -> Option<Uuid> {
    let project = am.get_tenant(ctx, project_id).await.ok()?;
    let workspace = am.get_tenant(ctx, project.parent_id?.0).await.ok()?;
    let org_id = workspace.parent_id?.0;
    let org = am.get_tenant(ctx, org_id).await.ok()?;
    (org.tenant_type.as_deref() == Some(crate::organizations::sdk::ORGANIZATION_TENANT_TYPE))
        .then_some(org_id)
}

/// GET /studio-artifact-ingest/v1/open-pull-requests — who they wait on.
async fn open_pull_requests(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(query): Query<OpenPullRequestsQuery>,
) -> ApiResult<JsonBody<WaitingPullRequestListDto>> {
    use std::collections::{BTreeMap, BTreeSet};

    let project_id = query.project_id.trim();
    if project_id.is_empty() {
        return Err(StudioArtifactIngestError::invalid_argument()
            .with_field_violation("project_id", "must name a project".to_owned(), "INVALID")
            .create());
    }
    let service = ingest.get()?;

    let pulls = scoped_entries(service, &ctx, "pull_request", project_id).await?;
    let repos: BTreeMap<String, (Option<String>, Option<String>)> =
        scoped_entries(service, &ctx, "repo", project_id)
            .await?
            .into_iter()
            .map(|(id, v)| {
                let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
                (id, (text("full_path"), text("provider")))
            })
            .collect();
    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(0);
    let waiting = super::pull_request_waits::waiting_pulls(&pulls, now);
    let provider_of = |repo: &Option<String>| {
        repo.as_ref()
            .and_then(|r| repos.get(r))
            .and_then(|(_, provider)| provider.clone())
    };

    // Every account named, per provider: a login means something only on the
    // provider it came from.
    let mut accounts: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for p in &waiting {
        let Some(provider) = provider_of(&p.repo) else {
            continue;
        };
        let set = accounts.entry(provider).or_default();
        set.extend(p.facts.author.iter().cloned());
        set.extend(p.facts.requested_reviewers.iter().cloned());
        set.extend(p.assignees.iter().cloned());
        set.extend(p.facts.reviews.iter().flatten().map(|r| r.login.clone()));
    }

    // Who of them is one of the organization's people. Best-effort: without
    // the directory every account reads as a bare login and the answer says
    // so, rather than calling everybody an outsider.
    let directory = ingest
        .hub
        .get_scoped::<dyn crate::user_profile::MemberAliases>(&ClientScope::gts_id(
            crate::user_profile::IDENTITY_INSTANCE_ID,
        ))
        .ok();
    let am = ingest
        .hub
        .get::<dyn account_management_sdk::AccountManagementClient>()
        .ok();
    let org = match (am, Uuid::parse_str(project_id)) {
        (Some(am), Ok(id)) => organization_of_project(am.as_ref(), &ctx, id).await,
        _ => None,
    };
    let mut members: BTreeMap<(String, String), crate::user_profile::AttributedMember> =
        BTreeMap::new();
    let mut members_known = false;
    if let (Some(directory), Some(org)) = (directory, org) {
        members_known = true;
        for (provider, logins) in &accounts {
            let logins: Vec<String> = logins.iter().cloned().collect();
            match directory.members_by_alias(org, provider, &logins).await {
                Ok(found) => {
                    for (login, member) in found {
                        members.insert((provider.clone(), login), member);
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, provider, "studio-artifact-ingest: member lookup failed");
                    members_known = false;
                }
            }
        }
    }
    let person = |provider: Option<&str>, login: &str| {
        let member = provider
            .and_then(|p| members.get(&(p.to_owned(), crate::user_profile::normalize_key(login))));
        PullRequestPersonDto {
            login: login.to_owned(),
            user_id: member.map(|m| m.person.clone()),
            display_name: member.and_then(|m| m.display_name.clone()),
            in_organization: members_known.then_some(member.is_some()),
        }
    };

    let items: Vec<WaitingPullRequestDto> = waiting
        .into_iter()
        .map(|p| {
            let provider = provider_of(&p.repo);
            let provider_ref = provider.as_deref();
            let requested = &p.facts.requested_reviewers;
            let mut reviewers: Vec<PullRequestReviewerDto> = requested
                .iter()
                .map(|login| PullRequestReviewerDto {
                    person: person(provider_ref, login),
                    state: "pending".to_owned(),
                })
                .collect();
            for r in p.facts.reviews.iter().flatten() {
                if !requested.iter().any(|q| q.eq_ignore_ascii_case(&r.login)) {
                    reviewers.push(PullRequestReviewerDto {
                        person: person(provider_ref, &r.login),
                        state: r.state.clone(),
                    });
                }
            }
            WaitingPullRequestDto {
                repo: p
                    .repo
                    .as_ref()
                    .and_then(|r| repos.get(r))
                    .and_then(|(path, _)| path.clone()),
                number: p.number,
                title: p.title,
                url: p.url,
                author: p.facts.author.as_deref().map(|a| person(provider_ref, a)),
                waiting: p.verdict.waiting.as_str().to_owned(),
                waiting_on: p
                    .verdict
                    .on
                    .iter()
                    .map(|login| person(provider_ref, login))
                    .collect(),
                waiting_on_teams: p.verdict.teams,
                reason: p.verdict.reason,
                review_decision: p.review_decision.map(str::to_owned),
                reviewers,
                assignees: p
                    .assignees
                    .iter()
                    .map(|login| person(provider_ref, login))
                    .collect(),
                draft: p.facts.draft,
                open_threads: p.facts.open_threads.and_then(|n| u32::try_from(n).ok()),
                created_at: p.created_at,
                updated_at: p.updated_at,
                days_open: p.days_open,
                days_since_update: p.days_since_update,
                provider,
                id: p.id,
            }
        })
        .collect();
    let (items, total) = page_of(items, query.page);
    Ok(Json(WaitingPullRequestListDto {
        items,
        total,
        members_known,
    }))
}

/// The payloads of one type that name `scope`, through the same predicate the
/// listing route applies — not a second spelling of it.
async fn scoped_values(
    service: &Arc<IngestService>,
    ctx: &SecurityContext,
    type_leaf: &str,
    scope: &str,
) -> ApiResult<Vec<serde_json::Value>> {
    Ok(service
        .list_in_scope(ctx, Some(type_leaf), scope)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .into_iter()
        .map(|node| node.value)
        .collect())
}

/// The same, keeping each node's instance id — what a feed row is keyed on.
async fn scoped_entries(
    service: &Arc<IngestService>,
    ctx: &SecurityContext,
    type_leaf: &str,
    scope: &str,
) -> ApiResult<Vec<(String, serde_json::Value)>> {
    Ok(service
        .list_in_scope(ctx, Some(type_leaf), scope)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .into_iter()
        .map(|node| (node.instance_id, node.value))
        .collect())
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<IngestService>>,
    hub: Arc<ClientHub>,
) -> Router {
    let router = OperationBuilder::post("/studio-artifact-ingest/v1/sync")
        .operation_id("studio_artifact_ingest.sync")
        .summary("Enqueue a background sync of a connector source into the graph")
        .description(
            "Checks the connector token, then queues a durable `artifact.ingest` \
             run: issues and pull requests from the API, and files from a \
             shallow git clone (or the tree API when no volume is mounted). \
             Answers 202 with the `run_id`: follow it at \
             `GET /studio-tasks/v1/runs/{run_id}`, which can also cancel or retry it. \
             Send an `Idempotency-Key` header to make a retry of this request safe: \
             a repeat with the same key answers the same run.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .json_request::<SyncRequest>(openapi, "Source to ingest")
        .handler(sync)
        .json_response_with_schema::<SyncEnqueued>(openapi, StatusCode::ACCEPTED, "Sync enqueued")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-artifact-ingest/v1/reconcile")
        .operation_id("studio_artifact_ingest.reconcile_repositories")
        .summary("Forget repositories a project no longer has attached")
        .description(
            "Forgets, in one attachment scope, every synced repository that is \
             not in `keep` — its issues, pull requests, files, comments and \
             commits, and the document bindings of its files. Called when a \
             repository is detached, so the project stops listing what it let \
             go of. Attaching it again later syncs it as before.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ReconcileRequest>(openapi, "Scope and the repositories it keeps")
        .handler(reconcile)
        .json_response_with_schema::<ReconcileResponse>(
            openapi,
            StatusCode::OK,
            "What was forgotten",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-artifact-ingest/v1/source-activity")
        .operation_id("studio_artifact_ingest.list_source_activity")
        .summary("A week of movement per repository, from the graph a sync filled")
        .description(
            "Pull requests and commits per repository over a window of days, folded from the \
             `pull_request` and `commit` nodes an ingest run wrote. A repository nobody has \
             synced reports nothing rather than reporting a plausible seven.\n\n\
             THE WINDOW IS CLOSED AT ONE END ONLY, on purpose. `open` counts pull requests open \
             right now however old they are — one opened three weeks ago and still open is the \
             one most worth seeing, and windowing it would hide exactly that. `merged` and \
             `commits` are windowed, because those are rates: what is interesting about a merge \
             is that it happened recently.\n\n\
             `days` is one bucket per day, oldest first, and always as long as the window — so a \
             sparkline never has to guess its own axis and a quiet repository draws a flat line \
             rather than nothing. Every row is measured against ONE instant, so a render \
             spanning midnight cannot put two repositories on different axes.\n\n\
             This used to be folded in the portal, which paged `pull_request` and `commit` \
             newest-first until it fell out of the window — commits outnumber everything else in \
             a repository, and the projection cannot narrow by a payload field, so each of those \
             pages was a slice of the tenant's whole typed node set.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("scope", true, "Workspace or project tenant to count within")
        .query_param("days", false, "Days of movement, ending today (default 7)")
        .handler(source_activity)
        .json_response_with_schema::<SourceActivityListDto>(
            openapi,
            StatusCode::OK,
            "Movement per repository",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-artifact-ingest/v1/activity")
        .operation_id("studio_artifact_ingest.list_activity")
        .summary("What was checked and what was said, in one feed")
        .description(
            "Spec-quality checks and repository comments for one project, in one list, newest \
             first. An undated row sorts LAST rather than first: a missing timestamp at the top \
             would put the least informative rows where the most recent ones belong, and \
             findings written before `recorded_at` existed are exactly that case.\n\n\
             WHAT THE HISTORY CAN SAY, and what it cannot. A `spec_finding`'s instance id is \
             keyed on (detector, subject), so re-running a detector UPSERTS: there is one \
             finding per detector per document, carrying when it was last produced. That is a \
             current state with a timestamp on it, not a log, so the feed shows the latest check \
             per document and nothing before it. Comments are the other half and are a genuine \
             history — every comment a sync pulled is its own node with its own `created_at`.\n\n\
             A check is named by the document it is about: the binding's name first, then the \
             node's own path, then its id. A row naming an opaque id is still a row somebody can \
             chase, and dropping it would hide a check that really happened. When the documents \
             gear is not here the names are simply absent and rows read by path.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose feed to read")
        .handler(activity_feed)
        .json_response_with_schema::<ActivityFeedListDto>(openapi, StatusCode::OK, "The feed")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-artifact-ingest/v1/open-pull-requests")
        .operation_id("studio_artifact_ingest.list_open_pull_requests")
        .summary("A project's open pull requests, each with who it is waiting on")
        .description(
            "Every open pull request of one project, from the `pull_request` nodes the last \
             sync wrote, each put in exactly one bucket: `review` (somebody asked to review it \
             has not), `author` (changes were asked for, conversations are open, or it was \
             only commented on), `merge` (approved, nothing outstanding), `draft`, or `nobody` \
             (open, not a draft, and nobody was asked — the stuck ones). The rules are in \
             `artifact_ingest/pull_request_waits.rs`. Longest-quiet first.\n\n\
             AS FRESH AS THE LAST SYNC, not as the provider: a review given since then is not \
             here until the project syncs again. Reviews are read for at most 200 open pull \
             requests per repository; past that, and on a provider whose reviews Studio does \
             not read, `review_decision` is null and a pull request nobody was asked about \
             says its reviews could not be read.\n\n\
             An account is shown as a person only where a member of the project's \
             organization has CONFIRMED it as theirs; anything less names nobody. \
             `members_known: false` means the directory could not be asked, and then no \
             account is called an outsider. Group by `waiting_on` on the client: a pull \
             request waiting on two reviewers is in both of their queues.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "project_id",
            true,
            "The project whose pull requests to read",
        )
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first pull request",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(open_pull_requests)
        .json_response_with_schema::<WaitingPullRequestListDto>(
            openapi,
            StatusCode::OK,
            "Open pull requests and who they are waiting on",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-artifact-ingest/v1/nodes")
        .operation_id("studio_artifact_ingest.list_nodes")
        .summary("List ingested artifact nodes")
        .description(
            "Reads back the artifact nodes upserted by /sync, optionally \
             filtered to a type (issue, pull_request, repo).",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "type",
            false,
            "GTS type id, or its bare leaf (issue, repo, ...)",
        )
        .query_param("scope", false, "Workspace or project tenant to scope to")
        .query_param("repo", false, "Instance id of the repo node to filter by")
        .query_param(
            "sort",
            false,
            "`updated` for newest first; default is by instance id",
        )
        .query_param(
            "q",
            false,
            "Case-insensitive substring over title/author/path/number",
        )
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first node",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(list_nodes)
        .json_response_with_schema::<ArtifactNodeListResponse>(
            openapi,
            StatusCode::OK,
            "Ingested nodes",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-artifact-ingest/v1/edges")
        .operation_id("studio_artifact_ingest.list_edges")
        .summary("List relations between ingested artifact nodes")
        .description(
            "Reads back the relations upserted by /sync — authored_by, modifies, \
             artifact_of, contains — as endpoint instance-id pairs, so the portal \
             can draw links between the nodes it already holds.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("scope", false, "Workspace or project tenant to scope to")
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first edge",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(list_edges)
        .json_response_with_schema::<ArtifactEdgeListResponse>(
            openapi,
            StatusCode::OK,
            "Ingested relations",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-artifact-ingest/v1/repo-files")
        .operation_id("studio_artifact_ingest.repo_files")
        .summary("Text files from a repository checkout")
        .description(
            "Returns the text files (path and content) of the studio-session \
             checkout for one repository, so analysis can run over the actual \
             repo. Empty until the IDE has cloned it.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .handler(repo_files)
        .json_response_with_schema::<RepoFilesResponse>(openapi, StatusCode::OK, "Repository files")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-artifact-ingest/v1/quality")
        .operation_id("studio_artifact_ingest.save_quality")
        .summary("Persist spec-quality detector results into the artifact graph")
        .description(
            "Upserts, per document, a spec_finding node (bloat/traceability/leak/\
             purpose) with its finding_on edge, plus the derived document↔document \
             relations (duplicates, traces_to) the portal built from a detector \
             result. Idempotent by (detector, document).",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<QualityFindingsRequest>(openapi, "Findings and derived links")
        .handler(save_quality)
        .json_response_with_schema::<QualityFindingsResponse>(
            openapi,
            StatusCode::OK,
            "Upsert counts",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-artifact-ingest/v1/search")
        .operation_id("studio_artifact_ingest.search")
        .summary("Search the artifact graph (semantic when embeddings exist, else lexical)")
        .description(
            "Ranks artifact nodes against a free-text query. With node embeddings \
             present the store runs hybrid retrieval (vector similarity seeds a \
             graph walk, filtered by text); without them it falls back to a \
             lexical full-text match. The request shape is identical either way.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SearchRequest>(openapi, "Query text and limit")
        .handler(search)
        .json_response_with_schema::<ArtifactNodeListResponse>(
            openapi,
            StatusCode::OK,
            "Ranked matches, most relevant first",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-artifact-ingest/v1/files")
        .operation_id("studio_artifact_ingest.add_file")
        .summary("Register an uploaded or generated project artifact")
        .description(
            "Registers a file-storage object reference as a standard `file` node, \
             scoped by organization, workspace and project. The object bytes are \
             never sent to Graph Storage. Origin is `manual` or `generated`; \
             repository-ingested files use the separate sync path. Idempotent by \
             (project, path).",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ManualFileRequest>(openapi, "File to store")
        .handler(add_file)
        .json_response_with_schema::<ManualFileResponse>(openapi, StatusCode::OK, "Stored file id")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Ingest::new(service, hub)))
}
