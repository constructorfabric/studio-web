//! REST surface for connections.
//!
//! Tokens are write-only: they arrive on create and never come back out. What
//! a client gets is the connection record plus, on create and test, the
//! identity the provider reported for that credential — enough to confirm the
//! right token was pasted without ever echoing it. That holds for a webhook
//! URL too, which is a credential and not a location: it is stored in
//! credstore like any other secret and never appears in a response.
//!
//! Beyond the catalogue, the routes are the capabilities of whatever provider
//! a connection points at: `…/repositories` for a source host, `…/targets` and
//! `…/messages` for a chat platform. A route asked of the wrong kind of
//! connection answers with the driver's own refusal rather than an empty
//! result, so "Slack has no repositories" comes back as a failed-precondition
//! violation with that sentence in it.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde::Deserialize;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::driver::{DriverIdentity, NotifyMessage, NotifyTarget, RemoteRepo};
#[cfg(feature = "graph")]
use super::graph_sync::SyncOutcome;
#[cfg(feature = "graph")]
use super::graph_sync_task::{SyncPayload, TASK_TYPE as GRAPH_SYNC_TASK_TYPE};
use super::service::{Connection, ConnectorService, NewConnection};
#[cfg(feature = "graph")]
use graph_storage_sdk::GraphStorageClientV1;
#[cfg(feature = "graph")]
use toolkit::client_hub::{ClientHub, ClientScope};

/// Errors attributable to a connection as a resource.
#[resource_error(gts_id!("cf.studio.connector.connection.v1~"))]
pub struct StudioConnectorError;

/// Service handle. `None` = the gear booted without its dependencies (no
/// driver plugin linked, or account-management unavailable): routes stay
/// mounted and answer 503 with the reason.
#[derive(Clone)]
pub struct Connectors(pub Option<Arc<ConnectorService>>);

impl Connectors {
    fn get(&self) -> ApiResult<&Arc<ConnectorService>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "source connectors are not available in this deployment \
                     (no connector driver plugin is registered)",
                )
                .create()
        })
    }
}

/// Knowledge-graph sink. `None` = the graph-storage gear did not publish its
/// client, so the sync route answers 503 instead of 500 on a missing
/// dependency.
///
/// The type exists in both builds so `register_routes` keeps one signature;
/// without the `graph` feature it carries nothing and no route reads it.
#[cfg(feature = "graph")]
#[derive(Clone)]
pub struct GraphSink {
    client: Option<Arc<dyn GraphStorageClientV1>>,
    /// Resolves the task queue per request. An import is a run now, and both
    /// the enqueue and the poll endpoint read through here — lazily, so this
    /// gear does not care whether `studio-tasks` initialized first.
    hub: Arc<ClientHub>,
}

#[cfg(not(feature = "graph"))]
#[derive(Clone)]
pub struct GraphSink;

#[cfg(feature = "graph")]
impl GraphSink {
    pub fn new(client: Option<Arc<dyn GraphStorageClientV1>>, hub: Arc<ClientHub>) -> Self {
        Self { client, hub }
    }

