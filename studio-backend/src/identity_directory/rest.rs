use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{DirectoryIdentity, IdentityDirectoryService};

#[resource_error(gts_id!("cf.studio.identity.directory.v1~"))]
pub struct IdentityDirectoryError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformIdentityDto {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub identity_provider: Option<String>,
    pub first_seen_at_epoch_ms: Option<i64>,
    pub status: String,
    #[schema(value_type = Option<String>)]
    pub home_tenant_id: Option<Uuid>,
    pub home_tenant_name: Option<String>,
    pub organization_role: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AssignIdentityRequest {
    #[schema(value_type = String)]
    pub tenant_id: Uuid,
    /// Organization-level designation. Access roles inside projects remain
    /// managed independently by the organization's People/Access screens.
    pub role: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformIdentityListDto {
    pub items: Vec<PlatformIdentityDto>,
    /// `true` when the realm holds more identities than one read of it takes.
    ///
    /// Sorting happens after reading, so a partial read is not the first page
    /// of this list — it is a different set of people, and the ones waiting to
    /// be placed may be among those missing. A screen that shows the list
    /// without saying this looks complete and is not.
    pub truncated: bool,
}

/// The membership recorder, or `None` when studio-user is inert (no database).
///
/// Assignment still works without it — the Keycloak attribute, the group and the
/// owner grant are all written — but the Studio membership record is skipped and
/// the backfill route reports that instead of pretending to run.
#[derive(Clone)]
pub struct Memberships(pub Option<Arc<dyn crate::user_profile::AssignmentRecorder>>);

/// Who a subject is, for the administrator gate.
///
/// `None` when studio-user is inert, and the gate then has only the token to go
/// on — which is what it has always had.
#[derive(Clone)]
pub struct People(pub Option<Arc<dyn crate::user_profile::OrganizationReader>>);

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BackfillReportDto {
    /// Identities whose membership was written or refreshed.
    pub recorded: i64,
    /// Identities the IdP calls assigned but whose record could not be written;
    /// each one is logged with its cause.
    pub failed: i64,
}

fn to_dto(identity: DirectoryIdentity) -> PlatformIdentityDto {
    PlatformIdentityDto {
        id: identity.id,
        username: identity.username,
        email: identity.email,
        display_name: identity.display_name,
        identity_provider: identity.identity_provider,
        first_seen_at_epoch_ms: identity.first_seen_at_epoch_ms,
        status: identity.status.to_owned(),
        home_tenant_id: identity.home_tenant_id,
        home_tenant_name: identity.home_tenant_name,
        organization_role: identity.organization_role,
    }
}

/// Is the caller a platform administrator?
///
/// A membership of the platform root, and nothing else (ADR-0018 §3). The
/// token's tenant was accepted here too while that migration ran; it is an
/// answer about one login rather than about the person, and this is the step
/// that removes it.
///
/// Without studio-user there is nobody to ask, and every route behind this gate
/// is administrative — so it refuses rather than falling back to the signal
/// just retired.
async fn require_platform_admin(ctx: &SecurityContext, people: &People) -> ApiResult<()> {
    let by_membership = match people.0.as_deref() {
        Some(reader) => reader
            .is_platform_admin(&ctx.subject_id().to_string())
            .await
            .unwrap_or(false),
        None => false,
    };
    if by_membership {
        Ok(())
    } else {
        Err(IdentityDirectoryError::permission_denied()
            .with_reason("PLATFORM_ADMIN_REQUIRED")
            .create())
    }
}

fn configured_service(
    service: Option<Arc<IdentityDirectoryService>>,
) -> ApiResult<Arc<IdentityDirectoryService>> {
    service.ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail(
                "identity directory is not configured; set the Keycloak admin base URL and secret",
            )
            .create()
    })
}

async fn list_identities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(people): Extension<People>,
    Extension(service): Extension<Option<Arc<IdentityDirectoryService>>>,
) -> ApiResult<JsonBody<PlatformIdentityListDto>> {
    require_platform_admin(&ctx, &people).await?;
    let service = configured_service(service)?;
    let directory = service.list(&ctx).await.map_err(|error| {
        CanonicalError::internal(format!("identity directory failed: {error:#}")).create()
    })?;
    Ok(Json(PlatformIdentityListDto {
        items: directory.identities.into_iter().map(to_dto).collect(),
        truncated: directory.truncated,
    }))
}

