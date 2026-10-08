//! Reading the plan file from its repository, through the organization's
//! GitHub connection -- the same one the board is read through.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::source::PlanFile;
use crate::connectors::sdk::{ConnectorService, Connectors, Repository};

/// A file's text and the blob it was.
#[derive(Clone, Debug, PartialEq)]
pub struct FileText {
    pub text: String,
    pub sha: Option<String>,
}

#[async_trait]
pub trait PlanReader: Send + Sync {
    async fn read(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        file: &PlanFile,
    ) -> Result<FileText>;

    /// Whether the connection the board is read through resolves in
    /// `tenant` and its token is readable -- asked before the board sync is
    /// queued, because that sync reads the board on its own time and treats
    /// a board it cannot read as one source of many, so it cannot refuse.
    async fn connection(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
    ) -> Result<()>;
}

pub struct GitHubPlanReader {
    connectors: Connectors,
}

impl GitHubPlanReader {
    pub fn new(connectors: Connectors) -> Self {
        Self { connectors }
    }

    fn service(&self) -> Result<Arc<ConnectorService>> {
        self.connectors.get().ok_or_else(|| {
            anyhow!("this deployment has no GitHub connector: upload the plan instead")
        })
    }
}

#[async_trait]
impl PlanReader for GitHubPlanReader {
    async fn connection(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
    ) -> Result<()> {
        self.service()?
            .named_or_default(ctx, tenant, connection_id, "github")
            .await
            .map(|_| ())
            .map_err(|e| anyhow!("the board cannot be read: {e:#}"))
    }

    async fn read(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        file: &PlanFile,
    ) -> Result<FileText> {
        let service = self.service()?;
        let repo = Repository::open(
            &service,
            ctx,
            tenant,
            connection_id,
            "github",
            &format!("{}/{}", file.owner, file.repo),
            file.git_ref.as_deref(),
        )
        .await?;
        let found = repo.read_file(&file.path).await?.ok_or_else(|| {
            anyhow!(
                "{} is not visible to this connection (no such file, or the token may not read that repository)",
                file.display()
            )
        })?;
        Ok(FileText {
            text: found.text,
            sha: found.sha,
        })
    }
}
