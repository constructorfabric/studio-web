//! REST surface for the gears catalog.
//!
//! `POST /studio-components-catalog/v1/sync` enqueues a background sync of the
//! crates.io keyword into the graph and returns a task id; `GET /tasks/{id}`
//! polls it. `GET /gears` and `GET /versions` read the catalog back.
//!
//! The sync is a `catalog.sync` run on `studio-tasks`, so the task id is a run
//! id and `GET /studio-tasks/v1/runs/{task_id}` answers the same question with
//! more detail. The response shapes here are unchanged.

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

use super::service::{CatalogCounts, CatalogService, RepoSource, SyncSources};
use super::sync_task::TASK_TYPE;
use uuid::Uuid;

/// Errors attributable to a components-catalog resource (e.g. an unknown task).
#[resource_error(gts_id!("cf.studio._.components_catalog.v1~"))]
pub struct StudioComponentsCatalogError;

/// Service handle, injected into the handlers.
#[derive(Clone)]
pub struct Catalog {
    pub service: Arc<CatalogService>,
    /// Resolved per request rather than held: a sync is a run now, and both the
    /// enqueue and the poll endpoint read through here — lazily, so this gear
    /// does not care whether `studio-tasks` initialized first.
    hub: Arc<ClientHub>,
}

impl Catalog {
    pub fn new(service: Arc<CatalogService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }

    fn queue(&self) -> ApiResult<Arc<dyn crate::tasks::TaskQueue>> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "catalog syncs are not available in this deployment \
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
    /// The run id. `GET /studio-tasks/v1/runs/{task_id}` has the full record.
    pub task_id: String,
    /// `queued` | `running` | `succeeded` | `failed` | `cancelled`.
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
    /// Whether a cap cut the list short. An organization can mark a type with
    /// six figures of instances as a component, and a page showing some of one
    /// without saying so is worse than a page that admits it.
    #[serde(default)]
    pub truncated: bool,
}

/// Open, Studio-owned metadata for a gear. The payload is intentionally
/// extensible: it holds delivery metrics and links that crates.io cannot know.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveGearProfileRequest {
    #[schema(value_type = Object)]
    pub profile: Value,
}

/// The field schemas this tenant renders component pages against.
///
/// Open shape on purpose. A schema is a layout, and this endpoint's job is to
/// let a deployment describe a component kind this build has never heard of —
/// pinning the JSON into a closed response DTO would put that behind a
/// release, which is the thing the schemas moved out of the client to escape.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct FieldSchemaListResponse {
    /// One entry per component type, `{describes, groups, composition,
    /// statusLegend, docStateLegend, sourceClasses, owner}`. `owner` is
    /// `builtin` or `tenant`, so a screen can offer to revert what it shows.
    #[schema(value_type = Vec<Object>)]
    pub schemas: Vec<Value>,
}

/// One GTS type the graph holds, and what this organization says about it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogTypeDto {
    /// The id graph-storage stores it under, ancestry and all. Empty when
    /// nothing has written a node of this type into this tenant's graph yet.
    pub type_id: String,
    /// The leaf of that id: how the type is named everywhere else, and the key
    /// a mark and a field schema are written against.
    pub leaf_id: String,
    /// A family or base. Derived from, never instantiated, so never a
    /// component — reported rather than filtered so a page can say why.
    pub is_abstract: bool,
    /// Whether this organization treats the type as a component.
    pub component: bool,
    /// Who authored the field schema it renders against: `builtin`, `tenant`
    /// or `none`.
    pub schema: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogTypeListResponse {
    pub types: Vec<CatalogTypeDto>,
}

/// How many nodes of one type the graph holds.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TypeCountDto {
    pub leaf_id: String,
    /// Exact, unless `capped` — then it is a floor, not a total.
    pub count: u64,
    /// Whether the count stopped at the cap rather than at the end of the
    /// type. A page that shows a capped number as if it were a total is
    /// telling its reader something untrue about their own graph.
    pub capped: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TypeCountListResponse {
    pub counts: Vec<TypeCountDto>,
}

/// Whether a type is one of this organization's components.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetTypeComponentRequest {
    pub component: bool,
}

