//! A product built by Studio, in the organization's cluster (ADR-0048 §9).
//!
//! The portal never compiles anything itself: Build asks the server, the
//! server starts a Kubernetes Job in the project's namespace of the chosen
//! environment, and the Job does the work on the organization's nodes:
//!
//! 1. `prepare` (the Studio backend image, `studio-backend build-prepare`):
//!    clones the product's repository and the gear sources its description
//!    names, runs `gearbox generate` for the profile with the engine this
//!    Studio runs, and makes the tree buildable (constructorfabric/gearbox#12);
//! 2. `build` (BuildKit, rootless, daemonless): builds each application's
//!    image and pushes it under the environment's registry prefix with the
//!    namespace's registry login;
//! 3. `publish` (`studio-backend build-publish`): packages and pushes the chart
//!    beside the images, and leaves the manifest -- images by digest, chart
//!    and version -- as its termination message.
//!
//! The run that starts the Job ends at once; a watch run follows it, a few
//! minutes at a time, and records the build when the Job ends, so a build
//! outlives the task queue's lease and a restart of the portal. The
//! repository's token is a Secret in the namespace for the Job's lifetime and
//! is removed when the build is recorded.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Pod, Secret};
use kube::api::{DeleteParams, ListParams, LogParams, Patch, PatchParams};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toolkit::client_hub::{ClientHub, ClientScope};
use tracing::warn;
use uuid::Uuid;

use super::deploy::{self, cluster_access, registry_access};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task types: a wire contract.
pub const TASK_TYPE: &str = "environments.build";
pub const WATCH_TASK_TYPE: &str = "environments.build.watch";

/// The image BuildKit runs in, rootless, unless `STUDIO_BUILDKIT_IMAGE` names
/// another: a cluster that admits only its own registry's images wants the
/// same image through that registry's proxy.
pub const BUILDKIT_IMAGE: &str = "moby/buildkit:v0.20.0-rootless";

/// How long a build may take before the cluster stops it.
const DEADLINE_SECS: i64 = 60 * 60;

/// How long one watch run waits before handing over to the next: well under
/// the queue's lease.
const WATCH_FOR: Duration = Duration::from_secs(10 * 60);
const WATCH_EVERY: Duration = Duration::from_secs(20);

/// The watch run past which a Job still running has outlived its deadline by
/// two rounds: the cluster should have stopped it, so nothing it says now can
/// be trusted, and the build is recorded as lost.
const LAST_WATCH_ROUND: u32 = (DEADLINE_SECS as u64 / WATCH_FOR.as_secs()) as u32 + 2;

/// How much of a failure a build keeps: a container's termination message is
/// at most 4 KiB, and the start of it names what broke.
const FAILURE_CHARS: usize = 3000;

/// Where the product's repository is, as the server read it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoRef {
    /// The tenant whose connection reaches it.
    pub tenant: Uuid,
    pub connection_id: Uuid,
    /// `owner/name`.
    pub repo: String,
    pub branch: String,
}

/// What Build puts on the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildPayload {
    pub build_id: String,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub connection_id: Uuid,
    pub registry_connection_id: Uuid,
    pub namespace: String,
    /// `ghcr.io/acme`.
    pub prefix: String,
    pub profile: String,
    pub product_file: String,
    pub repo: RepoRef,
    /// A branch, tag or commit; the repository's branch when absent.
    #[serde(default)]
    pub git_ref: Option<String>,
    /// The image `prepare` and `publish` run in: this Studio's backend.
    pub builder_image: String,
    /// The image the `build` step runs BuildKit in. Absent from a build
    /// queued before it was recorded, which gets the default.
    #[serde(default = "default_buildkit_image")]
    pub buildkit_image: String,
    /// The tenant the build's record was started in: the caller's. Every
    /// later record of it is written there too, or the page that reads the
    /// caller's records keeps the first one, `running`, for ever. Absent from
    /// a build queued before it was recorded, whose records go to the run's
    /// own tenant.
    #[serde(default)]
    pub records_in: Option<Uuid>,
    /// The tenant the environment's connections are found from and read as
    /// (ADR-0054 §5): the project, for a project's own environment. Absent
    /// for an organization's, and from a build queued before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections_from: Option<Uuid>,
    /// The repository's own Dockerfiles and chart (ADR-0054 §7); `None`
    /// builds `product_file` on gears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own: Option<super::model::OwnBuild>,
}

/// The context a run reads an environment's connections as, and the tenant
/// it finds them from: the project's service for a project's own
/// environment, else the run's own (ADR-0054 §5).
pub(super) fn connection_reader(
    run: &toolkit_security::SecurityContext,
    org: Uuid,
    from: Option<Uuid>,
) -> anyhow::Result<(toolkit_security::SecurityContext, Uuid)> {
    match from {
        Some(tenant) if tenant != org => Ok((super::store::service_context(tenant)?, tenant)),
        _ => Ok((run.clone(), org)),
    }
}

fn default_buildkit_image() -> String {
    BUILDKIT_IMAGE.to_owned()
}

/// What a watch run carries: the Job to follow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchPayload {
    pub build_id: String,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub connection_id: Uuid,
    pub namespace: String,
    pub job: String,
    pub repository: String,
    pub profile: String,
    /// How many watch runs came before this one.
    #[serde(default)]
    pub round: u32,
    /// The step last recorded as running, so a step is recorded once.
    #[serde(default)]
    pub step: Option<String>,
    /// See [`BuildPayload::records_in`].
    #[serde(default)]
    pub records_in: Option<Uuid>,
    /// See [`BuildPayload::connections_from`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections_from: Option<Uuid>,
}

/// The Job's name for a build: a DNS label.
pub fn job_name(build_id: &str) -> String {
    let id: String = build_id
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    format!("studio-build-{}", id.trim_start_matches("studio-"))
        .chars()
        .take(63)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned()
}

/// The repository-token Secret of a build.
pub fn git_secret_name(build_id: &str) -> String {
    format!("{}-git", job_name(build_id))
        .chars()
        .take(63)
        .collect()
}

/// The image BuildKit runs in: `STUDIO_BUILDKIT_IMAGE`, else [`BUILDKIT_IMAGE`].
pub fn buildkit_image() -> String {
    std::env::var("STUDIO_BUILDKIT_IMAGE")
        .ok()
        .map(|image| image.trim().to_owned())
        .filter(|image| !image.is_empty())
        .unwrap_or_else(default_buildkit_image)
}

/// The image `prepare` and `publish` run in: `STUDIO_BUILDER_IMAGE`, else the
/// published image of the commit this server was built from.
pub fn builder_image() -> Option<String> {
    if let Ok(image) = std::env::var("STUDIO_BUILDER_IMAGE") {
        let image = image.trim().to_owned();
        if !image.is_empty() {
            return Some(image);
        }
    }
    let commit = env!("STUDIO_BUILD_COMMIT");
    (!commit.is_empty())
        .then(|| format!("ghcr.io/constructorfabric/studio-web/studio-backend:sha-{commit}"))
}

/// The script the `build` container runs: one rootless, daemonless BuildKit
/// build per application `prepare` listed, pushed with the namespace's
/// registry login.
const BUILD_SCRIPT: &str = r#"set -eu
TAG="$(cat /work/tag)"
mkdir -p /work/meta
while read -r app name dockerfile context filename; do
  echo "building $app as $PREFIX/$name:$TAG"
  buildctl-daemonless.sh build --frontend dockerfile.v0 \
    --local context="$context" --local dockerfile="$dockerfile" --opt filename="${filename:-Dockerfile}" \
    --output "type=image,name=$PREFIX/$name:$TAG,push=true" \
    --metadata-file "/work/meta/$app.json"
done < /work/apps
"#;

