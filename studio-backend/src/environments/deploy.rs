//! A deploy on the server (ADR-0043 §3): the run that installs a product's
//! chart into an environment, and the status read back afterwards.
//!
//! The run gets everything it needs in its payload -- the chart, the values,
//! the namespace, which connection -- so it reads nothing a person could have
//! changed after the deploy was asked for and approved, except the cluster's
//! credential, which it reads from credstore as the service at the last
//! moment and writes only into a file of its own that it removes afterwards.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use base64::Engine;
use k8s_openapi::api::apps::v1::Deployment as KubeDeployment;
use k8s_openapi::api::core::v1::{LocalObjectReference, Namespace, Secret, ServiceAccount};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::{ListParams, ObjectMeta, Patch, PatchParams, PostParams};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use toolkit::client_hub::ClientHub;
use tracing::{info, warn};
use uuid::Uuid;

use super::database;
use super::model::{ChartRef, DatabaseMode, DeploymentAction};
use crate::connectors::sdk::{ClusterAccess, Connectors, RegistryAccess, same_registry};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "environments.deploy";

/// How long `helm upgrade --wait` waits for the release to come up. Under the
/// task lease (15 minutes), so a slow rollout fails as itself rather than as a
/// lost lease.
const HELM_TIMEOUT: &str = "8m";

/// The helm binary: `STUDIO_HELM`, or `helm` on the PATH (the image installs
/// one).
fn helm_binary() -> String {
    std::env::var("STUDIO_HELM")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "helm".to_owned())
}

/// The pull secret a deploy writes into the project's namespace (ADR-0048 §2).
pub const PULL_SECRET: &str = super::model::PULL_SECRET_NAME;

/// The field manager the deploy's own writes to the namespace are made as.
const FIELD_MANAGER: &str = "constructor-studio";

/// What the deploy route or an approval puts on the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployPayload {
    pub deployment_id: Uuid,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub connection_id: Uuid,
    /// The environment's registry: the namespace's pull secret, and the login
    /// a published chart is fetched with.
    #[serde(default)]
    pub registry_connection_id: Option<Uuid>,
    pub namespace: String,
    pub release: String,
    /// Install (payloads queued before uninstall existed) or uninstall.
    #[serde(default)]
    pub action: DeploymentAction,
    /// The environment, which with the project names where the release's
    /// configuration secrets are kept.
    #[serde(default)]
    pub environment_id: Uuid,
    /// The keys of the release's configuration secrets; their values are
    /// read from credstore by the run and written into the namespace.
    #[serde(default)]
    pub secret_keys: Vec<String>,
    /// How the environment gives the product its database.
    #[serde(default)]
    pub database: DatabaseMode,
    #[serde(default)]
    pub database_image: Option<String>,
    /// The chart, a `.tgz`, base64; `None` when it is published and named by
    /// [`Self::chart_ref`].
    #[serde(default)]
    pub chart: Option<String>,
    #[serde(default)]
    pub chart_ref: Option<ChartRef>,
    /// Values given to the chart: the images under the environment's registry.
    pub values: serde_json::Value,
}

pub struct DeployTask {
    hub: Arc<ClientHub>,
}

impl DeployTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

impl DeployTask {
    /// Read the release's configuration secrets from credstore, as the
    /// service, and write them into the namespace as one secret the chart's
    /// applications read (`existingSecret`).
    async fn write_config_secrets(
        &self,
        ctx: &toolkit_security::SecurityContext,
        client: &kube::Client,
        p: &DeployPayload,
    ) -> anyhow::Result<()> {
        let credstore = self
            .hub
            .get::<dyn credstore_sdk::CredStoreClientV1>()
            .map_err(|_| anyhow!("credstore is not available in this deployment"))?;
        let mut data = serde_json::Map::new();
        for key in &p.secret_keys {
            let reference = super::model::config_secret_ref(p.project_id, p.environment_id, key);
            let sref = credstore_sdk::SecretRef::new(&reference)
                .map_err(|e| anyhow!("bad secret reference {reference}: {e}"))?;
            let value = credstore
                .get(ctx, &sref)
                .await
                .map_err(|e| anyhow!("credstore: {e}"))?
                .ok_or_else(|| anyhow!("configuration secret {key} has no value: set it again"))?;
            let text = String::from_utf8(value.value.as_bytes().to_vec())
                .map_err(|_| anyhow!("configuration secret {key} is not text"))?;
            data.insert(key.clone(), text.into());
        }
        let name = super::model::config_secret_name(&p.release);
        let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), &p.namespace);
        let object = serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": name, "labels": { "app.kubernetes.io/managed-by": FIELD_MANAGER } },
            "type": "Opaque",
            "stringData": data,
        });
        secrets
            .patch(
                &name,
                &PatchParams::apply(FIELD_MANAGER).force(),
                &Patch::Apply(&object),
            )
            .await
            .map(|_| ())
            .map_err(|e| {
                anyhow!(
                    "the configuration secret could not be written into {}: {e}",
                    p.namespace
                )
            })
    }
}

