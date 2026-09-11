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
use super::leaving;
use super::service::{
    AliasOutcome, ConfirmReport, IdentityService, LoginView, MembershipView, Offered, ProfilePatch,
    UserProfile,
};

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
    /// `active` or `suspended`. A suspended membership grants nothing while it
    /// stands — the organization does not appear in what this person may reach
    /// — and still records that they belong here and in what role.
    pub status: String,
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
    /// `active` (the default) or `suspended`.
    ///
    /// Suspending is not removing: the row stays, with the role it would come
    /// back to. It is the same edit to the same row as changing a role, so it
    /// arrives on the same request and passes the same rule — an organization
    /// cannot be left with no owner who can act, whichever of the two did it.
    #[serde(default)]
    pub status: Option<String>,
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
    /// Brokered logins whose provider reported no handle to attribute.
    pub skipped_no_handle: i64,
    pub refused: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct InviteRequest {
    /// The address the invitation is bound to. Only somebody whose identity
    /// provider has verified this address can accept it.
    pub email: String,
    /// `member` or `admin`. Not `owner` — ownership is not something a link
    /// can confer.
    pub role: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InvitationDto {
    pub id: String,
    pub org_id: String,
    pub email: String,
    pub role: String,
    pub expires_at_epoch_ms: i64,
    pub accepted_at_epoch_ms: Option<i64>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InvitationCreatedDto {
    pub invitation: InvitationDto,
    /// Shown once and never again — only its digest is stored. Hand it to the
    /// person being invited.
    pub token: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InvitationListDto {
    pub items: Vec<InvitationDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AcceptInvitationRequest {
    /// The token from the invitation message. Send this or `invitation_id`.
    #[serde(default)]
    pub token: Option<String>,
    /// The id of one of the invitations `GET /me/invitations` listed for you.
    ///
    /// That listing is built by matching invitations to addresses this person
    /// has proven, so an id from it carries the same proof the token does —
    /// which is what makes accepting from the portal possible at all, since the
    /// token is never stored and cannot be shown again.
    #[serde(default)]
    pub invitation_id: Option<String>,
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
        status: m.status,
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

/// Is the caller a platform administrator?
///
/// One signal: **a membership of the platform root**. That is an answer about
/// the *person*, so it holds however they signed in.
///
/// The token's tenant used to be accepted as well. It was an answer about one
/// *login*, which made somebody an administrator through one sign-in method and
/// an ordinary member through another — the thing ADR-0018 §3 set out to end.
/// This is that migration's third step: the installation seeds its
/// administrators (`platform_admins`), the backfill wrote the rows for the
/// identities that already carried the `tenant_id` attribute, and with the
/// reading gone the attribute has no organizational purpose left — which is
/// what ADR-0016's follow-up was waiting for.
async fn is_platform_admin(ctx: &SecurityContext, service: &Arc<IdentityService>) -> bool {
    service
        .is_platform_admin(&ctx.subject_id().to_string())
        .await
        .unwrap_or(false)
}

async fn require_platform_admin(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
) -> ApiResult<()> {
    if is_platform_admin(ctx, service).await {
        Ok(())
    } else {
        Err(UserProfileError::permission_denied()
            .with_reason("PLATFORM_ADMIN_REQUIRED")
            .create())
    }
}

/// A membership write needs authority over that organization: its owner has it,
/// and so does a platform administrator.
///
/// The platform arm is not a convenience. Assignment from the identity directory
/// is a platform act (ADR-0011 §4 — only a platform administrator appoints an
/// organization's first owner), so an owner-only gate makes the very first
/// membership of a fresh organization unwritable: there is nobody to write it.
async fn require_org_authority(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
    org_id: Uuid,
) -> ApiResult<()> {
    if is_platform_admin(ctx, service).await || service.is_org_owner(ctx, org_id).await {
        Ok(())
    } else {
        Err(UserProfileError::permission_denied()
            .with_reason("ORG_OWNER_REQUIRED")
            .create())
    }
}

/// Turn a last-owner refusal into an answer the caller can act on.
///
/// `NotAMember` is a 404 — there is no membership at that address to end. The
/// other two are 400: the request is well-formed and the caller is allowed, but
/// the organization would be left without an owner, and the message says what
/// to do first.
fn refused(refusal: leaving::Refusal, user_id: &str, org_id: &str) -> CanonicalError {
    match refusal {
        leaving::Refusal::NotAMember => UserProfileError::not_found(refusal.message())
            .with_resource(format!("{user_id}@{org_id}"))
            .create(),
        _ => UserProfileError::invalid_argument()
            .with_constraint(refusal.message())
            .create(),
    }
}

fn parse_org(org_id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(org_id).map_err(|_| {
        UserProfileError::invalid_argument()
            .with_constraint("org_id must be a uuid")
            .create()
    })
}

/// Resolve the caller's canonical user id, provisioning on first sight.
///
/// Thin on purpose: the resolution itself belongs to the service, where every
/// other gear reaches it through `PersonResolver` (ADR-0014). Two copies of this
/// rule is how a human ends up keyed two different ways.
async fn caller_user_id(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
) -> ApiResult<String> {
    service.resolve_caller(ctx).await.map_err(internal)
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

/// What leaving took with it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct LeaveResultDto {
    /// How many of the leaver's personal connections were removed along with
    /// the membership. Reported rather than silent: it is their credentials
    /// that just disappeared, and they should be told how many.
    pub connections_removed: u32,
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
    let service = configured(service)?;
    require_platform_admin(&ctx, &service).await?;
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
    let service = configured(service)?;
    require_platform_admin(&ctx, &service).await?;
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
    require_org_authority(&ctx, &service, org).await?;
    let status = req.status.as_deref().unwrap_or(leaving::STATUS_ACTIVE);
    if !leaving::STATUSES.contains(&status) {
        return Err(UserProfileError::invalid_argument()
            .with_constraint(format!(
                "status must be one of {}",
                leaving::STATUSES.join(", ")
            ))
            .create());
    }
    let after = leaving::Standing {
        role: req.role.clone(),
        status: status.to_owned(),
    };
    let source = req.source.unwrap_or_else(|| "manual".to_string());
    // A role change or a suspension can remove the last owner who can act just
    // as surely as a removal can, so both go through the one gate.
    match service
        .set_membership_standing(&user_id, &org_id, &after, &source)
        .await
        .map_err(internal)?
    {
        Ok(membership) => Ok(Json(membership_to_dto(membership))),
        Err(refusal) => Err(refused(refusal, &user_id, &org_id)),
    }
}

async fn delete_membership(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((user_id, org_id)): Path<(String, String)>,
) -> ApiResult<JsonBody<LeaveResultDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org).await?;
    // Removed by an owner or walking out on their own, the departure is the
    // same one: the same invariant holds it back, and the same credentials go
    // with it.
    leave(&ctx, &service, &user_id, org).await
}

async fn leave_my_organization(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(org_id): Path<String>,
) -> ApiResult<JsonBody<LeaveResultDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    // No authority gate: leaving is nobody's permission to give. The last-owner
    // rule is the only thing that can hold it back.
    let user_id = caller_user_id(&ctx, &service).await?;
    leave(&ctx, &service, &user_id, org).await
}

async fn leave(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
    user_id: &str,
    org: Uuid,
) -> ApiResult<JsonBody<LeaveResultDto>> {
    match service
        .leave_organization(ctx, user_id, org)
        .await
        .map_err(internal)?
    {
        Ok(connections_removed) => Ok(Json(LeaveResultDto {
            connections_removed: connections_removed as u32,
        })),
        Err(refusal) => Err(refused(refusal, user_id, &org.to_string())),
    }
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
        skipped_no_handle: report.skipped_no_handle as i64,
        refused: report.refused,
    }
}

async fn add_alias(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(user_id): Path<String>,
    Json(req): Json<AddAliasRequest>,
) -> ApiResult<JsonBody<AliasWriteDto>> {
    let service = configured(service)?;
    require_platform_admin(&ctx, &service).await?;
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
        .confirm_aliases(&ctx, &user_id, tenant)
        .await
        .map_err(invalid)?;
    Ok(Json(confirm_report_dto(report)))
}

fn invitation_dto(r: super::service::InvitationRecord) -> InvitationDto {
    InvitationDto {
        id: r.id,
        org_id: r.org_id,
        email: r.email,
        role: r.role,
        expires_at_epoch_ms: r.expires_at_epoch_ms,
        accepted_at_epoch_ms: r.accepted_at_epoch_ms,
    }
}

async fn invite_to_organization(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(org_id): Path<String>,
    Json(req): Json<InviteRequest>,
) -> ApiResult<JsonBody<InvitationCreatedDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org).await?;
    let inviter = caller_user_id(&ctx, &service).await?;
    let (record, token) = service
        .invite(org, &inviter, &req.email, &req.role)
        .await
        .map_err(invalid)?;
    Ok(Json(InvitationCreatedDto {
        invitation: invitation_dto(record),
        token,
    }))
}

