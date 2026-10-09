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

use super::gearbox::Gearbox;

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
        let files = super::new_gear::files(gearbox.as_deref(), &target.repo, gear).await?;
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
