//! studio-notify — notifications that survive the thing that was going to send
//! them.
//!
//! ## Why this gear exists
//!
//! `studio-connector` can post a message to Slack, Zulip or Discord while a
//! request waits for it. That is the right shape for "test this connection",
//! and the wrong shape for a notification: the caller is usually some other
//! piece of Studio that has just finished a job, the platform may be
//! rate-limiting or down, and an HTTP handler is a bad place to discover
//! either. A message dropped there is dropped for good.
//!
//! So this gear validates a notification and queues it. Delivery happens
//! afterwards, with retries, and what cannot be delivered lands in a
//! dead-letter table instead of nowhere.
//!
//! ## The run is the record
//!
//! This gear owns **no database**. The message is the payload of a
//! `notify.deliver` run in `studio-tasks`, and that run is the whole history:
//! its state, its attempts, its `summary` or `last_error`.
//!
//! That is what keeps accepting a notification a single transaction. This gear
//! used to keep its own `studio_notify_deliveries` table beside its own outbox,
//! which worked because both were in one database. Moving the queue to
//! `studio-tasks` and keeping the table would have meant writing the record in
//! one database and the queue entry in another — and a crash between those two
//! writes is exactly the lost notification the queue exists to prevent. One
//! system of record, one commit.
//!
//! What that costs: "what happened to my notification" is answered by
//! `GET /studio-tasks/v1/runs/{id}` rather than by a route of this gear's own,
//! and the list of what needs attention is
//! `GET /studio-tasks/v1/runs?task_type=notify.deliver&state=failed`.
//!
//! ## What is left here
//!
//! Two things, and both have to be here rather than in the task gear:
//!
//! * [`service`] — the accept path, which resolves the connection with the
//!   *caller's* context and refuses what a background worker could not do
//!   later: a personal-scoped credential it will not be able to read, a
//!   missing channel, a channel sent to a webhook connection that has its own.
//! * [`handler`] — the `notify.deliver` task, which knows how to read a chat
//!   platform's refusal and decide whether it is worth another attempt.

mod handler;
mod rest;
pub mod service;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};
use tracing::info;

use service::NotifyService;

#[toolkit::gear(
    name = "studio-notify",
    deps = [account_management],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioNotifyGear {
    service: OnceLock<Arc<NotifyService>>,
}

#[async_trait]
impl Gear for StudioNotifyGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // The task type this gear owns. Registered in `init` because the
        // registry is a process-global — no ordering constraint against
        // `studio-tasks`, which resolves handlers per message.
        crate::tasks::registry::register(Arc::new(handler::DeliveryTask::new(ctx.client_hub())))?;

        self.service
            .set(NotifyService::new(ctx.client_hub()))
            .map_err(|_| anyhow::anyhow!("studio-notify already initialized"))?;

        info!(
            task_type = handler::TASK_TYPE,
            max_attempts = handler::MAX_ATTEMPTS,
            "studio-notify: delivery task registered"
        );
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioNotifyGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // `init` always sets it, but the REST phase must not panic on a boot
        // where it somehow did not: fall back to a fresh service over the same
        // hub, which behaves identically.
        let service = self
            .service
            .get()
            .cloned()
            .unwrap_or_else(|| NotifyService::new(ctx.client_hub()));
        Ok(rest::register_routes(router, openapi, service))
    }
}