/// The cluster's access for a connection, read as `ctx`.
pub async fn cluster_access(
    hub: &Arc<ClientHub>,
    ctx: &toolkit_security::SecurityContext,
    organization: Uuid,
    connection: Uuid,
) -> anyhow::Result<ClusterAccess> {
    let connectors = Connectors::new(Arc::clone(hub))
        .get()
        .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
    let (_, auth, c) = connectors
        .driver_and_auth(ctx, organization, connection)
        .await
        .map_err(|e| anyhow!("the environment's cluster connection cannot be used: {e:#}"))?;
    if c.provider != "kubernetes" {
        return Err(anyhow!(
            "connection '{}' is a {} connection, not a Kubernetes cluster",
            c.label,
            c.provider
        ));
    }
    ClusterAccess::parse(&auth.base_url, &auth.token)
}

/// The registry's login for a connection, read as `ctx`.
pub async fn registry_access(
    hub: &Arc<ClientHub>,
    ctx: &toolkit_security::SecurityContext,
    organization: Uuid,
    connection: Uuid,
) -> anyhow::Result<RegistryAccess> {
    let connectors = Connectors::new(Arc::clone(hub))
        .get()
        .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
    let (_, auth, c) = connectors
        .driver_and_auth(ctx, organization, connection)
        .await
        .map_err(|e| anyhow!("the environment's registry connection cannot be used: {e:#}"))?;
    if c.provider != "registry" {
        return Err(anyhow!(
            "connection '{}' is a {} connection, not a container registry",
            c.label,
            c.provider
        ));
    }
    RegistryAccess::parse(&auth.base_url, &auth.token)
}

