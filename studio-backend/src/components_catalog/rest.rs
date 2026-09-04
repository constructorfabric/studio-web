//! REST surface for the gears catalog.
//!
//! `POST /studio-components-catalog/v1/sync` enqueues a background sync of the
//! crates.io keyword into the graph and returns a task id; `GET /tasks/{id}`
//! polls it. `GET /gears` and `GET /versions` read the catalog back.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::service::{CatalogService, RepoSource, SyncSources};
use uuid::Uuid;

/// Errors attributable to a components-catalog resource (e.g. an unknown task).
#[resource_error(gts_id!("cf.studio._.components_catalog.v1~"))]
pub struct StudioComponentsCatalogError;

/// Service handle, injected into the handlers.
#[derive(Clone)]
pub struct Catalog(pub Arc<CatalogService>);

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Acknowledgement that a sync was accepted and is running in the background.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogSyncEnqueued {
    /// Poll `GET /studio-components-catalog/v1/tasks/{task_id}` for the outcome.
    pub task_id: String,
    pub status: String,
}

/// The state of a background catalog sync task.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogTaskStatusResponse {
    pub task_id: String,
    /// `queued` | `running` | `succeeded` | `failed`.
    pub status: String,
    /// Current phase while running, or the error message on failure.
    pub message: Option<String>,
    /// Live counts, updated per gear while running.
    pub gears: u32,
    pub versions: u32,
    /// Nodes already flushed to the graph store.
    pub stored: u32,
}

/// One catalog node (gear or crate_version).
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogNodeDto {
    /// GTS type id, e.g. `gts.cf.studio.catalog.gear.v1~`.
    pub type_id: String,
    /// Deterministic instance id.
    pub instance_id: String,
    /// The curated crate/version payload.
    #[schema(value_type = Object)]
    pub value: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogNodeListResponse {
    pub nodes: Vec<CatalogNodeDto>,
}

/// Open, Studio-owned metadata for a gear. The payload is intentionally
/// extensible: it holds delivery metrics and links that crates.io cannot know.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveGearProfileRequest {
    #[schema(value_type = Object)]
    pub profile: Value,
}

/// One file of a scaffolded gear to write into the repo.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ScaffoldFileDto {
    pub path: String,
    pub content: String,
}

/// Write a scaffolded gear skeleton into the project's connected gear repo.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ScaffoldRequest {
    /// Gear slug, used for the branch name `scaffold/<slug>`.
    pub slug: String,
    pub files: Vec<ScaffoldFileDto>,
    /// Open a pull request back into the base branch (default false).
    pub open_pr: Option<bool>,
}

/// Where the scaffold landed.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ScaffoldResultDto {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
}

/// Create a new repository via the connector and set it as the project's gear repo.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateRepoRequest {
    /// Tenant that owns the connection (usually the workspace/organization).
    pub tenant: Uuid,
    /// Connector connection id; when omitted the first GitHub connection is used.
    pub connection_id: Option<Uuid>,
    /// Organization login when `is_org`; empty/None = under the authed user.
    pub owner: Option<String>,
    /// Create under an organization (`owner`) rather than the user.
    pub is_org: Option<bool>,
    /// New repository name (without owner).
    pub name: String,
    /// Private repository (default true).
    pub private: Option<bool>,
}

/// The created repository.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CreateRepoResultDto {
    pub full_name: String,
    pub html_url: String,
    pub default_branch: String,
}

/// The gear repository connected to a project — where its gears live and where
/// scaffolded gears are written.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetProjectRepoRequest {
    /// Tenant that owns the connection (usually the workspace/organization).
    pub tenant: Uuid,
    /// Connector connection id; when omitted the first GitHub connection is used.
    pub connection_id: Option<Uuid>,
    /// `owner/name` of the repository.
    pub repo: String,
    /// Branch scaffolded gears are written to (default `main`).
    pub branch: Option<String>,
}

/// A repository source picked on the Gears page.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RepoSourceDto {
    /// Tenant that owns the connection (usually the workspace/organization).
    pub tenant: Uuid,
    /// Connection to use; when omitted the first GitHub connection is taken.
    pub connection_id: Option<Uuid>,
    /// `owner/name` of the repository.
    pub repo: String,
    /// Git ref to read (default `HEAD`).
    pub git_ref: Option<String>,
    /// Discovery mode: `"gears"` (default) or `"frontx"`.
    pub mode: Option<String>,
}

/// Which sources one sync should read. Omit the body to sync crates.io with the
/// default keyword (back-compatible).
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SyncRequestDto {
    /// crates.io keyword; `null`/absent disables the crates.io source.
    pub crates_io: Option<String>,
    /// Repository sources (gears repo, FrontX repo, …).
    pub repositories: Option<Vec<RepoSourceDto>>,
}

