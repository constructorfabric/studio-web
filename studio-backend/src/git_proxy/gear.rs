use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};

use super::rest::{self, GitProxy};

/// The Git remote for desktop sessions (ADR-0027). See the module docs.
#[toolkit::gear(
    name = "studio-git",
    deps = [account_management, credstore, authn_resolver],
    capabilities = [rest]
)]
pub struct GitProxyGear {
    proxy: OnceLock<Arc<GitProxy>>,
}

impl Default for GitProxyGear {
    fn default() -> Self {
        Self {
            proxy: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for GitProxyGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let hub = ctx.client_hub();
        // All three are required: without the resolver nobody can be
        // authenticated, without account-management no source can be found,
        // and without credstore a private source cannot be reached. A gear that
        // cannot do its one job fails the boot rather than answering 500s.
        let authn = hub.get::<dyn authn_resolver_sdk::AuthNResolverClient>()?;
        let account_management =
            hub.get::<dyn account_management_sdk::AccountManagementClient>()?;
        let credstore = hub.get::<dyn credstore_sdk::CredStoreClientV1>()?;
        // No overall timeout: a clone of a large repository streams for as
        // long as it takes. The connect timeout keeps a dead host from hanging.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        // Only the catalogue is read, never a provider, so no driver is linked.
        let connectors = crate::connectors::service::ConnectorService::new(
            Arc::clone(&account_management),
            Arc::clone(&credstore),
            Vec::new(),
        );
        self.proxy
            .set(Arc::new(GitProxy {
                client,
                authn,
                account_management,
                credstore,
                connectors,
                hub: ctx.client_hub(),
            }))
            .map_err(|_| anyhow::anyhow!("studio-git gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for GitProxyGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let proxy = self
            .proxy
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-git not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, proxy))
    }
}
