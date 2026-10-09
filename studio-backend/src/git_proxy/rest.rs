use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use authn_resolver_sdk::AuthNResolverClient;
use axum::body::Body;
use axum::extract::{Path, Query, Request};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::Response;
use axum::{Extension, Router};
use credstore_sdk::{CredStoreClientV1, SecretRef};
use futures_util::StreamExt;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::refresh::{self, Upstream};
use super::sources::{self, Service, Source};
use crate::connectors::sdk::Connectors;
use crate::pagination::{PageQuery, page_of};

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Errors attributable to a workspace's Git source as a resource.
#[resource_error(gts_id!("cf.studio.git.source.v1~"))]
pub struct StudioGitError;

/// Request headers the Git protocol needs upstream. Everything else — the
/// caller's own `Authorization` first of all — stays here.
const FORWARD_REQUEST: [header::HeaderName; 5] = [
    header::CONTENT_TYPE,
    header::CONTENT_ENCODING,
    header::ACCEPT,
    header::USER_AGENT,
    header::HeaderName::from_static("git-protocol"),
];

/// Response headers passed back to `git`.
const FORWARD_RESPONSE: [header::HeaderName; 5] = [
    header::CONTENT_TYPE,
    header::CONTENT_ENCODING,
    header::CACHE_CONTROL,
    header::EXPIRES,
    header::PRAGMA,
];

pub struct GitProxy {
    pub client: reqwest::Client,
    pub authn: Arc<dyn AuthNResolverClient>,
    pub account_management: Arc<dyn AccountManagementClient>,
    pub credstore: Arc<dyn CredStoreClientV1>,
    /// The connection catalogue, read (never written) to find what a pushed
    /// repository syncs through.
    pub connectors: Connectors,
    /// Where the task queue is found when a push has a sync to queue — per
    /// push, so this gear does not care whether `studio-tasks` booted first.
    pub hub: Arc<ClientHub>,
}

impl GitProxy {
    /// The project's Git sources, read under the caller's identity. Reading
    /// its config IS the access decision: account-management answers only for
    /// a tenant the caller reaches.
    async fn sources(&self, ctx: &SecurityContext, workspace_id: Uuid) -> Option<Vec<Source>> {
        crate::project_sources::git_sources(self.account_management.as_ref(), ctx, workspace_id)
            .await
    }

    async fn token(&self, ctx: &SecurityContext, token_ref: &str) -> Result<String, String> {
        let key = SecretRef::new(token_ref).map_err(|e| format!("bad token reference: {e}"))?;
        let secret = self
            .credstore
            .get(ctx, &key)
            .await
            .map_err(|e| format!("credstore: {e}"))?
            .ok_or_else(|| format!("the token '{token_ref}' is not readable"))?;
        String::from_utf8(secret.value.as_bytes().to_vec())
            .map_err(|_| format!("the token '{token_ref}' is not UTF-8"))
    }
}

impl GitProxy {
    /// Ask the organization's component registry to read the pushed project
    /// again (ADR-0041): a `catalog.registry` walk of that one project, which
    /// reads only the repositories whose files moved. Best effort, like the
    /// re-sync: the push has already succeeded.
    async fn refresh_registry_after_push(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        workspace_id: Option<Uuid>,
    ) {
        let Ok(registry) = self
            .hub
            .get::<dyn crate::components_catalog::port::Registry>()
        else {
            return;
        };
        let Some(workspace_id) = workspace_id else {
            return;
        };
        let Some(org) = self
            .account_management
            .get_tenant(ctx, workspace_id)
            .await
            .ok()
            .and_then(|t| t.parent_id)
            .map(|p| p.0)
        else {
            tracing::info!(%project_id, "studio-git: the pushed project's organization is not visible; the registry is not refreshed");
            return;
        };
        match registry.queue_refresh(ctx, org, &[project_id]).await {
            Ok(run_id) => {
                tracing::info!(%project_id, %org, %run_id, "studio-git: a push refreshes the component registry");
            }
            Err(error) => {
                tracing::warn!(%project_id, %org, error = %format!("{error:#}"), "studio-git: a push could not queue a registry refresh");
            }
        }
    }