/// The Job that builds `p`.
pub fn job_manifest(p: &BuildPayload, git_secret: bool) -> serde_json::Value {
    let name = job_name(&p.build_id);
    let labels = serde_json::json!({
        "app.kubernetes.io/managed-by": "constructor-studio",
        "app.kubernetes.io/name": "studio-build",
        "studio.constructor.tech/build": p.build_id,
    });
    let git_env = if git_secret {
        serde_json::json!([
            { "name": "GIT_USERNAME", "valueFrom": { "secretKeyRef": { "name": git_secret_name(&p.build_id), "key": "username" } } },
            { "name": "GIT_PASSWORD", "valueFrom": { "secretKeyRef": { "name": git_secret_name(&p.build_id), "key": "password" } } },
            { "name": "HOME", "value": "/work/home" },
        ])
    } else {
        serde_json::json!([{ "name": "HOME", "value": "/work/home" }])
    };
    let mut prepare_args = vec![
        "build-prepare".to_owned(),
        "--work".to_owned(),
        "/work".to_owned(),
        "--repo-url".to_owned(),
        repo_clone_placeholder(),
        "--product-file".to_owned(),
        p.product_file.clone(),
        "--profile".to_owned(),
        p.profile.clone(),
    ];
    if let Some(own) = &p.own {
        prepare_args.push("--own".to_owned());
        prepare_args.push(serde_json::to_string(own).unwrap_or_default());
    }
    if let Some(r) = p.git_ref.as_ref().filter(|r| !r.trim().is_empty()) {
        prepare_args.push("--ref".to_owned());
        prepare_args.push(r.trim().to_owned());
    } else {
        prepare_args.push("--ref".to_owned());
        prepare_args.push(p.repo.branch.clone());
    }
    let restricted = serde_json::json!({
        "runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 1000,
        "allowPrivilegeEscalation": false,
        "capabilities": { "drop": ["ALL"] },
        "seccompProfile": { "type": "RuntimeDefault" },
    });
    serde_json::json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": { "name": name, "labels": labels },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": DEADLINE_SECS,
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "metadata": { "labels": labels },
                "spec": {
                    "restartPolicy": "Never",
                    "securityContext": { "fsGroup": 1000 },
                    "automountServiceAccountToken": false,
                    "initContainers": [
                        {
                            "name": "prepare",
                            "image": p.builder_image,
                            "args": prepare_args,
                            "env": git_env,
                            "securityContext": restricted,
                            "terminationMessagePolicy": "FallbackToLogsOnError",
                            "resources": {
                                "requests": { "cpu": "250m", "memory": "512Mi" },
                                "limits": { "cpu": "2", "memory": "2Gi" },
                            },
                            "volumeMounts": [{ "name": "work", "mountPath": "/work" }],
                        },
                        {
                            "name": "build",
                            "image": p.buildkit_image,
                            "command": ["sh", "-c", BUILD_SCRIPT],
                            "env": [
                                { "name": "PREFIX", "value": p.prefix },
                                { "name": "BUILDKITD_FLAGS", "value": "--oci-worker-no-process-sandbox" },
                                { "name": "DOCKER_CONFIG", "value": "/home/user/.studio-registry" },
                            ],
                            // What rootless BuildKit needs, and no more: no
                            // privilege, a non-root user, seccomp and AppArmor
                            // off for its own user namespace.
                            "securityContext": {
                                "runAsUser": 1000, "runAsGroup": 1000,
                                "seccompProfile": { "type": "Unconfined" },
                                "appArmorProfile": { "type": "Unconfined" },
                            },
                            "terminationMessagePolicy": "FallbackToLogsOnError",
                            "resources": {
                                "requests": { "cpu": "2", "memory": "4Gi" },
                                "limits": { "cpu": "6", "memory": "10Gi" },
                            },
                            "volumeMounts": [
                                { "name": "work", "mountPath": "/work" },
                                { "name": "buildkit", "mountPath": "/home/user/.local/share/buildkit" },
                                { "name": "registry", "mountPath": "/home/user/.studio-registry", "readOnly": true },
                            ],
                        },
                    ],
                    "containers": [{
                        "name": "publish",
                        "image": p.builder_image,
                        "args": ["build-publish", "--work", "/work", "--prefix", p.prefix, "--registry-config", "/registry/config.json"],
                        "env": [{ "name": "HOME", "value": "/work/home" }],
                        "securityContext": restricted,
                        "terminationMessagePolicy": "FallbackToLogsOnError",
                        "resources": {
                            "requests": { "cpu": "100m", "memory": "128Mi" },
                            "limits": { "cpu": "1", "memory": "512Mi" },
                        },
                        "volumeMounts": [
                            { "name": "work", "mountPath": "/work" },
                            { "name": "registry", "mountPath": "/registry", "readOnly": true },
                        ],
                    }],
                    "volumes": [
                        { "name": "work", "emptyDir": { "sizeLimit": "20Gi" } },
                        { "name": "buildkit", "emptyDir": { "sizeLimit": "40Gi" } },
                        { "name": "registry", "secret": {
                            "secretName": deploy::PULL_SECRET,
                            "items": [{ "key": ".dockerconfigjson", "path": "config.json" }],
                        } },
                    ],
                },
            },
        },
    })
}

/// Stands in for the clone URL until the run knows it; replaced by
/// [`with_clone_url`], so a manifest built in a test needs no connection.
fn repo_clone_placeholder() -> String {
    "@CLONE_URL@".to_owned()
}

/// The Job manifest with the repository's clone URL in place.
pub fn with_clone_url(mut job: serde_json::Value, url: &str) -> serde_json::Value {
    if let Some(args) = job
        .pointer_mut("/spec/template/spec/initContainers/0/args")
        .and_then(|a| a.as_array_mut())
    {
        for a in args.iter_mut() {
            if a.as_str() == Some("@CLONE_URL@") {
                *a = url.into();
            }
        }
    }
    job
}

/* ── the server side: start, watch, record ── */

pub struct BuildTask {
    hub: Arc<ClientHub>,
}

impl BuildTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

/// Queue a run as the service of `tenant`.
pub async fn enqueue(
    hub: &Arc<ClientHub>,
    tenant: Uuid,
    task_type: &'static str,
    payload: serde_json::Value,
    partition: &str,
    idempotency: &str,
) -> anyhow::Result<Uuid> {
    let queue = hub
        .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
            crate::tasks::TASK_QUEUE_INSTANCE_ID,
        ))
        .map_err(|_| anyhow!("background runs are not available in this deployment"))?;
    let svc = super::store::service_context(tenant)?;
    queue
        .enqueue(
            &svc,
            crate::tasks::sdk::NewRun {
                tenant,
                task_type,
                payload,
                partition_key: Some(partition),
                idempotency_key: Some(idempotency),
                coalesce_queued: false,
                notify_workspace_id: None,
            },
        )
        .await
}

/// Record a build's outcome in the project's graph: in `records_in`, the
/// tenant its first record went to, when it names one; else in the run's.
pub(super) async fn record_outcome(
    hub: &Arc<ClientHub>,
    ctx: &toolkit_security::SecurityContext,
    records_in: Option<Uuid>,
    project: Uuid,
    outcome: crate::artifact_ingest::port::BuildOutcome,
) -> anyhow::Result<()> {
    record(hub, ctx, records_in, project, outcome).await
}

async fn record(
    hub: &Arc<ClientHub>,
    ctx: &toolkit_security::SecurityContext,
    records_in: Option<Uuid>,
    project: Uuid,
    outcome: crate::artifact_ingest::port::BuildOutcome,
) -> anyhow::Result<()> {
    let builds = hub
        .get::<dyn crate::artifact_ingest::port::BuildRecords>()
        .map_err(|_| anyhow!("builds are not available in this deployment"))?;
    let there = match records_in {
        Some(tenant) if tenant != ctx.subject_tenant_id() => super::store::service_context(tenant)?,
        _ => ctx.clone(),
    };
    builds.record(&there, &project.to_string(), &outcome).await
}

#[async_trait]
impl TaskHandler for BuildTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        2
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: BuildPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!("this run's payload is not a build ({e})"));
            }
        };
        match self.start(ctx, &p).await {
            Ok(job) => TaskOutcome::done_with(
                format!("building in {} as Job {job}", p.namespace),
                serde_json::json!({ "job": job }),
            ),
            Err(e) => {
                let failure = format!("{e:#}");
                let _ = record(
                    &self.hub,
                    &ctx.security,
                    p.records_in,
                    p.project_id,
                    crate::artifact_ingest::port::BuildOutcome::failed(
                        &p.build_id,
                        &p.repo.repo,
                        &p.profile,
                        &failure,
                        "start",
                    ),
                )
                .await;
                TaskOutcome::Failed(failure)
            }
        }
    }
}

