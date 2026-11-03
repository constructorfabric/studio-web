//! Building and running a product on Constructor Research (ADR-0049 §3, §4),
//! through the Research connector and Research's own public API.
//!
//! **Build.** Studio prepares the product on its own server -- the same
//! `prepare` a cluster build's Job runs: clone, `gearbox generate`, a
//! buildable tree -- and renders its chart as the deploy will, to learn what
//! each image must carry that a Research service cannot be given: the files
//! the chart mounts from ConfigMaps, the command and the scratch folders
//! (`research_app`). Each generated Dockerfile gains those lines, the tree
//! goes into a desk of the Research project (WebDAV), and Research builds one
//! image per Dockerfile there. The build's record says `where: research` and
//! names each image as `research-image/<bake>/<name>:<id>`. Research keeps no
//! chart, so none is published.
//!
//! **Deploy.** A deploy prepares the product again at the build's commit,
//! renders its chart with the build's images (`helm template`) and makes the
//! environment's application run exactly those services, one call each. The
//! deploy's record ends with where the product opens.
//!
//! The connection is the member's own, signed in personally (ADR-0049 §5).
//! A background run is the organization's service, which cannot read a
//! personal sign-in, so a run carries who asked ([`Requester`]) and reads
//! that member's connection as them -- that one credential, for the build or
//! deploy they asked for, and nothing else.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, anyhow, bail};
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::build::{self, RepoRef};
use super::research_app::{self, Application, Inputs};
use crate::connectors::sdk::research::{ImageBuild, Pace, Renew, ResearchApi};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

pub const BUILD_TASK_TYPE: &str = "environments.research.build";

/// Where in the build context Studio lays out what an image carries.
const OVERLAY_DIR: &str = "studio-research";

/// The member a Research run acts for: whose sign-in it reads, in the tenant
/// they asked in (where their personal connection's token was stored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requester {
    pub subject_id: Uuid,
    pub tenant_id: Uuid,
}

impl Requester {
    pub fn of(ctx: &SecurityContext) -> Self {
        Self {
            subject_id: ctx.subject_id(),
            tenant_id: ctx.subject_tenant_id(),
        }
    }

    /// The member as a reader of their own connection.
    fn context(&self) -> anyhow::Result<SecurityContext> {
        SecurityContext::builder()
            .subject_id(self.subject_id)
            .subject_type("user")
            .subject_tenant_id(self.tenant_id)
            .build()
            .map_err(|e| anyhow!("cannot act for the member who asked: {e}"))
    }
}

/// The access token of connection `connection_id`, read as `ctx`: each read
/// trades the stored refresh token for a fresh one.
async fn token(
    hub: Arc<ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
    connection_id: Uuid,
) -> anyhow::Result<(String, String)> {
    let connectors = crate::connectors::sdk::Connectors::new(hub)
        .get()
        .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
    let (_, auth, connection) = connectors
        .driver_and_auth(ctx, org, connection_id)
        .await
        .map_err(|e| anyhow!("the Constructor Research connection cannot be used: {e:#}"))?;
    if connection.provider != crate::connectors::sdk::RESEARCH_PROVIDER {
        bail!(
            "connection '{}' is not a Constructor Research one",
            connection.label
        );
    }
    Ok((auth.root().to_owned(), auth.token))
}

/// The Research connector's calls through connection `connection_id`, read
/// as `ctx` -- or, for a background run, as the member who asked. A token
/// Research stops accepting (they last an hour; a build may take longer) is
/// renewed from the connection.
pub async fn api(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
    connection_id: Uuid,
    requester: Option<&Requester>,
) -> anyhow::Result<ResearchApi> {
    let ctx = match requester {
        Some(r) => r.context()?,
        None => ctx.clone(),
    };
    let (root, first) = token(Arc::clone(hub), &ctx, org, connection_id).await?;
    let hub = Arc::clone(hub);
    let renew: Renew = Arc::new(move || -> BoxFuture<'static, anyhow::Result<String>> {
        let (hub, ctx) = (Arc::clone(&hub), ctx.clone());
        Box::pin(async move { Ok(token(hub, &ctx, org, connection_id).await?.1) })
    });
    Ok(ResearchApi::new(reqwest::Client::new(), &root, first).renewing(renew))
}

/// A product prepared on this server, in a folder removed with it.
struct Tree {
    work: PathBuf,
    prepared: build::Prepared,
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.work);
    }
}