    /// Queue a sync of every project source the push went to (ADR-0027 phase
    /// 2). Best effort and after the fact: the push has already succeeded, so
    /// a sync that cannot be queued is logged, never answered.
    async fn refresh_after_push(&self, ctx: &SecurityContext, project_id: Uuid, pushed: &Source) {
        let workspace_id = self
            .account_management
            .get_tenant(ctx, project_id)
            .await
            .ok()
            .and_then(|t| t.parent_id)
            .map(|p| p.0);
        self.refresh_registry_after_push(ctx, project_id, workspace_id)
            .await;
        let mut runs = Vec::new();

        // The project's record of its repositories names each one's
        // connection by id; the pushed source is one of them.
        if let Some(sources) =
            crate::project_sources::read(self.account_management.as_ref(), ctx, project_id).await
        {
            let mut connections = std::collections::HashMap::new();
            for source in sources
                .iter()
                .filter(|s| crate::project_sources::same_repository(&s.clone_url, &pushed.url))
            {
                let Some(connection_id) = source.connection_id else {
                    continue;
                };
                let Some(connectors) = self.connectors.get() else {
                    continue;
                };
                if let Some((at, c)) = connectors
                    .nearest_by_id(ctx, project_id, connection_id)
                    .await
                {
                    // The server's checkout is synced with this token: only
                    // the organization's own (`connectors::sdk::ownership`).
                    let holder = crate::connectors::sdk::holder_of_row(&c, at);
                    if let Err(refused) = crate::connectors::sdk::check_owned(
                        self.account_management.as_ref(),
                        ctx,
                        project_id,
                        project_id,
                        Some(holder),
                    )
                    .await
                    {
                        tracing::warn!(%project_id, holder = %refused.holder, "studio-git: a pushed source's connection is not the organization's; not re-synced through it");
                        continue;
                    }
                    connections.insert(
                        c.id,
                        Upstream {
                            provider: c.provider,
                            base_url: c.base_url,
                            secret_ref: c.secret_ref,
                        },
                    );
                }
            }
            runs.extend(refresh::runs_for_push(
                project_id,
                workspace_id,
                &sources,
                &connections,
                &pushed.url,
            ));
        }

        // The same sync found both ways is one sync.
        let mut seen = std::collections::HashSet::new();
        runs.retain(|run| seen.insert(run.partition_key()));
        if runs.is_empty() {
            tracing::info!(%project_id, source = %pushed.name, "studio-git: the pushed source names no connection this member can see; nothing re-synced");
            return;
        }
        let Ok(queue) = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
        else {
            tracing::warn!(%project_id, "studio-git: no task queue, so a push cannot re-sync the server's checkout");
            return;
        };
        for run in runs {
            let partition_key = run.partition_key();
            let repo = run.repo_full_path.clone();
            let Ok(payload) = serde_json::to_value(run) else {
                continue;
            };
            let queued = queue
                .enqueue(
                    ctx,
                    crate::tasks::sdk::NewRun {
                        tenant: ctx.subject_tenant_id(),
                        task_type: crate::artifact_ingest::INGEST_TASK_TYPE,
                        payload,
                        partition_key: Some(&partition_key),
                        idempotency_key: None,
                        coalesce_queued: true,
                        // The project's IDE session, if one is open, hears that
                        // its sources moved — as after a Re-sync in the portal.
                        notify_workspace_id: Some(project_id),
                    },
                )
                .await;
            match queued {
                Ok(run_id) => {
                    tracing::info!(%project_id, repo, %run_id, "studio-git: a push re-syncs the server's checkout");
                }
                Err(error) => {
                    tracing::warn!(%project_id, repo, error = %format!("{error:#}"), "studio-git: a push could not queue its re-sync");
                }
            }
        }
    }
}

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GitSourceDto {
    /// Source name, `[a-z0-9_-]+`; the workspace's own repository is `_root`.
    pub name: String,
    /// Gateway-rooted path to clone from, e.g.
    /// `/studio-git/v1/workspaces/{id}/sources/api`. Prefix it with the
    /// gateway's base URL. It names no source host and carries no credential.
    pub clone_path: String,
    pub branch: Option<String>,
    /// Checkout directory relative to the workspace root, when not `name`.
    pub target: Option<String>,
    /// Whether the proxy attaches a stored token upstream for this source.
    pub authenticated: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GitSourceListDto {
    pub items: Vec<GitSourceDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct SourcesQuery {
    /// The workspace or project whose sources to list.
    pub project_id: String,
    #[serde(flatten)]
    pub page: PageQuery,
}

#[derive(Debug, serde::Deserialize)]
pub struct RefsQuery {
    pub service: Option<String>,
}

/* ── Handlers ── */

/// GET /studio-git/v1/sources?project_id= — what a desktop can clone.
async fn list_sources(
    Extension(ctx): Extension<SecurityContext>,
    Extension(proxy): Extension<Arc<GitProxy>>,
    Query(query): Query<SourcesQuery>,
) -> ApiResult<JsonBody<GitSourceListDto>> {
    let workspace_id = Uuid::parse_str(query.project_id.trim()).map_err(|_| {
        StudioGitError::invalid_argument()
            .with_constraint("project_id is not a UUID")
            .create()
    })?;
    let found = proxy.sources(&ctx, workspace_id).await.ok_or_else(|| {
        StudioGitError::not_found("no such workspace, or its settings are not visible to you")
            .with_resource(workspace_id.to_string())
            .create()
    })?;
    let items: Vec<GitSourceDto> = found
        .into_iter()
        .map(|s| GitSourceDto {
            clone_path: format!(
                "/studio-git/v1/workspaces/{workspace_id}/sources/{}",
                s.name
            ),
            authenticated: s.token_ref.is_some(),
            name: s.name,
            branch: s.branch,
            target: s.target,
        })
        .collect();
    let (items, total) = page_of(items, query.page);
    Ok(Json(GitSourceListDto { items, total }))
}

/// A plain-text protocol failure. `git` prints the body to the user, so it says
/// what to do rather than what went wrong inside.
pub(crate) fn refuse(status: StatusCode, message: &str) -> Response {
    let mut response = Response::new(Body::from(format!("{message}\n")));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    if status == StatusCode::UNAUTHORIZED {
        // Without the challenge `git` never asks its credential helper.
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"Constructor Studio\""),
        );
    }
    response
}

