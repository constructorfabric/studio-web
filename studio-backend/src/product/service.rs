//! A project's product and the repositories it is written to.
//!
//! The product is a node in the catalogue graph keyed on the project id
//! (`project_product`: the gears picked, the frontend, what the Gearbox
//! engine said at the last preview and where it was saved). The repositories
//! are the project's one list of sources (`project.config` `sources[]`,
//! ADR-0060): there is no hidden main repository.
//!
//! - "Create a gear" writes into the source marked `gears_here`. The old
//!   per-project gear repository node (`project_gear_repo`) is folded into
//!   the list the first time it is read, and still read for one release
//!   where the list cannot be written.
//! - A published `product.gdl` goes to the source marked `publish_here`, and
//!   nowhere when none is: Studio keeps the revisions (ADR-0053).
//! - The description travels with its *home* source
//!   ([`crate::project_sources::description_home`]): its `path(...)` sources
//!   resolve there, and a build lays it in that checkout.
//!
//! Writing into a repository goes through its connection, so its credential
//! stays in credstore.

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

/// What a publish says when no source is marked to take it.
fn no_publish_source() -> anyhow::Error {
    anyhow!(
        "no source of this project is marked \"publish product.gdl here\": Studio keeps the \
         description's revisions; mark a source on the Sources tab to publish it there"
    )
}

/// Which of a project's sources a write goes to.
type SourcePick =
    fn(&[crate::project_sources::ProjectSource]) -> Option<&crate::project_sources::ProjectSource>;

pub struct ProductService {
    sink: Arc<dyn CatalogSink>,
    connectors: Connectors,
    /// Reads a project's own sources, for a project with no gear repository.
    account_management:
        std::sync::OnceLock<Arc<dyn account_management_sdk::AccountManagementClient>>,
    /// Who answers whether a write's connection is the organization's: the
    /// connector service unless a test set a table.
    ownership: std::sync::OnceLock<Arc<dyn Ownership>>,
    /// The tenants this process has registered the graph's types in. Every
    /// preview records the project's product, and registering again on each
    /// write was a round trip to graph-storage that never changed anything.
    registered: std::sync::Mutex<std::collections::HashSet<Uuid>>,
    /// The product's description by revision (ADR-0053), when the gear has a
    /// database ([`description_service`]).
    descriptions: std::sync::OnceLock<Arc<super::descriptions::DescriptionStore>>,
    /// Which organization a project hangs under, when a test says so instead
    /// of account-management.
    #[cfg(test)]
    project_organizations: std::sync::Mutex<std::collections::HashMap<Uuid, Uuid>>,
}

#[path = "description_service.rs"]
pub mod description_service;

