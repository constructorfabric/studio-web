//! A deploy on the server (ADR-0043 §3): the run that installs a product's
//! chart into an environment, and the status read back afterwards.
//!
//! The run gets everything it needs in its payload -- the chart, the values,
//! the namespace, which connection -- so it reads nothing a person could have
//! changed after the deploy was asked for and approved, except the cluster's
//! credential, which it reads from credstore as the service at the last
//! moment and writes only into a file of its own that it removes afterwards.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use base64::Engine;
use k8s_openapi::api::apps::v1::Deployment as KubeDeployment;
use k8s_openapi::api::authentication::v1::SelfSubjectReview;
use k8s_openapi::api::core::v1::{LocalObjectReference, Namespace, Pod, Secret, ServiceAccount};
use k8s_openapi::api::networking::v1::Ingress;
use k8s_openapi::api::rbac::v1::{RoleBinding, RoleRef, Subject};
use kube::api::{ListParams, LogParams, ObjectMeta, Patch, PatchParams, PostParams};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use toolkit::client_hub::ClientHub;
use tracing::{info, warn};
use uuid::Uuid;

use super::database;
use super::model::{ChartRef, DatabaseMode, DeployImage, DeploymentAction};
use super::preflight;
use crate::connectors::sdk::{ClusterAccess, Connectors, RegistryAccess, same_registry};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

// Installing a product's infra services before its release (ADR-0064 §5).
#[path = "infra_install.rs"]
mod infra_install;

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "environments.deploy";

/// How long `helm upgrade --wait` waits for the release to come up. Under the
/// task lease (15 minutes), so a slow rollout fails as itself rather than as a
/// lost lease.
const HELM_TIMEOUT: &str = "8m";