async fn authenticate(proxy: &GitProxy, headers: &HeaderMap) -> Result<SecurityContext, Response> {
    authenticate_member(proxy.authn.as_ref(), headers).await
}

/// The member a Git request comes from: the Studio token it carries (see
/// [`sources::presented_token`]), resolved like any API token. A refusal is
/// already the answer `git` needs, 401 with the Basic challenge.
pub(crate) async fn authenticate_member(
    authn: &dyn AuthNResolverClient,
    headers: &HeaderMap,
) -> Result<SecurityContext, Response> {
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let Some(token) = sources::presented_token(presented) else {
        return Err(refuse(
            StatusCode::UNAUTHORIZED,
            "Sign in to Constructor Studio: this remote takes your Studio token.",
        ));
    };
    match authn.authenticate(&token).await {
        Ok(result) => Ok(result.security_context),
        Err(error) => {
            tracing::debug!(%error, "studio-git: token refused");
            Err(refuse(
                StatusCode::UNAUTHORIZED,
                "Your Studio sign-in is not valid any more; sign in again.",
            ))
        }
    }
}

/// Authenticate, find the source, and send one protocol request upstream.
async fn forward(
    proxy: &Arc<GitProxy>,
    workspace_id: Uuid,
    source: &str,
    protocol_path: &str,
    service: Service,
    request: Request,
) -> Response {
    let ctx = match authenticate(proxy, request.headers()).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let Some(found) = proxy.sources(&ctx, workspace_id).await else {
        return refuse(
            StatusCode::NOT_FOUND,
            "No such workspace, or you are not a member of it.",
        );
    };
    let Some(found) = found.into_iter().find(|s| s.name == source) else {
        return refuse(
            StatusCode::NOT_FOUND,
            "The workspace has no Git source by that name.",
        );
    };
    // Never as the platform: a source connected through a connection held
    // above the project's organization is not proxied, neither with that
    // token nor without it.
    if let Some(holder) = found.held_outside {
        tracing::warn!(%workspace_id, source, %holder, "studio-git: the source's connection is not the organization's; refused");
        return refuse(StatusCode::FORBIDDEN, &sources::not_owned_text(holder));
    }
    let Some(url) = sources::upstream_url(&found.url, protocol_path) else {
        return refuse(
            StatusCode::NOT_FOUND,
            "This source is not an http(s) repository, so it cannot be cloned through Studio.",
        );
    };
    let token = match found.token_ref.as_deref() {
        None => None,
        Some(reference) => match proxy.token(&ctx, reference).await {
            Ok(token) => Some(token),
            Err(error) => {
                tracing::warn!(%workspace_id, source, %error, "studio-git: source token unavailable");
                return refuse(
                    StatusCode::FORBIDDEN,
                    "The workspace's token for this source is not readable by you.",
                );
            }
        },
    };

    let (status, response, answer) = match send_upstream(
        &proxy.client,
        &url,
        protocol_path,
        service,
        token.as_deref(),
        request,
        "The source host refused the workspace's token; ask an owner to update the connection.",
    )
    .await
    {
        Ok(sent) => sent,
        Err(refused) => {
            tracing::warn!(%workspace_id, source, "studio-git: the source host did not serve the request");
            return refused;
        }
    };
    let stream = answer.bytes_stream();
    let body = if refresh::reports_a_push(protocol_path, status) {
        // The push report is the last thing the source host sends, after its
        // refs have moved, so the sync is queued once `git` has read it all:
        // a sync queued any earlier could fetch the tree from before the push.
        let proxy = Arc::clone(proxy);
        let pushed = found.clone();
        let reported = futures_util::stream::once(async move {
            tokio::spawn(async move {
                proxy.refresh_after_push(&ctx, workspace_id, &pushed).await;
            });
        })
        .filter_map(|()| {
            futures_util::future::ready(None::<Result<axum::body::Bytes, reqwest::Error>>)
        });
        Body::from_stream(stream.chain(reported))
    } else {
        Body::from_stream(stream)
    };
    response.body(body).unwrap_or_else(|_| {
        refuse(
            StatusCode::BAD_GATEWAY,
            "The source host sent an unreadable answer.",
        )
    })
}

