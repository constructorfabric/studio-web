//! A project's product and the repository it is written to.
//!
//! Two records per project, both nodes in the catalogue graph keyed on the
//! project id: the gear repository (`project_gear_repo`: which connection,
//! repository and branch the project's gears and product description are
//! written to) and the product (`project_product`: the gears picked, the
//! deployment profile, what the Gearbox engine said at the last preview and
//! where it was saved). Writing into the repository goes through the
//! connection, so its credential stays in credstore.

use std::sync::Arc;

use anyhow::anyhow;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::catalog_graph::CatalogSink;
use crate::catalog_graph::gts::{self, GtsNode};
use crate::connectors::sdk::{
    ConnectorService, Connectors, CreatedRepository, Repository, create_repository,
};

pub struct ProductService {
    sink: Arc<dyn CatalogSink>,
    connectors: Connectors,
    /// Reads a project's own sources, for a project with no gear repository.
    account_management:
        std::sync::OnceLock<Arc<dyn account_management_sdk::AccountManagementClient>>,
}

impl ProductService {
    pub fn new(sink: Arc<dyn CatalogSink>, connectors: Connectors) -> Self {
        Self {
            sink,
            connectors,
            account_management: std::sync::OnceLock::new(),
        }
    }

    pub fn set_account_management(
        &self,
        client: Arc<dyn account_management_sdk::AccountManagementClient>,
    ) {
        let _ = self.account_management.set(client);
    }

    /// The connector service, when `studio-connector` has published one.
    fn connector_service(&self) -> Option<Arc<ConnectorService>> {
        self.connectors.get()
    }

