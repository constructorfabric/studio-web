//! Connectors — the providers Studio talks to, and the credentials it talks
//! with.
//!
//! Three kinds today, and the difference between them is only which of the
//! driver contract's capabilities a driver implements:
//!
//! * **source hosts** (GitLab, GitHub, Bitbucket) — bring repositories into
//!   Studio instead of typing clone URLs;
//! * **model providers** (Anthropic, OpenAI) — the key the IDE agents
//!   authenticate with;
//! * **chat platforms** (Slack, Zulip, Discord) — where Studio delivers
//!   notifications, each with a bot-token and an incoming-webhook variant.
//!
//! Three moving parts, deliberately separated:
//!
//! * **driver** ([`driver::ConnectorDriver`]) — knows one provider's API. Each
//!   driver is a plugin gear ([`plugin`]) that registers a `PluginV1` instance
//!   under `cf.studio.connector.plugin.v1~` and publishes itself as a scoped
//!   ClientHub client. Adding a provider means adding a plugin, not editing
//!   this gear.
//! * **connection** ([`service::Connection`]) — a tenant-scoped record binding
//!   a driver to an installation and a credential. Stored as tenant metadata;
//!   the token lives in credstore, where the sharing mode already expresses
//!   personal / workspace / organization visibility.
//! * **gear** ([`StudioConnectorGear`]) — resolves drivers, owns the catalogue,
//!   serves REST.
//!
//! What this replaces: the portal used to ask for a clone URL, a branch and a
//! `token_ref` per repository, per workspace. Now a connection is configured
//! once and repositories are picked from a list — and because the API returns
//! the credstore reference rather than the token, launching a session with
//! private repos needs no secret handling in the browser at all.

mod ai_providers;
mod bitbucket;
mod discord;
pub mod driver;
mod github;
mod gitlab;
#[cfg(feature = "graph")]
mod graph_sync;
#[cfg(feature = "graph")]
mod graph_sync_task;
pub(crate) mod gts;
mod notify;
mod plugin;
mod rest;
pub(crate) mod service;
mod slack;
mod zulip;

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use credstore_sdk::CredStoreClientV1;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use driver::ConnectorDriver;
use service::ConnectorService;

// The plugin gears are not named anywhere: `#[toolkit::gear]` submits them to
// the link-time `inventory` registry, so compiling the module is what
// registers them (same as `keycloak_idp_plugin`).

/// Every driver instance id the assembly knows how to look for. Resolution is
/// by GTS id through ClientHub, so an id whose plugin gear is not linked
/// simply yields no driver.
const KNOWN_DRIVERS: [&str; 11] = [
    gts::GITLAB_INSTANCE_ID,
    gts::GITHUB_INSTANCE_ID,
    gts::BITBUCKET_INSTANCE_ID,
    gts::ANTHROPIC_INSTANCE_ID,
    gts::OPENAI_INSTANCE_ID,
    gts::SLACK_INSTANCE_ID,
    gts::SLACK_WEBHOOK_INSTANCE_ID,
    gts::ZULIP_INSTANCE_ID,
    gts::ZULIP_WEBHOOK_INSTANCE_ID,
    gts::DISCORD_INSTANCE_ID,
    gts::DISCORD_WEBHOOK_INSTANCE_ID,
];

/// ClientHub key under which the notification sender is published for other
/// gears in this assembly.
///
/// Not a plugin: nothing selects between implementations, so — like
/// `user_profile::IDENTITY_INSTANCE_ID` — this id is the hub's scope key and
/// nothing more. It is not published to the types-registry.
pub const NOTIFY_SENDER_INSTANCE_ID: &str = "cf.studio._.notification_sender.v1~";

/// Message delivery, for gears that queue notifications rather than send them
/// inline (`studio-notify`).
///
/// Deliberately two methods and no catalogue. A consumer may ask whether a
/// connection can deliver, and ask it to deliver — it may not enumerate
/// connections, read credentials, or reach a driver. Everything this trait
/// exposes is something the connector gear would do for an HTTP caller anyway.
#[async_trait]
pub trait NotificationSender: Send + Sync + 'static {
    /// Whether this connection can deliver, and what a delivery to it needs.
    async fn preflight(
        &self,
        ctx: &toolkit_security::SecurityContext,
        tenant: uuid::Uuid,
        connection: uuid::Uuid,
    ) -> anyhow::Result<service::DeliveryPreflight>;

    /// Deliver one message. `ctx` is whatever identity the caller is acting
    /// under — a request's own context inline, or the queue worker's service
    /// identity for a queued delivery.
    async fn deliver(
        &self,
        ctx: &toolkit_security::SecurityContext,
        tenant: uuid::Uuid,
        connection: uuid::Uuid,
        target: Option<&str>,
        message: &driver::NotifyMessage,
    ) -> anyhow::Result<driver::SentMessage>;
}

