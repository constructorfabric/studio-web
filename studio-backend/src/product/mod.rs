//! studio-product — what a project builds out of gears, and the engine that
//! checks it.
//!
//! A project's product is the gears picked for it, the deployment profile, and
//! what the Gearbox engine said when it resolved them. This gear keeps that
//! record and the repository it is written to, composes `product.gdl` and
//! asks the engine about it, writes a new gear's skeleton into the project's
//! repository, and relays the gear corpus to IDEs that cannot clone it
//! themselves.
//!
//! It was part of `studio-components-catalog` until it became a gear of its
//! own: the catalogue says what gears exist, the product says what a project
//! makes of them. The catalogue still reads the engine (what each gear's
//! `gear.gdl` says) and a project's gear repository, both through
//! [`port`].

mod description_edit;
mod descriptions;
mod explanations;
mod frontx;
mod gear_roots;
mod gearbox;
mod mcp;
pub(crate) use mcp::tools as mcp_tools;
mod migrations;
mod new_gear;
pub mod port;
mod project_roots;
mod rest;
mod save_guard;
mod scaffold;
pub mod sdk;
mod service;
mod skeleton;
pub mod sources_lock;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use service::ProductService;

/// The metadata row an organization's plain explanations of gears are kept
/// in. Only this gear writes it (`studio_authz_plugin::GEAR_HELD_METADATA`).
pub use explanations::EXPLANATIONS_METADATA_TYPE;

#[toolkit::gear(
    name = "studio-product",
    deps = [types_registry, account_management],
    capabilities = [db, rest]
)]
#[derive(Default)]
pub struct StudioProductGear {
    /// A product's description by revision (ADR-0053 §1); `None` when no
    /// database is configured, and the description routes answer 503.
    descriptions: OnceLock<Option<Arc<descriptions::DescriptionStore>>>,
}

impl DatabaseCapability for StudioProductGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl Gear for StudioProductGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // The descriptions stand down without a database, rather than the
        // whole gear: previews, writes and the corpus need none.
        let store = match ctx.db_required() {
            Ok(db) => Some(Arc::new(descriptions::DescriptionStore::new(db.db()))),
            Err(e) => {
                warn!(
                    "studio-product: no database configured — product descriptions are not \
                     kept by revision (their routes answer 503) until a `database:` section \
                     is added: {e}"
                );
                None
            }
        };
        let _ = self.descriptions.set(store);
        let storage = crate::model_metadata::storage_of(ctx);
        crate::data_places::note(
            "studio-product",
            "metadata",
            &crate::data_places::store_name(storage),
        );
        let _ = explanations::STORAGE.set(storage);
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry
            .register(crate::catalog_graph::gts::product_type_schemas())
            .await?;
        RegisterResult::ensure_all_ok(&results)?;

        // Published at init, so every gear finds it by the REST phase.
        if let Some(cfg) = gearbox::GearboxConfig::from_env() {
            info!(
                workdir = %cfg.workdir.display(),
                corpus = %cfg.corpus_url,
                corpus_ref = %cfg.corpus_ref,
                "studio-product: product previews through the Gearbox engine; the platform's gear repositories replace this corpus once connected"
            );
            let engine = Arc::new(gearbox::Gearbox::new(cfg));
            ctx.client_hub()
                .register::<gearbox::Gearbox>(Arc::clone(&engine));
            // Read the platform's gear repositories, check them out and run the
            // engine once at start -- in the background, so readiness does not
            // wait -- and the first preview or components reference does not
            // pay for a clone.
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                let connectors = crate::connectors::sdk::Connectors::new(ctx.client_hub());
                rt.spawn(async move {
                    gear_roots::warm_up(&engine, &connectors).await;
                });
            }
        }
        info!("studio-product: types registered");
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioProductGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let mut sink = crate::catalog_graph::build_sink(&ctx.client_hub(), "studio-product");
        // A project's gear repository and product as domain objects (ADR-0066
        // §8a, `storage.catalog`).
        let held = Arc::new(
            if crate::model_metadata::keeps_in_model(ctx, "studio-product", "catalog") {
                crate::catalog_graph::ModelSink::new(sink, ctx.client_hub(), "studio-product")
            } else {
                // Kept in the graph store: what the model holds moves back.
                crate::catalog_graph::ModelSink::returning(sink, ctx.client_hub(), "studio-product")
            },
        );
        crate::model_sweep::register(held.clone());
        sink = held;
        let connectors = crate::connectors::sdk::Connectors::new(ctx.client_hub());
        let service = Arc::new(ProductService::new(sink, connectors));
        if let Some(store) = self.descriptions.get().cloned().flatten() {
            service.set_descriptions(store);
        }

        // A project without a gear repository writes into its own sources,
        // which only its config names. The same client answers whether a
        // caller reaches the organization a request names.
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

        ctx.client_hub().register::<dyn port::ProjectProducts>(
            Arc::clone(&service) as Arc<dyn port::ProjectProducts>
        );
        // Writing into a project's repository the way it takes changes, for
        // the documents gear's domain model (docs/spec-domain-model.md).
        ctx.client_hub()
            .register::<dyn port::ProjectFiles>(
                Arc::new(port::Files::new(Arc::clone(&service))) as Arc<dyn port::ProjectFiles>
            );
        ctx.client_hub()
            .register::<dyn port::GearDeclarations>(Arc::new(port::Declarations::new(
                Arc::clone(&service),
                ctx.client_hub(),
            ))
                as Arc<dyn port::GearDeclarations>);
        // Publish: a gear given to the platform's gear repository (ADR-0042 §4).
        ctx.client_hub().register::<dyn port::GearContributions>(
            Arc::new(port::Contributions::new(Arc::clone(&service)))
                as Arc<dyn port::GearContributions>,
        );
        // "Create a gear" into the organization's gear repository, which the
        // catalogue's registry keeps (ADR-0042 §2).
        ctx.client_hub()
            .register::<dyn port::GearScaffolds>(Arc::new(port::Scaffolds::new(
                Arc::clone(&service),
                ctx.client_hub(),
            )) as Arc<dyn port::GearScaffolds>);

        let gearbox = port::engine(&ctx.client_hub());
        let router = rest::register_routes(router, openapi, service, ctx.client_hub(), gearbox);
        // The platform's gear repositories, read on the way in (ADR-0046).
        let router = port::with_gear_roots(router, &ctx.client_hub());
        // Without it, a request that names an organization is refused rather
        // than served from the caller's home tenant.
        Ok(match org_access {
            Some(access) => router.layer(axum::Extension(access)),
            None => router,
        })
    }
}
