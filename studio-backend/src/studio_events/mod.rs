//! studio-events — the assembly's push channel to the portal.
//!
//! One place where any gear says "this happened", and one place the frontend
//! subscribes. Today it is a per-tenant in-process fan-out over SSE; the
//! contract is deliberately the same one a broker-backed implementation would
//! serve, so producers and the frontend do not change when that lands.
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

mod api;
mod config;
mod dto;
mod hub;
mod rest;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;

pub use api::{StudioEvent, StudioEventPublisher};
use config::StudioEventsConfig;
use hub::StudioEventHub;

#[toolkit::gear(name = "studio-events", capabilities = [rest])]
#[derive(Default)]
pub struct StudioEventsGear {
    hub: OnceLock<Arc<StudioEventHub>>,
}

#[async_trait]
impl Gear for StudioEventsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioEventsConfig = ctx.config_or_default()?;
        let hub = Arc::new(StudioEventHub::new(cfg.buffer, cfg.backlog));

        // Published in `init` so a producer resolving it during the REST phase
        // — when every gear is initialized — always finds it.
        let published: Arc<dyn StudioEventPublisher> = hub.clone();
        ctx.client_hub()
            .register::<dyn StudioEventPublisher>(published);

        self.hub
            .set(hub)
            .map_err(|_| anyhow::anyhow!("studio-events already initialized"))?;
        info!(
            buffer = cfg.buffer,
            backlog = cfg.backlog,
            "studio-events: channel ready"
        );
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioEventsGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let hub = self
            .hub
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-events not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, hub))
    }
}