impl ProductService {
    pub fn new(sink: Arc<dyn CatalogSink>, connectors: Connectors) -> Self {
        Self {
            sink,
            connectors,
            account_management: std::sync::OnceLock::new(),
            ownership: std::sync::OnceLock::new(),
            registered: std::sync::Mutex::new(std::collections::HashSet::new()),
            descriptions: std::sync::OnceLock::new(),
            #[cfg(test)]
            project_organizations: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The graph's types, registered in `ctx`'s tenant once per process. A
    /// failed registration is not remembered, so the next write tries again.
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        let known = self
            .registered
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(&tenant);
        if !known {
            self.sink.register_types(ctx).await?;
            self.registered
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(tenant);
        }
        Ok(())
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

    /// The old per-project gear repository node, as it was recorded.
    async fn legacy_gear_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let want = gts::project_gear_repo_instance_id(project_id);
        let nodes = self.sink.list(ctx, Some("project_gear_repo")).await?;
        Ok(nodes.into_iter().find(|n| n.instance_id == want))
    }

    /// The host a connection's repositories are cloned from
    /// (`https://github.com`), when the connection says.
    async fn clone_host(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        connection: Uuid,
    ) -> Option<String> {
        let connectors = self.connector_service()?;
        let tenant = connectors.locate(ctx, project, connection).await?;
        let (driver, auth, _) = connectors
            .driver_and_auth(ctx, tenant, connection)
            .await
            .ok()?;
        let url = driver.clone_url(&auth.base_url, "o/r").ok()?;
        url.strip_suffix("/o/r.git")
            .or_else(|| url.strip_suffix("/o/r"))
            .map(str::to_owned)
    }

    /// Fold the project's old gear repository node into its sources as the
    /// source marked `gears_here` (ADR-0060 §1). Idempotent; a failure is
    /// logged and the old node is read instead, for one release.
    async fn fold_legacy_gear_repo(&self, ctx: &SecurityContext, project_id: &str) {
        let (Some(am), Ok(project)) = (self.account_management.get(), Uuid::parse_str(project_id))
        else {
            return;
        };
        let Ok(Some(node)) = self.legacy_gear_repo(ctx, project_id).await else {
            return;
        };
        let connection = node
            .value
            .get("connection_id")
            .and_then(Value::as_str)
            .and_then(|c| Uuid::parse_str(c).ok());
        let host = match connection {
            Some(c) => self.clone_host(ctx, project, c).await,
            None => None,
        };
        match crate::project_sources::update_config(am.as_ref(), ctx, project, |config| {
            crate::project_sources::fold_gear_repo(config, &node.value, host.as_deref())
        })
        .await
        {
            Ok(true) => {
                tracing::info!(%project, "studio-product: the project's gear repository is a source marked `gears_here` now");
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(%project, error = %format!("{e:#}"), "studio-product: the project's gear repository could not be folded into its sources; the old record is read");
            }
        }
    }

    /// Where a project's new gears go (the source marked `gears_here`), in
    /// the shape the old gear repository record had: `{tenant,
    /// connection_id, repo, branch, project_id, source: true}`. `None` when
    /// no source is marked. The old record is folded into the sources first,
    /// and answers itself only when it could not be.
    pub async fn get_project_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        self.fold_legacy_gear_repo(ctx, project_id).await;
        if let Some(t) = self
            .flagged_target(ctx, project_id, crate::project_sources::gears_source)
            .await
        {
            let value = json!({
                "tenant": t.tenant,
                "connection_id": t.connection_id,
                "repo": t.repo,
                "branch": t.base_branch,
                "project_id": project_id,
                "source": true,
            });
            return Ok(Some(gts::project_gear_repo_node(project_id, value)));
        }
        self.legacy_gear_repo(ctx, project_id).await
    }

    /// Mark the source that is `repo` `gears_here` -- adding it to the
    /// project's sources when it is not one -- and clear the flag on every
    /// other. `repo` is `{tenant, connection_id, repo, branch}`. Without
    /// account-management (a test, a partial assembly) the old record is
    /// written instead.
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
        let value = Value::Object(value);
        if let (Some(am), Ok(project)) =
            (self.account_management.get(), Uuid::parse_str(project_id))
        {
            let connection = value
                .get("connection_id")
                .and_then(Value::as_str)
                .and_then(|c| Uuid::parse_str(c).ok());
            let host = match connection {
                Some(c) => self.clone_host(ctx, project, c).await,
                None => None,
            };
            let name = value
                .get("repo")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let url = format!(
                "{}/{name}.git",
                host.as_deref().unwrap_or("https://github.com")
            );
            crate::project_sources::update_config(am.as_ref(), ctx, project, |config| {
                crate::project_sources::set_gears_here(config, &value, &url, host.as_deref())
            })
            .await?;
            return Ok(gts::project_gear_repo_node(project_id, value));
        }
        let node = gts::project_gear_repo_node(project_id, value);
        self.register_types(ctx).await?;
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
        Ok(latest_record(nodes, &want))
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
        merge_product_patch(&mut value, patch);
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
        self.register_types(ctx).await?;
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
        let target = self.home_target(ctx, project_id).await?;
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

