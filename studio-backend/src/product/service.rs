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

use super::port::RepositoryTarget;
use crate::catalog_graph::CatalogSink;
use crate::catalog_graph::gts::{self, GtsNode};
use crate::connectors::sdk::ownership::Ownership;
use crate::connectors::sdk::{
    ConnectorService, Connectors, CreatedRepository, Repository, create_repository,
};

/// Which repository "Create a gear" writes into, in the order it is chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetOrigin {
    /// The project's own gear repository.
    Project,
    /// The organization's gear repository (ADR-0042 §2).
    Organization,
    /// The first of the project's `sources[]` read through a connection.
    Sources,
}

impl TargetOrigin {
    /// `project`, `organization` or `sources`: what a response says.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Organization => "organization",
            Self::Sources => "sources",
        }
    }
}

/// A repository a new gear is written into, and why that one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScaffoldTarget {
    pub target: RepositoryTarget,
    pub origin: TargetOrigin,
}

/// The scaffold's target order (ADR-0042 §2): the project's gear repository
/// wins for its project; the organization's gear repository is next; the
/// project's sources are last. Pure.
pub fn pick_scaffold_target(
    project: Option<RepositoryTarget>,
    organization: Option<RepositoryTarget>,
    sources: Option<RepositoryTarget>,
) -> Option<ScaffoldTarget> {
    let pick =
        |t: Option<RepositoryTarget>, origin| t.map(|target| ScaffoldTarget { target, origin });
    pick(project, TargetOrigin::Project)
        .or_else(|| pick(organization, TargetOrigin::Organization))
        .or_else(|| pick(sources, TargetOrigin::Sources))
}

/// What a scaffold says when a project has nowhere to write a new gear.
pub fn no_repo_text() -> &'static str {
    "this project has no repository connected to write to — add one on its Sources tab, or set the organization's gear repository on its Components page"
}

/// What a write says when a project has nowhere to write.
fn no_repo() -> anyhow::Error {
    anyhow!("this project has no repository connected to write to — add one on its Sources tab")
}

pub struct ProductService {
    sink: Arc<dyn CatalogSink>,
    connectors: Connectors,
    /// Reads a project's own sources, for a project with no gear repository.
    account_management:
        std::sync::OnceLock<Arc<dyn account_management_sdk::AccountManagementClient>>,
    /// Who answers whether a write's connection is the organization's: the
    /// connector service unless a test set a table.
    ownership: std::sync::OnceLock<Arc<dyn Ownership>>,
}

impl ProductService {
    pub fn new(sink: Arc<dyn CatalogSink>, connectors: Connectors) -> Self {
        Self {
            sink,
            connectors,
            account_management: std::sync::OnceLock::new(),
            ownership: std::sync::OnceLock::new(),
        }
    }

    /// Answer the ownership rule from `ownership` instead of the connector
    /// service.
    #[cfg(test)]
    pub(super) fn set_ownership(&self, ownership: Arc<dyn Ownership>) {
        let _ = self.ownership.set(ownership);
    }

