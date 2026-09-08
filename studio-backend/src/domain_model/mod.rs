//! studio-domain-model — store the Studio domain model as GTS types in Graph
//! Storage, create objects of those types, extend the types, and read the
//! model back so the frontend can be regenerated from it.
//!
//! The domain model is embedded from `studio-internal/domain-model-ui` (the
//! full core model + system bases — 11 buckets, 140 entities). Each entity is registered
//! as a GTS node type derived from the graph-storage `owned_node` family, and
//! each relation kind as an endpoint-typed edge type derived from `static_edge`;
//! objects are typed nodes keyed on a deterministic instance id. Prefers the
//! real graph-storage gear; falls back to an in-memory store so the create/read
//! loop still runs when the `graph` feature is off.
//!
//! Why the graph-storage families and not the tenant-metadata envelope: the
//! latter is closed by OP#12 narrowing, so a derived type cannot declare payload
//! fields (see `docs/gears-rust-issues.md` §4). The graph-storage families are
//! open, which is what makes goal #2 — extending a type with a new field —
//! a pure ontology edit rather than a schema migration.

pub(crate) mod gts;
pub(crate) mod ontology;
mod rest;
mod service;
mod store;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;
#[cfg(feature = "graph")]
use tracing::warn;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use ontology::Ontology;
use service::DomainModelService;
use store::{DomainStore, InMemoryDomainStore};

#[toolkit::gear(
    name = "studio-domain-model",
    deps = [types_registry],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioDomainModelGear {
    service: std::sync::OnceLock<Arc<DomainModelService>>,
}

#[async_trait]
impl Gear for StudioDomainModelGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Catalog the domain types in the platform types-registry (free-form
        // schemas — the same shape studio's other types use, so registration
        // never trips the closed-envelope narrowing check). The graph-storage
        // registration (derived schemas) happens in the REST phase, where the
        // graph-storage client is available. Idempotent — same documents every
        // boot.
        let ontology = Ontology::load();
        let mut schemas: Vec<serde_json::Value> = Vec::new();
        for nt in ontology.node_types() {
            schemas.push(gts::catalog_schema(&nt.type_id, &nt.title, &nt.description));
        }
        for et in ontology.edge_types() {
            schemas.push(gts::catalog_schema(
                &et.type_id,
                &et.relation_kind,
                gts::EDGE_CATALOG_DESCRIPTION,
            ));
        }
        // The meta layer (object_type + inherits/declares) is registered in
        // graph-storage by the store; catalog it here as well so the platform
        // registry knows every type this gear can put in the graph.
        for (id, title, description) in gts::META_CATALOG_DOCS {
            schemas.push(gts::catalog_schema(id, title, description));
        }
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(schemas).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-domain-model: domain types cataloged in the types-registry");
        Ok(())
    }
}

/// Resolve the object store. Prefers the real graph-storage gear (when the
/// `graph` feature is on and its client is published); otherwise the in-memory
/// fallback so create/read still works.
fn build_store(ctx: &GearCtx) -> Arc<dyn DomainStore> {
    #[cfg(feature = "graph")]
    {
        match ctx
            .client_hub()
            .get::<dyn graph_storage_sdk::GraphStorageClientV1>()
        {
            Ok(client) => {
                info!("studio-domain-model: using the graph-storage gear as the object store");
                return Arc::new(store::GraphStorageBackend::new(client));
            }
            Err(e) => warn!(
                error = %e,
                "studio-domain-model: graph-storage client unavailable — using the in-memory store"
            ),
        }
    }
    let _ = ctx;
    Arc::new(InMemoryDomainStore::default())
}

#[async_trait]
impl RestApiCapability for StudioDomainModelGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let store = build_store(ctx);
        let service = Arc::new(DomainModelService::new(store));
        let _ = self.service.set(service.clone());
        Ok(rest::register_routes(router, openapi, service))
    }
}