    /// Open an issue in the project's home repository (the source its
    /// description travels with), assigned to the given host accounts.
    pub async fn create_project_issue(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        title: &str,
        body: &str,
        assignees: &[String],
    ) -> anyhow::Result<(i64, Option<String>)> {
        let target = self.home_target(ctx, project_id).await?;
        self.ensure_owned(ctx, scope_of(ctx, project_id), &target)
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
        let issue = repo.create_issue(title, body, assignees).await?;
        Ok((issue.number, issue.url))
    }

    /// The project's home repository (the source its description travels
    /// with), checked to be reachable through a connection the organization
    /// holds.
    pub async fn project_repository(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<RepositoryTarget> {
        let target = self.home_target(ctx, project_id).await?;
        self.ensure_owned(ctx, scope_of(ctx, project_id), &target)
            .await?;
        Ok(target)
    }

    /// The text of `path` in the project's home repository, on its branch;
    /// `None` when the repository has no such file.
    pub async fn read_project_file(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        path: &str,
    ) -> anyhow::Result<Option<String>> {
        let target = self.home_target(ctx, project_id).await?;
        self.ensure_owned(ctx, scope_of(ctx, project_id), &target)
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
            Some(&target.base_branch),
        )
        .await?;
        Ok(repo.read_file(path).await?.map(|f| f.text))
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
        self.write_changes_to_repository(ctx, target, branch, files, &[], pull_request)
            .await
    }

    /// [`Self::write_to_repository`], deleting `deleted` in the same commit
    /// (ADR-0044 Extract: the code leaves the project it came from).
    pub async fn write_changes_to_repository(
        &self,
        ctx: &SecurityContext,
        target: &super::port::RepositoryTarget,
        branch: &str,
        files: &[super::scaffold::ScaffoldFile],
        deleted: &[String],
        pull_request: &super::port::PullRequestText,
    ) -> anyhow::Result<super::scaffold::ScaffoldWrite> {
        let repo = self.open_owned(ctx, target).await?;
        super::scaffold::write_changes(
            &repo,
            &target.base_branch,
            branch,
            files,
            deleted,
            &pull_request.message,
            Some(&pull_request.title),
            Some(&pull_request.body),
        )
        .await
    }

    /// Tag the tip of the target's base branch as `tag`, through the
    /// target's connection; answers the commit tagged.
    pub async fn tag_repository(
        &self,
        ctx: &SecurityContext,
        target: &super::port::RepositoryTarget,
        tag: &str,
    ) -> anyhow::Result<String> {
        let repo = self.open_owned(ctx, target).await?;
        let sha = repo
            .head_of(&target.base_branch)
            .await?
            .ok_or_else(|| anyhow!("{} has no branch `{}`", target.repo, target.base_branch))?;
        repo.create_tag(tag, &sha).await?;
        Ok(sha)
    }

