//! Whose connection an organization reads and writes through, as the
//! catalogue applies it.
//!
//! The rule itself -- an organization uses only a connection held by
//! itself, one of its workspaces or one of its projects; the platform's own
//! catalogue, synced in the root, reads with the root's connections because
//! there the root is the organization -- lives with the connections, in
//! [`crate::connectors::sdk::ownership`], so studio-product and studio-git
//! ask the same question. What is here is the catalogue's use of it: which
//! of a project's repositories the walk reads, which sources a sync keeps,
//! and what a refused one looks like.

use uuid::Uuid;

pub use crate::connectors::sdk::ownership::{Holders, NOT_OWNED_HINT, Tree, within};
use crate::connectors::sdk::ownership::{connection_is_owned, whose};

use super::registry::RepoWalk;
use super::service::{ProjectRepo, RepoSource, SyncSources};

/// The machine-readable reason an organization's source naming a tenant
/// outside the organization is refused with.
pub const SOURCE_TENANT_NOT_OWNED: &str = "SOURCE_TENANT_NOT_OWNED";

/// A repository the walk refused to read, as its project's status says it.
pub fn refused_walk(repo: &str, holder: Uuid) -> RepoWalk {
    RepoWalk {
        repo: repo.to_owned(),
        status: "failed".to_owned(),
        components: 0,
        error: Some(format!(
            "not read: its connection is held by {}, outside the organization",
            whose(holder)
        )),
        hint: Some(NOT_OWNED_HINT.to_owned()),
    }
}

/// Split a project's repositories into those read through a connection the
/// organization `org` owns and, for the others, what the walk reports.
/// Each repository's `holder` is the tenant holding its connection.
pub(super) async fn split_owned(
    org: Uuid,
    repos: Vec<ProjectRepo>,
    tree: &dyn Tree,
) -> (Vec<ProjectRepo>, Vec<RepoWalk>) {
    let mut owned = Vec::with_capacity(repos.len());
    let mut refused = Vec::new();
    for r in repos {
        if within(org, r.holder, tree).await {
            owned.push(r);
        } else {
            refused.push(refused_walk(&r.repo, r.holder));
        }
    }
    (owned, refused)
}

/// Take out of an organization's sync every source whose connection is not
/// the organization's: one naming a tenant outside it, or one whose
/// connection -- named, or the default the read would take -- is held above
/// it. Answers what was taken, `repo` or `owner/number`.
pub async fn retain_owned_sources(
    org: Uuid,
    sources: &mut SyncSources,
    holders: &dyn Holders,
    tree: &dyn Tree,
) -> Vec<String> {
    let mut refused = Vec::new();
    let mut repos = Vec::with_capacity(sources.repos.len());
    for s in std::mem::take(&mut sources.repos) {
        if connection_is_owned(org, s.tenant, s.connection_id, holders, tree).await {
            repos.push(s);
        } else {
            refused.push(s.repo.clone());
        }
    }
    sources.repos = repos;
    let mut roadmaps = Vec::with_capacity(sources.roadmaps.len());
    for r in std::mem::take(&mut sources.roadmaps) {
        if connection_is_owned(org, r.tenant, r.connection_id, holders, tree).await {
            roadmaps.push(r);
        } else {
            refused.push(format!("{}/{}", r.owner, r.number));
        }
    }
    sources.roadmaps = roadmaps;
    refused
}

/// The tenant an organization's source names, checked: the organization when
/// none is named (the nil id), the one named when it is within the
/// organization, else `Err` with the tenant refused.
pub async fn source_tenant(org: Uuid, named: Uuid, tree: &dyn Tree) -> Result<Uuid, Uuid> {
    if named.is_nil() {
        return Ok(org);
    }
    if within(org, named, tree).await {
        Ok(named)
    } else {
        Err(named)
    }
}

/// [`RepoSource`] with its tenant checked by [`source_tenant`].
pub async fn owned_source(
    org: Uuid,
    mut source: RepoSource,
    tree: &dyn Tree,
) -> Result<RepoSource, Uuid> {
    source.tenant = source_tenant(org, source.tenant, tree).await?;
    Ok(source)
}

#[cfg(test)]
#[path = "ownership_tests.rs"]
mod tests;
