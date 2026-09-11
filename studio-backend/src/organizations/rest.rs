//! HTTP surface for creating an organization.

use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{OrganizationService, Step};

#[resource_error(gts_id!("cf.studio._.organizations.v1~"))]
pub struct OrganizationError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateOrganizationRequest {
    /// Free text. Not unique — two organizations may share a name.
    pub name: String,
    /// The id a previous attempt reported, to finish what it started. Omit to
    /// create a new organization.
    #[serde(default)]
    pub organization_id: Option<String>,
}

/// Whether this installation lets people create organizations.
#[derive(Clone, Copy)]
pub struct SelfService(pub bool);

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrganizationCapabilitiesDto {
    /// When false, a person with no organization is waiting for an invitation
    /// or for the installation to join them — and the portal should not offer
    /// a control that will be refused.
    pub self_service: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrganizationDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrganizationDeletionDto {
    /// Memberships ended. The caller's own is one of them.
    pub people_removed: u32,
    /// Personal connections removed with them, and their tokens in credstore.
    pub connections_removed: u32,
}

fn configured(service: Option<Arc<OrganizationService>>) -> ApiResult<Arc<OrganizationService>> {
    service.ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail(
                "studio-organizations is not configured: it needs account-management and \
                 studio-user, so that a new organization gets both a tenant and an owner",
            )
            .create()
    })
}

async fn organization_capabilities(
    Extension(self_service): Extension<SelfService>,
) -> ApiResult<JsonBody<OrganizationCapabilitiesDto>> {
    Ok(Json(OrganizationCapabilitiesDto {
        self_service: self_service.0,
    }))
}

async fn create_organization(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<OrganizationService>>>,
    Extension(self_service): Extension<SelfService>,
    Json(req): Json<CreateOrganizationRequest>,
) -> ApiResult<JsonBody<OrganizationDto>> {
    if !self_service.0 {
        return Err(OrganizationError::permission_denied()
            .with_reason("SELF_SERVICE_DISABLED")
            .create());
    }
    let service = configured(service)?;
    let resume = match req.organization_id.as_deref() {
        None => None,
        Some(raw) => Some(Uuid::parse_str(raw).map_err(|_| {
            OrganizationError::invalid_argument()
                .with_constraint("organization_id must be a uuid")
                .create()
        })?),
    };

    match service.create(&ctx, &req.name, resume).await {
        Ok(org) => Ok(Json(OrganizationDto {
            id: org.id.to_string(),
            name: org.name,
        })),
        // A rejected name is the caller's problem and nothing was created.
        Err((Step::Tenant, error, None)) => Err(OrganizationError::invalid_argument()
            .with_constraint(format!("{error:#}"))
            .create()),
        // Past the first write: the organization exists but is not finished.
        // The response names it, because that id is the only way to finish it
        // and the caller is the only one holding it.
        Err((step, error, Some(id))) => Err(CanonicalError::internal(format!(
            "the organization was created as {id} but {} could not be written: {error:#}. \
             Repeat this request with organization_id={id} to finish it.",
            match step {
                Step::Tenant => "its record",
                Step::Membership => "your membership of it",
                Step::Grant => "your owner grant on it",
            }
        ))
        .create()),
        Err((_, error, None)) => Err(CanonicalError::internal(format!("{error:#}")).create()),
    }
}

async fn delete_organization(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<OrganizationService>>>,
    Path(org_id): Path<String>,
) -> ApiResult<JsonBody<OrganizationDeletionDto>> {
    let service = configured(service)?;
    let org = Uuid::parse_str(&org_id).map_err(|_| {
        OrganizationError::invalid_argument()
            .with_constraint("organization id must be a uuid")
            .create()
    })?;
    if !service.may_delete(&ctx, org).await {
        return Err(OrganizationError::permission_denied()
            .with_reason("ORG_OWNER_REQUIRED")
            .create());
    }
    match service.delete(&ctx, org).await {
        Ok(gone) => Ok(Json(OrganizationDeletionDto {
            people_removed: gone.people as u32,
            connections_removed: gone.connections as u32,
        })),
        // Account-management refuses a tenant that still has children, and that
        // refusal is the caller's to act on: an organization with a workspace or
        // a project in it is not disposed of by answering one prompt.
        Err(error) => Err(OrganizationError::invalid_argument()
            .with_constraint(format!("{error:#}"))
            .create()),
    }
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<OrganizationService>>,
    self_service: SelfService,
) -> Router {
    let router = OperationBuilder::get("/studio-organizations/v1/capabilities")
        .operation_id("studio_organizations.capabilities")
        .summary("What this installation lets people do with organizations")
        .description(
            "One field today: whether a person may create an organization. The portal reads it \
             so the no-organization screen offers creation where creation is possible and says \
             `wait for an invitation` where it is not — rather than offering a control that \
             answers 403.",
        )
        .tag("StudioOrganizations")
        .authenticated()
        .require_license_features::<License>([])
        .handler(organization_capabilities)
        .json_response_with_schema::<OrganizationCapabilitiesDto>(
            openapi,
            StatusCode::OK,
            "Capabilities",
        )
        .error_401(openapi)
        .register(router, openapi);

    let router = OperationBuilder::delete("/studio-organizations/v1/organizations/{org_id}")
        .operation_id("studio_organizations.delete_organization")
        .summary("Delete an organization")
        .description(
            "The other end of creating one, and what the last person in an organization is \
             pointed at when they try to leave: leaving an organization nobody else is in would \
             abandon it rather than hand it over, so it is deletion that is being asked for, \
             and deletion is a separate, deliberate act (ADR-0018 §6). Its owner may, and so \
             may a platform administrator. Every membership ends and every member's personal \
             connections go with it — the tenant is removed last, because the catalogue holding \
             those connections lives inside it. Refused while the organization still has a \
             workspace or a project: work is not disposed of by answering a prompt.",
        )
        .tag("StudioOrganizations")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("org_id", "Organization (tenant) id")
        .handler(delete_organization)
        .json_response_with_schema::<OrganizationDeletionDto>(
            openapi,
            StatusCode::OK,
            "Deleted, and what went with it",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::post("/studio-organizations/v1/organizations")
        .operation_id("studio_organizations.create_organization")
        .summary("Create an organization and own it")
        .description(
            "Anyone who can sign in may create an organization and becomes its owner \
             (ADR-0018 §2). Creating one writes three things — the tenant, the caller's owner \
             membership, and the owner grant the authorization policy reads — and there is no \
             transaction across the two systems that hold them. If a later write fails the \
             response names the organization it created; repeating the request with that \
             `organization_id` finishes it, and each write is idempotent so repeating is safe.",
        )
        .tag("StudioOrganizations")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateOrganizationRequest>(openapi, "The organization to create")
        .handler(create_organization)
        .json_response_with_schema::<OrganizationDto>(openapi, StatusCode::OK, "The organization")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service))
        .layer(Extension(self_service))
}
