//! The two-level catalogue over REST (ADR-0061, `catalogue_levels.rs`).
//!
//! - `GET /components?project_id=` -- a project's catalogue: the
//!   organization's, and the project's own components (`tier: project`).
//!   Without `project_id`, the organization's, as before.
//! - `GET` / `PUT /platform/pins` -- the organization's platform release:
//!   every platform source it sees, and the version it holds each at.
//! - `POST /project-catalogue/sync?project_id=` -- read a project's
//!   repositories into its own catalogue now.
//! - `GET` / `POST /publications`, `POST /publications/{id}/decisions` -- a
//!   project proposes a component at a version; an administrator answers.
//! - `GET /components/{name}/docs?path=` -- one of a component's documents.

use super::*;
use crate::components_catalog::catalogue_levels::{
    ComponentDoc, LevelError, PlatformPin, Publication, PublicationAsk, PublishedArtifact,
};

/// One platform source the organization holds at a version of its own.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request, response)]
pub struct CataloguePlatformPinDto {
    /// `owner/name` of the platform source.
    pub repo: String,
    /// The tag or commit it is held at.
    pub git_ref: String,
    pub note: Option<String>,
    /// Set on a response: who pinned it, and when (RFC 3339).
    pub pinned_by: Option<String>,
    pub pinned_by_name: Option<String>,
    pub at: Option<String>,
}

/// One platform source as the organization sees it.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct CataloguePlatformSourceDto {
    pub repo: String,
    /// The ref the platform reads it at.
    pub git_ref: String,
    pub mode: String,
    /// The organization's pin, when it holds it at another version.
    pub pinned_ref: Option<String>,
    pub note: Option<String>,
    /// Who pinned it, and when (RFC 3339).
    pub pinned_by: Option<String>,
    pub pinned_by_name: Option<String>,
    pub pinned_at: Option<String>,
}

/// The organization's platform release.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CataloguePlatformPinsDto {
    /// Every platform source, with its pin when it has one: the organization
    /// sees each and cannot hide one. Never paged.
    pub items: Vec<CataloguePlatformSourceDto>,
    pub total: u32,
    /// An organization administrator: may change the pins.
    pub may_manage: bool,
}

/// The pins as they are to be; a source left out follows the platform.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CatalogueSetPinsRequest {
    pub items: Vec<CataloguePlatformPinDto>,
}

/// A published artifact (later: crate, npm package, image).
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request, response)]
pub struct CataloguePublishedArtifactDto {
    /// `crate`, `npm` or `image`.
    pub kind: String,
    pub reference: String,
}

/// A project's request to put a component into the organization's
/// catalogue at one version, and its answer.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct CataloguePublicationDto {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub project_name: Option<String>,
    pub type_id: String,
    pub name: String,
    pub kind: Option<String>,
    pub repo: Option<String>,
    pub path: Option<String>,
    /// The version published: a tag or a commit.
    pub git_ref: String,
    pub commit: Option<String>,
    /// What its passport says its version is.
    pub version: Option<String>,
    pub artifact: Option<CataloguePublishedArtifactDto>,
    pub reason: Option<String>,
    pub requested_by: String,
    pub requested_by_name: Option<String>,
    /// RFC 3339.
    pub at: String,
    /// `requested`, `approved` or `declined`.
    pub state: String,
    pub decided_by: Option<String>,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<String>,
    pub decline_reason: Option<String>,
}

/// The organization's publications, newest first.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CataloguePublicationsDto {
    pub items: Vec<CataloguePublicationDto>,
    pub total: u32,
    /// An organization administrator: may answer them.
    pub may_decide: bool,
}

/// What a project asks be published.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CatalogueRequestPublicationRequest {
    /// The component's name in the project's catalogue.
    pub name: String,
    /// Its node type, when two components share the name.
    pub type_id: Option<String>,
    /// The tag or commit to publish; the ref it was read at when absent.
    pub git_ref: Option<String>,
    pub commit: Option<String>,
    pub artifact: Option<CataloguePublishedArtifactDto>,
    pub reason: Option<String>,
}

/// An administrator's answer.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CataloguePublicationDecisionRequest {
    /// `approve` or `decline`.
    pub action: String,
    /// Required to decline.
    pub reason: Option<String>,
}