/// This tenant's own schema for one component type, replacing what it inherits.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveFieldSchemaRequest {
    #[schema(value_type = Object)]
    pub schema: Value,
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
    /// Discovery mode: `"gears"` (default), `"frontx"` or `"kits"`.
    ///
    /// It selects what the scan looks for and, with it, what kind of component
    /// the repository contributes: a `gear.toml` directory, a FrontX package,
    /// or a `.cf-studio-kit.toml` manifest. Kits land as their own node type
    /// rather than as gears wearing a label.
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
    let queue = catalog.queue()?;
    let sources = match body {
        Some(Json(req)) => req.into_sources(catalog.service.default_keyword()),
        None => SyncSources {
            crates_io: Some(catalog.service.default_keyword().to_string()),
            repos: Vec::new(),
        },
    };
    let payload = serde_json::to_value(&sources)
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::service::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: TASK_TYPE,
                payload,
                // One catalog per tenant, upserted by deterministic node key:
                // two syncs at once would write the same gear nodes, so they
                // queue behind each other instead.
                partition_key: Some("catalog"),
                idempotency_key: None,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    Ok(Json(CatalogSyncEnqueued {
        task_id: run_id.to_string(),
        status: "queued".to_string(),
    }))
}

/// The state of one background catalog sync.
///
/// Served from the `catalog.sync` run rather than from a registry of this
/// gear's own: same response shape, but it survives a restart and the counts
/// come from the run's `result` — which the sync updates per phase, so they
/// tick up while it works.
async fn task_status(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<CatalogTaskStatusResponse>> {
    let queue = catalog.queue()?;
    let not_found = || {
        StudioComponentsCatalogError::not_found("no such sync task")
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

    let counts = CatalogCounts::of_result(run.result);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Json(CatalogTaskStatusResponse {
        task_id: id,
        status: run.state.as_str().to_string(),
        // What it did if it finished, why it stopped if it failed, where it is
        // if it is still going — in that order of usefulness to whoever is
        // polling.
        message: run.summary.or(run.last_error).or(run.progress),
        gears: count(counts.gears),
        versions: count(counts.versions),
        stored: count(counts.stored),
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

/// The components, which is now a question rather than a constant.
///
/// This used to read "nodes of `catalog.gear.v1~`", which put "what counts as
/// a component" in this file. It is a judgement about an organization's model,
/// so it belongs to the organization: the list is every node of every type it
/// marked on the Objects page.
async fn list_gears(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let (nodes, truncated) = catalog
        .service
        .list_component_nodes(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: nodes
            .into_iter()
            .map(|n| CatalogNodeDto {
                type_id: n.type_id,
                instance_id: n.instance_id,
                value: n.value,
            })
            .collect(),
        truncated,
    }))
}

async fn list_profiles(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let nodes = catalog
        .service
        .list_profiles(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(nodes),
        truncated: false,
    }))
}

async fn save_profile(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
    Json(body): Json<SaveGearProfileRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let node = catalog
        .service
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

async fn list_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CatalogTypeListResponse>> {
    let types = catalog
        .service
        .list_types(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogTypeListResponse {
        types: types
            .into_iter()
            .map(|t| CatalogTypeDto {
                type_id: t.type_id,
                leaf_id: t.leaf_id,
                is_abstract: t.is_abstract,
                component: t.component,
                schema: t.schema,
            })
            .collect(),
    }))
}

/// The instance count per type.
///
/// Its own endpoint because it costs one projection per type where the type
/// list costs two reads in total. The Objects page draws its table from
/// `/types` and fills these in after, so a graph with hundreds of types still
/// renders at once.
async fn count_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<TypeCountListResponse>> {
    let counts = catalog
        .service
        .count_types(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(TypeCountListResponse {
        counts: counts
            .into_iter()
            .map(|c| TypeCountDto {
                leaf_id: c.leaf_id,
                count: c.count as u64,
                capped: c.capped,
            })
            .collect(),
    }))
}

async fn set_type_component(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(type_id): Path<String>,
    Json(body): Json<SetTypeComponentRequest>,
) -> ApiResult<JsonBody<CatalogTypeDto>> {
    let record = catalog
        .service
        .set_type_component(&ctx, &type_id, body.component)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(CatalogTypeDto {
        // The caller named a leaf; reporting a graph id here would be
        // inventing one for a type the graph may not hold a node of.
        type_id: String::new(),
        leaf_id: record.describes,
        is_abstract: false,
        component: record.component,
        schema: record.owner,
    }))
}

