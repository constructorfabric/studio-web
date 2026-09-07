//! studio-identity — self-service identity resolution (ADR-0012).
//!
//! ## What it owns
//!
//! One append-only journal of assertions about external accounts:
//! `(provider, account) ← subject`, each row carrying how strong it is. Only a
//! **proof of control** binds; a system-found similarity and a bare human claim
//! are proposals that attribute nothing. The whole policy is thirty lines in
//! [`resolve`], and every other module in here is loading rows for it or
//! rendering what it returns.
//!
//! ## Why not the neighbouring product's implementation
//!
//! Insight's identity service solves the same shape with an operator as the root
//! of trust — an e-mail match binds, because a human curates the result. Studio
//! has no such operator: only the person knows which GitLab account is theirs,
//! and a commit author address is unauthenticated text anybody can set. So the
//! journal and the derive-don't-store habit are taken; the matching rules are
//! inverted. ADR-0012 lists the split line by line.
//!
//! ## Where the proof comes from
//!
//! It already existed. `ConnectorDriver::test()` asks a provider "who am I?"
//! with the caller's own credential, and `studio-connector` stores the answer in
//! `Connection.account`. A personal connection is therefore standing proof that
//! its creator controls that account —
//! [`service::IdentityService::verify_from_connections`] only records it. No
//! token is read and nothing is re-probed.
//!
//! ## Inert without a database
//!
//! Stands down with a WARN rather than failing the boot when no `database:`
//! section is configured, the same shape `studio-documents` uses.

mod entity;
mod migrations;
mod repo;
pub mod resolve;
mod rest;
mod service;

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::context::GearCtx;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit_db::DBProvider;
use tracing::{info, warn};
use uuid::Uuid;

use repo::IdentityRepo;
use resolve::Binding;
use service::IdentityService;

/// ClientHub key under which the resolver is published for other gears.
///
/// Not a plugin: nothing selects between implementations, so unlike
/// `studio-credstore-pg` this is not published to the types-registry — the id
/// is used purely as the hub's scope key.
pub const IDENTITY_INSTANCE_ID: &str = "cf.studio._.identity.v1~";

/// Read-only identity resolution for other gears in this assembly.
///
/// Deliberately narrow: a consumer may ask who an account belongs to and
/// nothing else. Recording an assertion is a self-service act that requires the
/// subject's own `SecurityContext`, so it has no place on a gear-to-gear
/// interface.
#[async_trait]
pub trait IdentityResolver: Send + Sync + 'static {
    /// Bindings for many accounts of one provider, in one query.
    ///
    /// Accounts with no journal row are absent from the map; read that as
    /// [`Binding::Unbound`]. Account names are matched case-insensitively.
    async fn bindings(
        &self,
        tenant: Uuid,
        provider: &str,
        accounts: &[String],
    ) -> anyhow::Result<BTreeMap<String, Binding>>;
}

#[async_trait]
impl IdentityResolver for IdentityService {
    async fn bindings(
        &self,
        tenant: Uuid,
        provider: &str,
        accounts: &[String],
    ) -> anyhow::Result<BTreeMap<String, Binding>> {
        self.resolve_bindings(tenant, provider, accounts).await
    }
}

/// Self-service identity resolution gear.
#[toolkit::gear(
    name = "studio-identity",
    deps = [account_management],
    capabilities = [db, rest]
)]
#[derive(Default)]
pub struct StudioIdentityGear {
    service: OnceLock<Arc<IdentityService>>,
}

#[async_trait]
impl toolkit::Gear for StudioIdentityGear {
    #[tracing::instrument(skip_all, fields(module = "studio-identity"))]
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let db_raw = match ctx.db_required() {
            Ok(db) => db,
            Err(e) => {
                warn!(
                    "studio-identity: no database configured — gear inert (no identity routes, \
                     no resolution). Add a `database:` section (server + dbname) to enable it: {e}"
                );
                return Ok(());
            }
        };
        let db = Arc::new(DBProvider::<anyhow::Error>::new(db_raw.db()));
        let repo = Arc::new(IdentityRepo::new(db));
        let account_management = ctx.client_hub().get::<dyn AccountManagementClient>()?;
        let service = Arc::new(IdentityService::new(repo, account_management));

        self.service
            .set(Arc::clone(&service))
            .map_err(|_| anyhow::anyhow!("studio-identity already initialized"))?;

        // Published in `init`, not in the REST phase: every gear's `init` runs
        // before any gear's `register_rest`, so a consumer resolving this in its
        // own REST phase cannot lose a race with us. Resolution needs only the
        // journal, which is why it can be published this early — the
        // verification fold needs the connector catalogue and is attached later
        // (see `register_rest`).
        let resolver: Arc<dyn IdentityResolver> = service;
        ctx.client_hub().register_scoped::<dyn IdentityResolver>(
            ClientScope::gts_id(IDENTITY_INSTANCE_ID),
            resolver,
        );

        info!("studio-identity: initialized");
        Ok(())
    }
}

impl DatabaseCapability for StudioIdentityGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl RestApiCapability for StudioIdentityGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // Inert when no database was configured (see `init`).
        let Some(service) = self.service.get().cloned() else {
            warn!("studio-identity: not initialized (no database) — no routes registered");
            return Ok(router);
        };

        // Attached here rather than in `init`: the connector driver plugins are
        // separate gears, and the REST phase is the first point where every one
        // of them is guaranteed to have registered. Without them there is no
        // credential to verify against, and the verify route answers 400 while
        // claims and reads keep working.
        let connectors = build_connectors(ctx);
        if connectors.is_none() {
            warn!(
                "studio-identity: no connector driver plugin registered — verification \
                 unavailable, claims and resolution still work"
            );
        }
        service.attach_connectors(connectors);

        Ok(rest::register_routes(router, openapi, service))
    }
}

/// Build a connector service for reading the caller's connection catalogue.
///
/// Same in-crate construction `studio-components-catalog` uses: the pieces come
/// from ClientHub, so this is a second view onto the same catalogue rather than
/// a second copy of its state.
fn build_connectors(ctx: &GearCtx) -> Option<Arc<crate::connectors::service::ConnectorService>> {
    use crate::connectors::driver::ConnectorDriver;
    let mut drivers: Vec<(String, Arc<dyn ConnectorDriver>)> = Vec::new();
    for id in crate::connectors::source_driver_ids() {
        if let Ok(driver) = ctx
            .client_hub()
            .get_scoped::<dyn ConnectorDriver>(&ClientScope::gts_id(id))
        {
            drivers.push((id.to_string(), driver));
        }
    }
    if drivers.is_empty() {
        return None;
    }
    let am = ctx.client_hub().get::<dyn AccountManagementClient>().ok()?;
    let credstore = ctx
        .client_hub()
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .ok()?;
    Some(crate::connectors::service::ConnectorService::new(
        am, credstore, drivers,
    ))
}
