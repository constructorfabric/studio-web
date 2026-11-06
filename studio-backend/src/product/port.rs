//! What another gear asks studio-product for, through the ClientHub.
//!
//! - [`ProjectProducts`]: a project's records. The catalogue reads a
//!   project's gear repository through it to say what the project's code
//!   depends on.
//! - [`engine`]: the Gearbox engine, when this deployment configures one. The
//!   catalogue asks it what each gear's `gear.gdl` says and checks the gears
//!   repository out with it, so the catalogue and the previews read one
//!   corpus.
//! - [`GearDeclarations`]: Declare it (ADR-0041 P3) -- the manifest that
//!   makes existing code a gear, written on a branch with a pull request.
//! - [`GearContributions`]: Publish (ADR-0042 §4) -- a gear's files written
//!   into the platform's gear repository, with a pull request.
//!
//! All are resolved when used, so a consumer does not depend on the order
//! gears start in.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// Each gear's `config` in a description, as JSON, by gear or plugin id.
pub use super::description_edit::gear_configs;
use super::gearbox::Gearbox;
/// Where a product's description goes when nothing recorded another path:
/// `products/<id>/product.gdl`.
pub use super::gearbox::product_gdl_path;
/// The commits a build takes for each source a description uses (ADR-0060
/// §3): studio-environments resolves them before it queues a build.
pub use super::sources_lock::{SourceRefs, build_refs};

#[async_trait]
pub trait ProjectProducts: Send + Sync + 'static {
    /// The gear repository connected to a project, as recorded:
    /// `{tenant, connection_id, repo, branch}`. `None` when none is connected.
    async fn gear_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Value>>;

    /// The gears the project's product picks, as recorded (crate names or
    /// engine ids). `None` before anything was picked. The registry's
    /// consumer graph reads it (ADR-0041 P4).
    async fn product_gears(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Vec<String>>>;

    /// Where the Product step last committed the product's description:
    /// its path in the repository, and the branch, `None` when it went onto
    /// the repository's own. `None` before it was ever written. A build that
    /// names nothing builds this.
    async fn saved_description(
        &self,
        _ctx: &SecurityContext,
        _project_id: &str,
    ) -> anyhow::Result<Option<SavedDescription>> {
        Ok(None)
    }

    /// The latest revision of the project's description, which Studio keeps
    /// (ADR-0053): what a build lays at the product's path before it
    /// generates. `None` before anything was saved, or in a deployment that
    /// keeps none -- the build then reads the file in the checkout.
    async fn latest_description(
        &self,
        _ctx: &SecurityContext,
        _project_id: Uuid,
    ) -> anyhow::Result<Option<DescriptionRevision>> {
        Ok(None)
    }
}

/// [`ProjectProducts::latest_description`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DescriptionRevision {
    pub revision: i64,
    pub text: String,
    /// Where it goes in the repository, when the record says.
    pub path: Option<String>,
    /// The commit of each source the text uses, pinned at save (ADR-0060
    /// §3); `None` for a revision saved before locks were kept.
    pub sources_lock: Option<super::sources_lock::SourcesLock>,
    /// The project sources the text uses, each at its branch now: what a dev
    /// build takes.
    pub planned: Vec<super::sources_lock::LockedSource>,
}

/// [`ProjectProducts::saved_description`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedDescription {
    pub path: String,
    pub branch: Option<String>,
}

