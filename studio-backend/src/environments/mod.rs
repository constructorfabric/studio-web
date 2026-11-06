//! studio-environments — where an organization's products run (ADR-0043).
//!
//! An organization lists its **environments**: a Kubernetes cluster reached
//! through a `kubernetes` connection it holds, an image registry, a namespace
//! pattern, whether a deploy needs approval, and which projects may deploy
//! there. A project binds each of them to the `kubernetes` profile of its
//! product it runs there, one profile to any number of them (ADR-0057). A
//! **deploy** is a request to this gear: the server installs the generated
//! chart as a background run (ADR-0038) with the environment's connection, so
//! a member's machine never holds a cluster credential (ADR-0027). Every deploy
//! is a record, and a release's rollout is read back from its cluster on
//! demand.
//!
//! ## Where things are kept
//!
//! Account-management metadata, one row each: the environments and the
//! deployment records on the organization, the bindings on the project. The
//! first two are written by this gear alone, as the service, after its own
//! administrator check; the PDP refuses a write of them by anybody else
//! (`studio_authz_plugin::GEAR_HELD_METADATA`). The records are bounded
//! (`model::HISTORY`) and read per organization.
//!
//! Its own tables (`records`, ADR-0062) keep what is not bounded and must
//! not be a member's to write: each project's immutable slug, the namespace
//! it was given in each environment, and its image and chart records. Without
//! a database the gear stands down to what it did before: namespaces from the
//! pattern, paths from the project's name, and the image routes answer 503.
//!
//! ## What it does not do yet
//!
//! Databases and required configuration from the environment (ADR-0043 phase
//! 4) wait for the engine's chart to ask for them (constructorfabric/gearbox#8,
//! #9): an environment records its database mode, nothing hands it on. Images
//! are built and pushed before a deploy, by CI or by the desktop.

pub(crate) mod build; // a product built by Studio in the organization's cluster (ADR-0048 §9)
mod database;
mod deploy;
mod gear_overrides; // a configuration secret that sets a gear's field the description sets
mod image_tasks; // delete, copy (promote, import) and sweep of image records
pub(crate) mod images; // a project's images and charts as records (ADR-0062 §4)
pub(crate) mod images_sink; // a pipeline's published images, recorded (ADR-0062 §4)
pub(crate) mod infra; // a product's infra services, placed and installed with it (ADR-0064)
mod mcp;
pub(crate) use mcp::tools as mcp_tools;
mod migrations;
mod model;
mod placement; // a project's slug, namespaces and registry path (ADR-0062 §3, §7)
pub(crate) mod port; // what another gear asks of this one directly
mod preflight; // what a deploy checks before and while it installs
mod preview; // a build tried in a namespace of its own, removed when it expires (ADR-0055)
mod readiness;
mod realm; // the Keycloak realm a product's own Keycloak imports // what a build or a deploy checks before it is queued
mod records; // the gear's own tables (ADR-0062)
mod research; // building and running on Constructor Research (ADR-0049 §3, §4)
mod research_app; // a rendered chart as a Constructor Research application (ADR-0049 §4)
mod rest;
mod secret_needs; // the configuration secrets a product needs in an environment
mod service;
mod store;
mod workflow; // the build workflow proposed to a product's repository (ADR-0048)

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

/// The organization's environments.
pub const ENVIRONMENTS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.environment.list.v1~";
/// A project's profile bindings.
pub const BINDINGS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.environment.bindings.v1~";
/// The organization's deployment records.
pub const DEPLOYMENTS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.environment.deployments.v1~";