impl SyncRequestDto {
    fn into_sources(self, default_keyword: &str) -> SyncSources {
        let repos: Vec<RepoSource> = self
            .repositories
            .unwrap_or_default()
            .into_iter()
            .filter(|r| !r.repo.trim().is_empty())
            .map(|r| RepoSource {
                tenant: r.tenant,
                connection_id: r.connection_id,
                repo: r.repo,
                git_ref: r.git_ref.unwrap_or_default(),
                mode: r.mode.unwrap_or_else(|| "gears".to_string()),
            })
            .collect();
        let crates_io = match self.crates_io {
            Some(k) if !k.trim().is_empty() => Some(k.trim().to_string()),
            Some(_) => None,
            None => {
                if repos.is_empty() {
                    Some(default_keyword.to_string())
                } else {
                    None
                }
            }
        };
        SyncSources { crates_io, repos }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct VersionsQuery {
    /// Optional crate name (query param `crate`) to filter versions to one gear.
    #[serde(rename = "crate", default)]
    pub crate_name: Option<String>,
}

async fn sync(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    body: Option<Json<SyncRequestDto>>,
) -> ApiResult<JsonBody<CatalogSyncEnqueued>> {
    let sources = match body {
        Some(Json(req)) => req.into_sources(catalog.0.default_keyword()),
        None => SyncSources {
            crates_io: Some(catalog.0.default_keyword().to_string()),
            repos: Vec::new(),
        },
    };
    let task_id = catalog.0.enqueue_sync(ctx, sources);
    Ok(Json(CatalogSyncEnqueued {
        task_id,
        status: "queued".to_string(),
    }))
}

async fn task_status(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<CatalogTaskStatusResponse>> {
    let rec = catalog.0.task(&id).ok_or_else(|| {
        StudioComponentsCatalogError::not_found("no such sync task")
            .with_resource(id.clone())
            .create()
    })?;
    Ok(Json(CatalogTaskStatusResponse {
        task_id: rec.id,
        status: rec.status.as_str().to_string(),
        message: rec.message,
        gears: rec.gears,
        versions: rec.versions,
        stored: rec.stored,
    }))
}

fn to_dtos(nodes: Vec<super::gts::GtsNode>) -> Vec<CatalogNodeDto> {
    nodes
        .into_iter()
        .map(|n| CatalogNodeDto {
            type_id: n.type_id.to_string(),
            instance_id: n.instance_id,
            value: n.value,
        })
        .collect()
}

async fn list_gears(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let nodes = catalog
        .0
        .list_nodes(&ctx, Some(super::gts::GEAR_TYPE))
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(nodes),
    }))
}

async fn list_profiles(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let nodes = catalog
        .0
        .list_profiles(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(nodes),
    }))
}

async fn save_profile(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
    Json(body): Json<SaveGearProfileRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let node = catalog
        .0
        .save_profile(&ctx, &name, body.profile)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("invalid gear profile: {e:#}"))
                .create()
        })?;
    let dto = to_dtos(vec![node])
        .into_iter()
        .next()
        .expect("one profile node converts to one DTO");
    Ok(Json(dto))
}

async fn get_project_repo(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let node = catalog
        .0
        .get_project_repo(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(node.into_iter().collect()),
    }))
}

async fn set_project_repo(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<SetProjectRepoRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let repo = serde_json::json!({
        "tenant": body.tenant,
        "connection_id": body.connection_id,
        "repo": body.repo,
        "branch": body.branch.unwrap_or_else(|| "main".to_string()),
    });
    let node = catalog
        .0
        .set_project_repo(&ctx, &project_id.to_string(), repo)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("invalid gear repo: {e:#}"))
                .create()
        })?;
    let dto = to_dtos(vec![node])
        .into_iter()
        .next()
        .expect("one node converts to one DTO");
    Ok(Json(dto))
}

async fn scaffold_gear(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<ScaffoldRequest>,
) -> ApiResult<JsonBody<ScaffoldResultDto>> {
    let files = body
        .files
        .into_iter()
        .map(|f| super::scaffold::ScaffoldFile {
            path: f.path,
            content: f.content,
        })
        .collect();
    let w = catalog
        .0
        .scaffold_into_repo(
            &ctx,
            &project_id.to_string(),
            &body.slug,
            files,
            body.open_pr.unwrap_or(false),
        )
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("scaffold failed: {e:#}"))
                .create()
        })?;
    Ok(Json(ScaffoldResultDto {
        branch: w.branch,
        commit_sha: w.commit_sha,
        pr_url: w.pr_url,
    }))
}