    fn get(&self) -> ApiResult<&Arc<dyn GraphStorageClientV1>> {
        self.client.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail("the knowledge graph is not available in this deployment")
                .create()
        })
    }

    fn queue(&self) -> ApiResult<Arc<dyn crate::tasks::TaskQueue>> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "repository imports are not available in this deployment                          (studio-tasks has no database configured)",
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

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProviderDto {
    /// Stable key used when creating a connection.
    pub provider: String,
    pub display_name: String,
    /// Suggested installation root for the form.
    pub default_base_url: String,
    /// GTS instance id of the driver plugin serving this provider.
    pub instance_id: String,
    /// `source_code` (repositories can be browsed) | `ai` (credential only) |
    /// `notification` (messages can be posted).
    pub category: String,
    /// Label the UI should put above the credential field.
    pub credential_label: String,
    /// Placeholder for the credential field.
    pub credential_hint: String,
    /// `notification` providers only: `true` when the credential itself fixes
    /// the channel — an incoming webhook — so a client should offer no channel
    /// picker and send no `target`.
    pub fixed_target: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProviderListDto {
    pub items: Vec<ProviderDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateConnectionRequest {
    /// Driver key from `GET /providers`.
    pub provider: String,
    /// Human label shown in the UI.
    pub label: String,
    /// Installation root; omitted = the provider's default.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Personal access token. Stored in credstore, never returned.
    pub token: String,
    /// personal | workspace | organization (default: workspace).
    #[serde(default)]
    pub scope: Option<String>,
    /// Tenant the connection is attached to: an organization (inherited by all
    /// its workspaces) or one workspace. Omitted = the caller's own tenant.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub owner_tenant_id: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PatchConnectionRequest {
    /// New label. Omitted = unchanged.
    #[serde(default)]
    pub label: Option<String>,
    /// New installation root. Omitted = unchanged; empty string = back to the
    /// provider's default.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Replacement credential. Omitted = keep the stored one (the change is
    /// still verified against it). Never returned.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ProbeConnectionRequest {
    /// Driver key from `GET /providers`.
    pub provider: String,
    /// Installation root; omitted = the provider's default.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Credential to verify. Not stored.
    pub token: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct IdentityDto {
    /// Account the credential belongs to, as reported by the provider.
    pub account: String,
    pub display_name: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConnectionDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    /// Tenant holding this connection. Equal to the tenant being viewed for a
    /// connection of its own; an ancestor's id when it was inherited.
    #[schema(value_type = String)]
    pub owner_tenant_id: Uuid,
    pub provider: String,
    pub label: String,
    /// Account the credential belongs to, captured when it was verified.
    pub account: String,
    pub base_url: String,
    pub scope: String,
    /// credstore reference of the token — hand this to studio-session as
    /// `token_ref` instead of copying the secret around.
    pub secret_ref: String,
    pub created_at_epoch_secs: u64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConnectionListDto {
    pub items: Vec<ConnectionDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConnectionTestDto {
    pub connection: ConnectionDto,
    /// Account the credential belongs to, as reported by the provider.
    pub account: String,
    pub display_name: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RemoteRepoDto {
    /// Provider-native id.
    pub id: String,
    /// Short name — the default directory inside a workspace.
    pub name: String,
    /// Namespaced path, e.g. `group/repo`.
    pub full_path: String,
    pub clone_url: String,
    pub default_branch: Option<String>,
    pub description: Option<String>,
    pub visibility: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RemoteRepoListDto {
    pub items: Vec<RemoteRepoDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct NotifyTargetDto {
    /// Provider-native id. Send this back as `target` — it is what the driver
    /// expects, and its shape differs per platform.
    pub id: String,
    /// Channel name without the platform's sigil.
    pub name: String,
    /// The server or workspace the channel belongs to, where the platform
    /// nests them (a Discord guild).
    pub container: Option<String>,
    /// Whether posting needs an invite.
    pub private: bool,
    /// Whether a message to this target must carry a `topic`. True for Zulip.
    pub topic_required: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct NotifyTargetListDto {
    pub items: Vec<NotifyTargetDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SendMessageRequest {
    /// Channel to post to, from `GET …/targets`. Omitted for a provider whose
    /// `fixed_target` is true (an incoming webhook), required otherwise.
    #[serde(default)]
    pub target: Option<String>,
    /// The message body. Markdown-ish; each driver renders it into its own
    /// platform's idiom.
    pub text: String,
    /// A short headline, rendered bold above the body.
    #[serde(default)]
    pub title: Option<String>,
    /// A link to the thing the message is about, appended as its own line.
    #[serde(default)]
    pub link: Option<String>,
    /// Thread/topic within the channel. Required by Zulip — which supplies a
    /// default when it is absent — and ignored by Slack and Discord.
    #[serde(default)]
    pub topic: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SentMessageDto {
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    pub provider: String,
    /// Where it landed, as the platform reported it. Not necessarily what was
    /// asked for: a webhook connection resolves its own channel.
    pub target: String,
    /// Provider-native message id, where the platform returns one.
    pub message_id: Option<String>,
}

/// Which tenant's catalogue the request is about. The portal passes the
/// workspace it is showing; omitted falls back to the caller's own tenant.
#[derive(Debug, Deserialize)]
pub struct ScopeQuery {
    #[serde(default)]
    tenant: Option<Uuid>,
}

/// A filtered listing through a connection — repositories, or notification
/// channels. One struct: the three parameters mean the same thing for both,
/// and the providers differ only in whether the filtering happens server-side.
#[derive(Debug, Deserialize)]
pub struct ListingQuery {
    /// Narrow the listing; server-side where the provider supports it.
    #[serde(default)]
    search: Option<String>,
    /// Page size, 1..=100.
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    tenant: Option<Uuid>,
}

fn to_dto(c: Connection) -> ConnectionDto {
    ConnectionDto {
        id: c.id,
        owner_tenant_id: c.owner_tenant_id,
        provider: c.provider,
        label: c.label,
        account: c.account,
        base_url: c.base_url,
        scope: c.scope,
        secret_ref: c.secret_ref,
        created_at_epoch_secs: c.created_at_epoch_secs,
    }
}

fn to_test_dto(c: Connection, id: DriverIdentity) -> ConnectionTestDto {
    ConnectionTestDto {
        connection: to_dto(c),
        account: id.account,
        display_name: id.display_name,
    }
}

fn to_target_dto(t: NotifyTarget) -> NotifyTargetDto {
    NotifyTargetDto {
        id: t.id,
        name: t.name,
        container: t.container,
        private: t.private,
        topic_required: t.topic_required,
    }
}

fn to_repo_dto(r: RemoteRepo) -> RemoteRepoDto {
    RemoteRepoDto {
        id: r.id,
        name: r.name,
        full_path: r.full_path,
        clone_url: r.clone_url,
        default_branch: r.default_branch,
        description: r.description,
        visibility: r.visibility,
    }
}

/* ── Handlers ── */

async fn list_providers(
    Extension(connectors): Extension<Connectors>,
) -> ApiResult<JsonBody<ProviderListDto>> {
    let svc = connectors.get()?;
    Ok(Json(ProviderListDto {
        items: svc
            .providers()
            .into_iter()
            .map(|p| ProviderDto {
                provider: p.provider,
                display_name: p.display_name,
                default_base_url: p.default_base_url,
                instance_id: p.instance_id,
                category: p.category,
                credential_label: p.credential_label,
                credential_hint: p.credential_hint,
                fixed_target: p.fixed_target,
            })
            .collect(),
    }))
}

async fn list_connections(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<JsonBody<ConnectionListDto>> {
    let svc = connectors.get()?;
    let items = svc
        .list(&ctx, q.tenant.unwrap_or_else(|| ctx.subject_tenant_id()))
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ConnectionListDto {
        items: items.into_iter().map(to_dto).collect(),
    }))
}

async fn patch_connection(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
    Json(req): Json<PatchConnectionRequest>,
) -> ApiResult<JsonBody<ConnectionTestDto>> {
    let svc = connectors.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let (connection, identity) = svc
        .update(
            &ctx,
            tenant,
            id,
            req.label.as_deref(),
            req.base_url.as_deref(),
            req.token.as_deref(),
        )
        .await
        // A rejected credential, an unknown installation or an attempt to edit
        // an inherited row are all the caller's problem, reported in the
        // provider's own words.
        .map_err(|e| {
            StudioConnectorError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(to_test_dto(connection, identity)))
}

async fn create_connection(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Json(req): Json<CreateConnectionRequest>,
) -> ApiResult<(StatusCode, JsonBody<ConnectionTestDto>)> {
    let svc = connectors.get()?;
    let (connection, identity) = svc
        .create(
            &ctx,
            NewConnection {
                owner_tenant: req
                    .owner_tenant_id
                    .unwrap_or_else(|| ctx.subject_tenant_id()),
                provider: req.provider.trim(),
                label: &req.label,
                base_url: req.base_url.as_deref(),
                token: &req.token,
                scope: req.scope.as_deref().unwrap_or("workspace"),
            },
        )
        .await
        // A rejected credential or an unknown provider is the caller's
        // problem, not ours — 400 with the provider's own words.
        .map_err(|e| {
            StudioConnectorError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok((StatusCode::CREATED, Json(to_test_dto(connection, identity))))
}

async fn probe_connection(
    Extension(connectors): Extension<Connectors>,
    Json(req): Json<ProbeConnectionRequest>,
) -> ApiResult<JsonBody<IdentityDto>> {
    let svc = connectors.get()?;
    let identity = svc
        .probe(req.provider.trim(), req.base_url.as_deref(), &req.token)
        .await
        // The provider rejected the credential, or the provider key is
        // unknown to this deployment — either way the caller sent something
        // we cannot use, so 400 with the provider's own words.
        .map_err(|e| {
            StudioConnectorError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(IdentityDto {
        account: identity.account,
        display_name: identity.display_name,
    }))
}

async fn test_connection(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<JsonBody<ConnectionTestDto>> {
    let svc = connectors.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let (connection, identity) = svc.test(&ctx, tenant, id).await.map_err(|e| {
        // The connection exists but is no longer usable: a rotated token, a
        // secret the caller may not read, a provider that is down.
        StudioConnectorError::failed_precondition()
            .with_precondition_violation(
                id.to_string(),
                format!("{e:#}"),
                "CONNECTOR_CREDENTIAL_UNUSABLE",
            )
            .create()
    })?;
    Ok(Json(to_test_dto(connection, identity)))
}

async fn list_repositories(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Path(id): Path<Uuid>,
    Query(q): Query<ListingQuery>,
) -> ApiResult<JsonBody<RemoteRepoListDto>> {
    let svc = connectors.get()?;
    let items = svc
        .repositories(
            &ctx,
            q.tenant.unwrap_or_else(|| ctx.subject_tenant_id()),
            id,
            q.search.as_deref(),
            q.limit.unwrap_or(50),
        )
        .await
        // Covers both an unusable credential and a model-provider connection,
        // which has no repositories by definition.
        .map_err(|e| {
            StudioConnectorError::failed_precondition()
                .with_precondition_violation(
                    id.to_string(),
                    format!("{e:#}"),
                    "CONNECTOR_LISTING_UNAVAILABLE",
                )
                .create()
        })?;
    Ok(Json(RemoteRepoListDto {
        items: items.into_iter().map(to_repo_dto).collect(),
    }))
}

async fn list_targets(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Path(id): Path<Uuid>,
    Query(q): Query<ListingQuery>,
) -> ApiResult<JsonBody<NotifyTargetListDto>> {
    let svc = connectors.get()?;
    let items = svc
        .notification_targets(
            &ctx,
            q.tenant.unwrap_or_else(|| ctx.subject_tenant_id()),
            id,
            q.search.as_deref(),
            q.limit.unwrap_or(100),
        )
        .await
        // Three shapes of the same answer: an unusable credential, a
        // connection to something that is not a chat platform, and a webhook
        // whose channel is fixed in its URL. All three are the connection's
        // state rather than a malformed request, and all three carry a
        // sentence worth showing.
        .map_err(|e| {
            StudioConnectorError::failed_precondition()
                .with_precondition_violation(
                    id.to_string(),
                    format!("{e:#}"),
                    "CONNECTOR_LISTING_UNAVAILABLE",
                )
                .create()
        })?;
    Ok(Json(NotifyTargetListDto {
        items: items.into_iter().map(to_target_dto).collect(),
    }))
}

async fn send_message(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
    Json(req): Json<SendMessageRequest>,
) -> ApiResult<JsonBody<SentMessageDto>> {
    let svc = connectors.get()?;
    // The one thing this layer can judge without asking a provider. Everything
    // else — whether the target is required, whether the channel exists,
    // whether the bot may post in it — is the platform's to answer.
    if req.text.trim().is_empty() && req.title.as_deref().unwrap_or_default().trim().is_empty() {
        return Err(StudioConnectorError::invalid_argument()
            .with_constraint("a message needs a text or a title")
            .create());
    }
    let message = NotifyMessage {
        text: req.text,
        title: req.title,
        link: req.link,
        topic: req.topic,
    };
    let (connection, sent) = svc
        .send_message(
            &ctx,
            q.tenant.unwrap_or_else(|| ctx.subject_tenant_id()),
            id,
            req.target.as_deref(),
            &message,
        )
        .await
        // Delivery failed at the provider, or the connection is not one that
        // can deliver. Reported as a precondition on the connection with the
        // platform's own words: `not_in_channel`, `Missing Access`, a revoked
        // webhook. A message is never retried here — see
        // `ConnectorService::send_message`.
        .map_err(|e| {
            StudioConnectorError::failed_precondition()
                .with_precondition_violation(
                    id.to_string(),
                    format!("{e:#}"),
                    "CONNECTOR_DELIVERY_FAILED",
                )
                .create()
        })?;
    Ok(Json(SentMessageDto {
        connection_id: connection.id,
        provider: connection.provider,
        target: sent.target,
        message_id: sent.id,
    }))
}

async fn delete_connection(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<StatusCode> {
    let svc = connectors.get()?;
    let removed = svc
        .delete(
            &ctx,
            q.tenant.unwrap_or_else(|| ctx.subject_tenant_id()),
            id,
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    if !removed {
        return Err(StudioConnectorError::not_found("Connection not found")
            .with_resource(id.to_string())
            .create());
    }
    Ok(StatusCode::NO_CONTENT)
}

/* ── Registration ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<ConnectorService>>,
    graph: GraphSink,
) -> Router {
    router = OperationBuilder::get("/studio-connector/v1/providers")
        .operation_id("studio_connector.list_providers")
        .summary("List source providers this deployment can connect to")
        .description(
            "One entry per registered connector driver plugin. A provider absent \
             from this list has no plugin linked into the assembly.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_providers)
        .json_response_with_schema::<ProviderListDto>(openapi, StatusCode::OK, "Providers")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-connector/v1/connections")
        .operation_id("studio_connector.list_connections")
        .summary("List connections visible to the caller")
        .description(
            "The caller's own tenant catalogue, or the nearest ancestor's when the \
             tenant has none of its own (organization-scoped connections).",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_connections)
        .json_response_with_schema::<ConnectionListDto>(openapi, StatusCode::OK, "Connections")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-connector/v1/connections")
        .operation_id("studio_connector.create_connection")
        .summary("Add a connection to a source host")
        .description(
            "Verifies the credential against the provider before storing anything. \
             The token goes to credstore under the requested scope; only its \
             reference is kept with the connection.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateConnectionRequest>(openapi, "Connection parameters")
        .handler(create_connection)
        .json_response_with_schema::<ConnectionTestDto>(
            openapi,
            StatusCode::CREATED,
            "Connection created; body carries the account the credential belongs to",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-connector/v1/probe")
        .operation_id("studio_connector.probe_connection")
        .summary("Verify a credential without storing it")
        .description(
            "Backs the \"Test connection\" affordance: the token is used for one \
             call to the provider and discarded. Nothing is written.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ProbeConnectionRequest>(openapi, "Credential to verify")
        .handler(probe_connection)
        .json_response_with_schema::<IdentityDto>(openapi, StatusCode::OK, "Credential is valid")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-connector/v1/connections/{id}/test")
        .operation_id("studio_connector.test_connection")
        .summary("Re-verify a stored credential")
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .handler(test_connection)
        .json_response_with_schema::<ConnectionTestDto>(
            openapi,
            StatusCode::OK,
            "Credential is valid",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-connector/v1/connections/{id}/repositories")
        .operation_id("studio_connector.list_repositories")
        .summary("List repositories reachable through a connection")
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .handler(list_repositories)
        .json_response_with_schema::<RemoteRepoListDto>(openapi, StatusCode::OK, "Repositories")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-connector/v1/connections/{id}/targets")
        .operation_id("studio_connector.list_targets")
        .summary("List channels a notification connection can post to")
        .description(
            "Slack conversations, Zulip channels, Discord text channels. Each entry's \
             `id` is what `POST …/messages` expects as `target`. Refuses a \
             connection whose provider has no channels to browse — including an \
             incoming webhook, whose channel is fixed in the URL it was created from.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .handler(list_targets)
        .json_response_with_schema::<NotifyTargetListDto>(openapi, StatusCode::OK, "Channels")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-connector/v1/connections/{id}/messages")
        .operation_id("studio_connector.send_message")
        .summary("Post a message through a notification connection")
        .description(
            "The caller says what happened; the driver renders it into the platform's \
             own idiom, so no caller has to know which of Slack, Zulip or Discord is \
             behind the connection. Delivered once and not retried: a refusal by the \
             platform comes back as a failed-precondition on the connection, carrying \
             the platform's own reason — which is the thing worth acting on.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .json_request::<SendMessageRequest>(openapi, "The message to deliver")
        .handler(send_message)
        .json_response_with_schema::<SentMessageDto>(
            openapi,
            StatusCode::OK,
            "Delivered; body says where it landed",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::patch("/studio-connector/v1/connections/{id}")
        .operation_id("studio_connector.patch_connection")
        .summary("Relabel a connection, move it, or rotate its credential")
        .description(
            "Every field is optional. The result is verified against the provider before \
             anything is written, whether or not a new token was sent — so relocating an \
             installation cannot leave a connection that has never been proven to work. \
             The connection id and its credstore reference are preserved, which is the \
             point: workspace sources reference a connection by id, so rotating an \
             expired token must not mean deleting and re-adding it. Scope is not \
             editable — it maps onto the secret's sharing mode.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .json_request::<PatchConnectionRequest>(openapi, "Fields to change")
        .handler(patch_connection)
        .json_response_with_schema::<ConnectionTestDto>(
            openapi,
            StatusCode::OK,
            "Connection updated; body carries the account the credential belongs to",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-connector/v1/connections/{id}")
        .operation_id("studio_connector.delete_connection")
        .summary("Remove a connection and its stored token")
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .handler(delete_connection)
        .no_content_response(StatusCode::NO_CONTENT, "Connection removed")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    #[cfg(feature = "graph")]
    let router = OperationBuilder::post("/studio-connector/v1/connections/{id}/graph-sync")
        .operation_id("studio_connector.graph_sync")
        .summary("Import a repository into the knowledge graph (background task)")
        .description(
            "Reads the repository's file tree and contributor list through this \
             connection and upserts them as typed nodes and edges; the graph \
             embeds every node on write. The import runs in the background — \
             this returns a task id at once, poll `GET /graph-sync/tasks/{task_id}` \
             for the phase and the outcome. Node keys are derived, so re-running \
             converges instead of duplicating. `wait: true` runs the import \
             inline instead and answers with the outcome, which fits the gateway \
             deadline only for small repositories.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .json_request::<GraphSyncRequest>(openapi, "What to import")
        .handler(graph_sync)
        .json_response_with_schema::<GraphSyncAcceptedDto>(
            openapi,
            StatusCode::OK,
            "The task id to poll, or (with `wait`) the outcome",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    #[cfg(feature = "graph")]
    let router = OperationBuilder::get("/studio-connector/v1/graph-sync/tasks/{task_id}")
        .operation_id("studio_connector.graph_sync_task")
        .summary("Poll a repository import")
        .description(
            "The status of a background import: `queued`, `running` (with the \
             current phase in `message`), `succeeded` (with `outcome`) or `failed` \
             (with the error in `message`). Tasks live in this process's memory: \
             a restart forgets them, and an import is cheap to re-run.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("task_id", "Task id returned by the import call")
        .handler(graph_sync_task)
        .json_response_with_schema::<GraphSyncTaskDto>(openapi, StatusCode::OK, "Task status")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router
        .layer(Extension(Connectors(service)))
        .layer(Extension(graph))
}

// ── repository import into the knowledge graph (`graph` feature) ──
#[cfg(feature = "graph")]
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GraphSyncRequest {
    /// Namespaced repository path, e.g. `constructorfabric/gears-rust`.
    pub repo_full_path: String,
    /// Ref to read the tree at; omitted = the repository's default branch.
    #[serde(default)]
    pub git_ref: Option<String>,
    /// Cap on tree entries turned into nodes. A large repository is truncated
    /// rather than refused, and the outcome says so.
    #[serde(default = "default_max_entries")]
    pub max_entries: usize,
    /// Cap on contributors turned into nodes.
    #[serde(default = "default_max_contributors")]
    pub max_contributors: u32,
    /// Project to attach the repository to, when the caller has one.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub project_id: Option<Uuid>,
    /// Display name of that project.
    #[serde(default)]
    pub project_name: Option<String>,
    /// Tenant context; omitted = the caller's own tenant.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub tenant: Option<Uuid>,
    /// Run inline and answer with the outcome instead of a task id. The import
    /// then has to finish within the gateway's request deadline, which a
    /// repository of a few hundred files does not reliably do.
    #[serde(default)]
    pub wait: bool,
}

#[cfg(feature = "graph")]
const fn default_max_entries() -> usize {
    2_000
}

#[cfg(feature = "graph")]
const fn default_max_contributors() -> u32 {
    50
}

#[cfg(feature = "graph")]
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GraphSyncResultDto {
    /// Ref the tree was actually read at.
    pub git_ref: String,
    /// Node key of the repository — seed a traversal or a neighbourhood with it.
    pub repo_node_key: String,
    pub nodes_upserted: u64,
    pub edges_upserted: u64,
    pub files: usize,
    pub directories: usize,
    pub contributors: usize,
    /// Of those, how many were keyed on a canonical Studio user because the
    /// person had proved control of the account.
    pub resolved_contributors: usize,
    /// Whether the provider or `max_entries` cut the tree short.
    pub truncated: bool,
}

#[cfg(feature = "graph")]
impl From<SyncOutcome> for GraphSyncResultDto {
    fn from(o: SyncOutcome) -> Self {
        Self {
            git_ref: o.git_ref,
            repo_node_key: o.repo_node_key,
            nodes_upserted: o.nodes_upserted,
            edges_upserted: o.edges_upserted,
            files: o.files,
            directories: o.directories,
            contributors: o.contributors,
            resolved_contributors: o.resolved_contributors,
            truncated: o.truncated,
        }
    }
}

/// What the import call answers: a task to poll, or — with `wait` — the
/// finished outcome under the same shape (`status: succeeded`).
#[cfg(feature = "graph")]
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GraphSyncAcceptedDto {
    pub task_id: String,
    /// `queued` | `running` | `succeeded` | `failed`.
    pub status: String,
    pub repo_full_path: String,
    /// Present with `wait: true`.
    pub outcome: Option<GraphSyncResultDto>,
}

#[cfg(feature = "graph")]
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GraphSyncTaskDto {
    pub task_id: String,
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    pub repo_full_path: String,
    /// `queued` | `running` | `succeeded` | `failed`.
    pub status: String,
    /// The current phase while running; the error once failed.
    pub message: Option<String>,
    /// What the import wrote, once succeeded.
    pub outcome: Option<GraphSyncResultDto>,
}

/// Walk a repository and write it into the caller's knowledge graph.
///
/// Enqueues a `connector.graph_sync` run and answers with its id. `wait: true`
/// keeps the documented inline behaviour by polling that run until it finishes
/// or a deadline passes — the work happens in the queue either way, so there is
/// one code path and one record of it.
#[cfg(feature = "graph")]
async fn graph_sync(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Extension(graph): Extension<GraphSink>,
    Path(id): Path<Uuid>,
    Json(body): Json<GraphSyncRequest>,
) -> ApiResult<JsonBody<GraphSyncAcceptedDto>> {
    let svc = Arc::clone(connectors.get()?);
    // Resolved for its 503: an import cannot run where there is no graph, and
    // saying so now beats a run that retries until it dead-letters.
    let _ = graph.get()?;
    let queue = graph.queue()?;

    let tenant = body.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let repo_full_path = body.repo_full_path.trim().to_owned();
    if repo_full_path.is_empty() {
        return Err(StudioConnectorError::invalid_argument()
            .with_constraint("repo_full_path must not be empty")
            .create());
    }
    // The connection is resolved up front, with the request's own context, so a
    // wrong id or an unreadable token is answered now rather than found by a
    // poll later.
    svc.driver_and_auth(&ctx, tenant, id).await.map_err(|e| {
        StudioConnectorError::invalid_argument()
            .with_constraint(format!("repository sync failed: {e:#}"))
            .create()
    })?;

    let payload = serde_json::to_value(SyncPayload {
        connection_id: id,
        repo_full_path: repo_full_path.clone(),
        git_ref: body.git_ref,
        max_entries: body.max_entries,
        max_contributors: body.max_contributors,
        project_id: body.project_id,
        project_name: body.project_name,
    })
    .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::service::NewRun {
                tenant,
                task_type: GRAPH_SYNC_TASK_TYPE,
                payload,
                // One repository's imports never run concurrently with each
                // other: two walks of the same tree would fight over the same
                // node keys.
                partition_key: Some(&format!("{id}:{repo_full_path}")),
                idempotency_key: None,
            },
        )
        .await
        .map_err(|e| {
            StudioConnectorError::failed_precondition()
                .with_precondition_violation(
                    id.to_string(),
                    format!("{e:#}"),
                    "CONNECTOR_IMPORT_NOT_QUEUED",
                )
                .create()
        })?;

    if body.wait {
        return wait_for_import(&queue, tenant, run_id, repo_full_path).await;
    }

    Ok(Json(GraphSyncAcceptedDto {
        task_id: run_id.to_string(),
        status: "queued".to_owned(),
        repo_full_path,
        outcome: None,
    }))
}

/// Poll one import to completion, for `wait: true`.
///
/// Bounded well inside the gateway's deadline: an import of a few hundred files
/// does not reliably finish in time, which the request field's own
/// documentation has always said. Timing out here cancels nothing — the run
/// carries on and the caller gets its id.
#[cfg(feature = "graph")]
async fn wait_for_import(
    queue: &Arc<dyn crate::tasks::TaskQueue>,
    tenant: Uuid,
    run_id: Uuid,
    repo_full_path: String,
) -> ApiResult<JsonBody<GraphSyncAcceptedDto>> {
    use crate::tasks::RunState;

    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(20);
    const POLL: std::time::Duration = std::time::Duration::from_millis(500);

    let until = std::time::Instant::now() + DEADLINE;
    while std::time::Instant::now() < until {
        tokio::time::sleep(POLL).await;
        let Some(run) = queue
            .run(tenant, run_id)
            .await
            .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        else {
            break;
        };
        match run.state {
            RunState::Succeeded => {
                return Ok(Json(GraphSyncAcceptedDto {
                    task_id: run_id.to_string(),
                    status: run.state.as_str().to_owned(),
                    repo_full_path,
                    outcome: run.result.and_then(sync_outcome_of).map(Into::into),
                }));
            }
            RunState::Failed | RunState::Cancelled => {
                return Err(StudioConnectorError::invalid_argument()
                    .with_constraint(format!(
                        "repository sync failed: {}",
                        run.last_error
                            .unwrap_or_else(|| run.state.as_str().to_owned())
                    ))
                    .create());
            }
            RunState::Queued | RunState::Running => {}
        }
    }
    // Still going. The honest answer is the task id — which is what the caller
    // would have got without `wait`.
    Ok(Json(GraphSyncAcceptedDto {
        task_id: run_id.to_string(),
        status: "running".to_owned(),
        repo_full_path,
        outcome: None,
    }))
}

/// A run's `result` read back as the walk's own outcome.
#[cfg(feature = "graph")]
fn sync_outcome_of(result: serde_json::Value) -> Option<SyncOutcome> {
    serde_json::from_value(result)
        .inspect_err(|e| tracing::warn!("studio-connector: unreadable import result: {e}"))
        .ok()
}

/// The state of one background import.
///
/// Served from the `connector.graph_sync` run rather than from a registry of
/// this gear's own: the route and its response shape are unchanged, the state
/// behind them now survives a restart. `task_id` is the run id, so
/// `GET /studio-tasks/v1/runs/{task_id}` answers the same question with more
/// detail.
#[cfg(feature = "graph")]
async fn graph_sync_task(
    Extension(ctx): Extension<SecurityContext>,
    Extension(graph): Extension<GraphSink>,
    Path(task_id): Path<String>,
) -> ApiResult<JsonBody<GraphSyncTaskDto>> {
    let queue = graph.queue()?;
    let not_found = || {
        StudioConnectorError::not_found("no such import task")
            .with_resource(task_id.clone())
            .create()
    };
    // Task ids used to be this gear's own strings; they are run ids now, and an
    // unparseable one is simply not a task this deployment has.
    let run_id = Uuid::parse_str(&task_id).map_err(|_| not_found())?;
    let run = queue
        .run(ctx.subject_tenant_id(), run_id)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .ok_or_else(not_found)?;

    let payload: Option<SyncPayload> = serde_json::from_value(run.payload).ok();
    Ok(Json(GraphSyncTaskDto {
        task_id,
        connection_id: payload.as_ref().map_or_else(Uuid::nil, |p| p.connection_id),
        repo_full_path: payload.map(|p| p.repo_full_path).unwrap_or_default(),
        status: run.state.as_str().to_owned(),
        // What it did if it finished, why it stopped if it failed, where it is
        // if it is still going — in that order of usefulness to whoever is
        // polling.
        message: run.summary.or(run.last_error).or(run.progress),
        outcome: run.result.and_then(sync_outcome_of).map(Into::into),
    }))
}