/// The documents this gear keeps as domain objects, each record of their
/// lists an object (ADR-0066 §8a, `storage.metadata`).
pub(crate) static MODEL_KINDS: &[crate::model_metadata::Kind] = {
    use crate::model_metadata::{Kind, Part};
    &[
        Kind {
            type_id: ENVIRONMENTS_METADATA_TYPE,
            gear: "studio-environments",
            parts: &[Part {
                field: "items",
                entity: "deployment-environment",
                name: "Deployment Environment",
                description: "A cluster namespace an organization deploys its products to.",
                key: &["id"],
            }],
        },
        Kind {
            type_id: BINDINGS_METADATA_TYPE,
            gear: "studio-environments",
            parts: &[
                Part {
                    field: "items",
                    entity: "environment-binding",
                    name: "Environment Binding",
                    description: "Which environment a project's deployment profile deploys to, with its values.",
                    key: &["profile", "environment_id"],
                },
                Part {
                    field: "secrets",
                    entity: "environment-config-secret",
                    name: "Environment Config Secret",
                    description: "A configuration secret a project sets for one environment; the value stays in credstore.",
                    key: &["environment_id", "key"],
                },
            ],
        },
        Kind {
            type_id: DEPLOYMENTS_METADATA_TYPE,
            gear: "studio-environments",
            parts: &[Part {
                field: "items",
                entity: "deployment",
                name: "Deployment",
                description: "One deploy of a project's build to an environment, and how it went.",
                key: &["id"],
            }],
        },
    ]
};

#[toolkit::gear(
    name = "studio-environments",
    deps = [account_management],
    capabilities = [db, rest]
)]
#[derive(Default)]
pub struct StudioEnvironmentsGear {
    /// The gear's own tables; `None` when no database is configured.
    records: OnceLock<Option<Arc<records::Records>>>,
}

impl DatabaseCapability for StudioEnvironmentsGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl Gear for StudioEnvironmentsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let records = match ctx.db_required() {
            Ok(db) => Some(Arc::new(records::Records::new(db.db()))),
            Err(e) => {
                warn!(
                    "studio-environments: no database configured -- namespaces follow the \
                     pattern, image paths the project's name, and the image routes answer 503 \
                     until a `database:` section is added: {e}"
                );
                None
            }
        };
        // The runs find the tables where every gear finds its clients.
        if let Some(r) = &records {
            ctx.client_hub().register::<records::Records>(Arc::clone(r));
        }
        let _ = self.records.set(records);
        // Deleting and copying images, and the retention sweep (ADR-0062 §4).
        crate::tasks::sdk::register(Arc::new(image_tasks::ImageTask::new(ctx.client_hub())))?;
        crate::tasks::sdk::register(Arc::new(image_tasks::SweepTask::new(ctx.client_hub())))?;
        crate::tasks::sdk::register(Arc::new(deploy::DeployTask::new(ctx.client_hub())))?;
        // A build in the organization's cluster, and the watch that records it (ADR-0048 §9).
        crate::tasks::sdk::register(Arc::new(build::BuildTask::new(ctx.client_hub())))?;
        crate::tasks::sdk::register(Arc::new(build::WatchTask::new(ctx.client_hub())))?;
        crate::tasks::sdk::register(Arc::new(research::ResearchBuildTask::new(ctx.client_hub())))?;
        // Previews removed when they expire, or when somebody asks (ADR-0055).
        crate::tasks::sdk::register(Arc::new(preview::SweepTask::new(ctx.client_hub())))?;
        info!("studio-environments: deploy runs registered");
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioEnvironmentsGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let am = ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()?;
        let access = crate::org_scope::OrgAccess(Arc::new(
            crate::studio_session::sdk::TenantMembership::new(Arc::clone(&am)),
        ));
        let service = Arc::new(service::EnvironmentService::new(
            store::Store::new(crate::model_metadata::client_for(ctx, am, MODEL_KINDS)),
            ctx.client_hub(),
        ));
        if let Some(records) = self.records.get().cloned().flatten() {
            service.set_records(records);
        }
        // A pipeline's manifest, read by studio-artifact-ingest, becomes image
        // records here too (ADR-0062 §4).
        images_sink::set(Arc::clone(&service));
        let router = rest::register_routes(router, openapi, service);
        // `?organization_id=` resolves through it; without it a request that
        // names an organization is refused rather than served from the
        // caller's home tenant.
        Ok(router.layer(axum::Extension(access)))
    }
}