/// Clone the product's repository at `git_ref` and prepare it, as a cluster
/// build's `prepare` step does.
async fn prepare(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    repo: &RepoRef,
    git_ref: Option<String>,
    description: Option<(Option<i64>, String)>,
    product_file: &str,
    profile: &str,
) -> anyhow::Result<Tree> {
    let connectors = crate::connectors::sdk::Connectors::new(Arc::clone(hub))
        .get()
        .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
    let (driver, auth, _) = connectors
        .driver_and_auth(ctx, repo.tenant, repo.connection_id)
        .await
        .map_err(|e| anyhow!("the repository's connection cannot be used by the server: {e:#}"))?;
    let url = driver.clone_url(&auth.base_url, &repo.repo)?;
    let (username, password) = driver.clone_credentials(&auth.token);
    let (username, password) = (username.to_owned(), password.to_owned());
    // A product branch lends only its description; the code is the base
    // branch's (ADR-0053 §4).
    let (git_ref, description_ref) =
        build::code_and_description_refs(git_ref.as_deref(), &repo.branch);
    let (product_file, profile) = (product_file.to_owned(), profile.to_owned());
    let work = std::env::temp_dir().join(format!("studio-research-{}", Uuid::new_v4().simple()));
    let at = work.clone();
    let prepared = tokio::task::spawn_blocking(move || -> anyhow::Result<build::Prepared> {
        std::fs::create_dir_all(&at)?;
        build::prepare_as(
            &at,
            &url,
            (&username, &password),
            Some(&git_ref),
            // Studio's revision first (ADR-0053 §2), else a product
            // branch's file (§4), else the checkout's.
            &match (&description, description_ref.as_deref()) {
                (Some((revision, text)), _) => build::DescriptionFrom::Text {
                    revision: *revision,
                    text,
                },
                (None, Some(r)) => build::DescriptionFrom::Ref(r),
                (None, None) => build::DescriptionFrom::Checkout,
            },
            &product_file,
            &profile,
        )?;
        serde_json::from_slice(&std::fs::read(at.join("build.json"))?)
            .context("prepare left no build.json")
    })
    .await
    .context("the prepare step stopped")
    .and_then(|r| r);
    match prepared {
        Ok(prepared) => Ok(Tree { work, prepared }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&work);
            Err(e)
        }
    }
}

/// The prepared chart rendered as `release` in `namespace` with `values`.
async fn render(
    tree: &Tree,
    release: &str,
    namespace: &str,
    values: &serde_json::Value,
) -> anyhow::Result<String> {
    let file = tree
        .work
        .join(format!("values-{}.json", Uuid::new_v4().simple()));
    tokio::fs::write(&file, serde_json::to_vec(values)?).await?;
    let out = tokio::process::Command::new(super::deploy::helm_binary())
        .args([
            "template",
            release,
            &tree.prepared.chart_dir,
            "--namespace",
            namespace,
            "--values",
        ])
        .arg(&file)
        .env("HELM_CACHE_HOME", tree.work.join(".helm/cache"))
        .env("HELM_CONFIG_HOME", tree.work.join(".helm/config"))
        .env("HELM_DATA_HOME", tree.work.join(".helm/data"))
        .output()
        .await
        .context("helm could not be run")?;
    if !out.status.success() {
        bail!(
            "helm template failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    String::from_utf8(out.stdout).context("helm's output is not text")
}

/// One image `prepare` listed: its Dockerfile and context, relative to the
/// work folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildImage {
    pub app: String,
    pub name: String,
    pub dockerfile: String,
    pub context: String,
}

/// The images `prepare` listed in `apps` (`app name dockerfile-dir context`),
/// their paths made relative to the work folder.
pub fn build_images(apps: &str, work: &Path) -> anyhow::Result<Vec<BuildImage>> {
    let rel = |p: &str| -> anyhow::Result<String> {
        let rel = Path::new(p)
            .strip_prefix(work)
            .map_err(|_| anyhow!("{p} is outside the prepared tree"))?;
        Ok(rel.to_string_lossy().replace('\\', "/"))
    };
    apps.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            let [app, name, dockerfile, context] = f.as_slice() else {
                bail!("'{line}' is not an application prepare listed");
            };
            let dir = rel(dockerfile)?;
            Ok(BuildImage {
                app: (*app).to_owned(),
                name: (*name).to_owned(),
                dockerfile: if dir.is_empty() {
                    "Dockerfile".into()
                } else {
                    format!("{dir}/Dockerfile")
                },
                context: match rel(context)? {
                    c if c.is_empty() => ".".into(),
                    c => c,
                },
            })
        })
        .collect()
}