/// One of a component's documents.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogueComponentDocDto {
    pub name: String,
    /// From the repository root.
    pub path: String,
    pub repo: String,
    pub git_ref: String,
    /// Where it is on the host.
    pub url: String,
    pub text: String,
    /// Cut at 200 KiB.
    pub truncated: bool,
}

/// `?project_id=`, optional.
#[derive(Debug, Default, serde::Deserialize)]
pub(super) struct OptionalProject {
    #[serde(default)]
    pub(super) project_id: Option<String>,
    #[serde(default)]
    pub(super) state: Option<String>,
    #[serde(default)]
    pub(super) path: Option<String>,
}

fn pin_dto(p: PlatformPin) -> CataloguePlatformPinDto {
    CataloguePlatformPinDto {
        repo: p.repo,
        git_ref: p.git_ref,
        note: p.note,
        pinned_by: Some(p.pinned_by),
        pinned_by_name: p.pinned_by_name,
        at: Some(p.at),
    }
}

fn artifact_dto(a: PublishedArtifact) -> CataloguePublishedArtifactDto {
    CataloguePublishedArtifactDto {
        kind: a.kind,
        reference: a.reference,
    }
}

fn publication_dto(p: Publication) -> CataloguePublicationDto {
    CataloguePublicationDto {
        id: p.id,
        organization_id: p.organization_id,
        project_id: p.project_id,
        project_name: p.project_name,
        type_id: p.type_id,
        name: p.name,
        kind: p.kind,
        repo: p.repo,
        path: p.path,
        git_ref: p.git_ref,
        commit: p.commit,
        version: p.version,
        artifact: p.artifact.map(artifact_dto),
        reason: p.reason,
        requested_by: p.requested_by,
        requested_by_name: p.requested_by_name,
        at: p.at,
        state: p.state,
        decided_by: p.decided_by,
        decided_by_name: p.decided_by_name,
        decided_at: p.decided_at,
        decline_reason: p.decline_reason,
    }
}

fn level_problem(e: LevelError) -> CanonicalError {
    let message = e.to_string();
    match e {
        LevelError::Invalid { field, .. } => StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(field, message, "INVALID")
            .create(),
        LevelError::NotFound(what) => StudioComponentsCatalogError::not_found(message)
            .with_resource(what)
            .create(),
        LevelError::Answered(state) => StudioComponentsCatalogError::failed_precondition()
            .with_precondition_violation(
                format!("state:{state}"),
                message,
                "PUBLICATION_ALREADY_ANSWERED",
            )
            .create(),
    }
}

fn admin_refusal() -> CanonicalError {
    StudioComponentsCatalogError::permission_denied()
        .with_reason("REGISTRY_ADMIN_REQUIRED")
        .create()
}

/// The caller acting in the project `raw` names: a project of the
/// organization `ctx` acts in, which the caller reaches. 404 otherwise, as
/// an organization the caller does not reach is.
pub(super) async fn project_ctx(
    catalog: &Catalog,
    ctx: &SecurityContext,
    access: Option<&crate::org_scope::OrgAccess>,
    raw: &str,
) -> ApiResult<SecurityContext> {
    let project = Uuid::parse_str(raw.trim()).map_err(|_| {
        StudioComponentsCatalogError::invalid_argument()
            .with_field_violation("project_id", "must be a UUID".to_owned(), "INVALID")
            .create()
    })?;
    let org = ctx.subject_tenant_id();
    let not_found = || {
        StudioComponentsCatalogError::not_found(format!(
            "there is no project {project} in this organization for this caller"
        ))
        .with_resource(project.to_string())
        .create()
    };
    if project == org || !catalog.service.tenant_within(ctx, org, project).await {
        return Err(not_found());
    }
    match access {
        Some(access) => crate::org_scope::resolve(access.0.as_ref(), ctx, Some(project))
            .await
            .map_err(|_| not_found()),
        // A deployment that resolves no organizations has one caller's tree.
        None => crate::components_catalog::registry::in_tenant(ctx, project).map_err(internal),
    }
}

