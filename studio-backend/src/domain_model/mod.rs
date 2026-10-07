//! studio-domain-model — store the Studio domain model as GTS types in Graph
//! Storage, create objects of those types, extend the types, and read the
//! model back so the frontend can be regenerated from it.
//!
//! Graph Storage is the model's system of record: the document embedded from
//! `studio-internal/domain-model-ui` (the full core model + system bases — 11
//! buckets, 140 entities) is the bootstrap seed a tenant runs until the graph
//! holds a model of its own, and every edit is stored. So the model is per
//! tenant, and it survives the process that changed it. Every edit is a
//! numbered version carrying the patch that made it and its inverse, so the
//! model has a history that can be read, audited and reverted.
//!
//! Each entity is registered
//! as a GTS node type derived from the graph-storage `owned_node` family, and
//! each relation kind as an edge type derived from `static_edge` — carrying
//! which declared relation it is, checked against the model's own source and
//! target before it is written;
//! objects are typed nodes keyed on a deterministic instance id, checked on the
//! way in against the type the model says they are — bases included, since that
//! is where most of a type's fields live. Prefers the
//! real graph-storage gear; falls back to an in-memory store so the create/read
//! loop still runs when the `graph` feature is off.
//!
//! Why the graph-storage families and not the tenant-metadata envelope: the
//! latter is closed by OP#12 narrowing, so a derived type cannot declare payload
//! fields (see `docs/upstream/gears-rust-issues.md` §4). The graph-storage families are
//! open, which is what makes goal #2 — extending a type with a new field —
//! a pure ontology edit rather than a schema migration.

mod access;
pub(crate) mod gts;
pub(crate) mod ontology;
pub mod port;
mod query;
mod rest;
mod service;
mod store;
pub(crate) mod validate;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

pub(crate) use access::DOMAIN_OBJECT_RESOURCE;
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

/// Who may read and write objects (ADR-0035): the PDP, through the platform
/// enforcer, with tenant hierarchy declared so a project-scoped grant can name
/// a project inside the organization. Without an authz resolver there is no
/// policy to ask, and the gear keeps the tenant-only behaviour it had.
fn build_policy(ctx: &GearCtx) -> Arc<dyn access::ObjectPolicy> {
    let authz = match ctx
        .client_hub()
        .get::<dyn authz_resolver_sdk::AuthZResolverApi>()
    {
        Ok(authz) => authz,
        Err(e) => {
            warn!(error = %e, "studio-domain-model: no authz resolver — objects are tenant-scoped only");
            return Arc::new(access::TenantOnly);
        }
    };
    let am = match ctx
        .client_hub()
        .get::<dyn account_management_sdk::AccountManagementClient>()
    {
        Ok(am) => am,
        Err(e) => {
            // The tree cannot be read, so no project can be shown to sit in the
            // organization: project-scoped grants then admit nothing, which
            // fails closed rather than open.
            warn!(error = %e, "studio-domain-model: no account-management client — project grants admit nothing");
            return Arc::new(access::PdpPolicy::new(enforcer(authz), Arc::new(NoTree)));
        }
    };
    Arc::new(access::PdpPolicy::new(
        enforcer(authz),
        Arc::new(AmTenants(am)),
    ))
}

fn enforcer(
    authz: Arc<dyn authz_resolver_sdk::AuthZResolverApi>,
) -> authz_resolver_sdk::PolicyEnforcer {
    authz_resolver_sdk::PolicyEnforcer::new(authz)
        .with_capabilities(vec![authz_resolver_sdk::Capability::TenantHierarchy])
}

/// A tenant's parent, from account-management. A tenant the caller cannot
/// read has no parent here, which can only exclude.
struct AmTenants(Arc<dyn account_management_sdk::AccountManagementClient>);

#[async_trait]
impl access::TenantParents for AmTenants {
    async fn parent_of(
        &self,
        ctx: &toolkit_security::SecurityContext,
        tenant: uuid::Uuid,
    ) -> Option<uuid::Uuid> {
        self.0
            .get_tenant(ctx, tenant)
            .await
            .ok()
            .and_then(|t| t.parent_id)
            .map(|p| p.0)
    }
}

struct NoTree;

#[async_trait]
impl access::TenantParents for NoTree {
    async fn parent_of(
        &self,
        _ctx: &toolkit_security::SecurityContext,
        _tenant: uuid::Uuid,
    ) -> Option<uuid::Uuid> {
        None
    }
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
        let service = Arc::new(DomainModelService::new(store).with_policy(build_policy(ctx)));
        let _ = self.service.set(service.clone());
        // What another gear writes and reads objects through (`port.rs`): the
        // same path as the REST routes, under its caller's context.
        ctx.client_hub()
            .register::<dyn port::DomainObjects>(Arc::new(port::Objects(service.clone())));
        // Who may change the model (ADR-0035 §1). studio-user publishes it in
        // its `init`, which runs before any gear's REST phase. Absent, nobody
        // can be shown to hold the authority, and model edits are refused.
        let authority = ctx
            .client_hub()
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
            .inspect_err(|e| {
                warn!(
                    error = %e,
                    "studio-domain-model: studio-user is not available — changing the model is refused"
                );
            })
            .ok();
        Ok(rest::register_routes(router, openapi, service, authority))
    }
}
