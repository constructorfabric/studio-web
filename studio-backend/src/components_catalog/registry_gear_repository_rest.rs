//! The organization's gear repository (ADR-0042 §2), over REST: the setting,
//! creating one, and "Create a gear" into it.
//!
//! - `GET /registry/gear-repository` -- every member reads it.
//! - `PUT` / `DELETE` -- an organization administrator (`component.registry`,
//!   as for decisions). The connection must be the organization's own -- never
//!   one inherited from the platform's root, whose token is the platform's --
//!   and organization-scoped: the walk reads the repository as the service and
//!   a project writes it from below the organization. The repository is read
//!   at its branch before it is stored.
//! - `POST /registry/gear-repository/create` -- a new repository through the
//!   connection, set as the gear repository.
//! - `POST /registry/scaffold` -- a new gear into it, through studio-product
//!   (`product::port::GearScaffolds`). The registry finds it once merged.

use super::*;
use crate::components_catalog::registry::{
    GearRepository, GearRepositoryError, GearRepositoryInput,
};

/// The organization's gear repository.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct GearRepositoryDto {
    /// The tenant whose catalogue holds the connection.
    pub tenant: Uuid,
    pub connection_id: Uuid,
    /// The connection's label when it was set.
    pub connection_label: Option<String>,
    /// `owner/name`.
    pub repo: String,
    /// The branch new gears go back to.
    pub branch: String,
    pub set_by: Option<String>,
    /// RFC 3339.
    pub set_at: Option<String>,
}

/// The setting, and whether the caller may change it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearRepositoryStateDto {
    /// Null when the organization has not named one.
    pub gear_repository: Option<GearRepositoryDto>,
    /// Whether the caller may set, create or remove it, and create a gear
    /// into it (`component.registry`).
    pub may_manage: bool,
}

/// What the organization's gear repository is to be.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetGearRepositoryRequest {
    /// A connection the organization sees, organization-scoped.
    pub connection_id: Uuid,
    /// `owner/name`.
    pub repo: String,
    /// The branch new gears go back to; `main` when omitted.
    pub branch: Option<String>,
}

/// A repository to create and set as the organization's gear repository.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateGearRepositoryRequest {
    /// A connection the organization sees, organization-scoped.
    pub connection_id: Uuid,
    /// The new repository's name, without its owner.
    pub name: String,
    /// The account or organization to create it under; the connection's
    /// account when omitted.
    pub owner: Option<String>,
    /// `owner` is an organization on the provider (default false).
    pub is_org: Option<bool>,
    /// Private (default true).
    pub private: Option<bool>,
}

/// A new gear for the organization's gear repository.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RegistryScaffoldRequest {
    /// The gear's slug: its branch `scaffold/<slug>`, directory and crate.
    pub slug: String,
    /// The PRD's opening sentence: what the gear is for.
    pub problem: Option<String>,
    /// Capability keys written into its `gear.toml`.
    pub capabilities: Option<Vec<String>>,
    /// `service` (default), `minimal` or `plugin`.
    pub gear_kind: Option<String>,
    /// For a plugin: the host crate whose extension point it fills.
    pub plugin_host: Option<String>,
    /// For a plugin of a host with several points: which, by GTS spec id.
    pub plugin_spec: Option<String>,
    /// Directory the gear's own goes under (default `gears`).
    pub parent_dir: Option<String>,
    /// Named in its manifest and its PRD.
    pub app_title: Option<String>,
    /// Open a pull request back into the base branch (default true: the
    /// repository is the organization's).
    pub open_pr: Option<bool>,
    /// Answer the files only; nothing is written.
    pub dry_run: Option<bool>,
}

/// What a scaffold into the organization's gear repository did, or would do.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryScaffoldResultDto {
    pub branch: String,
    /// Empty on a dry run.
    pub commit_sha: String,
    pub pr_url: Option<String>,
    pub files: Vec<DeclaredFileDto>,
    /// `owner/name` of the organization's gear repository.
    pub repo: String,
    pub dry_run: bool,
}

fn gear_repository_dto(r: GearRepository) -> GearRepositoryDto {
    GearRepositoryDto {
        tenant: r.tenant,
        connection_id: r.connection_id,
        connection_label: r.connection_label,
        repo: r.repo,
        branch: r.branch,
        set_by: r.set_by,
        set_at: r.set_at,
    }
}

