//! Source connectors — bring repositories into Studio instead of typing URLs.
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
pub mod driver;
mod github;
mod gitlab;
#[cfg(feature = "graph")]
mod graph_sync;
#[cfg(feature = "graph")]
mod graph_sync_tasks;
mod gts;
mod plugin;
mod rest;
mod service;

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use credstore_sdk::CredStoreClientV1;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use driver::ConnectorDriver;
use service::ConnectorService;

// The plugin gears are not named anywhere: `#[toolkit::gear]` submits them to
// the link-time `inventory` registry, so compiling the module is what
// registers them (same as `keycloak_idp_plugin`).

/// Every driver instance id the assembly knows how to look for. Resolution is
/// by GTS id through ClientHub, so an id whose plugin gear is not linked
/// simply yields no driver.
const KNOWN_DRIVERS: [&str; 5] = [
    gts::GITLAB_INSTANCE_ID,
    gts::GITHUB_INSTANCE_ID,
    gts::BITBUCKET_INSTANCE_ID,
    gts::ANTHROPIC_INSTANCE_ID,
    gts::OPENAI_INSTANCE_ID,
];

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
    deps = [account_management, credstore],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioConnectorGear {
    service: std::sync::OnceLock<Arc<ConnectorService>>,
}

#[async_trait]
impl Gear for StudioConnectorGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
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
                    warn!(
                        "studio-connector: graph-storage client not registered — \
                         repository import will answer 503"
                    );
                })
                .ok(),
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