#[async_trait]
impl TaskHandler for DeployTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    /// Two: a cluster that did not answer gets one more try; a chart the
    /// cluster refused will refuse again, so `run` says Failed for that.
    fn max_attempts(&self) -> i16 {
        2
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: DeployPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-environments: this run's payload is not a deploy ({e})"
                ));
            }
        };
        ctx.progress("reading the cluster's access").await;
        let access = match cluster_access(
            &self.hub,
            &ctx.security,
            payload.organization_id,
            payload.connection_id,
        )
        .await
        {
            Ok(a) => a,
            Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        if payload.action == DeploymentAction::Uninstall {
            ctx.progress(format!(
                "helm uninstall {} from {}",
                payload.release, payload.namespace
            ))
            .await;
            return match helm_uninstall(&access, &payload, &ctx.cancel).await {
                Ok(_) => TaskOutcome::done_with(
                    format!("{} uninstalled from {}", payload.release, payload.namespace),
                    serde_json::json!({}),
                ),
                Err(e) => TaskOutcome::Failed(format!("{e:#}")),
            };
        }
        let registry = match payload.registry_connection_id {
            Some(id) => {
                match registry_access(&self.hub, &ctx.security, payload.organization_id, id).await {
                    Ok(r) => Some(r),
                    Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
                }
            }
            None => None,
        };
        ctx.progress(format!("preparing namespace {}", payload.namespace))
            .await;
        let client = match access.client().await {
            Ok(client) => client,
            Err(e) => return TaskOutcome::Retry(format!("{e:#}")),
        };
        if let Err(e) = ensure_namespace(&client, &payload).await {
            return TaskOutcome::Failed(format!("{e:#}"));
        }
        if let Some(registry) = &registry {
            ctx.progress(format!("writing the pull secret for {}", registry.host))
                .await;
            if let Err(e) = write_pull_secret(&client, &payload.namespace, registry).await {
                return TaskOutcome::Failed(format!("{e:#}"));
            }
        }
        if !payload.secret_keys.is_empty() {
            ctx.progress("writing the release's configuration secrets")
                .await;
            if let Err(e) = self
                .write_config_secrets(&ctx.security, &client, &payload)
                .await
            {
                return TaskOutcome::Failed(format!("{e:#}"));
            }
        }
        let scratch = match Scratch::new() {
            Ok(s) => s,
            Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        let prepared = match prepare(&scratch, &access, registry.as_ref(), &payload) {
            Ok(p) => p,
            Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        if payload.database == DatabaseMode::Namespace {
            ctx.progress("reading what the chart needs of databases")
                .await;
            let rendered = match helm(
                &scratch,
                helm_template_args(&payload, &prepared),
                &ctx.cancel,
            )
            .await
            {
                Ok(out) => out,
                Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
            };
            let needs = match database::needs(&rendered) {
                Ok(n) => n,
                Err(e) => {
                    return TaskOutcome::Failed(format!(
                        "the chart's database configuration: {e:#}"
                    ));
                }
            };
            let image = payload
                .database_image
                .clone()
                .unwrap_or_else(|| database::DEFAULT_IMAGE.to_owned());
            for need in &needs {
                ctx.progress(format!(
                    "preparing the product's Postgres ({}, {} databases)",
                    need.host,
                    need.databases.len()
                ))
                .await;
                if let Err(e) = database::ensure(&client, &payload.namespace, need, &image).await {
                    return TaskOutcome::Failed(format!("{e:#}"));
                }
            }
        }
        ctx.progress(format!(
            "helm upgrade --install {} into {}",
            payload.release, payload.namespace
        ))
        .await;
        match helm(&scratch, helm_args(&payload, &prepared), &ctx.cancel).await {
            Ok(out) => {
                info!(
                    deployment = %payload.deployment_id,
                    namespace = %payload.namespace,
                    "studio-environments: release installed"
                );
                TaskOutcome::done_with(
                    format!("{} installed into {}", payload.release, payload.namespace),
                    serde_json::json!({ "output": tail(&out, 4000) }),
                )
            }
            Err(e) => TaskOutcome::Failed(format!("{e:#}")),
        }
    }
}

/// The last `n` bytes of `s`, on a character boundary.
fn tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_owned();
    }
    let mut at = s.len() - n;
    while !s.is_char_boundary(at) {
        at += 1;
    }
    format!("…{}", &s[at..])
}

/// Make sure the namespace exists, creating it when the connection may. A
/// connection limited to its namespaces cannot read namespaces at all, and is
/// trusted to have been given this one.
pub(super) async fn prepare_namespace(
    client: &kube::Client,
    namespace: &str,
    project: Uuid,
) -> anyhow::Result<()> {
    let namespaces: kube::Api<Namespace> = kube::Api::all(client.clone());
    match namespaces.get_opt(namespace).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            let ns = Namespace {
                metadata: ObjectMeta {
                    name: Some(namespace.to_owned()),
                    labels: Some(
                        [
                            (
                                "app.kubernetes.io/managed-by".to_owned(),
                                "constructor-studio".to_owned(),
                            ),
                            (
                                "studio.constructor.tech/project".to_owned(),
                                project.to_string(),
                            ),
                        ]
                        .into(),
                    ),
                    ..ObjectMeta::default()
                },
                ..Namespace::default()
            };
            namespaces
                .create(&PostParams::default(), &ns)
                .await
                .map(|_| ())
                .map_err(|e| {
                    anyhow!(
                        "namespace {} does not exist and the cluster connection may not \
                         create it: create it, or let the connection's service account \
                         create namespaces ({e})",
                        namespace
                    )
                })
        }
        Err(kube::Error::Api(status)) if status.code == 403 => {
            warn!(namespace = %namespace, "studio-environments: cannot read namespaces; assuming it exists");
            Ok(())
        }
        Err(e) => Err(anyhow!("the cluster did not answer: {e}")),
    }
}

async fn ensure_namespace(client: &kube::Client, p: &DeployPayload) -> anyhow::Result<()> {
    prepare_namespace(client, &p.namespace, p.project_id).await
}

