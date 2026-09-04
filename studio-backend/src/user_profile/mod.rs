//! studio-user — the canonical user, its sign-in methods, and the identity
//! mapper.
//!
//! Keycloak authenticates; this gear owns *who the person is*. It keeps a
//! Studio-owned `user` entity (the profile, role-free) to which multiple
//! sign-in methods (`login`) and non-login identifiers (`alias`) bind, and it
//! maps a token subject onto that canonical user id. All identity nodes live in
//! one shared partition (the platform root tenant) so a person is one entity
//! across every organization. Prefers the real graph-storage gear; falls back
//! to an in-memory store so the mapper still works when the `graph` feature is
//! off.
//!
//! Role deliberately lives in organization membership (tenant grants), never in
//! the profile: the same person can hold different roles in different orgs.

mod gts;
mod rest;
mod service;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;
#[cfg(feature = "graph")]
use tracing::warn;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use service::IdentityService;

#[toolkit::gear(
    name = "studio-user",
    deps = [types_registry],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioUserGear {
    service: OnceLock<Arc<IdentityService>>,
}

#[async_trait]
impl Gear for StudioUserGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Register the identity GTS type schemas (idempotent). The graph store
        // is resolved later, in the REST phase, where every gear is initialized.
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(gts::type_schemas()).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-user: identity types registered");
        Ok(())
    }
}

/// Resolve the identity graph store. Prefers the real graph-storage gear (when
/// the `graph` feature is on and its client is published); otherwise the
/// in-memory fallback so the mapper still runs.
fn build_sink(ctx: &GearCtx) -> Arc<dyn service::IdentitySink> {
    #[cfg(feature = "graph")]
    {
        match ctx
            .client_hub()
            .get::<dyn crate::graph_storage::sdk::GraphStorageClientV1>()
        {
            Ok(client) => {
                info!("studio-user: using the graph-storage gear as the identity store");
                return Arc::new(service::GraphSink::new(client));
            }
            Err(e) => warn!(
                error = %e,
                "studio-user: graph-storage client unavailable — using the in-memory store"
            ),
        }
    }
    let _ = ctx;
    Arc::new(service::MemorySink::default())
}

#[async_trait]
impl RestApiCapability for StudioUserGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let sink = build_sink(ctx);
        let service = Arc::new(IdentityService::new(sink));
        let _ = self.service.set(service.clone());
        Ok(rest::register_routes(router, openapi, service))
    }
}