/// The helm binary: `STUDIO_HELM`, or `helm` on the PATH (the image installs
/// one).
pub(super) fn helm_binary() -> String {
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
    /// `registry_connection_id` is the push login: the environment names no
    /// pull identity (`PULL_USES_PUSH_LOGIN`), which the run says.
    #[serde(default)]
    pub pull_uses_push_login: bool,
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
    /// What the deploy goes on with and says, `CODE: message` each: the run
    /// writes them in its progress and its outcome.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
    /// The tenant the environment's connections are found from and read as
    /// (ADR-0054 §5); absent for an organization's environment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections_from: Option<Uuid>,
    /// Values given to the chart: the images under the environment's registry.
    pub values: serde_json::Value,
    /// The images the release is to run, under the environment's registry:
    /// what the rendered chart must name (`CHART_IGNORES_BUILT_IMAGES`).
    /// Absent from a payload queued before it was carried.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<DeployImage>,
    /// A deploy to a Constructor Research environment (ADR-0049 §4): what it
    /// prepares and where it puts the application. `None` for a cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research: Option<super::research::ResearchDeploy>,
    /// The project's build namespace there, recorded with its namespace once
    /// the run made or found it (ADR-0062 §3); absent from a deploy queued
    /// before it was recorded, and for a preview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_namespace: Option<String>,
    /// A preview (ADR-0055): its namespace is labelled as one, and its host
    /// routed once the release is installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<super::preview::PreviewRoute>,
    /// The product's infra services, as this run brings them (ADR-0064).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub infra: Vec<super::infra::InfraInstall>,
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
        if let Some(research) = &payload.research {
            return match super::research::deploy(&self.hub, ctx, &payload, research).await {
                Ok(at) => TaskOutcome::done_with(at.clone(), serde_json::json!({ "output": at })),
                Err(e) => TaskOutcome::Failed(format!("{e:#}")),
            };
        }
        ctx.progress("reading the cluster's access").await;
        let (reader, from) = match super::build::connection_reader(
            &ctx.security,
            payload.organization_id,
            payload.connections_from,
        ) {
            Ok(r) => r,
            Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        let access = match cluster_access(&self.hub, &reader, from, payload.connection_id).await {
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
            Some(id) => match registry_access(&self.hub, &reader, from, id).await {
                Ok(r) => Some(r),
                Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
            },
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
        if payload.preview.is_none() {
            super::placement::record(
                &self.hub,
                payload.organization_id,
                payload.project_id,
                payload.environment_id,
                payload.connection_id,
                &payload.namespace,
                payload
                    .build_namespace
                    .as_deref()
                    .unwrap_or(&payload.namespace),
            )
            .await;
        }
        if let Some(registry) = &registry {
            if payload.pull_uses_push_login {
                ctx.progress(format!(
                    "{}: {}",
                    super::model::PULL_USES_PUSH_LOGIN,
                    super::model::PULL_USES_PUSH_LOGIN_MESSAGE
                ))
                .await;
            }
            ctx.progress(format!("writing the pull secret for {}", registry.host))
                .await;
            if let Err(e) = write_pull_secret(&client, &payload.namespace, registry).await {
                return TaskOutcome::Failed(format!("{e:#}"));
            }
        }
        // The product's infra services come first (ADR-0064 §5): what they
        // provide is part of the configuration written next.
        if !payload.infra.is_empty()
            && let Err(e) =
                infra_install::bring(&self.hub, ctx, &access, registry.as_ref(), &payload).await
        {
            return TaskOutcome::Failed(format!("{e:#}"));
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
        let mut prepared = match prepare(&scratch, &access, registry.as_ref(), &payload) {
            Ok(p) => p,
            Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        // A build's chart is installed as the build pushed it: pulled by its
        // version, its digest checked, then installed from the pulled file,
        // so a version pushed over since installs nothing.
        if let Some(digest) = payload.chart_ref.as_ref().and_then(|r| r.digest.clone()) {
            ctx.progress(format!("pulling the chart, pinned to {digest}"))
                .await;
            match pull_pinned(&scratch, &payload, &prepared, &digest, &ctx.cancel).await {
                Ok(path) => prepared.chart = path,
                Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
            }
        }
        ctx.progress("reading what the chart needs").await;
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
        // The release runs what was built, or nothing: a chart that reads its
        // images from other values would install its own defaults.
        if let Some(apps) = images_ignored(&rendered, &payload.images) {
            return TaskOutcome::Failed(format!(
                "CHART_IGNORES_BUILT_IMAGES: the rendered chart names none of the images built \
                 for {}: set where the chart reads each image (the build's values paths) or \
                 the chart's values",
                apps.join(", ")
            ));
        }
        let mut notes = Vec::new();
        for w in &payload.warnings {
            ctx.progress(format!("warning: {w}")).await;
            notes.push(w.clone());
        }
        if let Some(why) = secret_unread(&rendered, &payload) {
            ctx.progress(format!("warning: {why}")).await;
            notes.push(why);
        }
        let needs = match database::needs_reported(&rendered) {
            Ok((n, skipped)) => {
                for s in skipped {
                    ctx.progress(format!(
                        "manifest document {} does not parse and was skipped: {}",
                        s.index, s.error
                    ))
                    .await;
                }
                n
            }
            // Without a database of Studio's to prepare, a configuration it
            // cannot read is the product's business, not a reason to refuse
            // -- but said, not taken for "needs no database".
            Err(e) if payload.database == DatabaseMode::Shared => {
                warn!(error = %format!("{e:#}"), "studio-environments: the chart's database configuration could not be read");
                ctx.progress(format!(
                    "the chart's database configuration could not be read ({e:#}); \
                     the environment's shared database is used as the chart configures it"
                ))
                .await;
                Vec::new()
            }
            Err(e) => {
                return TaskOutcome::Failed(format!("the chart's database configuration: {e:#}"));
            }
        };
        // The product's database comes with it (`DatabaseMode`): whatever
        // its gears keep, in its namespace, before the release that reads it.
        if payload.database != DatabaseMode::Shared {
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
                match database::ensure(&client, &payload.namespace, need, &image).await {
                    Ok(database::Ensured::Studios) => {}
                    Ok(database::Ensured::LeftAlone) => {
                        ctx.progress(format!(
                            "{} in {} is not Studio's: the product's own, left as it is",
                            need.host, payload.namespace
                        ))
                        .await;
                    }
                    Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
                }
            }
        }
        // The product signs in through an IdP of its own (ADR-0062 §9).
        if let Some((code, why)) =
            preflight::platform_idp_refusal(&rendered, preflight::studio_issuer().as_deref())
        {
            return TaskOutcome::Failed(format!("{code}: {why}"));
        }
        ctx.progress("checking the namespace has every secret the chart reads")
            .await;
        match secrets_in(&client, &payload.namespace).await {
            Ok(present) => {
                let reads = preflight::secrets_read(&rendered);
                if let Some(why) = preflight::missing_secrets(
                    &reads,
                    &present,
                    &needs,
                    payload.database,
                    &payload.namespace,
                ) {
                    return TaskOutcome::Failed(why);
                }
            }
            // Not being allowed to list secrets is no reason to refuse: the
            // watch below still sees a pod that cannot start.
            Err(e) => {
                warn!(error = %e, "studio-environments: the namespace's secrets could not be listed")
            }
        }
        if let Err(e) = unstick_release(&scratch, &payload, &prepared, &ctx.cancel).await {
            return TaskOutcome::Failed(format!("{e:#}"));
        }
        ctx.progress(format!(
            "helm upgrade --install {} into {}",
            payload.release, payload.namespace
        ))
        .await;
        let stuck = tokio::select! {
            out = helm(&scratch, helm_args(&payload, &prepared), &ctx.cancel) => Ok(out),
            why = watch_start(client.clone(), &payload.namespace) => Err(why),
        };
        let out = match stuck {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return TaskOutcome::Failed(format!("{e:#}")),
            Err(why) => {
                // helm was stopped by being dropped and left the release
                // pending, which would refuse the next install: put it back.
                if let Err(e) = unstick_release(&scratch, &payload, &prepared, &ctx.cancel).await {
                    warn!(error = %e, "studio-environments: a stopped release could not be put back");
                }
                return TaskOutcome::Failed(format!(
                    "the release could not start, so the deploy stopped waiting: {why}"
                ));
            }
        };
        info!(
            deployment = %payload.deployment_id,
            namespace = %payload.namespace,
            "studio-environments: release installed"
        );
        let mut summary = format!("{} installed into {}", payload.release, payload.namespace);
        for note in notes {
            summary = format!("{summary}; warning: {note}");
        }
        if let Some(route) = &payload.preview {
            ctx.progress("routing the preview's address").await;
            match super::preview::apply_route(&client, &payload.namespace, &payload.release, route)
                .await
            {
                Ok(Some(said)) => summary = format!("{summary}; {said}"),
                Ok(None) => {}
                Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
            }
        }
        TaskOutcome::done_with(
            summary.clone(),
            serde_json::json!({ "output": format!("{}\n{summary}", tail(&out, 4000)) }),
        )
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
/// connection that may not even read the namespace is refused with the
/// reason: it used to be trusted to have been given it, and then failed
/// later with a bare 403 (see `readiness`, which asks before anything is
/// queued).
pub(super) async fn prepare_namespace(
    client: &kube::Client,
    namespace: &str,
    project: Uuid,
) -> anyhow::Result<()> {
    make_namespace(client, namespace, project, None).await
}

/// [`prepare_namespace`], for a preview when `expires_at` is given: the
/// namespace is labelled as one and says when it expires (ADR-0055).
async fn make_namespace(
    client: &kube::Client,
    namespace: &str,
    project: Uuid,
    expires_at: Option<&str>,
) -> anyhow::Result<()> {
    let namespaces: kube::Api<Namespace> = kube::Api::all(client.clone());
    match namespaces.get_opt(namespace).await {
        // A namespace another project's label claims is never this one's
        // (ADR-0062 §3); one without the label was assigned by hand, which
        // the check before the run asked.
        Ok(Some(found)) => {
            let label = found
                .metadata
                .labels
                .as_ref()
                .and_then(|l| l.get(super::placement::PROJECT_LABEL))
                .cloned();
            match super::placement::owner_refusal(namespace, label.as_deref(), project, true) {
                Some((_, why)) => Err(anyhow!(why)),
                None => Ok(()),
            }
        }
        Ok(None) => {
            let mut labels: std::collections::BTreeMap<String, String> = [
                (
                    "app.kubernetes.io/managed-by".to_owned(),
                    "constructor-studio".to_owned(),
                ),
                (
                    "studio.constructor.tech/project".to_owned(),
                    project.to_string(),
                ),
            ]
            .into();
            let mut annotations = std::collections::BTreeMap::new();
            if let Some(at) = expires_at {
                labels.insert(super::preview::PREVIEW_LABEL.to_owned(), "true".to_owned());
                annotations.insert(super::preview::EXPIRES_ANNOTATION.to_owned(), at.to_owned());
            }
            let ns = Namespace {
                metadata: ObjectMeta {
                    name: Some(namespace.to_owned()),
                    labels: Some(labels),
                    annotations: (!annotations.is_empty()).then_some(annotations),
                    ..ObjectMeta::default()
                },
                ..Namespace::default()
            };
            namespaces
                .create(&PostParams::default(), &ns)
                .await
                .map_err(|e| {
                    anyhow!(
                        "namespace {} does not exist and the cluster connection may not \
                         create it: create it, or let the connection's service account \
                         create namespaces ({e})",
                        namespace
                    )
                })?;
            grant_self_admin(client, namespace).await
        }
        Err(kube::Error::Api(status)) if status.code == 403 => Err(anyhow!(
            "the cluster connection may not read namespace {namespace}, so whether it exists \
             cannot be told: a cluster administrator applies {}, or gives the connection's \
             account admin in {namespace} ({})",
            crate::connectors::sdk::BOOTSTRAP_FILE,
            status.message
        )),
        Err(e) => Err(anyhow!("the cluster did not answer: {e}")),
    }
}

/// The RoleBinding that gives the connection `admin` in a namespace it made.
pub const SELF_ADMIN_BINDING: &str = "constructor-studio";

/// Give the connection's own account `admin` in the namespace it just made.
/// Creating a namespace gives its creator nothing inside it, so a connection
/// that may create namespaces (and bind `admin`: the cluster's bootstrap
/// manifest, `deploy/k8s/studio-environments/`) would otherwise make one it
/// cannot deploy into. Every project of the organization gets its namespace
/// this way, without anybody preparing it.
async fn grant_self_admin(client: &kube::Client, namespace: &str) -> anyhow::Result<()> {
    let review = kube::Api::<SelfSubjectReview>::all(client.clone())
        .create(&PostParams::default(), &SelfSubjectReview::default())
        .await
        .map_err(|e| anyhow!("the cluster did not say who the connection is: {e}"))?;
    let username = review
        .status
        .and_then(|s| s.user_info)
        .and_then(|u| u.username)
        .ok_or_else(|| anyhow!("the cluster did not say who the connection is"))?;
    let binding = RoleBinding {
        metadata: ObjectMeta {
            name: Some(SELF_ADMIN_BINDING.to_owned()),
            labels: Some(
                [(
                    "app.kubernetes.io/managed-by".to_owned(),
                    FIELD_MANAGER.to_owned(),
                )]
                .into(),
            ),
            ..ObjectMeta::default()
        },
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".to_owned(),
            kind: "ClusterRole".to_owned(),
            name: "admin".to_owned(),
        },
        subjects: Some(vec![subject_for(&username)]),
    };
    kube::Api::<RoleBinding>::namespaced(client.clone(), namespace)
        .patch(
            SELF_ADMIN_BINDING,
            &PatchParams::apply(FIELD_MANAGER).force(),
            &Patch::Apply(&binding),
        )
        .await
        .map(|_| ())
        .map_err(|e| {
            anyhow!(
                "namespace {namespace} was created, but the cluster connection may not give \
                 itself admin there: apply the cluster's bootstrap manifest, which lets it \
                 bind admin in the namespaces it makes ({e})"
            )
        })
}

/// The RBAC subject a username names: a service account's
/// `system:serviceaccount:<namespace>:<name>`, else a user.
fn subject_for(username: &str) -> Subject {
    match username
        .strip_prefix("system:serviceaccount:")
        .and_then(|rest| rest.split_once(':'))
    {
        Some((namespace, name)) => Subject {
            kind: "ServiceAccount".to_owned(),
            name: name.to_owned(),
            namespace: Some(namespace.to_owned()),
            api_group: None,
        },
        None => Subject {
            kind: "User".to_owned(),
            name: username.to_owned(),
            namespace: None,
            api_group: Some("rbac.authorization.k8s.io".to_owned()),
        },
    }
}

async fn ensure_namespace(client: &kube::Client, p: &DeployPayload) -> anyhow::Result<()> {
    match &p.preview {
        None => prepare_namespace(client, &p.namespace, p.project_id).await,
        Some(route) => {
            make_namespace(client, &p.namespace, p.project_id, Some(&route.expires_at)).await
        }
    }
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
    // A chart pulled by its digest is a file by now; only a reference has a
    // version to name.
    if let Some(r) = &p.chart_ref
        && c.chart.starts_with("oci://")
    {
        args.push("--version".into());
        args.push(r.version.clone());
    }
    if let Some(config) = &c.registry_config {
        args.push("--registry-config".into());
        args.push(config.display().to_string());
    }
}

/// The arguments that pull a published chart into `dest`, by its version.
pub fn helm_pull_args(p: &DeployPayload, c: &Prepared, dest: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec!["pull".into(), c.chart.clone()];
    if let Some(r) = &p.chart_ref {
        args.push("--version".into());
        args.push(r.version.clone());
    }
    args.push("--destination".into());
    args.push(dest.display().to_string());
    if let Some(config) = &c.registry_config {
        args.push("--registry-config".into());
        args.push(config.display().to_string());
    }
    args
}

/// Whether what `helm pull` said it pulled is the digest the build recorded.
pub fn check_pulled_digest(output: &str, expected: &str) -> anyhow::Result<()> {
    match super::build::pushed_digest(output) {
        Some(d) if d == expected => Ok(()),
        Some(d) => Err(anyhow!(
            "CHART_DIGEST_MISMATCH: the registry holds {d} under the chart's version, not the \
             {expected} the build pushed -- the version was pushed over since"
        )),
        None => Err(anyhow!(
            "helm pull said no digest for the chart, so it cannot be checked against the \
             build's {expected}"
        )),
    }
}

/// The chart pulled, its digest checked, and the pulled file's path.
async fn pull_pinned(
    scratch: &Scratch,
    p: &DeployPayload,
    c: &Prepared,
    digest: &str,
    cancel: &tokio_util::sync::CancellationToken,
) -> anyhow::Result<String> {
    let dest = scratch.path().join("pulled");
    std::fs::create_dir_all(&dest).context("cannot create the chart's folder")?;
    let out = helm(scratch, helm_pull_args(p, c, &dest), cancel).await?;
    check_pulled_digest(&out, digest)?;
    let mut tgz = std::fs::read_dir(&dest)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "tgz"));
    let path = tgz
        .next()
        .ok_or_else(|| anyhow!("helm pull left no chart"))?;
    Ok(path.display().to_string())
}

/// The applications whose built images the rendered chart names nowhere,
/// when it names none of them: each image is looked for by its digest and
/// by `repository:tag`. `None` when one appears, or there is nothing to
/// look for.
pub fn images_ignored(rendered: &str, images: &[DeployImage]) -> Option<Vec<String>> {
    let mut apps = Vec::new();
    for i in images {
        let (name, digest) = match i.image.split_once('@') {
            Some((name, digest)) => (name, Some(digest)),
            None => (i.image.as_str(), None),
        };
        let (repository, tag) = super::model::split_image(name);
        let marks: Vec<String> = digest
            .map(str::to_owned)
            .into_iter()
            .chain(tag.map(|t| format!("{repository}:{t}")))
            .collect();
        if marks.is_empty() {
            continue;
        }
        if marks.iter().any(|m| rendered.contains(m.as_str())) {
            return None;
        }
        apps.push(i.app.clone());
    }
    (!apps.is_empty()).then_some(apps)
}

/// Why the release's configuration secret reaches no application: it has
/// keys, and the rendered chart never names it.
pub fn secret_unread(rendered: &str, p: &DeployPayload) -> Option<String> {
    let name = super::model::config_secret_name(&p.release);
    (!p.secret_keys.is_empty() && !rendered.contains(&name)).then(|| {
        format!(
            "the chart reads no configuration secret {name}, so {} reach(es) no application: \
             set where the chart reads it (the build's values paths)",
            p.secret_keys.join(", ")
        )
    })
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

/// The arguments that read a release's state, as JSON.
pub fn helm_status_args(p: &DeployPayload, kubeconfig: &Path) -> Vec<String> {
    vec![
        "status".into(),
        p.release.clone(),
        "--namespace".into(),
        p.namespace.clone(),
        "--kubeconfig".into(),
        kubeconfig.display().to_string(),
        "--output".into(),
        "json".into(),
    ]
}

/// The arguments that take a release back to its last good revision.
pub fn helm_rollback_args(p: &DeployPayload, kubeconfig: &Path) -> Vec<String> {
    vec![
        "rollback".into(),
        p.release.clone(),
        "--namespace".into(),
        p.namespace.clone(),
        "--kubeconfig".into(),
        kubeconfig.display().to_string(),
        "--wait".into(),
        "--timeout".into(),
        HELM_TIMEOUT.into(),
    ]
}

/// Put back a release an earlier run left `pending-*` (see
/// [`preflight::unstick`]); a release that is not there, or cannot be read,
/// is left to the install, which says what is wrong with it.
async fn unstick_release(
    scratch: &Scratch,
    p: &DeployPayload,
    c: &Prepared,
    cancel: &tokio_util::sync::CancellationToken,
) -> anyhow::Result<()> {
    let Ok(status) = helm(scratch, helm_status_args(p, &c.kubeconfig), cancel).await else {
        return Ok(());
    };
    let args = match preflight::unstick(&status) {
        preflight::Unstick::None => return Ok(()),
        preflight::Unstick::Uninstall => helm_uninstall_args(p, &c.kubeconfig),
        preflight::Unstick::Rollback => helm_rollback_args(p, &c.kubeconfig),
    };
    warn!(release = %p.release, namespace = %p.namespace, "studio-environments: putting back a release an earlier run left pending");
    helm(scratch, args, cancel)
        .await
        .map(|_| ())
        .context("the release an earlier deploy left pending could not be put back")
}

/// The names of the namespace's secrets.
async fn secrets_in(client: &kube::Client, namespace: &str) -> anyhow::Result<BTreeSet<String>> {
    let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), namespace);
    let list = tokio::time::timeout(
        Duration::from_secs(20),
        secrets.list_metadata(&ListParams::default()),
    )
    .await
    .map_err(|_| anyhow!("the cluster did not answer in 20 s"))??;
    Ok(list
        .items
        .into_iter()
        .filter_map(|s| s.metadata.name)
        .collect())
}

