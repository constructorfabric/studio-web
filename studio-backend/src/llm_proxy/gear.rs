use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientHub;
use toolkit::{Gear, GearCtx};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::config::LlmProxyConfig;
use super::keys::{ConnectorKeys, CredstoreProfile, PeopleKeys, ProfileKeys};
use super::port::ModelProviders;
use super::providers::Providers;
use super::rest;
use crate::connectors::sdk::Connectors;
use crate::studio_session::sdk::{TenantMembership, WorkspaceAccess};

/// Workspace membership, asked of account-management when a request names a
/// workspace. Resolved per use: Studio gears share one crate, so `deps` cannot
/// order this gear after account-management's client is published. No client
/// is no answer, and no answer is a refusal.
struct HubMembership(Arc<ClientHub>);

#[async_trait]
impl WorkspaceAccess for HubMembership {
    async fn may_reach(&self, ctx: &SecurityContext, workspace_id: Uuid) -> bool {
        match self
            .0
            .get::<dyn account_management_sdk::AccountManagementClient>()
        {
            Ok(am) => TenantMembership::new(am).may_reach(ctx, workspace_id).await,
            Err(_) => {
                warn!(
                    "studio-llm-proxy: no account-management client — a request naming a workspace is refused"
                );
                false
            }
        }
    }
}

/// Studio's one way out to a model provider (ADR-0039), and the IDE's way to
/// its agents' and chat's providers, each call on a person's key.
///
/// See the module docs (`super`) for the why; the how is deliberately dumb:
/// authenticated passthrough with the caller's key ([`super::keys`]). No model
/// policy beyond "the chat uses the provider's chat model" — that stays the
/// mini-chat/oagw chain's job.
///
/// Linked into every build, not only with the `llm` feature: it is the one way
/// out to a provider for the rest of Studio (ADR-0039), and needs nothing the
/// `llm` chain brings.
#[toolkit::gear(name = "studio-llm-proxy", deps = [credstore], capabilities = [rest])]
pub struct LlmProxyGear {
    providers: OnceLock<Arc<Providers>>,
}

impl Default for LlmProxyGear {
    fn default() -> Self {
        Self {
            providers: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for LlmProxyGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: LlmProxyConfig = ctx.config_or_default()?;

        // Long timeout: chat completions stream for minutes. connect_timeout
        // still keeps dead upstreams from hanging the handler.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()?;

        // A person's profile key lives in credstore; without one, only their
        // AI connections can answer (and those need credstore too).
        let profile: Option<Arc<dyn ProfileKeys>> = match ctx
            .client_hub()
            .get::<dyn credstore_sdk::CredStoreClientV1>(
        ) {
            Ok(credstore) => Some(Arc::new(CredstoreProfile(credstore))),
            Err(e) => {
                warn!("studio-llm-proxy: credstore unavailable ({e}); nobody has a profile key");
                None
            }
        };
        let keys = Arc::new(PeopleKeys {
            profile,
            connections: Arc::new(ConnectorKeys(Connectors::new(ctx.client_hub()))),
        });
        let chat: Vec<String> = cfg
            .providers
            .iter()
            .filter_map(|p| p.chat_model.as_ref().map(|m| format!("{}:{m}", p.name)))
            .collect();
        info!(chat = ?chat, "studio-llm-proxy: providers configured; every call goes out on the caller's key");

        let providers = Arc::new(Providers {
            client,
            list: cfg.providers.clone(),
            keys,
            access: Arc::new(HubMembership(ctx.client_hub())),
        });
        // Studio's one way out to a provider (ADR-0039): other gears reach one
        // through this client, with a key they hand it.
        ctx.client_hub()
            .register::<dyn ModelProviders>(providers.clone());
        self.providers
            .set(providers)
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
        let providers = self
            .providers
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-llm-proxy not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, providers))
    }
}
