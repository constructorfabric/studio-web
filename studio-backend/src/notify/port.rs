//! How another gear asks for a notification: the [`Notifications`] client on
//! the ClientHub, published by `studio-notify` at `init`.
//!
//! `studio-tasks` announces a finished run through it. It used to build a
//! `NotifyService` of its own, which made the two gears a cycle in code —
//! notify runs its deliveries as tasks, and tasks reached into notify's
//! service. Through this port the cycle is a contract in one direction and a
//! lookup in the other, and an assembly without `studio-notify` simply sends
//! no notice.

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

pub use super::service::{Destination, NewDelivery};

#[async_trait]
pub trait Notifications: Send + Sync + 'static {
    /// Verify and queue one notification. Returns the run that delivers it.
    async fn accept(&self, ctx: &SecurityContext, req: NewDelivery<'_>) -> anyhow::Result<Uuid>;
}

#[async_trait]
impl Notifications for super::service::NotifyService {
    async fn accept(&self, ctx: &SecurityContext, req: NewDelivery<'_>) -> anyhow::Result<Uuid> {
        super::service::NotifyService::accept(self, ctx, req).await
    }
}
