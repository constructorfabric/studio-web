//! Building and running a product on Constructor Research (ADR-0049 §3, §4),
//! through the Research connector and the integration service Research runs.
//!
//! **Build.** Studio prepares the product on its own server -- the same
//! `prepare` a cluster build's Job runs: clone, `gearbox generate`, a
//! buildable tree -- packs the tree, and hands it to the integration service
//! with each image's Dockerfile. Research compiles and keeps the images; the
//! build's record says `where: research` and names them by Research's
//! reference. Research keeps no chart, so none is published.
//!
//! **Deploy.** A deploy prepares the product again at the build's commit,
//! renders its chart with the build's images (`helm template`) and puts the
//! result as one application (`research_app`). The deploy's record ends with
//! where the product opens.
//!
//! The connection is the organization's: these run in the background as its
//! service, which cannot read a member's personal sign-in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::build::{self, RepoRef};
use super::research_app::{self, Application};
use crate::connectors::sdk::research::{BuildImage, ResearchApi};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

pub const BUILD_TASK_TYPE: &str = "environments.research.build";

/// How long a Research build is followed before Studio gives up on it.
const BUILD_FOR: Duration = Duration::from_secs(60 * 60);
/// How long a deploy waits for every service to run.
const START_FOR: Duration = Duration::from_secs(10 * 60);
const POLL_EVERY: Duration = Duration::from_secs(15);

