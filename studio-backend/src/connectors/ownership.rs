//! Whose connection a tenant may use.
//!
//! Connections are inherited downwards: a project sees its workspace's, its
//! organization's and the platform root's. Seeing one is not owning it. An
//! organization -- and anything under it -- uses only a connection held by
//! itself, one of its workspaces or one of its projects; never one held above
//! it, such as the platform's root, whose token would read (or write) the
//! organization's repositories with the platform's rights, and never another
//! organization's. The root acting for itself (the platform's own catalogue,
//! publishing to the platform's repository) uses the root's connections by
//! design: there the root is the organization.
//!
//! The rule lives here, with the connections, so every gear that acts through
//! one asks the same question: the components catalogue (walk, sources, sync,
//! declare, publish, gear repository), studio-product (scaffold, product
//! writes, repository creation) and studio-git (the proxy's upstream token).
//! `docs/design/studio-connector.md` (`cpt-studio-constraint-connector-own-connections`)
//! states it.
//!
//! The pure rule asks the tree and the connections through [`Tree`] and
//! [`Holders`], so it is tested with tables;
//! [`ConnectorService::ensure_owned`](super::service::ConnectorService::ensure_owned)
//! is the same rule over the real tree and catalogue.

use uuid::Uuid;

/// The platform's (root) tenant -- the same id studio-user and the
/// organizations gear name the root by.
pub const PLATFORM_ROOT_TENANT: Uuid = Uuid::from_u128(1);

/// The machine-readable reason a use of a connection the organization does
/// not own is refused with (400, `failed_precondition`).
pub const CONNECTION_NOT_OWNED: &str = "CONNECTION_NOT_OWNED";

/// What a person can do about a repository refused for its connection.
pub const NOT_OWNED_HINT: &str = "The project's connection belongs to the platform or another tenant, not to this organization; connect the repository with an organization-scope connection of your own.";

/// The tenant tree as the caller reads it.
#[async_trait::async_trait]
pub trait Tree: Send + Sync {
    /// `tenant`'s parent: `Some(None)` for a tenant with none, `None` when it
    /// cannot be read.
    async fn parent_of(&self, tenant: Uuid) -> Option<Option<Uuid>>;
}

/// Where connections are held.
#[async_trait::async_trait]
pub trait Holders: Send + Sync {
    /// The tenant holding the connection a use from `tenant` would take --
    /// `connection_id`'s, or the default one when none is named. `None` when
    /// there is none.
    async fn holder_of(&self, tenant: Uuid, connection_id: Option<Uuid>) -> Option<Uuid>;
}

/// Whether `tenant` is `org` or below it. Fails closed: a tenant whose
/// ancestry cannot be read, the platform's root (unless it is `org`) and
/// anything above `org` are not within it.
pub async fn within(org: Uuid, tenant: Uuid, tree: &dyn Tree) -> bool {
    if tenant == org {
        return true;
    }
    if tenant == PLATFORM_ROOT_TENANT {
        return false;
    }
    // Project -> workspace -> organization: nothing Studio keeps is deeper.
    let mut current = tenant;
    for _ in 0..4 {
        match tree.parent_of(current).await {
            Some(Some(p)) if p == org => return true,
            Some(Some(p)) if p == PLATFORM_ROOT_TENANT => return false,
            Some(Some(p)) => current = p,
            _ => return false,
        }
    }
    false
}

/// Whether a use from `tenant` through `connection_id` (or the default
/// connection, when none is named) is `org`'s to make: `tenant` is within the
/// organization and so is the tenant holding the connection. A connection
/// that cannot be found is let through: the use fails on its own, saying so.
pub async fn connection_is_owned(
    org: Uuid,
    tenant: Uuid,
    connection_id: Option<Uuid>,
    holders: &dyn Holders,
    tree: &dyn Tree,
) -> bool {
    if !within(org, tenant, tree).await {
        return false;
    }
    match holders.holder_of(tenant, connection_id).await {
        Some(holder) => within(org, holder, tree).await,
        None => true,
    }
}

/// The rule as a gear that acts through a connection asks it: may a use,
/// for `scope` (a project, workspace or organization -- or the root, for
/// itself), start from `tenant` through `connection_id` (or the default
/// `provider` connection when none is named)? The connector service answers
/// it over the real tree and catalogue; a test answers it from a table.
#[async_trait::async_trait]
pub trait Ownership: Send + Sync {
    async fn ensure_owned(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: Uuid,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        provider: &str,
    ) -> Result<(), NotOwned>;
}

/// Who holds a refused connection, as a message says it.
pub fn whose(holder: Uuid) -> String {
    if holder == PLATFORM_ROOT_TENANT {
        "the platform's root".to_owned()
    } else {
        format!("tenant {holder}")
    }
}

/// A use of a connection held outside the organization, refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotOwned {
    /// The tenant holding the connection.
    pub holder: Uuid,
    /// The organization the use was for.
    pub organization: Uuid,
}

impl std::fmt::Display for NotOwned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the connection is held by {}, outside organization {}: an organization writes and reads only through a connection held by itself, one of its workspaces or one of its projects. Connect the repository with an organization-scope connection of your own.",
            whose(self.holder),
            self.organization
        )
    }
}

impl std::error::Error for NotOwned {}

#[cfg(test)]
#[path = "ownership_tests.rs"]
mod tests;
