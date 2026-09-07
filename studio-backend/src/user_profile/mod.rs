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

mod entity;
mod migrations;
mod rest;
mod service;
mod store;

use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use toolkit_db::DBProvider;
use tracing::{info, warn};

use service::IdentityService;

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
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self.service.get().cloned().flatten();
        Ok(rest::register_routes(router, openapi, service))
    }
}