/// Send one smart-HTTP request to `url` (the source's `…/info/refs` or
/// `…/git-*-pack`), with `token` as the upstream credential, and hand back the
/// answer's status, a response carrying its protocol headers, and the answer
/// to stream. A source host that refuses the token is answered 403 with
/// `refused`: passing its 401 through would make `git` ask for credentials to
/// *this* host again, which cannot help.
pub(crate) async fn send_upstream(
    client: &reqwest::Client,
    url: &str,
    protocol_path: &str,
    service: Service,
    token: Option<&str>,
    request: Request,
    refused: &str,
) -> Result<(u16, axum::http::response::Builder, reqwest::Response), Response> {
    let (parts, body) = request.into_parts();
    let method = if parts.method == axum::http::Method::POST {
        reqwest::Method::POST
    } else {
        reqwest::Method::GET
    };
    let query = if protocol_path == "info/refs" {
        format!("?service={}", service.as_str())
    } else {
        String::new()
    };
    let mut upstream = client.request(method, format!("{url}{query}"));
    for name in &FORWARD_REQUEST {
        if let Some(value) = parts.headers.get(name) {
            upstream = upstream.header(name.as_str(), value.as_bytes());
        }
    }
    if let Some(token) = token {
        upstream = upstream.header(
            reqwest::header::AUTHORIZATION,
            sources::upstream_authorization(token),
        );
    }
    if parts.method == axum::http::Method::POST {
        upstream = upstream.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let answer = match upstream.send().await {
        Ok(answer) => answer,
        Err(error) => {
            // The URL is not logged: a source URL may embed credentials of its own.
            tracing::warn!(error = %error.without_url(), "studio-git: upstream unreachable");
            return Err(refuse(
                StatusCode::BAD_GATEWAY,
                "The source host could not be reached.",
            ));
        }
    };
    let status = answer.status().as_u16();
    if status == 401 || status == 403 {
        tracing::warn!(
            status,
            "studio-git: the source host refused the stored token"
        );
        return Err(refuse(StatusCode::FORBIDDEN, refused));
    }
    let mut response =
        Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY));
    for name in &FORWARD_RESPONSE {
        if let Some(value) = answer.headers().get(name.as_str()) {
            response = response.header(name, value.as_bytes());
        }
    }
    Ok((status, response, answer))
}

/// The upstream answer streamed back as it arrives, nothing buffered.
pub(crate) fn stream_back(
    response: axum::http::response::Builder,
    answer: reqwest::Response,
) -> Response {
    response
        .body(Body::from_stream(answer.bytes_stream()))
        .unwrap_or_else(|_| {
            refuse(
                StatusCode::BAD_GATEWAY,
                "The source host sent an unreadable answer.",
            )
        })
}