/// A refused gear repository as a problem: 400 naming the field.
pub(crate) fn gear_repository_problem(e: &GearRepositoryError) -> CanonicalError {
    let (field, reason) = match e {
        GearRepositoryError::InvalidRepo(_) => ("repo", "INVALID"),
        GearRepositoryError::UnknownConnection(_) => ("connection_id", "UNKNOWN_CONNECTION"),
        GearRepositoryError::NotShared { .. } => ("connection_id", "CONNECTION_NOT_SHARED"),
        GearRepositoryError::NotOwned { .. } => ("connection_id", "CONNECTION_NOT_OWNED"),
        GearRepositoryError::Unreadable { .. } => ("repo", "GEAR_REPOSITORY_UNREADABLE"),
    };
    StudioComponentsCatalogError::invalid_argument()
        .with_field_violation(field, e.to_string(), reason)
        .create()
}

fn registry_admin_required() -> CanonicalError {
    StudioComponentsCatalogError::permission_denied()
        .with_reason("REGISTRY_ADMIN_REQUIRED")
        .create()
}

impl Catalog {
    /// 403 unless the caller may decide about the registry.
    pub(super) async fn require_registry_admin(&self, ctx: &SecurityContext) -> ApiResult<()> {
        if may_decide(self.authority().as_deref(), ctx).await {
            Ok(())
        } else {
            Err(registry_admin_required())
        }
    }

    /// The setting with whether the caller may change it.
    async fn gear_repository_state(
        &self,
        ctx: &SecurityContext,
        repo: Option<GearRepository>,
    ) -> GearRepositoryStateDto {
        GearRepositoryStateDto {
            gear_repository: repo.map(gear_repository_dto),
            may_manage: may_decide(self.authority().as_deref(), ctx).await,
        }
    }

    /// After the setting changed: keep the hourly walk, and walk now so what
    /// the repository holds is in the registry. Best effort.
    async fn walk_after_gear_repository(&self, ctx: &SecurityContext) {
        self.ensure_registry_schedule(ctx).await;
        let queued = match crate::components_catalog::registry_task::queue(&self.hub) {
            Ok(queue) => {
                crate::components_catalog::registry_task::enqueue(
                    queue.as_ref(),
                    ctx,
                    ctx.subject_tenant_id(),
                    &crate::components_catalog::registry_task::RegistryPayload::default(),
                )
                .await
            }
            Err(e) => Err(e),
        };
        if let Err(e) = queued {
            tracing::info!(error = %format!("{e:#}"), "components-catalog: no walk queued after the gear repository changed; the next one reads it");
        }
    }

    /// Where the gear repository's connection is found, read and created
    /// through: the connectors, or a 503 in an assembly without them.
    fn gear_repository_access(
        &self,
    ) -> ApiResult<crate::components_catalog::registry::ConnectorAccess> {
        self.service
            .connector_service()
            .map(crate::components_catalog::registry::ConnectorAccess)
            .ok_or_else(|| {
                CanonicalError::service_unavailable()
                    .with_detail("no connector service is available for the gear repository")
                    .create()
            })
    }

    /// "Create a gear"'s writer, studio-product's: a 503 in an assembly
    /// without it.
    fn scaffolds(&self) -> ApiResult<Arc<dyn crate::product::port::GearScaffolds>> {
        self.hub
            .get::<dyn crate::product::port::GearScaffolds>()
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "creating a gear is not available in this deployment \
                         (studio-product is not part of it)",
                    )
                    .create()
            })
    }
}

