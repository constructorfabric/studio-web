//! studio-organizations — a person creates an organization and owns it.
//!
//! The first of ADR-0018's follow-ups. Before it, organizations were created by
//! the browser calling account-management's `createTenant` directly, which
//! cannot do this job: an organization needs a tenant *and* an owner, and a
//! client that writes only the first produces one nobody owns and nobody sees.
//!
//! The gear owns no storage. It composes: account-management holds the tenant,
//! `studio-user` holds the membership that makes somebody its owner, and the
//! tenant's access config holds the grant the Studio PDP reads. What it adds is
//! that those three are written by one operation, in an order that can be
//! resumed (see `service`).

mod rest;
mod service;

use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::warn;
use uuid::Uuid;

use service::OrganizationService;

/// The tenant new organizations are created under.
///
/// The platform root, the same constant the rest of the assembly uses for it.
const PLATFORM_ROOT_TENANT_ID: Uuid = Uuid::from_u128(1);

#[toolkit::gear(
    name = "studio-organizations",
    deps = [account_management],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioOrganizationsGear {
    service: OnceLock<Option<Arc<OrganizationService>>>,
}

#[async_trait]
impl Gear for StudioOrganizationsGear {
    async fn init(&self, _ctx: &GearCtx) -> anyhow::Result<()> {
        // Nothing to do here: everything this gear needs comes from other gears,
        // and the REST phase is the first point at which they have all
        // initialized.
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioOrganizationsGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = build_service(ctx);
        let _ = self.service.set(service.clone());
        Ok(rest::register_routes(router, openapi, service))
    }
}

/// Both halves, or nothing.
///
/// Without `studio-user` there is nowhere to record who owns the new
/// organization, and creating a tenant anyway would produce exactly the
/// ownerless organization this gear exists to prevent — so the route answers
/// 503 instead.
fn build_service(ctx: &GearCtx) -> Option<Arc<OrganizationService>> {
    let am = ctx
        .client_hub()
        .get::<dyn AccountManagementClient>()
        .inspect_err(|_| warn!("studio-organizations: account-management is not available"))
        .ok()?;
    let memberships = ctx
        .client_hub()
        .get_scoped::<dyn crate::user_profile::AssignmentRecorder>(&ClientScope::gts_id(
            crate::user_profile::IDENTITY_INSTANCE_ID,
        ))
        .inspect_err(|_| {
            warn!(
                "studio-organizations: studio-user is not available — organization creation \
                 answers 503 rather than creating one nobody owns"
            );
        })
        .ok()?;
    Some(Arc::new(OrganizationService::new(
        am,
        memberships,
        PLATFORM_ROOT_TENANT_ID,
    )))
}