/// The registry's login as the namespace's pull secret, used by every pod
/// that runs as the namespace's `default` service account (ADR-0048 §2). A
/// chart need not know about it, and a rotated token reaches the cluster with
/// the next deploy, because the secret is written on every one.
pub(super) async fn write_pull_secret(
    client: &kube::Client,
    namespace: &str,
    registry: &RegistryAccess,
) -> anyhow::Result<()> {
    let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), namespace);
    let secret = Secret {
        metadata: ObjectMeta {
            name: Some(PULL_SECRET.to_owned()),
            labels: Some(
                [(
                    "app.kubernetes.io/managed-by".to_owned(),
                    FIELD_MANAGER.to_owned(),
                )]
                .into(),
            ),
            ..ObjectMeta::default()
        },
        type_: Some("kubernetes.io/dockerconfigjson".to_owned()),
        string_data: Some(
            [(
                ".dockerconfigjson".to_owned(),
                registry.docker_config_json(),
            )]
            .into(),
        ),
        ..Secret::default()
    };
    secrets
        .patch(
            PULL_SECRET,
            &PatchParams::apply(FIELD_MANAGER).force(),
            &Patch::Apply(&secret),
        )
        .await
        .map_err(|e| {
            anyhow!(
                "the pull secret could not be written into {namespace}: the cluster connection \
                 needs to manage secrets there ({e})"
            )
        })?;

    // The `default` service account appears a moment after its namespace;
    // wait for it rather than race the controller that makes it.
    let accounts: kube::Api<ServiceAccount> = kube::Api::namespaced(client.clone(), namespace);
    for _ in 0..10 {
        match accounts.get_opt("default").await {
            Ok(Some(sa)) => {
                let Some(names) = with_pull_secret(&sa) else {
                    return Ok(());
                };
                let patch = serde_json::json!({ "imagePullSecrets": names });
                return accounts
                    .patch("default", &PatchParams::default(), &Patch::Merge(&patch))
                    .await
                    .map(|_| ())
                    .map_err(|e| {
                        anyhow!(
                            "the default service account in {namespace} could not be given the \
                             pull secret ({e})"
                        )
                    });
            }
            Ok(None) => tokio::time::sleep(Duration::from_secs(1)).await,
            Err(e) => return Err(anyhow!("the cluster did not answer: {e}")),
        }
    }
    Err(anyhow!(
        "namespace {namespace} has no default service account after 10 s"
    ))
}

/// The account's pull secrets with [`PULL_SECRET`] added, or `None` when it
/// already has it. A merge patch replaces the whole list, so the others are
/// kept by name.
fn with_pull_secret(sa: &ServiceAccount) -> Option<Vec<serde_json::Value>> {
    let have: Vec<String> = sa
        .image_pull_secrets
        .iter()
        .flatten()
        .map(|r: &LocalObjectReference| r.name.clone())
        .collect();
    if have.iter().any(|n| n == PULL_SECRET) {
        return None;
    }
    Some(
        have.into_iter()
            .chain(std::iter::once(PULL_SECRET.to_owned()))
            .map(|name| serde_json::json!({ "name": name }))
            .collect(),
    )
}