async fn assign_identity(
    Extension(ctx): Extension<SecurityContext>,
    Extension(people): Extension<People>,
    Extension(service): Extension<Option<Arc<IdentityDirectoryService>>>,
    Extension(memberships): Extension<Memberships>,
    Path(identity_id): Path<String>,
    Json(req): Json<AssignIdentityRequest>,
) -> ApiResult<StatusCode> {
    require_platform_admin(&ctx, &people).await?;
    let role = req.role.trim().to_ascii_lowercase();
    if !matches!(role.as_str(), "owner" | "member") {
        return Err(IdentityDirectoryError::invalid_argument()
            .with_constraint("role must be owner or member")
            .create());
    }
    configured_service(service)?
        .assign(
            &ctx,
            &identity_id,
            req.tenant_id,
            &role,
            memberships.0.as_deref(),
        )
        .await
        .map_err(|error| {
            CanonicalError::internal(format!("identity assignment failed: {error:#}")).create()
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn backfill_memberships(
    Extension(ctx): Extension<SecurityContext>,
    Extension(people): Extension<People>,
    Extension(service): Extension<Option<Arc<IdentityDirectoryService>>>,
    Extension(memberships): Extension<Memberships>,
) -> ApiResult<JsonBody<BackfillReportDto>> {
    require_platform_admin(&ctx, &people).await?;
    let service = configured_service(service)?;
    let Some(recorder) = memberships.0.as_deref() else {
        return Err(CanonicalError::service_unavailable()
            .with_detail(
                "studio-user has no database configured, so there is nowhere to record \
                 memberships",
            )
            .create());
    };
    let (recorded, failed) =
        service
            .backfill_memberships(&ctx, recorder)
            .await
            .map_err(|error| {
                CanonicalError::internal(format!("membership backfill failed: {error:#}")).create()
            })?;
    Ok(Json(BackfillReportDto {
        recorded: recorded as i64,
        failed: failed as i64,
    }))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<IdentityDirectoryService>>,
    memberships: Memberships,
    people: People,
) -> Router {
    let router = OperationBuilder::get("/studio-identity/v1/users")
        .operation_id("studio_identity.list_users")
        .summary("List identities known to Studio's Keycloak realm")
        .description(
            "Platform-admin-only identity directory. Includes authenticated but unassigned users; \
             organization owners must use their tenant-scoped People endpoint instead. Newest \
             first. The realm is read a page at a time up to a ceiling, and `truncated` says \
             whether that ceiling was reached — the list is then part of the directory rather \
             than its first page, since the sort happens after the read.",
        )
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_identities)
        .json_response_with_schema::<PlatformIdentityListDto>(
            openapi,
            StatusCode::OK,
            "Identity directory",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-identity/v1/users/{identity_id}/assignment")
        .operation_id("studio_identity.assign_user")
        .summary("Assign an identity to an organization")
        .description(
            "Platform-admin-only onboarding action. Updates the Keycloak tenant membership and the organization-level Owner/Member designation.",
        )
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("identity_id", "Keycloak user id")
        .json_request::<AssignIdentityRequest>(openapi, "Organization assignment")
        .handler(assign_identity)
        .no_content_response(StatusCode::NO_CONTENT, "Identity assigned")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::post("/studio-identity/v1/memberships/backfill")
        .operation_id("studio_identity.backfill_memberships")
        .summary("Record Studio memberships for identities the IdP already calls assigned")
        .description(
            "Platform-admin-only migration action (ADR-0011 Phase 4). Every identity carrying a \
             home-tenant attribute that names an existing organization gets a Studio membership \
             recorded for it, so organization access can be read from membership rather than \
             from the attribute. Idempotent: re-running refreshes the rows it already wrote.",
        )
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .handler(backfill_memberships)
        .json_response_with_schema::<BackfillReportDto>(openapi, StatusCode::OK, "Backfill report")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        // Applied once at the end: `Router::layer` covers every route added
        // before the call, which is how the service extension above already
        // reaches both of the earlier routes.
        .layer(Extension(service))
        .layer(Extension(memberships))
        .layer(Extension(people))
}
