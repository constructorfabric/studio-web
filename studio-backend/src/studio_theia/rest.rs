//! REST surface of the studio-theia gear.
//!
//! Two families:
//!   * the **portal API** (`/studio-theia/v1/workspaces/{workspace_id}/…`) —
//!     authenticated studio-backend endpoints that drive the IDE through
//!     [`TheiaControlClientV1`], tenant-scoped by the caller's `SecurityContext`;
//!   * the **event ingress** (`/studio-theia/v1/events`) — the Theia→studio
//!     endpoint the container POSTs forwarded `StudioRuntimeClient` events to;
//!   * the **desktop session** routes
//!     (`/studio-theia/v1/desktop-sessions/{id}/…`, ADR-0027 phases 4 and 5) —
//!     a desktop posts the same events under the member's own token, and the
//!     portal sends it commands, which go out over `studio-events`.
//!
//! `client`/`service = None` (gear disabled) makes both answer 503 with a clear
//! reason instead of a 404.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::studio_session::sdk::SessionIdentity;
use crate::studio_theia::commands;
use crate::studio_theia::sdk::{
    EnqueueOperation, EnqueueOperationResult, OpenInEditor, OpenInEditorResult, OperationDeltas,
    OperationSnapshot, RepositoryDescriptor, RuntimeStatus, SessionInfo, SessionTarget,
    TheiaControlClientV1,
};
use crate::studio_theia::service::TheiaService;
use crate::studio_theia::sink::TheiaForwardedEvent;

/// Errors about a desktop session the bridge reaches (ADR-0027 phases 4 and 5).
#[resource_error(gts_id!("cf.studio.theia.desktop_session.v1~"))]
pub struct DesktopSessionError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Portal control client for the REST layer. `None` = the bridge is disabled
/// (`studio-theia.enabled = false`): endpoints stay mounted and answer 503.
#[derive(Clone)]
pub struct Portal(pub Option<Arc<dyn TheiaControlClientV1>>);

impl Portal {
    fn client(&self) -> ApiResult<Arc<dyn TheiaControlClientV1>> {
        self.0.clone().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail("the Theia bridge is disabled (studio-theia.enabled = false)")
                .create()
        })
    }
}

/// `?after_sequence=N` cursor for the operation-delta backfill.
#[derive(Debug, serde::Deserialize)]
struct DeltaQuery {
    #[serde(default)]
    after_sequence: i64,
}

/* ── Portal handlers (studio → Theia) ── */