/// The values a build renders the chart with: the binding's, each
/// application at a placeholder image, and the configuration secret --
/// what the deploy's values are but for the images (`model::deploy_values`).
fn build_values(
    binding: Option<&serde_json::Value>,
    images: &[BuildImage],
    secret_keys: &[String],
    release: &str,
) -> serde_json::Value {
    let mut values = binding
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    for i in images {
        super::model::merge(
            &mut values,
            serde_json::json!({ i.app.clone(): { "image": {
                "repository": format!("{}/{}", research_app::PENDING_IMAGE, i.app),
                "tag": "build",
            }}}),
        );
        if !secret_keys.is_empty() {
            super::model::merge(
                &mut values,
                serde_json::json!({ i.app.clone(): {
                    "existingSecret": super::model::config_secret_name(release),
                    "secretKeys": secret_keys,
                }}),
            );
        }
    }
    values
}

/// Write `text` at `path`, making its folder.
fn write(path: &Path, text: &str) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, text).with_context(|| format!("{} could not be written", path.display()))
}

/// What a build lays out for Research in `root` (the uploaded folder): per
/// image a Dockerfile in its context folder -- Research builds with the
/// Dockerfile's folder as the context -- with what the chart mounts and runs
/// baked in, and the database servers' Postgres images. The images to build
/// and the digest of what each carries.
fn lay_out(
    work: &Path,
    root: &Path,
    images: &[BuildImage],
    app: &Application,
    database_image: &str,
) -> anyhow::Result<(Vec<ImageBuild>, BTreeMap<String, String>)> {
    let rel = |p: &Path| -> anyhow::Result<String> {
        Ok(p.strip_prefix(root)
            .map_err(|_| anyhow!("{} is outside the uploaded tree", p.display()))?
            .to_string_lossy()
            .replace('\\', "/"))
    };
    let mut builds = Vec::new();
    let mut bakes = BTreeMap::new();
    for i in images {
        let pending = format!("{}/{}:build", research_app::PENDING_IMAGE, i.app);
        let spec = app.services.iter().find(|s| s.image == pending);
        let context = work.join(&i.context);
        let source = work.join(&i.dockerfile);
        let mut text = std::fs::read_to_string(&source)
            .with_context(|| format!("no Dockerfile for {}", i.app))?;
        let dir = format!("{OVERLAY_DIR}/{}", i.app);
        if let Some(spec) = spec {
            text.push_str(&spec.overlay(&dir));
            for (path, content) in spec.overlay_files() {
                write(&context.join(&dir).join(path), &content)?;
            }
        }
        let dockerfile = context.join(format!("Dockerfile.studio-{}", i.app));
        write(&dockerfile, &text)?;
        // The generated ignore file sits beside the generated Dockerfile; it
        // goes beside this one, and keeps what Studio lays out.
        let keep = format!("\n!{OVERLAY_DIR}/\n!{OVERLAY_DIR}/**\n");
        let generated = source.with_file_name("Dockerfile.dockerignore");
        let ignore = std::fs::read_to_string(&generated).ok();
        if let Some(ignore) = &ignore {
            write(
                &dockerfile.with_file_name(format!("Dockerfile.studio-{}.dockerignore", i.app)),
                &format!("{ignore}{keep}"),
            )?;
        }
        let context_ignore = context.join(".dockerignore");
        match std::fs::read_to_string(&context_ignore) {
            Ok(own) if !own.contains(&keep) => write(&context_ignore, &format!("{own}{keep}"))?,
            Ok(_) => {}
            Err(_) => {
                if let Some(ignore) = &ignore {
                    write(&context_ignore, &format!("{ignore}{keep}"))?;
                }
            }
        }
        builds.push(ImageBuild {
            key: i.app.clone(),
            name: research_app::image_name(&i.name),
            dockerfile: rel(&dockerfile)?,
        });
        bakes.insert(
            i.app.clone(),
            spec.map(|s| s.bake()).unwrap_or_else(|| "none".into()),
        );
    }
    for db in app.services.iter().filter(|s| s.database) {
        let dir = root.join(format!("{OVERLAY_DIR}-db")).join(&db.name);
        let mut text = format!("FROM {database_image}\n");
        text.push_str(&db.overlay("."));
        for (path, content) in db.overlay_files() {
            write(&dir.join(path), &content)?;
        }
        let dockerfile = dir.join("Dockerfile");
        write(&dockerfile, &text)?;
        let key = research_app::database_key(&db.name);
        builds.push(ImageBuild {
            key: key.clone(),
            name: research_app::image_name(&format!("studio-db-{}", db.name)),
            dockerfile: rel(&dockerfile)?,
        });
        bakes.insert(key, db.bake());
    }
    Ok((builds, bakes))
}

