//! REST surface for connections.
//!
//! Tokens are write-only: they arrive on create and never come back out. What
//! a client gets is the connection record plus, on create and test, the
//! identity the provider reported for that credential — enough to confirm the
//! right token was pasted without ever echoing it.

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

use super::driver::{DriverIdentity, RemoteRepo};
#[cfg(feature = "graph")]
use super::graph_sync::{SyncRequest, sync_repository};
use super::service::{Connection, ConnectorService, NewConnection};
#[cfg(feature = "graph")]
use crate::graph_storage::sdk::GraphStorageClientV1;

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
pub struct GraphSink(pub Option<Arc<dyn GraphStorageClientV1>>);

#[cfg(not(feature = "graph"))]
#[derive(Clone)]
pub struct GraphSink;

#[cfg(feature = "graph")]
impl GraphSink {
    fn get(&self) -> ApiResult<&Arc<dyn GraphStorageClientV1>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail("the knowledge graph is not available in this deployment")
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
    /// `source_code` (repositories can be browsed) | `ai` (credential only).
    pub category: String,
    /// Label the UI should put above the credential field.
    pub credential_label: String,
    /// Placeholder for the credential field.
    pub credential_hint: String,
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

/// Which tenant's catalogue the request is about. The portal passes the
/// workspace it is showing; omitted falls back to the caller's own tenant.
#[derive(Debug, Deserialize)]
pub struct ScopeQuery {
    #[serde(default)]
    tenant: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct RepoQuery {
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
    Query(q): Query<RepoQuery>,
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
        .summary("Import a repository into the knowledge graph")
        .description(
            "Reads the repository's file tree and contributor list through this \
             connection and upserts them as typed nodes and edges. Node keys are \
             derived, so re-running converges instead of duplicating.",
        )
        .tag("StudioConnectors")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Connection id")
        .json_request::<GraphSyncRequest>(openapi, "What to import")
        .handler(graph_sync)
        .json_response_with_schema::<GraphSyncResultDto>(
            openapi,
            StatusCode::OK,
            "What the import wrote",
        )
        .error_400(openapi)
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
    /// rather than refused, and the response says so.
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
    /// Node key of the repository — seed a traversal or a subgraph with it.
    pub repo_node_key: String,
    pub nodes_upserted: u64,
    pub edges_upserted: u64,
    pub files: usize,
    pub directories: usize,
    pub contributors: usize,
    /// Whether the provider or `max_entries` cut the tree short.
    pub truncated: bool,
}

/// Walk a repository and write it into the caller's knowledge graph.
#[cfg(feature = "graph")]
async fn graph_sync(
    Extension(ctx): Extension<SecurityContext>,
    Extension(connectors): Extension<Connectors>,
    Extension(graph): Extension<GraphSink>,
    Path(id): Path<Uuid>,
    Json(body): Json<GraphSyncRequest>,
) -> ApiResult<JsonBody<GraphSyncResultDto>> {
    let svc = connectors.get()?;
    let sink = graph.get()?;

    let outcome = sync_repository(
        svc,
        sink,
        &ctx,
        &SyncRequest {
            connection_id: id,
            tenant: body.tenant.unwrap_or_else(|| ctx.subject_tenant_id()),
            repo_full_path: &body.repo_full_path,
            git_ref: body.git_ref.as_deref(),
            max_entries: body.max_entries,
            max_contributors: body.max_contributors,
            project_id: body.project_id,
            project_name: body.project_name.as_deref(),
        },
    )
    .await
    .map_err(|e| {
        StudioConnectorError::invalid_argument()
            .with_constraint(format!("repository sync failed: {e:#}"))
            .create()
    })?;

    Ok(Json(GraphSyncResultDto {
        git_ref: outcome.git_ref,
        repo_node_key: outcome.repo_node_key,
        nodes_upserted: outcome.nodes_upserted,
        edges_upserted: outcome.edges_upserted,
        files: outcome.files,
        directories: outcome.directories,
        contributors: outcome.contributors,
        truncated: outcome.truncated,
    }))
}
