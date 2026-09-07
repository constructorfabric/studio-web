//! REST surface for studio-identity, under `/studio-identity/v1`.
//!
//! Everything is addressed by the organization tenant (ADR-0012 §6). The
//! self-service calls live under `.../me/`, so the subject is the caller's own
//! `SecurityContext` and never a request field — there is no route that lets one
//! person record an assertion on behalf of another.
//!
//! `claim` and `revoke` are POSTs carrying the account in the body rather than
//! in the path: a provider login is user-supplied text, and encoding it into a
//! path segment buys nothing.

use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::resolve::Binding;
use super::service::{IdentityService, IdentityView, VerifyReport};

#[resource_error(gts_id!("cf.studio._.identity.v1~"))]
pub struct IdentityError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

// ── DTOs ─────────────────────────────────────────────────────────────────────

/// One external account as it concerns one person.
///
/// **Not** `IdentityDto`: `studio-connector` already registers a schema by that
/// name (the account a credential resolved to), and the OpenAPI registry is
/// shared across the whole assembly — a second definition under the same name
/// panics the boot, not the request. Nothing in `cargo build`, `clippy` or the
/// tests catches it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ExternalAccountDto {
    pub provider: String,
    pub account: String,
    /// The caller's own newest assertion: `suggested` | `claimed` | `verified`
    /// | `revoked`.
    pub my_kind: String,
    /// Activity on this account is attributed to the caller.
    pub mine: bool,
    /// Bound to a different subject. The caller may still verify and win.
    pub taken_by_other: bool,
    /// Decided to be a bot or shared credential rather than a person.
    pub excluded: bool,
    /// More than one subject holds a live verification.
    pub contested: bool,
    /// How the caller's own standing was obtained (`connector-pat`,
    /// `self-assert`, …). Informational: only `my_kind` decides anything.
    pub method: String,
    /// RFC 3339.
    pub observed_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ExternalAccountListDto {
    pub identities: Vec<ExternalAccountDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AccountRefDto {
    /// Driver key: `github`, `gitlab`, `bitbucket`.
    pub provider: String,
    /// Provider-native login or username.
    pub account: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct VerifyReportDto {
    /// `provider/account` pairs the caller now holds a verification for.
    pub verified: Vec<AccountPairDto>,
    /// Team or bot credentials: proving control of a shared account says
    /// nothing about who the caller is.
    pub skipped_shared: i64,
    /// Personal connections belonging to somebody else.
    pub skipped_other_owner: i64,
    /// Personal connections created before the record named its creator.
    pub skipped_unknown_owner: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AccountPairDto {
    pub provider: String,
    pub account: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProposalDto {
    pub subject: String,
    /// `suggested` or `claimed`.
    pub kind: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AccountResolutionDto {
    pub provider: String,
    pub account: String,
    /// `unbound` | `excluded` | `subject`.
    pub binding: String,
    /// The bound subject, present only when `binding` is `subject`.
    pub subject: Option<String>,
    /// Live assertions that bind nothing, strongest first.
    pub proposals: Vec<ProposalDto>,
    pub contested: bool,
}

// ── mapping ──────────────────────────────────────────────────────────────────

fn identity_dto(view: IdentityView) -> ExternalAccountDto {
    ExternalAccountDto {
        provider: view.provider,
        account: view.account,
        my_kind: view.my_kind.as_str().to_owned(),
        mine: view.mine,
        taken_by_other: view.taken_by_other,
        excluded: view.excluded,
        contested: view.contested,
        method: view.method,
        observed_at: rfc3339(view.observed_at),
    }
}

fn report_dto(report: VerifyReport) -> VerifyReportDto {
    VerifyReportDto {
        verified: report
            .verified
            .into_iter()
            .map(|key| AccountPairDto {
                provider: key.provider,
                account: key.account,
            })
            .collect(),
        skipped_shared: report.skipped_shared as i64,
        skipped_other_owner: report.skipped_other_owner as i64,
        skipped_unknown_owner: report.skipped_unknown_owner as i64,
    }
}

/// An `observed_at` that cannot be formatted is a bug, not a client error, so
/// it degrades to an empty string rather than failing the whole listing.
fn rfc3339(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

// ── errors ───────────────────────────────────────────────────────────────────

fn invalid(error: anyhow::Error) -> CanonicalError {
    IdentityError::invalid_argument()
        .with_constraint(error.to_string())
        .create()
}

/// A tenant the caller cannot resolve reads as not-found rather than leaking
/// its existence (the endpoint refuses to be an existence oracle).
fn no_tenant(_error: anyhow::Error) -> CanonicalError {
    IdentityError::not_found("organization not found or not accessible")
        .with_resource("tenant")
        .create()
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn list_my_identities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Path(tenant_id): Path<Uuid>,
) -> ApiResult<JsonBody<ExternalAccountListDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    let views = service
        .my_identities(&ctx, tenant_id)
        .await
        .map_err(invalid)?;
    Ok(Json(ExternalAccountListDto {
        identities: views.into_iter().map(identity_dto).collect(),
    }))
}

async fn claim_identity(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Path(tenant_id): Path<Uuid>,
    Json(body): Json<AccountRefDto>,
) -> ApiResult<JsonBody<ExternalAccountListDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    service
        .claim(&ctx, tenant_id, &body.provider, &body.account)
        .await
        .map_err(invalid)?;
    let views = service
        .my_identities(&ctx, tenant_id)
        .await
        .map_err(invalid)?;
    Ok(Json(ExternalAccountListDto {
        identities: views.into_iter().map(identity_dto).collect(),
    }))
}

async fn revoke_identity(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Path(tenant_id): Path<Uuid>,
    Json(body): Json<AccountRefDto>,
) -> ApiResult<JsonBody<ExternalAccountListDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    service
        .revoke(&ctx, tenant_id, &body.provider, &body.account)
        .await
        .map_err(invalid)?;
    let views = service
        .my_identities(&ctx, tenant_id)
        .await
        .map_err(invalid)?;
    Ok(Json(ExternalAccountListDto {
        identities: views.into_iter().map(identity_dto).collect(),
    }))
}

async fn verify_from_connections(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Path(tenant_id): Path<Uuid>,
) -> ApiResult<JsonBody<VerifyReportDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    let report = service
        .verify_from_connections(&ctx, tenant_id)
        .await
        .map_err(invalid)?;
    Ok(Json(report_dto(report)))
}

async fn resolve_account(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<IdentityService>>,
    Path((tenant_id, provider, account)): Path<(Uuid, String, String)>,
) -> ApiResult<JsonBody<AccountResolutionDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    let resolution = service
        .resolve_account(tenant_id, &provider, &account)
        .await
        .map_err(invalid)?;
    let (binding, subject) = match &resolution.binding {
        Binding::Unbound => ("unbound", None),
        Binding::Excluded => ("excluded", None),
        Binding::Subject(subject) => ("subject", Some(subject.clone())),
    };
    Ok(Json(AccountResolutionDto {
        provider,
        account,
        binding: binding.to_owned(),
        subject,
        proposals: resolution
            .proposals
            .into_iter()
            .map(|proposal| ProposalDto {
                subject: proposal.subject,
                kind: proposal.kind.as_str().to_owned(),
            })
            .collect(),
        contested: resolution.contested,
    }))
}

// ── registration ─────────────────────────────────────────────────────────────

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<IdentityService>,
) -> Router {
    router = OperationBuilder::get("/studio-identity/v1/tenants/{tenant_id}/me/identities")
        .operation_id("studio_identity.list_my_identities")
        .summary("List the external accounts that concern the caller")
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("tenant_id", "Organization tenant id")
        .handler(list_my_identities)
        .json_response_with_schema::<ExternalAccountListDto>(
            openapi,
            StatusCode::OK,
            "Accounts and their state",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-identity/v1/tenants/{tenant_id}/me/identities/claim")
        .operation_id("studio_identity.claim_identity")
        .summary("Assert that an external account is the caller's (binds nothing)")
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("tenant_id", "Organization tenant id")
        .json_request::<AccountRefDto>(openapi, "Account to claim")
        .handler(claim_identity)
        .json_response_with_schema::<ExternalAccountListDto>(
            openapi,
            StatusCode::OK,
            "Accounts and their state after the claim",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-identity/v1/tenants/{tenant_id}/me/identities/revoke")
        .operation_id("studio_identity.revoke_identity")
        .summary("Withdraw the caller's assertion about an external account")
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("tenant_id", "Organization tenant id")
        .json_request::<AccountRefDto>(openapi, "Account to withdraw")
        .handler(revoke_identity)
        .json_response_with_schema::<ExternalAccountListDto>(
            openapi,
            StatusCode::OK,
            "Accounts and their state after the withdrawal",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-identity/v1/tenants/{tenant_id}/me/identities/verify")
        .operation_id("studio_identity.verify_from_connections")
        .summary("Record verifications from the caller's own personal connections")
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("tenant_id", "Organization tenant id")
        .handler(verify_from_connections)
        .json_response_with_schema::<VerifyReportDto>(
            openapi,
            StatusCode::OK,
            "What the fold recorded and what it skipped",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get(
        "/studio-identity/v1/tenants/{tenant_id}/accounts/{provider}/{account}",
    )
    .operation_id("studio_identity.resolve_account")
    .summary("Resolve one external account to a platform subject")
    .tag("StudioIdentity")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("tenant_id", "Organization tenant id")
    .path_param("provider", "Driver key: github, gitlab, bitbucket")
    .path_param("account", "Provider-native login or username")
    .handler(resolve_account)
    .json_response_with_schema::<AccountResolutionDto>(
        openapi,
        StatusCode::OK,
        "Binding and proposals for the account",
    )
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    // Without this every handler above compiles and then fails at request time
    // on a missing extension. Applied once, after the last route.
    router.layer(Extension(service))
}
