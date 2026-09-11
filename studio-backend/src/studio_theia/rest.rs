//! REST surface of the studio-theia gear.
//!
//! Two families:
//!   * the **portal API** (`/studio-theia/v1/workspaces/{workspace_id}/…`) —
//!     authenticated studio-backend endpoints that drive the IDE through
//!     [`TheiaControlClientV1`], tenant-scoped by the caller's `SecurityContext`;
//!   * the **event ingress** (`/studio-theia/v1/events`) — the Theia→studio
//!     endpoint the container POSTs forwarded `StudioRuntimeClient` events to.
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
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::studio_theia::sdk::{
    EnqueueOperation, EnqueueOperationResult, OpenInEditor, OpenInEditorResult, OperationDeltas,
    OperationSnapshot, RepositoryDescriptor, RuntimeStatus, SessionInfo, SessionTarget,
    TheiaControlClientV1,
};
use crate::studio_theia::service::TheiaService;
use crate::studio_theia::sink::TheiaForwardedEvent;

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
/// Phase 3 (ADR-0010) resolves the session to `(tenant, workspace)` and
/// republishes onto the `event-broker` gear. Today it authenticates the S2S
/// token, traces the event kind, and acknowledges.
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
    let kind = payload
        .get("kind")
        .and_then(|k| k.as_str())
        .unwrap_or("unknown")
        .to_string();
    let sequence = payload.get("sequence").and_then(|s| s.as_i64());
    let event = payload
        .get("event")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    // The sink decides where this goes: `studio-events` by default (the
    // portal's stream), the event-broker under its feature. The trusted
    // identity below is its input either way.
    service
        .sink()
        .accept(TheiaForwardedEvent {
            tenant_id: identity.tenant_id,
            workspace_id: identity.workspace_id,
            session_id: identity.session_id,
            kind,
            sequence,
            payload: event,
        })
        .await;
    StatusCode::ACCEPTED
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

    // Both extension layers apply to the whole router.
    router
        .layer(Extension(service))
        .layer(Extension(Portal(client)))
}