/* ── build ── */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchBuildPayload {
    pub build_id: String,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    /// The environment's `research` connection.
    pub connection_id: Uuid,
    /// The Research project the images are built in.
    pub research_project: String,
    pub profile: String,
    pub product_file: String,
    pub repo: RepoRef,
    #[serde(default)]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub records_in: Option<Uuid>,
    /// See [`build::BuildPayload::description_revision`] (ADR-0053 §2).
    #[serde(default)]
    pub description_revision: Option<i64>,
    #[serde(default)]
    pub description_text: Option<String>,
    /// Whose Research sign-in the build uses.
    #[serde(default)]
    pub requested_by: Option<Requester>,
    /// The application a deploy puts the build in, which is also the
    /// namespace its chart is rendered for. The build renders the chart as
    /// that deploy will, with the binding's values and secret keys.
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub values: Option<serde_json::Value>,
    #[serde(default)]
    pub secret_keys: Vec<String>,
    /// What a database server's Postgres image is built from.
    #[serde(default)]
    pub database_image: Option<String>,
}

pub struct ResearchBuildTask {
    hub: Arc<ClientHub>,
}

impl ResearchBuildTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    async fn record(
        &self,
        ctx: &SecurityContext,
        p: &ResearchBuildPayload,
        outcome: crate::artifact_ingest::port::BuildOutcome,
    ) {
        let outcome = crate::artifact_ingest::port::BuildOutcome {
            r#where: Some("research".into()),
            description_revision: outcome.description_revision.or(p.description_revision),
            ..outcome
        };
        if let Err(e) =
            build::record_outcome(&self.hub, ctx, p.records_in, p.project_id, outcome).await
        {
            tracing::warn!(build = %p.build_id, error = %e, "studio-environments: a Research build could not be recorded");
        }
    }

    async fn step(&self, ctx: &TaskContext, p: &ResearchBuildPayload, step: &str) {
        ctx.progress(step.to_owned()).await;
        let mut running = crate::artifact_ingest::port::BuildOutcome::running(
            &p.build_id,
            &p.repo.repo,
            &p.profile,
        );
        running.step = Some(step.to_owned());
        self.record(&ctx.security, p, running).await;
    }

    async fn build(
        &self,
        ctx: &TaskContext,
        p: &ResearchBuildPayload,
    ) -> Result<crate::artifact_ingest::port::BuildOutcome, (String, String)> {
        use crate::artifact_ingest::port::BuildOutcome;
        let fail = |step: &str| {
            let step = step.to_owned();
            move |e: anyhow::Error| (step, format!("{e:#}"))
        };
        let api = api(
            &self.hub,
            &ctx.security,
            p.organization_id,
            p.connection_id,
            p.requested_by.as_ref(),
        )
        .await
        .map_err(fail("start"))?;

        self.step(ctx, p, "prepare").await;
        let tree = prepare(
            &self.hub,
            &ctx.security,
            &p.repo,
            p.git_ref.clone(),
            p.description_text
                .clone()
                .filter(|t| !t.trim().is_empty())
                .map(|t| (p.description_revision, t)),
            &p.product_file,
            &p.profile,
        )
        .await
        .map_err(fail("prepare"))?;
        let apps = std::fs::read_to_string(tree.work.join("apps"))
            .map_err(|e| fail("prepare")(e.into()))?;
        let images = build_images(&apps, &tree.work).map_err(fail("prepare"))?;

        // The chart as the deploy will render it: what each image carries.
        let release = tree.prepared.product.clone();
        let values = build_values(p.values.as_ref(), &images, &p.secret_keys, &release);
        let rendered = render(&tree, &release, &p.namespace, &values)
            .await
            .map_err(fail("prepare"))?;
        let database_image = p
            .database_image
            .clone()
            .unwrap_or_else(|| super::database::DEFAULT_IMAGE.to_owned());
        let any_secret = |_: &str, _: &str| Some(String::new());
        let no_password = |_: &str| String::new();
        let app = research_app::application_of(
            &rendered,
            &Inputs {
                hardware: None,
                secret: &any_secret,
                database_password: &no_password,
                database_image: &database_image,
                namespace: &p.namespace,
            },
        )
        .map_err(|e| fail("prepare")(e.into()))?;
        let root = tree.work.join("repo");
        let (builds, bakes) =
            lay_out(&tree.work, &root, &images, &app, &database_image).map_err(fail("prepare"))?;

        self.step(ctx, p, "images").await;
        let progress = |m: String| -> BoxFuture<'_, ()> { Box::pin(ctx.progress(m)) };
        let cancelled = || ctx.cancel.is_cancelled();
        let built = api
            .build_in_desk(
                &p.research_project,
                &root,
                &p.build_id,
                &builds,
                Pace::RESEARCH,
                &progress,
                &cancelled,
            )
            .await
            .map_err(fail("images"))?;
        Ok(BuildOutcome {
            build_id: p.build_id.clone(),
            status: "passed".into(),
            product: Some(tree.prepared.product.clone()),
            profile: Some(p.profile.clone()),
            repository: Some(p.repo.repo.clone()),
            commit: Some(tree.prepared.commit.clone()),
            lock_hash: tree.prepared.lock_hash.clone(),
            images: built
                .into_iter()
                .map(|b| {
                    let bake = bakes.get(&b.key).cloned().unwrap_or_default();
                    let reference = research_app::image_reference(&bake, &b.name, &b.id);
                    (b.key, reference)
                })
                .collect(),
            ..BuildOutcome::default()
        })
    }
}

