//! REST surface for artifact ingest.
//!
//! `POST /studio-artifact-ingest/v1/sync` enqueues a background sync (issues,
//! pull requests and files) and returns a task id; `GET /tasks/{id}` polls it.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::service::IngestService;

/// Errors attributable to an artifact-ingest resource (e.g. an unknown task).
/// Five tokens in the segment (`vendor.package.namespace.type.vN`); `_` is the
/// empty namespace slot.
#[resource_error(gts_id!("cf.studio._.artifact_ingest.v1~"))]
pub struct StudioArtifactIngestError;

/// Service handle. `None` = the gear booted without any connector driver
/// linked; the route stays mounted and answers 503 with the reason.
#[derive(Clone)]
pub struct Ingest(pub Option<Arc<IngestService>>);

impl Ingest {
    fn get(&self) -> ApiResult<&Arc<IngestService>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "artifact ingest is not available in this deployment \
                     (no connector driver plugin is registered)",
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
    /// Workspace this repo belongs to. With `repo_dir`, lets ingest read the
    /// studio-session checkout (the same clone the IDE opens) instead of
    /// cloning its own. Omitted = fall back to own-clone / tree API.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Directory name of this repo under the workspace root (the source's
    /// `target`, or its `name`). Pairs with `workspace_id`.
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
    pub task_id: String,
    /// `queued` | `running` | `succeeded` | `failed`.
    pub status: String,
    pub repo_full_path: String,
    /// Current phase while running, or the error message on failure.
    pub message: Option<String>,
    /// Populated once `succeeded`.
    pub issues: u32,
    pub pull_requests: u32,
    pub files: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct NodesQuery {
    /// Type substring to filter by: `issue`, `pull_request` or `repo`.
    /// Omitted = every ingested node.
    #[serde(default)]
    pub r#type: Option<String>,
}

/// One ingested artifact node.
#[derive(Debug)]
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

async fn sync(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Json(req): Json<SyncRequest>,
) -> ApiResult<JsonBody<SyncEnqueued>> {
    let svc = ingest.get()?;
    // Resolve the token now, while we still have the request's security context;
    // the background job carries only the resolved token.
    let secret_ref = req.secret_ref.trim().to_string();
    let token = svc
        .resolve_token(&ctx, &secret_ref)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let task_id = svc.enqueue_sync(
        ctx,
        req.provider.trim().to_string(),
        req.base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        secret_ref,
        req.repo_full_path.trim().to_string(),
        req.since
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        token,
        req.workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        req.repo_dir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    );
    Ok(Json(SyncEnqueued {
        task_id,
        status: "queued".to_string(),
    }))
}

async fn task_status(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<TaskStatusResponse>> {
    let svc = ingest.get()?;
    let rec = svc.task(&id).ok_or_else(|| {
        StudioArtifactIngestError::not_found("no such sync task")
            .with_resource(id.clone())
            .create()
    })?;
    Ok(Json(TaskStatusResponse {
        task_id: rec.id,
        status: rec.status.as_str().to_string(),
        repo_full_path: rec.repo_full_path,
        message: rec.message,
        issues: rec.issues,
        pull_requests: rec.pull_requests,
        files: rec.files,
    }))
}

async fn list_nodes(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
    Query(q): Query<NodesQuery>,
) -> ApiResult<JsonBody<ArtifactNodeListResponse>> {
    let svc = ingest.get()?;
    let filter = q.r#type.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let nodes = svc
        .list_nodes(&ctx, filter)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ArtifactNodeListResponse {
        nodes: nodes
            .into_iter()
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
            .collect(),
    }))
}

async fn list_edges(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ingest): Extension<Ingest>,
) -> ApiResult<JsonBody<ArtifactEdgeListResponse>> {
    let svc = ingest.get()?;
    let edges = svc
        .list_relations(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ArtifactEdgeListResponse {
        edges: edges
            .into_iter()
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

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<IngestService>>,
) -> Router {
    let router = OperationBuilder::post("/studio-artifact-ingest/v1/sync")
        .operation_id("studio_artifact_ingest.sync")
        .summary("Enqueue a background sync of a connector source into the graph")
        .description(
            "Resolves the connector driver and token, then runs a background \
             sync: issues and pull requests from the API, and files from a \
             shallow git clone (or the tree API when no volume is mounted). \
             Returns a task id to poll.",
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
        .description("Returns the status of a sync task and, once succeeded, its counts.")
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Sync task id")
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

    router.layer(Extension(Ingest(service)))
}