async fn create_repo(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<CreateRepoRequest>,
) -> ApiResult<JsonBody<CreateRepoResultDto>> {
    let created = catalog
        .0
        .create_project_repo(
            &ctx,
            &project_id.to_string(),
            body.tenant,
            body.connection_id,
            body.owner.as_deref(),
            body.is_org.unwrap_or(false),
            &body.name,
            body.private.unwrap_or(true),
        )
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("create repo failed: {e:#}"))
                .create()
        })?;
    Ok(Json(CreateRepoResultDto {
        full_name: created.full_name,
        html_url: created.html_url,
        default_branch: created.default_branch,
    }))
}

async fn list_versions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Query(q): Query<VersionsQuery>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let mut nodes = catalog
        .0
        .list_nodes(&ctx, Some("crate_version"))
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    if let Some(name) = q
        .crate_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        nodes.retain(|n| n.value.get("crate").and_then(Value::as_str) == Some(name));
    }
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(nodes),
    }))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<CatalogService>,
) -> Router {
    let router = OperationBuilder::post("/studio-components-catalog/v1/sync")
        .operation_id("studio_components_catalog.sync")
        .summary("Enqueue a background sync of the crates.io keyword into the graph")
        .description(
            "Lists every crate under the configured keyword (constructorfabric), \
             fetches each crate's detail and version history from crates.io, and \
             upserts gear + crate_version nodes (joined by has_version) into the \
             graph. Returns a task id to poll.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SyncRequestDto>(openapi, "Sources to sync")
        .handler(sync)
        .json_response_with_schema::<CatalogSyncEnqueued>(openapi, StatusCode::OK, "Sync enqueued")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/tasks/{id}")
        .operation_id("studio_components_catalog.task_status")
        .summary("Poll a background catalog sync task")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Sync task id")
        .handler(task_status)
        .json_response_with_schema::<CatalogTaskStatusResponse>(
            openapi,
            StatusCode::OK,
            "Task status",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/components")
        .operation_id("studio_components_catalog.list_gears")
        .summary("List the ingested gear crates")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_gears)
        .json_response_with_schema::<CatalogNodeListResponse>(openapi, StatusCode::OK, "Gears")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/versions")
        .operation_id("studio_components_catalog.list_versions")
        .summary("List ingested crate versions, optionally filtered to one crate")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_versions)
        .json_response_with_schema::<CatalogNodeListResponse>(openapi, StatusCode::OK, "Versions")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/profiles")
        .operation_id("studio_components_catalog.list_profiles")
        .summary("List Studio-managed, editable Gear profiles")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_profiles)
        .json_response_with_schema::<CatalogNodeListResponse>(
            openapi,
            StatusCode::OK,
            "Gear profiles",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-components-catalog/v1/components/{name}/profile")
        .operation_id("studio_components_catalog.save_profile")
        .summary("Create or replace Studio-managed metadata for one Gear")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Crate name")
        .handler(save_profile)
        .json_request::<SaveGearProfileRequest>(openapi, "Gear profile")
        .json_response_with_schema::<CatalogNodeDto>(openapi, StatusCode::OK, "Saved Gear profile")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router =
        OperationBuilder::get("/studio-components-catalog/v1/projects/{project_id}/gear-repo")
            .operation_id("studio_components_catalog.get_project_repo")
            .summary("The gear repository connected to a project (0 or 1 node)")
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .handler(get_project_repo)
            .json_response_with_schema::<CatalogNodeListResponse>(
                openapi,
                StatusCode::OK,
                "Connected gear repo",
            )
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/projects/{project_id}/gear-repo")
            .operation_id("studio_components_catalog.set_project_repo")
            .summary("Connect (or update) the gear repository for a project")
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .handler(set_project_repo)
            .json_request::<SetProjectRepoRequest>(openapi, "Gear repository")
            .json_response_with_schema::<CatalogNodeDto>(
                openapi,
                StatusCode::OK,
                "Connected gear repo",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/projects/{project_id}/scaffold")
            .operation_id("studio_components_catalog.scaffold_gear")
            .summary("Write a scaffolded gear skeleton into the project's connected gear repo")
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .handler(scaffold_gear)
            .json_request::<ScaffoldRequest>(openapi, "Gear scaffold")
            .json_response_with_schema::<ScaffoldResultDto>(
                openapi,
                StatusCode::OK,
                "Scaffold written",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/projects/{project_id}/create-repo")
            .operation_id("studio_components_catalog.create_repo")
            .summary(
                "Create a new repository via the connector and set it as the project's gear repo",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .handler(create_repo)
            .json_request::<CreateRepoRequest>(openapi, "New repository")
            .json_response_with_schema::<CreateRepoResultDto>(
                openapi,
                StatusCode::OK,
                "Created repository",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router.layer(Extension(Catalog(service)))
}