/// The project's name, as account-management says.
async fn project_name(catalog: &Catalog, ctx: &SecurityContext, project: Uuid) -> Option<String> {
    catalog.service.tenant_name(ctx, project).await
}

pub(super) async fn list_pins(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CataloguePlatformPinsDto>> {
    let pins = catalog
        .service
        .platform_pins(&ctx)
        .await
        .map_err(internal)?;
    let sources = catalog
        .service
        .platform_sources_seen(&ctx)
        .await
        .map_err(internal)?;
    let items: Vec<CataloguePlatformSourceDto> = sources
        .into_iter()
        .map(|s| {
            let pin = pins
                .iter()
                .find(|p| p.repo.eq_ignore_ascii_case(s.repo.trim()))
                .cloned()
                .map(pin_dto);
            CataloguePlatformSourceDto {
                repo: s.repo,
                git_ref: s.git_ref,
                mode: s.mode,
                pinned_ref: pin.as_ref().map(|p| p.git_ref.clone()),
                note: pin.as_ref().and_then(|p| p.note.clone()),
                pinned_by: pin.as_ref().and_then(|p| p.pinned_by.clone()),
                pinned_by_name: pin.as_ref().and_then(|p| p.pinned_by_name.clone()),
                pinned_at: pin.and_then(|p| p.at),
            }
        })
        .collect();
    Ok(Json(CataloguePlatformPinsDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        may_manage: may_decide(catalog.authority().as_deref(), &ctx).await,
    }))
}

pub(super) async fn update_pins(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<CatalogueSetPinsRequest>,
) -> ApiResult<JsonBody<CataloguePlatformPinsDto>> {
    if !may_decide(catalog.authority().as_deref(), &ctx).await {
        return Err(admin_refusal());
    }
    let me = catalog.decider(&ctx).await;
    let now = crate::components_catalog::registry::now();
    let previous = catalog
        .service
        .platform_pins(&ctx)
        .await
        .map_err(internal)?;
    let pins: Vec<PlatformPin> = body
        .items
        .into_iter()
        .map(|p| {
            // An unchanged pin keeps who set it and when.
            match previous.iter().find(|o| {
                o.repo.eq_ignore_ascii_case(p.repo.trim()) && o.git_ref == p.git_ref.trim()
            }) {
                Some(kept) => PlatformPin {
                    note: p.note.clone(),
                    ..kept.clone()
                },
                None => PlatformPin {
                    repo: p.repo,
                    git_ref: p.git_ref,
                    note: p.note,
                    pinned_by: me.id.clone(),
                    pinned_by_name: me.name.clone(),
                    at: now.clone(),
                },
            }
        })
        .collect();
    catalog
        .service
        .set_platform_pins(&ctx, pins)
        .await
        .map_err(internal)?
        .map_err(level_problem)?;
    list_pins(OrgCtx(ctx), Extension(catalog)).await
}

pub(super) async fn sync_project_catalogue(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    access: Option<Extension<crate::org_scope::OrgAccess>>,
    Query(q): Query<OptionalProject>,
) -> ApiResult<(StatusCode, JsonBody<CatalogSyncEnqueued>)> {
    let raw = q.project_id.unwrap_or_default();
    let pctx = project_ctx(&catalog, &ctx, access.as_ref().map(|a| &a.0), &raw).await?;
    let run = catalog
        .service
        .queue_project_sync(&ctx, pctx.subject_tenant_id())
        .await
        .map_err(internal)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(CatalogSyncEnqueued {
            run_id: run.to_string(),
            status: "queued".to_string(),
        }),
    ))
}

pub(super) async fn list_publications(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    access: Option<Extension<crate::org_scope::OrgAccess>>,
    Query(q): Query<OptionalProject>,
) -> ApiResult<JsonBody<CataloguePublicationsDto>> {
    let project = match q.project_id.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(raw) => Some(
            project_ctx(&catalog, &ctx, access.as_ref().map(|a| &a.0), raw)
                .await?
                .subject_tenant_id(),
        ),
        None => None,
    };
    let state = q.state.map(|s| s.trim().to_ascii_lowercase());
    let items: Vec<CataloguePublicationDto> = catalog
        .service
        .publications(&ctx, project)
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|p| {
            state
                .as_deref()
                .is_none_or(|s| s.is_empty() || p.state == s)
        })
        .map(publication_dto)
        .collect();
    Ok(Json(CataloguePublicationsDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        may_decide: may_decide(catalog.authority().as_deref(), &ctx).await,
    }))
}