/// The `written` of a product record, as a [`SavedDescription`]; for a
/// record with only a Studio revision (ADR-0053), its path and no branch.
/// The path is the recorded one, else the product's own
/// `products/<product_id>/product.gdl` (`description_path`); `None` before
/// anything was written or kept, or for a record that names no product.
pub fn saved_of(record: &Value) -> Option<SavedDescription> {
    let written = record.get("written");
    if written.is_none() && record.get("description").is_none() {
        return None;
    }
    let path = super::service::description_service::description_path(Some(record))?;
    let branch = written
        .and_then(|w| w.get("branch"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    Some(SavedDescription { path, branch })
}

/// The picks of a product record: its `gears`, trimmed, blanks dropped.
pub fn picks_of(record: &Value) -> Option<Vec<String>> {
    let gears = record.get("gears")?.as_array()?;
    Some(
        gears
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|g| !g.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

#[async_trait]
impl ProjectProducts for super::service::ProductService {
    async fn gear_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        Ok(self
            .get_project_repo(ctx, project_id)
            .await?
            .map(|n| n.value))
    }

    async fn product_gears(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Vec<String>>> {
        Ok(self
            .get_project_product(ctx, project_id)
            .await?
            .and_then(|n| picks_of(&n.value)))
    }

    async fn saved_description(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<SavedDescription>> {
        Ok(self
            .get_project_product(ctx, project_id)
            .await?
            .and_then(|n| saved_of(&n.value)))
    }

    async fn latest_description(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<Option<DescriptionRevision>> {
        if self.descriptions().is_none() {
            return Ok(None);
        }
        // The service's own (inherent) read, which takes over a project's
        // last saved description the first time (ADR-0053 §5).
        let Some(latest) =
            super::service::ProductService::latest_description(self, ctx, project_id).await?
        else {
            return Ok(None);
        };
        let record = self
            .get_project_product(ctx, &project_id.to_string())
            .await?
            .map(|n| n.value);
        let path = super::service::description_service::description_path(record.as_ref());
        let sources = self.project_sources(ctx, &project_id.to_string()).await;
        let planned = super::sources_lock::plan(
            &super::sources_lock::sources(&latest.text),
            path.as_deref().unwrap_or("product.gdl"),
            &sources,
            crate::project_sources::description_home(&sources),
        )
        .into_iter()
        .map(|(l, _)| l)
        .collect();
        Ok(Some(DescriptionRevision {
            revision: latest.revision,
            text: latest.text,
            path,
            sources_lock: latest.sources_lock,
            planned,
        }))
    }
}

#[cfg(test)]
mod saved_tests {
    use super::*;

    #[test]
    fn a_record_says_where_its_description_was_written() {
        let r = serde_json::json!({ "written": {
            "branch": "product/shop-1a2b3c4d", "commit_sha": "abc", "path": "products/shop/product.gdl" } });
        assert_eq!(
            saved_of(&r),
            Some(SavedDescription {
                path: "products/shop/product.gdl".into(),
                branch: Some("product/shop-1a2b3c4d".into()),
            })
        );
        // Without a recorded path it is the product's own, never the root's.
        let onto_base = serde_json::json!({ "product_id": "shop",
            "written": { "branch": null, "commit_sha": "abc" } });
        assert_eq!(
            saved_of(&onto_base),
            Some(SavedDescription {
                path: "products/shop/product.gdl".into(),
                branch: None
            })
        );
        let nameless = serde_json::json!({ "written": { "branch": null, "commit_sha": "abc" } });
        assert_eq!(saved_of(&nameless), None);
        let at_root =
            serde_json::json!({ "product_id": "shop", "written": { "path": "product.gdl" } });
        assert_eq!(
            saved_of(&at_root).map(|s| s.path).as_deref(),
            Some("product.gdl")
        );
        assert_eq!(saved_of(&serde_json::json!({ "gears": [] })), None);
    }
}

/// [`ProjectProducts`], resolved from the ClientHub when used.
#[derive(Clone)]
pub struct Products {
    hub: Arc<ClientHub>,
}

impl Products {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    /// `None` before studio-product has published it, or in an assembly
    /// without it.
    pub fn get(&self) -> Option<Arc<dyn ProjectProducts>> {
        self.hub.get::<dyn ProjectProducts>().ok()
    }
}

/// The Gearbox engine studio-product published at `init`. `None` when
/// `STUDIO_GEARBOX_WORKDIR` is not set, or in an assembly without the gear.
pub fn engine(hub: &ClientHub) -> Option<Arc<Gearbox>> {
    hub.get::<Gearbox>().ok()
}

/// Which corpus a request in `tenant` reads (ADR-0046): its organization's --
/// the platform's gear repositories, then the organization's own, read into
/// the engine when due -- or the platform's when `tenant` is in none. The
/// caller has already shown that `ctx` reaches `tenant`.
pub async fn engine_scope(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    tenant: Uuid,
) -> super::gearbox::Scope {
    let gearbox = engine(hub)?;
    let am = hub
        .get::<dyn account_management_sdk::AccountManagementClient>()
        .ok()?;
    let org = crate::organizations::sdk::organization_of(am.as_ref(), ctx, tenant).await;
    let connectors = crate::connectors::sdk::Connectors::new(Arc::clone(hub));
    super::gear_roots::scope_for(&gearbox, &connectors, hub, ctx, org, false).await
}

/// `router` with the platform's gear repositories read into the engine on the
/// way into a route that may run it (ADR-0046). A gear whose routes use the
/// engine wraps them with this; without an engine it is `router` unchanged.
pub fn with_gear_roots(router: axum::Router, hub: &Arc<ClientHub>) -> axum::Router {
    let Some(gearbox) = engine(hub) else {
        return router;
    };
    let connectors = crate::connectors::sdk::Connectors::new(Arc::clone(hub));
    router.layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let gearbox = Arc::clone(&gearbox);
            let connectors = connectors.clone();
            async move { super::gear_roots::layer(gearbox, connectors, request, next).await }
        },
    ))
}

// ── Declare it (ADR-0041 P3) ──────────────────────────────────────────────────

/// Existing code to declare a gear: where its manifest goes and what it says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeclarationSpec {
    /// The gear's name, kebab-case: the engine's id for its `gear.gdl`.
    pub name: String,
    /// The directory the manifest is written into: the module's or crate's.
    pub dir: String,
    pub description: String,
    pub category: Option<String>,
    pub capabilities: Vec<String>,
    pub plugin: bool,
}

/// Which manifest a declaration's paths write: `gear.gdl` or `gear.toml`.
pub use super::skeleton::declaration_manifest;

/// One file a declaration writes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclarationFile {
    pub path: String,
    pub content: String,
}

/// The repository a declaration is written into, through which connection,
/// and the branch its pull request goes back to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryTarget {
    /// The tenant whose connection reaches the repository.
    pub tenant: Uuid,
    pub connection_id: Option<Uuid>,
    /// `owner/name`.
    pub repo: String,
    pub base_branch: String,
}