/// A directory only this process reads, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> anyhow::Result<Self> {
        let dir = std::env::temp_dir().join(format!("studio-deploy-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).context("cannot create a scratch directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self(dir))
    }

    fn write(&self, name: &str, bytes: &[u8]) -> anyhow::Result<PathBuf> {
        let path = self.0.join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options
            .open(&path)
            .and_then(|mut f| f.write_all(bytes))
            .with_context(|| format!("cannot write {name}"))?;
        Ok(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What every helm call of a run reads, written into its scratch directory:
/// the chart (a path, or a published chart's reference), the values, the
/// kubeconfig and, for a published chart, the registry login.
pub struct Prepared {
    pub chart: String,
    pub values: std::path::PathBuf,
    pub kubeconfig: std::path::PathBuf,
    pub registry_config: Option<std::path::PathBuf>,
}

fn prepare(
    scratch: &Scratch,
    access: &ClusterAccess,
    registry: Option<&RegistryAccess>,
    p: &DeployPayload,
) -> anyhow::Result<Prepared> {
    let (chart, registry_config) = match (&p.chart_ref, &p.chart) {
        (Some(r), _) => {
            let registry = registry.ok_or_else(|| {
                anyhow!(
                    "a published chart is pulled with the environment's registry, and it has none"
                )
            })?;
            same_registry(registry, &r.reference)?;
            let config =
                scratch.write("registry.json", registry.docker_config_json().as_bytes())?;
            (r.reference.clone(), Some(config))
        }
        (None, Some(chart)) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(chart.as_bytes())
                .context("the chart is not base64")?;
            let path = scratch.write("chart.tgz", &bytes)?;
            (path.display().to_string(), None)
        }
        (None, None) => return Err(anyhow!("the deploy names no chart")),
    };
    Ok(Prepared {
        chart,
        values: scratch.write("values.json", serde_json::to_string(&p.values)?.as_bytes())?,
        kubeconfig: scratch.write("kubeconfig", access.kubeconfig_yaml().as_bytes())?,
        registry_config,
    })
}

/// The arguments of the install, so a test can say what runs.
pub fn helm_args(p: &DeployPayload, c: &Prepared) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "upgrade".into(),
        "--install".into(),
        p.release.clone(),
        c.chart.clone(),
        "--namespace".into(),
        p.namespace.clone(),
        "--values".into(),
        c.values.display().to_string(),
        "--kubeconfig".into(),
        c.kubeconfig.display().to_string(),
        "--wait".into(),
        "--timeout".into(),
        HELM_TIMEOUT.into(),
        "--history-max".into(),
        "10".into(),
    ];
    chart_source_args(p, c, &mut args);
    args
}

/// The arguments that render the chart as the install would, without the
/// cluster: what the database step reads.
pub fn helm_template_args(p: &DeployPayload, c: &Prepared) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "template".into(),
        p.release.clone(),
        c.chart.clone(),
        "--namespace".into(),
        p.namespace.clone(),
        "--values".into(),
        c.values.display().to_string(),
    ];
    chart_source_args(p, c, &mut args);
    args
}

fn chart_source_args(p: &DeployPayload, c: &Prepared, args: &mut Vec<String>) {
    if let Some(r) = &p.chart_ref {
        args.push("--version".into());
        args.push(r.version.clone());
    }
    if let Some(config) = &c.registry_config {
        args.push("--registry-config".into());
        args.push(config.display().to_string());
    }
}