#[async_trait]
impl TaskHandler for ResearchBuildTask {
    fn task_type(&self) -> &'static str {
        BUILD_TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        1
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: ResearchBuildPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "this run's payload is not a Research build ({e})"
                ));
            }
        };
        match self.build(ctx, &p).await {
            Ok(outcome) => {
                let images = outcome.images.len();
                self.record(&ctx.security, &p, outcome).await;
                TaskOutcome::done_with(
                    format!(
                        "Constructor Research built {images} image(s) of {}",
                        p.repo.repo
                    ),
                    serde_json::json!({}),
                )
            }
            Err((step, why)) => {
                let failed = crate::artifact_ingest::port::BuildOutcome::failed(
                    &p.build_id,
                    &p.repo.repo,
                    &p.profile,
                    &why,
                    &step,
                );
                self.record(&ctx.security, &p, failed).await;
                TaskOutcome::Failed(why)
            }
        }
    }
}

/* ── deploy ── */

/// What a deploy to a Research environment needs beyond a cluster deploy's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchDeploy {
    pub research_project: String,
    #[serde(default)]
    pub hardware: Option<String>,
    /// The product's repository and description, prepared again at `commit`.
    pub repo: RepoRef,
    pub product_file: String,
    pub profile: String,
    pub commit: String,
    /// Whose Research sign-in the deploy uses.
    #[serde(default)]
    pub requested_by: Option<Requester>,
}

/// The credstore reference of a database server's password: kept, since the
/// Postgres volume keeps the password it was first started with.
fn database_password_ref(project: Uuid, environment: Uuid, host: &str) -> String {
    format!("studio-env-database-{project}-{environment}-{host}")
}

async fn credstore_text(
    credstore: &dyn credstore_sdk::CredStoreClientV1,
    ctx: &SecurityContext,
    reference: &str,
) -> anyhow::Result<Option<String>> {
    let sref = credstore_sdk::SecretRef::new(reference)
        .map_err(|e| anyhow!("bad secret reference {reference}: {e}"))?;
    let value = credstore
        .get(ctx, &sref)
        .await
        .map_err(|e| anyhow!("credstore: {e}"))?;
    value
        .map(|v| {
            String::from_utf8(v.value.as_bytes().to_vec())
                .map_err(|_| anyhow!("{reference} is not text"))
        })
        .transpose()
}

/// The password of each database server the chart names, made once and kept.
async fn database_passwords(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    project: Uuid,
    environment: Uuid,
    rendered: &str,
) -> anyhow::Result<BTreeMap<String, String>> {
    let credstore = hub
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .map_err(|_| anyhow!("credstore is not available in this deployment"))?;
    let mut out = BTreeMap::new();
    for need in super::database::needs(rendered)? {
        let reference = database_password_ref(project, environment, &need.host);
        let password = match credstore_text(credstore.as_ref(), ctx, &reference).await? {
            Some(p) => p,
            None => {
                let fresh = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                let sref = credstore_sdk::SecretRef::new(&reference).map_err(|e| anyhow!("{e}"))?;
                credstore
                    .create(
                        ctx,
                        &sref,
                        credstore_sdk::SecretValue::new(fresh.clone().into_bytes()),
                        credstore_sdk::SharingMode::Tenant,
                    )
                    .await
                    .map_err(|e| anyhow!("the database password could not be kept: {e}"))?;
                fresh
            }
        };
        out.insert(need.host, password);
    }
    Ok(out)
}

