//! HTTP surface for the identity/user gear.
//!
//! `/studio-user/v1/me*` is self-service: any authenticated caller resolves to
//! their own canonical user and reads/edits their profile, sign-in methods and
//! memberships. Membership WRITES for an organization are gated on being an
//! OWNER of that organization (per-org authority, not a platform-wide admin).
//! Cross-org identity operations (read any user, alias, merge, resolve) are a
//! narrow platform-admin action.

use std::sync::Arc;

use axum::{
    Extension, Router,
    extract::{Path, Query},
};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::alias_policy::Confidence;
use super::leaving;
use super::service::{
    AliasOutcome, Colleague, ConfirmReport, DirectoryProfile, IdentityService, LoginView,
    MembershipView, Offered, PersonEmail, ProfilePatch, UserProfile, check_ui_preferences,
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
    /// The address the person typed. `emails` lists every address they hold.
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
    pub created_at_epoch_ms: i64,
    pub updated_at_epoch_ms: i64,
    pub merged_into: Option<String>,
    /// Every address the person can be reached at: the profile's, each
    /// sign-in's and each attributed `email` identity, primary first marked.
    pub emails: Vec<PersonEmailDto>,
    /// When the person last made a request, to within five minutes; null
    /// until they are seen.
    pub last_seen_at_epoch_ms: Option<i64>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
}

/// The caller's remembered UI choices.
///
/// A flat map of short strings whose keys the portal owns — `projects.view`
/// is `table` or `tiles`, and this gear has no opinion on either. What it does
/// own is the size: see `check_ui_preferences`.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct UiPreferencesDto {
    pub preferences: std::collections::BTreeMap<String, String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpdateUiPreferencesRequest {
    /// The complete set. Sent whole, stored whole — a merge would leave no way
    /// to forget a preference, because an absent key would mean "unchanged"
    /// rather than "drop it".
    pub preferences: std::collections::BTreeMap<String, String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct LoginDto {
    pub provider: String,
    pub subject: String,
    pub verified: bool,
    pub linked_at_epoch_ms: i64,
    /// The address the identity provider holds for this sign-in, as last read.
    pub email: Option<String>,
    /// Whether the identity provider vouches for that address.
    pub email_verified: bool,
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

/// One address a person can be reached at.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PersonEmailDto {
    /// Lowercased.
    pub address: String,
    /// `profile` (typed by the person), `sign_in` (what the identity provider
    /// holds for one of their logins) or `alias` (an attributed `email`
    /// identity).
    pub source: String,
    /// Whether the identity provider, or a confirmed alias, vouches for it.
    pub verified: bool,
    /// The one to show first.
    pub primary: bool,
}

/// How an organization describes one of its people. Shown, never decided
/// from.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MemberDirectoryDto {
    /// The company the person works for.
    pub affiliation: Option<String>,
    pub department: Option<String>,
    /// Job title.
    pub title: Option<String>,
    /// The member they report to, as a user id.
    pub reports_to: Option<String>,
}

/// How the organization describes one member, sent whole: an absent or
/// blank field clears it.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpdateMemberDirectoryRequest {
    pub affiliation: Option<String>,
    pub department: Option<String>,
    pub title: Option<String>,
    /// A member of the same organization, by user id.
    pub reports_to: Option<String>,
}

/// A photo to store, base64-encoded.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UploadAvatarRequest {
    /// `image/png`, `image/jpeg`, `image/webp` or `image/gif`; it must match
    /// the bytes.
    pub content_type: String,
    /// Standard base64 of the image, at most 1 MiB decoded.
    pub data: String,
}

/// Somebody the caller shares an organization with, as any member of it
/// sees them (ADR-0036). No addresses and no sign-ins: those stay with
/// `people.view`.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ColleagueDto {
    /// The organization this row is about; a person in two shared
    /// organizations has a row in each, with that organization's description.
    pub org_id: String,
    pub user_id: String,
    /// Absent when the person never gave a name and the realm had none.
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// `owner`, `admin` or `member`.
    pub role: String,
    pub directory: MemberDirectoryDto,
    /// When they last made a request, to within five minutes.
    pub last_seen_at_epoch_ms: Option<i64>,
}