/// The words of a declaration's commit and pull request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequestText {
    pub message: String,
    pub title: String,
    pub body: String,
}

/// Where a declaration landed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclarationWritten {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
}

/// What studio-product offers for declaring existing code a gear: the files
/// (`gear.toml`, and `gear.gdl` from the engine when one is configured), and
/// writing them on a branch with a pull request, through the repository's
/// connection. The catalogue's registry asks it for Declare it.
#[async_trait]
pub trait GearDeclarations: Send + Sync {
    /// The files a declaration writes. Nothing is written.
    async fn declaration_files(
        &self,
        spec: &DeclarationSpec,
    ) -> anyhow::Result<Vec<DeclarationFile>>;

    /// Commit `files` onto `branch` off the target's base branch and open a
    /// pull request back (or answer the one already open). `ctx` must reach
    /// the target's connection: the project's tenant.
    async fn open_declaration(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten>;
}

/// How another gear writes into a project's repository, the one its product
/// description goes to: read a file there, and commit files the way the
/// repository takes changes (its source's `share_mode`), or always as a
/// pull request when what is written is only a proposal.
#[async_trait]
pub trait ProjectFiles: Send + Sync {
    /// `path`'s text on the repository's base branch; `None` when absent.
    async fn read(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        path: &str,
    ) -> anyhow::Result<Option<String>>;

    /// Commit `files`. With `propose`, or when the repository takes changes
    /// as pull requests, they go on `branch` with a pull request; when it
    /// takes them straight onto its branch, they are committed there.
    async fn write(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
        propose: bool,
    ) -> anyhow::Result<DeclarationWritten>;

