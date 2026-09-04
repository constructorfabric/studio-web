//! HTTP surface for the identity/user gear.
//!
//! `/studio-user/v1/me*` is self-service: any authenticated caller resolves to
//! their canonical user and reads or edits their own profile and sign-in
//! methods. The `/studio-user/v1/users*` and `/merge` endpoints are
//! platform-admin only (root tenant), mirroring the identity-directory gear.

use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::service::{
    IdentityService, LoginView, PLATFORM_ROOT_TENANT_ID, ProfilePatch, UserProfile,
};

/// Provider tag for a token minted through Studio's Keycloak realm. Every
/// authenticated request today carries a Keycloak subject.
const PROVIDER_KEYCLOAK: &str = "keycloak";

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
#[toolkit_macros::api_dto(request)]
pub struct AddAliasRequest {
    /// What kind of external identifier this is (e.g. "github", "slack").
    pub kind: String,
    /// The identifier value at that source.
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
}

fn to_dto(profile: UserProfile) -> UserProfileDto {
    UserProfileDto {
        id: profile.id,
        display_name: profile.display_name,
        email: profile.email,
        avatar_url: profile.avatar_url,
        locale: profile.locale,
        created_at_epoch_ms: profile.created_at_epoch_ms,
        updated_at_epoch_ms: profile.updated_at_epoch_ms,
        merged_into: profile.merged_into,
    }
}

fn login_to_dto(login: LoginView) -> LoginDto {
    LoginDto {
        provider: login.provider,
        subject: login.subject,
        verified: login.verified,
        linked_at_epoch_ms: login.linked_at_epoch_ms,
    }
}

fn internal(error: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("identity service failed: {error:#}")).create()
}

fn require_platform_admin(ctx: &SecurityContext) -> ApiResult<()> {
    if ctx.subject_tenant_id() != PLATFORM_ROOT_TENANT_ID {
        return Err(UserProfileError::permission_denied()
            .with_reason("PLATFORM_ADMIN_REQUIRED")
            .create());
    }
    Ok(())
}

/// Resolve the caller's canonical user id, provisioning on first sight. The
/// token subject is an already-authenticated Keycloak identity, so verified.
async fn caller_user_id(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
) -> ApiResult<String> {
    let subject = ctx.subject_id().to_string();
    service
        .resolve_or_provision(ctx, PROVIDER_KEYCLOAK, &subject, None, None, true)
        .await
        .map_err(internal)
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn get_me(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    let user_id = caller_user_id(&ctx, &service).await?;
    let profile = service
        .get_profile(&ctx, &user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal(anyhow::anyhow!("profile missing right after provisioning")))?;
    Ok(Json(to_dto(profile)))
}

async fn update_me(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Json(req): Json<UpdateProfileRequest>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    let user_id = caller_user_id(&ctx, &service).await?;
    let patch = ProfilePatch {
        display_name: req.display_name,
        email: req.email,
        avatar_url: req.avatar_url,
        locale: req.locale,
    };
    let updated = service
        .update_profile(&ctx, &user_id, patch)
        .await
        .map_err(internal)?;
    Ok(Json(to_dto(updated)))
}

async fn get_my_logins(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
) -> ApiResult<JsonBody<LoginListDto>> {
    let user_id = caller_user_id(&ctx, &service).await?;
    let items = service
        .list_logins(&ctx, &user_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(login_to_dto)
        .collect();
    Ok(Json(LoginListDto { items }))
}

async fn get_user(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Path(user_id): Path<String>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    require_platform_admin(&ctx)?;
    let profile = service
        .get_profile(&ctx, &user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            UserProfileError::not_found("no such user")
                .with_resource(user_id.clone())
                .create()
        })?;
    Ok(Json(to_dto(profile)))
}

async fn add_alias(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Path(user_id): Path<String>,
    Json(req): Json<AddAliasRequest>,
) -> ApiResult<StatusCode> {
    require_platform_admin(&ctx)?;
    let confidence = req.confidence.unwrap_or_else(|| "suggested".to_string());
    service
        .add_alias(&ctx, &user_id, &req.kind, &req.external_id, &confidence)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn merge_users(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Json(req): Json<MergeRequest>,
) -> ApiResult<JsonBody<MergeResultDto>> {
    require_platform_admin(&ctx)?;
    let result = service
        .merge(&ctx, &req.from_user_id, &req.into_user_id)
        .await
        .map_err(internal)?;
    Ok(Json(MergeResultDto {
        logins_moved: result.logins_moved as u32,
        aliases_moved: result.aliases_moved as u32,
    }))
}

// ── Routes ──────────────────────────────────────────────────────────────────

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<IdentityService>,
) -> Router {
    let router = OperationBuilder::get("/studio-user/v1/me")
        .operation_id("studio_user.get_me")
        .summary("Resolve the caller to their canonical Studio user and profile")
        .description(
            "Maps the authenticated token subject onto a canonical user, provisioning one the \
             first time an identity is seen, and returns the role-free profile.",
        )
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
        .description("Patches the caller's profile; omitted fields are left unchanged.")
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

    OperationBuilder::post("/studio-user/v1/merge")
        .operation_id("studio_user.merge_users")
        .summary("Merge one user into another (platform admin)")
        .description(
            "Repoints every sign-in method and alias from the source user onto the target and \
             tombstones the source with a merge pointer, so reads follow it.",
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