/// A page of colleagues.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ColleagueListDto {
    pub items: Vec<ColleagueDto>,
    pub total: u32,
}

/// One member of an organization, with who they are: what a members screen
/// shows. The profile fields are absent when the person's profile cannot be
/// read (a person merged away, a row older than profiles).
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrganizationMemberDto {
    pub user_id: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    /// Every address the member holds; see `UserProfileDto.emails`.
    pub emails: Vec<PersonEmailDto>,
    pub avatar_url: Option<String>,
    /// When the member last made a request; null until they are seen.
    pub last_seen_at_epoch_ms: Option<i64>,
    /// How the organization describes the member.
    pub directory: MemberDirectoryDto,
    pub role: String,
    /// `active` or `suspended`.
    pub status: String,
    /// How the membership arose: `creation`, `assignment`, `invitation`,
    /// `bootstrap`, `first_login`, `manual`.
    pub source: String,
    pub created_at_epoch_ms: i64,
    pub updated_at_epoch_ms: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrganizationMemberListDto {
    pub items: Vec<OrganizationMemberDto>,
    /// Members across every page.
    pub total: u32,
}

/// Everything that identifies one member: how they sign in, and which external
/// accounts are attributed to them. What a members screen shows when a row is
/// opened.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MemberIdentitiesDto {
    pub user_id: String,
    /// Sign-in methods, oldest first. For `provider: keycloak` the `subject` is
    /// the realm user id the identity directory lists.
    pub logins: Vec<LoginDto>,
    /// Attributed external identities, strongest first.
    pub aliases: Vec<AliasDto>,
}

/// The roles a membership may carry. `owner` is the one that administers
/// (its access-config grant is kept in step with it); `admin` and `member`
/// are what an invitation may offer.
pub const MEMBERSHIP_ROLES: &[&str] = &[crate::access_config::ROLE_OWNER, "admin", "member"];

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
    /// How the organization describes the person — company, department,
    /// title, manager. Absent leaves the description as it is; present
    /// replaces it whole.
    #[serde(default)]
    pub directory: Option<UpdateMemberDirectoryRequest>,
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
    /// Grants that named the merged-away person and now name the target.
    pub grants_moved: u32,
}