pub(super) async fn request_publication(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    access: Option<Extension<crate::org_scope::OrgAccess>>,
    Query(q): Query<OptionalProject>,
    Json(body): Json<CatalogueRequestPublicationRequest>,
) -> ApiResult<(StatusCode, JsonBody<CataloguePublicationDto>)> {
    let raw = q.project_id.unwrap_or_default();
    let pctx = project_ctx(&catalog, &ctx, access.as_ref().map(|a| &a.0), &raw).await?;
    let me = catalog.decider(&ctx).await;
    let name = project_name(&catalog, &ctx, pctx.subject_tenant_id()).await;
    let ask = PublicationAsk {
        type_id: body.type_id,
        name: body.name,
        git_ref: body.git_ref,
        commit: body.commit,
        artifact: body.artifact.map(|a| PublishedArtifact {
            kind: a.kind,
            reference: a.reference,
        }),
        reason: body.reason,
    };
    let p = catalog
        .service
        .request_publication(&ctx, &pctx, ask, name, (me.id, me.name))
        .await
        .map_err(internal)?
        .map_err(level_problem)?;
    Ok((StatusCode::CREATED, Json(publication_dto(p))))
}

pub(super) async fn decide_publication(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(id): Path<Uuid>,
    Json(body): Json<CataloguePublicationDecisionRequest>,
) -> ApiResult<JsonBody<CataloguePublicationDto>> {
    if !may_decide(catalog.authority().as_deref(), &ctx).await {
        return Err(admin_refusal());
    }
    let approve = match body.action.trim() {
        "approve" => true,
        "decline" => false,
        other => {
            return Err(StudioComponentsCatalogError::invalid_argument()
                .with_field_violation(
                    "action",
                    format!("`{other}`; a publication is answered with `approve` or `decline`"),
                    "INVALID",
                )
                .create());
        }
    };
    let me = catalog.decider(&ctx).await;
    let p = catalog
        .service
        .decide_publication(&ctx, id, approve, body.reason, (me.id, me.name))
        .await
        .map_err(internal)?
        .map_err(level_problem)?;
    Ok(Json(publication_dto(p)))
}