/// How often the install's pods are looked at.
const WATCH_EVERY: Duration = Duration::from_secs(10);

/// Look at the namespace's pods while helm waits, and answer why once a
/// container cannot start (see [`preflight::StartWatch`]); never otherwise.
async fn watch_start(client: kube::Client, namespace: &str) -> String {
    let pods: kube::Api<Pod> = kube::Api::namespaced(client, namespace);
    let mut watch = preflight::StartWatch::default();
    loop {
        tokio::time::sleep(WATCH_EVERY).await;
        // A look the cluster did not answer is skipped, not counted.
        let Ok(Ok(list)) =
            tokio::time::timeout(Duration::from_secs(20), pods.list(&ListParams::default())).await
        else {
            continue;
        };
        let now: Vec<_> = list.items.iter().flat_map(preflight::waiting).collect();
        if let Some(why) = watch.look(&now) {
            // The release is taken back after this, and its pods with it: what
            // a crashing container said is kept in the reason, or it is lost.
            let mut said = Vec::new();
            for w in now.iter().filter(|w| w.restarts > 0) {
                let params = LogParams {
                    container: Some(w.container.clone()),
                    previous: true,
                    tail_lines: Some(CRASH_LOG_LINES),
                    limit_bytes: Some(CRASH_LOG_BYTES),
                    ..LogParams::default()
                };
                if let Ok(Ok(text)) =
                    tokio::time::timeout(Duration::from_secs(10), pods.logs(&w.pod, &params)).await
                    && let Some(last) = last_words(&text)
                {
                    said.push(format!("{} stopped: {last}", w.container));
                }
            }
            if said.is_empty() {
                return why;
            }
            // A run's reason is cut to 500 characters: what the container
            // said goes first, the cluster's account of it after.
            return format!("{}; {why}", said.join("; "));
        }
    }
}

