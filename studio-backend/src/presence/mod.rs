//! studio-presence — who is in Studio right now, and a way to reach them.
//!
//! Two things an administrator asked for and could not get: *who is working
//! in here at the moment*, and *can I say something to them*.
//!
//! **Presence is heartbeats.** The portal says "still here, on this screen"
//! every [`registry::HEARTBEAT_MS`], and anybody whose last word was inside
//! [`registry::ONLINE_TTL_MS`] is online. Inferring it from an open SSE
//! subscription would be cheaper and would answer a worse question — a tab
//! left open overnight holds a subscription and tells you nothing about
//! whether anyone is there.
//!
//! **A message is a note handed over on the next heartbeat, not a mailbox.** A
//! note to a person waits in an in-process inbox (at most
//! [`registry::MAX_INBOX`] per recipient, oldest dropped first) and is handed
//! over, and removed, in the answer to the recipient's next
//! `POST /studio-presence/v1/me` heartbeat. Only somebody online can be
//! written to: if the recipient is not there, the send answers
//! `delivered: false` and stores nothing, rather than queueing something they
//! will read tomorrow out of context. That is a deliberate limit, and the
//! endpoint states it.
//!
//! State is per-process and resets on restart — like the event hub's replay
//! window. A restart makes everybody look offline for one heartbeat interval
//! and then the truth comes back on its own, which is a better failure than a
//! persisted row that outlives the process that wrote it.

mod registry;
mod rest;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};

use registry::PresenceRegistry;

#[toolkit::gear(name = "studio-presence", capabilities = [rest])]
#[derive(Default)]
pub struct PresenceGear {
    registry: Arc<PresenceRegistry>,
}

#[async_trait]
impl Gear for PresenceGear {
    async fn init(&self, _ctx: &GearCtx) -> anyhow::Result<()> {
        // Nothing to set up: the registry is the gear's own field and starts
        // empty, which is the correct state for "nobody has said hello yet".
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for PresenceGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let _ = ctx;
        Ok(rest::register_routes(
            router,
            openapi,
            self.registry.clone(),
        ))
    }
}