/// The Research connector's calls, signed in as the organization's
/// connection `connection_id`.
pub async fn api(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
    connection_id: Uuid,
) -> anyhow::Result<ResearchApi> {
    let connectors = crate::connectors::sdk::Connectors::new(Arc::clone(hub))
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
    Ok(ResearchApi::new(
        reqwest::Client::new(),
        auth.root(),
        auth.token.clone(),
    ))
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
    let git_ref = git_ref.unwrap_or_else(|| repo.branch.clone());
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

/// The images `prepare` listed in `apps` (`app name dockerfile-dir context`),
/// their paths made relative to the work folder the archive holds.
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

/// The prepared tree as a `.tar.gz`, without the repository's history.
async fn archive(work: &Path) -> anyhow::Result<Vec<u8>> {
    let out = work.with_extension("tar.gz");
    let status = tokio::process::Command::new("tar")
        .arg("-czf")
        .arg(&out)
        .args(["--exclude=.git", "--exclude=target", "-C"])
        .arg(work)
        .arg("repo")
        .status()
        .await
        .context("tar could not be run")?;
    if !status.success() {
        bail!("the prepared tree could not be packed ({status})");
    }
    let bytes = tokio::fs::read(&out).await?;
    let _ = tokio::fs::remove_file(&out).await;
    Ok(bytes)
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
        let api = api(&self.hub, &ctx.security, p.organization_id, p.connection_id)
            .await
            .map_err(fail("start"))?;

        self.step(ctx, p, "prepare").await;
        let tree = prepare(
            &self.hub,
            &ctx.security,
            &p.repo,
            p.git_ref.clone(),
            &p.product_file,
            &p.profile,
        )
        .await
        .map_err(fail("prepare"))?;
        let apps = std::fs::read_to_string(tree.work.join("apps"))
            .map_err(|e| fail("prepare")(e.into()))?;
        let images = build_images(&apps, &tree.work).map_err(fail("prepare"))?;
        let context = archive(&tree.work).await.map_err(fail("prepare"))?;

        self.step(ctx, p, "images").await;
        let id = api
            .start_build(&p.research_project, &images, context)
            .await
            .map_err(fail("images"))?;
        let until = tokio::time::Instant::now() + BUILD_FOR;
        loop {
            if ctx.cancel.is_cancelled() {
                return Err(("images".into(), "the build was cancelled".into()));
            }
            let state = api.build(&id).await.map_err(fail("images"))?;
            match state.state.as_str() {
                "succeeded" => {
                    return Ok(BuildOutcome {
                        build_id: p.build_id.clone(),
                        status: "passed".into(),
                        product: Some(tree.prepared.product.clone()),
                        profile: Some(p.profile.clone()),
                        repository: Some(p.repo.repo.clone()),
                        commit: Some(tree.prepared.commit.clone()),
                        lock_hash: tree.prepared.lock_hash.clone(),
                        images: state
                            .images
                            .into_iter()
                            .map(|i| (i.app, i.reference))
                            .collect(),
                        ..BuildOutcome::default()
                    });
                }
                "failed" => {
                    let why = state
                        .log_tail
                        .unwrap_or_else(|| "Constructor Research says the build failed".into());
                    return Err((state.step.unwrap_or_else(|| "images".into()), why));
                }
                _ => {}
            }
            if tokio::time::Instant::now() >= until {
                return Err((
                    "images".into(),
                    format!("Constructor Research's build {id} did not end within an hour"),
                ));
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
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

/// Install `p` into its Research environment; where the product opens.
pub async fn deploy(
    hub: &Arc<ClientHub>,
    ctx: &TaskContext,
    p: &super::deploy::DeployPayload,
    r: &ResearchDeploy,
) -> anyhow::Result<String> {
    let api = api(hub, &ctx.security, p.organization_id, p.connection_id).await?;
    if p.action == super::model::DeploymentAction::Uninstall {
        ctx.progress(format!("removing application {}", p.namespace))
            .await;
        api.delete_application(&r.research_project, &p.namespace, false)
            .await?;
        return Ok(format!("{} removed from Constructor Research", p.namespace));
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
        &r.product_file,
        &r.profile,
    )
    .await?;

    ctx.progress("rendering the chart").await;
    let values = tree.work.join("values.json");
    tokio::fs::write(&values, serde_json::to_vec(&p.values)?).await?;
    let out = tokio::process::Command::new(super::deploy::helm_binary())
        .args([
            "template",
            &p.release,
            &tree.prepared.chart_dir,
            "--namespace",
            &p.namespace,
            "--values",
        ])
        .arg(&values)
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
    let rendered = String::from_utf8(out.stdout).context("helm's output is not text")?;

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
        &research_app::Inputs {
            hardware: r.hardware.as_deref(),
            secret: &secret,
            database_password: &password,
            database_image: &image,
        },
    )?;

    ctx.progress(format!(
        "putting application {} ({} services)",
        p.namespace,
        app.services.len()
    ))
    .await;
    let revision = api
        .put_application(&r.research_project, &p.namespace, &app)
        .await?;
    let until = tokio::time::Instant::now() + START_FOR;
    loop {
        let state = api.application(&r.research_project, &p.namespace).await?;
        if let Some(failed) = state.failed() {
            bail!(
                "{} did not start in Constructor Research: {}",
                failed.name,
                failed.message.clone().unwrap_or_else(|| "it failed".into())
            );
        }
        if state.running() {
            let urls = state.public_urls();
            let at = if urls.is_empty() {
                "no public address".to_owned()
            } else {
                urls.join(", ")
            };
            return Ok(format!(
                "{} runs in Constructor Research{}: {at}",
                p.namespace,
                revision
                    .map(|r| format!(" (revision {r})"))
                    .unwrap_or_default()
            ));
        }
        if tokio::time::Instant::now() >= until {
            bail!(
                "{} did not start in Constructor Research within ten minutes",
                p.namespace
            );
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

/// A Research application as a release's rollout: each service a workload,
/// its public addresses the hosts.
pub async fn rollout(
    api: &ResearchApi,
    project: &str,
    application: &str,
) -> anyhow::Result<super::deploy::Rollout> {
    let state = api.application(project, application).await?;
    Ok(super::deploy::Rollout {
        hosts: state.public_urls(),
        workloads: state
            .services
            .into_iter()
            .map(|s| super::deploy::Workload {
                ready: i32::from(s.state == "running"),
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
    fn the_images_prepare_listed_are_named_inside_the_archive() {
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
}
