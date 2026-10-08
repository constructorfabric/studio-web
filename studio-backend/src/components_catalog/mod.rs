//! studio-components-catalog — a connector to crates.io that catalogues "our gears".
//!
//! Lists every crate under a keyword (constructorfabric), pulls each crate's
//! detail and version history from the public crates.io API, and stores them in
//! the knowledge graph as typed `gear` and `crate_version` nodes joined by
//! `has_version`. The portal reads them back to show the gears and their
//! published versions. Prefers the real graph-storage gear; falls back to an
//! in-memory store so the catalog still works when the `graph` feature is off.

mod activity;
mod cratesio;
pub(crate) mod field_schema;
mod history;
pub mod port;
mod quality;
pub(crate) mod reference;
mod repo_enrich;
mod repo_facts;
mod rest;
pub(crate) mod roadmap;
pub mod sdk;
mod service;
mod sync_task;
mod taxonomy;
pub(crate) mod values;

/// The catalogue's node vocabulary lives beside the store it is written to.
pub(crate) use crate::catalog_graph::gts;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use service::CatalogService;

/// Default crates.io keyword to catalogue. Overridable via
/// `STUDIO_COMPONENTS_CATALOG_KEYWORD`.
const DEFAULT_KEYWORD: &str = "constructorfabric";

#[toolkit::gear(
    name = "studio-components-catalog",
    deps = [types_registry, account_management, credstore],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioComponentsCatalogGear {
    service: std::sync::OnceLock<Arc<CatalogService>>,
}

#[async_trait]
impl Gear for StudioComponentsCatalogGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Register the catalog GTS type schemas (idempotent). The graph store is
        // resolved later, in the REST phase, where every gear is initialized.
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(gts::type_schemas()).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-components-catalog: types registered");
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioComponentsCatalogGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let keyword = std::env::var("STUDIO_COMPONENTS_CATALOG_KEYWORD")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_KEYWORD.to_string());
        info!(keyword = %keyword, "studio-components-catalog: cataloguing crates.io keyword");

        let sink = crate::catalog_graph::build_sink(
            ctx.client_hub().as_ref(),
            "studio-components-catalog",
        );
        // The one connector service, resolved when a sync needs it: without a
        // GitHub connector the catalogue is crates.io only.
        let connectors = Some(crate::connectors::sdk::Connectors::new(ctx.client_hub()));
        let service = Arc::new(CatalogService::new(sink, keyword, connectors));

        // A sync is a `catalog.sync` run on studio-tasks — durable,
        // cancellable, retried with backoff. Registered here because the
        // service it needs is built here, and refused loudly if something else
        // has claimed the task type.
        crate::tasks::sdk::register(Arc::new(sync_task::CatalogSyncTask::new(Arc::clone(
            &service,
        ))))?;

        // The Gearbox engine is studio-product's; the catalogue reads what it
        // says about each gear, and a sync follows the gears repository with
        // it. Every gear's `init` has run by now, so it is published if it
        // is configured at all.
        let gearbox = crate::product::port::engine(&ctx.client_hub());
        if let Some(g) = &gearbox {
            service.set_gearbox(Arc::clone(g));
        }
        service.set_products(crate::product::port::Products::new(ctx.client_hub()));
        // A project without a gear repository is compared against its own
        // sources, which only its config names. The same client answers
        // whether a caller reaches the organization a request names.
        let mut org_access = None;
        if let Ok(am) = ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()
        {
            org_access = Some(crate::org_scope::OrgAccess(Arc::new(
                crate::studio_session::sdk::TenantMembership::new(Arc::clone(&am)),
            )));
            service.set_account_management(am);
        }

        // What the reports gear reads the roadmap through (`port.rs`).
        ctx.client_hub()
            .register::<dyn port::RoadmapCatalog>(Arc::new(port::CatalogRoadmaps::new(
                Arc::clone(&service),
                ctx.client_hub(),
            )));
        // What the spec-mapping gear matches a specification against.
        ctx.client_hub()
            .register::<dyn port::ComponentCatalog>(Arc::new(port::CatalogComponents::new(
                Arc::clone(&service),
                gearbox.clone(),
            )));

        let _ = self.service.set(service.clone());
        let router = rest::register_routes(router, openapi, service, ctx.client_hub(), gearbox);
        // Without it, a request that names an organization is refused rather
        // than served from the caller's home tenant.
        Ok(match org_access {
            Some(access) => router.layer(axum::Extension(access)),
            None => router,
        })
    }
}