async fn list_organization_invitations(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(org_id): Path<String>,
) -> ApiResult<JsonBody<InvitationListDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org).await?;
    let items = service
        .invitations_of(org)
        .await
        .map_err(internal)?
        .into_iter()
        .map(invitation_dto)
        .collect();
    Ok(Json(InvitationListDto { items }))
}

async fn revoke_invitation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((org_id, invitation_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org).await?;
    if service
        .revoke_invitation(org, &invitation_id)
        .await
        .map_err(internal)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(
            UserProfileError::not_found("no such invitation in this organization")
                .with_resource(invitation_id)
                .create(),
        )
    }
}

async fn my_invitations(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<InvitationListDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let emails = service.verified_emails(&user_id).await.map_err(internal)?;
    let items = service
        .invitations_waiting_for(&emails)
        .await
        .map_err(internal)?
        .into_iter()
        .map(invitation_dto)
        .collect();
    Ok(Json(InvitationListDto { items }))
}

async fn accept_invitation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<AcceptInvitationRequest>,
) -> ApiResult<JsonBody<OrgMembershipDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let emails = service.verified_emails(&user_id).await.map_err(internal)?;
    let offered = match (req.token.as_deref(), req.invitation_id.as_deref()) {
        (Some(token), None) => Offered::Token(token),
        (None, Some(id)) => Offered::Id(id),
        _ => {
            return Err(UserProfileError::invalid_argument()
                .with_constraint("send exactly one of token or invitation_id")
                .create());
        }
    };
    match service
        .accept_invitation(&user_id, &offered, &emails)
        .await
        .map_err(internal)?
    {
        Ok(membership) => Ok(Json(membership_to_dto(membership))),
        // Every refusal is the caller's to act on and none of them reveals
        // anything about an invitation they do not hold.
        Err(refusal) => Err(UserProfileError::invalid_argument()
            .with_constraint(refusal.message())
            .create()),
    }
}

