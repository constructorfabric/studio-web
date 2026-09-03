//! studio-gears-catalog — a connector to crates.io that catalogues "our gears".
//!
//! Lists every crate under a keyword (constructorfabric), pulls each crate's
//! detail and version history from the public crates.io API, and stores them in
//! the knowledge graph as typed `gear` and `crate_version` nodes joined by
//! `has_version`. The portal reads them back to show the gears and their
//! published versions. Prefers the real graph-storage gear; falls back to an
//! in-memory store so the catalog still works when the `graph` feature is off.

mod cratesio;
mod gts;
mod rest;
mod service;
mod tasks;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;
#[cfg(feature = "graph")]
use tracing::warn;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use service::CatalogService;

/// Default crates.io keyword to catalogue. Overridable via
/// `STUDIO_GEARS_CATALOG_KEYWORD`.
const DEFAULT_KEYWORD: &str = "constructorfabric";

#[toolkit::gear(
    name = "studio-gears-catalog",
    deps = [types_registry],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioGearsCatalogGear {
    service: std::sync::OnceLock<Arc<CatalogService>>,
}

#[async_trait]
impl Gear for StudioGearsCatalogGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Register the catalog GTS type schemas (idempotent). The graph store is
        // resolved later, in the REST phase, where every gear is initialized.
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(gts::type_schemas()).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-gears-catalog: types registered");
        Ok(())
    }
}

/// Resolve the catalog graph store. Prefers the real graph-storage gear (when
/// the `graph` feature is on and its client is published); otherwise the
/// in-memory fallback so the pipeline still runs.
fn build_sink(ctx: &GearCtx) -> Arc<dyn service::CatalogSink> {
    #[cfg(feature = "graph")]
    {
        match ctx
            .client_hub()
            .get::<dyn graph_storage_sdk::GraphStorageClientV1>()
        {
            Ok(client) => {
                info!("studio-gears-catalog: using the graph-storage gear as the catalog store");
                return Arc::new(service::GraphSink::new(client));
            }
            Err(e) => warn!(
                error = %e,
                "studio-gears-catalog: graph-storage client unavailable — using the in-memory store"
            ),
        }
    }
    let _ = ctx;
    Arc::new(service::MemorySink::default())
}

#[async_trait]
impl RestApiCapability for StudioGearsCatalogGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let keyword = std::env::var("STUDIO_GEARS_CATALOG_KEYWORD")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_KEYWORD.to_string());
        info!(keyword = %keyword, "studio-gears-catalog: cataloguing crates.io keyword");

        let sink = build_sink(ctx);
        let service = Arc::new(CatalogService::new(sink, keyword));
        let _ = self.service.set(service.clone());
        Ok(rest::register_routes(router, openapi, service))
    }
}
