//! studio-user — the canonical user, its sign-in methods, memberships and the
//! identity mapper.
//!
//! Keycloak authenticates; this gear owns *who the person is*: a Studio-owned
//! `user` record (the profile, role-free) to which sign-in methods (`login`),
//! organization memberships (`membership`, role per org) and non-login
//! identifiers (`alias`) bind, and the mapper that turns a token subject into a
//! stable user id. Storage is the gear's own relational database (SeaORM) — the
//! records are looked up and constrained, not traversed; a graph projection for
//! visualization/path-finding is a later, derived concern (ADR-0006).
//!
//! No database configured → the gear stands down (routes answer 503) rather
//! than failing a boot, mirroring studio-credstore-pg.

mod alias_policy;
mod entity;
mod migrations;
mod rest;
mod service;
mod store;

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use toolkit_db::DBProvider;
use tracing::{info, warn};

use service::IdentityService;

/// Fold an alias key into its stored form. Re-exported because the
/// knowledge-graph sync must normalize a login the same way a write did,
/// or the lookup misses the row.
pub use service::normalize_key;

/// ClientHub key under which the alias resolver is published for other gears.
///
/// Not a plugin: nothing selects between implementations, so unlike
/// `studio-credstore-pg` this is not published to the types-registry — the id is
/// the hub's scope key and nothing more.
pub const IDENTITY_INSTANCE_ID: &str = "cf.studio._.user_identity.v1~";

/// Read-only alias resolution for other gears in this assembly.
///
/// Deliberately narrow: a consumer may ask who a confirmed external identity
/// belongs to and nothing else. Writing an attribution is a self-service act
/// that needs the person's own `SecurityContext`, so it has no place on a
/// gear-to-gear interface.
#[async_trait]
pub trait AliasResolver: Send + Sync + 'static {
    /// Confirmed owners of `external_ids` for one `kind`, keyed by identifier.
    ///
    /// Identifiers with no confirmed alias are absent from the map; read that as
    /// "nobody has proven this one". Claims and suggestions are never returned:
    /// they attribute nothing, so a consumer must not be able to mistake one for
    /// an attribution (ADR-0012).
    async fn confirmed_owners(
        &self,
        kind: &str,
        external_ids: &[String],
    ) -> anyhow::Result<BTreeMap<String, String>>;
}

#[async_trait]
impl AliasResolver for IdentityService {
    async fn confirmed_owners(
        &self,
        kind: &str,
        external_ids: &[String],
    ) -> anyhow::Result<BTreeMap<String, String>> {
        self.confirmed_alias_owners(kind, external_ids).await
    }
}

#[toolkit::gear(
    name = "studio-user",
    deps = [account_management],
    capabilities = [rest, db]
)]
#[derive(Default)]
pub struct StudioUserGear {
    service: OnceLock<Option<Arc<IdentityService>>>,
}

#[async_trait]
impl Gear for StudioUserGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let service = match ctx.db_required() {
            Ok(db_raw) => {
                let db = Arc::new(DBProvider::<anyhow::Error>::new(db_raw.db()));
                let store = Arc::new(store::PgStore::new(db));
                let am = ctx.client_hub().get::<dyn AccountManagementClient>()?;
                info!("studio-user: relational identity store configured");
                Some(Arc::new(IdentityService::new(store, am)))
            }
            Err(e) => {
                warn!(
                    "studio-user: no database configured — gear stands down (identity API \
                     answers 503 until a `database:` section is added): {e}"
                );
                None
            }
        };
        // Published in `init`, not in the REST phase: every gear's `init` runs
        // before any gear's `register_rest`, so a consumer resolving this in its
        // own REST phase cannot lose a race with us. Resolution needs only the
        // store, which is why it can be published this early — the confirmation
        // ceremony needs the connector catalogue and is attached later (see
        // `register_rest`).
        if let Some(svc) = service.clone() {
            let resolver: Arc<dyn AliasResolver> = svc;
            ctx.client_hub().register_scoped::<dyn AliasResolver>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                resolver,
            );
        }

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-user already initialized"))?;
        Ok(())
    }
}

impl DatabaseCapability for StudioUserGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl RestApiCapability for StudioUserGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self.service.get().cloned().flatten();

        // Attached here rather than in `init`: the connector driver plugins are
        // separate gears, and the REST phase is the first point where every one
        // of them is guaranteed to have registered. Without them there is no
        // credential to confirm an identity against, and /me/aliases/confirm
        // answers 400 while claims and reads keep working.
        if let Some(svc) = service.as_ref() {
            let connectors = build_connectors(ctx);
            if connectors.is_none() {
                warn!(
                    "studio-user: no connector driver plugin registered — identity confirmation \
                     unavailable, claims and resolution still work"
                );
            }
            svc.attach_connectors(connectors);
        }

        Ok(rest::register_routes(router, openapi, service))
    }
}

/// Build a connector service for reading the caller's connection catalogue.
///
/// The same in-crate construction `studio-components-catalog` uses: the pieces
/// come from ClientHub, so this is a second view onto the same catalogue rather
/// than a second copy of its state.
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
