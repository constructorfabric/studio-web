//! What another gear uses of the connectors, and nothing else.
//!
//! There is one [`ConnectorService`] in the process. `studio-connector` builds
//! it at `init` and publishes it on the ClientHub; a gear that reads
//! connections or talks to a provider through them holds a [`Connectors`]
//! handle and resolves the service when it needs it. Resolving per use rather
//! than at `init` keeps the consumer independent of the order gears start in:
//! Studio gears share one crate, so the toolkit's `deps` cannot order them.
//!
//! A gear that reads or writes a repository opens a [`Repository`] -- the
//! connection's driver bound to one repository and ref -- instead of speaking
//! the provider's API itself.
//!
//! The drivers, the REST surface and the graph sync stay private to the gear.

use std::sync::Arc;

use toolkit::client_hub::ClientHub;

/// A working copy on disk: shallow clone, fast-forward, walk. Credentials go
/// to `git` through a helper, never the URL or argv.
pub(crate) use super::clone as git_checkout;
pub use super::driver::CommitStatus;
#[cfg(test)]
pub use super::driver::RemoteReleaseAsset;
#[cfg(test)]
pub use super::driver::RemoteReview;
pub use super::driver::{
    ConnectionAuth, ConnectorDriver, CreatedRepository, DownloadTarget, FileToWrite, NotifyMessage,
    PullRequestThreads, RemoteBuildArtifact, RemoteComment, RemoteCommit, RemoteFile,
    RemoteFileList, RemoteIssue, RemotePullRequest, RemoteRelease, RemoteWorkflowJob,
    RemoteWorkflowRun,
};
/// What another gear's test needs to stand in for a provider.
#[cfg(test)]
pub use super::driver::{ConnectorCategory, DriverIdentity};
pub use super::gear_repository::PROVIDER as GEAR_REPOSITORY_PROVIDER;
pub use super::kubernetes::ClusterAccess;
pub use super::references::{Mention, NumberRef, Relation, find as find_references};
pub use super::registry::{RegistryAccess, same_registry};
pub use super::research::PROVIDER as RESEARCH_PROVIDER;
/// The Research connector's calls to the integration service (ADR-0049 §6).
pub mod research {
    pub use super::super::research_api::*;
}
pub use super::repository::{Repository, create_repository};
pub use super::service::{
    ConnectorService, GearRepositorySource, check_owned, connection_by_id, holder_of_row,
};

/// Whose connection a tenant may use: an organization, and anything under
/// it, only one held by itself, one of its workspaces or one of its
/// projects. The pure rule; [`ConnectorService::ensure_owned`] applies it
/// over the real tree and catalogue.
pub mod ownership {
    pub use super::super::ownership::*;
}

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