    /// The gear repository connected to a project (where its gears live and where
    /// scaffolded gears are written), or `None` when none is connected yet.
    pub async fn get_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let want = gts::project_gear_repo_instance_id(project_id);
        let nodes = self.sink.list(ctx, Some("project_gear_repo")).await?;
        Ok(nodes.into_iter().find(|n| n.instance_id == want))
    }

    /// Connect (or update) the gear repository for a project. `repo` is an open
    /// JSON object — `{connection_id, repo, branch}` — and the service stamps in
    /// the `project_id` identity before persisting.
    pub async fn set_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        repo: Value,
    ) -> anyhow::Result<GtsNode> {
        let mut value = repo
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("gear repo must be a JSON object"))?;
        value.insert(
            "project_id".to_owned(),
            Value::String(project_id.to_owned()),
        );
        let node = gts::project_gear_repo_node(project_id, Value::Object(value));
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(node)
    }

    /// The product a project is composing, or `None` before anything was picked.
    pub async fn get_project_product(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let want = gts::project_product_instance_id(project_id);
        let nodes = self.sink.list(ctx, Some("project_product")).await?;
        Ok(nodes.into_iter().find(|n| n.instance_id == want))
    }

    /// Merge `patch` into the project's product record and persist it. A merge,
    /// not a replace: the picks are saved as they change, the last preview when
    /// it runs, and neither write may erase the other's half.
    pub async fn update_project_product(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        patch: serde_json::Map<String, Value>,
    ) -> anyhow::Result<GtsNode> {
        let mut value = self
            .get_project_product(ctx, project_id)
            .await?
            .and_then(|n| n.value.as_object().cloned())
            .unwrap_or_default();
        for (k, v) in patch {
            value.insert(k, v);
        }
        value.insert(
            "project_id".to_owned(),
            Value::String(project_id.to_owned()),
        );
        value.insert(
            "updated_at".to_owned(),
            Value::String(
                time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default(),
            ),
        );
        let node = gts::project_product_node(project_id, Value::Object(value));
        self.sink.register_types(ctx).await?;
        self.sink
            .upsert(ctx, std::slice::from_ref(&node), &[])
            .await?;
        Ok(node)
    }

    /// Write a scaffolded gear into the project's connected gear repository: a
    /// branch off the connected base branch carrying the skeleton files, and an
    /// optional pull request. The connection token is resolved via the
    /// connectors service (it stays in credstore).
    pub async fn scaffold_into_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        slug: &str,
        files: Vec<super::scaffold::ScaffoldFile>,
        open_pr: bool,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        let pr_title = open_pr.then(|| format!("Scaffold {slug} gear"));
        self.write_to_project_repo(
            ctx,
            project_id,
            Some(&format!("scaffold/{slug}")),
            &files,
            &format!("scaffold: {slug} gear skeleton"),
            pr_title.as_deref(),
        )
        .await
    }

    /// Commit files into the project's connected gear repository: on a new
    /// `branch` off its base branch (which must not exist yet), with a pull
    /// request when `pr_title` is given, or with `branch: None` straight onto
    /// the base branch. Returns the branch the commit landed on.
    pub async fn write_to_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        branch: Option<&str>,
        files: &[super::scaffold::ScaffoldFile],
        message: &str,
        pr_title: Option<&str>,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        let (tenant, connection_id, repo, base_branch) = self.write_target(ctx, project_id).await?;

        let connectors = self
            .connector_service()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let repo = Repository::open(
            &connectors,
            ctx,
            tenant,
            connection_id,
            "github",
            &repo,
            None,
        )
        .await?;
        super::scaffold::write_scaffold(
            &repo,
            &base_branch,
            branch.unwrap_or(&base_branch),
            files,
            message,
            pr_title,
        )
        .await
    }

    /// Where a write into "the project's repository" lands: `(tenant of the
    /// connection, connection, owner/repo, base branch)`.
    ///
    /// The gear repository when one was connected on this tab; otherwise the
    /// project's own repository, from `project.config` `sources[]` — the one
    /// record of a project's repositories since #590. Only the first source
    /// read through a connection counts: a write needs credentials, and the
    /// first source is the project's own repository in every project the
    /// portal creates. Reading already fell back the same way
    /// (`source_dependencies`); writing did not, so a project whose
    /// repository was connected as a source could compose a product and not
    /// save it.
    async fn write_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<(Uuid, Option<Uuid>, String, String)> {
        if let Some(node) = self.get_project_repo(ctx, project_id).await? {
            let v = node.value;
            let repo = v
                .get("repo")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("connected gear repo has no 'repo'"))?
                .to_string();
            let base_branch = v
                .get("branch")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("main")
                .to_string();
            let tenant: Uuid = v
                .get("tenant")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| anyhow!("connected gear repo has no 'tenant'"))?;
            let connection_id: Option<Uuid> = v
                .get("connection_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok());
            return Ok((tenant, connection_id, repo, base_branch));
        }
        let no_repo = || {
            anyhow!(
                "this project has no repository connected to write to — add one on its Sources tab"
            )
        };
        let (Some(am), Some(connectors)) =
            (self.account_management.get(), self.connector_service())
        else {
            return Err(no_repo());
        };
        let project = Uuid::parse_str(project_id).map_err(|_| no_repo())?;
        for source in crate::project_sources::read(am.as_ref(), ctx, project)
            .await
            .unwrap_or_default()
        {
            let Some(connection_id) = source.connection_id else {
                continue;
            };
            if let Some(tenant) = connectors.locate(ctx, project, connection_id).await {
                let branch = source
                    .branch
                    .filter(|b| !b.trim().is_empty())
                    .unwrap_or_else(|| "main".to_owned());
                return Ok((tenant, Some(connection_id), source.full_path, branch));
            }
        }
        Err(no_repo())
    }

    /// Create a new repository through the connector and record it as this
    /// project's gear repository. Returns the created repo's full name and URL.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
    ) -> anyhow::Result<CreatedRepository> {
        let connectors = self
            .connector_service()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let created = create_repository(
            &connectors,
            ctx,
            tenant,
            connection_id,
            "github",
            owner,
            is_org,
            name,
            private,
        )
        .await?;
        // Record it as the project's gear repository so scaffolds land here.
        let repo_val = json!({
            "tenant": tenant,
            "connection_id": connection_id,
            "repo": created.full_name,
            "branch": created.default_branch,
        });
        self.set_project_repo(ctx, project_id, repo_val).await?;
        Ok(created)
    }
}