/// How much of a crashing container's last run is read for its reason.
const CRASH_LOG_LINES: i64 = 60;
const CRASH_LOG_BYTES: i64 = 16 * 1024;

/// What a container that stopped said last that matters: its last lines
/// that name an error, or its last lines when none does -- without their
/// timestamps and colours, so the reason's few hundred characters go to the
/// error itself.
pub fn last_words(log: &str) -> Option<String> {
    let lines: Vec<String> = log
        .lines()
        .map(plain_log_line)
        .filter(|l| !l.is_empty())
        .collect();
    // A server that returns its error from `main` prints `Error: ...` and the
    // chain of causes under it: that is the whole story, in order.
    if let Some(at) = lines.iter().rposition(|l| l.starts_with("Error: ")) {
        let chain: Vec<&str> = lines[at..]
            .iter()
            .map(String::as_str)
            .filter(|l| *l != "Caused by:")
            .collect();
        return Some(chain.join(" / ").chars().take(400).collect());
    }
    let errors: Vec<&String> = lines
        .iter()
        .filter(|l| {
            let l = l.to_ascii_lowercase();
            ["error", "panic", "fatal", "failed"]
                .iter()
                .any(|w| l.contains(w))
        })
        .collect();
    let pick: Vec<&String> = if errors.is_empty() {
        lines.iter().rev().take(2).rev().collect()
    } else {
        errors.iter().rev().take(3).rev().copied().collect()
    };
    if pick.is_empty() {
        return None;
    }
    Some(
        pick.iter()
            .map(|l| l.chars().take(240).collect::<String>())
            .collect::<Vec<_>>()
            .join(" / "),
    )
}