async fn list_field_schemas(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<FieldSchemaListResponse>> {
    let schemas = catalog
        .service
        .list_field_schemas(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let schemas = schemas
        .into_iter()
        .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
        .filter(|v| !v.is_null())
        .collect();
    Ok(Json(FieldSchemaListResponse { schemas }))
}

async fn save_field_schema(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(describes): Path<String>,
    Json(body): Json<SaveFieldSchemaRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let saved = catalog
        .service
        .save_field_schema(&ctx, &describes, body.schema)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("invalid field schema: {e:#}"))
                .create()
        })?;
    let value = serde_json::to_value(&saved)
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeDto {
        type_id: super::gts::FIELD_SCHEMA_TYPE.to_string(),
        instance_id: super::gts::field_schema_instance_id(&saved.describes),
        value,
    }))
}

async fn delete_field_schema(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(describes): Path<String>,
) -> ApiResult<StatusCode> {
    catalog
        .service
        .delete_field_schema(&ctx, &describes)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_project_repo(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let node = catalog
        .service
        .get_project_repo(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(node.into_iter().collect()),
        truncated: false,
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
        .service
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
        .service
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
        .service
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
        .service
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
        truncated: false,
    }))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<CatalogService>,
    hub: Arc<ClientHub>,
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
        .path_param("id", "Sync task id (a studio-tasks run id)")
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
        .summary("List every node of every type this organization marks as a component")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_gears)
        .json_response_with_schema::<CatalogNodeListResponse>(openapi, StatusCode::OK, "Components")
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

    let router = OperationBuilder::get("/studio-components-catalog/v1/types")
        .operation_id("studio_components_catalog.list_types")
        .summary("Every node type the graph holds, and which are components here")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_types)
        .json_response_with_schema::<CatalogTypeListResponse>(
            openapi,
            StatusCode::OK,
            "Node types with their component mark and schema owner",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/types/counts")
        .operation_id("studio_components_catalog.count_types")
        .summary("How many nodes of each type the graph holds")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(count_types)
        .json_response_with_schema::<TypeCountListResponse>(
            openapi,
            StatusCode::OK,
            "Instance counts, exact up to a cap",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-components-catalog/v1/types/{type_id}/component")
        .operation_id("studio_components_catalog.set_type_component")
        .summary("Mark a type as one of this organization's components, or unmark it")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("type_id", "GTS type id (the leaf form)")
        .handler(set_type_component)
        .json_request::<SetTypeComponentRequest>(openapi, "The mark")
        .json_response_with_schema::<CatalogTypeDto>(
            openapi,
            StatusCode::OK,
            "The type as it now reads",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/field-schemas")
        .operation_id("studio_components_catalog.list_field_schemas")
        .summary("The field schema each component type is rendered against")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_field_schemas)
        .json_response_with_schema::<FieldSchemaListResponse>(
            openapi,
            StatusCode::OK,
            "Field schemas, built-ins overlaid by this tenant's own",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-components-catalog/v1/field-schemas/{describes}")
        .operation_id("studio_components_catalog.save_field_schema")
        .summary("Replace the field schema this tenant renders one component type against")
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("describes", "GTS type id the schema describes")
        .handler(save_field_schema)
        .json_request::<SaveFieldSchemaRequest>(openapi, "Field schema")
        .json_response_with_schema::<CatalogNodeDto>(openapi, StatusCode::OK, "Saved field schema")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router =
        OperationBuilder::delete("/studio-components-catalog/v1/field-schemas/{describes}")
            .operation_id("studio_components_catalog.delete_field_schema")
            .summary("Revert one component type to the built-in field schema")
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("describes", "GTS type id the schema describes")
            .handler(delete_field_schema)
            .no_content_response(StatusCode::NO_CONTENT, "Reverted")
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

    router.layer(Extension(Catalog::new(service, hub)))
}