pub(super) async fn component_doc(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    access: Option<Extension<crate::org_scope::OrgAccess>>,
    Path(name): Path<String>,
    Query(q): Query<OptionalProject>,
) -> ApiResult<JsonBody<CatalogueComponentDocDto>> {
    let pctx = match q.project_id.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(raw) => Some(project_ctx(&catalog, &ctx, access.as_ref().map(|a| &a.0), raw).await?),
        None => None,
    };
    let path = q.path.unwrap_or_default();
    let ComponentDoc {
        path,
        repo,
        git_ref,
        url,
        text,
        truncated,
    } = catalog
        .service
        .component_doc(&ctx, pctx.as_ref(), &name, &path)
        .await
        .map_err(internal)?
        .map_err(level_problem)?;
    Ok(Json(CatalogueComponentDocDto {
        name,
        path,
        repo,
        git_ref,
        url,
        text,
        truncated,
    }))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::get("/studio-components-catalog/v1/platform/pins")
        .operation_id("studio_components_catalog.list_platform_pins")
        .summary("The organization's platform release: every platform source and its pin")
        .description(
            "Every platform source the organization sees (it cannot hide one), with the \
             ref the platform reads it at and the organization's pin when it holds it at \
             another tag or commit (ADR-0061). `may_manage` says whether the caller may \
             change the pins.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_pins)
        .json_response_with_schema::<CataloguePlatformPinsDto>(openapi, StatusCode::OK, "The pins")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);
    let router = OperationBuilder::put("/studio-components-catalog/v1/platform/pins")
        .operation_id("studio_components_catalog.update_platform_pins")
        .summary("Hold platform sources at versions of the organization's own")
        .description(
            "Replaces the pins, one per platform source; a source left out follows the \
             platform. Each names a platform source and a tag or commit. 403 \
             (`REGISTRY_ADMIN_REQUIRED`) for anyone but an organization administrator; \
             400 for a repository that is not a platform source.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .json_request::<CatalogueSetPinsRequest>(openapi, "The pins")
        .handler(update_pins)
        .json_response_with_schema::<CataloguePlatformPinsDto>(openapi, StatusCode::OK, "The pins")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);
    let router = OperationBuilder::post("/studio-components-catalog/v1/project-catalogue/sync")
        .operation_id("studio_components_catalog.sync_project_catalogue")
        .summary("Read a project's repositories into its own catalogue now")
        .description(
            "Queues a `catalog.sync` of the project's own catalogue (ADR-0061): each of \
             its repositories the organization owns the connection of, read for gears, \
             own services, kits and FrontX packages by their passports, into the \
             project's tenant. The registry walk queues the same run when a project's \
             repositories change. Answers 202 with the `run_id`.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .query_param("project_id", true, "The project")
        .handler(sync_project_catalogue)
        .json_response_with_schema::<CatalogSyncEnqueued>(
            openapi,
            StatusCode::ACCEPTED,
            "Sync enqueued",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);
    let router = OperationBuilder::get("/studio-components-catalog/v1/publications")
        .operation_id("studio_components_catalog.list_publications")
        .summary("Projects' requests to publish a component into the organization's catalogue")
        .description(
            "Newest first; `project_id` narrows to one project, `state` to `requested`, \
             `approved` or `declined`. `may_decide` says whether the caller answers them.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .query_param("project_id", false, "One project's")
        .query_param("state", false, "`requested`, `approved` or `declined`")
        .handler(list_publications)
        .json_response_with_schema::<CataloguePublicationsDto>(
            openapi,
            StatusCode::OK,
            "The publications",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);
    let router = OperationBuilder::post("/studio-components-catalog/v1/publications")
        .operation_id("studio_components_catalog.create_publication")
        .summary("Propose a project's component to the organization at a version")
        .description(
            "The component must be in the project's own catalogue. What is published is a \
             version: `git_ref` (a tag or a commit; the ref it was read at when absent) \
             and the passport's version; `artifact` (crate, npm package, image) is \
             recorded for later. A second open request for the same component replaces \
             the first. An organization administrator answers it.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .query_param("project_id", true, "The project proposing it")
        .json_request::<CatalogueRequestPublicationRequest>(openapi, "What to publish")
        .handler(request_publication)
        .json_response_with_schema::<CataloguePublicationDto>(
            openapi,
            StatusCode::CREATED,
            "The request",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);
    let router =
        OperationBuilder::post("/studio-components-catalog/v1/publications/{id}/decisions")
            .operation_id("studio_components_catalog.decide_publication")
            .summary("An organization administrator approves or declines a publication")
            .description(
                "`approve` puts the project's component, at the version published, into \
                 the organization's catalogue (`published_from` says where from); \
                 `decline` needs a `reason`. 403 (`REGISTRY_ADMIN_REQUIRED`) for anyone but \
                 an organization administrator; 400 `PUBLICATION_ALREADY_ANSWERED` for one \
                 answered before.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .path_param("id", "The publication")
            .json_request::<CataloguePublicationDecisionRequest>(openapi, "`approve` or `decline`")
            .handler(decide_publication)
            .json_response_with_schema::<CataloguePublicationDto>(
                openapi,
                StatusCode::OK,
                "The publication",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);
    OperationBuilder::get("/studio-components-catalog/v1/components/{name}/docs")
        .operation_id("studio_components_catalog.get_component_doc")
        .summary("One of a component's documents, read from its repository")
        .description(
            "Only a path the component's passport lists in `docs` (or the README beside \
             it), read at the ref the catalogue read it at, cut at 200 KiB. \
             `project_id` reads a project's own component.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("name", "Component name")
        .query_param("path", true, "The document, from the repository root")
        .query_param("project_id", false, "The project, for its own component")
        .handler(component_doc)
        .json_response_with_schema::<CatalogueComponentDocDto>(
            openapi,
            StatusCode::OK,
            "The document",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi)
}