impl BuildTask {
    async fn start(&self, ctx: &TaskContext, p: &BuildPayload) -> anyhow::Result<String> {
        ctx.progress("reading the cluster's access").await;
        let (reader, from) =
            connection_reader(&ctx.security, p.organization_id, p.connections_from)?;
        let access = cluster_access(&self.hub, &reader, from, p.connection_id).await?;
        let client = access.client().await?;
        deploy::prepare_namespace(&client, &p.namespace, p.project_id).await?;
        let registry = registry_access(&self.hub, &reader, from, p.registry_connection_id).await?;
        deploy::write_pull_secret(&client, &p.namespace, &registry).await?;

        ctx.progress("reading the repository's access").await;
        let connectors = crate::connectors::sdk::Connectors::new(Arc::clone(&self.hub))
            .get()
            .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
        let (driver, auth, _) = connectors
            .driver_and_auth(&ctx.security, p.repo.tenant, p.repo.connection_id)
            .await
            .map_err(|e| {
                anyhow!("the repository's connection cannot be used by the server: {e:#}")
            })?;
        let url = driver.clone_url(&auth.base_url, &p.repo.repo)?;
        let (username, password) = driver.clone_credentials(&auth.token);
        let git_secret = !password.trim().is_empty();
        if git_secret {
            let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), &p.namespace);
            let name = git_secret_name(&p.build_id);
            let object = serde_json::json!({
                "apiVersion": "v1", "kind": "Secret",
                "metadata": { "name": name, "labels": { "app.kubernetes.io/managed-by": "constructor-studio", "studio.constructor.tech/build": p.build_id } },
                "type": "Opaque",
                "stringData": { "username": username, "password": password },
            });
            secrets
                .patch(
                    &name,
                    &PatchParams::apply("constructor-studio").force(),
                    &Patch::Apply(&object),
                )
                .await
                .map_err(|e| {
                    anyhow!("the repository token could not be given to the build: {e}")
                })?;
        }

        ctx.progress(format!("starting the build Job in {}", p.namespace))
            .await;
        let job = job_name(&p.build_id);
        let manifest = with_clone_url(job_manifest(p, git_secret), &url);
        let jobs: kube::Api<Job> = kube::Api::namespaced(client.clone(), &p.namespace);
        jobs.patch(
            &job,
            &PatchParams::apply("constructor-studio").force(),
            &Patch::Apply(&manifest),
        )
        .await
        .map_err(|e| anyhow!("the build Job could not be started in {}: {e}", p.namespace))?;

        let watch = WatchPayload {
            build_id: p.build_id.clone(),
            organization_id: p.organization_id,
            project_id: p.project_id,
            connection_id: p.connection_id,
            namespace: p.namespace.clone(),
            job: job.clone(),
            repository: p.repo.repo.clone(),
            profile: p.profile.clone(),
            round: 0,
            step: None,
            records_in: p.records_in,
            connections_from: p.connections_from,
        };
        enqueue(
            &self.hub,
            p.organization_id,
            WATCH_TASK_TYPE,
            serde_json::to_value(&watch)?,
            &format!("build-watch:{}", p.build_id),
            &format!("{}:watch:0", p.build_id),
        )
        .await?;
        Ok(job)
    }
}

pub struct WatchTask {
    hub: Arc<ClientHub>,
}

impl WatchTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

/// What the Job says now.
enum JobState {
    Running,
    Succeeded,
    Failed(String),
}

fn job_state(job: &Job) -> JobState {
    let status = job.status.clone().unwrap_or_default();
    if status.succeeded.unwrap_or(0) > 0 {
        return JobState::Succeeded;
    }
    for c in status.conditions.unwrap_or_default() {
        if c.status == "True" && (c.type_ == "Failed") {
            return JobState::Failed(
                c.message
                    .or(c.reason)
                    .unwrap_or_else(|| "the Job failed".into()),
            );
        }
    }
    if status.failed.unwrap_or(0) > 0 {
        return JobState::Failed("the build pod failed".into());
    }
    JobState::Running
}

/// The termination message of `container` in the build's pod, and which step
/// failed: the first container, init or not, that ended other than 0.
fn pod_messages(pod: &Pod) -> (Option<String>, Option<(String, String)>) {
    let status = pod.status.clone().unwrap_or_default();
    let mut publish = None;
    let mut failed = None;
    for c in status
        .init_container_statuses
        .unwrap_or_default()
        .into_iter()
        .chain(status.container_statuses.unwrap_or_default())
    {
        let Some(t) = c.state.and_then(|s| s.terminated) else {
            continue;
        };
        if c.name == "publish" && t.exit_code == 0 {
            publish = t.message.clone();
        }
        if t.exit_code != 0 && failed.is_none() {
            let why = t
                .message
                .clone()
                .or(t.reason.clone())
                .unwrap_or_else(|| format!("exit {}", t.exit_code));
            failed = Some((c.name.clone(), why));
        }
    }
    (publish, failed)
}

/// The step the build's pod is in: the first container, init or not, that
/// has not ended.
fn current_step(pod: &Pod) -> Option<String> {
    let status = pod.status.as_ref()?;
    status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten())
        .find(|c| c.state.as_ref().is_none_or(|s| s.terminated.is_none()))
        .map(|c| c.name.clone())
}

/// A container that waits for what will not come: an image that cannot be
/// pulled, a configuration that cannot be made. Its step, and why.
fn stuck(pod: &Pod) -> Option<(String, String)> {
    const HOPELESS: [&str; 5] = [
        "ErrImagePull",
        "ImagePullBackOff",
        "InvalidImageName",
        "CreateContainerConfigError",
        "CreateContainerError",
    ];
    let status = pod.status.as_ref()?;
    status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten())
        .find_map(|c| {
            let waiting = c.state.as_ref()?.waiting.as_ref()?;
            let reason = waiting.reason.as_deref()?;
            HOPELESS.contains(&reason).then(|| {
                (
                    c.name.clone(),
                    format!(
                        "{reason}: {}",
                        waiting
                            .message
                            .as_deref()
                            .unwrap_or("the container cannot start")
                    ),
                )
            })
        })
}

/// The last `n` characters of `s`: a log's end says most.
fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.trim().chars().collect();
    if chars.len() <= n {
        return chars.into_iter().collect();
    }
    format!("…{}", chars[chars.len() - n..].iter().collect::<String>())
}

/// The first `n` characters of `s`: an error list's start says most.
fn head(s: &str, n: usize) -> String {
    let s = s.trim();
    match s.char_indices().nth(n) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_owned(),
    }
}

/// What a build records when its watch can no longer follow it: how it ended
/// is not known.
fn lost(why: &str) -> String {
    format!("Studio lost sight of the build: {why}. How it ended is not known; build again.")
}

#[async_trait]
impl TaskHandler for WatchTask {
    fn task_type(&self) -> &'static str {
        WATCH_TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        3
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: WatchPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "this run's payload is not a build watch ({e})"
                ));
            }
        };
        match self.watch(ctx, &p).await {
            Ok(said) => TaskOutcome::done_with(said, serde_json::json!({ "job": p.job })),
            // The last attempt: nobody watches after this one, so the build
            // says it is lost rather than running for ever.
            Err(e) if ctx.attempt >= self.max_attempts() => {
                let why = format!("{e:#}");
                let outcome = crate::artifact_ingest::port::BuildOutcome::failed(
                    &p.build_id,
                    &p.repository,
                    &p.profile,
                    &lost(&why),
                    "watch",
                );
                if let Err(e) = record(
                    &self.hub,
                    &ctx.security,
                    p.records_in,
                    p.project_id,
                    outcome,
                )
                .await
                {
                    warn!(build = %p.build_id, "studio-environments: a lost build could not be recorded ({e})");
                }
                TaskOutcome::Failed(why)
            }
            Err(e) => TaskOutcome::Retry(format!("{e:#}")),
        }
    }
}

