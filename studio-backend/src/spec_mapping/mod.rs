//! studio-spec-mapping: from a project's specification to the gears that
//! build it.
//!
//! One place for every rule of that path (`cpt-studio-fr-spec-gear-mapping`,
//! `cpt-studio-fr-mapping-decisions`, `cpt-studio-fr-nfr-to-profile`):
//! - [`reading`]: what a specification needs, read as it is written;
//! - [`plan`]: which gears cover each need -- contract first, evidence second,
//!   gap last -- ranked by what members decided, and the deployment profile
//!   the non-functional statements point to;
//! - `rest`: the routes under `/studio-spec-mapping/v1`.
//!
//! The gear owns rules, not data. The documents gear keeps its index of what
//! each document needs, the components catalogue keeps the gears and what the
//! Gearbox engine says about them, and the artifact graph keeps the decisions;
//! each is read through the port its owner publishes. The design is
//! `docs/design/studio-spec-mapping.md`.

pub(crate) mod plan;
pub(crate) mod reading;
mod rest;
pub mod sdk;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};

#[toolkit::gear(name = "studio-spec-mapping", capabilities = [rest])]
#[derive(Default)]
pub struct SpecMappingGear;

#[async_trait]
impl Gear for SpecMappingGear {
    async fn init(&self, _ctx: &GearCtx) -> anyhow::Result<()> {
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for SpecMappingGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let router = rest::register_routes(router, openapi, rest::Ports::new(ctx.client_hub()));
        // The catalogue is kept per organization: a request that names one is
        // read there, as the catalogue's own routes are (`crate::org_scope`).
        Ok(
            match ctx
                .client_hub()
                .get::<dyn account_management_sdk::AccountManagementClient>()
            {
                Ok(am) => router.layer(axum::Extension(crate::org_scope::OrgAccess(Arc::new(
                    crate::studio_session::sdk::TenantMembership::new(am),
                )))),
                Err(_) => router,
            },
        )
    }
}