/// What a grant rekey did (ADR-0040 §5).
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RekeyReportDto {
    /// Organizations whose access config was read.
    pub organizations: u32,
    /// Grants that now name a person rather than a login, plus the duplicates
    /// the rewrite produced and removed. Zero on a second run.
    pub rewritten: u32,
    /// Organizations that could not be read or written; re-run to retry them.
    pub failed: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ResolveRequest {
    pub provider: String,
    pub subject: String,
    /// What to call the person when this is the first time they are seen —
    /// an administrator adding somebody who has not signed in yet knows their
    /// name from the identity provider. Ignored for a person who exists.
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ResolveResultDto {
    pub user_id: String,
}

fn to_dto(p: UserProfile, emails: Vec<PersonEmail>) -> UserProfileDto {
    UserProfileDto {
        id: p.id,
        display_name: p.display_name,
        email: p.email,
        avatar_url: p.avatar_url,
        locale: p.locale,
        created_at_epoch_ms: p.created_at_epoch_ms,
        updated_at_epoch_ms: p.updated_at_epoch_ms,
        merged_into: p.merged_into,
        emails: emails.into_iter().map(email_dto).collect(),
        last_seen_at_epoch_ms: p.last_seen_at_epoch_ms,
    }
}

fn login_to_dto(l: LoginView) -> LoginDto {
    LoginDto {
        provider: l.provider,
        subject: l.subject,
        verified: l.verified,
        linked_at_epoch_ms: l.linked_at_epoch_ms,
        email: l.email,
        email_verified: l.email_verified,
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

fn email_dto(e: PersonEmail) -> PersonEmailDto {
    PersonEmailDto {
        address: e.address,
        source: e.source.to_owned(),
        verified: e.verified,
        primary: e.primary,
    }
}

fn directory_dto(d: DirectoryProfile) -> MemberDirectoryDto {
    MemberDirectoryDto {
        affiliation: d.affiliation,
        department: d.department,
        title: d.title,
        reports_to: d.reports_to,
    }
}

/// A profile as the API answers it: with every address the person holds.
async fn profile_dto(service: &IdentityService, profile: UserProfile) -> ApiResult<UserProfileDto> {
    let emails = service
        .emails_of(&profile.id, profile.email.as_deref())
        .await
        .map_err(internal)?;
    Ok(to_dto(profile, emails))
}

/// How many people a members listing asks the realm about at once.
const REALM_READ_WINDOW: usize = 4;

fn colleague_dto(c: Colleague) -> ColleagueDto {
    ColleagueDto {
        org_id: c.org_id,
        user_id: c.user_id,
        display_name: c.display_name,
        avatar_url: c.avatar_url,
        role: c.role,
        directory: directory_dto(c.directory),
        last_seen_at_epoch_ms: c.last_seen_at_epoch_ms,
    }
}

async fn list_my_colleagues(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Query(page): Query<crate::pagination::PageQuery>,
) -> ApiResult<JsonBody<ColleagueListDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let items = service
        .colleagues(&user_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(colleague_dto)
        .collect();
    let (items, total) = crate::pagination::page_of(items, page);
    Ok(Json(ColleagueListDto { items, total }))
}

async fn upsert_my_avatar(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<UploadAvatarRequest>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    use base64::Engine as _;
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.data.trim())
        .map_err(|_| {
            UserProfileError::invalid_argument()
                .with_constraint("data must be standard base64")
                .create()
        })?;
    let profile = service
        .set_avatar(&user_id, &req.content_type, bytes)
        .await
        .map_err(invalid)?;
    Ok(Json(profile_dto(&service, profile).await?))
}

async fn delete_my_avatar(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<UserProfileDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let profile = service.remove_avatar(&user_id).await.map_err(internal)?;
    Ok(Json(profile_dto(&service, profile).await?))
}

/// Serve a stored photo. Anonymous because an `<img>` sends no token; the
/// digest in the path is only learned from a profile read the caller was
/// allowed to make. The answer for a version is the same forever, so it is
/// cached as immutable.
async fn get_avatar(
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((user_id, digest)): Path<(String, String)>,
) -> axum::response::Response {
    use axum::http::{HeaderValue, header};
    use axum::response::IntoResponse;
    let not_found = || (StatusCode::NOT_FOUND, "no such photo").into_response();
    let Some(service) = service else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "studio-user has no database",
        )
            .into_response();
    };
    match service.avatar(&user_id, &digest).await {
        Ok(Some(avatar)) => {
            let mut response = avatar.bytes.into_response();
            let headers = response.headers_mut();
            if let Ok(value) = HeaderValue::from_str(&avatar.content_type) {
                headers.insert(header::CONTENT_TYPE, value);
            }
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=31536000, immutable"),
            );
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("default-src 'none'; sandbox"),
            );
            response
        }
        Ok(None) => not_found(),
        Err(error) => {
            tracing::warn!(user = %user_id, "studio-user: could not read a photo: {error:#}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "the photo could not be read",
            )
                .into_response()
        }
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

/// An administrative act on an organization needs authority over it: its owner
/// has it, a platform administrator has it, and — for an organization on the
/// roles model — so does whoever holds `privilege` (ADR-0019 §2).
///
/// The platform arm is not a convenience. Assignment from the identity directory
/// is a platform act (ADR-0011 §4 — only a platform administrator appoints an
/// organization's first owner), so an owner-only gate makes the very first
/// membership of a fresh organization unwritable: there is nobody to write it.
///
/// The refusal still says `ORG_OWNER_REQUIRED`. Every organization is on the
/// `tenant` model, where ownership is the only arm that can fire, so the reason
/// is still true of every refusal this can currently produce — and ADR-0016
/// documents that code against these routes.
async fn require_org_authority(
    ctx: &SecurityContext,
    service: &Arc<IdentityService>,
    org_id: Uuid,
    privilege: &str,
) -> ApiResult<()> {
    if is_platform_admin(ctx, service).await || service.may_administer(ctx, org_id, privilege).await
    {
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
/// other gear reaches it through `PersonResolver` (ADR-0025). Two copies of this
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
    // A person first seen through a token has no name yet; the realm has one.
    service.refresh_from_realm(&user_id).await;
    let profile = service
        .get_profile(&user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal(anyhow::anyhow!("profile missing right after provisioning")))?;
    Ok(Json(profile_dto(&service, profile).await?))
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
    Ok(Json(profile_dto(&service, updated).await?))
}

async fn get_my_ui_preferences(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<UiPreferencesDto>> {
    let service = configured(service)?;
    let user_id = caller_user_id(&ctx, &service).await?;
    let preferences = service.ui_preferences(&user_id).await.map_err(internal)?;
    Ok(Json(UiPreferencesDto { preferences }))
}

async fn update_my_ui_preferences(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Json(req): Json<UpdateUiPreferencesRequest>,
) -> ApiResult<JsonBody<UiPreferencesDto>> {
    let service = configured(service)?;
    // Refused before the caller is resolved would be tidier, but resolving is
    // what provisions a first-time user — and a person whose very first act is
    // to change a view should not have to sign in twice for it to stick.
    let user_id = caller_user_id(&ctx, &service).await?;
    if let Err(why) = check_ui_preferences(&req.preferences) {
        return Err(invalid(anyhow::anyhow!("{why}")));
    }
    let preferences = service
        .set_ui_preferences(&user_id, req.preferences)
        .await
        .map_err(internal)?;
    Ok(Json(UiPreferencesDto { preferences }))
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
    Ok(Json(profile_dto(&service, profile).await?))
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

async fn list_organization_members(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(org_id): Path<String>,
    Query(page): Query<crate::pagination::PageQuery>,
) -> ApiResult<JsonBody<OrganizationMemberListDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org, "people.view").await?;
    let org_key = org.to_string();
    let mut rows = service
        .members_with_profiles(&org_key)
        .await
        .map_err(internal)?;
    // Name the people the realm can name before answering, a few at a time.
    // Each person is asked once per process, so a later listing pays nothing.
    let unnamed: Vec<String> = rows
        .iter()
        .filter(|(_, p)| {
            p.as_ref()
                .is_none_or(|p| p.display_name.is_none() || p.email.is_none())
        })
        .map(|(m, _)| m.user_id.clone())
        .collect();
    if !unnamed.is_empty() {
        use futures_util::StreamExt as _;
        futures_util::stream::iter(unnamed)
            .for_each_concurrent(REALM_READ_WINDOW, |user_id| {
                let service = service.clone();
                async move { service.refresh_from_realm(&user_id).await }
            })
            .await;
        rows = service
            .members_with_profiles(&org_key)
            .await
            .map_err(internal)?;
    }
    let directory = service.directory_of(&org_key).await.map_err(internal)?;
    let people: Vec<(String, Option<String>)> = rows
        .iter()
        .map(|(m, p)| (m.user_id.clone(), p.as_ref().and_then(|p| p.email.clone())))
        .collect();
    let mut emails_of = service.emails_of_people(&people).await.map_err(internal)?;
    let mut items = Vec::with_capacity(rows.len());
    for (m, profile) in rows {
        let emails = emails_of.remove(&m.user_id).unwrap_or_default();
        let described = directory.get(&m.user_id).cloned().unwrap_or_default();
        items.push(OrganizationMemberDto {
            display_name: profile.as_ref().and_then(|p| p.display_name.clone()),
            email: profile.as_ref().and_then(|p| p.email.clone()),
            emails: emails.into_iter().map(email_dto).collect(),
            avatar_url: profile.as_ref().and_then(|p| p.avatar_url.clone()),
            last_seen_at_epoch_ms: profile.as_ref().and_then(|p| p.last_seen_at_epoch_ms),
            directory: directory_dto(described),
            user_id: m.user_id,
            role: m.role,
            status: m.status,
            source: m.source,
            created_at_epoch_ms: m.created_at_epoch_ms,
            updated_at_epoch_ms: m.updated_at_epoch_ms,
        });
    }
    let (items, total) = crate::pagination::page_of(items, page);
    Ok(Json(OrganizationMemberListDto { items, total }))
}

async fn get_member_identities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((org_id, user_id)): Path<(String, String)>,
) -> ApiResult<JsonBody<MemberIdentitiesDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org, "people.view").await?;
    let (logins, aliases) = service
        .member_identities(&org.to_string(), &user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            UserProfileError::not_found("not a member of this organization")
                .with_resource(format!("{user_id}@{org}"))
                .create()
        })?;
    Ok(Json(MemberIdentitiesDto {
        user_id,
        logins: logins.into_iter().map(login_to_dto).collect(),
        aliases: aliases.into_iter().map(alias_dto).collect(),
    }))
}

