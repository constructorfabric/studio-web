//! Constructor Studio kit registry.
//!
//! The first vertical slice deliberately keeps kit bytes in their canonical
//! Git repositories. This gear owns catalogue metadata and project-scoped
//! desired installations; `cfs` remains the only component that materializes
//! kit files into a checkout.

mod rest;
pub(crate) mod service;

use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};

use service::KitRegistryService;

#[toolkit::gear(
    name = "studio-kits",
    deps = [account_management],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioKitsGear {
    service: OnceLock<Arc<KitRegistryService>>,
}

#[async_trait]
impl Gear for StudioKitsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let account_management = ctx.client_hub().get::<dyn AccountManagementClient>()?;
        self.service
            .set(Arc::new(KitRegistryService::new(
                account_management,
                ctx.client_hub(),
            )))
            .map_err(|_| anyhow::anyhow!("studio-kits already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioKitsGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self
            .service
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-kits not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, service))
    }
}
