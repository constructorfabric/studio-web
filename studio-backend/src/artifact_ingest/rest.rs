//! REST surface for artifact ingest.
//!
//! `POST /studio-artifact-ingest/v1/sync` enqueues a background sync (issues,
//! pull requests and files) and returns a task id; `GET /tasks/{id}` polls it.
//!
//! Both are served by `studio-tasks` now: the task id *is* a run id, so
//! `GET /studio-tasks/v1/runs/{task_id}` answers the same question with more
//! detail, and the sync survives the process that accepted it. The response
//! shapes here are unchanged.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::ingest_task::{IngestPayload, TASK_TYPE};
use super::service::{IngestService, ProjectArtifact, SyncSummary};

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
    /// Poll `GET /studio-artifact-ingest/v1/tasks/{task_id}` for the outcome.
    pub task_id: String,
    /// `queued` at enqueue time.
    pub status: String,
}

/// The state of a background sync task.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TaskStatusResponse {
    /// The run id. `GET /studio-tasks/v1/runs/{task_id}` has the full record.
    pub task_id: String,
    /// `queued` | `running` | `succeeded` | `failed` | `cancelled`.
    pub status: String,
    pub repo_full_path: String,
    /// Current phase while running, or the error message on failure.
    pub message: Option<String>,
    /// Live counts, updated per phase while running (not only on success) so the
    /// portal can show progress as objects are pulled and stored.
    pub issues: u32,
    pub pull_requests: u32,
    pub files: u32,
    pub comments: u32,
    pub commits: u32,
    /// Nodes already flushed to the graph store so far — the objects that are
    /// queryable right now, mid-sync.
    pub stored: u32,
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
}