/// A log line without its colour codes and the timestamp a server puts
/// first.
fn plain_log_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // An escape sequence: `ESC [` up to its final letter.
            if chars.peek() == Some(&'[') {
                chars.next();
                for f in chars.by_ref() {
                    if f.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c.is_control() || c == '\u{fffd}' {
            continue;
        }
        out.push(c);
    }
    let out = out.trim();
    match out.split_once(' ') {
        Some((first, rest))
            if first.len() >= 20
                && first.as_bytes().get(4) == Some(&b'-')
                && first.contains('T') =>
        {
            rest.trim().to_string()
        }
        _ => out.to_string(),
    }
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
    /// The containers that cannot start, and why: one line each.
    pub problems: Vec<String>,
}

/// The end of one container's log, as the release's pod has it.
#[derive(Debug, Clone, Serialize)]
pub struct ContainerLog {
    pub pod: String,
    pub container: String,
    /// The log of the run before the last restart: what a crashing
    /// container said before it died, which its new run has not.
    pub previous: bool,
    pub text: String,
}

/// How many lines of each log a reader gets when it does not say.
pub const LOG_LINES: i64 = 200;
pub const LOG_LINES_MAX: i64 = 2000;
const LOG_BYTES: i64 = 128 * 1024;
/// A release with more pods than this is read for its first ones only.
const LOG_PODS: usize = 12;

