//! What another gear uses of the connectors, and nothing else.
//!
//! There is one [`ConnectorService`] in the process. `studio-connector` builds
//! it at `init` and publishes it on the ClientHub; a gear that reads
//! connections or talks to a provider through them holds a [`Connectors`]
//! handle and resolves the service when it needs it. Resolving per use rather
//! than at `init` keeps the consumer independent of the order gears start in:
//! Studio gears share one crate, so the toolkit's `deps` cannot order them.
//!
//! The drivers, the REST surface and the graph sync stay private to the gear.

use std::sync::Arc;

use toolkit::client_hub::ClientHub;

#[cfg(test)]
pub use super::driver::RemoteReview;
pub use super::driver::{
    ConnectionAuth, ConnectorDriver, NotifyMessage, PullRequestThreads, RemoteComment,
    RemoteCommit, RemoteFile, RemoteIssue, RemotePullRequest,
};
pub(crate) use super::github::graphql_url;
pub use super::service::{ConnectorService, connection_by_id};

/// The connector service, resolved from the ClientHub when used.
#[derive(Clone)]
pub struct Connectors {
    hub: Arc<ClientHub>,
}

impl Connectors {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    /// The service `studio-connector` published, or `None` before it has, or
    /// in an assembly without it.
    pub fn get(&self) -> Option<Arc<ConnectorService>> {
        self.hub.get::<ConnectorService>().ok()
    }
}