/// The image a deploy's values give `key` (`{key: {image: {repository, tag}}}`).
fn values_image(values: &serde_json::Value, key: &str) -> Option<String> {
    let image = values.get(key)?.get("image")?;
    let repository = image.get("repository")?.as_str()?;
    Some(match image.get("tag").and_then(|t| t.as_str()) {
        Some(tag) => format!("{repository}:{tag}"),
        None => repository.to_owned(),
    })
}

/// Each service of `app` as Research's API takes it, on `hardware`, with its
/// image read back from the build: what the person should know beside.
fn service_bodies(
    app: &Application,
    values: &serde_json::Value,
    hardware: &str,
) -> anyhow::Result<(
    Vec<crate::connectors::sdk::research::ServiceBody>,
    Vec<String>,
)> {
    let mut bodies = Vec::new();
    let mut notes = Vec::new();
    let mut secrets = 0;
    for spec in &app.services {
        let reference = if spec.database {
            values_image(values, &research_app::database_key(&spec.name))
        } else {
            Some(spec.image.clone())
        };
        let image = reference
            .as_deref()
            .and_then(research_app::image_ref)
            .ok_or_else(|| {
                anyhow!(
                    "{} would run {}, which is not an image Constructor Research built for this \
                     product: deploy a build made in Research (a build made before Studio called \
                     Research's own API must be made again)",
                    spec.name,
                    reference.as_deref().unwrap_or("no image")
                )
            })?;
        if image.bake != spec.bake() {
            bail!(
                "what {} carries in its image -- the files the chart mounts, its command, its \
                 scratch folders -- is not what this deploy's chart asks for: the product's \
                 configuration for this environment changed since the build. Build again, then \
                 deploy that build",
                spec.name
            );
        }
        secrets += spec.secret_env.len();
        let (body, more) = spec.body(&image.id, hardware)?;
        notes.extend(more);
        bodies.push(body);
    }
    if secrets > 0 {
        notes.insert(
            0,
            format!(
                "{secrets} secret value(s) are plain environment variables in Constructor \
                 Research: its public API keeps no secret variables, and shows them to whoever \
                 can open the service"
            ),
        );
    }
    Ok((bodies, notes))
}

