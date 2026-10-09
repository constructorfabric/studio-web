//! What another gear may ask about an organization's tenant tree.
//!
//! `ProjectsOf` lists an organization's projects (ADR-0041 §1). The tree is
//! walked here and nowhere else -- `rollups::projects_of`, the same two levels
//! the portfolio walks -- so a gear that needs every project of an
//! organization (the components registry) asks rather than walking the tree
//! itself and growing its own idea of where projects sit.
//!
//! Published on the ClientHub at init, while account-management is the one
//! dependency it needs.

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

pub use super::rollups::OrgProject;

#[async_trait]
pub trait ProjectsOf: Send + Sync {
    /// Every project tenant of the organization `org`, with its workspace, in
    /// tree order. An error when the tree could not be listed: "none" is an
    /// answer, "could not tell" is not one.
    async fn projects_of(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> anyhow::Result<Vec<OrgProject>>;
}

/// The organizations gear's answer to [`ProjectsOf`].
pub struct TenantTreeProjects {
    am: Arc<dyn AccountManagementClient>,
}

impl TenantTreeProjects {
    pub fn new(am: Arc<dyn AccountManagementClient>) -> Self {
        Self { am }
    }
}

#[async_trait]
impl ProjectsOf for TenantTreeProjects {
    async fn projects_of(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> anyhow::Result<Vec<OrgProject>> {
        super::rollups::projects_of(self.am.as_ref(), ctx, org).await
    }
}