async fn get_status(
    Extension(ctx): Extension<SecurityContext>,
    Extension(portal): Extension<Portal>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<Json<RuntimeStatus>> {
    let client = portal.client()?;
    let out = client
        .get_runtime_status(&ctx, &SessionTarget { workspace_id })
        .await?;
    Ok(Json(out))
}

async fn get_session_info(
    Extension(ctx): Extension<SecurityContext>,
    Extension(portal): Extension<Portal>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<Json<SessionInfo>> {
    let client = portal.client()?;
    let out = client
        .get_session_info(&ctx, &SessionTarget { workspace_id })
        .await?;
    Ok(Json(out))
}

async fn get_repositories(
    Extension(ctx): Extension<SecurityContext>,
    Extension(portal): Extension<Portal>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<Json<Vec<RepositoryDescriptor>>> {
    let client = portal.client()?;
    let out = client
        .get_repositories(&ctx, &SessionTarget { workspace_id })
        .await?;
    Ok(Json(out))
}

async fn enqueue_operation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(portal): Extension<Portal>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<EnqueueOperation>,
) -> ApiResult<Json<EnqueueOperationResult>> {
    let client = portal.client()?;
    let out = client
        .enqueue_operation(&ctx, &SessionTarget { workspace_id }, &body)
        .await?;
    Ok(Json(out))
}

async fn get_operation_deltas(
    Extension(ctx): Extension<SecurityContext>,
    Extension(portal): Extension<Portal>,
    Path(workspace_id): Path<Uuid>,
    Query(query): Query<DeltaQuery>,
) -> ApiResult<Json<OperationDeltas>> {
    let client = portal.client()?;
    let out = client
        .get_operation_deltas(&ctx, &SessionTarget { workspace_id }, query.after_sequence)
        .await?;
    Ok(Json(out))
}

async fn retry_operation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(portal): Extension<Portal>,
    Path((workspace_id, operation_id)): Path<(Uuid, String)>,
) -> ApiResult<Json<OperationSnapshot>> {
    let client = portal.client()?;
    let out = client
        .retry_operation(&ctx, &SessionTarget { workspace_id }, &operation_id)
        .await?;
    Ok(Json(out))
}

async fn open_in_editor(
    Extension(ctx): Extension<SecurityContext>,
    Extension(portal): Extension<Portal>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<OpenInEditor>,
) -> ApiResult<Json<OpenInEditorResult>> {
    let client = portal.client()?;
    let out = client
        .open_in_editor(&ctx, &SessionTarget { workspace_id }, &body)
        .await?;
    Ok(Json(out))
}

/* ── Event ingress (Theia → studio) ── */

/// Receive one forwarded `StudioRuntimeClient` event from a Theia container.
///
/// Phase 3 (ADR-0022): the S2S token is reverse-resolved to the session's
/// trusted `(tenant, workspace)` and the event is handed to the sink — by
/// default `StudioEventsSink`, which republishes it onto `studio-events` as
/// `theia.<kind>`; the `event-broker` gear under `theia-event-broker`.
async fn ingest_events(
    Extension(service): Extension<Option<Arc<TheiaService>>>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> StatusCode {
    let Some(service) = service else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let presented = headers
        .get("X-CFS-Theia-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if presented.is_empty() {
        return StatusCode::UNAUTHORIZED;
    }
    // The token IS the credential: reverse-resolve it to the session's trusted
    // (tenant, workspace). This — not the request body — is the source of truth
    // for who the event belongs to, so a forged `session.workspaceId` cannot
    // cross-tenant a forwarded event.
    let identity = match service.token_resolver().resolve_token(presented).await {
        Ok(Some(identity)) => identity,
        Ok(None) => return StatusCode::UNAUTHORIZED,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE,
    };
    // The sink decides where this goes: `studio-events` by default (the
    // portal's stream), the event-broker under its feature. The trusted
    // identity below is its input either way.
    service
        .sink()
        .accept(forwarded(&identity, "container", &payload))
        .await;
    StatusCode::ACCEPTED
}

/// One forwarded event from the forwarder's envelope `{ kind, sequence?,
/// event }`, under the identity the credential resolved to. The envelope's own
/// `session` is advisory and never read: who the event belongs to is the
/// credential's answer, not the body's.
fn forwarded(
    identity: &SessionIdentity,
    runtime: &'static str,
    payload: &serde_json::Value,
) -> TheiaForwardedEvent {
    TheiaForwardedEvent {
        tenant_id: identity.tenant_id,
        workspace_id: identity.workspace_id,
        session_id: identity.session_id,
        runtime,
        kind: payload
            .get("kind")
            .and_then(|k| k.as_str())
            .unwrap_or("unknown")
            .to_string(),
        sequence: payload.get("sequence").and_then(|s| s.as_i64()),
        payload: payload
            .get("event")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    }
}

/* ── Desktop sessions (ADR-0027 phases 4 and 5) ── */

fn bridge_disabled() -> CanonicalError {
    CanonicalError::service_unavailable()
        .with_detail("the Theia bridge is disabled (studio-theia.enabled = false)")
        .create()
}

/// The caller's own live desktop session, or 404 — somebody else's lease is
/// answered like a missing one, as `studio-session` answers it.
async fn own_desktop(
    service: &TheiaService,
    ctx: &SecurityContext,
    desktop_session_id: Uuid,
) -> ApiResult<SessionIdentity> {
    service
        .desktops()
        .resolve_own_desktop(ctx, desktop_session_id)
        .await?
        .ok_or_else(|| {
            DesktopSessionError::not_found("Desktop session not found")
                .with_resource(desktop_session_id.to_string())
                .create()
        })
}

/// A desktop's events (phase 4): the forwarder's envelope, as a container
/// posts it, under the member's token and the lease they hold.
async fn ingest_desktop_events(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<TheiaService>>>,
    Path(desktop_session_id): Path<Uuid>,
    Json(payload): Json<serde_json::Value>,
) -> ApiResult<StatusCode> {
    let service = service.ok_or_else(bridge_disabled)?;
    let identity = own_desktop(&service, &ctx, desktop_session_id).await?;
    service
        .sink()
        .accept(forwarded(&identity, "desktop", &payload))
        .await;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DesktopCommandRequest {
    /// `open_in_editor`, `enqueue_operation` or `retry_operation`: one of a
    /// container's control calls.
    pub command: String,
    /// The control call's own parameters, e.g. `{ "relativePath": "docs/a.md" }`.
    #[serde(default)]
    #[schema(value_type = Object)]
    pub params: serde_json::Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DesktopCommandDto {
    /// Names the command in the desktop's events about it.
    #[schema(value_type = String)]
    pub command_id: Uuid,
    #[schema(value_type = String)]
    pub desktop_session_id: Uuid,
    pub command: String,
}

/// A command for a desktop (phase 5): sent, not called. The desktop picks it
/// off `studio-events` and answers with its ordinary events.
async fn send_desktop_command(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<TheiaService>>>,
    Path(desktop_session_id): Path<Uuid>,
    Json(req): Json<DesktopCommandRequest>,
) -> ApiResult<(StatusCode, JsonBody<DesktopCommandDto>)> {
    let service = service.ok_or_else(bridge_disabled)?;
    let command = req.command.trim().to_owned();
    let params = commands::checked_params(&command, req.params).map_err(|refusal| {
        DesktopSessionError::invalid_argument()
            .with_constraint(refusal.to_string())
            .create()
    })?;
    let desktop = own_desktop(&service, &ctx, desktop_session_id).await?;
    let command_id = Uuid::new_v4();
    if !service.commands().send(commands::command_event(
        &desktop, command_id, &command, params,
    )) {
        return Err(CanonicalError::service_unavailable()
            .with_detail(
                "a desktop is reached over studio-events, which this deployment does not have",
            )
            .create());
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(DesktopCommandDto {
            command_id,
            desktop_session_id,
            command,
        }),
    ))
}

/* ── Routes ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    event_ingress_path: &str,
    service: Option<Arc<TheiaService>>,
    client: Option<Arc<dyn TheiaControlClientV1>>,
) -> Router {
    router = OperationBuilder::get("/studio-theia/v1/workspaces/{workspace_id}/status")
        .operation_id("studio_theia.get_runtime_status")
        .summary("IDE runtime status for a workspace's live session")
        .description(
            "Asks the workspace's live IDE session what state its runtime is in, \
             over the backend-to-backend bridge. 404 when the workspace has no \
             live session.",
        )
        .tag("StudioTheia")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace id")
        .handler(get_status)
        .json_response(StatusCode::OK, "Runtime status")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-theia/v1/workspaces/{workspace_id}/session")
        .operation_id("studio_theia.get_session_info")
        .summary("Session identity + feature flags for a workspace's IDE")
        .description(
            "Returns which session serves this workspace and which IDE features \
             it has, so the portal renders the controls the session actually \
             supports.",
        )
        .tag("StudioTheia")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace id")
        .handler(get_session_info)
        .json_response(StatusCode::OK, "Session info")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-theia/v1/workspaces/{workspace_id}/repositories")
        .operation_id("studio_theia.get_repositories")
        .summary("Repositories the IDE has mounted for a workspace")
        .description(
            "Returns the repositories the IDE has mounted in this workspace, as \
             the session itself reports them.",
        )
        .tag("StudioTheia")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace id")
        .handler(get_repositories)
        .json_response(StatusCode::OK, "Repositories")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-theia/v1/workspaces/{workspace_id}/operations")
        .operation_id("studio_theia.enqueue_operation")
        .summary("Queue a save/commit/push through the IDE operation journal")
        .description(
            "Queues a save, commit or push into the IDE's operation journal and \
             returns the operation's first snapshot. The IDE performs it; this \
             answers as soon as it is journalled.",
        )
        .tag("StudioTheia")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace id")
        .handler(enqueue_operation)
        .json_response(StatusCode::OK, "Operation snapshot")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-theia/v1/workspaces/{workspace_id}/operations")
        .operation_id("studio_theia.get_operation_deltas")
        .summary("Cursor backfill of operation events after a sequence")
        .description(
            "Returns the operation events after a sequence number, so a client \
             that was disconnected catches up instead of re-reading the whole \
             journal.",
        )
        .tag("StudioTheia")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace id")
        .query_param("after_sequence", false, "Return events after this sequence")
        .handler(get_operation_deltas)
        .json_response(StatusCode::OK, "Operation deltas")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-theia/v1/workspaces/{workspace_id}/operations/{operation_id}/retry",
    )
    .operation_id("studio_theia.retry_operation")
    .summary("Retry a failed operation by id")
    .description(
        "Runs a failed operation from the IDE's journal again, keeping its id, so \
         the history shows one operation that was retried rather than two that \
         were attempted.",
    )
    .tag("StudioTheia")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace id")
    .path_param("operation_id", "Operation id")
    .handler(retry_operation)
    .json_response(StatusCode::OK, "Operation snapshot")
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post("/studio-theia/v1/workspaces/{workspace_id}/open")
        .operation_id("studio_theia.open_in_editor")
        .summary("Reveal/open a file in the running IDE")
        .description(
            "Reveals and opens a file in the running IDE, so a link from the \
             portal lands on the right file rather than in the workspace root.",
        )
        .tag("StudioTheia")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace id")
        .handler(open_in_editor)
        .json_response(StatusCode::OK, "Open result")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // Event ingress: S2S-token-gated, and it MUST be `.anonymous().exposed()`
    // rather than a raw route. The Theia container POSTs with no platform
    // token, so the api-gateway's require_auth_by_default would 401 a raw
    // route before it ever reached `ingest_events` — exactly the reason the
    // IDE reverse-proxy routes are exposed (see studio_session::rest). The
    // S2S-token check inside the handler is the real auth, analogous to the
    // proxy's own 256-bit gate. `.anonymous()` keeps the platform auth layer
    // off; `.exposed()` lands the path in the gateway's public-route set.
    router = OperationBuilder::post(event_ingress_path)
        .operation_id("studio_theia.ingest_events")
        .summary("Theia->studio S2S event ingress")
        .description(
            "The Theia node's way back in: a session posts its events here, \
             authenticated by the per-session S2S token rather than by a user's \
             token, since no user is present when a background operation \
             finishes.",
        )
        .tag("StudioTheia")
        .anonymous()
        .exposed()
        .handler(ingest_events)
        .no_content_response(StatusCode::ACCEPTED, "Event accepted")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::post("/studio-theia/v1/desktop-sessions/{desktop_session_id}/events")
            .operation_id("studio_theia.push_desktop_events")
            .summary("A desktop session's events")
            .description(
                "The desktop Studio posts its forwarded events here, in the envelope a \
         container posts to the S2S ingress, under the member's own token. The \
         desktop session must be live and the caller's own (ADR-0027 phase 4); \
         somebody else's answers 404.",
            )
            .tag("StudioTheia")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("desktop_session_id", "Desktop session id")
            .handler(ingest_desktop_events)
            .no_content_response(StatusCode::ACCEPTED, "Event accepted")
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router =
        OperationBuilder::post("/studio-theia/v1/desktop-sessions/{desktop_session_id}/commands")
            .operation_id("studio_theia.send_desktop_command")
            .summary("Send a command to a desktop session")
            .description(
                "Nothing dials a member's laptop, so a command for a desktop is sent, \
         not called: it goes out on studio-events as \
         `desktop_session.command_sent` about the \
         `desktop_session`, and the desktop runs it through its operation \
         queue and answers with its ordinary events (ADR-0027 phase 5). Only \
         the member holding the session may send it one.",
            )
            .tag("StudioTheia")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("desktop_session_id", "Desktop session id")
            .json_request::<DesktopCommandRequest>(openapi, "The command and its parameters")
            .handler(send_desktop_command)
            .json_response_with_schema::<DesktopCommandDto>(openapi, StatusCode::ACCEPTED, "Sent")
            .error_400(openapi)
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    // Both extension layers apply to the whole router.
    router
        .layer(Extension(service))
        .layer(Extension(Portal(client)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_forwarded_event_belongs_to_the_credential_not_to_the_envelope() {
        let identity = SessionIdentity {
            session_id: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
        };
        let envelope = json!({
            "session": { "workspaceId": Uuid::new_v4() },
            "kind": "operation",
            "sequence": 7,
            "event": { "operationId": "op-1" },
        });
        let event = forwarded(&identity, "desktop", &envelope);
        assert_eq!(event.workspace_id, identity.workspace_id);
        assert_eq!(event.tenant_id, identity.tenant_id);
        assert_eq!(event.session_id, identity.session_id);
        assert_eq!(event.runtime, "desktop");
        assert_eq!(event.kind, "operation");
        assert_eq!(event.sequence, Some(7));
        assert_eq!(event.payload, json!({ "operationId": "op-1" }));

        let bare = forwarded(&identity, "container", &json!({}));
        assert_eq!(bare.kind, "unknown");
        assert_eq!(bare.sequence, None);
        assert_eq!(bare.payload, serde_json::Value::Null);
    }
}