/// True when a node's `value` is inside `scope` — i.e. its `workspace_id` or
/// its `project_id` equals `scope`. Used to keep a project's (or workspace's)
/// graph to its own artifacts. A `None` scope admits everything.
fn node_in_scope(value: &Value, scope: Option<&str>) -> bool {
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
    Json(req): Json<SyncRequest>,
) -> ApiResult<JsonBody<SyncEnqueued>> {
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
    // Resolved here and thrown away: the run resolves its own token per
    // attempt (a queue row is no place for one), but a `secret_ref` this caller
    // cannot read should be a 500 on this request rather than a run that
    // dead-letters where nobody is looking.
    svc.resolve_token(&ctx, &secret_ref)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let trimmed = |v: Option<&str>| {
        v.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let workspace_id = trimmed(req.workspace_id.as_deref());
    let project_id = trimmed(req.project_id.as_deref());
    let payload = serde_json::to_value(IngestPayload {
        provider: provider.clone(),
        base_url: trimmed(req.base_url.as_deref()),
        secret_ref: secret_ref.clone(),
        repo_full_path: repo_full_path.clone(),
        since: trimmed(req.since.as_deref()),
        workspace_id: workspace_id.clone(),
        project_id: project_id.clone(),
        repo_dir: trimmed(req.repo_dir.as_deref()),
    })
    .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    // Two syncs that would write the same graph keys must not run at once.
    // Those keys are built from exactly these four things (see `gts::*_node`),
    // so the same four make the partition key: the same repository under a
    // different project is a different set of nodes and may run in parallel.
    let scope = project_id
        .as_deref()
        .or(workspace_id.as_deref())
        .unwrap_or("unscoped");
    let partition_key = format!("{provider}:{secret_ref}:{scope}:{repo_full_path}");

    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::service::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: TASK_TYPE,
                payload,
                partition_key: Some(&partition_key),
                idempotency_key: None,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    Ok(Json(SyncEnqueued {
        task_id: run_id.to_string(),
        status: "queued".to_string(),
    }))
}

/// The state of one background sync.
///
/// Served from the `artifact.ingest` run rather than from a registry of this
/// gear's own: same response shape, but it survives a restart and the counts
/// come from the run's `result` — which the sync updates per phase, so they
/// tick up while it works.
async fn task_status(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<TaskStatusResponse>> {
    let queue = ingest.queue()?;
    let not_found = || {
        StudioArtifactIngestError::not_found("no such sync task")
            .with_resource(id.clone())
            .create()
    };
    // Task ids used to be this gear's own strings; they are run ids now, and an
    // unparseable one is simply not a task this deployment has.
    let run_id = Uuid::parse_str(&id).map_err(|_| not_found())?;
    let run = queue
        .run(ctx.subject_tenant_id(), run_id)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .ok_or_else(not_found)?;

    let payload: Option<IngestPayload> = serde_json::from_value(run.payload).ok();
    let counts = SyncSummary::of_result(run.result);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Json(TaskStatusResponse {
        task_id: id,
        status: run.state.as_str().to_string(),
        repo_full_path: payload.map(|p| p.repo_full_path).unwrap_or_default(),
        // What it did if it finished, why it stopped if it failed, where it is
        // if it is still going — in that order of usefulness to whoever is
        // polling.
        message: run.summary.or(run.last_error).or(run.progress),
        issues: count(counts.issues),
        pull_requests: count(counts.pull_requests),
        files: count(counts.files),
        comments: count(counts.comments),
        commits: count(counts.commits),
        stored: count(counts.stored),
    }))
}
async fn list_nodes(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(q): Query<NodesQuery>,
) -> ApiResult<JsonBody<ArtifactNodeListResponse>> {
    let svc = ingest.get()?;
    let filter = q.r#type.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let scope = q.scope.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let nodes = svc
        .list_nodes(&ctx, filter)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let repo = q.repo.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let needle =
        q.q.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
    let mut nodes: Vec<_> = nodes
        .into_iter()
        .filter(|n| node_in_scope(&n.value, scope))
        // Optional repository filter: keep nodes whose `repo` matches. Repo
        // nodes themselves carry no `repo` field, so they drop out when a repo
        // filter is set — which is the intent (you're listing its contents).
        .filter(|n| match repo {
            Some(r) => n.value.get("repo").and_then(Value::as_str) == Some(r),
            None => true,
        })
        // Optional text search over the human-facing fields.
        .filter(|n| match &needle {
            None => true,
            Some(needle) => {
                let v = &n.value;
                let hay = [
                    v.get("title").and_then(Value::as_str).unwrap_or(""),
                    v.get("author").and_then(Value::as_str).unwrap_or(""),
                    v.get("path").and_then(Value::as_str).unwrap_or(""),
                    v.get("full_path").and_then(Value::as_str).unwrap_or(""),
                ]
                .join(" ")
                .to_lowercase();
                let num = v
                    .get("number")
                    .and_then(Value::as_i64)
                    .map(|n| n.to_string())
                    .unwrap_or_default();
                hay.contains(needle.as_str()) || num.contains(needle.as_str())
            }
        })
        .map(|n| {
            // File nodes carry full text content; drop it from the listing
            // so the payload stays small (`has_text` still flags it). A
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
    // Order: newest `updated_at` first when asked, else a stable order by
    // instance id (the graph adapters may return storage pages in any order).
    // ISO-8601 timestamps sort lexically, so a string compare is chronological.
    if q.sort.as_deref() == Some("updated") {
        nodes.sort_by(|a, b| {
            let ua = a
                .value
                .get("updated_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            let ub = b
                .value
                .get("updated_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            ub.cmp(ua).then_with(|| a.instance_id.cmp(&b.instance_id))
        });
    } else {
        nodes.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    }
    // The full filtered set is the total; pagination only slices a window of it.
    let total = nodes.len() as u32;
    // Offset wins when present (classic paginator); otherwise resolve the legacy
    // cursor to the position just after it.
    let start = match q.offset {
        Some(offset) => offset.min(nodes.len()),
        None => q
            .cursor
            .as_deref()
            .and_then(|cursor| {
                nodes
                    .iter()
                    .position(|node: &ArtifactNodeDto| node.instance_id == cursor)
            })
            .map(|index| index + 1)
            .unwrap_or(0),
    };
    let end = (start + limit).min(nodes.len());
    let page = nodes[start..end].to_vec();
    let next_cursor = (end < nodes.len())
        .then(|| page.last().map(|node| node.instance_id.clone()))
        .flatten();
    Ok(Json(ArtifactNodeListResponse {
        nodes: page,
        total,
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
    let in_scope: Option<std::collections::HashSet<String>> = if scope.is_some() {
        let nodes = svc
            .list_nodes(&ctx, None)
            .await
            .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
        Some(
            nodes
                .into_iter()
                .filter(|n| node_in_scope(&n.value, scope))
                .map(|n| n.instance_id)
                .collect(),
        )
    } else {
        None
    };
    let edges = svc
        .list_relations(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ArtifactEdgeListResponse {
        edges: edges
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
            .collect(),
    }))
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
             Returns a task id to poll — which is also a run id, so \
             `GET /studio-tasks/v1/runs/{id}` can cancel or retry it.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SyncRequest>(openapi, "Source to ingest")
        .handler(sync)
        .json_response_with_schema::<SyncEnqueued>(openapi, StatusCode::OK, "Sync enqueued")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-artifact-ingest/v1/tasks/{id}")
        .operation_id("studio_artifact_ingest.task_status")
        .summary("Poll a background sync task")
        .description(
            "Returns the status of a sync task and its counts, which tick up per \
             phase while it runs. 404 once the run has been pruned by the \
             retention sweep.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Sync task id (a studio-tasks run id)")
        .handler(task_status)
        .json_response_with_schema::<TaskStatusResponse>(openapi, StatusCode::OK, "Task status")
        .error_401(openapi)
        .error_404(openapi)
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