    /// Refuse a write, for `scope`, into `target` through a connection the
    /// organization `scope` is in does not own: one held by the platform's
    /// root or another organization, which a project sees because
    /// connections are inherited downwards
    /// (`cpt-studio-constraint-connector-own-connections`). The error is a
    /// [`crate::connectors::sdk::ownership::NotOwned`], which the REST layer answers 400 `CONNECTION_NOT_OWNED`.
    pub async fn ensure_owned(
        &self,
        ctx: &SecurityContext,
        scope: Uuid,
        target: &RepositoryTarget,
    ) -> anyhow::Result<()> {
        let rule: Option<Arc<dyn Ownership>> = match self.ownership.get() {
            Some(rule) => Some(Arc::clone(rule)),
            None => self.connector_service().map(|c| c as Arc<dyn Ownership>),
        };
        // Without connectors there is nothing to write through: the write
        // fails on its own, saying so.
        if let Some(rule) = rule
            && let Err(refused) = rule
                .ensure_owned(ctx, scope, target.tenant, target.connection_id, "github")
                .await
        {
            tracing::warn!(%scope, tenant = %target.tenant, repo = %target.repo, holder = %refused.holder, "studio-product: a write through a connection the organization does not own is refused");
            return Err(refused.into());
        }
        Ok(())
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
        let target = self.write_target(ctx, project_id).await?;
        self.ensure_owned(ctx, scope_of(ctx, project_id), &target)
            .await?;
        let RepositoryTarget {
            tenant,
            connection_id,
            repo,
            base_branch,
        } = target;

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
            None,
        )
        .await
    }

    /// Commit files onto a new `branch` off `target`'s base branch in the
    /// repository `target` names, through its connection, and open a pull
    /// request back: what Declare it writes (ADR-0041 P3). `ctx` is the
    /// tenant the connection is readable from -- the project's, or the
    /// root's when the platform writes its own repository (publish) -- and
    /// the write is for that tenant ([`Self::ensure_owned`]).
    pub async fn write_to_repository(
        &self,
        ctx: &SecurityContext,
        target: &super::port::RepositoryTarget,
        branch: &str,
        files: &[super::scaffold::ScaffoldFile],
        pull_request: &super::port::PullRequestText,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        self.ensure_owned(ctx, ctx.subject_tenant_id(), target)
            .await?;
        let connectors = self
            .connector_service()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let repo = Repository::open(
            &connectors,
            ctx,
            target.tenant,
            target.connection_id,
            "github",
            &target.repo,
            None,
        )
        .await?;
        super::scaffold::write_scaffold(
            &repo,
            &target.base_branch,
            branch,
            files,
            &pull_request.message,
            Some(&pull_request.title),
            Some(&pull_request.body),
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
    ) -> anyhow::Result<RepositoryTarget> {
        let target = match self.project_gear_repo_target(ctx, project_id).await? {
            Some(t) => Some(t),
            None => self.source_target(ctx, project_id).await,
        };
        target.ok_or_else(no_repo)
    }

    /// The gear repository connected to the project, as a write target.
    async fn project_gear_repo_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<RepositoryTarget>> {
        let Some(node) = self.get_project_repo(ctx, project_id).await? else {
            return Ok(None);
        };
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
        Ok(Some(RepositoryTarget {
            tenant,
            connection_id,
            repo,
            base_branch,
        }))
    }

    /// The project's own repository from `project.config` `sources[]`: the
    /// first read through a connection the caller sees.
    async fn source_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> Option<RepositoryTarget> {
        let (Some(am), Some(connectors)) =
            (self.account_management.get(), self.connector_service())
        else {
            return None;
        };
        let project = Uuid::parse_str(project_id).ok()?;
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
                return Some(RepositoryTarget {
                    tenant,
                    connection_id: Some(connection_id),
                    repo: source.full_path,
                    base_branch: branch,
                });
            }
        }
        None
    }

    /// Where "Create a gear" writes for a project (ADR-0042 §2): its own gear
    /// repository, else `organization` -- the organization's gear
    /// repository, which the caller asked the catalogue for -- else the
    /// project's sources. `None` when there is none of the three.
    pub async fn scaffold_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        organization: Option<RepositoryTarget>,
    ) -> anyhow::Result<Option<ScaffoldTarget>> {
        let project = self.project_gear_repo_target(ctx, project_id).await?;
        // Read only when it would be the answer: it lists connections.
        let source = if project.is_none() && organization.is_none() {
            self.source_target(ctx, project_id).await
        } else {
            None
        };
        Ok(pick_scaffold_target(project, organization, source))
    }

    /// The organization a project hangs under, as the caller reads the tree.
    pub async fn organization_of_project(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> Option<Uuid> {
        let am = self.account_management.get()?;
        crate::organizations::sdk::organization_of(am.as_ref(), ctx, project_id).await
    }

    /// Commit a new gear's `files` onto `scaffold/<slug>` off `target`'s base
    /// branch, through its connection, with a pull request when `open_pr`.
    /// The write is for `scope` -- the project, or the organization -- and
    /// only through a connection its organization owns
    /// ([`Self::ensure_owned`]).
    pub async fn scaffold_into_target(
        &self,
        ctx: &SecurityContext,
        scope: Uuid,
        target: &RepositoryTarget,
        slug: &str,
        files: &[super::scaffold::ScaffoldFile],
        open_pr: bool,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        self.ensure_owned(ctx, scope, target).await?;
        let connectors = self
            .connector_service()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        let repo = Repository::open(
            &connectors,
            ctx,
            target.tenant,
            target.connection_id,
            "github",
            &target.repo,
            None,
        )
        .await?;
        let pr_title = open_pr.then(|| format!("Scaffold {slug} gear"));
        super::scaffold::write_scaffold(
            &repo,
            &target.base_branch,
            &format!("scaffold/{slug}"),
            files,
            &format!("scaffold: {slug} gear skeleton"),
            pr_title.as_deref(),
            None,
        )
        .await
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
        // Not through a connection the organization only inherits: the
        // repository would be created with the platform's rights, and every
        // later write to it would go through the same token.
        self.ensure_owned(
            ctx,
            scope_of(ctx, project_id),
            &RepositoryTarget {
                tenant,
                connection_id,
                repo: String::new(),
                base_branch: String::new(),
            },
        )
        .await?;
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

/// The tenant a write about project `project_id` is for: the project, or --
/// for an id that is not one -- the caller's tenant.
fn scope_of(ctx: &SecurityContext, project_id: &str) -> Uuid {
    Uuid::parse_str(project_id).unwrap_or_else(|_| ctx.subject_tenant_id())
}

#[cfg(test)]
#[path = "service_ownership_tests.rs"]
mod ownership_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog_graph::MemorySink;

    fn target(repo: &str) -> RepositoryTarget {
        RepositoryTarget {
            tenant: Uuid::from_u128(1),
            connection_id: Some(Uuid::from_u128(2)),
            repo: repo.into(),
            base_branch: "main".into(),
        }
    }

    #[test]
    fn a_new_gear_goes_to_the_project_then_the_organization_then_the_sources() {
        let all = pick_scaffold_target(
            Some(target("acme/app-gears")),
            Some(target("acme/gears")),
            Some(target("acme/app")),
        )
        .unwrap();
        assert_eq!(all.origin, TargetOrigin::Project, "the project's own wins");
        assert_eq!(all.target.repo, "acme/app-gears");

        let org = pick_scaffold_target(None, Some(target("acme/gears")), Some(target("acme/app")))
            .unwrap();
        assert_eq!(org.origin, TargetOrigin::Organization);
        assert_eq!(org.target.repo, "acme/gears");
        assert_eq!(org.origin.as_str(), "organization");

        let sources = pick_scaffold_target(None, None, Some(target("acme/app"))).unwrap();
        assert_eq!(sources.origin, TargetOrigin::Sources);
        assert_eq!(sources.origin.as_str(), "sources");

        assert_eq!(pick_scaffold_target(None, None, None), None);
    }

    #[tokio::test]
    async fn a_project_with_its_own_gear_repository_writes_there_and_one_without_writes_to_the_organizations()
     {
        let service = ProductService::new(
            Arc::new(MemorySink::default()),
            Connectors::new(Arc::new(toolkit::client_hub::ClientHub::new())),
        );
        let ctx = SecurityContext::builder()
            .subject_id(Uuid::from_u128(7))
            .subject_tenant_id(Uuid::from_u128(0x0a6))
            .build()
            .unwrap();
        let project = Uuid::from_u128(0x101).to_string();

        let org = service
            .scaffold_target(&ctx, &project, Some(target("acme/gears")))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(org.origin, TargetOrigin::Organization);
        assert_eq!(org.target.repo, "acme/gears");

        // Without either, and with no sources readable, nowhere.
        assert_eq!(
            service.scaffold_target(&ctx, &project, None).await.unwrap(),
            None
        );

        service
            .set_project_repo(
                &ctx,
                &project,
                json!({
                    "tenant": Uuid::from_u128(1),
                    "connection_id": Uuid::from_u128(3),
                    "repo": "acme/app-gears",
                    "branch": "dev",
                }),
            )
            .await
            .unwrap();
        let own = service
            .scaffold_target(&ctx, &project, Some(target("acme/gears")))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(own.origin, TargetOrigin::Project);
        assert_eq!(own.target.repo, "acme/app-gears");
        assert_eq!(own.target.base_branch, "dev");
        assert_eq!(own.target.connection_id, Some(Uuid::from_u128(3)));
    }
}
