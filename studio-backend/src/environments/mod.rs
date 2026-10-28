//! studio-environments — where an organization's products run (ADR-0043).
//!
//! An organization lists its **environments**: a Kubernetes cluster reached
//! through a `kubernetes` connection it holds, an image registry, a namespace
//! pattern, whether a deploy needs approval, and which projects may deploy
//! there. A project binds its product's `kubernetes` profiles to them. A
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
//! (`studio_authz_plugin::GEAR_HELD_METADATA`). No database of its own: the
//! records are bounded (`model::HISTORY`) and read per organization.
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
mod model;
mod rest;
mod service;
mod store;
mod workflow; // the build workflow proposed to a product's repository (ADR-0048)

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;

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
/// lists an object (ADR-0051 §8a, `storage.metadata`).
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
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioEnvironmentsGear;

#[async_trait]
impl Gear for StudioEnvironmentsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        crate::tasks::sdk::register(Arc::new(deploy::DeployTask::new(ctx.client_hub())))?;
        // A build in the organization's cluster, and the watch that records it (ADR-0048 §9).
        crate::tasks::sdk::register(Arc::new(build::BuildTask::new(ctx.client_hub())))?;
        crate::tasks::sdk::register(Arc::new(build::WatchTask::new(ctx.client_hub())))?;
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
        let router = rest::register_routes(router, openapi, service);
        // `?organization_id=` resolves through it; without it a request that
        // names an organization is refused rather than served from the
        // caller's home tenant.
        Ok(router.layer(axum::Extension(access)))
    }
}
