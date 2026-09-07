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

use super::alias_policy::Confidence;
use super::service::{
    AliasOutcome, ConfirmReport, IdentityService, LoginView, MembershipView, ProfilePatch,
    UserProfile,
};

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

/// A person's membership in one organization, carrying the role held there.
///
/// **Not** `MembershipDto`: the resource-group system gear already registers a
/// schema by that name, and the OpenAPI registry is shared across the whole
/// assembly — a second definition under the same name panics the boot, not the
/// request. Nothing in `cargo build`, `clippy` or the tests catches it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMembershipDto {
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
    pub items: Vec<OrgMembershipDto>,
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
    /// `suggested`, `claimed` or `confirmed`. Defaults to `suggested`.
    ///
    /// An unrecognised value is a 400, not a silent downgrade to `suggested` —
    /// a typo'd `confirmd` used to become a hypothesis without telling anyone.
    pub confidence: Option<String>,
}

/// The external identity a self-service call is about.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AliasRefRequest {
    /// `github` | `gitlab` | `bitbucket` | ...
    pub kind: String,
    /// The provider-native login or identifier.
    pub external_id: String,
}

/// One external identity attributed to the caller.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AliasDto {
    pub kind: String,
    pub external_id: String,
    /// `suggested` | `claimed` | `confirmed`.
    pub confidence: String,
    /// Whether activity on this identity is attributed to the caller. True only
    /// for `confirmed`.
    pub attributes: bool,
    pub added_at_epoch_ms: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AliasListDto {
    pub aliases: Vec<AliasDto>,
}

/// The answer to a self-service alias write.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AliasWriteDto {
    /// `written` | `written_over_a_proof` | `already_held` | `refused`.
    pub outcome: String,
    /// Present when `outcome` is `refused`: why, in terms the caller can act on.
    pub reason: Option<String>,
    /// The caller's identities after the write.
    pub aliases: Vec<AliasDto>,
}

