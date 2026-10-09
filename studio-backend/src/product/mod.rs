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

mod gearbox;
mod new_gear;
pub mod port;
mod rest;
mod scaffold;
pub mod sdk;
mod service;
mod skeleton;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use service::ProductService;

#[toolkit::gear(
    name = "studio-product",
    deps = [types_registry, account_management],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioProductGear;

#[async_trait]
impl Gear for StudioProductGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
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
                "studio-product: product previews through the Gearbox engine"
            );
            let engine = Arc::new(gearbox::Gearbox::new(cfg));
            ctx.client_hub()
                .register::<gearbox::Gearbox>(Arc::clone(&engine));
            // Check the corpus out and run the engine once at start, so the
            // first preview or components reference does not pay for a clone.
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    if let Err(e) = engine.catalogue_json().await {
                        tracing::warn!(error = %format!("{e:#}"), "studio-product: corpus warm-up failed");
                    }
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
        let sink = crate::catalog_graph::build_sink(&ctx.client_hub(), "studio-product");
        let connectors = crate::connectors::sdk::Connectors::new(ctx.client_hub());
        let service = Arc::new(ProductService::new(sink, connectors));

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
        // Without it, a request that names an organization is refused rather
        // than served from the caller's home tenant.
        Ok(match org_access {
            Some(access) => router.layer(axum::Extension(access)),
            None => router,
        })
    }
}