/// Install `p` into its Research environment; where the product opens.
pub async fn deploy(
    hub: &Arc<ClientHub>,
    ctx: &TaskContext,
    p: &super::deploy::DeployPayload,
    r: &ResearchDeploy,
) -> anyhow::Result<String> {
    let api = api(
        hub,
        &ctx.security,
        p.organization_id,
        p.connection_id,
        r.requested_by.as_ref(),
    )
    .await?;
    let progress = |m: String| -> BoxFuture<'_, ()> { Box::pin(ctx.progress(m)) };
    if p.action == super::model::DeploymentAction::Uninstall {
        ctx.progress(format!("removing application {}", p.namespace))
            .await;
        return match api
            .application_named(&r.research_project, &p.namespace)
            .await?
        {
            Some(app) => {
                api.delete_application(&app.id).await?;
                Ok(format!("{} removed from Constructor Research", p.namespace))
            }
            None => Ok(format!(
                "{} was not in Constructor Research: nothing to remove",
                p.namespace
            )),
        };
    }

    ctx.progress(format!(
        "preparing {} at {}",
        r.repo.repo,
        &r.commit[..r.commit.len().min(12)]
    ))
    .await;
    let tree = prepare(
        hub,
        &ctx.security,
        &r.repo,
        Some(r.commit.clone()),
        // TODO(ADR-0053 §2): a deploy re-renders the chart from the
        // checkout's file at the build's commit; a build that took its
        // description from Studio should be rendered with that revision too.
        None,
        &r.product_file,
        &r.profile,
    )
    .await?;

    ctx.progress("rendering the chart").await;
    let rendered = render(&tree, &p.release, &p.namespace, &p.values).await?;

    let credstore = hub
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .map_err(|_| anyhow!("credstore is not available in this deployment"))?;
    let config_name = super::model::config_secret_name(&p.release);
    let mut config = BTreeMap::new();
    for key in &p.secret_keys {
        let reference = super::model::config_secret_ref(p.project_id, p.environment_id, key);
        let value = credstore_text(credstore.as_ref(), &ctx.security, &reference)
            .await?
            .ok_or_else(|| anyhow!("configuration secret {key} has no value: set it again"))?;
        config.insert(key.clone(), value);
    }
    let passwords = database_passwords(
        hub,
        &ctx.security,
        p.project_id,
        p.environment_id,
        &rendered,
    )
    .await?;
    let secret = |name: &str, key: &str| {
        (name == config_name)
            .then(|| config.get(key).cloned())
            .flatten()
    };
    let password = |host: &str| passwords.get(host).cloned().unwrap_or_default();
    let image = p
        .database_image
        .clone()
        .unwrap_or_else(|| super::database::DEFAULT_IMAGE.to_owned());
    let app: Application = research_app::application_of(
        &rendered,
        &Inputs {
            hardware: r.hardware.as_deref(),
            secret: &secret,
            database_password: &password,
            database_image: &image,
            namespace: &p.namespace,
        },
    )?;

    let hardware = match &r.hardware {
        Some(h) => h.clone(),
        None => {
            let offered = api.hardware(&r.research_project).await?;
            let h = crate::connectors::sdk::research::smallest(&offered).ok_or_else(|| {
                anyhow!("the Research project offers no hardware to run the services on")
            })?;
            ctx.progress(format!(
                "the environment names no hardware: the services run on {}",
                h.name
            ))
            .await;
            h.id.clone()
        }
    };
    let (bodies, notes) = service_bodies(&app, &p.values, &hardware)?;
    for note in &notes {
        ctx.progress(note.clone()).await;
    }
    let running = api
        .put_application(
            &r.research_project,
            &p.namespace,
            &bodies,
            Pace::RESEARCH,
            &progress,
        )
        .await?;
    let links = running.links();
    let at = if links.is_empty() {
        "no public address".to_owned()
    } else {
        links.join(", ")
    };
    let noted = if notes.is_empty() {
        String::new()
    } else {
        format!(" (note: {})", notes.join("; "))
    };
    Ok(format!(
        "{} runs in Constructor Research: {at}{noted}",
        p.namespace
    ))
}