/// What one confirmation pass over the caller's connections did.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConfirmReportDto {
    pub confirmed: Vec<AliasPairDto>,
    pub already_confirmed: i64,
    /// Team or bot credentials: proving control of a shared account says
    /// nothing about who the caller is.
    pub skipped_shared: i64,
    /// Personal connections belonging to somebody else.
    pub skipped_other_owner: i64,
    /// Personal connections written before the record named its creator.
    pub skipped_unknown_owner: i64,
    pub refused: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AliasPairDto {
    pub kind: String,
    pub external_id: String,
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

fn membership_to_dto(m: MembershipView) -> OrgMembershipDto {
    OrgMembershipDto {
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

/// A request the service rejected on its own terms — a malformed key, a missing
/// user, no connector to confirm against. A client error, not a fault, so it
/// must not read as a 500 the way `internal` would.
fn invalid(error: anyhow::Error) -> CanonicalError {
    UserProfileError::invalid_argument()
        .with_constraint(error.to_string())
        .create()
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
) -> ApiResult<JsonBody<OrgMembershipDto>> {
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

fn parse_confidence(raw: Option<&str>) -> ApiResult<Confidence> {
    let raw = raw.unwrap_or("suggested");
    Confidence::parse(raw).ok_or_else(|| {
        UserProfileError::invalid_argument()
            .with_constraint("confidence must be suggested, claimed or confirmed")
            .create()
    })
}

fn alias_dto(record: super::service::AliasRecord) -> AliasDto {
    let confidence = Confidence::parse(&record.confidence);
    AliasDto {
        kind: record.kind,
        external_id: record.external_id,
        attributes: confidence.is_some_and(Confidence::attributes),
        confidence: record.confidence,
        added_at_epoch_ms: record.added_at_epoch_ms,
    }
}

/// Render an outcome plus the caller's resulting identities, so the UI needs one
/// round trip rather than a write followed by a list.
async fn alias_write_dto(
    service: &Arc<IdentityService>,
    user_id: &str,
    outcome: AliasOutcome,
) -> ApiResult<AliasWriteDto> {
    let aliases = service.list_aliases(user_id).await.map_err(internal)?;
    let (name, reason) = match outcome {
        AliasOutcome::Written => ("written", None),
        AliasOutcome::WrittenOverAProof => ("written_over_a_proof", None),
        AliasOutcome::AlreadyHeld => ("already_held", None),
        AliasOutcome::Refused(reason) => ("refused", Some(reason.to_owned())),
    };
    Ok(AliasWriteDto {
        outcome: name.to_owned(),
        reason,
        aliases: aliases.into_iter().map(alias_dto).collect(),
    })
}

fn confirm_report_dto(report: ConfirmReport) -> ConfirmReportDto {
    ConfirmReportDto {
        confirmed: report
            .confirmed
            .into_iter()
            .map(|(kind, external_id)| AliasPairDto { kind, external_id })
            .collect(),
        already_confirmed: report.already_confirmed as i64,
        skipped_shared: report.skipped_shared as i64,
        skipped_other_owner: report.skipped_other_owner as i64,
        skipped_unknown_owner: report.skipped_unknown_owner as i64,
        refused: report.refused,
    }
}

async fn add_alias(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(user_id): Path<String>,
    Json(req): Json<AddAliasRequest>,
) -> ApiResult<JsonBody<AliasWriteDto>> {
    require_platform_admin(&ctx)?;
    let service = configured(service)?;
    let confidence = parse_confidence(req.confidence.as_deref())?;
    // Through the same gate as the self-service path: an admin writing on
    // somebody's behalf must not be able to silently take an identity another
    // person has proven either.
    let outcome = service
        .attribute_alias(&user_id, &req.kind, &req.external_id, confidence)
        .await
        .map_err(invalid)?;
    Ok(Json(alias_write_dto(&service, &user_id, outcome).await?))
}

// ── self-service (ADR-0012): the person attributes their own identities ─────

async fn list_my_aliases(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<AliasListDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let aliases = service.list_aliases(&user_id).await.map_err(internal)?;
    Ok(Json(AliasListDto {
        aliases: aliases.into_iter().map(alias_dto).collect(),
    }))
}

async fn claim_my_alias(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<AliasRefRequest>,
) -> ApiResult<JsonBody<AliasWriteDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let outcome = service
        .claim_alias(&user_id, &req.kind, &req.external_id)
        .await
        .map_err(invalid)?;
    Ok(Json(alias_write_dto(&service, &user_id, outcome).await?))
}

async fn revoke_my_alias(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<AliasRefRequest>,
) -> ApiResult<JsonBody<AliasWriteDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let outcome = service
        .revoke_alias(&user_id, &req.kind, &req.external_id)
        .await
        .map_err(invalid)?;
    Ok(Json(alias_write_dto(&service, &user_id, outcome).await?))
}

async fn confirm_my_aliases(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<ConfirmReportDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    // The caller's own tenant: the connection catalogue is tenant-scoped, and
    // the credentials that prove an identity are the ones they can read.
    let tenant = ctx.subject_tenant_id();
    let report = service
        .confirm_aliases_from_connections(&ctx, &user_id, tenant)
        .await
        .map_err(invalid)?;
    Ok(Json(confirm_report_dto(report)))
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
        .json_response_with_schema::<OrgMembershipDto>(
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
             belonging to a user. Only 'confirmed' attributes activity; 'claimed' and \
             'suggested' are recorded and grant nothing. Subject to the same write policy as \
             the self-service path: an identity another person has proven is not taken by an \
             unproven assertion, whoever writes it.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("user_id", "Canonical Studio user id")
        .json_request::<AddAliasRequest>(openapi, "The external identifier to attribute")
        .handler(add_alias)
        .json_response_with_schema::<AliasWriteDto>(
            openapi,
            StatusCode::OK,
            "The outcome and the user's identities after it",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // ── self-service (ADR-0012) ────────────────────────────────────────────
    //
    // The person, not an operator, attributes their own external identities:
    // only they know which GitLab account is theirs, and they are the party
    // with the interest in getting it right. The system may suggest; a claim
    // records intent; only a proof of control attributes anything.

    let router = OperationBuilder::get("/studio-user/v1/me/aliases")
        .operation_id("studio_user.list_my_aliases")
        .summary("List the external identities attributed to the caller")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_my_aliases)
        .json_response_with_schema::<AliasListDto>(
            openapi,
            StatusCode::OK,
            "The caller's external identities",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-user/v1/me/aliases")
        .operation_id("studio_user.claim_my_alias")
        .summary("Claim an external identity as the caller's own (attributes nothing yet)")
        .description(
            "Records that the caller says this identity is theirs. It grants nothing until a \
             proof of control confirms it — see POST /me/aliases/confirm. Refused when another \
             person has already claimed or proven the same identity.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<AliasRefRequest>(openapi, "The external identity to claim")
        .handler(claim_my_alias)
        .json_response_with_schema::<AliasWriteDto>(
            openapi,
            StatusCode::OK,
            "The outcome and the caller's identities after it",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-user/v1/me/aliases/confirm")
        .operation_id("studio_user.confirm_my_aliases")
        .summary("Confirm the caller's identities from their own connector credentials")
        .description(
            "Every connection in the catalogue already passed the provider's \"who am I?\" \
             check with that credential, so a personal connection is standing proof that its \
             creator controls the account it resolved to. This records that proof; no token is \
             read and nothing is re-probed. Team and organization credentials are skipped: they \
             prove control of an account, not of the caller's own.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(confirm_my_aliases)
        .json_response_with_schema::<ConfirmReportDto>(
            openapi,
            StatusCode::OK,
            "What was confirmed and what was skipped",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-user/v1/me/aliases/revoke")
        .operation_id("studio_user.revoke_my_alias")
        .summary("Withdraw an external identity the caller holds")
        .description(
            "Removes the attribution, freeing the identity for whoever it really belongs to. \
             Refused for an identity attributed to somebody else. A POST with a body rather \
             than a DELETE with a path: a provider login is user-supplied text.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<AliasRefRequest>(openapi, "The external identity to withdraw")
        .handler(revoke_my_alias)
        .json_response_with_schema::<AliasWriteDto>(
            openapi,
            StatusCode::OK,
            "The outcome and the caller's identities after it",
        )
        .error_400(openapi)
        .error_401(openapi)
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
