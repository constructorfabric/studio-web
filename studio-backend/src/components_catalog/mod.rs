//! studio-components-catalog — a connector to crates.io that catalogues "our gears".
//!
//! Lists every crate under a keyword (constructorfabric), pulls each crate's
//! detail and version history from the public crates.io API, and stores them in
//! the knowledge graph as typed `gear` and `crate_version` nodes joined by
//! `has_version`. The portal reads them back to show the gears and their
//! published versions. Prefers the real graph-storage gear; falls back to an
//! in-memory store so the catalog still works when the `graph` feature is off.

mod activity;
mod compose;
mod cratesio;
pub(crate) mod field_schema;
mod gearbox;
pub(crate) mod gts;
mod history;
pub mod port;
mod quality;
pub(crate) mod reference;
mod repo_enrich;
mod repo_facts;
mod rest;
pub(crate) mod roadmap;
mod scaffold;
mod service;
mod skeleton;
mod sync_task;
mod taxonomy;
mod values;

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
                info!(
                    "studio-components-catalog: using the graph-storage gear as the catalog store"
                );
                return Arc::new(service::GraphSink::new(client));
            }
            Err(e) => warn!(
                error = %e,
                "studio-components-catalog: graph-storage client unavailable — using the in-memory store"
            ),
        }
    }
    let _ = ctx;
    Arc::new(service::MemorySink::default())
}

/// Build the repository enricher when a GitHub connector is linked and the
/// catalogue tenant is configured (see [`repo_enrich`]). Best-effort: any
/// missing piece disables enrichment, leaving a crates.io-only catalogue.
pub(crate) fn build_connectors(
    ctx: &GearCtx,
) -> Option<Arc<crate::connectors::service::ConnectorService>> {
    use crate::connectors::driver::ConnectorDriver;
    let mut drivers: Vec<(String, Arc<dyn ConnectorDriver>)> = Vec::new();
    for id in crate::connectors::source_driver_ids() {
        if let Ok(d) = ctx
            .client_hub()
            .get_scoped::<dyn ConnectorDriver>(&toolkit::client_hub::ClientScope::gts_id(id))
        {
            drivers.push((id.to_string(), d));
        }
    }
    if drivers.is_empty() {
        return None;
    }
    let am = ctx
        .client_hub()
        .get::<dyn account_management_sdk::AccountManagementClient>()
        .ok()?;
    let credstore = ctx
        .client_hub()
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .ok()?;
    Some(crate::connectors::service::ConnectorService::new(
        am, credstore, drivers,
    ))
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

        let sink = build_sink(ctx);
        let connectors = build_connectors(ctx);
        let service = Arc::new(CatalogService::new(sink, keyword, connectors));

        // A sync is a `catalog.sync` run on studio-tasks — durable,
        // cancellable, retried with backoff. Registered here because the
        // service it needs is built here, and refused loudly if something else
        // has claimed the task type.
        crate::tasks::registry::register(Arc::new(sync_task::CatalogSyncTask::new(Arc::clone(
            &service,
        ))))?;

        let gearbox = gearbox::GearboxConfig::from_env().map(|cfg| {
            info!(
                workdir = %cfg.workdir.display(),
                corpus = %cfg.corpus_url,
                corpus_ref = %cfg.corpus_ref,
                "studio-components-catalog: product previews through the Gearbox engine"
            );
            Arc::new(gearbox::Gearbox::new(cfg))
        });
        if let Some(g) = &gearbox {
            service.set_gearbox(Arc::clone(g));
            // Check the corpus out and run the engine once at start, so the
            // first components reference does not pay for a clone.
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                let g = Arc::clone(g);
                rt.spawn(async move {
                    if let Err(e) = g.catalogue_json().await {
                        tracing::warn!(error = %format!("{e:#}"), "studio-components-catalog: corpus warm-up failed");
                    }
                });
            }
        }
        // A project without a gear repository is compared against its own
        // sources, which only its config names. The same client answers
        // whether a caller reaches the organization a request names.
        let mut org_access = None;
        if let Ok(am) = ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()
        {
            org_access = Some(crate::org_scope::OrgAccess(Arc::new(
                crate::studio_session::access::TenantMembership::new(Arc::clone(&am)),
            )));
            service.set_account_management(am);
        }

        // What the reports gear reads the roadmap through (`port.rs`).
        ctx.client_hub()
            .register::<dyn port::RoadmapCatalog>(Arc::new(port::CatalogRoadmaps::new(
                Arc::clone(&service),
                ctx.client_hub(),
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