/// A Research application as a release's rollout: each service a workload,
/// its public links the hosts.
pub async fn rollout(
    api: &ResearchApi,
    project: &str,
    application: &str,
) -> anyhow::Result<super::deploy::Rollout> {
    let Some(app) = api.application_named(project, application).await? else {
        return Ok(super::deploy::Rollout {
            hosts: Vec::new(),
            workloads: Vec::new(),
            problems: Vec::new(),
        });
    };
    Ok(super::deploy::Rollout {
        problems: Vec::new(),
        hosts: app.links(),
        workloads: app
            .services
            .into_iter()
            .map(|s| super::deploy::Workload {
                ready: i32::from(s.status == "running"),
                desired: 1,
                name: s.name,
                images: Vec::new(),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_images_prepare_listed_are_named_inside_the_tree() {
        let work = Path::new("/tmp/studio-research-1");
        let apps = "api-gateway gbx-api-gateway /tmp/studio-research-1/repo/.gearbox/out/docker/api-gateway /tmp/studio-research-1/repo\n";
        let images = build_images(apps, work).unwrap();
        assert_eq!(
            images,
            [BuildImage {
                app: "api-gateway".into(),
                name: "gbx-api-gateway".into(),
                dockerfile: "repo/.gearbox/out/docker/api-gateway/Dockerfile".into(),
                context: "repo".into(),
            }]
        );
        assert!(build_images("api /elsewhere/docker /elsewhere x\n", work).is_err());
        assert!(build_images("api gbx /tmp/studio-research-1/a /etc\n", work).is_err());
    }

    const CHART: &str = r#"
apiVersion: v1
kind: ConfigMap
metadata: { name: shop-config }
data:
  shop.yaml: |
    database:
      host: postgres
      port: 5432
    listen: 0.0.0.0:8087
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: shop }
spec:
  template:
    metadata: { labels: { app: shop } }
    spec:
      securityContext: { runAsUser: 65532 }
      containers:
        - name: shop
          image: studio-research-pending/shop:build
          command: [gbx-shop]
          args: [--config, /etc/shop/shop.yaml]
          ports: [{ name: rest, containerPort: 8087 }]
          env:
            - { name: DATABASE_URL, value: "postgres://app@postgres:5432/shop" }
          volumeMounts:
            - { name: config, mountPath: /etc/shop/shop.yaml, subPath: shop.yaml }
            - { name: home, mountPath: /var/lib/shop }
      volumes:
        - { name: config, configMap: { name: shop-config } }
        - { name: home, emptyDir: {} }
"#;

    fn shop(image: &str) -> Application {
        let none = |_: &str, _: &str| None;
        let pw = |_: &str| "pw".to_owned();
        research_app::application_of(
            &CHART.replace("studio-research-pending/shop:build", image),
            &Inputs {
                hardware: None,
                secret: &none,
                database_password: &pw,
                database_image: "postgres:18",
                namespace: "shop-dev",
            },
        )
        .unwrap()
    }

    #[test]
    fn a_build_lays_out_a_dockerfile_in_the_context_with_what_the_chart_mounts_baked_in() {
        let work = std::env::temp_dir().join(format!("research-lay-{}", Uuid::new_v4().simple()));
        let docker = work.join("repo/out/docker/shop");
        std::fs::create_dir_all(&docker).unwrap();
        std::fs::write(docker.join("Dockerfile"), "FROM debian:bookworm-slim\n").unwrap();
        std::fs::write(docker.join("Dockerfile.dockerignore"), "*\n!src\n").unwrap();
        let images = [BuildImage {
            app: "shop".into(),
            name: "gbx-shop".into(),
            dockerfile: "repo/out/docker/shop/Dockerfile".into(),
            context: "repo".into(),
        }];
        let app = shop("studio-research-pending/shop:build");
        let (builds, bakes) =
            lay_out(&work, &work.join("repo"), &images, &app, "postgres:18").unwrap();
        let read = |p: &str| std::fs::read_to_string(work.join(p)).unwrap();
        let dockerfile = read("repo/Dockerfile.studio-shop");
        let config = read("repo/studio-research/shop/files/etc/shop/shop.yaml");
        let ignore = read("repo/.dockerignore");
        let _ = std::fs::remove_dir_all(&work);

        assert_eq!(
            builds,
            [ImageBuild {
                key: "shop".into(),
                name: "gbx-shop".into(),
                dockerfile: "Dockerfile.studio-shop".into(),
            }]
        );
        assert_eq!(bakes["shop"], app.services[0].bake());
        assert!(dockerfile.starts_with("FROM debian:bookworm-slim\n"));
        assert!(
            dockerfile.contains("COPY [\"studio-research/shop/files/\",\"/\"]\n"),
            "{dockerfile}"
        );
        assert!(
            dockerfile.contains(
                "COPY --chown=65532:65532 [\"studio-research/shop/scratch/\",\"/var/lib/shop/\"]\n"
            ),
            "{dockerfile}"
        );
        assert!(
            dockerfile.ends_with(
                "ENTRYPOINT [\"gbx-shop\"]\nCMD [\"--config\",\"/etc/shop/shop.yaml\"]\n"
            )
        );
        assert!(config.contains("listen: 0.0.0.0:8087"));
        assert!(ignore.starts_with("*\n!src\n") && ignore.contains("!studio-research/**"));
    }

    #[test]
    fn a_deploy_runs_the_build_s_image_and_refuses_one_whose_baked_files_changed() {
        let built = shop("studio-research-pending/shop:build");
        let bake = built.services[0].bake();
        let app = shop(&research_app::image_reference(&bake, "gbx-shop", "img-7"));
        assert_eq!(
            app.services[0].bake(),
            bake,
            "the image does not change what is baked"
        );
        let (bodies, notes) = service_bodies(&app, &serde_json::json!({}), "cpu-s").unwrap();
        assert_eq!(bodies[0].image_id, "img-7");
        assert_eq!(bodies[0].hardware_configuration_id, "cpu-s");
        assert_eq!(
            bodies[0].environment_variables[0].value, "postgres://app@postgres:5432/shop",
            "postgres is not one of this chart's services"
        );
        assert!(notes.is_empty(), "{notes:?}");

        let stale = shop(&research_app::image_reference(
            "0badbeef0bad",
            "gbx-shop",
            "img-7",
        ));
        let e = service_bodies(&stale, &serde_json::json!({}), "cpu-s")
            .unwrap_err()
            .to_string();
        assert!(e.contains("Build again"), "{e}");

        let foreign = shop("ghcr.io/acme/shop:1");
        let e = service_bodies(&foreign, &serde_json::json!({}), "cpu-s")
            .unwrap_err()
            .to_string();
        assert!(e.contains("not an image Constructor Research built"), "{e}");
    }
}
