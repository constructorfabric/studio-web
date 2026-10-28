//! What the routes do: who may, against what, and in which order.

use std::sync::Arc;

use base64::Engine;
use sha2::{Digest, Sha256};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::build;
use super::deploy::{self, DeployPayload, Rollout};
use super::model::{
    self, Binding, BindingList, ConfigSecret, DeployImage, Deployment, DeploymentAction,
    DeploymentList, DeploymentState, Environment, EnvironmentInput, EnvironmentList, Invalid,
};
use super::store::{Store, service_context};
use super::workflow;
use super::{BINDINGS_METADATA_TYPE, DEPLOYMENTS_METADATA_TYPE, ENVIRONMENTS_METADATA_TYPE};
use crate::connectors::sdk as connectors;

/// The privilege that manages an organization's environments and decides
/// about deploys to its protected ones (ADR-0043 §1, §3).
pub const MANAGE_PRIVILEGE: &str = "environment.manage";

/// Why a request was not done. Each maps onto one HTTP answer.
#[derive(Debug)]
pub enum Refusal {
    /// 403: the caller may not; the reason code the problem carries.
    Forbidden(&'static str),
    /// 404: not there, or not for this caller: the id asked for, and why.
    NotFound(String, String),
    /// 400: the request as written cannot be done.
    Invalid(String),
    /// 400 failed_precondition: not now, in this state.
    Precondition(&'static str, String),
    /// 503: a gear this needs is missing.
    Unavailable(String),
    /// 500.
    Internal(String),
}

impl From<anyhow::Error> for Refusal {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(format!("{e:#}"))
    }
}

impl From<Invalid> for Refusal {
    fn from(e: Invalid) -> Self {
        Self::Invalid(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Refusal>;

/// A person as a record names them.
#[derive(Debug, Clone)]
pub struct Person {
    pub id: String,
    pub name: Option<String>,
}

/// What a project sees: the environments it may deploy to, each with the
/// namespace it would get there, and its bindings.
#[derive(Debug, Clone)]
pub struct Targets {
    pub organization_id: Uuid,
    pub project_name: String,
    pub environments: Vec<(Environment, String)>,
    pub bindings: Vec<Binding>,
    pub secrets: Vec<ConfigSecret>,
}

/// A deploy as asked for.
#[derive(Debug, Clone)]
pub struct DeployRequest {
    pub environment_id: Uuid,
    pub profile: String,
    pub product: String,
    pub commit: Option<String>,
    pub lock_hash: Option<String>,
    /// The build it came from, when the IDE deploys one it built.
    pub build: Option<String>,
    pub images: Vec<DeployImage>,
    /// The chart, a `.tgz`, base64; or
    pub chart: Option<String>,
    /// the chart published to the environment's registry (ADR-0048 §3), and
    /// its version.
    pub chart_ref: Option<String>,
    pub chart_version: Option<String>,
    /// Install (the default) or uninstall the release.
    pub action: DeploymentAction,
    /// Install again what an earlier deployment of the project installed: a
    /// rollback, or a promotion to the next environment. Takes the place of
    /// the chart, the images and the build.
    pub redeploy_of: Option<Uuid>,
}

/// A build Studio was asked to run.
#[derive(Debug, Clone)]
pub struct BuildStarted {
    pub build_id: String,
    pub run_id: Uuid,
    pub namespace: String,
}

/// The build workflow as proposed.
#[derive(Debug, Clone)]
pub struct WorkflowProposal {
    pub path: String,
    pub branch: String,
    pub pr_url: Option<String>,
}

/// A token a member pushes a build's images and chart with.
#[derive(Debug, Clone)]
pub struct PushToken {
    /// `ghcr.io`: the host the token is for.
    pub registry: String,
    /// `ghcr.io/acme`: where under it the images go.
    pub prefix: String,
    pub token: String,
    /// Seconds, when the registry says.
    pub expires_in: Option<u64>,
}

/// A project's configuration for one release (ADR-0048 §7).
#[derive(Debug, Clone, Default)]
struct Config {
    values: Option<serde_json::Value>,
    secret_keys: Vec<String>,
}

pub struct EnvironmentService {
    store: Store,
    hub: Arc<ClientHub>,
    /// For the registries' token services.
    http: reqwest::Client,
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// A commit or a lock hash: hex, 7 to 64.
fn check_hash(field: &'static str, v: Option<String>) -> Result<Option<String>> {
    let Some(v) = v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if (7..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(Some(v))
    } else {
        Err(Refusal::Invalid(format!("{field} '{v}' is not a hex hash")))
    }
}

/// A build id as the IDE makes one: 8 to 64 letters, digits and hyphens.
fn check_build(v: Option<String>) -> Result<Option<String>> {
    let Some(v) = v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if (8..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(Some(v))
    } else {
        Err(Refusal::Invalid(format!("build '{v}' is not a build id")))
    }
}

impl EnvironmentService {
    pub fn new(store: Store, hub: Arc<ClientHub>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("constructor-studio")
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self { store, hub, http }
    }

    fn service(&self, tenant: Uuid) -> Result<SecurityContext> {
        service_context(tenant).map_err(Refusal::from)
    }

    /// May the caller administer `org`'s environments?
    pub async fn may_manage(&self, ctx: &SecurityContext, org: Uuid) -> bool {
        match self
            .hub
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(authority) => authority.may_administer(ctx, org, MANAGE_PRIVILEGE).await,
            // Without studio-user nobody can be shown to hold it.
            Err(_) => false,
        }
    }

    async fn require_manage(&self, ctx: &SecurityContext, org: Uuid) -> Result<()> {
        if self.may_manage(ctx, org).await {
            Ok(())
        } else {
            // Only an organization administrator, or whoever holds
            // MANAGE_PRIVILEGE, manages environments and decides about
            // deploys to protected ones.
            Err(Refusal::Forbidden("ENVIRONMENT_ADMIN_REQUIRED"))
        }
    }

    /// The caller as a person, with the name their profile carries.
    pub async fn person(&self, ctx: &SecurityContext) -> Person {
        if let Ok(people) = self
            .hub
            .get_scoped::<dyn crate::user_profile::PersonResolver>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
            && let Ok((id, name)) = people.resolve_caller_named(ctx).await
        {
            return Person { id, name };
        }
        Person {
            id: ctx.subject_id().to_string(),
            name: None,
        }
    }

    /// The organization a project is in, read as the caller: refused when the
    /// caller cannot see the project.
    pub async fn organization_of_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Uuid> {
        crate::organizations::sdk::organization_of(self.store.am().as_ref(), ctx, project)
            .await
            .filter(|org| *org != project)
            .ok_or_else(|| {
                Refusal::NotFound(
                    project.to_string(),
                    format!("there is no project {project} for this caller"),
                )
            })
    }

    /* ── environments ── */

    pub async fn environments(&self, ctx: &SecurityContext, org: Uuid) -> Result<EnvironmentList> {
        Ok(self
            .store
            .read::<EnvironmentList>(ctx, org, ENVIRONMENTS_METADATA_TYPE)
            .await?
            .0)
    }

    async fn environment(&self, ctx: &SecurityContext, org: Uuid, id: Uuid) -> Result<Environment> {
        self.environments(ctx, org)
            .await?
            .items
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| {
                Refusal::NotFound(
                    id.to_string(),
                    format!("the organization has no environment {id}"),
                )
            })
    }

    /// The connection an environment names must be a Kubernetes cluster the
    /// organization holds, shared with it: a deploy runs as the service, which
    /// cannot read somebody's personal token.
    async fn check_connection(&self, ctx: &SecurityContext, org: Uuid, id: Uuid) -> Result<()> {
        let am = self.store.am().as_ref();
        let (at, c) = connectors::connection_by_id(am, ctx, org, id)
            .await
            .ok_or_else(|| {
                Refusal::Invalid(format!("there is no connection {id} in the organization"))
            })?;
        if c.provider != "kubernetes" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is {}, not a Kubernetes cluster",
                c.label, c.provider
            )));
        }
        if c.scope == "personal" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is personal: an environment's cluster is the organization's, \
                 so connect it for the organization",
                c.label
            )));
        }
        let holder = connectors::holder_of_row(&c, at);
        connectors::check_owned(am, ctx, org, org, Some(holder))
            .await
            .map_err(|e| Refusal::Invalid(format!("{e}")))
    }

    /// The registry an environment names must be a `registry` connection the
    /// organization holds, shared with it, on the host its prefix names: the
    /// deploy logs in to it as the service, and writes its credential into
    /// the project's namespace.
    async fn check_registry_connection(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
        prefix: &str,
    ) -> Result<()> {
        let am = self.store.am().as_ref();
        let (at, c) = connectors::connection_by_id(am, ctx, org, id)
            .await
            .ok_or_else(|| {
                Refusal::Invalid(format!("there is no connection {id} in the organization"))
            })?;
        if c.provider != "registry" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is {}, not a container registry",
                c.label, c.provider
            )));
        }
        if c.scope == "personal" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is personal: an environment's registry is the organization's, \
                 so connect it for the organization",
                c.label
            )));
        }
        // The host is all that is read here; the credential stays in credstore.
        let access = connectors::RegistryAccess::parse(&c.base_url, "host-only")
            .map_err(|e| Refusal::Invalid(format!("{e}")))?;
        let prefix = prefix.trim().trim_end_matches('/');
        if !access.holds(prefix) {
            return Err(Refusal::Invalid(format!(
                "the registry prefix '{prefix}' is not on {}, the registry connection '{}' logs in to",
                access.host, c.label
            )));
        }
        let holder = connectors::holder_of_row(&c, at);
        connectors::check_owned(am, ctx, org, org, Some(holder))
            .await
            .map_err(|e| Refusal::Invalid(format!("{e}")))
    }

    pub async fn put_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Option<Uuid>,
        input: EnvironmentInput,
    ) -> Result<Environment> {
        self.require_manage(ctx, org).await?;
        self.check_connection(ctx, org, input.connection_id).await?;
        if let Some(registry) = input.registry_connection_id {
            self.check_registry_connection(ctx, org, registry, &input.registry)
                .await?;
        }
        let by = self.person(ctx).await.id;
        let at = now();
        let svc = self.service(org)?;
        let written = self
            .store
            .update::<EnvironmentList, Environment, Refusal>(
                &svc,
                org,
                ENVIRONMENTS_METADATA_TYPE,
                |list| {
                    if let Some(id) = id
                        && !list.items.iter().any(|e| e.id == id)
                    {
                        return Err(Refusal::NotFound(
                            id.to_string(),
                            format!("the organization has no environment {id}"),
                        ));
                    }
                    let env = model::checked(list, id, input.clone(), by.clone(), at.clone())?;
                    match list.items.iter_mut().find(|e| e.id == env.id) {
                        Some(slot) => *slot = env.clone(),
                        None => list.items.push(env.clone()),
                    }
                    list.items.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(env)
                },
            )
            .await?;
        written.map(|(_, env)| env)
    }

    pub async fn delete_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Result<()> {
        self.require_manage(ctx, org).await?;
        let svc = self.service(org)?;
        self.store
            .update::<EnvironmentList, (), Refusal>(&svc, org, ENVIRONMENTS_METADATA_TYPE, |list| {
                let before = list.items.len();
                list.items.retain(|e| e.id != id);
                if list.items.len() == before {
                    Err(Refusal::NotFound(
                        id.to_string(),
                        format!("the organization has no environment {id}"),
                    ))
                } else {
                    Ok(())
                }
            })
            .await?
            .map(|_| ())
    }

    /// Reach the environment's cluster with its connection and say what
    /// answered.
    pub async fn test_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Result<String> {
        self.require_manage(ctx, org).await?;
        let env = self.environment(ctx, org, id).await?;
        let svc = self.service(org)?;
        let access = deploy::cluster_access(&self.hub, &svc, org, env.connection_id)
            .await
            .map_err(|e| Refusal::Precondition("ENVIRONMENT_CLUSTER_UNUSABLE", format!("{e:#}")))?;
        let client = access.client().await.map_err(|e| {
            Refusal::Precondition("ENVIRONMENT_CLUSTER_UNREACHABLE", format!("{e:#}"))
        })?;
        let version = client.apiserver_version().await.map_err(|e| {
            Refusal::Precondition(
                "ENVIRONMENT_CLUSTER_UNREACHABLE",
                format!("the cluster did not answer: {e}"),
            )
        })?;
        Ok(format!(
            "{} answers: Kubernetes {}",
            access.server, version.git_version
        ))
    }

    /* ── a project's bindings and targets ── */

    pub async fn targets(&self, ctx: &SecurityContext, project: Uuid) -> Result<Targets> {
        let org = self.organization_of_project(ctx, project).await?;
        let project_name = self.store.tenant_name(ctx, project).await;
        let environments = self
            .environments(ctx, org)
            .await?
            .items
            .into_iter()
            .filter(|e| e.admits(project))
            .map(|e| {
                let ns = model::namespace_for(&e.namespace_pattern, &project_name, &e.name)
                    .unwrap_or_default();
                (e, ns)
            })
            .collect();
        let list = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0;
        Ok(Targets {
            organization_id: org,
            project_name,
            environments,
            bindings: list.items,
            secrets: list.secrets,
        })
    }

    pub async fn put_bindings(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        items: Vec<Binding>,
    ) -> Result<Vec<Binding>> {
        let org = self.organization_of_project(ctx, project).await?;
        let list = model::checked_bindings(items)?;
        let environments = self.environments(ctx, org).await?;
        for b in &list.items {
            let env = environments
                .items
                .iter()
                .find(|e| e.id == b.environment_id)
                .ok_or_else(|| {
                    Refusal::Invalid(format!(
                        "the organization has no environment {}",
                        b.environment_id
                    ))
                })?;
            if !env.admits(project) {
                return Err(Refusal::Invalid(format!(
                    "environment '{}' does not take this project's deploys",
                    env.name
                )));
            }
        }
        // The project's own setting, written as its member: a binding grants
        // nothing -- a deploy is still checked against the environment.
        self.store
            .update::<BindingList, (), Refusal>(ctx, project, BINDINGS_METADATA_TYPE, |row| {
                // The secrets' keys are kept: they are set one by one.
                row.items = list.items.clone();
                Ok(())
            })
            .await?
            .map(|(row, ())| row.items)
    }

    /// Set (`Some`) or remove (`None`) one secret of the project's
    /// configuration in an environment. The value goes to credstore, written
    /// as the service; the project's row keeps only the key.
    pub async fn put_config_secret(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
        key: &str,
        value: Option<String>,
    ) -> Result<ConfigSecret> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self.environment(ctx, org, environment).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        let key = key.trim().to_owned();
        if !model::is_secret_key(&key) {
            return Err(Refusal::Invalid(format!(
                "'{key}' is not a variable name: capitals, digits and _ (SMTP_PASSWORD)"
            )));
        }
        let credstore = self
            .hub
            .get::<dyn credstore_sdk::CredStoreClientV1>()
            .map_err(|_| {
                Refusal::Unavailable("credstore is not available in this deployment".into())
            })?;
        let reference = model::config_secret_ref(project, env.id, &key);
        let sref = credstore_sdk::SecretRef::new(&reference)
            .map_err(|e| Refusal::Internal(format!("bad secret reference: {e}")))?;
        let svc = self.service(org)?;
        let entry = ConfigSecret {
            environment_id: env.id,
            key: key.clone(),
        };
        match value {
            Some(value) => {
                if value.is_empty() || value.len() > 64 * 1024 {
                    return Err(Refusal::Invalid(
                        "a secret's value is between 1 byte and 64 KiB".into(),
                    ));
                }
                let bytes = value.into_bytes();
                // Overwrite whatever is there; create when nothing is.
                if credstore
                    .put(
                        &svc,
                        &sref,
                        credstore_sdk::SecretValue::new(bytes.clone()),
                        credstore_sdk::SharingMode::Tenant,
                        credstore_sdk::WritePrecondition::Exists,
                    )
                    .await
                    .is_err()
                {
                    credstore
                        .create(
                            &svc,
                            &sref,
                            credstore_sdk::SecretValue::new(bytes),
                            credstore_sdk::SharingMode::Tenant,
                        )
                        .await
                        .map_err(|e| {
                            Refusal::Internal(format!("the secret could not be stored: {e}"))
                        })?;
                }
                self.store
                    .update::<BindingList, (), Refusal>(
                        ctx,
                        project,
                        BINDINGS_METADATA_TYPE,
                        |row| {
                            if !row.secrets.contains(&entry) {
                                row.secrets.push(entry.clone());
                            }
                            Ok(())
                        },
                    )
                    .await??;
            }
            None => {
                self.store
                    .update::<BindingList, (), Refusal>(
                        ctx,
                        project,
                        BINDINGS_METADATA_TYPE,
                        |row| {
                            let before = row.secrets.len();
                            row.secrets.retain(|s| s != &entry);
                            if row.secrets.len() == before {
                                return Err(Refusal::NotFound(
                                    key.clone(),
                                    format!("no secret {key} is set for this environment"),
                                ));
                            }
                            Ok(())
                        },
                    )
                    .await??;
                if let Err(e) = credstore
                    .delete(&svc, &sref, credstore_sdk::WritePrecondition::Exists)
                    .await
                {
                    tracing::warn!(
                        reference,
                        "studio-environments: a secret's key was removed but its value could not be ({e})"
                    );
                }
            }
        }
        Ok(entry)
    }

    /* ── deployments ── */

    async fn enqueue(&self, org: Uuid, payload: &DeployPayload) -> Result<Uuid> {
        let queue = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                Refusal::Unavailable("background runs are not available in this deployment".into())
            })?;
        let svc = self.service(org)?;
        let partition = format!("{}:{}", payload.namespace, payload.release);
        queue
            .enqueue(
                &svc,
                crate::tasks::sdk::NewRun {
                    tenant: org,
                    task_type: deploy::TASK_TYPE,
                    payload: serde_json::to_value(payload).map_err(anyhow::Error::from)?,
                    // One release is installed by one run at a time.
                    partition_key: Some(&partition),
                    idempotency_key: Some(&payload.deployment_id.to_string()),
                    coalesce_queued: false,
                    notify_workspace_id: None,
                },
            )
            .await
            .map_err(|e| Refusal::Unavailable(format!("the deploy could not be queued: {e:#}")))
    }

    /// Queue the run, or record that it could not be queued: a record left
    /// `queued` with no run would say "deploying" for ever.
    async fn queue_or_fail(
        &self,
        org: Uuid,
        d: &mut Deployment,
        payload: DeployPayload,
    ) -> Result<Uuid> {
        match self.enqueue(org, &payload).await {
            Ok(run) => Ok(run),
            Err(refusal) => {
                d.state = DeploymentState::Failed;
                d.outcome = Some(match &refusal {
                    Refusal::Unavailable(why) | Refusal::Internal(why) => why.clone(),
                    _ => "the deploy could not be queued".to_owned(),
                });
                if let Err(e) = self.record(org, d.clone()).await {
                    tracing::warn!(error = ?e, "studio-environments: an unqueued deploy could not be recorded as failed");
                }
                Err(refusal)
            }
        }
    }

    /// The project's configuration for a release in `env`: the bound
    /// profile's values, and the keys of its secrets there.
    async fn project_config(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        env: &Environment,
        profile: &str,
    ) -> Result<Config> {
        let (list, _) = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?;
        Ok(Config {
            values: list
                .items
                .into_iter()
                .find(|b| b.profile == profile && b.environment_id == env.id)
                .and_then(|b| b.values),
            secret_keys: list
                .secrets
                .into_iter()
                .filter(|s| s.environment_id == env.id)
                .map(|s| s.key)
                .collect(),
        })
    }

    fn payload(
        org: Uuid,
        env: &Environment,
        d: &Deployment,
        chart: Option<String>,
        config: Config,
    ) -> DeployPayload {
        DeployPayload {
            deployment_id: d.id,
            organization_id: org,
            project_id: d.project_id,
            connection_id: env.connection_id,
            registry_connection_id: env.registry_connection_id,
            namespace: d.namespace.clone(),
            release: d.product.clone(),
            action: d.action,
            environment_id: env.id,
            secret_keys: config.secret_keys.clone(),
            database: env.database,
            database_image: env.database_image.clone(),
            chart,
            chart_ref: d.chart_ref.clone(),
            values: model::deploy_values(
                env,
                &d.images,
                config.values.as_ref(),
                &config.secret_keys,
                &d.product,
            ),
        }
    }

    async fn record(&self, org: Uuid, d: Deployment) -> Result<()> {
        let svc = self.service(org)?;
        self.store
            .update::<DeploymentList, (), Refusal>(&svc, org, DEPLOYMENTS_METADATA_TYPE, |list| {
                list.record(d.clone());
                Ok(())
            })
            .await?
            .map(|_| ())
    }

    /// An uploaded chart, checked: base64 of a packaged `.tgz` within the
    /// limit. Its sha256, which the record keeps.
    fn checked_chart(chart: &str) -> Result<String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(chart.as_bytes())
            .map_err(|_| Refusal::Invalid("the chart is not base64".into()))?;
        if bytes.is_empty() || bytes.len() > model::MAX_CHART_BYTES {
            return Err(Refusal::Invalid(format!(
                "the chart is {} bytes; a packaged chart is between 1 and {}",
                bytes.len(),
                model::MAX_CHART_BYTES
            )));
        }
        // gzip magic: the chart is a packaged `.tgz`.
        if !bytes.starts_with(&[0x1f, 0x8b]) {
            return Err(Refusal::Invalid("the chart is not a packaged .tgz".into()));
        }
        Ok(hex::encode(Sha256::digest(&bytes)))
    }

    /// A release name: a DNS label of at most 53, as Helm takes it.
    fn release_name(product: &str) -> Result<String> {
        let product = product.trim().to_owned();
        if !model::is_dns_label(&product) || product.len() > 53 {
            return Err(Refusal::Invalid(format!(
                "'{product}' cannot be a release name"
            )));
        }
        Ok(product)
    }

    pub async fn request_deploy(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        mut req: DeployRequest,
    ) -> Result<Deployment> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self.environment(ctx, org, req.environment_id).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        if let Some(earlier) = req.redeploy_of {
            req = self.again(ctx, org, project, earlier, req).await?;
        } else if req.action == DeploymentAction::Install
            && req.chart.is_none()
            && req.chart_ref.is_none()
            && let Some(build) = req.build.clone()
        {
            req = self.what_build_published(ctx, project, &build, req).await?;
        }
        let product = Self::release_name(&req.product)?;
        let project_name = self.store.tenant_name(ctx, project).await;
        let namespace = model::namespace_for(&env.namespace_pattern, &project_name, &env.name)?;
        let person = self.person(ctx).await;
        let mut d = Deployment {
            id: Uuid::new_v4(),
            project_id: project,
            project_name,
            environment_id: env.id,
            environment_name: env.name.clone(),
            profile: req.profile.trim().to_owned(),
            product,
            action: req.action,
            redeploy_of: req.redeploy_of,
            commit: None,
            lock_hash: None,
            build: None,
            images: Vec::new(),
            namespace,
            chart_sha256: String::new(),
            chart_ref: None,
            state: DeploymentState::Queued,
            run_id: None,
            requested_by: person.id,
            requested_by_name: person.name.unwrap_or_default(),
            requested_at: now(),
            decided_by: None,
            decided_by_name: None,
            decided_at: None,
            reason: None,
            outcome: None,
            pending_chart: None,
        };
        let mut chart = None;
        if req.action == DeploymentAction::Install {
            model::check_images(&req.images)?;
            chart = req
                .chart
                .map(|c| c.trim().to_owned())
                .filter(|c| !c.is_empty());
            let chart_ref = req
                .chart_ref
                .map(|c| c.trim().to_owned())
                .filter(|c| !c.is_empty());
            match (&chart, chart_ref) {
                (Some(chart), None) => d.chart_sha256 = Self::checked_chart(chart)?,
                (None, Some(reference)) => {
                    let version = req.chart_version.unwrap_or_default();
                    d.chart_ref = Some(model::check_chart_ref(&env, &reference, &version)?);
                }
                _ => {
                    return Err(Refusal::Invalid(
                        "a deploy carries the chart or names a published one (chart_ref), one of them"
                            .into(),
                    ));
                }
            }
            d.commit = check_hash("commit", req.commit)?;
            d.lock_hash = check_hash("lock_hash", req.lock_hash)?;
            d.build = check_build(req.build)?;
            d.images = req.images;
            self.check_promoted(ctx, org, &env, &d).await?;
        }
        let config = self.project_config(ctx, project, &env, &d.profile).await?;
        self.submit(org, &env, d, chart, config).await
    }

    /// The request that installs again what `earlier` installed, into the
    /// environment `req` names.
    async fn again(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        earlier: Uuid,
        req: DeployRequest,
    ) -> Result<DeployRequest> {
        let d = self.deployment(ctx, org, earlier).await?;
        if d.project_id != project || d.action != DeploymentAction::Install {
            return Err(Refusal::Invalid(format!(
                "deployment {earlier} is not an install of this project's product"
            )));
        }
        let Some(chart) = d.chart_ref else {
            return Err(Refusal::Invalid(format!(
                "deployment {earlier} carried its chart, which Studio does not keep: \
                 deploy that build again from where it was built"
            )));
        };
        Ok(DeployRequest {
            environment_id: req.environment_id,
            profile: d.profile,
            product: d.product,
            commit: d.commit,
            lock_hash: d.lock_hash,
            build: d.build,
            images: d.images,
            chart: None,
            chart_ref: Some(chart.reference),
            chart_version: Some(chart.version),
            action: DeploymentAction::Install,
            redeploy_of: Some(earlier),
        })
    }

    /// The request that installs what build `build_id` published: its chart
    /// and images, at its commit and lock (ADR-0048 §6). The build must have
    /// passed and published a chart.
    async fn what_build_published(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        build_id: &str,
        req: DeployRequest,
    ) -> Result<DeployRequest> {
        let builds = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
            .map_err(|_| {
                Refusal::Unavailable("builds are not available in this deployment".into())
            })?;
        let b = builds
            .build(ctx, &project.to_string(), build_id.trim())
            .await
            .map_err(|e| Refusal::Internal(format!("{e:#}")))?
            .ok_or_else(|| {
                Refusal::NotFound(
                    build_id.to_owned(),
                    format!("the project has no build {build_id}"),
                )
            })?;
        if b.status != "passed" {
            return Err(Refusal::Precondition(
                "BUILD_NOT_PASSED",
                format!("build {build_id} is {}, not passed", b.status),
            ));
        }
        let (Some(chart_ref), Some(chart_version)) = (b.chart_ref, b.chart_version) else {
            return Err(Refusal::Precondition(
                "BUILD_PUBLISHED_NO_CHART",
                format!(
                    "build {build_id} published no chart: build it with the product's workflow, \
                     or publish from the IDE"
                ),
            ));
        };
        let product = if req.product.trim().is_empty() {
            b.product.unwrap_or_default()
        } else {
            req.product
        };
        let profile = if req.profile.trim().is_empty() {
            b.profile.unwrap_or_default()
        } else {
            req.profile
        };
        Ok(DeployRequest {
            environment_id: req.environment_id,
            profile,
            product,
            commit: b.commit,
            lock_hash: b.lock_hash,
            build: Some(b.build_id),
            images: b
                .images
                .into_iter()
                .map(|(app, image)| DeployImage { app, image })
                .collect(),
            chart: None,
            chart_ref: Some(chart_ref),
            chart_version: Some(chart_version),
            action: DeploymentAction::Install,
            redeploy_of: None,
        })
    }

    /// Propose the build workflow to the project's repository, as a pull
    /// request: it builds `profile` and publishes under `environment`'s
    /// registry prefix (ADR-0048 §5).
    pub async fn propose_workflow(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
        profile: &str,
        product_file: &str,
    ) -> Result<WorkflowProposal> {
        let product_file = product_file.trim().trim_start_matches("./").to_owned();
        if !workflow::is_product_file(&product_file) {
            return Err(Refusal::Invalid(format!(
                "'{product_file}' is not a product description in the repository"
            )));
        }
        let org = self.organization_of_project(ctx, project).await?;
        let env = self.environment(ctx, org, environment).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        let files = self
            .hub
            .get::<dyn crate::product::port::ProjectFiles>()
            .map_err(|_| {
                Refusal::Unavailable(
                    "the project's repository is not available in this deployment".into(),
                )
            })?;
        let project_key = project.to_string();
        let gdl = files
            .read(ctx, &project_key, &product_file)
            .await
            .map_err(|e| Refusal::Invalid(format!("{e:#}")))?
            .ok_or_else(|| {
                Refusal::Precondition(
                    "PRODUCT_NOT_SAVED",
                    format!(
                        "the project's repository has no {product_file}: save the product first"
                    ),
                )
            })?;
        let product = workflow::product_id(&gdl)
            .ok_or_else(|| Refusal::Invalid(format!("{product_file} names no product id")))?;
        let (engine_repo, engine_rev) = crate::product::sdk::engine_pin();
        let params = workflow::Params {
            product_file: product_file.clone(),
            product,
            profile: profile.trim().to_owned(),
            prefix: env.registry.clone(),
            engine_repo,
            engine_rev: engine_rev.unwrap_or_default(),
        };
        let text = workflow::render(&params)?;
        let written = files
            .write(
                ctx,
                &project_key,
                &format!("studio/build-{}", params.product),
                &[crate::product::port::DeclarationFile {
                    path: workflow::path(&params.product),
                    content: text,
                }],
                &crate::product::port::PullRequestText {
                    message: format!("ci: build {} for {}", params.profile, env.name),
                    title: format!("Studio: build the product's {} profile for {}", params.profile, env.name),
                    body: format!(
                        "Proposed by Constructor Studio (ADR-0048). On every push to main it builds \
                         the `{}` profile with the Gearbox engine Studio runs, pushes the images \
                         and the chart under `{}`, and uploads `studio-build.json`, which Studio \
                         records as the run's build. A deploy to `{}` can then name that build.\n\n\
                         ghcr.io works with the run's own token; another registry needs the \
                         repository secrets STUDIO_REGISTRY_USERNAME and STUDIO_REGISTRY_TOKEN.",
                        params.profile, params.prefix, env.name
                    ),
                },
                true,
            )
            .await
            .map_err(|e| Refusal::Invalid(format!("the workflow could not be proposed: {e:#}")))?;
        Ok(WorkflowProposal {
            path: workflow::path(&params.product),
            branch: written.branch,
            pr_url: written.pr_url,
        })
    }

    /// Build the product in the environment's cluster (ADR-0048 §9): a run
    /// that starts a Job in the project's namespace there, which clones,
    /// generates, builds and pushes, and is watched until it ends. The build
    /// is recorded as running now, as the member who asked.
    pub async fn request_build(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
        profile: &str,
        product_file: Option<&str>,
        git_ref: Option<String>,
    ) -> Result<BuildStarted> {
        // Naming neither builds what the Product step last wrote, where it
        // wrote it: the description's path and its branch.
        let saved = if product_file.is_none() && git_ref.is_none() {
            match self.hub.get::<dyn crate::product::port::ProjectProducts>() {
                Ok(products) => products
                    .saved_description(ctx, &project.to_string())
                    .await
                    .ok()
                    .flatten(),
                Err(_) => None,
            }
        } else {
            None
        };
        let product_file = product_file
            .map(str::to_owned)
            .or_else(|| saved.as_ref().map(|s| s.path.clone()))
            .unwrap_or_else(|| "product.gdl".to_owned());
        let git_ref = git_ref.or_else(|| saved.and_then(|s| s.branch));
        let org = self.organization_of_project(ctx, project).await?;
        let env = self.environment(ctx, org, environment).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        let Some(registry_connection_id) = env.registry_connection_id else {
            return Err(Refusal::Precondition(
                "ENVIRONMENT_HAS_NO_REGISTRY",
                format!(
                    "environment '{}' has no registry login: a build pushes its images there",
                    env.name
                ),
            ));
        };
        let product_file = product_file.trim().trim_start_matches("./").to_owned();
        if !workflow::is_product_file(&product_file) {
            return Err(Refusal::Invalid(format!(
                "'{product_file}' is not a product description in the repository"
            )));
        }
        let profile = profile.trim().to_owned();
        if profile.is_empty()
            || !profile
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Refusal::Invalid(format!("'{profile}' is not a profile id")));
        }
        let git_ref = git_ref
            .map(|r| r.trim().to_owned())
            .filter(|r| !r.is_empty());
        if let Some(r) = &git_ref
            && (r.len() > 200
                || r.starts_with('-')
                || !r
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/')))
        {
            return Err(Refusal::Invalid(format!(
                "'{r}' is not a branch, tag or commit"
            )));
        }
        let builder_image = build::builder_image().ok_or_else(|| {
            Refusal::Unavailable(
                "this Studio does not know its own image to build with: set STUDIO_BUILDER_IMAGE"
                    .into(),
            )
        })?;
        let files = self
            .hub
            .get::<dyn crate::product::port::ProjectFiles>()
            .map_err(|_| {
                Refusal::Unavailable(
                    "the project's repository is not available in this deployment".into(),
                )
            })?;
        let target = files
            .repository(ctx, &project.to_string())
            .await
            .map_err(|e| Refusal::Invalid(format!("{e:#}")))?;
        let connection_id = target.connection_id.ok_or_else(|| {
            Refusal::Precondition(
                "REPOSITORY_HAS_NO_CONNECTION",
                "the project's repository is reached through no connection the server can use"
                    .into(),
            )
        })?;
        let project_name = self.store.tenant_name(ctx, project).await;
        let namespace = model::namespace_for(&env.namespace_pattern, &project_name, &env.name)?;
        let build_id = format!("studio-{}", &Uuid::new_v4().simple().to_string()[..12]);
        let payload = build::BuildPayload {
            build_id: build_id.clone(),
            organization_id: org,
            project_id: project,
            connection_id: env.connection_id,
            registry_connection_id,
            namespace: namespace.clone(),
            prefix: env.registry.clone(),
            profile: profile.clone(),
            product_file,
            repo: build::RepoRef {
                tenant: target.tenant,
                connection_id,
                repo: target.repo.clone(),
                branch: target.base_branch.clone(),
            },
            git_ref,
            builder_image,
            buildkit_image: build::buildkit_image(),
        };
        if let Ok(builds) = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
        {
            builds
                .record(
                    ctx,
                    &project.to_string(),
                    &crate::artifact_ingest::port::BuildOutcome::running(
                        &build_id,
                        &target.repo,
                        &profile,
                    ),
                )
                .await
                .map_err(|e| Refusal::Internal(format!("{e:#}")))?;
        }
        let run_id = build::enqueue(
            &self.hub,
            org,
            build::TASK_TYPE,
            serde_json::to_value(&payload).map_err(anyhow::Error::from)?,
            &format!("build:{namespace}"),
            &build_id,
        )
        .await
        .map_err(|e| Refusal::Unavailable(format!("the build could not be queued: {e:#}")))?;
        Ok(BuildStarted {
            build_id,
            run_id,
            namespace,
        })
    }

    /// A short-lived token that may push `repositories` (names under the
    /// environment's registry prefix) and nothing else, for a member who
    /// publishes a build from the desktop (ADR-0048 §1). The registry's own
    /// token service issues it; the stored credential never leaves.
    pub async fn push_token(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
        repositories: Vec<String>,
    ) -> Result<PushToken> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self.environment(ctx, org, environment).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        let Some(connection) = env.registry_connection_id else {
            return Err(Refusal::Precondition(
                "ENVIRONMENT_HAS_NO_REGISTRY",
                format!("environment '{}' has no registry login", env.name),
            ));
        };
        let paths = model::push_paths(&env.registry, &repositories)?;
        let svc = self.service(org)?;
        let access = deploy::registry_access(&self.hub, &svc, org, connection)
            .await
            .map_err(|e| Refusal::Invalid(format!("{e:#}")))?;
        let (token, expires_in) = access
            .push_token(&self.http, &paths)
            .await
            .map_err(|e| Refusal::Unavailable(format!("{e:#}")))?;
        Ok(PushToken {
            registry: access.host.clone(),
            prefix: env.registry.clone(),
            token,
            expires_in,
        })
    }

    /// Refused when `env` takes releases from another environment and this
    /// one has not succeeded there (ADR-0048 §5).
    async fn check_promoted(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        env: &Environment,
        d: &Deployment,
    ) -> Result<()> {
        let Some(from) = env.promote_from else {
            return Ok(());
        };
        let from_name = self
            .environment(ctx, org, from)
            .await
            .map(|e| e.name)
            .unwrap_or_else(|_| from.to_string());
        let history = self
            .deployments(ctx, org, Some(d.project_id), Some(from))
            .await?;
        match model::promotion_gap(env, &from_name, d, &history) {
            None => Ok(()),
            Some(why) => Err(Refusal::Precondition("RELEASE_NOT_PROMOTED", why)),
        }
    }

    /// Record `d` and queue its run, or hold it for an administrator when the
    /// environment is protected.
    async fn submit(
        &self,
        org: Uuid,
        env: &Environment,
        mut d: Deployment,
        chart: Option<String>,
        config: Config,
    ) -> Result<Deployment> {
        if env.protected {
            d.state = DeploymentState::AwaitingApproval;
            // A published chart is named on the record; only an uploaded one
            // has to be kept until the decision.
            d.pending_chart = chart;
            self.record(org, d.clone()).await?;
        } else {
            // Recorded before it is queued, so the run never finishes before
            // the record of it exists.
            self.record(org, d.clone()).await?;
            let payload = Self::payload(org, env, &d, chart, config);
            let run = self.queue_or_fail(org, &mut d, payload).await?;
            d.run_id = Some(run);
            self.record(org, d.clone()).await?;
        }
        d.pending_chart = None;
        Ok(d)
    }

    /// Approve or decline a deploy waiting for one.
    pub async fn decide(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
        approve: bool,
        reason: Option<String>,
    ) -> Result<Deployment> {
        self.require_manage(ctx, org).await?;
        let reason = reason
            .map(|r| r.trim().to_owned())
            .filter(|r| !r.is_empty());
        if !approve && reason.is_none() {
            return Err(Refusal::Invalid(
                "a declined deploy says why: give a reason".into(),
            ));
        }
        let mut d = self.deployment(ctx, org, id).await?;
        if d.state != DeploymentState::AwaitingApproval {
            return Err(Refusal::Precondition(
                "DEPLOYMENT_NOT_AWAITING_APPROVAL",
                format!(
                    "the deploy is {}, not waiting for a decision",
                    d.state.as_str()
                ),
            ));
        }
        let person = self.person(ctx).await;
        d.decided_by = Some(person.id);
        d.decided_by_name = person.name;
        d.decided_at = Some(now());
        d.reason = reason;
        let chart = d.pending_chart.take();
        if approve {
            let env = self.environment(ctx, org, d.environment_id).await?;
            if d.action == DeploymentAction::Install && chart.is_none() && d.chart_ref.is_none() {
                return Err(Refusal::Precondition(
                    "DEPLOYMENT_CHART_GONE",
                    "the deploy no longer carries its chart: ask again".into(),
                ));
            }
            // Read at the decision, so a value changed while the deploy waited
            // is the one installed. As the service, which reads the project's
            // row whoever the administrator is.
            let svc = self.service(org)?;
            let config = match self
                .project_config(&svc, d.project_id, &env, &d.profile)
                .await
            {
                Ok(c) => c,
                Err(_) => {
                    self.project_config(ctx, d.project_id, &env, &d.profile)
                        .await?
                }
            };
            d.state = DeploymentState::Queued;
            self.record(org, d.clone()).await?;
            let payload = Self::payload(org, &env, &d, chart, config);
            let run = self.queue_or_fail(org, &mut d, payload).await?;
            d.run_id = Some(run);
        } else {
            d.state = DeploymentState::Declined;
        }
        self.record(org, d.clone()).await?;
        Ok(d)
    }

    async fn deployment(&self, ctx: &SecurityContext, org: Uuid, id: Uuid) -> Result<Deployment> {
        self.store
            .read::<DeploymentList>(ctx, org, DEPLOYMENTS_METADATA_TYPE)
            .await?
            .0
            .items
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| {
                Refusal::NotFound(
                    id.to_string(),
                    format!("the organization has no deployment {id}"),
                )
            })
    }

    /// An organization's deployments, newest first, each with where its run
    /// has got to. A run that ended since the last read is written back, so
    /// the record keeps its outcome after the run's history is swept.
    pub async fn deployments(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Option<Uuid>,
        environment: Option<Uuid>,
    ) -> Result<Vec<Deployment>> {
        let (list, _) = self
            .store
            .read::<DeploymentList>(ctx, org, DEPLOYMENTS_METADATA_TYPE)
            .await?;
        let queue = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .ok();
        let mut ended = Vec::new();
        let mut items = Vec::new();
        for mut d in list.items {
            if project.is_some_and(|p| p != d.project_id)
                || environment.is_some_and(|e| e != d.environment_id)
            {
                continue;
            }
            if let (Some(queue), Some(run), DeploymentState::Queued | DeploymentState::Running) =
                (&queue, d.run_id, d.state)
                && let Ok(Some(view)) = queue.run(org, run).await
            {
                let state = match view.state {
                    crate::tasks::RunState::Queued => DeploymentState::Queued,
                    crate::tasks::RunState::Running => DeploymentState::Running,
                    crate::tasks::RunState::Succeeded => DeploymentState::Succeeded,
                    crate::tasks::RunState::Failed => DeploymentState::Failed,
                    crate::tasks::RunState::Cancelled => DeploymentState::Cancelled,
                };
                if state != d.state {
                    d.state = state;
                    d.outcome = view.last_error.clone().or_else(|| {
                        view.result
                            .as_ref()
                            .and_then(|r| r.get("output"))
                            .and_then(|o| o.as_str())
                            .map(|o| o.lines().last().unwrap_or_default().to_owned())
                    });
                    if view.state.is_terminal() {
                        ended.push(d.clone());
                    }
                }
            }
            d.pending_chart = None;
            items.push(d);
        }
        for d in ended {
            // Best effort: the answer above is right either way.
            if let Err(e) = self.record(org, d).await {
                tracing::warn!(error = ?e, "studio-environments: a finished deploy could not be written back");
            }
        }
        Ok(items)
    }

    /// The release's rollout as its cluster reports it now.
    pub async fn status(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Result<(Deployment, Rollout)> {
        let d = self.deployment(ctx, org, id).await?;
        let env = self.environment(ctx, org, d.environment_id).await?;
        // The member asked through a deployment they can see; the cluster is
        // read as the service, which can read the organization's connection.
        let svc = self.service(org)?;
        let access = deploy::cluster_access(&self.hub, &svc, org, env.connection_id)
            .await
            .map_err(|e| Refusal::Precondition("ENVIRONMENT_CLUSTER_UNUSABLE", format!("{e:#}")))?;
        let rollout = deploy::rollout(&access, &d.namespace, &d.product)
            .await
            .map_err(|e| {
                Refusal::Precondition("ENVIRONMENT_CLUSTER_UNREACHABLE", format!("{e:#}"))
            })?;
        let mut d = d;
        d.pending_chart = None;
        Ok((d, rollout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hash_is_hex_of_a_sensible_length() {
        assert_eq!(check_hash("commit", None).unwrap(), None);
        assert_eq!(check_hash("commit", Some(" ".into())).unwrap(), None);
        assert_eq!(
            check_hash("commit", Some("ea964f9".into()))
                .unwrap()
                .as_deref(),
            Some("ea964f9")
        );
        assert!(check_hash("commit", Some("main".into())).is_err());
        assert!(check_hash("commit", Some("abc".into())).is_err());
    }
}