async fn put_membership(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((user_id, org_id)): Path<(String, String)>,
    Json(req): Json<PutMembershipRequest>,
) -> ApiResult<JsonBody<OrgMembershipDto>> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org, "people.manage").await?;
    if !MEMBERSHIP_ROLES.contains(&req.role.as_str()) {
        return Err(UserProfileError::invalid_argument()
            .with_constraint(format!(
                "role must be one of {}",
                MEMBERSHIP_ROLES.join(", ")
            ))
            .create());
    }
    let status = req.status.as_deref().unwrap_or(leaving::STATUS_ACTIVE);
    if !leaving::STATUSES.contains(&status) {
        return Err(UserProfileError::invalid_argument()
            .with_constraint(format!(
                "status must be one of {}",
                leaving::STATUSES.join(", ")
            ))
            .create());
    }
    // Checked before anything is written, so a bad description cannot
    // leave the role changed and the request refused.
    let directory = match req.directory {
        Some(d) => Some(
            service
                .checked_directory(
                    &org.to_string(),
                    &user_id,
                    DirectoryProfile {
                        affiliation: d.affiliation,
                        department: d.department,
                        title: d.title,
                        reports_to: d.reports_to,
                    },
                )
                .await
                .map_err(invalid)?,
        ),
        None => None,
    };
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
        Ok(membership) => {
            // The grant follows the row: an active owner administers, anyone
            // else — demoted, suspended — does not.
            let owner = membership.role == crate::access_config::ROLE_OWNER
                && membership.status == leaving::STATUS_ACTIVE;
            service
                .sync_owner_grant(&ctx, &membership.user_id, org, owner)
                .await
                .map_err(internal)?;
            if let Some(directory) = directory {
                service
                    .set_member_directory(&org.to_string(), &membership.user_id, directory)
                    .await
                    .map_err(internal)?;
            }
            Ok(Json(membership_to_dto(membership)))
        }
        Err(refusal) => Err(refused(refusal, &user_id, &org_id)),
    }
}

