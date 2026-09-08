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

mod entity;
pub(crate) mod gts;
mod migrations;
mod model;
mod repo;
mod rest;
mod service;
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
use service::DocumentsService;

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

        let service = Arc::new(DocumentsService::new(repo, account_management));
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
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // Inert when no database was configured (see `init`): return the router
        // unchanged rather than failing the boot.
        let Some(service) = self.service.get().cloned() else {
            warn!("studio-documents: not initialized (no database) — no routes registered");
            return Ok(router);
        };
        Ok(rest::register_routes(router, openapi, service))
    }
}