/// The lines to ask for: what was asked, within reason.
pub fn log_lines(asked: Option<i64>) -> i64 {
    asked.unwrap_or(LOG_LINES).clamp(1, LOG_LINES_MAX)
}

/// Which logs of a container to read: the current run's, and the one
/// before when it has restarted and is not running now -- a crash loop's
/// current run is often too young to have said anything.
pub fn logs_to_read(pod: &Pod) -> Vec<(String, bool)> {
    let Some(status) = &pod.status else {
        return Vec::new();
    };
    status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten())
        .flat_map(|c| {
            let running = c.state.as_ref().is_some_and(|s| s.running.is_some());
            let mut out = vec![(c.name.clone(), false)];
            if c.restart_count > 0 && !running {
                out.push((c.name.clone(), true));
            }
            out
        })
        .collect()
}

/// The end of every container's log of a release, read now.
pub async fn logs(
    access: &ClusterAccess,
    namespace: &str,
    release: &str,
    lines: i64,
) -> anyhow::Result<Vec<ContainerLog>> {
    let client = access.client().await?;
    let pods: kube::Api<Pod> = kube::Api::namespaced(client, namespace);
    let selector = format!("app.kubernetes.io/instance={release}");
    let list = async {
        let mut items = pods
            .list(&ListParams::default().labels(&selector))
            .await?
            .items;
        // As for the rollout: a chart that does not label its pods.
        if items.is_empty() {
            items = pods.list(&ListParams::default()).await?.items;
        }
        Ok::<_, kube::Error>(items)
    };
    let items = tokio::time::timeout(Duration::from_secs(20), list)
        .await
        .map_err(|_| anyhow!("the cluster did not answer in 20 s"))?
        .map_err(|e| anyhow!("the cluster refused to say: {e}"))?;
    let mut out = Vec::new();
    for pod in items.iter().take(LOG_PODS) {
        let name = pod.metadata.name.clone().unwrap_or_default();
        for (container, previous) in logs_to_read(pod) {
            let params = LogParams {
                container: Some(container.clone()),
                tail_lines: Some(lines),
                limit_bytes: Some(LOG_BYTES),
                previous,
                ..LogParams::default()
            };
            // A container that never started has no log; the cluster's
            // answer says why ("waiting to start: CreateContainerConfigError").
            let text = match tokio::time::timeout(
                Duration::from_secs(20),
                pods.logs(&name, &params),
            )
            .await
            {
                Ok(Ok(text)) => text,
                Ok(Err(e)) => format!("(no log: {e})"),
                Err(_) => "(no log: the cluster did not answer in 20 s)".to_owned(),
            };
            out.push(ContainerLog {
                pod: name.clone(),
                container,
                previous,
                text,
            });
        }
    }
    Ok(out)
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
        // The pods say what the workloads' counts do not: why one is not ready.
        let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), namespace);
        let problems = pods
            .list(&ListParams::default())
            .await
            .map(|l| preflight::problems(&l.items))
            .unwrap_or_default();
        Ok::<_, kube::Error>((items, hosts, problems))
    };
    let (items, hosts, problems) = tokio::time::timeout(Duration::from_secs(20), read)
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
    Ok(Rollout {
        workloads,
        hosts,
        problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_account_binds_as_itself_and_anybody_else_as_a_user() {
        let sa = subject_for("system:serviceaccount:studio-environments:deployer");
        assert_eq!(sa.kind, "ServiceAccount");
        assert_eq!(sa.name, "deployer");
        assert_eq!(sa.namespace.as_deref(), Some("studio-environments"));
        assert_eq!(sa.api_group, None);

        let user = subject_for("kubernetes-admin");
        assert_eq!(user.kind, "User");
        assert_eq!(user.name, "kubernetes-admin");
        assert_eq!(user.api_group.as_deref(), Some("rbac.authorization.k8s.io"));
    }

    pub(super) fn payload() -> DeployPayload {
        DeployPayload {
            deployment_id: Uuid::nil(),
            organization_id: Uuid::nil(),
            project_id: Uuid::nil(),
            connection_id: Uuid::nil(),
            registry_connection_id: None,
            pull_uses_push_login: false,
            namespace: "studio-web-prod".into(),
            release: "studio-web".into(),
            action: DeploymentAction::Install,
            environment_id: Uuid::nil(),
            secret_keys: Vec::new(),
            database: DatabaseMode::None,
            database_image: None,
            chart: Some(String::new()),
            chart_ref: None,
            connections_from: None,
            values: serde_json::json!({}),
            research: None,
            build_namespace: None,
            preview: None,
            warnings: Vec::new(),
            infra: Vec::new(),
            images: Vec::new(),
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

    const DIGEST: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

    #[test]
    fn a_builds_chart_is_pulled_by_its_version_checked_and_installed_from_the_file() {
        let mut p = payload();
        p.chart = None;
        p.chart_ref = Some(ChartRef {
            reference: "oci://ghcr.io/acme/charts/shop".into(),
            version: "0.1.0-sha.abc.r4".into(),
            digest: Some(DIGEST.into()),
        });
        let c = prepared("oci://ghcr.io/acme/charts/shop", true);
        let pull = helm_pull_args(&p, &c, Path::new("/s/pulled")).join(" ");
        assert!(pull.starts_with("pull oci://ghcr.io/acme/charts/shop --version 0.1.0-sha.abc.r4"));
        assert!(pull.contains("--destination /s/pulled"));
        assert!(pull.contains("--registry-config /s/registry.json"));
        let said = format!("Pulled: ghcr.io/acme/charts/shop:0.1.0-sha.abc.r4\nDigest: {DIGEST}\n");
        assert!(check_pulled_digest(&said, DIGEST).is_ok());
        let other = said.replace("sha256:1111", "sha256:2222");
        let why = check_pulled_digest(&other, DIGEST).unwrap_err().to_string();
        assert!(why.starts_with("CHART_DIGEST_MISMATCH"), "{why}");
        assert!(check_pulled_digest("Pulled: x\n", DIGEST).is_err());
        // Pulled, it installs from the file: no version to name.
        let line = helm_args(&p, &prepared("/s/pulled/shop-0.1.0.tgz", true)).join(" ");
        assert!(line.starts_with("upgrade --install studio-web /s/pulled/shop-0.1.0.tgz"));
        assert!(!line.contains("--version"));
    }

    #[test]
    fn a_chart_that_names_none_of_the_built_images_is_refused() {
        let images = [
            DeployImage {
                app: "api".into(),
                image: format!("ghcr.io/acme/shop/api:sha-abc@{DIGEST}"),
            },
            DeployImage {
                app: "web".into(),
                image: "ghcr.io/acme/shop/web:sha-abc".into(),
            },
        ];
        let defaults = "image: \"nginx:1.27\"\n---\nimage: \"ghcr.io/acme/shop/api:latest\"\n";
        assert_eq!(
            images_ignored(defaults, &images),
            Some(vec!["api".to_owned(), "web".to_owned()])
        );
        let by_digest = format!("image: \"ghcr.io/acme/shop/api:sha-abc@{DIGEST}\"\n");
        assert_eq!(images_ignored(&by_digest, &images), None);
        let by_tag = "image: ghcr.io/acme/shop/web:sha-abc\n";
        assert_eq!(images_ignored(by_tag, &images), None);
        // Nothing built, nothing to look for.
        assert_eq!(images_ignored(defaults, &[]), None);
    }

    #[test]
    fn a_configuration_secret_the_chart_never_names_is_said() {
        let mut p = payload();
        assert_eq!(secret_unread("kind: Deployment\n", &p), None, "no keys");
        p.secret_keys = vec!["SMTP_PASSWORD".into()];
        let why = secret_unread("kind: Deployment\n", &p).unwrap();
        assert!(why.contains("studio-web-config") && why.contains("SMTP_PASSWORD"));
        assert_eq!(
            secret_unread("secretRef:\n  name: studio-web-config\n", &p),
            None
        );
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
            digest: None,
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
    fn a_log_is_read_for_a_reasonable_number_of_lines() {
        assert_eq!(log_lines(None), LOG_LINES);
        assert_eq!(log_lines(Some(50)), 50);
        assert_eq!(log_lines(Some(0)), 1);
        assert_eq!(log_lines(Some(1_000_000)), LOG_LINES_MAX);
    }

    #[test]
    fn a_stopped_container_is_remembered_by_its_errors() {
        let log = "2026-11-05T07:13:06.882117449Z \u{1b}[32m INFO\u{1b}[0m toolkit: Initializing a gear... gear=\"a\"\n\
                   2026-11-05T07:13:06.990000000Z \u{1b}[31mERROR\u{1b}[0m toolkit: gear init failed: oidc discovery: connection refused\n\
                   2026-11-05T07:13:07.000000000Z  INFO toolkit: shutting down\n";
        assert_eq!(
            last_words(log).as_deref(),
            Some("ERROR toolkit: gear init failed: oidc discovery: connection refused")
        );
        // Nothing names an error: the last lines are what is left.
        assert_eq!(
            last_words("one\ntwo\nthree\n").as_deref(),
            Some("two / three")
        );
        assert_eq!(last_words("\n \n"), None);
        // An error returned from `main` is told with its causes.
        let log = "2026-11-05T07:16:48.383Z ERROR hw: Failed to get hardware machine ID\n\
                   Error: initialization failed for gear 'm'\n\
                   \n\
                   Caused by:\n    invalid config for gear 'm': missing field `model_catalog`\n";
        assert_eq!(
            last_words(log).as_deref(),
            Some(
                "Error: initialization failed for gear 'm' / invalid config for gear 'm': missing field `model_catalog`"
            )
        );
    }

    #[test]
    fn a_crashing_container_is_read_with_the_run_before_it() {
        let pod: Pod = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "shop-api-1" },
            "status": {
                "initContainerStatuses": [{ "name": "migrate", "image": "x", "imageID": "", "ready": true,
                    "restartCount": 0, "state": { "terminated": { "exitCode": 0 } } }],
                "containerStatuses": [
                    { "name": "api", "image": "x", "imageID": "", "ready": false, "restartCount": 4,
                      "state": { "waiting": { "reason": "CrashLoopBackOff" } } },
                    { "name": "sidecar", "image": "x", "imageID": "", "ready": true, "restartCount": 2,
                      "state": { "running": {} } }
                ]
            }
        }))
        .unwrap();
        assert_eq!(
            logs_to_read(&pod),
            [
                ("migrate".to_owned(), false),
                ("api".to_owned(), false),
                ("api".to_owned(), true),
                ("sidecar".to_owned(), false),
            ]
        );
        let empty: Pod =
            serde_json::from_value(serde_json::json!({ "metadata": { "name": "p" } })).unwrap();
        assert!(logs_to_read(&empty).is_empty());
    }

    #[test]
    fn a_pending_release_is_read_as_json_and_rolled_back_with_a_wait() {
        let p = payload();
        let status = helm_status_args(&p, Path::new("/s/kubeconfig")).join(" ");
        assert_eq!(
            status,
            "status studio-web --namespace studio-web-prod --kubeconfig /s/kubeconfig --output json"
        );
        let back = helm_rollback_args(&p, Path::new("/s/kubeconfig")).join(" ");
        assert!(back.starts_with("rollback studio-web --namespace studio-web-prod"));
        assert!(back.contains("--wait --timeout 8m"));
    }

    #[test]
    fn a_published_chart_is_installed_at_its_version_with_the_registry_login() {
        let mut p = payload();
        p.chart = None;
        p.chart_ref = Some(ChartRef {
            reference: "oci://ghcr.io/acme/charts/shop".into(),
            version: "0.1.0".into(),
            digest: None,
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