/// GET …/info/refs?service= — the first request of every clone, fetch and push.
async fn get_refs(
    Extension(proxy): Extension<Arc<GitProxy>>,
    Path((workspace_id, source)): Path<(Uuid, String)>,
    Query(query): Query<RefsQuery>,
    request: Request,
) -> Response {
    // Only the smart protocol: the dumb one would mean serving a repository's
    // files one by one, which no source host Studio connects to needs.
    let Some(service) = query.service.as_deref().and_then(Service::parse) else {
        return refuse(
            StatusCode::BAD_REQUEST,
            "Only the smart HTTP protocol is served (service=git-upload-pack or git-receive-pack).",
        );
    };
    forward(&proxy, workspace_id, &source, "info/refs", service, request).await
}

/// POST …/git-upload-pack — the pack a clone or fetch downloads.
async fn pull_pack(
    Extension(proxy): Extension<Arc<GitProxy>>,
    Path((workspace_id, source)): Path<(Uuid, String)>,
    request: Request,
) -> Response {
    forward(
        &proxy,
        workspace_id,
        &source,
        "git-upload-pack",
        Service::UploadPack,
        request,
    )
    .await
}

/// POST …/git-receive-pack — the pack a push uploads.
async fn push_pack(
    Extension(proxy): Extension<Arc<GitProxy>>,
    Path((workspace_id, source)): Path<(Uuid, String)>,
    request: Request,
) -> Response {
    forward(
        &proxy,
        workspace_id,
        &source,
        "git-receive-pack",
        Service::ReceivePack,
        request,
    )
    .await
}

/* ── Routes ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    proxy: Arc<GitProxy>,
) -> Router {
    router = OperationBuilder::get("/studio-git/v1/sources")
        .operation_id("studio_git.list_sources")
        .summary("The Git sources of a workspace that a desktop session can clone")
        .description(
            "Lists the workspace's http(s) Git sources with the path to clone each \
             one from through this proxy. No source host URL and no credential is \
             returned: a desktop clones from `clone_path` with its Studio token, \
             and the proxy attaches the stored token upstream.",
        )
        .tag("StudioGit")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_sources)
        .json_response_with_schema::<GitSourceListDto>(openapi, StatusCode::OK, "The sources")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // The protocol routes. `.anonymous().exposed()` because `git` sends Basic
    // credentials, which the gateway's Bearer-only layer would refuse before
    // they arrive; `authenticate` above is the real check, through the same
    // resolver.
    router = OperationBuilder::get(
        "/studio-git/v1/workspaces/{workspace_id}/sources/{source}/info/refs",
    )
    .operation_id("studio_git.get_refs")
    .summary("Git smart-HTTP ref advertisement for a workspace source")
    .description(
        "The first request of every clone, fetch and push. Authenticated with \
             the member's Studio token as the Basic password (or a Bearer token); \
             answers 401 with a Basic challenge so `git` asks its credential helper. \
             A source whose connection is held outside the project's organization \
             (the platform's, inherited) is refused 403 `CONNECTION_NOT_OWNED`, \
             here and on the pack routes.",
    )
    .tag("StudioGit")
    .anonymous()
    .exposed()
    .handler(get_refs)
    .text_response(
        StatusCode::OK,
        "Ref advertisement",
        "application/x-git-upload-pack-advertisement",
    )
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-git/v1/workspaces/{workspace_id}/sources/{source}/git-upload-pack",
    )
    .operation_id("studio_git.pull_pack")
    .summary("Git smart-HTTP upload-pack (clone and fetch) for a workspace source")
    .description(
        "Streams the negotiation to the source host with the workspace's stored \
             token attached, and streams the pack back. Nothing is buffered, so a \
             large repository costs the backend bandwidth, not memory.",
    )
    .tag("StudioGit")
    .anonymous()
    .exposed()
    .handler(pull_pack)
    .text_response(
        StatusCode::OK,
        "Pack",
        "application/x-git-upload-pack-result",
    )
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-git/v1/workspaces/{workspace_id}/sources/{source}/git-receive-pack",
    )
    .operation_id("studio_git.push_pack")
    .summary("Git smart-HTTP receive-pack (push) for a workspace source")
    .description(
        "Streams a push to the source host with the workspace's stored token \
             attached. The source host's own branch protection still applies; \
             this proxy decides only who may reach the workspace.",
    )
    .tag("StudioGit")
    .anonymous()
    .exposed()
    .handler(push_pack)
    .text_response(
        StatusCode::OK,
        "Push report",
        "application/x-git-receive-pack-result",
    )
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router.layer(Extension(proxy))
}