async fn get_gear_repository(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<GearRepositoryStateDto>> {
    let repo = catalog
        .service
        .gear_repository(&ctx)
        .await
        .map_err(internal)?;
    Ok(Json(catalog.gear_repository_state(&ctx, repo).await))
}

async fn set_gear_repository(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<SetGearRepositoryRequest>,
) -> ApiResult<JsonBody<GearRepositoryStateDto>> {
    catalog.require_registry_admin(&ctx).await?;
    let by = catalog.decider(&ctx).await;
    let input = GearRepositoryInput {
        connection_id: body.connection_id,
        repo: body.repo,
        branch: body.branch,
    };
    let access = catalog.gear_repository_access()?;
    let repo = catalog
        .service
        .set_gear_repository(&ctx, &input, Some(by.id), &access)
        .await
        .map_err(internal)?
        .map_err(|e| gear_repository_problem(&e))?;
    catalog.walk_after_gear_repository(&ctx).await;
    Ok(Json(catalog.gear_repository_state(&ctx, Some(repo)).await))
}

async fn delete_gear_repository(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<GearRepositoryStateDto>> {
    catalog.require_registry_admin(&ctx).await?;
    catalog
        .service
        .store_gear_repository(&ctx, None)
        .await
        .map_err(internal)?;
    // The next full walk retires what was found there.
    catalog.walk_after_gear_repository(&ctx).await;
    Ok(Json(catalog.gear_repository_state(&ctx, None).await))
}

async fn create_gear_repository(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<CreateGearRepositoryRequest>,
) -> ApiResult<(StatusCode, JsonBody<GearRepositoryStateDto>)> {
    catalog.require_registry_admin(&ctx).await?;
    let name = body.name.trim();
    if name.is_empty() || name.contains('/') || name.contains(char::is_whitespace) {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(
                "name",
                "name the new repository without its owner, with no spaces",
                "INVALID",
            )
            .create());
    }
    let by = catalog.decider(&ctx).await;
    let owner = body
        .owner
        .as_deref()
        .map(str::trim)
        .filter(|o| !o.is_empty());
    let access = catalog.gear_repository_access()?;
    let repo = catalog
        .service
        .create_gear_repository(
            &ctx,
            body.connection_id,
            owner,
            body.is_org.unwrap_or(false),
            name,
            body.private.unwrap_or(true),
            Some(by.id),
            &access,
        )
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("the repository could not be created: {e:#}"))
                .create()
        })?
        .map_err(|e| gear_repository_problem(&e))?;
    catalog.walk_after_gear_repository(&ctx).await;
    Ok((
        StatusCode::CREATED,
        Json(catalog.gear_repository_state(&ctx, Some(repo)).await),
    ))
}

/// The request in the port's terms. The gear is the organization's, so its
/// manifest names the organization (`organization`) unless the request
/// names something else.
fn new_gear_of(
    body: RegistryScaffoldRequest,
    organization: String,
) -> crate::product::port::NewGear {
    crate::product::port::NewGear {
        slug: body.slug,
        app_title: body
            .app_title
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
            .or_else(|| Some(organization).filter(|o| !o.trim().is_empty())),
        problem: body.problem,
        origin: Some("Scaffolded from the organization's Components page.".to_owned()),
        parent_dir: body.parent_dir,
        gear_kind: body.gear_kind,
        plugin_host: body.plugin_host,
        plugin_spec: body.plugin_spec,
        capabilities: body.capabilities.unwrap_or_default(),
        open_pr: body.open_pr.unwrap_or(true),
        dry_run: body.dry_run.unwrap_or(false),
    }
}

/// Where a scaffold into the organization's gear repository goes.
pub(crate) fn scaffold_target(repo: &GearRepository) -> crate::product::port::RepositoryTarget {
    crate::product::port::RepositoryTarget {
        tenant: repo.tenant,
        connection_id: Some(repo.connection_id),
        repo: repo.repo.clone(),
        base_branch: repo.branch.clone(),
    }
}

fn no_gear_repository() -> CanonicalError {
    StudioComponentsCatalogError::failed_precondition()
        .with_precondition_violation(
            "gear_repository",
            "the organization has no gear repository: set one on the Components page first",
            "REGISTRY_NO_GEAR_REPOSITORY",
        )
        .create()
}

