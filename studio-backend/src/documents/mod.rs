//! studio-documents — document management gear.
//!
//! Document **types** are registered in the platform types-registry; each type
//! carries a template (markdown skeleton), a section checklist and structural
//! conformance rules ([`model`], [`validate`]). Documents are created at the
//! **workspace** level and inherited by projects: the storage scope is always
//! the workspace tenant, and a document's `project_id` column (NULL =
//! workspace-level) distinguishes project-owned from inherited — so inheritance
//! is a cheap column filter, not a cross-tenant read.
//!
//! Storage is the gear's own database (`toolkit_db`/sea-orm + migrations), the
//! same shape as `studio-credstore-pg`; the caller's access to a workspace or
//! project tenant is authorized through account-management, as `studio-kits`
//! does for its project routes.

mod classify;
mod entity;
pub(crate) mod gts;
pub(crate) mod intake;
mod migrations;
pub(crate) mod model;
mod paths;
pub(crate) mod port;
mod quality;
mod repo;
#[cfg(test)]
mod repo_tests;
mod rest;
mod review_guide;
pub mod sdk;
mod service;
mod spec_rows;
#[cfg(test)]
mod sync_analysis_tests;
mod validate;

use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::context::GearCtx;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit_db::DBProvider;
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use repo::DocumentsRepo;
use service::{DocumentsService, SyncAnalysis};

/// `gears.studio-documents.config`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct DocumentsConfig {
    /// Have Spec Quality analyse the documents a source sync found new or
    /// changed, recording the findings without anybody pressing a button.
    /// Does nothing while Spec Quality has no key.
    pub analyze_on_sync: bool,
    /// The most documents one sync has analysed.
    pub analyze_on_sync_max_documents: usize,
}

impl Default for DocumentsConfig {
    fn default() -> Self {
        Self {
            analyze_on_sync: true,
            analyze_on_sync_max_documents: 50,
        }
    }
}

/// Document management gear.
#[toolkit::gear(
    name = "studio-documents",
    deps = [account_management, types_registry],
    capabilities = [db, rest]
)]
#[derive(Default)]
pub struct StudioDocumentsGear {
    service: OnceLock<Arc<DocumentsService>>,
}

#[async_trait]
impl toolkit::Gear for StudioDocumentsGear {
    #[tracing::instrument(skip_all, fields(module = "studio-documents"))]
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Stand down (rather than fail the whole boot) when no database is
        // configured, the same shape studio-credstore-pg uses when its key is
        // absent: the gear stays inert and registers no routes, so a profile
        // that has not provisioned `studio_documents` still boots. Add a
        // `database:` section to the studio-documents gear config to enable it.
        let db_raw = match ctx.db_required() {
            Ok(db) => db,
            Err(e) => {
                warn!(
                    "studio-documents: no database configured — gear inert (no document routes). \
                     Add a `database:` section (server + dbname) to enable it: {e}"
                );
                return Ok(());
            }
        };
        let db = Arc::new(DBProvider::<anyhow::Error>::new(db_raw.db()));
        let repo = Arc::new(DocumentsRepo::new(db));

        let account_management = ctx.client_hub().get::<dyn AccountManagementClient>()?;

        // Register the document GTS types (the two base types plus the built-in
        // catalogue) for discovery. Best-effort: registration is not required for
        // the gear to function (it has its own storage), so a registry that is
        // unavailable or rejects a schema must not take the whole backend down.
        match ctx.client_hub().get::<dyn TypesRegistryClient>() {
            Ok(registry) => match registry.register(gts::type_schemas()).await {
                Ok(results) => {
                    if let Err(e) = RegisterResult::ensure_all_ok(&results) {
                        warn!("studio-documents: some document types were not registered: {e}");
                    }
                }
                Err(e) => warn!("studio-documents: type registration failed: {e}"),
            },
            Err(e) => {
                warn!("studio-documents: types-registry unavailable, skipping registration: {e}")
            }
        }

        let config: DocumentsConfig = ctx.config_or_default()?;
        let service = Arc::new(
            DocumentsService::new(repo, account_management).with_sync_analysis(
                config.analyze_on_sync.then(|| SyncAnalysis {
                    hub: ctx.client_hub(),
                    max_documents: config.analyze_on_sync_max_documents.max(1),
                }),
            ),
        );

        // Offer classification to whoever walks a repository. Registered here,
        // in `init`, so it is on the hub before any gear's REST phase resolves
        // it; a deployment without this gear's database never gets here, and
        // the consumer treats an absent client as "do not classify".
        ctx.client_hub()
            .register::<dyn port::DocumentClassifier>(service.clone());
        // The portfolio's document count, for whoever composes the rollup.
        ctx.client_hub()
            .register::<dyn port::DocumentCounter>(service.clone());
        // What each ingested file is called, for whoever lists what happened
        // to it. Registered beside the count and absent the same way.
        ctx.client_hub()
            .register::<dyn port::BindingNames>(service.clone());
        // Where a Spec Quality run records the gate verdicts it reads itself.
        ctx.client_hub()
            .register::<dyn port::AnalysisRecorder>(service.clone());
        // What a project's specifications need, for the spec-mapping gear.
        ctx.client_hub()
            .register::<dyn port::SpecNeeds>(service.clone());

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-documents already initialized"))?;
        info!("studio-documents: initialized");
        Ok(())
    }
}

impl DatabaseCapability for StudioDocumentsGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl RestApiCapability for StudioDocumentsGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // Inert when no database was configured (see `init`): return the router
        // unchanged rather than failing the boot.
        let Some(service) = self.service.get().cloned() else {
            warn!("studio-documents: not initialized (no database) — no routes registered");
            return Ok(router);
        };
        Ok(rest::register_routes(
            router,
            openapi,
            service,
            ctx.client_hub(),
        ))
    }
}
