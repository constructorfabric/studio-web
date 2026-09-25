use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use super::config::LlmProxyConfig;
use super::providers::{CredstoreKeys, Providers};
use super::rest::{self, ProxyState};

/// OpenAI-compatible LLM proxy for Theia AI inside IDE sessions.
///
/// See the module docs (`super`) for the why; the how is deliberately dumb:
/// authenticated passthrough with a server-held upstream key. No request
/// rewriting, no model policy — that stays the mini-chat/oagw chain's job.
#[toolkit::gear(name = "studio-llm-proxy", deps = [credstore], capabilities = [rest])]
pub struct LlmProxyGear {
    state: OnceLock<Arc<ProxyState>>,
    /// `None` when there is no credstore to ask for the caller's key: the
    /// provider routes are then not mounted at all.
    providers: OnceLock<Option<Arc<Providers>>>,
}

impl Default for LlmProxyGear {
    fn default() -> Self {
        Self {
            state: OnceLock::new(),
            providers: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for LlmProxyGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: LlmProxyConfig = ctx.config_or_default()?;
        let api_key = cfg.resolve_api_key();
        let base_url = cfg.resolve_base_url();
        let model = cfg.resolve_model();
        if base_url.is_empty() || model.is_empty() || api_key.is_none() {
            warn!(
                base_url_set = !base_url.is_empty(),
                model_set = !model.is_empty(),
                key_set = api_key.is_some(),
                "studio-llm-proxy: upstream not (fully) configured — in-IDE AI stays off. \
                 Set STUDIO_LLM_BASE_URL / STUDIO_LLM_MODEL / STUDIO_LLM_API_KEY (or the YAML equivalents)"
            );
        } else {
            info!(base_url = %base_url, model = %model, "studio-llm-proxy: configured");
        }

        // Long timeout: chat completions stream for minutes. connect_timeout
        // still keeps dead upstreams from hanging the handler.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()?;

        // The agents' own APIs, each call on the caller's key (ADR-0030).
        let providers = match ctx
            .client_hub()
            .get::<dyn credstore_sdk::CredStoreClientV1>()
        {
            Ok(credstore) => Some(Arc::new(Providers {
                client: client.clone(),
                list: cfg.providers.clone(),
                keys: Arc::new(CredstoreKeys(credstore)),
            })),
            Err(e) => {
                warn!(
                    "studio-llm-proxy: credstore unavailable ({e}); agents get no provider passthrough"
                );
                None
            }
        };
        let _ = self.providers.set(providers);

        let state = Arc::new(ProxyState {
            client,
            base_url,
            api_key,
            model,
            developer_message_settings: cfg.developer_message_settings.clone(),
        });
        self.state
            .set(state)
            .map_err(|_| anyhow::anyhow!("studio-llm-proxy gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for LlmProxyGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-llm-proxy not initialized"))?
            .clone();
        let providers = self.providers.get().cloned().flatten();
        Ok(rest::register_routes(router, openapi, state, providers))
    }
}