#[async_trait]
impl NotificationSender for ConnectorService {
    async fn preflight(
        &self,
        ctx: &toolkit_security::SecurityContext,
        tenant: uuid::Uuid,
        connection: uuid::Uuid,
    ) -> anyhow::Result<service::DeliveryPreflight> {
        self.delivery_preflight(ctx, tenant, connection).await
    }

    async fn deliver(
        &self,
        ctx: &toolkit_security::SecurityContext,
        tenant: uuid::Uuid,
        connection: uuid::Uuid,
        target: Option<&str>,
        message: &driver::NotifyMessage,
    ) -> anyhow::Result<driver::SentMessage> {
        self.send_message(ctx, tenant, connection, target, message)
            .await
            .map(|(_, sent)| sent)
    }
}

/// Source-host driver plugin ids (github/gitlab/bitbucket), for gears that
/// resolve a driver from ClientHub without duplicating the id strings — e.g.
/// `artifact_ingest`. AI providers are excluded: they have no repositories,
/// issues or pull requests.
pub fn source_driver_ids() -> [&'static str; 3] {
    [
        gts::GITHUB_INSTANCE_ID,
        gts::GITLAB_INSTANCE_ID,
        gts::BITBUCKET_INSTANCE_ID,
    ]
}

#[toolkit::gear(
    name = "studio-connector",
    deps = [types_registry, account_management, credstore],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioConnectorGear {
    service: std::sync::OnceLock<Arc<ConnectorService>>,
}

#[async_trait]
impl Gear for StudioConnectorGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Catalog the repository knowledge-graph types. Before the driver loop
        // on purpose: a deployment with no driver still answers reads over a
        // graph an earlier sync wrote, and the catalog must describe those
        // types either way. Idempotent — the same documents every boot.
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(gts::catalog_type_schemas()).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-connector: knowledge-graph types cataloged");

        let mut drivers: Vec<(String, Arc<dyn ConnectorDriver>)> = Vec::new();
        for id in KNOWN_DRIVERS {
            match ctx
                .client_hub()
                .get_scoped::<dyn ConnectorDriver>(&ClientScope::gts_id(id))
            {
                Ok(d) => {
                    info!(instance_id = %id, provider = %d.provider(),
                          "studio-connector: driver resolved");
                    drivers.push((id.to_string(), d));
                }
                Err(_) => info!(
                    instance_id = %id,
                    "studio-connector: driver not registered — provider unavailable"
                ),
            }
        }
        if drivers.is_empty() {
            // Not fatal: the REST surface answers 503 with the reason, which
            // beats failing a boot over an optional feature.
            warn!(
                "studio-connector: no connector driver plugins registered — \
                 connection APIs will answer 503"
            );
            return Ok(());
        }

        let am = ctx.client_hub().get::<dyn AccountManagementClient>()?;
        let credstore = ctx.client_hub().get::<dyn CredStoreClientV1>()?;
        let service = ConnectorService::new(am, credstore, drivers);

        // Published in `init` so a consumer resolving it in its own `init` or
        // later cannot lose a race with us. `studio-notify` resolves it lazily
        // per delivery instead, which makes the two gears independent of
        // initialization order altogether — but publishing early costs nothing
        // and keeps the option open.
        // The repository import is a task type now, so it survives a restart,
        // can be cancelled and can be retried. Registered here because the
        // service it needs is built here; the graph client and the alias
        // resolver are resolved per run, inside the handler.
        #[cfg(feature = "graph")]
        crate::tasks::registry::register(Arc::new(graph_sync_task::GraphSyncTask::new(
            Arc::clone(&service),
            ctx.client_hub(),
        )))?;

        let sender: Arc<dyn NotificationSender> = service.clone();
        ctx.client_hub().register_scoped::<dyn NotificationSender>(
            ClientScope::gts_id(NOTIFY_SENDER_INSTANCE_ID),
            sender,
        );

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-connector gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioConnectorGear {
    // `ctx` is read only to resolve the knowledge-graph client.
    #[cfg_attr(not(feature = "graph"), allow(unused_variables))]
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // Resolved here rather than in `init`: the REST phase runs after every
        // gear has initialized, so this does not depend on graph-storage
        // happening to come first in the topological order. A deployment
        // without it keeps the route mounted and answers 503.
        #[cfg(feature = "graph")]
        let graph = rest::GraphSink::new(
            ctx.client_hub()
                .get::<dyn graph_storage_sdk::GraphStorageClientV1>()
                .inspect_err(|_| {
                    warn!("studio-connector: no graph-storage client — imports answer 503");
                })
                .ok(),
            // The hub, not resolved clients: the import runs as a task now and
            // its handler resolves what it needs per run — including the alias
            // resolver, which used to be captured here. What is left on this
            // path is the enqueue and the poll endpoint.
            ctx.client_hub(),
        );
        // Built without the `graph` feature there is no knowledge graph to
        // import into, and the route is not registered at all.
        #[cfg(not(feature = "graph"))]
        let graph = rest::GraphSink;

        Ok(rest::register_routes(
            router,
            openapi,
            self.service.get().cloned(),
            graph,
        ))
    }
}