impl WatchTask {
    async fn watch(&self, ctx: &TaskContext, p: &WatchPayload) -> anyhow::Result<String> {
        let (reader, from) =
            connection_reader(&ctx.security, p.organization_id, p.connections_from)?;
        let access = cluster_access(&self.hub, &reader, from, p.connection_id).await?;
        let client = access.client().await?;
        let jobs: kube::Api<Job> = kube::Api::namespaced(client.clone(), &p.namespace);
        let started = std::time::Instant::now();
        let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), &p.namespace);
        let mut step = p.step.clone();
        loop {
            let Some(job) = jobs
                .get_opt(&p.job)
                .await
                .map_err(|e| anyhow!("the cluster did not answer: {e}"))?
            else {
                self.finish(
                    ctx,
                    &client,
                    p,
                    Err(("watch".into(), lost("its Job is gone from the cluster"))),
                )
                .await?;
                return Ok("the build Job is gone".into());
            };
            match job_state(&job) {
                JobState::Running => {
                    let pod = pods
                        .list(&ListParams::default().labels(&format!("job-name={}", p.job)))
                        .await
                        .ok()
                        .and_then(|l| l.items.into_iter().next());
                    // A pod that cannot start never fails the Job: it waits
                    // out the deadline. Say why now instead.
                    if let Some((at, why)) = pod.as_ref().and_then(stuck) {
                        let said = format!("failed in {at}: {why}");
                        self.finish(ctx, &client, p, Err((at, why))).await?;
                        let _ = jobs.delete(&p.job, &DeleteParams::background()).await;
                        return Ok(said);
                    }
                    let now = pod.as_ref().and_then(current_step);
                    if now.is_some() && now != step {
                        let mut running = crate::artifact_ingest::port::BuildOutcome::running(
                            &p.build_id,
                            &p.repository,
                            &p.profile,
                        );
                        running.step = now.clone();
                        if let Err(e) = record(
                            &self.hub,
                            &ctx.security,
                            p.records_in,
                            p.project_id,
                            running,
                        )
                        .await
                        {
                            warn!(build = %p.build_id, "studio-environments: the build's step could not be recorded ({e})");
                        }
                        step = now;
                    }
                    if started.elapsed() >= WATCH_FOR && p.round + 1 >= LAST_WATCH_ROUND {
                        let why = lost("its Job still runs past the hour a build may take");
                        self.finish(ctx, &client, p, Err(("watch".into(), why.clone())))
                            .await?;
                        let _ = jobs.delete(&p.job, &DeleteParams::background()).await;
                        return Ok(why);
                    }
                    if started.elapsed() >= WATCH_FOR {
                        let next = WatchPayload {
                            round: p.round + 1,
                            step: step.clone(),
                            ..p.clone()
                        };
                        enqueue(
                            &self.hub,
                            p.organization_id,
                            WATCH_TASK_TYPE,
                            serde_json::to_value(&next)?,
                            &format!("build-watch:{}", p.build_id),
                            &format!("{}:watch:{}", p.build_id, next.round),
                        )
                        .await?;
                        return Ok("still building; watching on".into());
                    }
                    ctx.progress(format!(
                        "building in {}: {}",
                        p.namespace,
                        step.as_deref().unwrap_or("starting")
                    ))
                    .await;
                    tokio::select! {
                        () = tokio::time::sleep(WATCH_EVERY) => {}
                        () = ctx.cancel.cancelled() => bail!("the watch was cancelled"),
                    }
                }
                state => {
                    let pod = pods
                        .list(&ListParams::default().labels(&format!("job-name={}", p.job)))
                        .await
                        .ok()
                        .and_then(|l| l.items.into_iter().next());
                    let (manifest, failed) = pod.as_ref().map(pod_messages).unwrap_or((None, None));
                    let outcome = match (state, manifest, failed) {
                        (JobState::Succeeded, Some(m), _) => Ok(m),
                        (_, _, Some((step, why))) => Err((step, why)),
                        (JobState::Failed(why), _, None) => Err(("build".into(), why)),
                        _ => Err(("publish".into(), "the build left no manifest".into())),
                    };
                    let said = match &outcome {
                        Ok(_) => "built and published".to_owned(),
                        Err((step, why)) => format!("failed in {step}: {}", tail(why, 300)),
                    };
                    self.finish(ctx, &client, p, outcome).await?;
                    return Ok(said);
                }
            }
        }
    }

    async fn finish(
        &self,
        ctx: &TaskContext,
        client: &kube::Client,
        p: &WatchPayload,
        outcome: Result<String, (String, String)>,
    ) -> anyhow::Result<()> {
        use crate::artifact_ingest::port::BuildOutcome;
        let record_of = match outcome {
            Ok(manifest) => match serde_json::from_str::<Manifest>(manifest.trim()) {
                Ok(m) => BuildOutcome {
                    build_id: p.build_id.clone(),
                    status: "passed".into(),
                    product: Some(m.product),
                    profile: Some(m.profile),
                    repository: Some(p.repository.clone()),
                    commit: Some(m.commit),
                    lock_hash: m.lock_hash,
                    images: m.images.into_iter().map(|i| (i.app, i.image)).collect(),
                    chart_ref: Some(m.chart.reference),
                    chart_version: Some(m.chart.version),
                    ..BuildOutcome::default()
                },
                Err(e) => BuildOutcome::failed(
                    &p.build_id,
                    &p.repository,
                    &p.profile,
                    &format!("the build's manifest is not one: {e}"),
                    "publish",
                ),
            },
            Err((step, why)) => BuildOutcome::failed(
                &p.build_id,
                &p.repository,
                &p.profile,
                &tail(&why, FAILURE_CHARS),
                &step,
            ),
        };
        record(
            &self.hub,
            &ctx.security,
            p.records_in,
            p.project_id,
            record_of,
        )
        .await?;
        // The repository's token goes with the build.
        let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), &p.namespace);
        if let Err(e) = secrets
            .delete(&git_secret_name(&p.build_id), &DeleteParams::default())
            .await
            && !matches!(&e, kube::Error::Api(s) if s.code == 404)
        {
            warn!(build = %p.build_id, "studio-environments: the build's repository token could not be removed ({e})");
        }
        Ok(())
    }
}

/* ── a build's log, read from its pod ── */

/// How much of a step's log is read: its end, where a failure says why.
const LOG_LINES: i64 = 500;
const LOG_BYTES: i64 = 256 * 1024;

/// One step of a build, as its pod shows it now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepLog {
    /// `prepare`, `build` or `publish`.
    pub step: String,
    /// `waiting` | `running` | `passed` | `failed`.
    pub state: String,
    /// The end of what it wrote; empty while it has not started.
    pub log: String,
}

/// Each step of the build's pod, in the order they run, and whether it has
/// started: what is read of a step's log.
fn steps_of(pod: &Pod) -> Vec<(String, &'static str)> {
    let Some(status) = pod.status.as_ref() else {
        return Vec::new();
    };
    status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten())
        .map(|c| {
            let state = match c.state.as_ref() {
                Some(s) if s.running.is_some() => "running",
                Some(s) => match &s.terminated {
                    Some(t) if t.exit_code == 0 => "passed",
                    Some(_) => "failed",
                    None => "waiting",
                },
                None => "waiting",
            };
            (c.name.clone(), state)
        })
        .collect()
}

/// The build's steps and the end of each one's log, as its pod in
/// `namespace` has them; `None` when there is no such pod there (another
/// environment's, or gone a day after the build ended).
pub async fn step_logs(
    client: &kube::Client,
    namespace: &str,
    build_id: &str,
) -> anyhow::Result<Option<Vec<StepLog>>> {
    let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), namespace);
    let Some(pod) = pods
        .list(&ListParams::default().labels(&format!("job-name={}", job_name(build_id))))
        .await
        .map_err(|e| anyhow!("the cluster did not answer: {e}"))?
        .items
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let name = pod.metadata.name.clone().unwrap_or_default();
    let mut out = Vec::new();
    for (step, state) in steps_of(&pod) {
        let log = if state == "waiting" {
            String::new()
        } else {
            let params = LogParams {
                container: Some(step.clone()),
                tail_lines: Some(LOG_LINES),
                limit_bytes: Some(LOG_BYTES),
                ..LogParams::default()
            };
            pods.logs(&name, &params)
                .await
                .unwrap_or_else(|e| format!("(the log could not be read: {e})"))
        };
        out.push(StepLog {
            step,
            state: state.to_owned(),
            log,
        });
    }
    Ok(Some(out))
}