    /// `target`'s default branch, as its host says. `None` when it cannot be
    /// read -- no connectors, no such connection, the host refused -- and the
    /// caller picks its own.
    pub async fn default_branch_of(
        &self,
        ctx: &SecurityContext,
        target: &super::port::RepositoryTarget,
    ) -> Option<String> {
        let connectors = self.connector_service()?;
        let read = async {
            Repository::open(
                &connectors,
                ctx,
                target.tenant,
                target.connection_id,
                "github",
                &target.repo,
                None,
            )
            .await?
            .default_branch()
            .await
        };
        match read.await {
            Ok(b) if !b.trim().is_empty() => Some(b.trim().to_owned()),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(repo = %target.repo, error = %format!("{e:#}"), "studio-product: the repository's default branch could not be read");
                None
            }
        }
    }

    /// The target's repository, opened only when `ctx` may write through
    /// its connection.
    async fn open_owned(
        &self,
        ctx: &SecurityContext,
        target: &super::port::RepositoryTarget,
    ) -> anyhow::Result<Repository> {
        self.ensure_owned(ctx, ctx.subject_tenant_id(), target)
            .await?;
        let connectors = self
            .connector_service()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        Repository::open(
            &connectors,
            ctx,
            target.tenant,
            target.connection_id,
            "github",
            &target.repo,
            None,
        )
        .await
    }

    /// A project source as a write target: the tenant its connection is
    /// found on, the connection, `owner/name` and its branch (`main` when it
    /// names none). `None` for a source read through no connection the
    /// caller sees.
    async fn source_as_target(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        source: crate::project_sources::ProjectSource,
    ) -> Option<RepositoryTarget> {
        let connectors = self.connector_service()?;
        let connection_id = source.connection_id?;
        let tenant = connectors.locate(ctx, project, connection_id).await?;
        let branch = source
            .branch
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| "main".to_owned());
        Some(RepositoryTarget {
            tenant,
            connection_id: Some(connection_id),
            repo: source.full_path,
            base_branch: branch,
        })
    }

    /// The project's sources, as the caller reads its config; none when it
    /// cannot be read.
    pub async fn project_sources(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> Vec<crate::project_sources::ProjectSource> {
        let (Some(am), Ok(project)) = (self.account_management.get(), Uuid::parse_str(project_id))
        else {
            return Vec::new();
        };
        crate::project_sources::read(am.as_ref(), ctx, project)
            .await
            .unwrap_or_default()
    }

    /// The source `pick` chooses out of the project's sources, as a target.
    async fn flagged_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        pick: SourcePick,
    ) -> Option<RepositoryTarget> {
        let project = Uuid::parse_str(project_id).ok()?;
        let sources = self.project_sources(ctx, project_id).await;
        let source = pick(&sources)?.clone();
        self.source_as_target(ctx, project, source).await
    }

    /// The project's home repository: the source its description travels
    /// with ([`crate::project_sources::description_home`]). A `path(...)`
    /// source of the description resolves in it, and a build lays the
    /// description in its checkout. Not the project's gear repository: where
    /// new gears go decides nothing about the product (ADR-0060 §1).
    pub(crate) async fn home_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<RepositoryTarget> {
        self.flagged_target(ctx, project_id, crate::project_sources::description_home)
            .await
            .ok_or_else(no_repo)
    }

    /// Where a published description goes: the source marked
    /// `publish_here`, and nowhere else (ADR-0060 §1). Refused when none is:
    /// Studio keeps the revisions, and publishing is a choice.
    pub(crate) async fn publish_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<RepositoryTarget> {
        self.flagged_target(ctx, project_id, crate::project_sources::publish_source)
            .await
            .ok_or_else(no_publish_source)
    }

    /// `owner/name` of the project's home repository, when it has one.
    pub async fn write_repo(&self, ctx: &SecurityContext, project_id: &str) -> Option<String> {
        let sources = self.project_sources(ctx, project_id).await;
        crate::project_sources::description_home(&sources).map(|s| s.full_path.clone())
    }

    /// How the project shares into its home repository: that source's
    /// `share_mode`. `None` for a project with no sources.
    pub async fn write_share_mode(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> Option<crate::project_sources::ShareMode> {
        let sources = self.project_sources(ctx, project_id).await;
        crate::project_sources::description_home(&sources).map(|s| s.share_mode)
    }

    /// Where new gears go, as a write target: the source marked
    /// `gears_here` (or the old record, where it could not be folded).
    async fn gears_target(
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

    /// Where "Create a gear" writes for a project (ADR-0042 §2, ADR-0060
    /// §1): its source marked `gears_here`, else `organization` -- the
    /// organization's gear repository, which the caller asked the catalogue
    /// for -- else its home source. `None` when there is none of the three.
    pub async fn scaffold_target(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        organization: Option<RepositoryTarget>,
    ) -> anyhow::Result<Option<ScaffoldTarget>> {
        let project = self.gears_target(ctx, project_id).await?;
        // Read only when it would be the answer: it lists connections.
        let source = if project.is_none() && organization.is_none() {
            self.home_target(ctx, project_id).await.ok()
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
        #[cfg(test)]
        if let Some(org) = self
            .project_organizations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&project_id)
        {
            return Some(*org);
        }
        let am = self.account_management.get()?;
        crate::organizations::sdk::organization_of(am.as_ref(), ctx, project_id).await
    }

    /// Say that `project` hangs under `organization`, instead of asking
    /// account-management.
    #[cfg(test)]
    pub(super) fn set_project_organization(&self, project: Uuid, organization: Uuid) {
        self.project_organizations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(project, organization);
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

    /// Create a new repository through the connector and make it this
    /// project's source marked `gears_here`. Returns the created repo's full name and URL.
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
        // Make it the project's source new gears go to.
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

/// The newest of the records under `key`. A project's record can be found
/// twice: one written before writes were scoped to the organization sits in
/// the platform root, beside the organization's, under the same key -- and
/// the first one listed was the old one, so a save looked lost. The newest
/// `updated_at` (RFC 3339, so it orders as text) is the record.
fn latest_record(nodes: Vec<GtsNode>, key: &str) -> Option<GtsNode> {
    nodes
        .into_iter()
        .filter(|n| n.instance_id == key)
        .max_by(|a, b| {
            let at = |n: &GtsNode| {
                n.value
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            at(a).cmp(&at(b))
        })
}

/// A patch laid over a product record: each field replaced, except `checks`,
/// which is merged by profile -- a preview checks one profile and must not
/// take the others' verdicts away (ADR-0057).
fn merge_product_patch(
    value: &mut serde_json::Map<String, Value>,
    patch: serde_json::Map<String, Value>,
) {
    for (k, v) in patch {
        if let (true, Value::Object(new), Some(Value::Object(old))) =
            (k == "checks", &v, value.get_mut(&k))
        {
            old.extend(new.clone());
            continue;
        }
        value.insert(k, v);
    }
}

#[cfg(test)]
mod merge_tests {
    use super::*;

    #[test]
    fn a_check_of_one_profile_keeps_the_others() {
        let mut value = serde_json::json!({
            "gears": ["a"],
            "checks": {"prod": {"ok": true}, "dev": {"ok": true}},
        })
        .as_object()
        .cloned()
        .unwrap();
        let patch = serde_json::json!({
            "gears": ["b"],
            "checks": {"dev": {"ok": false}},
        })
        .as_object()
        .cloned()
        .unwrap();
        merge_product_patch(&mut value, patch);
        assert_eq!(value["gears"], serde_json::json!(["b"]));
        assert_eq!(value["checks"]["prod"]["ok"], true);
        assert_eq!(value["checks"]["dev"]["ok"], false);
        // A record from before checks were kept takes them as they come.
        let mut old = serde_json::Map::new();
        merge_product_patch(
            &mut old,
            serde_json::json!({"checks": {"prod": {"ok": true}}})
                .as_object()
                .cloned()
                .unwrap(),
        );
        assert_eq!(old["checks"]["prod"]["ok"], true);
    }
}

#[cfg(test)]
mod latest_record_tests {
    use super::*;

    #[test]
    fn the_newest_record_under_the_key_is_the_projects() {
        let node = |key: &str, at: &str, gears: u32| GtsNode {
            type_id: gts::PROJECT_PRODUCT_TYPE,
            instance_id: key.to_owned(),
            value: serde_json::json!({"updated_at": at, "gears": gears}),
        };
        let nodes = vec![
            node("k", "2026-10-19T10:40:05Z", 66),
            node("other", "2026-12-01T00:00:00Z", 1),
            node("k", "2026-11-03T14:29:51Z", 71),
        ];
        assert_eq!(latest_record(nodes, "k").unwrap().value["gears"], 71);
        assert!(latest_record(Vec::new(), "k").is_none());
    }
}

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
