//! REST for desktop sessions (ADR-0027 §4). See [`super::desktop`].
//!
//! A resource of its own rather than a `runtime` on `/sessions`: a desktop
//! session has none of what a `SessionDto` describes — no URL, no gate token,
//! no `starting`/`running`, no container to launch — and none of what
//! `create_session` does applies to it. Both answer to the same question of
//! access, though: the caller must reach the workspace.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::access::WorkspaceAccess;
use super::desktop::{self, DesktopLease, DesktopLeases, Renewal};
use super::rest::StudioSessionError;
use crate::pagination::{PageQuery, page_of};

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// The leases, and who may reach a workspace. `access` is `None` when
/// account-management is not linked: then nobody can be authorized, and the
/// routes say so rather than answer for everyone.
#[derive(Clone)]
pub struct Desktops {
    pub leases: Arc<DesktopLeases>,
    pub access: Option<Arc<dyn WorkspaceAccess>>,
}

impl Desktops {
    async fn reach(&self, ctx: &SecurityContext, workspace_id: Uuid) -> ApiResult<()> {
        let access = self.access.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "desktop sessions cannot be authorized in this deployment \
                     (account-management is not linked)",
                )
                .create()
        })?;
        if access.may_reach(ctx, workspace_id).await {
            Ok(())
        } else {
            Err(StudioSessionError::not_found("Workspace not found")
                .with_resource(workspace_id.to_string())
                .create())
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpsertDesktopSessionRequest {
    /// Workspace tenant the desktop has open.
    #[schema(value_type = String)]
    pub workspace_id: Uuid,
    /// The installation's own stable id, `[A-Za-z0-9._-]{1,128}`.
    pub device_id: String,
    /// What the person calls this machine, shown in the portal.
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DesktopSessionDto {
    /// Derived from workspace, member and device: the same on every renewal.
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub workspace_id: Uuid,
    /// Subject id of the member who has it open.
    pub member_id: String,
    pub device_id: String,
    pub device_name: Option<String>,
    pub started_at_epoch_secs: u64,
    pub last_seen_epoch_secs: u64,
    /// When it ends unless renewed first.
    pub expires_at_epoch_secs: u64,
    /// How often to renew, so the client need not hard-code it.
    pub heartbeat_secs: u64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DesktopSessionListDto {
    pub items: Vec<DesktopSessionDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct DesktopSessionsQuery {
    /// The workspace (or project) whose desktop sessions to list.
    pub project_id: String,
    #[serde(flatten)]
    pub page: PageQuery,
}

fn to_dto(lease: DesktopLease) -> DesktopSessionDto {
    DesktopSessionDto {
        id: lease.id,
        workspace_id: lease.workspace_id,
        expires_at_epoch_secs: lease.expires_at_epoch_secs(),
        member_id: lease.member,
        device_id: lease.device_id,
        device_name: lease.device_name,
        started_at_epoch_secs: lease.started_at_epoch_secs,
        last_seen_epoch_secs: lease.last_seen_epoch_secs,
        heartbeat_secs: desktop::HEARTBEAT_SECS,
    }
}

/* ── Handlers ── */

async fn upsert_desktop_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(desktops): Extension<Desktops>,
    Json(req): Json<UpsertDesktopSessionRequest>,
) -> ApiResult<impl IntoResponse> {
    let device_id = req.device_id.trim();
    if !desktop::valid_device_id(device_id) {
        return Err(StudioSessionError::invalid_argument()
            .with_constraint("device_id must be 1-128 characters of [A-Za-z0-9._-]")
            .create());
    }
    // Asked on every heartbeat, not only the first: a member removed from the
    // workspace stops being able to hold it open at the next renewal.
    desktops.reach(&ctx, req.workspace_id).await?;
    let member = ctx.subject_id().to_string();
    let (lease, opened) = desktops.leases.renew(
        now_secs(),
        Renewal {
            workspace_id: req.workspace_id,
            tenant_id: ctx.subject_tenant_id(),
            member: &member,
            device_id,
            device_name: desktop::device_label(req.device_name.as_deref()),
        },
    );
    if opened {
        tracing::info!(workspace_id = %lease.workspace_id, session = %lease.id, "studio-session: a desktop opened the workspace");
    }
    let status = if opened {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(to_dto(lease))))
}

async fn list_desktop_sessions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(desktops): Extension<Desktops>,
    Query(query): Query<DesktopSessionsQuery>,
) -> ApiResult<JsonBody<DesktopSessionListDto>> {
    let workspace_id = Uuid::parse_str(query.project_id.trim()).map_err(|_| {
        StudioSessionError::invalid_argument()
            .with_constraint("project_id is not a UUID")
            .create()
    })?;
    desktops.reach(&ctx, workspace_id).await?;
    let open = desktops.leases.in_workspace(now_secs(), workspace_id);
    let (items, total) = page_of(open, query.page);
    Ok(Json(DesktopSessionListDto {
        items: items.into_iter().map(to_dto).collect(),
        total,
    }))
}

async fn delete_desktop_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(desktops): Extension<Desktops>,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    if !desktops
        .leases
        .end(now_secs(), id, &ctx.subject_id().to_string())
    {
        return Err(StudioSessionError::not_found("Desktop session not found")
            .with_resource(id.to_string())
            .create());
    }
    Ok(StatusCode::NO_CONTENT)
}

/* ── Routes ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    desktops: Desktops,
) -> Router {
    router = OperationBuilder::post("/studio-session/v1/desktop-sessions")
        .operation_id("studio_session.upsert_desktop_session")
        .summary("Open or renew a desktop session for a workspace")
        .description(
            "A desktop Studio calls this when it opens a workspace and again \
             every `heartbeat_secs`; a session not renewed within \
             `expires_at_epoch_secs` has ended. Idempotent per workspace, member \
             and device: 201 when the session was not open, 200 when renewed. \
             Nothing is limited — a workspace may be open on any number of \
             desktops and in a container session at the same time.",
        )
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<UpsertDesktopSessionRequest>(openapi, "Workspace and device")
        .handler(upsert_desktop_session)
        .json_response_with_schema::<DesktopSessionDto>(openapi, StatusCode::OK, "Renewed")
        .json_response_with_schema::<DesktopSessionDto>(openapi, StatusCode::CREATED, "Opened")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-session/v1/desktop-sessions")
        .operation_id("studio_session.list_desktop_sessions")
        .summary("List the desktops a workspace is open on")
        .description(
            "Every live desktop session of the workspace, whoever holds it, \
             oldest first.",
        )
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "Workspace or project id")
        .handler(list_desktop_sessions)
        .json_response_with_schema::<DesktopSessionListDto>(
            openapi,
            StatusCode::OK,
            "Desktop sessions",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-session/v1/desktop-sessions/{id}")
        .operation_id("studio_session.delete_desktop_session")
        .summary("End one of the caller's desktop sessions")
        .description(
            "The desktop calls this when it closes the workspace. Only the \
             member holding a session can end it; anybody else's is answered \
             with 404.",
        )
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Desktop session id")
        .handler(delete_desktop_session)
        .no_content_response(StatusCode::NO_CONTENT, "Desktop session ended")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(desktops))
}