/* ── the Job side: `studio-backend build-prepare` and `build-publish` ── */

/// The manifest `publish` leaves, the same shape a pipeline's
/// `studio-build.json` has.
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub product: String,
    pub profile: String,
    pub commit: String,
    #[serde(default)]
    pub lock_hash: Option<String>,
    pub images: Vec<ManifestImage>,
    pub chart: ManifestChart,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestImage {
    pub app: String,
    pub image: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestChart {
    pub reference: String,
    pub version: String,
}

/// What `prepare` leaves for `build` and `publish`, in `/work/build.json`.
#[derive(Debug, Serialize, Deserialize)]
pub struct Prepared {
    pub product: String,
    pub profile: String,
    pub commit: String,
    pub lock_hash: Option<String>,
    pub chart_dir: String,
    pub chart_base: String,
    /// `(app, image name)`.
    pub apps: Vec<(String, String)>,
}

/// The applications `docker/build.sh` builds, `(app, image)`, and its build
/// context relative to `docker/`.
pub fn read_build_script(text: &str) -> anyhow::Result<(String, Vec<(String, String)>)> {
    let context = text
        .lines()
        .find_map(|l| {
            let at = l.find("\"$SCRIPT_DIR/\"'")?;
            let rest = &l[at + "\"$SCRIPT_DIR/\"'".len()..];
            rest.split('\'').next().map(str::to_owned)
        })
        .ok_or_else(|| anyhow!("docker/build.sh names no build context"))?;
    let mut apps: Vec<(String, String)> = Vec::new();
    for l in text.lines() {
        let l = l.trim();
        let Some(rest) = l.strip_prefix("build_one ") else {
            continue;
        };
        let mut parts = rest.splitn(2, ' ');
        let app = parts.next().unwrap_or_default().trim();
        let image = parts
            .next()
            .unwrap_or_default()
            .trim()
            .trim_start_matches('\'')
            .split('\'')
            .next()
            .unwrap_or_default();
        if !app.is_empty() && !image.is_empty() && !apps.iter().any(|(a, _)| a == app) {
            apps.push((app.to_owned(), image.to_owned()));
        }
    }
    if apps.is_empty() {
        bail!("docker/build.sh builds no application");
    }
    Ok((context, apps))
}

/// A generated Dockerfile with what its build stage lacks
/// (constructorfabric/gearbox#12): protoc and the protobuf well-known types
/// for the gRPC gears, cmake for zlib.
pub fn with_build_tools(dockerfile: &str) -> String {
    if dockerfile.contains("protobuf-compiler") {
        return dockerfile.to_owned();
    }
    let mut out = String::with_capacity(dockerfile.len() + 160);
    for line in dockerfile.lines() {
        out.push_str(line);
        out.push('\n');
        let l = line.trim();
        if l.starts_with("FROM rust:") && l.ends_with(" AS build") {
            out.push_str(
                "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
                 protobuf-compiler libprotobuf-dev cmake && rm -rf /var/lib/apt/lists/*\n",
            );
        }
    }
    out
}

/// `Chart.yaml`'s `version`.
pub fn chart_base_version(chart_yaml: &str) -> String {
    chart_yaml
        .lines()
        .find_map(|l| l.trim().strip_prefix("version:"))
        .map(|v| v.trim().trim_matches('"').trim_matches('\'').to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "0.1.0".to_owned())
}

/// A path inside `root`, `rel` resolved without touching the disk; `None`
/// when it would leave `root`.
pub fn inside(root: &Path, rel: &Path) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for c in rel.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if out == root || !out.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    out.starts_with(root).then_some(out)
}

fn run(cmd: &mut Command, what: &str) -> anyhow::Result<String> {
    let out = cmd
        .output()
        .with_context(|| format!("{what} could not be started"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        // The whole output to the container's log; the failure itself carries
        // what went wrong, which the run records as the build's reason.
        eprintln!("{text}");
        bail!("{what} failed: {}", failure_text(&text));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Give the generated workspace the lock of the sources it builds, when it
/// has none of its own: the product's own code first (a source in the
/// repository), else a fetched one. Without it cargo locks every crate to its
/// latest version, and the first build on a cluster mixed two releases of the
/// platform's toolkit crates whose traits no longer met; cargo keeps what the
/// lock names and adds only what it lacks.
fn seed_lock(roots: &[PathBuf], repo: &Path, out: &Path) -> anyhow::Result<()> {
    let target = out.join("Cargo.lock");
    if target.exists() {
        return Ok(());
    }
    let in_repo = |r: &PathBuf| {
        r.canonicalize()
            .map(|c| c.starts_with(repo.canonicalize().unwrap_or_else(|_| repo.to_owned())))
            .unwrap_or(false)
    };
    let own = roots.iter().filter(|r| in_repo(r));
    let fetched = roots.iter().filter(|r| !in_repo(r));
    if let Some(lock) = own
        .chain(fetched)
        .map(|r| r.join("Cargo.lock"))
        .find(|l| l.is_file())
    {
        std::fs::copy(&lock, &target)
            .with_context(|| format!("{} could not be copied into the tree", lock.display()))?;
    }
    Ok(())
}

/// A tool's output reduced to its `error` diagnostics, each with the lines
/// indented under it, or all of it when it names none. gearbox prints every
/// `info` and `warning` before it gives up, and a whole product's of them
/// pushed the one `error` out of the tail a failure keeps.
fn errors_first(text: &str) -> String {
    let mut kept = Vec::new();
    let mut in_error = false;
    for line in text.lines() {
        if line.starts_with(char::is_whitespace) {
            if in_error {
                kept.push(line);
            }
        } else {
            in_error = line.starts_with("error");
            if in_error {
                kept.push(line);
            }
        }
    }
    if kept.is_empty() {
        text.to_owned()
    } else {
        kept.join("\n")
    }
}

/// What a failed tool said, for the build's record: its errors from the
/// first, which name what broke (a gear, a file), or the end of all it said
/// when it names none.
fn failure_text(text: &str) -> String {
    let kept = errors_first(text);
    if kept == text {
        tail(text, FAILURE_CHARS)
    } else {
        head(&kept, FAILURE_CHARS)
    }
}

/// A step's failure as its container's termination message, which the watch
/// records as the build's reason. Without it the kubelet falls back to the
/// log's last 2 KiB, which the tool's own output fills, and the start of the
/// error -- the gear it names -- falls out of it.
pub fn say_failure(e: &anyhow::Error) {
    let text = format!("{e:#}");
    let mut end = text.len().min(4000);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let _ = std::fs::write("/dev/termination-log", &text[..end]);
}

fn gearbox() -> String {
    std::env::var("STUDIO_GEARBOX_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "gearbox".to_owned())
}

/// `studio-backend build-prepare`: the repository and its gear sources
/// cloned, the profile generated and made buildable, and what to build listed.
pub fn prepare(
    work: &Path,
    repo_url: &str,
    git_ref: Option<&str>,
    product_file: &str,
    profile: &str,
    own: Option<&str>,
) -> anyhow::Result<()> {
    let username = std::env::var("GIT_USERNAME").unwrap_or_default();
    let password = std::env::var("GIT_PASSWORD").unwrap_or_default();
    if let Some(own) = own {
        let own: super::model::OwnBuild =
            serde_json::from_str(own).context("--own is not a build of the repository's own")?;
        return prepare_own(work, repo_url, (&username, &password), git_ref, &own);
    }
    prepare_as(
        work,
        repo_url,
        (&username, &password),
        git_ref,
        product_file,
        profile,
    )
}

/// `build-prepare` for a project built without a product description
/// (ADR-0054 §7): the repository cloned, and its own Dockerfiles and chart
/// listed for `build` and `publish` as a generated tree's would be.
pub fn prepare_own(
    work: &Path,
    repo_url: &str,
    (username, password): (&str, &str),
    git_ref: Option<&str>,
    own: &super::model::OwnBuild,
) -> anyhow::Result<()> {
    let own = super::model::checked_own_build(own.clone()).map_err(|e| anyhow!("{e}"))?;
    let repo = work.join("repo");
    crate::connectors::sdk::git_checkout::clone_or_update_into(
        &repo, repo_url, username, password, git_ref,
    )
    .context("the repository could not be cloned")?;
    let commit = crate::connectors::sdk::git_checkout::head_commit(&repo)
        .ok_or_else(|| anyhow!("the clone has no commit"))?;
    let mut list = String::new();
    let mut named = Vec::new();
    for i in &own.images {
        let dockerfile = repo.join(&i.dockerfile);
        if !dockerfile.is_file() {
            bail!("{} is not in the repository at {commit}", i.dockerfile);
        }
        let folder = dockerfile.parent().unwrap_or(&repo).to_path_buf();
        let filename = dockerfile
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Dockerfile")
            .to_owned();
        let context = if i.context == "." {
            repo.clone()
        } else {
            repo.join(&i.context)
        };
        if !context.is_dir() {
            bail!(
                "the build context {} is not a folder in the repository",
                i.context
            );
        }
        list.push_str(&format!(
            "{} {} {} {} {}\n",
            i.app,
            i.name,
            folder.display(),
            context.display(),
            filename
        ));
        named.push((i.app.clone(), i.name.clone()));
    }
    std::fs::write(work.join("apps"), list)?;
    let short: String = commit.chars().take(12).collect();
    std::fs::write(work.join("tag"), format!("sha-{short}"))?;
    let chart_dir = repo.join(&own.chart);
    let chart_yaml = std::fs::read_to_string(chart_dir.join("Chart.yaml"))
        .with_context(|| format!("{} has no Chart.yaml", own.chart))?;
    let product = chart_yaml
        .lines()
        .find_map(|l| l.strip_prefix("name:"))
        .map(|n| n.trim().trim_matches('"').trim_matches('\'').to_owned())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| anyhow!("{}/Chart.yaml names no chart", own.chart))?;
    let prepared = Prepared {
        product,
        profile: "own".to_owned(),
        commit,
        lock_hash: None,
        chart_dir: chart_dir.display().to_string(),
        chart_base: chart_base_version(&chart_yaml),
        apps: named,
    };
    std::fs::write(
        work.join("build.json"),
        serde_json::to_vec_pretty(&prepared)?,
    )?;
    println!(
        "prepared {} image(s) and chart {} of the repository's own",
        prepared.apps.len(),
        prepared.product
    );
    Ok(())
}

/// [`prepare`] with the repository's credentials given, not read from the
/// environment: the server prepares a Research build in its own process.
pub fn prepare_as(
    work: &Path,
    repo_url: &str,
    (username, password): (&str, &str),
    git_ref: Option<&str>,
    product_file: &str,
    profile: &str,
) -> anyhow::Result<()> {
    if !super::workflow::is_product_file(product_file) {
        bail!("'{product_file}' is not a product description in the repository");
    }
    let repo = work.join("repo");
    crate::connectors::sdk::git_checkout::clone_or_update_into(
        &repo, repo_url, username, password, git_ref,
    )
    .context("the product's repository could not be cloned")?;
    let commit = crate::connectors::sdk::git_checkout::head_commit(&repo)
        .ok_or_else(|| anyhow!("the clone has no commit"))?;
    let file = repo.join(product_file);

    let intent: serde_json::Value = serde_json::from_str(&run(
        Command::new(gearbox())
            .arg("product")
            .arg("--file")
            .arg(&file)
            .args(["--format", "json"]),
        "gearbox product",
    )?)
    .context("gearbox product did not answer JSON")?;
    let product = intent
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("{product_file} names no product id"))?
        .to_owned();

    let sources_dir = repo.join(".gearbox-sources");
    std::fs::create_dir_all(&sources_dir)?;
    let base = Path::new(product_file).parent().unwrap_or(Path::new(""));
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(sources) = intent.get("sources").and_then(|s| s.as_object()) {
        for (id, s) in sources {
            if !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            {
                bail!("source id '{id}' is not a folder name");
            }
            match s.get("kind").and_then(|k| k.as_str()) {
                Some("git") => {
                    let url = s.get("url").and_then(|v| v.as_str()).unwrap_or_default();
                    let rev = s.get("rev").and_then(|v| v.as_str()).unwrap_or_default();
                    if !url.starts_with("https://") || rev.is_empty() {
                        bail!("source '{id}' is not an https git URL at a revision");
                    }
                    let dir = sources_dir.join(id);
                    run(
                        Command::new("git").arg("init").arg("-q").arg(&dir),
                        "git init",
                    )?;
                    run(
                        Command::new("git")
                            .arg("-C")
                            .arg(&dir)
                            .args(["-c", "core.longpaths=true", "fetch", "-q", "--depth", "1"])
                            .arg(url)
                            .arg(rev),
                        &format!("fetching source '{id}'"),
                    )?;
                    run(
                        Command::new("git").arg("-C").arg(&dir).args([
                            "checkout",
                            "-q",
                            "FETCH_HEAD",
                        ]),
                        &format!("checking out source '{id}'"),
                    )?;
                    roots.push(dir);
                }
                Some("path") => {
                    let at = s.get("at").and_then(|v| v.as_str()).unwrap_or_default();
                    let dir = inside(&repo, &base.join(at))
                        .ok_or_else(|| anyhow!("source '{id}' points outside the repository"))?;
                    if dir.file_name().and_then(|n| n.to_str()) == Some(id.as_str()) {
                        roots.push(dir);
                    } else {
                        #[cfg(unix)]
                        {
                            let link = sources_dir.join(id);
                            let rel = dir
                                .strip_prefix(&repo)
                                .map(|r| Path::new("..").join(r))
                                .unwrap_or(dir.clone());
                            std::os::unix::fs::symlink(&rel, &link)?;
                            roots.push(link);
                        }
                        #[cfg(not(unix))]
                        bail!("source '{id}' needs a link, which this platform cannot make");
                    }
                }
                other => bail!("source '{id}' is of a kind this build does not know ({other:?})"),
            }
        }
    }

    let out = repo.join(".gearbox").join("out");
    let mut generate = Command::new(gearbox());
    generate.arg("generate");
    for r in &roots {
        generate.arg("--root").arg(r);
    }
    generate
        .arg("--product")
        .arg(&file)
        .arg("--profile")
        .arg(profile)
        .arg("--out")
        .arg(&out);
    run(&mut generate, "gearbox generate")?;
    seed_lock(&roots, &repo, &out)?;

    // The tree, made buildable (constructorfabric/gearbox#12).
    let docker = out.join("docker");
    let ignore = std::fs::read_to_string(docker.join(".dockerignore")).ok();
    let script = std::fs::read_to_string(docker.join("build.sh"))
        .context("the generated tree has no docker/build.sh: is the profile a kubernetes one?")?;
    let (context_rel, apps) = read_build_script(&script)?;
    // `../../..` from docker/ climbs out of it by design: the context is the
    // common ancestor of the tree and the sources. It must stay in /work.
    let context = inside(
        work,
        docker
            .strip_prefix(work)
            .unwrap_or(&docker)
            .join(&context_rel)
            .as_path(),
    )
    .ok_or_else(|| anyhow!("the build context '{context_rel}' leaves the work folder"))?;
    let mut list = String::new();
    let mut named = Vec::new();
    for (app, image) in &apps {
        let dockerfile = docker.join(app).join("Dockerfile");
        let text = std::fs::read_to_string(&dockerfile)
            .with_context(|| format!("no Dockerfile for {app}"))?;
        std::fs::write(&dockerfile, with_build_tools(&text))?;
        if let Some(ignore) = &ignore {
            std::fs::write(docker.join(app).join("Dockerfile.dockerignore"), ignore)?;
        }
        let name = image.split(':').next().unwrap_or(image).to_owned();
        list.push_str(&format!(
            "{app} {name} {} {}\n",
            docker.join(app).display(),
            context.display()
        ));
        named.push((app.clone(), name));
    }
    std::fs::write(work.join("apps"), list)?;
    let short: String = commit.chars().take(12).collect();
    std::fs::write(work.join("tag"), format!("sha-{short}"))?;

    let chart_dir = out.join("helm").join(&product);
    let chart_base = chart_base_version(
        &std::fs::read_to_string(chart_dir.join("Chart.yaml"))
            .context("the generated chart has no Chart.yaml")?,
    );
    let lock_hash = std::fs::read(out.join("product.lock"))
        .ok()
        .map(|b| hex::encode(Sha256::digest(&b)));
    let prepared = Prepared {
        product,
        profile: profile.to_owned(),
        commit,
        lock_hash,
        chart_dir: chart_dir.display().to_string(),
        chart_base,
        apps: named,
    };
    std::fs::write(
        work.join("build.json"),
        serde_json::to_vec_pretty(&prepared)?,
    )?;
    println!(
        "prepared {} application(s) of {}",
        prepared.apps.len(),
        prepared.product
    );
    Ok(())
}

/// The digest BuildKit wrote for a pushed image.
pub fn digest_of(metadata: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata)
        .ok()?
        .get("containerimage.digest")?
        .as_str()
        .filter(|d| d.starts_with("sha256:"))
        .map(str::to_owned)
}

/// `studio-backend build-publish`: the chart pushed beside the images, and
/// the manifest left where Studio reads it.
pub fn publish(work: &Path, prefix: &str, registry_config: &Path) -> anyhow::Result<String> {
    let prepared: Prepared = serde_json::from_slice(&std::fs::read(work.join("build.json"))?)?;
    let short: String = prepared.commit.chars().take(12).collect();
    let tag = format!("sha-{short}");
    let mut images = Vec::new();
    for (app, name) in &prepared.apps {
        let meta = std::fs::read_to_string(work.join("meta").join(format!("{app}.json")))
            .with_context(|| format!("{app} was not built"))?;
        let digest = digest_of(&meta).ok_or_else(|| anyhow!("{app} was built without a digest"))?;
        images.push(ManifestImage {
            app: app.clone(),
            image: format!("{prefix}/{name}:{tag}@{digest}"),
        });
    }
    let version = format!("{}-sha.{short}", prepared.chart_base);
    let charts = work.join("charts");
    std::fs::create_dir_all(&charts)?;
    let home = work.join("helm");
    let helm = |args: &[&str]| -> anyhow::Result<String> {
        run(
            Command::new("helm")
                .args(args)
                .env("HELM_CACHE_HOME", home.join("cache"))
                .env("HELM_CONFIG_HOME", home.join("config"))
                .env("HELM_DATA_HOME", home.join("data")),
            &format!("helm {}", args.first().copied().unwrap_or_default()),
        )
    };
    helm(&[
        "package",
        &prepared.chart_dir,
        "--version",
        &version,
        "--destination",
        &charts.display().to_string(),
    ])?;
    let packaged = charts.join(format!("{}-{version}.tgz", prepared.product));
    helm(&[
        "push",
        &packaged.display().to_string(),
        &format!("oci://{prefix}/charts"),
        "--registry-config",
        &registry_config.display().to_string(),
    ])?;
    let manifest = Manifest {
        product: prepared.product.clone(),
        profile: prepared.profile,
        commit: prepared.commit,
        lock_hash: prepared.lock_hash,
        images,
        chart: ManifestChart {
            reference: format!("oci://{prefix}/charts/{}", prepared.product),
            version,
        },
    };
    let text = serde_json::to_string(&manifest)?;
    // The kubelet keeps a container's termination message (at most 4 KiB):
    // that is how Studio reads what was published without reading logs.
    let _ = std::fs::write("/dev/termination-log", &text);
    println!("{text}");
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILD_SH: &str = "#!/bin/sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- \"$(dirname \"$0\")\" && pwd)\nCONTEXT=$(CDPATH= cd -- \"$SCRIPT_DIR/\"'../../..' && pwd)\nbuild_one() {\n  :\n}\nif [ \"$#\" -eq 0 ]; then\n  build_one api-gateway 'gbx-api-gateway:0.1.0'\n  build_one worker 'gbx-worker:0.1.0'\n  exit 0\nfi\nfor name in \"$@\"; do\n  case \"$name\" in\n    api-gateway) build_one api-gateway 'gbx-api-gateway:0.1.0' ;;\n  esac\ndone\n";

    fn payload() -> BuildPayload {
        BuildPayload {
            build_id: "studio-0123456789ab".into(),
            organization_id: Uuid::nil(),
            project_id: Uuid::nil(),
            connection_id: Uuid::nil(),
            registry_connection_id: Uuid::nil(),
            namespace: "studio-web-dev".into(),
            prefix: "ghcr.io/acme".into(),
            profile: "prod".into(),
            product_file: "products/sample/product.gdl".into(),
            repo: RepoRef {
                tenant: Uuid::nil(),
                connection_id: Uuid::nil(),
                repo: "acme/shop".into(),
                branch: "main".into(),
            },
            git_ref: None,
            builder_image: "ghcr.io/acme/studio-backend:sha-1".into(),
            buildkit_image: BUILDKIT_IMAGE.into(),
            records_in: None,
            connections_from: None,
            own: None,
        }
    }

    #[test]
    fn a_watch_queued_before_records_in_still_reads_and_carries_it_on() {
        // A run queued by the release before: no `records_in`.
        let old: WatchPayload = serde_json::from_value(serde_json::json!({
            "build_id": "studio-0123456789ab", "organization_id": Uuid::nil(),
            "project_id": Uuid::nil(), "connection_id": Uuid::nil(),
            "namespace": "studio-web-dev", "job": "studio-build-0123456789ab",
            "repository": "acme/shop", "profile": "prod",
        }))
        .unwrap();
        assert_eq!(old.records_in, None);
        let mut b = payload();
        let tenant = Uuid::from_u128(1);
        b.records_in = Some(tenant);
        let back: BuildPayload = serde_json::from_value(serde_json::to_value(&b).unwrap()).unwrap();
        assert_eq!(back.records_in, Some(tenant));
    }

    fn pod(init: serde_json::Value, main: serde_json::Value) -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "studio-build-1" },
            "status": { "initContainerStatuses": init, "containerStatuses": main },
        }))
        .unwrap()
    }

    fn done(name: &str) -> serde_json::Value {
        serde_json::json!({ "name": name, "ready": false, "restartCount": 0, "image": "i", "imageID": "",
            "state": { "terminated": { "exitCode": 0 } } })
    }

    fn waiting(name: &str, reason: &str) -> serde_json::Value {
        serde_json::json!({ "name": name, "ready": false, "restartCount": 0, "image": "i", "imageID": "",
            "state": { "waiting": { "reason": reason, "message": "no such image" } } })
    }

    #[test]
    fn the_step_is_the_first_container_that_has_not_ended() {
        let p = pod(
            serde_json::json!([done("prepare"), waiting("build", "PodInitializing")]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(current_step(&p).as_deref(), Some("build"));
        let p = pod(
            serde_json::json!([done("prepare"), done("build")]),
            serde_json::json!([waiting("publish", "ContainerCreating")]),
        );
        assert_eq!(current_step(&p).as_deref(), Some("publish"));
        assert_eq!(stuck(&p), None);
    }

    #[test]
    fn each_step_says_whether_it_ran_so_only_a_started_ones_log_is_read() {
        let failed = serde_json::json!({ "name": "prepare", "ready": false, "restartCount": 0,
            "image": "i", "imageID": "", "state": { "terminated": { "exitCode": 1 } } });
        let running = serde_json::json!({ "name": "build", "ready": true, "restartCount": 0,
            "image": "i", "imageID": "", "state": { "running": {} } });
        let p = pod(
            serde_json::json!([failed, waiting("build", "PodInitializing")]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(
            steps_of(&p),
            vec![
                ("prepare".to_owned(), "failed"),
                ("build".to_owned(), "waiting"),
                ("publish".to_owned(), "waiting"),
            ]
        );
        let p = pod(
            serde_json::json!([done("prepare"), running]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(steps_of(&p)[0], ("prepare".to_owned(), "passed"));
        assert_eq!(steps_of(&p)[1], ("build".to_owned(), "running"));
    }

    #[test]
    fn an_image_that_cannot_be_pulled_fails_the_build_at_once() {
        let p = pod(
            serde_json::json!([waiting("prepare", "ImagePullBackOff")]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(
            stuck(&p),
            Some(("prepare".into(), "ImagePullBackOff: no such image".into()))
        );
    }

    #[test]
    fn the_tree_gets_the_lock_of_the_products_own_code_before_a_fetched_ones() {
        let work = std::env::temp_dir().join(format!("studio-seed-lock-{}", Uuid::new_v4()));
        let repo = work.join("repo");
        let own = repo.join("studio-backend");
        let fetched = work.join("sources").join("gears-rust");
        let out = repo.join(".gearbox").join("out");
        for d in [&own, &fetched, &out] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(fetched.join("Cargo.lock"), "fetched").unwrap();
        std::fs::write(own.join("Cargo.lock"), "own").unwrap();

        seed_lock(&[fetched.clone(), own.clone()], &repo, &out).unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("Cargo.lock")).unwrap(),
            "own"
        );

        // A lock the engine wrote is the tree's own, and stays.
        std::fs::write(out.join("Cargo.lock"), "generated").unwrap();
        seed_lock(&[own], &repo, &out).unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("Cargo.lock")).unwrap(),
            "generated"
        );

        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn a_failure_keeps_its_errors_however_many_notes_come_before_them() {
        let notes = "info [GBX0517] two plugins share a vendor\n    help: give them priorities\n"
            .repeat(40);
        let text = format!(
            "{notes}error [GBX0511] gear `tenant-resolver` has no implementation\n    \
             help: pick one\nwarning [GBX0315] no gRPC services\nerror: resolution reported errors"
        );
        let kept = errors_first(&text);
        assert_eq!(
            kept,
            "error [GBX0511] gear `tenant-resolver` has no implementation\n    help: pick one\n\
             error: resolution reported errors"
        );
        assert_eq!(errors_first("fatal: no such ref"), "fatal: no such ref");
    }

    #[test]
    fn a_failure_keeps_the_start_of_its_errors_and_the_end_of_a_log() {
        let error = "error [GBX0322] gear `tenant-resolver` carries `#[toolkit::consumes(...)]`";
        let notes = "info [GBX0517] note\n".repeat(40);
        let text = format!("{notes}{error}\n    help: {}", "x".repeat(5000));
        let kept = failure_text(&text);
        assert!(kept.starts_with(error), "{kept}");
        assert_eq!(kept.chars().count(), FAILURE_CHARS + 1);

        let log = format!("{}fatal: no such ref", "y".repeat(5000));
        let kept = failure_text(&log);
        assert!(
            kept.starts_with('…') && kept.ends_with("fatal: no such ref"),
            "{kept}"
        );
    }

    #[test]
    fn the_last_watch_round_comes_after_the_deadline() {
        assert!(u64::from(LAST_WATCH_ROUND) * WATCH_FOR.as_secs() > DEADLINE_SECS as u64);
    }

    #[test]
    fn the_build_script_lists_each_application_once_and_its_context() {
        let (context, apps) = read_build_script(BUILD_SH).unwrap();
        assert_eq!(context, "../../..");
        assert_eq!(
            apps,
            [
                ("api-gateway".to_owned(), "gbx-api-gateway:0.1.0".to_owned()),
                ("worker".to_owned(), "gbx-worker:0.1.0".to_owned()),
            ]
        );
        assert!(read_build_script("no script").is_err());
    }

    #[test]
    fn the_build_stage_gets_its_tools_once() {
        let df = "# GENERATED\nFROM rust:1.97.0-bookworm AS build\nWORKDIR /src\n\nFROM debian:bookworm-slim\n";
        let fixed = with_build_tools(df);
        let lines: Vec<&str> = fixed.lines().collect();
        assert_eq!(lines[1], "FROM rust:1.97.0-bookworm AS build");
        assert!(lines[2].contains("protobuf-compiler libprotobuf-dev cmake"));
        assert_eq!(with_build_tools(&fixed), fixed);
    }

    #[test]
    fn a_path_never_leaves_its_root() {
        let root = Path::new("/work/repo");
        assert_eq!(
            inside(root, Path::new("products/sample/../../studio-backend")),
            Some(PathBuf::from("/work/repo/studio-backend"))
        );
        assert_eq!(inside(root, Path::new("../etc")), None);
        assert_eq!(inside(root, Path::new("a/../../b")), None);
    }

    #[test]
    fn the_chart_version_and_the_digest_are_read_from_what_tools_wrote() {
        assert_eq!(
            chart_base_version("apiVersion: v2\nname: shop\nversion: \"0.1.0\"\n"),
            "0.1.0"
        );
        assert_eq!(chart_base_version("name: x\n"), "0.1.0");
        assert_eq!(
            digest_of(r#"{"containerimage.digest":"sha256:abc","image.name":"x"}"#).as_deref(),
            Some("sha256:abc")
        );
        assert_eq!(digest_of("{}"), None);
    }

    #[test]
    fn a_build_of_the_repositorys_own_tells_prepare_what_to_build() {
        let mut p = payload();
        assert!(
            !job_manifest(&p, true)["spec"]["template"]["spec"]["initContainers"][0]["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a == "--own")
        );
        p.own = Some(super::super::model::OwnBuild {
            images: vec![super::super::model::OwnImage {
                app: "hello".into(),
                name: "csharp-hello".into(),
                dockerfile: "Dockerfile".into(),
                context: ".".into(),
            }],
            chart: "chart/csharp-hello".into(),
        });
        let job = job_manifest(&p, true);
        let args = job["spec"]["template"]["spec"]["initContainers"][0]["args"]
            .as_array()
            .unwrap()
            .clone();
        let at = args.iter().position(|a| a == "--own").unwrap();
        let own: super::super::model::OwnBuild =
            serde_json::from_str(args[at + 1].as_str().unwrap()).unwrap();
        assert_eq!(own, p.own.unwrap());
        assert!(BUILD_SCRIPT.contains("--opt filename=\"${filename:-Dockerfile}\""));
    }

    #[test]
    fn the_job_runs_rootless_buildkit_between_studios_own_steps() {
        let job = with_clone_url(
            job_manifest(&payload(), true),
            "https://github.com/acme/shop.git",
        );
        assert_eq!(job["metadata"]["name"], "studio-build-0123456789ab");
        let spec = &job["spec"]["template"]["spec"];
        assert_eq!(spec["initContainers"][0]["name"], "prepare");
        assert_eq!(
            spec["initContainers"][0]["args"][4],
            "https://github.com/acme/shop.git"
        );
        assert!(
            spec["initContainers"][0]["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a == "main")
        );
        let build = &spec["initContainers"][1];
        assert_eq!(build["image"], BUILDKIT_IMAGE);
        assert!(build["securityContext"].get("privileged").is_none());
        assert_eq!(build["securityContext"]["runAsUser"], 1000);
        assert_eq!(spec["containers"][0]["name"], "publish");
        assert_eq!(
            spec["volumes"][2]["secret"]["secretName"],
            deploy::PULL_SECRET
        );
        assert_eq!(job["spec"]["backoffLimit"], 0);
        let plain = job_manifest(&payload(), false);
        assert!(
            plain["spec"]["template"]["spec"]["initContainers"][0]["env"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["name"] != "GIT_PASSWORD")
        );
    }

    #[test]
    fn job_and_secret_names_are_dns_labels() {
        assert!(super::super::model::is_dns_label(&job_name(
            "studio-0123456789ab"
        )));
        assert!(super::super::model::is_dns_label(&git_secret_name(
            "studio-0123456789ab"
        )));
        assert!(job_name(&"x".repeat(100)).len() <= 63);
    }
}
