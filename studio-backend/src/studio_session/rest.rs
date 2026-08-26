use std::sync::Arc;

use axum::extract::Path;
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{RepoKind, RepoSpec, Session, SessionService};

/// Errors attributable to an IDE session as a resource.
#[resource_error(gts_id!("cf.studio.session.session.v1~"))]
pub struct StudioSessionError;

/// Session driver handle for the REST layer. `None` = sessions disabled
/// (config flag, or no Docker daemon on the host): the endpoints stay
/// mounted and answer 503 so clients get a clear reason instead of 404s.
#[derive(Clone)]
pub struct Sessions(pub Option<Arc<SessionService>>);

impl Sessions {
    fn get(&self) -> ApiResult<&Arc<SessionService>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "IDE sessions are not available in this deployment \
                     (session driver disabled — see studio-session.enabled)",
                )
                .create()
        })
    }
}

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/* ── DTOs ── */

/// One workspace source, mirrored into the canonical `.cf-workspace.toml`.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RepoSpecDto {
    /// Directory name under the workspace root — `[a-z0-9_-]+`.
    pub name: String,
    /// "git" (cloned on first launch) or "local" (backend-host folder
    /// bind-mounted as ./name).
    pub kind: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// Mount/clone target relative to the workspace root (defaults to name).
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// credstore secret reference with a PAT for private repos. Resolved
    /// server-side; the token value never travels through this API.
    #[serde(default)]
    pub token_ref: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateSessionRequest {
    /// Workspace tenant id the IDE session is for.
    #[schema(value_type = String)]
    pub workspace_id: Uuid,
    /// Existing Studio workspace folder on the backend host (e.g. created by
    /// the Studio CLI) mounted as the workspace root instead of the managed
    /// directory. Its own .cf-workspace.toml is left untouched.
    #[serde(default)]
    pub root_path: Option<String>,
    /// Clone URL of the workspace repository itself (a CLI-created Studio
    /// workspace is a git repo). Cloned into the managed directory on first
    /// launch; ignored when `root_path` is set.
    #[serde(default)]
    pub root_repo_url: Option<String>,
    #[serde(default)]
    pub root_branch: Option<String>,
    /// credstore secret reference with a PAT for the workspace repository.
    #[serde(default)]
    pub root_token_ref: Option<String>,
    /// Workspace sources (multiple repositories/folders per workspace).
    #[serde(default)]
    pub repos: Vec<RepoSpecDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SessionDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub workspace_id: Uuid,
    /// starting | running | stopped
    pub state: String,
    /// Browser URL of the Theia IDE (loopback-published).
    pub url: String,
    pub created_at_epoch_secs: u64,
    /// Source summaries, e.g. "docs (git)", "demo (local)".
    pub sources: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SessionListDto {
    pub items: Vec<SessionDto>,
}

fn to_dto(svc: &SessionService, s: Session) -> SessionDto {
    // The gate token travels once, in the URL the portal embeds: the
    // in-container proxy swaps it for an HttpOnly cookie and redirects to
    // the clean path. Only callers who may read the session get it here.
    let url = if s.session_token.is_empty() {
        svc.session_url(&s)
    } else {
        format!("{}?token={}", svc.session_url(&s), s.session_token)
    };
    SessionDto {
        id: s.id,
        workspace_id: s.workspace_id,
        state: s.state.as_str().to_string(),
        url,
        created_at_epoch_secs: s.created_at_epoch_secs,
        sources: s.sources,
    }
}

/* ── Handlers ── */

async fn create_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(sessions): Extension<Sessions>,
    Json(req): Json<CreateSessionRequest>,
) -> ApiResult<impl IntoResponse> {
    let svc = sessions.get()?;
    // Map DTOs to specs, resolving per-repo PATs from credstore under the
    // caller's tenant.
    let mut repos = Vec::with_capacity(req.repos.len());
    for r in req.repos {
        let kind = match r.kind.as_str() {
            "git" => RepoKind::Git,
            "local" => RepoKind::Local,
            other => {
                return Err(CanonicalError::internal(format!(
                    "source '{}': unknown kind '{other}' (expected git|local)",
                    r.name
                ))
                .create());
            }
        };
        // A missing/inaccessible secret must not block the launch: public
        // repositories clone fine without it, and a private one fails later
        // with git's own message in the session log.
        let token = match r.token_ref.as_deref().filter(|t| !t.trim().is_empty()) {
            Some(token_ref) => match svc.resolve_git_token(&ctx, token_ref.trim()).await {
                Ok(t) => Some(t),
                Err(e) => {
                    tracing::warn!(
                        source = %r.name,
                        token_ref = %token_ref.trim(),
                        "studio-session: repo token unavailable ({e:#}) — cloning without credentials"
                    );
                    None
                }
            },
            None => None,
        };
        repos.push(RepoSpec {
            name: r.name,
            kind,
            url: r.url,
            path: r.path,
            target: r.target,
            branch: r.branch,
            token,
        });
    }
    // Workspace root repository (optional).
    let root_repo = match req
        .root_repo_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        Some(url) => {
            let token = match req
                .root_token_ref
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                Some(token_ref) => match svc.resolve_git_token(&ctx, token_ref).await {
                    Ok(t) => Some(t),
                    Err(e) => {
                        tracing::warn!(
                            token_ref = %token_ref,
                            "studio-session: workspace-root token unavailable ({e:#}) — cloning without credentials"
                        );
                        None
                    }
                },
                None => None,
            };
            Some(RepoSpec {
                name: "workspace-root".to_string(),
                kind: RepoKind::Git,
                url: Some(url.to_string()),
                path: None,
                target: None,
                branch: req.root_branch.clone(),
                token,
            })
        }
        None => None,
    };

    let (session, existed) = svc
        .create(&ctx, req.workspace_id, req.root_path, root_repo, repos)
        .await
        .map_err(|e| CanonicalError::internal(format!("session launch failed: {e:#}")).create())?;
    let status = if existed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(to_dto(svc, session))))
}

