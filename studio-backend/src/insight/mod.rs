//! studio-insight — the integration seam to Constructor Insight
//! (`github.com/constructorfabric/insight`, a decision-intelligence platform
//! whose REST API lives under `/api/v1`).
//!
//! This gear wraps that external service so the rest of the assembly has one
//! place of contact for two scenarios: **pull** data from Insight and **push**
//! data to Insight. The seam is exposed two ways:
//!   * a REST surface (`/studio-insight/v1/{pull,push,health}`) for the portal
//!     and out-of-process callers, and
//!   * an in-process [`InsightClient`] published to the ClientHub, so another
//!     gear can reach Insight without a network hop through our own gateway.
//!
//! Deliberately generic (resource + JSON) while Insight finalizes the contract
//! for us; typed methods land on the same client once their shapes are pinned.

mod client;
mod config;
mod rest;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use client::HttpInsightClient;
pub use client::InsightClient;
use config::InsightConfig;

/// ClientHub scope key under which the Insight client is published for other
/// gears. Resolve it with `get_scoped::<dyn InsightClient>(&ClientScope::gts_id(INSIGHT_INSTANCE_ID))`.
pub const INSIGHT_INSTANCE_ID: &str = "cf.studio._.insight.v1~";

#[toolkit::gear(name = "studio-insight", capabilities = [rest])]
#[derive(Default)]
pub struct StudioInsightGear {
    client: OnceLock<Arc<HttpInsightClient>>,
}

#[async_trait]
impl Gear for StudioInsightGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: InsightConfig = ctx.config_or_default()?;
        let base_url = cfg.resolve_base_url();
        let api_key = cfg.resolve_api_key();
        let api_path = cfg.resolve_api_path();

        if base_url.is_empty() || api_key.is_none() {
            warn!(
                base_url_set = !base_url.is_empty(),
                key_set = api_key.is_some(),
                "studio-insight: upstream not (fully) configured — pull/push will 500. \
                 Set STUDIO_INSIGHT_BASE_URL / STUDIO_INSIGHT_API_KEY (or the YAML equivalents)"
            );
        } else {
            info!(base_url = %base_url, api_path = %api_path, "studio-insight: configured");
        }

        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()?;
        let client = Arc::new(HttpInsightClient::new(http, base_url, api_path, api_key));

        // Publish the seam for other gears (in `init`, before any REST phase, so
        // a consumer resolving it in its own REST phase cannot lose a race).
        let published: Arc<dyn InsightClient> = client.clone();
        ctx.client_hub().register_scoped::<dyn InsightClient>(
            ClientScope::gts_id(INSIGHT_INSTANCE_ID),
            published,
        );

        self.client
            .set(client)
            .map_err(|_| anyhow::anyhow!("studio-insight already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioInsightGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let client = self
            .client
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-insight not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, client))
    }
}
