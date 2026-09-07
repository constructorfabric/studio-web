//! HTTP surface for the identity/user gear.
//!
//! `/studio-user/v1/me*` is self-service: any authenticated caller resolves to
//! their own canonical user and reads/edits their profile, sign-in methods and
//! memberships. Membership WRITES for an organization are gated on being an
//! OWNER of that organization (per-org authority, not a platform-wide admin).
//! Cross-org identity operations (read any user, alias, merge, resolve) are a
//! narrow platform-admin action.

use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{IdentityService, LoginView, MembershipView, ProfilePatch, UserProfile};

/// Provider tag for a token minted through Studio's Keycloak realm.
const PROVIDER_KEYCLOAK: &str = "keycloak";
/// The platform root tenant; a caller acting here is a platform admin.
const PLATFORM_ROOT_TENANT_ID: Uuid = Uuid::from_u128(1);

#[resource_error(gts_id!("cf.studio.user.profile.v1~"))]
pub struct UserProfileError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct UserProfileDto {
    pub id: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
    pub created_at_epoch_ms: i64,
    pub updated_at_epoch_ms: i64,
    pub merged_into: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct LoginDto {
    pub provider: String,
    pub subject: String,
    pub verified: bool,
    pub linked_at_epoch_ms: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct LoginListDto {
    pub items: Vec<LoginDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MembershipDto {
    pub user_id: String,
    pub org_id: String,
    pub role: String,
    pub source: String,
    pub created_at_epoch_ms: i64,
    pub updated_at_epoch_ms: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MembershipListDto {
    pub items: Vec<MembershipDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PutMembershipRequest {
    /// The role this person holds in THIS organization.
    pub role: String,
    /// How the membership was established: "assignment", "grant", "manual".
    pub source: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AddAliasRequest {
    pub kind: String,
    pub external_id: String,
    /// "confirmed" or "suggested"; anything else is treated as "suggested".
    pub confidence: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct MergeRequest {
    pub from_user_id: String,
    pub into_user_id: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MergeResultDto {
    pub logins_moved: u32,
    pub aliases_moved: u32,
    pub memberships_moved: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ResolveRequest {
    pub provider: String,
    pub subject: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ResolveResultDto {
    pub user_id: String,
}

fn to_dto(p: UserProfile) -> UserProfileDto {
    UserProfileDto {
        id: p.id,
        display_name: p.display_name,
        email: p.email,
        avatar_url: p.avatar_url,
        locale: p.locale,
        created_at_epoch_ms: p.created_at_epoch_ms,
        updated_at_epoch_ms: p.updated_at_epoch_ms,
        merged_into: p.merged_into,
    }
}

fn login_to_dto(l: LoginView) -> LoginDto {
    LoginDto {
        provider: l.provider,
        subject: l.subject,
        verified: l.verified,
        linked_at_epoch_ms: l.linked_at_epoch_ms,
    }
}

fn membership_to_dto(m: MembershipView) -> MembershipDto {
    MembershipDto {
        user_id: m.user_id,
        org_id: m.org_id,
        role: m.role,
        source: m.source,
        created_at_epoch_ms: m.created_at_epoch_ms,
        updated_at_epoch_ms: m.updated_at_epoch_ms,
    }
}

// ── Guards & helpers ──────────────────────────────────────────────────────────

fn internal(error: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("identity service failed: {error:#}")).create()
}

fn configured(service: Option<Arc<IdentityService>>) -> ApiResult<Arc<IdentityService>> {
    service.ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail("studio-user has no database configured")
            .create()
    })
}

fn require_platform_admin(ctx: &SecurityContext) -> ApiResult<()> {
    if ctx.subject_tenant_id() != PLATFORM_ROOT_TENANT_ID {
        return Err(UserProfileError::permission_denied()
            .with_reason("PLATFORM_ADMIN_REQUIRED")
            .create());
    }
    Ok(())
}

async fn require_org_owner(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
    org_id: Uuid,
) -> ApiResult<()> {
    if service.is_org_owner(ctx, org_id).await {
        Ok(())
    } else {
        Err(UserProfileError::permission_denied()
            .with_reason("ORG_OWNER_REQUIRED")
            .create())
    }
}

fn parse_org(org_id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(org_id).map_err(|_| {
        UserProfileError::invalid_argument()
            .with_constraint("org_id must be a uuid")
            .create()
    })
}

/// Resolve the caller's canonical user id, provisioning on first sight. The
/// token subject is an already-authenticated Keycloak identity, so verified.
async fn caller_user_id(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
) -> ApiResult<String> {
    let subject = ctx.subject_id().to_string();
    service
        .resolve_or_provision(PROVIDER_KEYCLOAK, &subject, None, None, true)
        .await
        .map_err(internal)
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn get_me(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let profile = service
        .get_profile(&user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal(anyhow::anyhow!("profile missing right after provisioning")))?;
    Ok(Json(to_dto(profile)))
}

async fn update_me(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<UpdateProfileRequest>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let patch = ProfilePatch {
        display_name: req.display_name,
        email: req.email,
        avatar_url: req.avatar_url,
        locale: req.locale,
    };
    let updated = service
        .update_profile(&user_id, patch)
        .await
        .map_err(internal)?;
    Ok(Json(to_dto(updated)))
}

async fn get_my_logins(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<LoginListDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let items = service
        .list_logins(&user_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(login_to_dto)
        .collect();
    Ok(Json(LoginListDto { items }))
}

async fn get_my_memberships(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<MembershipListDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let items = service
        .list_memberships(&user_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(membership_to_dto)
        .collect();
    Ok(Json(MembershipListDto { items }))
}

async fn get_user(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(user_id): Path<String>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    require_platform_admin(&ctx)?;
    let service = configured(service)?;
    let profile = service
        .get_profile(&user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            UserProfileError::not_found("no such user")
                .with_resource(user_id.clone())
                .create()
        })?;
    Ok(Json(to_dto(profile)))
}

async fn get_user_memberships(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(user_id): Path<String>,
) -> ApiResult<JsonBody<MembershipListDto>> {
    require_platform_admin(&ctx)?;
    let service = configured(service)?;
    let items = service
        .list_memberships(&user_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(membership_to_dto)
        .collect();
    Ok(Json(MembershipListDto { items }))
}

async fn put_membership(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((user_id, org_id)): Path<(String, String)>,
    Json(req): Json<PutMembershipRequest>,
) -> ApiResult<JsonBody<MembershipDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_owner(&ctx, &service, org).await?;
    let source = req.source.unwrap_or_else(|| "manual".to_string());
    let membership = service
        .record_membership(&user_id, &org_id, &req.role, &source)
        .await
        .map_err(internal)?;
    Ok(Json(membership_to_dto(membership)))
}

async fn delete_membership(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((user_id, org_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_owner(&ctx, &service, org).await?;
    service
        .remove_membership(&user_id, &org_id)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn add_alias(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(user_id): Path<String>,
    Json(req): Json<AddAliasRequest>,
) -> ApiResult<StatusCode> {
    require_platform_admin(&ctx)?;
    let service = configured(service)?;
    let confidence = req.confidence.unwrap_or_else(|| "suggested".to_string());
    service
        .add_alias(&user_id, &req.kind, &req.external_id, &confidence)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn merge_users(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<MergeRequest>,
) -> ApiResult<JsonBody<MergeResultDto>> {
    require_platform_admin(&ctx)?;
    let service = configured(service)?;
    let result = service
        .merge(&req.from_user_id, &req.into_user_id)
        .await
        .map_err(internal)?;
    Ok(Json(MergeResultDto {
        logins_moved: result.logins_moved as u32,
        aliases_moved: result.aliases_moved as u32,
        memberships_moved: result.memberships_moved as u32,
    }))
}

async fn resolve_identity(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<ResolveRequest>,
) -> ApiResult<JsonBody<ResolveResultDto>> {
    require_platform_admin(&ctx)?;
    let service = configured(service)?;
    let user_id = service
        .resolve_or_provision(&req.provider, &req.subject, None, None, true)
        .await
        .map_err(internal)?;
    Ok(Json(ResolveResultDto { user_id }))
}

// ── Routes ──────────────────────────────────────────────────────────────────

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<IdentityService>>,
) -> Router {
    let router = OperationBuilder::get("/studio-user/v1/me")
        .operation_id("studio_user.get_me")
        .summary("Resolve the caller to their canonical Studio user and profile")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_me)
        .json_response_with_schema::<UserProfileDto>(
            openapi,
            StatusCode::OK,
            "The caller's profile",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::post("/studio-user/v1/me")
        .operation_id("studio_user.update_me")
        .summary("Update the caller's own profile")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<UpdateProfileRequest>(openapi, "Profile fields to change")
        .handler(update_me)
        .json_response_with_schema::<UserProfileDto>(openapi, StatusCode::OK, "The updated profile")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::get("/studio-user/v1/me/logins")
        .operation_id("studio_user.get_my_logins")
        .summary("List the caller's linked sign-in methods")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_my_logins)
        .json_response_with_schema::<LoginListDto>(
            openapi,
            StatusCode::OK,
            "Linked sign-in methods",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::get("/studio-user/v1/me/memberships")
        .operation_id("studio_user.get_my_memberships")
        .summary("List the caller's organization memberships and roles")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_my_memberships)
        .json_response_with_schema::<MembershipListDto>(
            openapi,
            StatusCode::OK,
            "The caller's memberships",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::get("/studio-user/v1/users/{user_id}")
        .operation_id("studio_user.get_user")
        .summary("Read any user's profile (platform admin)")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("user_id", "Canonical Studio user id")
        .handler(get_user)
        .json_response_with_schema::<UserProfileDto>(openapi, StatusCode::OK, "The user's profile")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::get("/studio-user/v1/users/{user_id}/memberships")
        .operation_id("studio_user.get_user_memberships")
        .summary("List a user's organization memberships (platform admin)")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("user_id", "Canonical Studio user id")
        .handler(get_user_memberships)
        .json_response_with_schema::<MembershipListDto>(
            openapi,
            StatusCode::OK,
            "The user's memberships",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::put("/studio-user/v1/users/{user_id}/memberships/{org_id}")
        .operation_id("studio_user.put_membership")
        .summary("Set a user's role in an organization (organization owner)")
        .description(
            "Records the role a person holds in one organization. Gated on being an OWNER of that \
             organization; role lives on the membership, never on the profile.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("user_id", "Canonical Studio user id")
        .path_param("org_id", "Organization (tenant) id")
        .json_request::<PutMembershipRequest>(openapi, "The role to record")
        .handler(put_membership)
        .json_response_with_schema::<MembershipDto>(
            openapi,
            StatusCode::OK,
            "The recorded membership",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::delete("/studio-user/v1/users/{user_id}/memberships/{org_id}")
        .operation_id("studio_user.delete_membership")
        .summary("Remove a user's membership in an organization (organization owner)")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("user_id", "Canonical Studio user id")
        .path_param("org_id", "Organization (tenant) id")
        .handler(delete_membership)
        .no_content_response(StatusCode::NO_CONTENT, "Membership removed")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::post("/studio-user/v1/users/{user_id}/aliases")
        .operation_id("studio_user.add_alias")
        .summary("Attribute a non-login external identifier to a user (platform admin)")
        .description(
            "Records an external identifier (commit author, chat handle, external system id) as \
             belonging to a user. 'suggested' attributions are hypotheses and grant nothing.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("user_id", "Canonical Studio user id")
        .json_request::<AddAliasRequest>(openapi, "The external identifier to attribute")
        .handler(add_alias)
        .no_content_response(StatusCode::NO_CONTENT, "Alias recorded")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::post("/studio-user/v1/resolve")
        .operation_id("studio_user.resolve_identity")
        .summary("Resolve a (provider, subject) to a canonical user id (platform admin)")
        .description(
            "Maps a sign-in identity onto its canonical Studio user, provisioning one on first \
             sight. For the authentication edge and administrative tooling.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ResolveRequest>(openapi, "The identity to resolve")
        .handler(resolve_identity)
        .json_response_with_schema::<ResolveResultDto>(
            openapi,
            StatusCode::OK,
            "The canonical user id",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    OperationBuilder::post("/studio-user/v1/merge")
        .operation_id("studio_user.merge_users")
        .summary("Merge one user into another (platform admin)")
        .description(
            "Repoints every sign-in method, alias and membership from the source user onto the \
             target and tombstones the source with a merge pointer, so reads follow it. A \
             cross-organization operation, kept to the platform scope.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<MergeRequest>(openapi, "Source and target users")
        .handler(merge_users)
        .json_response_with_schema::<MergeResultDto>(
            openapi,
            StatusCode::OK,
            "What the merge moved",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service))
}
