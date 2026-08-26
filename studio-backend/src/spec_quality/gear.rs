use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use super::config::SpecQualityConfig;
use super::rest::{self, ProxyState};

/// Authenticated wrapper over the external spec-quality service.
///
/// See the module docs (`super`) for the why; the how is deliberately dumb:
/// authenticated passthrough with a server-held upstream key. No request
/// rewriting, no task bookkeeping — the upstream owns the task lifecycle and
/// the caller polls it through this same wrapper.
#[toolkit::gear(name = "studio-spec-quality", capabilities = [rest])]
pub struct SpecQualityGear {
    state: OnceLock<Arc<ProxyState>>,
}

impl Default for SpecQualityGear {
    fn default() -> Self {
        Self {
            state: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for SpecQualityGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: SpecQualityConfig = ctx.config_or_default()?;
        let base_url = cfg.resolve_base_url();
        let api_key = cfg.resolve_api_key();
        if base_url.is_empty() || api_key.is_none() {
            warn!(
                base_url_set = !base_url.is_empty(),
                key_set = api_key.is_some(),
                "studio-spec-quality: upstream not (fully) configured — analysis calls will 500. \
                 Set STUDIO_SPEC_QUALITY_BASE_URL / STUDIO_SPEC_QUALITY_API_KEY (or the YAML equivalents)"
            );
        } else {
            info!(base_url = %base_url, "studio-spec-quality: configured");
        }

        // Submit/poll calls are short JSON round-trips (the upstream is async:
        // POST returns 202 immediately, results come from separate GET polls).
        // connect_timeout keeps a dead upstream from hanging the handler.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()?;

        let state = Arc::new(ProxyState {
            client,
            base_url,
            api_key,
        });
        self.state
            .set(state)
            .map_err(|_| anyhow::anyhow!("studio-spec-quality gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for SpecQualityGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-spec-quality not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, state))
    }
}