/// Run helm with `args`, its homes under the scratch directory: the
/// server's home is not writable, and nothing should outlive the run.
async fn helm(
    scratch: &Scratch,
    args: Vec<String>,
    cancel: &tokio_util::sync::CancellationToken,
) -> anyhow::Result<String> {
    let what = args.first().cloned().unwrap_or_default();
    let home = scratch.path().join("helm");
    let mut cmd = Command::new(helm_binary());
    cmd.args(&args)
        .env("HELM_CACHE_HOME", home.join("cache"))
        .env("HELM_CONFIG_HOME", home.join("config"))
        .env("HELM_DATA_HOME", home.join("data"))
        .env_remove("KUBECONFIG")
        .kill_on_drop(true);
    let output = tokio::select! {
        out = cmd.output() => out.map_err(|e| anyhow!("helm could not be started -- is it installed on the server? ({e})"))?,
        () = cancel.cancelled() => return Err(anyhow!("the deploy was cancelled")),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        // `template` answers with manifests on stdout only; the rest with both.
        if what == "template" {
            Ok(stdout)
        } else {
            Ok(format!(
                "{stdout}{}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    } else {
        let text = format!("{stdout}{}", String::from_utf8_lossy(&output.stderr));
        Err(anyhow!("helm {what} failed: {}", tail(text.trim(), 2000)))
    }
}

/// The arguments of an uninstall. A release that is not there is not an
/// error: what was asked for is true.
pub fn helm_uninstall_args(p: &DeployPayload, kubeconfig: &Path) -> Vec<String> {
    vec![
        "uninstall".into(),
        p.release.clone(),
        "--namespace".into(),
        p.namespace.clone(),
        "--kubeconfig".into(),
        kubeconfig.display().to_string(),
        "--wait".into(),
        "--timeout".into(),
        HELM_TIMEOUT.into(),
        "--ignore-not-found".into(),
    ]
}

async fn helm_uninstall(
    access: &ClusterAccess,
    p: &DeployPayload,
    cancel: &tokio_util::sync::CancellationToken,
) -> anyhow::Result<String> {
    let scratch = Scratch::new()?;
    let kubeconfig = scratch.write("kubeconfig", access.kubeconfig_yaml().as_bytes())?;
    helm(&scratch, helm_uninstall_args(p, &kubeconfig), cancel).await
}

/// One workload of a release as the cluster reports it.
#[derive(Debug, Clone, Serialize)]
pub struct Workload {
    pub name: String,
    pub ready: i32,
    pub desired: i32,
    pub images: Vec<String>,
}

/// A release's rollout as the cluster reports it now.
#[derive(Debug, Clone, Serialize)]
pub struct Rollout {
    pub workloads: Vec<Workload>,
    /// Hosts the release's ingresses answer on.
    pub hosts: Vec<String>,
}

/// Read a release's workloads and addresses from the cluster.
pub async fn rollout(
    access: &ClusterAccess,
    namespace: &str,
    release: &str,
) -> anyhow::Result<Rollout> {
    let client = access.client().await?;
    let selector = format!("app.kubernetes.io/instance={release}");
    let read = async {
        let deployments: kube::Api<KubeDeployment> =
            kube::Api::namespaced(client.clone(), namespace);
        let mut items = deployments
            .list(&ListParams::default().labels(&selector))
            .await?
            .items;
        // A chart that does not label its workloads with the release: the
        // namespace is the release's own (one per project and environment).
        if items.is_empty() {
            items = deployments.list(&ListParams::default()).await?.items;
        }
        let ingresses: kube::Api<Ingress> = kube::Api::namespaced(client.clone(), namespace);
        let hosts = ingresses
            .list(&ListParams::default())
            .await
            .map(|l| l.items)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|i| i.spec)
            .flat_map(|s| s.rules.unwrap_or_default())
            .filter_map(|r| r.host)
            .collect::<Vec<_>>();
        Ok::<_, kube::Error>((items, hosts))
    };
    let (items, hosts) = tokio::time::timeout(Duration::from_secs(20), read)
        .await
        .map_err(|_| anyhow!("the cluster did not answer in 20 s"))?
        .map_err(|e| anyhow!("the cluster refused to say: {e}"))?;
    let workloads = items
        .into_iter()
        .map(|d| {
            let status = d.status.unwrap_or_default();
            let spec = d.spec.unwrap_or_default();
            Workload {
                name: d.metadata.name.unwrap_or_default(),
                ready: status.ready_replicas.unwrap_or(0),
                desired: spec.replicas.unwrap_or(1),
                images: spec
                    .template
                    .spec
                    .map(|s| s.containers.into_iter().filter_map(|c| c.image).collect())
                    .unwrap_or_default(),
            }
        })
        .collect();
    Ok(Rollout { workloads, hosts })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> DeployPayload {
        DeployPayload {
            deployment_id: Uuid::nil(),
            organization_id: Uuid::nil(),
            project_id: Uuid::nil(),
            connection_id: Uuid::nil(),
            registry_connection_id: None,
            namespace: "studio-web-prod".into(),
            release: "studio-web".into(),
            action: DeploymentAction::Install,
            environment_id: Uuid::nil(),
            secret_keys: Vec::new(),
            database: DatabaseMode::None,
            database_image: None,
            chart: Some(String::new()),
            chart_ref: None,
            values: serde_json::json!({}),
        }
    }

    fn prepared(chart: &str, registry: bool) -> Prepared {
        Prepared {
            chart: chart.into(),
            values: "/s/values.json".into(),
            kubeconfig: "/s/kubeconfig".into(),
            registry_config: registry.then(|| "/s/registry.json".into()),
        }
    }

    #[test]
    fn the_install_names_its_namespace_values_and_kubeconfig_and_waits() {
        let line = helm_args(&payload(), &prepared("/s/chart.tgz", false)).join(" ");
        assert!(line.starts_with("upgrade --install studio-web /s/chart.tgz"));
        assert!(line.contains("--namespace studio-web-prod"));
        assert!(line.contains("--values /s/values.json"));
        assert!(line.contains("--kubeconfig /s/kubeconfig"));
        assert!(line.contains("--wait"));
        // The namespace is prepared by the run, with its labels; helm's
        // --create-namespace would make one without them.
        assert!(!line.contains("--create-namespace"));
        assert!(!line.contains("--version") && !line.contains("--registry-config"));
    }

    #[test]
    fn the_chart_is_rendered_as_it_would_be_installed_without_the_cluster() {
        let mut p = payload();
        p.chart_ref = Some(ChartRef {
            reference: "oci://ghcr.io/acme/charts/shop".into(),
            version: "0.1.0".into(),
        });
        let line =
            helm_template_args(&p, &prepared("oci://ghcr.io/acme/charts/shop", true)).join(" ");
        assert!(line.starts_with("template studio-web oci://ghcr.io/acme/charts/shop"));
        assert!(line.contains("--values /s/values.json") && line.contains("--version 0.1.0"));
        assert!(line.contains("--registry-config /s/registry.json"));
        assert!(!line.contains("--kubeconfig"), "rendering needs no cluster");
    }

    #[test]
    fn an_uninstall_waits_and_is_content_with_nothing_there() {
        let mut p = payload();
        p.action = DeploymentAction::Uninstall;
        let line = helm_uninstall_args(&p, Path::new("/s/kubeconfig")).join(" ");
        assert!(line.starts_with("uninstall studio-web --namespace studio-web-prod"));
        assert!(line.contains("--wait") && line.contains("--ignore-not-found"));
    }

    #[test]
    fn a_published_chart_is_installed_at_its_version_with_the_registry_login() {
        let mut p = payload();
        p.chart = None;
        p.chart_ref = Some(ChartRef {
            reference: "oci://ghcr.io/acme/charts/shop".into(),
            version: "0.1.0".into(),
        });
        let line = helm_args(&p, &prepared("oci://ghcr.io/acme/charts/shop", true)).join(" ");
        assert!(line.starts_with("upgrade --install studio-web oci://ghcr.io/acme/charts/shop"));
        assert!(line.contains("--version 0.1.0"));
        assert!(line.contains("--registry-config /s/registry.json"));
    }

    #[test]
    fn a_payload_queued_before_charts_had_references_still_reads() {
        let old = serde_json::json!({
            "deployment_id": Uuid::nil(), "organization_id": Uuid::nil(),
            "project_id": Uuid::nil(), "connection_id": Uuid::nil(),
            "namespace": "n", "release": "r", "chart": "H4sI", "values": {},
        });
        let p: DeployPayload = serde_json::from_value(old).unwrap();
        assert_eq!(p.chart.as_deref(), Some("H4sI"));
        assert!(p.chart_ref.is_none() && p.registry_connection_id.is_none());
        assert_eq!(p.action, DeploymentAction::Install);
        assert_eq!(p.database, DatabaseMode::None);
    }

    #[test]
    fn the_default_account_gets_the_pull_secret_once_and_keeps_its_others() {
        let mut sa = ServiceAccount::default();
        assert_eq!(
            with_pull_secret(&sa),
            Some(vec![serde_json::json!({ "name": PULL_SECRET })])
        );
        sa.image_pull_secrets = Some(vec![LocalObjectReference {
            name: "theirs".into(),
        }]);
        assert_eq!(
            with_pull_secret(&sa),
            Some(vec![
                serde_json::json!({ "name": "theirs" }),
                serde_json::json!({ "name": PULL_SECRET }),
            ])
        );
        sa.image_pull_secrets
            .as_mut()
            .unwrap()
            .push(LocalObjectReference {
                name: PULL_SECRET.into(),
            });
        assert_eq!(with_pull_secret(&sa), None);
    }

    #[test]
    fn a_scratch_directory_goes_away_with_its_files() {
        let path = {
            let s = Scratch::new().unwrap();
            s.write("kubeconfig", b"secret").unwrap();
            s.path().to_path_buf()
        };
        assert!(!path.exists());
    }

    #[test]
    fn a_long_output_keeps_its_end() {
        let s = format!("{}END", "x".repeat(5000));
        let t = tail(&s, 10);
        assert!(t.ends_with("END"));
        assert!(t.len() < 20);
    }
}