async fn merge_users(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<MergeRequest>,
) -> ApiResult<JsonBody<MergeResultDto>> {
    let service = configured(service)?;
    require_platform_admin(&ctx, &service).await?;
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
    let service = configured(service)?;
    require_platform_admin(&ctx, &service).await?;
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
        .description(
            "Resolves the caller's token subject to their canonical Studio user \
             and returns the profile, provisioning the user on first sight: an \
             authenticated subject nobody has seen before is a new person, not an \
             error.",
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
        .description(
            "Updates the caller's own profile. Roles are not here — a role is \
             held in an organization and lives on the membership.",
        )
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
        .description(
            "Returns the sign-in methods that resolve to the caller. One person \
             reached through different providers is one user with several logins.",
        )
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
        .description(
            "Returns the organizations the caller belongs to, and the role held \
             in each.",
        )
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
        .description(
            "Returns any user's profile. Platform-admin view of what `/me` \
             returns to the user themselves.",
        )
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
        .description(
            "Returns any user's organization memberships and roles. Platform- \
             admin view.",
        )
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
        .summary("Set a user's role or standing in an organization (organization owner)")
        .description(
            "Records the role a person holds in one organization, and whether that membership \
             currently applies. Gated on being an OWNER of that organization; role lives on the \
             membership, never on the profile. `status: suspended` stops the membership granting \
             anything — the organization disappears from what that person may reach — while \
             keeping the record of where they belong and what they would come back to; leaving \
             and removal delete the row instead. Refused where it would leave the organization \
             with no owner able to act, whether by demotion or by suspension.",
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
        .description(
            "Removes a user's membership in an organization, and the role that came with it, \
             along with the personal connections they created there. The user record and their \
             other memberships are untouched. Organization owners only, and refused where it \
             would leave the organization without an owner — the same rule that applies when \
             somebody leaves of their own accord.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("user_id", "Canonical Studio user id")
        .path_param("org_id", "Organization (tenant) id")
        .handler(delete_membership)
        .json_response_with_schema::<LeaveResultDto>(
            openapi,
            StatusCode::OK,
            "Membership removed, and what went with it",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::delete("/studio-user/v1/me/memberships/{org_id}")
        .operation_id("studio_user.leave_organization")
        .summary("Leave an organization")
        .description(
            "Ends the caller's own membership. Nobody's permission is needed for it, and the \
             only thing that refuses it is the rule that an organization always has an owner: \
             its only owner is told to appoint another first, and its only person is told that \
             leaving would mean deleting the organization, which is a separate act. Documents, \
             projects and authorship stay with the organization; the caller's personal \
             connections do not, and the response says how many were removed.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("org_id", "Organization (tenant) id")
        .handler(leave_my_organization)
        .json_response_with_schema::<LeaveResultDto>(
            openapi,
            StatusCode::OK,
            "Left, and what went with it",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
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
        .description(
            "Returns the external identities attributed to the caller — emails \
             and handles they have claimed — and whether each is confirmed. An \
             unconfirmed alias cannot be used to absorb another account.",
        )
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

    let router = OperationBuilder::post("/studio-user/v1/organizations/{org_id}/invitations")
        .operation_id("studio_user.invite_to_organization")
        .summary("Invite an address into an organization")
        .description(
            "An owner or a platform administrator invites somebody by e-mail. The token comes \
             back once and is stored only as a digest, so it cannot be shown again — hand it to \
             the person being invited. It expires, it works once, and it can only be accepted by \
             somebody whose identity provider has verified that address: a forwarded invitation \
             is not a way into an organization. The role may be `member` or `admin`; ownership \
             is not something a link can confer.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("org_id", "Organization tenant id")
        .json_request::<InviteRequest>(openapi, "Who to invite, and as what")
        .handler(invite_to_organization)
        .json_response_with_schema::<InvitationCreatedDto>(
            openapi,
            StatusCode::OK,
            "The invitation and its one-time token",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-user/v1/organizations/{org_id}/invitations")
        .operation_id("studio_user.list_organization_invitations")
        .summary("List an organization's invitations")
        .description("Tokens are never included — only their digests are stored.")
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("org_id", "Organization tenant id")
        .handler(list_organization_invitations)
        .json_response_with_schema::<InvitationListDto>(openapi, StatusCode::OK, "Invitations")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::delete(
        "/studio-user/v1/organizations/{org_id}/invitations/{invitation_id}",
    )
    .operation_id("studio_user.revoke_invitation")
    .summary("Withdraw an invitation")
    .description(
        "Deletes it outright rather than marking it spent: an invitation nobody may use again          has nothing left to record, and a withdrawn row left behind would keep appearing in          the organization's list. Answers 404 when there is no such invitation in this          organization — the organization is part of the lookup, so one organization's owner          cannot withdraw another's.",
    )
    .tag("StudioUser")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("org_id", "Organization tenant id")
    .path_param("invitation_id", "Invitation id")
    .handler(revoke_invitation)
    .no_content_response(StatusCode::NO_CONTENT, "Withdrawn")
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-user/v1/me/invitations")
        .operation_id("studio_user.my_invitations")
        .summary("Invitations waiting for the signed-in person")
        .description(
            "Matched against every address this person's identity provider has verified, across \
             all of their sign-in methods — an invitation sent to the address on one login is \
             theirs whichever way they signed in today. The profile e-mail is not used: it is \
             self-service, so believing it would let anybody claim any invitation.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(my_invitations)
        .json_response_with_schema::<InvitationListDto>(openapi, StatusCode::OK, "Invitations")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-user/v1/me/invitations/accept")
        .operation_id("studio_user.accept_invitation")
        .summary("Accept an invitation and become a member")
        .description(
            "Single use, decided by the database rather than by a check followed by a write, so \
             two acceptances racing produce one member and one refusal.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<AcceptInvitationRequest>(openapi, "The invitation token")
        .handler(accept_invitation)
        .json_response_with_schema::<OrgMembershipDto>(
            openapi,
            StatusCode::OK,
            "The membership it produced",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

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