async fn delete_membership(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path((user_id, org_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let service = configured(service)?;
    let org = parse_org(&org_id)?;
    require_org_authority(&ctx, &service, org, "people.manage").await?;
    // Removed by an owner or walking out on their own, the departure is the
    // same one: the same invariant holds it back, and the same credentials go
    // with it.
    leave(&ctx, &service, &user_id, org).await
}

async fn leave_my_organization(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
    Path(org_id): Path<String>,
) -> ApiResult<StatusCode> {
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
) -> ApiResult<StatusCode> {
    match service
        .leave_organization(ctx, user_id, org)
        .await
        .map_err(internal)?
    {
        Ok(connections_removed) => {
            // Gone from the room, gone from its administration: an owner grant
            // left behind would let somebody who is not a member any more
            // still administer the organization.
            service
                .sync_owner_grant(ctx, user_id, org, false)
                .await
                .map_err(internal)?;
            // How many credentials went with the membership is logged, not
            // answered: a DELETE is 204.
            tracing::info!(
                user = %user_id,
                organization = %org,
                connections_removed,
                "studio-user: membership ended"
            );
            Ok(StatusCode::NO_CONTENT)
        }
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
    require_org_authority(&ctx, &service, org, "people.invite").await?;
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
    require_org_authority(&ctx, &service, org, "people.view").await?;
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
    require_org_authority(&ctx, &service, org, "people.invite").await?;
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
        .merge_with_grants(&ctx, &req.from_user_id, &req.into_user_id)
        .await
        .map_err(internal)?;
    Ok(Json(MergeResultDto {
        logins_moved: result.logins_moved as u32,
        aliases_moved: result.aliases_moved as u32,
        memberships_moved: result.memberships_moved as u32,
        grants_moved: result.grants_moved as u32,
    }))
}

async fn rekey_grants(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityService>>>,
) -> ApiResult<JsonBody<RekeyReportDto>> {
    let service = configured(service)?;
    require_platform_admin(&ctx, &service).await?;
    let report = service.rekey_all_grants(&ctx).await.map_err(internal)?;
    Ok(Json(RekeyReportDto {
        organizations: report.organizations as u32,
        rewritten: report.rewritten as u32,
        failed: report.failed as u32,
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
        .resolve_or_provision(
            &req.provider,
            &req.subject,
            req.display_name.as_deref(),
            req.email.as_deref(),
            true,
        )
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

    let router = OperationBuilder::get("/studio-user/v1/me/ui-preferences")
        .operation_id("studio_user.get_my_ui_preferences")
        .summary("The caller's remembered UI choices")
        .description(
            "Returns what the caller has chosen about how Studio looks to them \
             — which screens they read as a table and which as tiles, and \
             anything else the portal decides to remember. An empty map is a \
             person who has changed nothing, which is not an error.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_my_ui_preferences)
        .json_response_with_schema::<UiPreferencesDto>(
            openapi,
            StatusCode::OK,
            "The caller's UI preferences",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    let router = OperationBuilder::put("/studio-user/v1/me/ui-preferences")
        .operation_id("studio_user.update_my_ui_preferences")
        .summary("Replace the caller's remembered UI choices")
        .description(
            "Replaces the whole set. The portal holds it all anyway, and a \
             merge would give no way to forget a preference: an absent key \
             would read as \"unchanged\" rather than \"drop it\". Bounded — at \
             most 64 entries, keys of a-z 0-9 . _ - up to 64 characters, \
             values up to 128 — because a bag the client can key freely is a \
             schema-less table that grows until somebody stores a document in \
             it.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<UpdateUiPreferencesRequest>(openapi, "The complete set of preferences")
        .handler(update_my_ui_preferences)
        .json_response_with_schema::<UiPreferencesDto>(
            openapi,
            StatusCode::OK,
            "The preferences as now stored",
        )
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
             somebody leaves of their own accord. Answers 204 with no body.",
        )
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
             connections in it are removed with the membership. Answers 204 with no body.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("org_id", "Organization (tenant) id")
        .handler(leave_my_organization)
        .no_content_response(StatusCode::NO_CONTENT, "Left")
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

    let router = OperationBuilder::get("/studio-user/v1/organizations/{org_id}/members")
        .operation_id("studio_user.list_organization_members")
        .summary("List an organization's members")
        .description(
            "Everybody with a membership in this organization — active or suspended — with \
             their role, how the membership arose, and the person's name and e-mail when their \
             profile can be read. The room a members screen shows before anyone is added, \
             removed, promoted or suspended. Gated on `people.view` (an owner, or a platform \
             administrator).",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("org_id", "Organization tenant id")
        .handler(list_organization_members)
        .json_response_with_schema::<OrganizationMemberListDto>(
            openapi,
            StatusCode::OK,
            "The organization's members",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get(
        "/studio-user/v1/organizations/{org_id}/members/{user_id}/identities",
    )
    .operation_id("studio_user.get_member_identities")
    .summary("One member's sign-in methods and attributed identities")
    .description(
        "Every login that resolves to this person and every external identity \
                 attributed to them, with how strongly. Only for a person who holds a \
                 membership in this organization (404 otherwise), and gated like the member \
                 list on `people.view`. Read from Studio's own records; the IdP is not asked.",
    )
    .tag("StudioUser")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("org_id", "Organization tenant id")
    .path_param("user_id", "Canonical Studio person id")
    .handler(get_member_identities)
    .json_response_with_schema::<MemberIdentitiesDto>(
        openapi,
        StatusCode::OK,
        "The member's identities",
    )
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
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

    let router = OperationBuilder::get("/studio-user/v1/me/colleagues")
        .operation_id("studio_user.list_my_colleagues")
        .summary("The people the caller shares an organization with")
        .description(
            "Everybody in each organization the caller is an active member of, as any member \
             sees them: name, photo, role, how the organization describes them and when they \
             were last seen. One row per organization and person, the caller included. \
             Suspended memberships count on neither side. No addresses and no sign-ins — \
             those stay with `people.view` on the members listing (ADR-0036). The \
             organizations come from the caller's own memberships, so none can be named to \
             look into. Paged with `offset` and `limit`.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("offset", false, "Zero-based index of the first row")
        .query_param("limit", false, "Rows per page")
        .handler(list_my_colleagues)
        .json_response_with_schema::<ColleagueListDto>(
            openapi,
            StatusCode::OK,
            "The caller's colleagues",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-user/v1/me/avatar")
        .operation_id("studio_user.upsert_my_avatar")
        .summary("Store the caller's photo")
        .description(
            "Stores a PNG, JPEG, WebP or GIF of at most 1 MiB as the caller's photo and points \
             `avatar_url` at it. The bytes decide the type: a body that is not the image it \
             declares is refused. The photo is served at the returned `avatar_url`, which \
             changes with every new photo.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<UploadAvatarRequest>(openapi, "The photo, base64-encoded")
        .handler(upsert_my_avatar)
        .json_response_with_schema::<UserProfileDto>(openapi, StatusCode::OK, "The updated profile")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::delete("/studio-user/v1/me/avatar")
        .operation_id("studio_user.delete_my_avatar")
        .summary("Remove the caller's stored photo")
        .description(
            "Removes the photo stored with `PUT /me/avatar`. An `avatar_url` the person set to \
             a picture elsewhere is not Studio's and stays.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(delete_my_avatar)
        .json_response_with_schema::<UserProfileDto>(openapi, StatusCode::OK, "The updated profile")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-user/v1/avatars/{user_id}/{digest}")
        .operation_id("studio_user.get_avatar")
        .summary("A stored photo")
        .description(
            "Serves one version of a person's photo. Anonymous, because an `<img>` sends no \
             token: the digest in the path is learned only from a profile the caller may read, \
             and anything but the current version answers 404. Cached as immutable.",
        )
        .tag("StudioUser")
        .anonymous()
        .exposed()
        .path_param("user_id", "The person")
        .path_param("digest", "The version, as `avatar_url` names it")
        .handler(get_avatar)
        .text_response(StatusCode::OK, "The photo", "image/*")
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-user/v1/grants/backfill")
        .operation_id("studio_user.backfill_grants")
        .summary("Point every member grant at its person (platform admin)")
        .description(
            "A migration step (ADR-0040 §5). In every organization somebody belongs to, each \
             member grant of the access config that names a known sign-in subject is rewritten \
             to name the canonical person instead, and the duplicates that produces are dropped. \
             Grants on a person, team grants and subjects no login knows are left alone. \
             Idempotent: a second run rewrites nothing.",
        )
        .tag("StudioUser")
        .authenticated()
        .require_license_features::<License>([])
        .handler(rekey_grants)
        .json_response_with_schema::<RekeyReportDto>(openapi, StatusCode::OK, "What the rekey did")
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
             target, carries the grants that named the source in those organizations to the \
             target, and tombstones the source with a merge pointer, so reads follow it. A \
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
