//! studio-events — the assembly's push channel to the portal.
//!
//! One place where any gear says "this happened", and one place the frontend
//! subscribes. The contract is deliberately the one a broker-backed
//! implementation would serve, so producers and the frontend do not change
//! when that lands.
//!
//! **The channel is domain-neutral on purpose.** It knows nothing about tasks,
//! repositories or IDE sessions — a producer states `kind` + `subject` and
//! puts its own vocabulary in `payload`. That keeps any single producer's
//! protocol (the Theia bridge's included) from leaking into the contract every
//! other producer and the whole frontend then have to live with.
//!
//! Two endpoints, both tenant-scoped from the security context:
//!   * `GET /studio-events/v1/stream` — the live SSE channel;
//!   * `GET /studio-events/v1/events?after_seq=` — replay after a reconnect.
//!
//! Producers resolve [`StudioEventPublisher`] from the ClientHub **in their
//! REST phase**, not in `init`: gear init order is not guaranteed, and a
//! producer that cannot find the publisher simply publishes nothing.
//!
//! ## Why this gear has a database
//!
//! It did not, and that was the one thing keeping this deployment on a single
//! replica. The sequence and the replay window were per process, so two
//! replicas meant two independent sequences for one tenant: an event published
//! on one never reached a subscriber on the other, and a reconnect that landed
//! on the other replayed a different window under the same cursor, silently.
//!
//! The sequence and the window are now rows ([`store`]). What is still per
//! process is only the set of SSE connections this replica is holding, which
//! is the one thing that genuinely is.
//!
//! **Without a database the gear stands down**: no publisher is registered, so
//! producers publish nothing, and both endpoints answer 503 saying why. That
//! is the same shape studio-tasks takes, and it is better than a channel that
//! looks connected and delivers to one replica's worth of users.

mod api;
mod config;
mod dto;
mod entity;
mod hub;
mod migrations;
mod pump;
mod rest;
mod store;
#[cfg(test)]
mod store_tests;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::{DatabaseCapability, RestApiCapability, RunnableCapability};
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

pub use api::{StudioEvent, StudioEventPublisher};
use config::StudioEventsConfig;
use hub::StudioEventHub;
use store::EventStore;

#[toolkit::gear(name = "studio-events", capabilities = [rest, db, stateful])]
#[derive(Default)]
pub struct StudioEventsGear {
    /// `None` = no database, so the gear stood down.
    hub: OnceLock<Option<Arc<StudioEventHub>>>,
    store: OnceLock<Option<Arc<EventStore>>>,
    shutdown: OnceLock<CancellationToken>,
}

#[async_trait]
impl Gear for StudioEventsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioEventsConfig = ctx.config_or_default()?;

        let db = match ctx.db_required() {
            Ok(db) => db.db(),
            Err(e) => {
                warn!(
                    "studio-events: no database configured — the channel stands down (both \
                     endpoints answer 503 and nothing is published) until a `database:` \
                     section with server + dbname is added: {e}"
                );
                let _ = self.hub.set(None);
                let _ = self.store.set(None);
                return Ok(());
            }
        };

        let store = Arc::new(EventStore::new(db));
        let (to_writer, from_publishers) = mpsc::channel(cfg.queue.max(1));
        let hub = Arc::new(StudioEventHub::new(cfg.buffer, to_writer));

        // Published in `init` so a producer resolving it during the REST phase
        // — when every gear is initialized — always finds it.
        let published: Arc<dyn StudioEventPublisher> = hub.clone();
        ctx.client_hub()
            .register::<dyn StudioEventPublisher>(published);

        let shutdown = CancellationToken::new();
        pump::spawn_writer(from_publishers, store.clone(), shutdown.child_token());
        pump::spawn_poller(
            hub.clone(),
            store.clone(),
            Duration::from_millis(cfg.poll_ms.max(1)),
            i64::try_from(cfg.backlog).unwrap_or(i64::MAX),
            shutdown.child_token(),
        );

        self.shutdown
            .set(shutdown)
            .map_err(|_| anyhow::anyhow!("studio-events already initialized"))?;
        self.hub
            .set(Some(hub))
            .map_err(|_| anyhow::anyhow!("studio-events already initialized"))?;
        self.store
            .set(Some(store))
            .map_err(|_| anyhow::anyhow!("studio-events already initialized"))?;

        info!(
            buffer = cfg.buffer,
            backlog = cfg.backlog,
            queue = cfg.queue,
            poll_ms = cfg.poll_ms,
            "studio-events: channel ready"
        );
        Ok(())
    }
}

impl DatabaseCapability for StudioEventsGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl RunnableCapability for StudioEventsGear {
    async fn start(&self, _cancel: CancellationToken) -> anyhow::Result<()> {
        Ok(())
    }

    /// Stop the writer and the poller.
    ///
    /// Events still in the queue are lost, which is the same promise `publish`
    /// makes everywhere else: an event is best-effort, the operation that
    /// produced it is not. Draining here would hold a shutdown open for a
    /// database that may be the reason we are shutting down.
    async fn stop(&self, _deadline: CancellationToken) -> anyhow::Result<()> {
        if let Some(shutdown) = self.shutdown.get() {
            shutdown.cancel();
        }
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioEventsGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let hub = self.hub.get().cloned().flatten();
        let store = self.store.get().cloned().flatten();
        let access = ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()
            .ok()
            .map(|am| {
                crate::org_scope::OrgAccess(Arc::new(
                    crate::studio_session::sdk::TenantMembership::new(am),
                ))
            });
        Ok(rest::register_routes(router, openapi, hub, store, access))
    }
}