async fn list_sessions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(sessions): Extension<Sessions>,
) -> ApiResult<JsonBody<SessionListDto>> {
    // List degrades gracefully: no driver = no sessions (portal keeps working).
    let Some(svc) = sessions.0.as_ref() else {
        return Ok(Json(SessionListDto { items: Vec::new() }));
    };
    let items = svc
        .list(ctx.subject_tenant_id())
        .await
        .into_iter()
        .map(|s| to_dto(svc, s))
        .collect();
    Ok(Json(SessionListDto { items }))
}

async fn get_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(sessions): Extension<Sessions>,
    Path(id): Path<Uuid>,
) -> ApiResult<JsonBody<SessionDto>> {
    let svc = sessions.get()?;
    let session = svc.get(ctx.subject_tenant_id(), id).await.ok_or_else(|| {
        StudioSessionError::not_found("Session not found")
            .with_resource(id.to_string())
            .create()
    })?;
    Ok(Json(to_dto(svc, session)))
}

async fn delete_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(sessions): Extension<Sessions>,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    let svc = sessions.get()?;
    let removed = svc
        .stop(ctx.subject_tenant_id(), id)
        .await
        .map_err(|e| CanonicalError::internal(format!("session stop failed: {e:#}")).create())?;
    if !removed {
        return Err(StudioSessionError::not_found("Session not found")
            .with_resource(id.to_string())
            .create());
    }
    Ok(StatusCode::NO_CONTENT)
}

/* ── Routes ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<SessionService>>,
) -> Router {
    router = OperationBuilder::post("/studio-session/v1/sessions")
        .operation_id("studio_session.create_session")
        .summary("Launch (or reuse) a Theia IDE session for a workspace")
        .description(
            "Starts a per-workspace IDE container. Idempotent per workspace: \
             an existing non-stopped session is returned with 200.",
        )
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateSessionRequest>(openapi, "Session parameters")
        .handler(create_session)
        .json_response_with_schema::<SessionDto>(openapi, StatusCode::CREATED, "Session created")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-session/v1/sessions")
        .operation_id("studio_session.list_sessions")
        .summary("List IDE sessions of the caller's tenant")
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_sessions)
        .json_response_with_schema::<SessionListDto>(openapi, StatusCode::OK, "Sessions")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-session/v1/sessions/{id}")
        .operation_id("studio_session.get_session")
        .summary("Get one IDE session (state refreshes to running when ready)")
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Session id")
        .handler(get_session)
        .json_response_with_schema::<SessionDto>(openapi, StatusCode::OK, "Session")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-session/v1/sessions/{id}")
        .operation_id("studio_session.delete_session")
        .summary("Stop and remove an IDE session")
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Session id")
        .handler(delete_session)
        .no_content_response(StatusCode::NO_CONTENT, "Session stopped and removed")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // Browser → session reverse proxy (Kubernetes driver). These are `.anonymous().exposed()`
    // on purpose: the browser opens the IDE in an iframe with no platform token,
    // so the api-gateway must NOT auth-gate them — the session container's own
    // 256-bit gate (?token -> cookie) is the auth (see proxy.rs). `.anonymous().exposed()`
    // (vs a raw route) is what lands the path in the gateway's public-route set;
    // a raw route is still caught by require_auth_by_default and 401s. The
    // handler mounts as a plain `get`/`post`, so the WebSocket upgrade passes
    // through untouched. Theia loads at the trailing-slash root and every asset/
    // WS path under it; GET carries the page + WS upgrade, POST the RPC services.
    for (method, is_root) in [(true, true), (true, false), (false, true), (false, false)] {
        let (path, tag) = if is_root {
            ("/studio-session/v1/ide/{id}/", "ide-root")
        } else {
            ("/studio-session/v1/ide/{id}/{*rest}", "ide-asset")
        };
        let base = if method {
            OperationBuilder::get(path)
        } else {
            OperationBuilder::post(path)
        };
        let op = base
            .operation_id(format!(
                "studio_session.ide_proxy.{}.{}",
                if method { "get" } else { "post" },
                tag
            ))
            .summary("Reverse proxy to a Kubernetes IDE session")
            .tag("StudioSessions")
            .anonymous()
            .exposed();
        router = if is_root {
            op.handler(super::proxy::ide_proxy_root)
                .text_response(StatusCode::OK, "IDE session stream", "text/html")
                .register(router, openapi)
        } else {
            op.handler(super::proxy::ide_proxy_rest)
                .text_response(StatusCode::OK, "IDE session stream", "text/html")
                .register(router, openapi)
        };
    }

    router.layer(Extension(Sessions(service)))
}
