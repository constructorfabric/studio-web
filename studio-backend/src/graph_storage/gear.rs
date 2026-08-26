//! Composition root: wires configuration, services and adapters together.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use toolkit::api::OpenApiRegistry;
use toolkit::{DatabaseCapability, Gear, GearCtx, RestApiCapability};
use toolkit_db::{DBProvider, DbError};
use tracing::{debug, info};

use crate::graph_storage::sdk::GraphStorageClientV1;

use crate::graph_storage::api::rest::routes;
use crate::graph_storage::config::GraphStorageConfig;
use crate::graph_storage::domain::local_client::GraphStorageLocalClient;
use crate::graph_storage::domain::service::GraphServices;

/// The graph-storage gear.
#[toolkit::gear(name = "graph-storage", capabilities = [db, rest])]
pub struct GraphStorage {
    services: OnceLock<Arc<GraphServices>>,
}

impl Default for GraphStorage {
    fn default() -> Self {
        Self {
            services: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for GraphStorage {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: GraphStorageConfig = ctx.config_or_default()?;
        debug!(
            ingest_max_nodes = cfg.ingest_max_nodes,
            traversal_max_depth = cfg.traversal_max_depth,
            "loaded graph-storage config"
        );

        // Acquiring the database capability is what makes the platform run
        // this gear's migrations before the REST phase.
        let db: Arc<DBProvider<DbError>> = Arc::new(ctx.db_required()?);

        let services = Arc::new(GraphServices::new(cfg, db));

        self.services
            .set(services.clone())
            .map_err(|_| anyhow::anyhow!("{} gear already initialized", Self::MODULE_NAME))?;

        // Publish the in-process client so other gears can consume the graph
        // without going through HTTP.
        ctx.client_hub()
            .register::<dyn GraphStorageClientV1>(Arc::new(GraphStorageLocalClient::new(services)));

        info!("graph-storage gear initialized");
        Ok(())
    }
}

impl DatabaseCapability for GraphStorage {
    fn migrations(&self) -> Vec<Box<dyn sea_orm_migration::MigrationTrait>> {
        use sea_orm_migration::MigratorTrait;
        crate::graph_storage::infra::storage::migrations::Migrator::migrations()
    }
}

impl RestApiCapability for GraphStorage {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: axum::Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<axum::Router> {
        let services = self
            .services
            .get()
            .ok_or_else(|| anyhow::anyhow!("graph-storage services not initialized"))?
            .clone();

        Ok(routes::register_routes(router, openapi, services))
    }
}