async fn scaffold_organization_gear(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<RegistryScaffoldRequest>,
) -> ApiResult<JsonBody<RegistryScaffoldResultDto>> {
    catalog.require_registry_admin(&ctx).await?;
    if body.slug.trim().is_empty() {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation("slug", "name the gear", "REQUIRED")
            .create());
    }
    let repo = catalog
        .service
        .gear_repository(&ctx)
        .await
        .map_err(internal)?
        .ok_or_else(no_gear_repository)?;
    let scaffolds = catalog.scaffolds()?;
    let organization = catalog
        .service
        .organization_name(&ctx, ctx.subject_tenant_id())
        .await;
    let gear = new_gear_of(body, organization);
    let dry_run = gear.dry_run;
    let done = scaffolds
        .scaffold_into(&ctx, &scaffold_target(&repo), &gear)
        .await
        .map_err(|e| match e {
            crate::product::port::ScaffoldFailure::Invalid(msg) => {
                StudioComponentsCatalogError::invalid_argument()
                    .with_constraint(msg)
                    .create()
            }
            crate::product::port::ScaffoldFailure::Failed(e) => internal(e),
        })?;
    if !dry_run {
        tracing::info!(organization_id = %ctx.subject_tenant_id(), repo = %repo.repo, branch = %done.branch, pr = ?done.pr_url, "components-catalog: a gear was scaffolded into the organization's gear repository");
    }
    Ok(Json(RegistryScaffoldResultDto {
        branch: done.branch,
        commit_sha: done.commit_sha,
        pr_url: done.pr_url,
        files: done
            .files
            .into_iter()
            .map(|f| DeclaredFileDto {
                path: f.path,
                content: f.content,
            })
            .collect(),
        repo: repo.repo,
        dry_run,
    }))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::get("/studio-components-catalog/v1/registry/gear-repository")
        .operation_id("studio_components_catalog.get_registry_gear_repository")
        .summary("The organization's gear repository")
        .description(
            "The repository the organization keeps its gears in (ADR-0042): \
             where \"Create a gear\" writes for a project without a gear \
             repository of its own, and a repository the registry walk reads \
             (its occurrences say `scope: organization`). `gear_repository` is \
             null when none is set; `may_manage` says whether the caller may \
             change it. Every member reads it.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_gear_repository)
        .json_response_with_schema::<GearRepositoryStateDto>(
            openapi,
            StatusCode::OK,
            "The gear repository",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-components-catalog/v1/registry/gear-repository")
        .operation_id("studio_components_catalog.update_registry_gear_repository")
        .summary("Set the organization's gear repository")
        .description(
            "Names the organization's gear repository: a connection, \
             `owner/name` and the branch new gears go back to (default `main`). \
             The connection must be one the organization sees, and \
             organization-scoped: the registry walk reads the repository as \
             the service, and a project's \"Create a gear\" writes it from below \
             the organization, so a personal or a workspace connection is \
             refused (400 `CONNECTION_NOT_SHARED`, saying why). The \
             connection must also be the organization's own: one it only \
             inherits from the platform's root is refused (400 \
             `CONNECTION_NOT_OWNED`). The repository is read at the branch \
             through the connection before it is stored; one that cannot be \
             is refused (400 `GEAR_REPOSITORY_UNREADABLE`, with the \
             provider's error). Queues a walk. 403 for anyone but an \
             organization administrator (`component.registry`).",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(set_gear_repository)
        .json_request::<SetGearRepositoryRequest>(openapi, "The gear repository")
        .json_response_with_schema::<GearRepositoryStateDto>(
            openapi,
            StatusCode::OK,
            "The gear repository",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::delete("/studio-components-catalog/v1/registry/gear-repository")
        .operation_id("studio_components_catalog.delete_registry_gear_repository")
        .summary("Remove the organization's gear repository")
        .description(
            "Unsets the organization's gear repository; the repository itself is \
             not touched. The next full walk retires the occurrences found in it, \
             and a project without a gear repository of its own writes into its \
             sources again. 403 for anyone but an organization administrator.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(delete_gear_repository)
        .json_response_with_schema::<GearRepositoryStateDto>(openapi, StatusCode::OK, "Removed")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/registry/gear-repository/create")
            .operation_id("studio_components_catalog.create_registry_gear_repository")
            .summary("Create a repository and make it the organization's gear repository")
            .description(
                "Creates a repository through an organization-scoped connection and \
                 sets it as the organization's gear repository, on its default \
                 branch. The connection is checked before anything is created: \
                 the organization's own (400 `CONNECTION_NOT_OWNED` for one \
                 inherited from the platform's root) and organization-scoped. \
                 Answers 201. 403 for anyone but an organization administrator.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(create_gear_repository)
            .json_request::<CreateGearRepositoryRequest>(openapi, "The new repository")
            .json_response_with_schema::<GearRepositoryStateDto>(
                openapi,
                StatusCode::CREATED,
                "The gear repository",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .register(router, openapi);

    OperationBuilder::post("/studio-components-catalog/v1/registry/scaffold")
        .operation_id("studio_components_catalog.scaffold_registry_gear")
        .summary("Create a gear in the organization's gear repository")
        .description(
            "Writes a new gear's skeleton -- studio-product's, the one a project's \
             scaffold writes -- into the organization's gear repository on \
             `scaffold/<slug>`, with a pull request unless `open_pr` is false. \
             `dry_run` answers the files and writes nothing. The registry finds \
             the gear, `declared`, once the walk reads it merged. 403 for anyone \
             but an organization administrator; 400 `failed_precondition` when \
             the organization has no gear repository; 503 without studio-product.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(scaffold_organization_gear)
        .json_request::<RegistryScaffoldRequest>(openapi, "The new gear")
        .json_response_with_schema::<RegistryScaffoldResultDto>(
            openapi,
            StatusCode::OK,
            "The branch, the pull request and the files",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}

#[cfg(test)]
#[path = "registry_gear_repository_tests.rs"]
mod tests;