    /// Where the project's repository is: the one its product description
    /// lives in, through a connection the caller may use.
    async fn repository(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<RepositoryTarget>;

    /// Open an issue in the project's repository, assigned to the given host
    /// accounts: `(number, url)`.
    async fn create_issue(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        title: &str,
        body: &str,
        assignees: &[String],
    ) -> anyhow::Result<(i64, Option<String>)>;
}

/// studio-product's [`ProjectFiles`]: its own project writer.
pub struct Files {
    service: Arc<super::service::ProductService>,
}

impl Files {
    pub(super) fn new(service: Arc<super::service::ProductService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl ProjectFiles for Files {
    async fn repository(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<RepositoryTarget> {
        self.service.project_repository(ctx, project_id).await
    }

    async fn read(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        path: &str,
    ) -> anyhow::Result<Option<String>> {
        self.service.read_project_file(ctx, project_id, path).await
    }

    async fn write(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
        propose: bool,
    ) -> anyhow::Result<DeclarationWritten> {
        let onto_base = !propose
            && matches!(
                self.service.write_share_mode(ctx, project_id).await,
                Some(crate::project_sources::ShareMode::Branch)
            );
        let files: Vec<super::scaffold::ScaffoldFile> = files
            .iter()
            .map(|f| super::scaffold::ScaffoldFile {
                path: f.path.clone(),
                content: f.content.clone(),
            })
            .collect();
        let w = self
            .service
            .write_to_project_repo(
                ctx,
                project_id,
                (!onto_base).then_some(branch),
                &files,
                &text.message,
                (!onto_base).then_some(text.title.as_str()),
            )
            .await?;
        Ok(DeclarationWritten {
            branch: w.branch,
            commit_sha: w.commit_sha,
            pr_url: w.pr_url,
        })
    }

    async fn create_issue(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        title: &str,
        body: &str,
        assignees: &[String],
    ) -> anyhow::Result<(i64, Option<String>)> {
        self.service
            .create_project_issue(ctx, project_id, title, body, assignees)
            .await
    }
}

/// studio-product's [`GearDeclarations`]: the skeleton's manifest, the
/// engine's `gear.gdl`, and the scaffold's writer.
pub struct Declarations {
    service: Arc<super::service::ProductService>,
    hub: Arc<ClientHub>,
}

impl Declarations {
    pub(super) fn new(service: Arc<super::service::ProductService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

#[async_trait]
impl GearDeclarations for Declarations {
    async fn declaration_files(
        &self,
        spec: &DeclarationSpec,
    ) -> anyhow::Result<Vec<DeclarationFile>> {
        let slug = super::skeleton::gear_slug(&spec.name);
        // The engine's own description, so the gear is composable from its
        // first commit; without an engine, or when it refuses, the manifest
        // alone declares it.
        let gdl = match engine(&self.hub) {
            Some(gearbox) => match gearbox
                .scaffold_gdl(super::gearbox::GearScaffold {
                    crate_name: slug.clone(),
                    name: super::skeleton::title_case(&slug),
                    kind: super::gearbox::GearKind::Service,
                    plugin: None,
                })
                .await
            {
                Ok(gdl) => Some(gdl),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), gear = %slug, "gearbox: no gear.gdl for the declaration");
                    None
                }
            },
            None => None,
        };
        Ok(super::skeleton::declaration(
            &spec.dir,
            &slug,
            &spec.description,
            spec.category.as_deref(),
            &spec.capabilities,
            spec.plugin,
            gdl,
        )
        .into_iter()
        .map(|f| DeclarationFile {
            path: f.path,
            content: f.content,
        })
        .collect())
    }

    async fn open_declaration(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        let files: Vec<super::scaffold::ScaffoldFile> = files
            .iter()
            .map(|f| super::scaffold::ScaffoldFile {
                path: f.path.clone(),
                content: f.content.clone(),
            })
            .collect();
        let w = self
            .service
            .write_to_repository(ctx, target, branch, &files, text)
            .await?;
        Ok(DeclarationWritten {
            branch: w.branch,
            commit_sha: w.commit_sha,
            pr_url: w.pr_url,
        })
    }
}

// ── Publish: give a gear to the platform (ADR-0042 §4) ────────────────────────

/// What studio-product offers for contributing a gear to the platform: the
/// gear's files, already read and placed by the catalogue's registry, written
/// on a branch of the platform's gear repository with a pull request back.
/// The registry's `publish` decision asks it.
#[async_trait]
pub trait GearContributions: Send + Sync {
    /// Commit `files` onto `branch` off the target's base branch and open a
    /// pull request back (or answer the one already open). `ctx` must reach
    /// the target's connection: the platform's (root) tenant.
    async fn contribute(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten>;

    /// [`Self::contribute`], with `deleted` removed in the same commit: the
    /// pull request Extract opens into the project a gear leaves
    /// (ADR-0044). A writer that cannot delete refuses one that would.
    async fn contribute_changes(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        deleted: &[String],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        if deleted.is_empty() {
            return self.contribute(ctx, target, branch, files, text).await;
        }
        anyhow::bail!("this writer cannot delete files")
    }

    /// Tag the tip of the target's base branch as `tag` (Extract's version,
    /// `<gear>/vX.Y.Z`); answers the commit tagged. A tag already there is
    /// not an error.
    async fn tag(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        tag: &str,
    ) -> anyhow::Result<String> {
        let _ = (ctx, target, tag);
        anyhow::bail!("this writer cannot create tags")
    }
}

/// studio-product's [`GearContributions`]: the scaffold's writer.
pub struct Contributions {
    service: Arc<super::service::ProductService>,
}

impl Contributions {
    pub(super) fn new(service: Arc<super::service::ProductService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl GearContributions for Contributions {
    async fn contribute(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        let files: Vec<super::scaffold::ScaffoldFile> = files
            .iter()
            .map(|f| super::scaffold::ScaffoldFile {
                path: f.path.clone(),
                content: f.content.clone(),
            })
            .collect();
        let w = self
            .service
            .write_to_repository(ctx, target, branch, &files, text)
            .await?;
        Ok(DeclarationWritten {
            branch: w.branch,
            commit_sha: w.commit_sha,
            pr_url: w.pr_url,
        })
    }

    async fn contribute_changes(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        deleted: &[String],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        let files: Vec<super::scaffold::ScaffoldFile> = files
            .iter()
            .map(|f| super::scaffold::ScaffoldFile {
                path: f.path.clone(),
                content: f.content.clone(),
            })
            .collect();
        let w = self
            .service
            .write_changes_to_repository(ctx, target, branch, &files, deleted, text)
            .await?;
        Ok(DeclarationWritten {
            branch: w.branch,
            commit_sha: w.commit_sha,
            pr_url: w.pr_url,
        })
    }

    async fn tag(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        tag: &str,
    ) -> anyhow::Result<String> {
        self.service.tag_repository(ctx, target, tag).await
    }
}

// ── Create a gear (ADR-0042 §2) ───────────────────────────────────────────────

/// A new gear to scaffold: what `POST /projects/{id}/scaffold` takes, less
/// explicit files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewGear {
    /// The gear's slug: its branch `scaffold/<slug>`, directory and crate.
    pub slug: String,
    pub app_title: Option<String>,
    /// The PRD's opening sentence.
    pub problem: Option<String>,
    pub origin: Option<String>,
    /// Directory the gear's own goes under (default `gears`).
    pub parent_dir: Option<String>,
    /// `service` (default), `minimal` or `plugin`.
    pub gear_kind: Option<String>,
    pub plugin_host: Option<String>,
    pub plugin_spec: Option<String>,
    /// The subsystem it belongs to; `None` is `platform`.
    pub category: Option<String>,
    /// Capability keys written into its `gear.toml`.
    pub capabilities: Vec<String>,
    /// Open a pull request back into the base branch.
    pub open_pr: bool,
    /// Answer the files only; nothing is written.
    pub dry_run: bool,
}

/// What a scaffold wrote, or -- on a dry run -- would write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScaffoldOutcome {
    pub branch: String,
    /// Empty on a dry run.
    pub commit_sha: String,
    pub pr_url: Option<String>,
    pub files: Vec<DeclarationFile>,
}

/// Why a scaffold did not happen: the request's mistake, or a failure.
#[derive(Debug)]
pub enum ScaffoldFailure {
    Invalid(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for ScaffoldFailure {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

/// What studio-product offers for writing a new gear into a repository it
/// does not keep the record of: the organization's gear repository, which
/// the catalogue's registry keeps (`POST /registry/scaffold`). The skeleton
/// is the one a project's scaffold writes.
#[async_trait]
pub trait GearScaffolds: Send + Sync {
    /// Generate `gear`'s files and -- unless `dry_run` -- commit them onto
    /// `scaffold/<slug>` off the target's base branch, with a pull request
    /// when `open_pr`. `ctx` must reach the target's connection.
    async fn scaffold_into(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        gear: &NewGear,
    ) -> Result<ScaffoldOutcome, ScaffoldFailure>;
}

/// studio-product's [`GearScaffolds`].
pub struct Scaffolds {
    service: Arc<super::service::ProductService>,
    hub: Arc<ClientHub>,
}

impl Scaffolds {
    pub(super) fn new(service: Arc<super::service::ProductService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

#[async_trait]
impl GearScaffolds for Scaffolds {
    async fn scaffold_into(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        gear: &NewGear,
    ) -> Result<ScaffoldOutcome, ScaffoldFailure> {
        let gearbox = engine(&self.hub);
        let scope = engine_scope(&self.hub, ctx, ctx.subject_tenant_id()).await;
        let files = super::new_gear::files(gearbox.as_deref(), scope, &target.repo, gear).await?;
        let listed: Vec<DeclarationFile> = files
            .iter()
            .map(|f| DeclarationFile {
                path: f.path.clone(),
                content: f.content.clone(),
            })
            .collect();
        let slug = super::skeleton::gear_slug(&gear.slug);
        if gear.dry_run {
            return Ok(ScaffoldOutcome {
                branch: format!("scaffold/{slug}"),
                commit_sha: String::new(),
                pr_url: None,
                files: listed,
            });
        }
        let w = self
            .service
            .scaffold_into_target(
                ctx,
                ctx.subject_tenant_id(),
                target,
                &slug,
                &files,
                gear.open_pr,
            )
            .await?;
        Ok(ScaffoldOutcome {
            branch: w.branch,
            commit_sha: w.commit_sha,
            pr_url: w.pr_url,
            files: listed,
        })
    }
}
