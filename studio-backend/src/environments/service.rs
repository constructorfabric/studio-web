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
    DeploymentList, DeploymentState, Environment, EnvironmentInput, EnvironmentKind,
    EnvironmentList, Invalid, Preview,
};
use super::placement;
use super::preview::{self, PreviewRoute, SweepPayload};
use super::readiness::{self, Role};
use super::records::Records;
use super::research;
use super::store::{Store, service_context};
use super::workflow;
use super::{BINDINGS_METADATA_TYPE, DEPLOYMENTS_METADATA_TYPE, ENVIRONMENTS_METADATA_TYPE};
use crate::connectors::sdk as connectors;

// A project's images and an organization's registries (ADR-0062 §4, §5).
#[path = "service_images.rs"]
mod images_service;
pub use images_service::{RetentionOf, RetentionScope, RunsIn};

// A project's infra services and what a deploy does with them (ADR-0064).
#[path = "service_infra.rs"]
mod infra_service;
pub use infra_service::InfraPlan;

// One build, one deployment and an environment's secret keys, read one at a
// time by an agent following the pipeline (`docs/mcp.md`).
#[path = "service_pipeline.rs"]
mod pipeline_service;
pub use pipeline_service::{BuildView, SecretKeys};

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
    /// 409: not while the thing is in this state: the code, and why.
    Conflict(&'static str, String),
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
    /// Install it as a preview (ADR-0055): into a namespace of its own, for
    /// a while.
    pub preview: Option<PreviewAsk>,
}

/// What a person asks of a preview.
#[derive(Debug, Clone, Default)]
pub struct PreviewAsk {
    /// Default: made of the deployment's id.
    pub name: Option<String>,
    /// Default, and at most: the environment's.
    pub ttl_hours: Option<u32>,
}

/// A build Studio was asked to run.
#[derive(Debug, Clone)]
pub struct BuildStarted {
    pub build_id: String,
    pub run_id: Uuid,
    pub namespace: String,
}

/// One source a build takes, as its plan says it (ADR-0062 §8).
#[derive(Debug, Clone, Default)]
pub struct PlanSource {
    /// `home` for the project's repository, else the description's id.
    pub id: String,
    pub repository: String,
    pub git_ref: String,
    /// The commit, when the ref is one (a protected build's pin).
    pub commit: Option<String>,
    pub connection_id: Option<Uuid>,
    pub connection_label: Option<String>,
    pub connection_scope: Option<String>,
    /// The tenant that holds the connection.
    pub connection_holder: Option<Uuid>,
}

/// What a build would do, said before anything starts (ADR-0062 §8).
#[derive(Debug, Clone)]
pub struct BuildPlan {
    pub environment_id: Uuid,
    pub environment: String,
    pub profile: String,
    pub product_file: String,
    pub description_revision: Option<i64>,
    pub strictness: String,
    pub namespace: String,
    pub build_namespace: String,
    pub builder_image: String,
    pub builder_pinned: bool,
    pub gearbox_version: Option<String>,
    pub registry_prefix: String,
    pub image_repositories: Vec<String>,
    pub chart_repository: String,
    pub sources: Vec<PlanSource>,
    pub warnings: Vec<String>,
    /// The codes of the environment's warnings among `warnings`, e.g.
    /// `PULL_USES_PUSH_LOGIN`.
    pub warning_codes: Vec<String>,
    /// The refusal a build would meet now: its code and why.
    pub refusal: Option<(String, String)>,
}

/// A build asked for, or only planned.
#[derive(Debug, Clone)]
pub enum BuildAsked {
    Started(BuildStarted),
    Planned(Box<BuildPlan>),
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
    /// The project's build namespace there, recorded with its namespace by
    /// the run (ADR-0062 §3).
    build_namespace: Option<String>,
    /// The product's infra services, as the run brings them (ADR-0064).
    infra: Vec<super::infra::InfraInstall>,
    /// The repository's own build (ADR-0054 §7): where its chart reads the
    /// images and the configuration secret.
    own: Option<model::OwnBuild>,
    /// What the deploy says and goes on with, `CODE: message` each: a
    /// configuration secret the description wins over, an issuer pods may
    /// not reach.
    warnings: Vec<String>,
    /// Why an install is refused: a configuration secret and the
    /// description both set a field ([`super::gear_overrides::CONFLICT`]).
    conflict: Option<String>,
}

impl Config {
    /// Refuse an install the configuration contradicts.
    fn check(&self, action: DeploymentAction) -> Result<()> {
        match (&self.conflict, action) {
            (Some(why), DeploymentAction::Install) => Err(Refusal::Precondition(
                super::gear_overrides::CONFLICT,
                why.clone(),
            )),
            _ => Ok(()),
        }
    }
}

pub struct EnvironmentService {
    store: Store,
    hub: Arc<ClientHub>,
    /// For the registries' token services.
    http: reqwest::Client,
    /// The gear's own tables (ADR-0062); unset without a database.
    records: std::sync::OnceLock<Arc<Records>>,
}

/// A build or deploy that names no description, of a project whose product
/// was never saved: there is nothing to say which `product.gdl` it means.
/// The saved product description could not be read: the store's answer, not
/// "the project has no product".
fn saved_description_unreadable(e: anyhow::Error) -> Refusal {
    Refusal::Unavailable(format!(
        "the project's saved product description could not be read: {e:#}"
    ))
}

/// The project's name could not be read, and a namespace is made of it: a
/// deploy or a build is refused rather than placed in a namespace named
/// after nothing.
fn project_name_unreadable(project: Uuid, e: anyhow::Error) -> Refusal {
    Refusal::Unavailable(format!(
        "the name of project {project} could not be read, and its namespace is made of it: \
         {e:#}"
    ))
}

fn no_saved_product() -> Refusal {
    Refusal::Precondition(
        "PRODUCT_NOT_SAVED",
        "the project has no product yet: save one in the Product step first, or name its \
         product.gdl"
            .into(),
    )
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

/// A deploy refused for repeating one that waits for a decision.
fn already_waiting(waiting: Uuid) -> Refusal {
    Refusal::Conflict(
        "DEPLOY_ALREADY_WAITING",
        format!(
            "deployment {waiting} of this release already waits for a decision in this \
             environment: approve or decline it rather than asking again"
        ),
    )
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
        Self {
            store,
            hub,
            http,
            records: std::sync::OnceLock::new(),
        }
    }

    pub fn set_records(&self, records: Arc<Records>) {
        let _ = self.records.set(records);
    }

    fn records(&self) -> Option<&Arc<Records>> {
        self.records.get()
    }

    fn records_or_unavailable(&self) -> Result<&Arc<Records>> {
        self.records().ok_or_else(|| {
            Refusal::Unavailable(
                "image records are not kept in this deployment: the environments gear has no \
                 database"
                    .into(),
            )
        })
    }

    /// The project's name, which its namespaces are made of: refused with
    /// the cause when account-management does not answer it.
    async fn project_name(&self, ctx: &SecurityContext, project: Uuid) -> Result<String> {
        self.store
            .tenant_name(ctx, project)
            .await
            .map_err(|e| project_name_unreadable(project, e))
    }

    /// The project's immutable slug (ADR-0062 §3): recorded the first time,
    /// from its name; without the tables, its name as a slug.
    pub(super) async fn slug(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
    ) -> Result<String> {
        let name = self.project_name(ctx, project).await?;
        match self.records() {
            Some(r) => r
                .slug(org, project, &name)
                .await
                .map_err(|e| Refusal::Internal(format!("{e:#}"))),
            None => Ok(model::slug(&name)),
        }
    }

    /// Where `project` goes in `env`: its recorded namespaces, else the
    /// pattern's for its slug, and its own registry path.
    pub(super) async fn place(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        env: &Environment,
    ) -> Result<placement::Place> {
        let slug = self.slug(ctx, org, project).await?;
        let assignment = match self.records() {
            Some(r) => r
                .assignment(org, project, env.id)
                .await
                .map_err(|e| Refusal::Internal(format!("{e:#}")))?,
            None => None,
        };
        placement::place_of(env, &slug, assignment.as_ref())
            .map_err(|(code, why)| Refusal::Precondition(code, why))
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
        from: Uuid,
        id: Uuid,
        prefix: &str,
    ) -> Result<()> {
        let am = self.store.am().as_ref();
        let (at, c) = connectors::connection_by_id(am, ctx, from, id)
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

    /// A Research environment signs in with a `research` connection. It is
    /// the member's own (ADR-0049 §1): a run reads it as the member who asked.
    async fn check_research_connection(
        &self,
        ctx: &SecurityContext,
        from: Uuid,
        id: Uuid,
    ) -> Result<()> {
        let am = self.store.am().as_ref();
        let (_, c) = connectors::connection_by_id(am, ctx, from, id)
            .await
            .ok_or_else(|| Refusal::Invalid(format!("there is no connection {id} you can use")))?;
        if c.provider != connectors::RESEARCH_PROVIDER {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is {}, not Constructor Research",
                c.label, c.provider
            )));
        }
        Ok(())
    }

    /// The cluster a project's own environment runs on (ADR-0054 §2): one the
    /// project holds and shares with it, or one of the organization's that
    /// the organization opened to its projects. Never a personal one.
    async fn check_project_cluster(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        open: &[Uuid],
        id: Uuid,
    ) -> Result<()> {
        let am = self.store.am().as_ref();
        let (at, c) = connectors::connection_by_id(am, ctx, project, id)
            .await
            .ok_or_else(|| {
                Refusal::Invalid(format!("there is no connection {id} in the project"))
            })?;
        if c.provider != "kubernetes" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is {}, not a Kubernetes cluster",
                c.label, c.provider
            )));
        }
        if c.scope == "personal" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is personal: a deploy runs as the service, so connect the \
                 cluster for the project",
                c.label
            )));
        }
        let holder = connectors::holder_of_row(&c, at);
        if holder != project && !open.contains(&id) {
            return Err(Refusal::Forbidden("CLUSTER_NOT_OPEN_TO_PROJECTS"));
        }
        connectors::check_owned(am, ctx, org, org, Some(holder))
            .await
            .map_err(|e| Refusal::Invalid(format!("{e}")))
    }

    /* ── what the run will read, read before it is queued ── */

    /// One connection read the way a run reads it: as `reader`, found from
    /// `tenant`, its credential taken out of credstore. What was seen of it,
    /// and its credential when that could be read.
    async fn read_connection(
        &self,
        reader: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> (readiness::Seen, Option<connectors::ConnectionAuth>) {
        let Some(service) = connectors::Connectors::new(Arc::clone(&self.hub)).get() else {
            return (
                readiness::Seen {
                    unreadable: Some("connections are not available in this deployment".into()),
                    ..readiness::Seen::default()
                },
                None,
            );
        };
        match service.driver_and_auth(reader, tenant, id).await {
            Ok((_, auth, c)) => (
                readiness::Seen {
                    label: Some(c.label),
                    scope: Some(c.scope),
                    unreadable: None,
                },
                Some(auth),
            ),
            Err(e) => {
                // Name it as far as it can be found, whoever's it is.
                let named =
                    connectors::connection_by_id(self.store.am().as_ref(), reader, tenant, id)
                        .await
                        .map(|(_, c)| c);
                (
                    readiness::Seen {
                        label: named.as_ref().map(|c| c.label.clone()),
                        scope: named.map(|c| c.scope),
                        unreadable: Some(format!("{e:#}")),
                    },
                    None,
                )
            }
        }
    }

    /// The repository a build clones must be reached through a connection
    /// the build can read: as the organization's service, as the run reads
    /// it (`build::BuildTask::start`). Its label, for the build's record.
    async fn check_source_readable(&self, org: Uuid, repo: &build::RepoRef) -> Result<String> {
        let reader = self.service(org)?;
        let (seen, _) = self
            .read_connection(&reader, repo.tenant, repo.connection_id)
            .await;
        if let Some((code, why)) = readiness::connection_refusal(
            Role::Source,
            &repo.connection_id.to_string(),
            &seen,
            Some(&repo.repo),
        ) {
            return Err(Refusal::Precondition(code, why));
        }
        Ok(seen.label.unwrap_or_default())
    }

    /// The environment's connections read as the run will read them, and its
    /// cluster asked whether the connection may do there what a build or a
    /// deploy does in `namespace` (ADR-0043): each refusal names its cause
    /// before anything is queued.
    async fn check_cluster_ready(
        &self,
        org: Uuid,
        project: Uuid,
        env: &Environment,
        place: &placement::Place,
        registry: Option<Uuid>,
        build: bool,
    ) -> Result<()> {
        let from = env.connections_from(org);
        let reader = self.service(from)?;
        if let Some(id) = registry.filter(|id| !id.is_nil()) {
            let (seen, auth) = self.read_connection(&reader, from, id).await;
            if let Some((code, why)) =
                readiness::connection_refusal(Role::Registry, &id.to_string(), &seen, None)
            {
                return Err(Refusal::Precondition(code, why));
            }
            // A build pushes as the organization's service, with a token
            // that may push and pull packages and nothing more (ADR-0062 §2).
            if build {
                let label = seen.label.clone().unwrap_or_else(|| id.to_string());
                if seen.scope.as_deref() == Some("personal") {
                    return Err(Refusal::Precondition(
                        readiness::REGISTRY_CONNECTION_PERSONAL,
                        format!(
                            "the environment's registry connection '{label}' is personal: a build \
                             Studio runs pushes as the organization's service -- connect the \
                             registry for the organization"
                        ),
                    ));
                }
                if let Some(auth) = auth
                    && let Ok(access) =
                        connectors::RegistryAccess::parse(&auth.base_url, &auth.token)
                    && let Ok(connectors::TokenScopes::Known(scopes)) =
                        connectors::token_scopes(&self.http, &access).await
                    && let Some((code, why)) = readiness::token_refusal(
                        &label,
                        &connectors::too_broad(&scopes),
                        env.boundaries.allow_broad_registry_token,
                    )
                {
                    return Err(Refusal::Precondition(code, why));
                }
            }
        }
        let client = self.cluster_client(org, env).await?;
        let given = env.boundaries.namespaces.clone().unwrap_or_default();
        let mut wanted = vec![place.namespace.as_str()];
        if build && place.build_namespace != place.namespace {
            wanted.push(place.build_namespace.as_str());
        }
        let unreachable = |why: String| {
            Refusal::Precondition(
                "ENVIRONMENT_CLUSTER_UNREACHABLE",
                format!("{}: {why}", env.name),
            )
        };
        // A cluster that does not answer is said in seconds, not after the
        // client's own minutes.
        let (level, facts) = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let level = connectors::cluster_readiness(&client, &given).await?;
            let mut facts = Vec::new();
            for ns in &wanted {
                facts.push(readiness::cluster_facts(&client, ns).await?);
            }
            anyhow::Ok((level, facts))
        })
        .await
        .map_err(|_| unreachable("the cluster did not answer in 30 seconds".into()))?
        .map_err(|e| unreachable(format!("{e:#}")))?;
        // How far the cluster is bootstrapped (ADR-0062 §6), before any one
        // namespace: a partial cluster says all it lacks at once.
        if let Some((code, why)) = readiness::bootstrap_refusal(&level.readiness, &wanted) {
            return Err(Refusal::Precondition(code, why));
        }
        for f in &facts {
            if let Some((code, why)) = readiness::cluster_refusal(f) {
                return Err(Refusal::Precondition(code, why));
            }
            if f.seen == readiness::NamespaceSeen::Exists
                && let Some((code, why)) = placement::owner_refusal(
                    &f.namespace,
                    f.project_label.as_deref(),
                    project,
                    place.recorded,
                )
            {
                return Err(Refusal::Precondition(code, why));
            }
        }
        Ok(())
    }

    /// A client of the environment's cluster, its connection read as a run
    /// reads it.
    async fn cluster_client(&self, org: Uuid, env: &Environment) -> Result<kube::Client> {
        let from = env.connections_from(org);
        let reader = self.service(from)?;
        let (seen, auth) = self.read_connection(&reader, from, env.connection_id).await;
        if let Some((code, why)) = readiness::connection_refusal(
            Role::Cluster,
            &env.connection_id.to_string(),
            &seen,
            None,
        ) {
            return Err(Refusal::Precondition(code, why));
        }
        let auth = auth.ok_or_else(|| {
            Refusal::Internal("the cluster connection was read without its credential".into())
        })?;
        let access =
            connectors::ClusterAccess::parse(&auth.base_url, &auth.token).map_err(|e| {
                Refusal::Precondition(
                    readiness::CLUSTER_CONNECTION_UNREADABLE,
                    format!(
                        "the environment's cluster connection '{}' cannot be used: {e:#}",
                        seen.label.as_deref().unwrap_or_default()
                    ),
                )
            })?;
        access.client().await.map_err(|e| {
            Refusal::Precondition(
                "ENVIRONMENT_CLUSTER_UNREACHABLE",
                format!("{}: {e:#}", env.name),
            )
        })
    }

    /// How far an environment's cluster is bootstrapped, asked now
    /// (ADR-0062 §6).
    pub async fn readiness(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Option<Uuid>,
        environment: Uuid,
    ) -> Result<(connectors::ReadinessReport, Vec<String>, Vec<String>)> {
        let env = match project {
            Some(p) => self.project_environment(ctx, org, p, environment).await?,
            None => self.environment(ctx, org, environment).await?,
        };
        if env.kind != EnvironmentKind::Kubernetes {
            return Err(Refusal::Precondition(
                "ENVIRONMENT_NOT_A_CLUSTER",
                format!("'{}' is not a Kubernetes environment", env.name),
            ));
        }
        let client = self.cluster_client(org, &env).await?;
        let given = env.boundaries.namespaces.clone().unwrap_or_default();
        let report = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            connectors::cluster_readiness(&client, &given),
        )
        .await
        .map_err(|_| {
            Refusal::Precondition(
                "ENVIRONMENT_CLUSTER_UNREACHABLE",
                format!("{}: the cluster did not answer in 30 seconds", env.name),
            )
        })?
        .map_err(|e| {
            Refusal::Precondition(
                "ENVIRONMENT_CLUSTER_UNREACHABLE",
                format!("{}: {e:#}", env.name),
            )
        })?;
        // How the environment is set up says the rest: the cluster may be
        // ready while it pulls with the push login.
        Ok((report, env.warnings(), env.warning_codes()))
    }

    /* ── a project's own environments (ADR-0054) ── */

    /// The project's own environments, read as the caller.
    async fn own_environments(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Vec<Environment>> {
        Ok(self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0
            .environments)
    }

    /// What `project` sees: the organization's environments that admit it,
    /// and its own.
    async fn visible(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
    ) -> Result<(Vec<Environment>, Vec<Environment>)> {
        let admitted = self
            .environments(ctx, org)
            .await?
            .items
            .into_iter()
            .filter(|e| e.admits(project))
            .collect();
        Ok((admitted, self.own_environments(ctx, project).await?))
    }

    /// One environment `project` may deploy to: the organization's that
    /// admits it, or its own.
    async fn project_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        id: Uuid,
    ) -> Result<Environment> {
        if let Some(own) = self
            .own_environments(ctx, project)
            .await?
            .into_iter()
            .find(|e| e.id == id)
        {
            return Ok(own);
        }
        let env = self.environment(ctx, org, id).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        Ok(env)
    }

    /// The project's own environments, and the organization's clusters it
    /// may put one on.
    pub async fn project_environments(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<(Vec<Environment>, Vec<Uuid>)> {
        let org = self.organization_of_project(ctx, project).await?;
        let open = self.environments(ctx, org).await?.open_clusters;
        Ok((self.own_environments(ctx, project).await?, open))
    }

    /// Add (`id` `None`) or change one of the project's own environments, as
    /// a member who may write the project's settings (ADR-0054 §4).
    pub async fn put_project_environment(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        id: Option<Uuid>,
        input: EnvironmentInput,
    ) -> Result<Environment> {
        let org = self.organization_of_project(ctx, project).await?;
        let list = self.environments(ctx, org).await?;
        match input.kind {
            EnvironmentKind::Kubernetes => {
                self.check_project_cluster(
                    ctx,
                    org,
                    project,
                    &list.open_clusters,
                    input.connection_id,
                )
                .await?
            }
            EnvironmentKind::Research => {
                self.check_research_connection(ctx, project, input.connection_id)
                    .await?
            }
        }
        if let Some(registry) = input.registry_connection_id {
            self.check_registry_connection(ctx, org, project, registry, &input.registry)
                .await?;
        }
        let admitted: Vec<Environment> = list
            .items
            .into_iter()
            .filter(|e| e.admits(project))
            .collect();
        let by = self.person(ctx).await.id;
        let at = now();
        self.store
            .update::<BindingList, Environment, Refusal>(
                ctx,
                project,
                BINDINGS_METADATA_TYPE,
                |row| {
                    if let Some(id) = id
                        && !row.environments.iter().any(|e| e.id == id)
                    {
                        return Err(Refusal::NotFound(
                            id.to_string(),
                            format!("the project has no environment {id} of its own"),
                        ));
                    }
                    let env = model::checked_for_project(
                        &admitted,
                        &row.environments,
                        project,
                        id,
                        input.clone(),
                        by.clone(),
                        at.clone(),
                    )?;
                    match row.environments.iter_mut().find(|e| e.id == env.id) {
                        Some(slot) => *slot = env.clone(),
                        None => row.environments.push(env.clone()),
                    }
                    row.environments.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(env)
                },
            )
            .await?
            .map(|(_, env)| env)
    }

    /// Remove one of the project's own environments, and the bindings to it.
    /// What runs there stays, and its records stay in the organization's
    /// history.
    pub async fn delete_project_environment(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        id: Uuid,
    ) -> Result<()> {
        self.organization_of_project(ctx, project).await?;
        self.store
            .update::<BindingList, (), Refusal>(ctx, project, BINDINGS_METADATA_TYPE, |row| {
                let before = row.environments.len();
                row.environments.retain(|e| e.id != id);
                if row.environments.len() == before {
                    return Err(Refusal::NotFound(
                        id.to_string(),
                        format!("the project has no environment {id} of its own"),
                    ));
                }
                row.items.retain(|b| b.environment_id != id);
                Ok(())
            })
            .await?
            .map(|_| ())
    }

    /// How the project builds (ADR-0054 §7): `None` on gears, from its
    /// product description; `Some` from the repository's own Dockerfiles and
    /// chart.
    pub async fn project_build(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Option<model::OwnBuild>> {
        self.organization_of_project(ctx, project).await?;
        Ok(self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0
            .build)
    }

    /// Set how the project builds, as a member who may write its settings.
    pub async fn put_project_build(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        build: Option<model::OwnBuild>,
    ) -> Result<Option<model::OwnBuild>> {
        self.organization_of_project(ctx, project).await?;
        let build = build.map(model::checked_own_build).transpose()?;
        self.store
            .update::<BindingList, Option<model::OwnBuild>, Refusal>(
                ctx,
                project,
                BINDINGS_METADATA_TYPE,
                |row| {
                    row.build = build.clone();
                    Ok(build.clone())
                },
            )
            .await?
            .map(|(_, b)| b)
    }

    /// Say which of the organization's clusters its projects may put
    /// environments of their own on (ADR-0054 §2). Administrators only.
    pub async fn put_open_clusters(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        mut clusters: Vec<Uuid>,
    ) -> Result<Vec<Uuid>> {
        self.require_manage(ctx, org).await?;
        clusters.sort();
        clusters.dedup();
        for id in &clusters {
            self.check_connection(ctx, org, *id).await?;
        }
        let svc = self.service(org)?;
        self.store
            .update::<EnvironmentList, Vec<Uuid>, Refusal>(
                &svc,
                org,
                ENVIRONMENTS_METADATA_TYPE,
                |list| {
                    list.open_clusters = clusters.clone();
                    Ok(clusters.clone())
                },
            )
            .await?
            .map(|(_, open)| open)
    }

    pub async fn put_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Option<Uuid>,
        input: EnvironmentInput,
    ) -> Result<Environment> {
        self.require_manage(ctx, org).await?;
        match input.kind {
            EnvironmentKind::Kubernetes => {
                self.check_connection(ctx, org, input.connection_id).await?
            }
            EnvironmentKind::Research => {
                self.check_research_connection(ctx, org, input.connection_id)
                    .await?
            }
        }
        if let Some(registry) = input.registry_connection_id {
            self.check_registry_connection(ctx, org, org, registry, &input.registry)
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
        project: Option<Uuid>,
    ) -> Result<String> {
        // A project's own environment is tested by whoever sees it; the
        // organization's by those who manage them.
        let env = match project {
            Some(project) => self.project_environment(ctx, org, project, id).await?,
            None => {
                self.require_manage(ctx, org).await?;
                self.environment(ctx, org, id).await?
            }
        };
        let from = env.connections_from(org);
        let svc = self.service(from)?;
        if env.kind == EnvironmentKind::Research {
            let project_tenant = project;
            let project = env
                .research
                .as_ref()
                .map(|r| r.project.clone())
                .unwrap_or_default();
            let projects = self
                .own_research_api(ctx, org, project_tenant)
                .await?
                .projects()
                .await
                .map_err(|e| {
                    Refusal::Precondition("ENVIRONMENT_RESEARCH_UNREACHABLE", format!("{e:#}"))
                })?;
            return match projects.iter().find(|p| p.id == project) {
                Some(p) => Ok(format!(
                    "Constructor Research answers: your sign-in reaches project {}",
                    if p.name.is_empty() { &p.id } else { &p.name }
                )),
                None => Err(Refusal::Precondition(
                    "ENVIRONMENT_RESEARCH_PROJECT_UNKNOWN",
                    format!(
                        "'{project}' is not one of your Research projects: its owner adds you \
                         to it in Research"
                    ),
                )),
            };
        }
        let access = deploy::cluster_access(&self.hub, &svc, from, env.connection_id)
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

    /// The profile a build for `environment` takes when the caller names
    /// none: the one the project binds to it, else `prod` (the profile a new
    /// description's cluster starts with). Any profile the description
    /// declares may be bound.
    pub async fn profile_for(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
    ) -> String {
        let bound = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await
            .ok()
            .and_then(|(list, ..)| {
                list.items
                    .into_iter()
                    .find(|b| b.environment_id == environment)
                    .map(|b| b.profile)
            });
        bound.unwrap_or_else(|| "prod".to_owned())
    }

    pub async fn targets(&self, ctx: &SecurityContext, project: Uuid) -> Result<Targets> {
        let org = self.organization_of_project(ctx, project).await?;
        let project_name = self.project_name(ctx, project).await?;
        let (admitted, own) = self.visible(ctx, org, project).await?;
        let mut environments = Vec::new();
        for e in admitted.into_iter().chain(own) {
            // A namespace not assigned yet reads as none.
            let ns = self
                .place(ctx, org, project, &e)
                .await
                .map(|p| p.namespace)
                .unwrap_or_default();
            environments.push((e, ns));
        }
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
        let (admitted, own) = self.visible(ctx, org, project).await?;
        for b in &list.items {
            let env = admitted
                .iter()
                .chain(own.iter())
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
                // The secrets' keys and the project's own environments are
                // kept: they are set one by one.
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
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
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
                // A value for a gear's field the description already fills
                // would be ignored, or contradict it: not kept.
                if super::gear_overrides::field_of(&key).is_some() {
                    let (list, _) = self
                        .store
                        .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
                        .await?;
                    let installs =
                        super::infra::installs(env.boundaries.infra.as_ref(), &list.infra, None);
                    let mut keys: Vec<String> = list
                        .secrets
                        .iter()
                        .filter(|s| s.environment_id == env.id && s.key != key)
                        .map(|s| s.key.clone())
                        .chain(super::infra::produced_variables(&installs))
                        .chain(super::infra::file_variables(&installs))
                        .collect();
                    keys.push(key.clone());
                    if let Some(c) = self
                        .config_clashes(ctx, project, &keys)
                        .await
                        .into_iter()
                        .find(|c| c.key == key)
                    {
                        return Err(Refusal::Precondition(
                            c.code,
                            format!("{key} is not set: {}", c.message),
                        ));
                    }
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

    /// The project's configuration for a release of `build` in `env`: the
    /// bound profile's values, and the keys of its secrets there.
    async fn project_config(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        env: &Environment,
        profile: &str,
        build: Option<&str>,
    ) -> Result<Config> {
        let (list, _) = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?;
        // The services the build's lock resolved, placed by the project's
        // records (ADR-0065 §3). A build from before the project kept them
        // runs the records as they are (ADR-0064); one whose services are no
        // longer kept is refused rather than run with today's.
        let built = build.and_then(|b| list.built_infra.iter().find(|x| x.build == b));
        let services = match (built, build) {
            (Some(built), _) => super::infra::built_services(built, &list.infra),
            (None, Some(b))
                if !list.built_infra.is_empty() && env.kind == EnvironmentKind::Kubernetes =>
            {
                return Err(Refusal::Precondition(
                    "BUILD_INFRA_NOT_KEPT",
                    format!(
                        "the project keeps no infra services for build {b}: it is older than the \
                         {} it keeps, from before it kept them, or built outside Studio (a CI \
                         build keeps none); build the product again in Studio to deploy it",
                        super::infra::MAX_LOCKED_BUILDS
                    ),
                ));
            }
            (None, _) => list.infra.clone(),
        };
        // Infra services run on a cluster (ADR-0064); a Research
        // environment brings its own services.
        let infra = if env.kind == EnvironmentKind::Kubernetes {
            super::infra::installs(
                env.boundaries.infra.as_ref(),
                &services,
                env.previews
                    .as_ref()
                    .and_then(|s| s.ingress_class.as_deref()),
            )
        } else {
            Vec::new()
        };
        let mut secret_keys: Vec<String> = list
            .secrets
            .into_iter()
            .filter(|s| s.environment_id == env.id)
            .map(|s| s.key)
            .collect();
        // What the infra services provide reaches the product as more of
        // its configuration secrets, written by the run before the release.
        for v in super::infra::produced_variables(&infra)
            .into_iter()
            .chain(super::infra::file_variables(&infra))
        {
            if !secret_keys.contains(&v) {
                secret_keys.push(v);
            }
        }
        let mut warnings: Vec<String> = infra
            .iter()
            .flat_map(|i| super::infra::issuer_warnings(&i.service, i.install, i.shared.as_ref()))
            .map(|(code, why)| format!("{code}: {why}"))
            .collect();
        // A configuration secret that would set a gear's field over the
        // description: the description wins, or the deploy is refused.
        let clashes = self.config_clashes(ctx, project, &secret_keys).await;
        let conflict = clashes
            .iter()
            .find(|c| c.refuses())
            .map(|c| c.message.clone());
        warnings.extend(
            clashes
                .iter()
                .filter(|c| !c.refuses())
                .map(super::gear_overrides::Clash::line),
        );
        let secret_keys = super::gear_overrides::injected(secret_keys, &clashes);
        Ok(Config {
            infra,
            values: list
                .items
                .into_iter()
                .find(|b| b.profile == profile && b.environment_id == env.id)
                .and_then(|b| b.values),
            secret_keys,
            build_namespace: None,
            own: list.build,
            warnings,
            conflict,
        })
    }

    /// The configuration secrets in `secret_keys` that set a gear's config
    /// field the project's latest description also sets, and what a deploy
    /// does about each. Without a description to read there is nothing to
    /// compare: none.
    pub(super) async fn config_clashes(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        secret_keys: &[String],
    ) -> Vec<super::gear_overrides::Clash> {
        if !secret_keys
            .iter()
            .any(|k| super::gear_overrides::field_of(k).is_some())
        {
            return Vec::new();
        }
        let Ok(products) = self.hub.get::<dyn crate::product::port::ProjectProducts>() else {
            return Vec::new();
        };
        let text = match products.latest_description(ctx, project).await {
            Ok(Some(d)) => d.text,
            Ok(None) => return Vec::new(),
            Err(e) => {
                tracing::warn!(%project, error = %format!("{e:#}"), "studio-environments: the description could not be read; configuration secrets are not compared with it");
                return Vec::new();
            }
        };
        let configs = crate::product::port::gear_configs(&text);
        let provided: std::collections::BTreeSet<String> = secret_keys.iter().cloned().collect();
        super::gear_overrides::clashes(&configs, secret_keys, &provided)
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
            // The cluster pulls with the pull identity (ADR-0062 §2).
            registry_connection_id: env.pull_connection(),
            pull_uses_push_login: env.pulls_with_push_login(),
            build_namespace: config.build_namespace.clone(),
            namespace: d.namespace.clone(),
            release: d.product.clone(),
            action: d.action,
            environment_id: env.id,
            secret_keys: config.secret_keys.clone(),
            warnings: config.warnings.clone(),
            database: env.database,
            // The product's own database server runs the image its infra
            // service imported (ADR-0064 §5), else the environment's.
            database_image: super::infra::database_image(&config.infra)
                .or_else(|| env.database_image.clone()),
            infra: config.infra.clone(),
            chart,
            chart_ref: d.chart_ref.clone(),
            connections_from: env.project_id,
            values: model::deploy_values(
                env,
                &d.images,
                config.values.as_ref(),
                &config.secret_keys,
                &d.product,
                config.own.as_ref(),
            ),
            images: d
                .images
                .iter()
                .map(|i| DeployImage {
                    app: i.app.clone(),
                    image: env.image(&i.image),
                })
                .collect(),
            research: d.research.clone(),
            preview: d.preview.as_ref().map(|p| PreviewRoute {
                expires_at: p.expires_at.clone(),
                host: p.host.clone(),
                ingress_class: env.previews.as_ref().and_then(|s| s.ingress_class.clone()),
            }),
        }
    }

    /// The digest build `build` pushed `chart` as, from the project's image
    /// records (ADR-0062 §4); `None` without records, or a build that
    /// recorded none.
    async fn chart_digest(
        &self,
        org: Uuid,
        project: Uuid,
        build: &str,
        chart: &model::ChartRef,
    ) -> Option<String> {
        let records = self.records()?;
        let filter = super::records::ImageFilter {
            kind: Some(super::images::ImageKind::Chart),
            build_id: Some(build.to_owned()),
            ..Default::default()
        };
        match records.images(org, project, &filter, 0, 50).await {
            Ok((found, _)) => super::images::chart_digest(&found, chart),
            Err(e) => {
                tracing::warn!(error = ?e, %build, "studio-environments: the build's chart digest could not be read; the chart installs by its version");
                None
            }
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
        let env = self
            .project_environment(ctx, org, project, req.environment_id)
            .await?;
        if env.kind == EnvironmentKind::Research {
            if req.preview.is_some() {
                return Err(Refusal::Precondition(
                    "ENVIRONMENT_TAKES_NO_PREVIEWS",
                    format!(
                        "'{}' is a Constructor Research environment: a preview is a namespace of \
                         its own on a cluster",
                        env.name
                    ),
                ));
            }
            return self
                .request_research_deploy(ctx, org, project, &env, req)
                .await;
        }
        if env.project_id.is_some() {
            // An organization environment added after this one may give the
            // project the same namespace on the same cluster (ADR-0054 §6).
            let (admitted, _) = self.visible(ctx, org, project).await?;
            let project_name = self.project_name(ctx, project).await?;
            if let Some(taken) = model::namespace_clash(&env, &admitted, &project_name) {
                return Err(Refusal::Precondition(
                    "ENVIRONMENT_NAMESPACE_TAKEN",
                    format!(
                        "the organization's environment '{}' deploys this project into the same \
                         namespace on the same cluster: rename '{}' or change its namespace pattern",
                        taken.name, env.name
                    ),
                ));
            }
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
        let project_name = self.project_name(ctx, project).await?;
        let place = self.place(ctx, org, project, &env).await?;
        let mut namespace = place.namespace.clone();
        let id = Uuid::new_v4();
        let preview = match req.preview.take() {
            None => None,
            Some(ask) => {
                let p = self
                    .preview_for(ctx, org, project, &env, &req, &namespace, id, ask)
                    .await?;
                namespace = model::preview_namespace(&namespace, &p.name)?;
                Some(Preview {
                    host: env
                        .previews
                        .as_ref()
                        .and_then(|s| model::preview_host(s, &namespace)),
                    ..p
                })
            }
        };
        let person = self.person(ctx).await;
        let mut d = Deployment {
            id,
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
            research: None,
            preview: None,
            warnings: Vec::new(),
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
                    let chart = model::check_chart_ref(&env, &reference, &version)?;
                    model::check_chart_in_project(&chart, &place.prefix)?;
                    d.chart_ref = Some(chart);
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
            // A build's chart is installed by the digest it was pushed as,
            // which the record keeps as its sha256: the version alone may
            // since name another chart.
            if let (Some(build), Some(chart)) = (d.build.clone(), d.chart_ref.clone())
                && let Some(digest) = self.chart_digest(org, project, &build, &chart).await
            {
                d.chart_sha256 = digest.trim_start_matches("sha256:").to_owned();
                d.chart_ref = Some(model::ChartRef {
                    digest: Some(digest),
                    ..chart
                });
            }
            // Only images under the project's own path (ADR-0062 §4).
            d.images = req
                .images
                .into_iter()
                .map(|i| {
                    model::project_image(&env, &place.prefix, &i.image)
                        .map(|image| DeployImage { app: i.app, image })
                })
                .collect::<std::result::Result<_, _>>()
                .map_err(|e| Refusal::Precondition("IMAGE_NOT_IN_PROJECT_PATH", e.reason))?;
            // A preview is how a release is tried before it is promoted.
            if preview.is_none() {
                self.check_promoted(ctx, org, &env, &d).await?;
            }
        }
        d.preview = preview;
        if d.action == DeploymentAction::Install {
            let mut at = place.clone();
            at.namespace = d.namespace.clone();
            self.check_cluster_ready(org, project, &env, &at, env.pull_connection(), false)
                .await?;
        }
        let mut config = self
            .project_config(ctx, project, &env, &d.profile, d.build.as_deref())
            .await?;
        config.build_namespace = Some(place.build_namespace.clone());
        if d.action == DeploymentAction::Install {
            self.check_infra(&env, &place.prefix, &config.infra)?;
        }
        d.warnings = config.warnings.clone();
        let previewing = d.preview.is_some();
        let d = self.submit(org, &env, d, chart, config).await?;
        if previewing {
            self.keep_sweeping(org).await;
        }
        Ok(d)
    }

    /// The preview `ask` describes, checked against the environment and the
    /// project's live previews there; its host is the caller's to add once
    /// the namespace is known.
    #[allow(clippy::too_many_arguments)]
    async fn preview_for(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        env: &Environment,
        req: &DeployRequest,
        base: &str,
        id: Uuid,
        ask: PreviewAsk,
    ) -> Result<Preview> {
        let Some(settings) = &env.previews else {
            return Err(Refusal::Precondition(
                "ENVIRONMENT_TAKES_NO_PREVIEWS",
                format!(
                    "environment '{}' takes no previews: an administrator turns them on in its \
                     settings",
                    env.name
                ),
            ));
        };
        if req.action != DeploymentAction::Install {
            return Err(Refusal::Invalid(
                "a preview installs a release: remove a preview rather than uninstall it".into(),
            ));
        }
        let name = model::preview_name(ask.name.as_deref(), id)?;
        model::preview_namespace(base, &name)?;
        let ttl = ask.ttl_hours.unwrap_or(settings.ttl_hours);
        if ttl == 0 || ttl > settings.ttl_hours {
            return Err(Refusal::Invalid(format!(
                "a preview in '{}' lives from 1 to {} hours",
                env.name, settings.ttl_hours
            )));
        }
        let history = self
            .deployments(ctx, org, Some(project), Some(env.id))
            .await?;
        if let Some(why) = model::preview_refusal(settings, &history, project, env.id, &name) {
            return Err(Refusal::Precondition("PREVIEW_REFUSED", why));
        }
        let expires_at = (time::OffsetDateTime::now_utc() + time::Duration::hours(i64::from(ttl)))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        Ok(Preview {
            name,
            expires_at,
            host: None,
            connection_id: env.connection_id,
            connections_from: env.project_id,
            removed_at: None,
            removal_error: None,
        })
    }

    /// Make sure the organization's previews are swept: one schedule each,
    /// in the platform tenant, naming it. Best effort: a preview whose sweep
    /// is not scheduled can still be removed by hand, and the next preview
    /// asks again.
    async fn keep_sweeping(&self, org: Uuid) {
        let Ok(schedules) = self.hub.get::<dyn crate::scheduler::port::Schedules>() else {
            tracing::warn!("studio-environments: no scheduler here; previews expire only by hand");
            return;
        };
        let ensured = match self.service(org) {
            Ok(svc) => {
                schedules
                    .ensure(
                        &svc,
                        crate::scheduler::port::ScheduleSpec {
                            // Names are unique, and every schedule lives in
                            // the platform's tenant: the organization makes
                            // it one.
                            name: format!("Remove the expired previews of {org}"),
                            task_type: preview::SWEEP_TASK_TYPE,
                            payload: serde_json::json!({ "organization_id": org }),
                            cron: preview::SWEEP_CRON.to_owned(),
                            enabled: true,
                        },
                    )
                    .await
            }
            Err(e) => Err(anyhow::anyhow!("{e:?}")),
        };
        if let Err(e) = ensured {
            tracing::warn!(error = ?e, organization = %org, "studio-environments: the preview sweep could not be scheduled");
        }
    }

    /// Remove a preview of `project` now: queue a sweep of it alone. The
    /// record says it is gone once the namespace is.
    pub async fn remove_preview(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        id: Uuid,
    ) -> Result<Uuid> {
        let org = self.organization_of_project(ctx, project).await?;
        let d = self.deployment(ctx, org, id).await?;
        if d.project_id != project || d.preview.is_none() {
            return Err(Refusal::NotFound(
                id.to_string(),
                format!("the project has no preview {id}"),
            ));
        }
        if !d.is_live_preview() {
            return Err(Refusal::Precondition(
                "PREVIEW_ALREADY_REMOVED",
                format!("preview {} is already removed", d.namespace),
            ));
        }
        let queue = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                Refusal::Unavailable("background runs are not available in this deployment".into())
            })?;
        let svc = self.service(org)?;
        let partition = format!("previews:{org}");
        queue
            .enqueue(
                &svc,
                crate::tasks::sdk::NewRun {
                    tenant: org,
                    task_type: preview::SWEEP_TASK_TYPE,
                    payload: serde_json::to_value(SweepPayload {
                        organization_id: org,
                        deployment_id: Some(id),
                    })
                    .map_err(anyhow::Error::from)?,
                    // After any sweep already going, so the two do not
                    // delete the same namespace at once.
                    partition_key: Some(&partition),
                    idempotency_key: None,
                    coalesce_queued: true,
                    notify_workspace_id: None,
                },
            )
            .await
            .map_err(|e| Refusal::Unavailable(format!("the removal could not be queued: {e:#}")))
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
            preview: req.preview,
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
            preview: req.preview,
        })
    }

    /// Propose the build workflow to the project's repository, as a pull
    /// request: it builds `profile` and publishes under `environment`'s
    /// registry prefix (ADR-0048 §5).
    /// Where the project's product description is, as its product record
    /// says: the recorded path, else `products/<product_id>/product.gdl`.
    /// Refused when the project has no product.
    async fn saved_product_file(&self, ctx: &SecurityContext, project: Uuid) -> Result<String> {
        let products = self
            .hub
            .get::<dyn crate::product::port::ProjectProducts>()
            .map_err(|_| {
                Refusal::Unavailable("products are not available in this deployment".into())
            })?;
        products
            .saved_description(ctx, &project.to_string())
            .await
            .map_err(|e| Refusal::Internal(format!("{e:#}")))?
            .map(|s| s.path)
            .ok_or_else(no_saved_product)
    }

    pub async fn propose_workflow(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
        profile: &str,
        product_file: Option<&str>,
    ) -> Result<WorkflowProposal> {
        let product_file = match product_file.map(str::trim).filter(|f| !f.is_empty()) {
            Some(f) => f.trim_start_matches("./").to_owned(),
            None => self.saved_product_file(ctx, project).await?,
        };
        if !workflow::is_product_file(&product_file) {
            return Err(Refusal::Invalid(format!(
                "'{product_file}' is not a product description in the repository"
            )));
        }
        let org = self.organization_of_project(ctx, project).await?;
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
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
        // The pipeline pushes under the project's own path (ADR-0062 §2).
        let slug = self.slug(ctx, org, project).await?;
        let params = workflow::Params {
            product_file: product_file.clone(),
            product,
            profile: profile.trim().to_owned(),
            prefix: super::images::project_prefix(&env.registry, &slug),
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
    /// is recorded as running now, as the member who asked. With `dry_run`,
    /// nothing starts: the plan says what would, and what would refuse it.
    #[allow(clippy::too_many_arguments)]
    pub async fn request_build(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
        profile: &str,
        product_file: Option<&str>,
        git_ref: Option<String>,
        dry_run: bool,
    ) -> Result<BuildAsked> {
        // A build is the code at a ref and a description revision (ADR-0053
        // §2): the latest revision Studio keeps, laid at its path. Without
        // one, naming neither builds what the Product step last wrote, where
        // it wrote it -- of a `product/…` branch only the file (§4).
        let products = self
            .hub
            .get::<dyn crate::product::port::ProjectProducts>()
            .ok();
        let description = match &products {
            Some(products) => products
                .latest_description(ctx, project)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(%project, error = %format!("{e:#}"), "studio-environments: the description revision could not be read; the build reads the checkout's");
                    None
                }),
            None => None,
        };
        let saved = match (&products, product_file.is_none()) {
            // A read that failed is not "never saved": say why rather than
            // answer PRODUCT_NOT_SAVED.
            (Some(products), true) => products
                .saved_description(ctx, &project.to_string())
                .await
                .map_err(saved_description_unreadable)?,
            _ => None,
        };
        let product_file = product_file
            .map(str::to_owned)
            .or_else(|| description.as_ref().and_then(|d| d.path.clone()))
            .or_else(|| saved.as_ref().map(|s| s.path.clone()))
            .ok_or_else(no_saved_product)?;
        let git_ref = match &description {
            Some(_) => git_ref,
            None => git_ref.or_else(|| saved.and_then(|s| s.branch)),
        };
        let org = self.organization_of_project(ctx, project).await?;
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
        let research = env.kind == EnvironmentKind::Research;
        // How the project builds (ADR-0054 §7): on gears, or the
        // repository's own Dockerfiles and chart.
        let own = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0
            .build;
        if own.is_some() && research {
            return Err(Refusal::Precondition(
                "OWN_BUILD_NOT_IN_RESEARCH",
                "a build of the repository's own Dockerfiles runs in a cluster environment; \
                 Constructor Research builds a product on gears for now"
                    .into(),
            ));
        }
        let registry_connection_id = match env.registry_connection_id {
            Some(id) => id,
            // Research keeps the images it builds (ADR-0049 §3).
            None if research => Uuid::nil(),
            None => {
                return Err(Refusal::Precondition(
                    "ENVIRONMENT_HAS_NO_REGISTRY",
                    format!(
                        "environment '{}' has no registry login: a build pushes its images there",
                        env.name
                    ),
                ));
            }
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
        // Each project source the description uses (ADR-0060 §3): a dev
        // build takes its branch and records the commit it got; a protected
        // environment builds only the commits the revision pinned at save.
        let refs = if research || own.is_some() {
            crate::product::port::SourceRefs::default()
        } else {
            match &description {
                Some(d) => crate::product::port::build_refs(
                    d.sources_lock.as_ref(),
                    &d.planned,
                    env.protected,
                )
                .map_err(|why| Refusal::Precondition("REVISION_NOT_PINNED", why))?,
                None if env.protected => {
                    return Err(Refusal::Precondition(
                        "REVISION_NOT_PINNED",
                        format!(
                            "environment '{}' is protected: it builds only a description \
                             revision Studio keeps, with its sources pinned -- save the \
                             product first",
                            env.name
                        ),
                    ));
                }
                None => crate::product::port::SourceRefs::default(),
            }
        };
        let git_ref = match (&refs.home, env.protected) {
            (Some(pinned), true) => {
                if git_ref.as_deref().is_some_and(|r| r != pinned) {
                    tracing::info!(%project, environment = %env.name, "studio-environments: a protected build takes the revision's pinned commit, not the ref asked for");
                }
                Some(pinned.clone())
            }
            _ => git_ref,
        };
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
        if research {
            let slug = self.slug(ctx, org, project).await?;
            let namespace = model::namespace_for(&env.namespace_pattern, &slug, &env.name)?;
            if dry_run {
                return Ok(BuildAsked::Planned(Box::new(BuildPlan {
                    environment_id: env.id,
                    environment: env.name.clone(),
                    profile,
                    product_file,
                    description_revision: description.as_ref().map(|d| d.revision),
                    strictness: env.strictness().as_str().to_owned(),
                    namespace: namespace.clone(),
                    build_namespace: namespace,
                    builder_image: String::new(),
                    builder_pinned: true,
                    gearbox_version: None,
                    registry_prefix: String::new(),
                    image_repositories: Vec::new(),
                    chart_repository: String::new(),
                    sources: vec![PlanSource {
                        id: "home".into(),
                        repository: target.repo.clone(),
                        git_ref: git_ref
                            .clone()
                            .unwrap_or_else(|| target.base_branch.clone()),
                        connection_id: Some(connection_id),
                        ..PlanSource::default()
                    }],
                    warnings: vec![
                        "Constructor Research builds and keeps the images itself".into(),
                    ],
                    warning_codes: Vec::new(),
                    refusal: None,
                })));
            }
            return self
                .request_research_build(
                    ctx,
                    org,
                    project,
                    &env,
                    profile,
                    product_file,
                    build::RepoRef {
                        tenant: target.tenant,
                        connection_id,
                        repo: target.repo.clone(),
                        branch: target.base_branch.clone(),
                    },
                    git_ref,
                    namespace,
                    description,
                )
                .await
                .map(BuildAsked::Started);
        }
        let repo = build::RepoRef {
            tenant: target.tenant,
            connection_id,
            repo: target.repo.clone(),
            branch: target.base_branch.clone(),
        };
        // Each check a run would fail on, in order. A plan collects the first
        // refusal and says what it can of the rest; a build stops at it.
        let mut refusal: Option<Refusal> = None;
        let mut refuse = |r: Refusal| {
            if refusal.is_none() {
                refusal = Some(r);
            }
        };
        let builder = match build::builder_for(&env) {
            Ok(b) => Some(b),
            Err((code, why)) => {
                refuse(Refusal::Precondition(code, why));
                None
            }
        };
        // The product signs its people in with an IdP of its own (ADR-0062 §9).
        if let Some(d) = &description
            && let Some((code, why)) = super::preflight::platform_idp_refusal(
                &d.text,
                super::preflight::studio_issuer().as_deref(),
            )
        {
            refuse(Refusal::Precondition(code, why));
        }
        let place = match self.place(ctx, org, project, &env).await {
            Ok(p) => Some(p),
            Err(e) => {
                refuse(e);
                None
            }
        };
        // Every connection the run reads, read now as it will read them, and
        // the cluster asked: a build that cannot start says why here.
        let source_label = match self.check_source_readable(org, &repo).await {
            Ok(l) => l,
            Err(e) => {
                refuse(e);
                String::new()
            }
        };
        if let Some(place) = &place
            && let Err(e) = self
                .check_cluster_ready(
                    org,
                    project,
                    &env,
                    place,
                    Some(registry_connection_id),
                    true,
                )
                .await
        {
            refuse(e);
        }
        let description_revision = description.as_ref().map(|d| d.revision);
        if dry_run {
            let am = self.store.am().as_ref();
            let reader = self.service(org)?;
            let home = connectors::connection_by_id(am, &reader, repo.tenant, connection_id).await;
            let home_source = PlanSource {
                id: "home".into(),
                repository: repo.repo.clone(),
                git_ref: git_ref.clone().unwrap_or_else(|| repo.branch.clone()),
                commit: None,
                connection_id: Some(connection_id),
                connection_label: Some(source_label).filter(|l| !l.is_empty()),
                connection_scope: home.as_ref().map(|(_, c)| c.scope.clone()),
                connection_holder: home
                    .as_ref()
                    .map(|(at, c)| connectors::holder_of_row(c, *at)),
            };
            let mut sources = vec![home_source.clone()];
            for (id, at) in &refs.git {
                let pinned = at.len() >= 7 && at.bytes().all(|b| b.is_ascii_hexdigit());
                sources.push(PlanSource {
                    id: id.clone(),
                    repository: id.clone(),
                    git_ref: at.clone(),
                    commit: pinned.then(|| at.clone()),
                    ..home_source.clone()
                });
            }
            let prefix = place.as_ref().map(|p| p.prefix.clone()).unwrap_or_default();
            let image_repositories = match &own {
                Some(o) => o
                    .images
                    .iter()
                    .map(|i| format!("{prefix}/{}", i.name))
                    .collect(),
                None => vec![format!("{prefix}/<each application Gearbox names>")],
            };
            let mut warnings = env.warnings();
            if let Some(d) = &description {
                warnings.extend(super::preflight::unreachable_issuers(&self.http, &d.text).await);
            }
            if builder.as_ref().is_some_and(|b| !b.pinned) {
                warnings.push(
                    "the builder image names no digest: taken only because this stand allows it"
                        .into(),
                );
            }
            let refusal = refusal.map(|r| match r {
                Refusal::Precondition(code, why) => (code.to_owned(), why),
                Refusal::Forbidden(code) => (code.to_owned(), code.to_owned()),
                Refusal::NotFound(_, why) => ("NOT_FOUND".to_owned(), why),
                Refusal::Invalid(why) => ("INVALID".to_owned(), why),
                Refusal::Unavailable(why) => ("UNAVAILABLE".to_owned(), why),
                Refusal::Conflict(code, why) => (code.to_owned(), why),
                Refusal::Internal(why) => ("INTERNAL".to_owned(), why),
            });
            return Ok(BuildAsked::Planned(Box::new(BuildPlan {
                environment_id: env.id,
                environment: env.name.clone(),
                profile,
                product_file,
                description_revision,
                strictness: env.strictness().as_str().to_owned(),
                namespace: place
                    .as_ref()
                    .map(|p| p.namespace.clone())
                    .unwrap_or_default(),
                build_namespace: place
                    .as_ref()
                    .map(|p| p.build_namespace.clone())
                    .unwrap_or_default(),
                builder_image: builder
                    .as_ref()
                    .map(|b| b.image.clone())
                    .unwrap_or_default(),
                builder_pinned: builder.as_ref().is_some_and(|b| b.pinned),
                gearbox_version: builder.and_then(|b| b.gearbox_version),
                chart_repository: format!("oci://{prefix}/charts"),
                registry_prefix: prefix,
                image_repositories,
                sources,
                warnings,
                warning_codes: env.warning_codes(),
                refusal,
            })));
        }
        if let Some(r) = refusal {
            return Err(r);
        }
        let (Some(builder), Some(place)) = (builder, place) else {
            return Err(Refusal::Internal("the build's place was not found".into()));
        };
        let build_id = format!("studio-{}", &Uuid::new_v4().simple().to_string()[..12]);
        let person = self.person(ctx).await;
        let record_place = crate::artifact_ingest::port::BuildPlace {
            environment_id: Some(env.id.to_string()),
            environment: Some(env.name.clone()),
            // Where it ran: the build namespace (ADR-0062 §7).
            namespace: Some(place.build_namespace.clone()),
            git_ref: git_ref.clone().or_else(|| Some(repo.branch.clone())),
            source_connection_id: Some(connection_id.to_string()),
            source_connection: Some(source_label).filter(|l| !l.is_empty()),
            builder_image: Some(builder.image.clone()),
            gearbox_version: builder.gearbox_version.clone(),
            source_commits: None,
        };
        let payload = build::BuildPayload {
            build_id: build_id.clone(),
            organization_id: org,
            project_id: project,
            connection_id: env.connection_id,
            registry_connection_id,
            namespace: place.namespace.clone(),
            // The project's own path (ADR-0062 §2).
            prefix: place.prefix.clone(),
            profile: profile.clone(),
            product_file,
            repo,
            git_ref,
            builder_image: builder.image,
            builder_registry_connection_id: builder.pull_connection_id,
            build_namespace: Some(place.build_namespace.clone()),
            pull_registry_connection_id: env.boundaries.registry_pull_connection_id,
            labels: build::image_labels(&now(), project, &build_id, description_revision),
            requested_by: Some(person.id),
            environment_id: Some(env.id),
            buildkit_image: build::buildkit_image(),
            records_in: Some(ctx.subject_tenant_id()),
            description_revision,
            description_text: description.map(|d| d.text),
            connections_from: env.project_id,
            own,
            source_refs: refs.git,
            strictness: Some(env.strictness().as_str().to_owned()),
        };
        if let Ok(builds) = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
        {
            let mut running = crate::artifact_ingest::port::BuildOutcome::running(
                &build_id,
                &target.repo,
                &profile,
            );
            running.description_revision = payload.description_revision;
            running.place = record_place;
            builds
                .record(ctx, &project.to_string(), &running)
                .await
                .map_err(|e| Refusal::Internal(format!("{e:#}")))?;
        }
        let run_id = build::enqueue(
            &self.hub,
            org,
            build::TASK_TYPE,
            serde_json::to_value(&payload).map_err(anyhow::Error::from)?,
            &format!("build:{}", place.build_namespace),
            &build_id,
        )
        .await
        .map_err(|e| Refusal::Unavailable(format!("the build could not be queued: {e:#}")))?;
        Ok(BuildAsked::Started(BuildStarted {
            build_id,
            run_id,
            namespace: place.build_namespace,
        }))
    }

    /* ── Constructor Research (ADR-0049) ── */

    /// The caller's own Research sign-in. A Research environment runs every
    /// build, deploy and read with the sign-in of the member who asks
    /// (ADR-0049 §1): Research's access keys are personal, and a project there
    /// is shared by adding its members, so nobody runs on another's sign-in.
    /// Looked for from the operation's project first (a member may keep their
    /// sign-in there), then the organization, then the caller's own tenant.
    async fn own_research(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Option<Uuid>,
    ) -> Result<research::SignIn> {
        let am = self.store.am().as_ref();
        let from: Vec<Uuid> = project
            .into_iter()
            .chain([org, ctx.subject_tenant_id()])
            .collect();
        connectors::own_connection(am, ctx, &from, connectors::RESEARCH_PROVIDER)
            .await
            .map(|(tenant, c)| research::SignIn {
                tenant,
                connection_id: c.id,
            })
            .ok_or_else(|| {
                Refusal::Precondition(
                    "ENVIRONMENT_RESEARCH_NOT_SIGNED_IN",
                    "a Research environment runs with your own sign-in to Constructor \
                     Research: sign in under Connections, \"Sign in with Constructor\", first"
                        .to_owned(),
                )
            })
    }

    /// The Research connector's calls with the caller's own sign-in.
    async fn own_research_api(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Option<Uuid>,
    ) -> Result<crate::connectors::sdk::research::ResearchApi> {
        let sign_in = self.own_research(ctx, org, project).await?;
        self.research_api(ctx, sign_in.tenant, sign_in.connection_id)
            .await
    }

    /// The Research connector's calls through a connection, as the caller:
    /// a member's own sign-in is readable only by them (ADR-0049 §5).
    async fn research_api(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection_id: Uuid,
    ) -> Result<crate::connectors::sdk::research::ResearchApi> {
        research::api(&self.hub, ctx, org, connection_id, None)
            .await
            .map_err(|e| Refusal::Precondition("ENVIRONMENT_RESEARCH_UNUSABLE", format!("{e:#}")))
    }

    /// The Research projects a connection of the organization may run
    /// products in: what an administrator picks a Research environment from.
    pub async fn research_projects(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection_id: Uuid,
    ) -> Result<Vec<crate::connectors::sdk::research::Project>> {
        self.require_manage(ctx, org).await?;
        self.research_api(ctx, org, connection_id)
            .await?
            .projects()
            .await
            .map_err(|e| {
                Refusal::Precondition("ENVIRONMENT_RESEARCH_UNREACHABLE", format!("{e:#}"))
            })
    }

    /// The hardware configurations of a Research project.
    pub async fn research_hardware(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection_id: Uuid,
        project: &str,
    ) -> Result<Vec<crate::connectors::sdk::research::Hardware>> {
        self.require_manage(ctx, org).await?;
        self.research_api(ctx, org, connection_id)
            .await?
            .hardware(project)
            .await
            .map_err(|e| {
                Refusal::Precondition("ENVIRONMENT_RESEARCH_UNREACHABLE", format!("{e:#}"))
            })
    }

    /// A build Studio prepares and Constructor Research compiles.
    #[allow(clippy::too_many_arguments)]
    async fn request_research_build(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        env: &Environment,
        profile: String,
        product_file: String,
        repo: build::RepoRef,
        git_ref: Option<String>,
        application: String,
        description: Option<crate::product::port::DescriptionRevision>,
    ) -> Result<BuildStarted> {
        let target = env.research.as_ref().ok_or_else(|| {
            Refusal::Precondition(
                "ENVIRONMENT_RESEARCH_UNUSABLE",
                format!("environment '{}' names no Research project", env.name),
            )
        })?;
        let build_id = format!("research-{}", &Uuid::new_v4().simple().to_string()[..12]);
        // The build bakes in what the chart mounts, so it renders the chart
        // with the values the deploy will (ADR-0049 §3).
        let config = self
            .project_config(ctx, project, env, &profile, None)
            .await?;
        let payload = research::ResearchBuildPayload {
            namespace: application.clone(),
            values: config.values,
            secret_keys: config.secret_keys,
            database_image: env.database_image.clone(),
            build_id: build_id.clone(),
            organization_id: org,
            project_id: project,
            connection_id: env.connection_id,
            sign_in: Some(self.own_research(ctx, org, Some(project)).await?),
            research_project: target.project.clone(),
            profile: profile.clone(),
            product_file,
            repo: repo.clone(),
            git_ref,
            records_in: Some(ctx.subject_tenant_id()),
            description_revision: description.as_ref().map(|d| d.revision),
            description_text: description.map(|d| d.text),
            requested_by: Some(research::Requester::of(ctx)),
        };
        if let Ok(builds) = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
        {
            let mut running = crate::artifact_ingest::port::BuildOutcome::running(
                &build_id, &repo.repo, &profile,
            );
            running.r#where = Some("research".into());
            running.description_revision = payload.description_revision;
            builds
                .record(ctx, &project.to_string(), &running)
                .await
                .map_err(|e| Refusal::Internal(format!("{e:#}")))?;
        }
        let run_id = build::enqueue(
            &self.hub,
            org,
            research::BUILD_TASK_TYPE,
            serde_json::to_value(&payload).map_err(anyhow::Error::from)?,
            &format!("research-build:{application}"),
            &build_id,
        )
        .await
        .map_err(|e| Refusal::Unavailable(format!("the build could not be queued: {e:#}")))?;
        Ok(BuildStarted {
            build_id,
            run_id,
            namespace: application,
        })
    }

    /// A deploy to a Research environment: a build made there, put as the
    /// project's application in the environment's Research project.
    async fn request_research_deploy(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        env: &Environment,
        req: DeployRequest,
    ) -> Result<Deployment> {
        let target = env.research.clone().ok_or_else(|| {
            Refusal::Precondition(
                "ENVIRONMENT_RESEARCH_UNUSABLE",
                format!("environment '{}' names no Research project", env.name),
            )
        })?;
        let build_id = match (req.redeploy_of, &req.build) {
            (Some(earlier), _) => self
                .deployment(ctx, org, earlier)
                .await?
                .build
                .ok_or_else(|| Refusal::Invalid(format!("deployment {earlier} names no build")))?,
            (None, Some(b)) => b.trim().to_owned(),
            (None, None) if req.action == DeploymentAction::Uninstall => String::new(),
            (None, None) => {
                return Err(Refusal::Invalid(
                    "a deploy to Constructor Research names a build made there".into(),
                ));
            }
        };
        let files = self
            .hub
            .get::<dyn crate::product::port::ProjectFiles>()
            .map_err(|_| {
                Refusal::Unavailable(
                    "the project's repository is not available in this deployment".into(),
                )
            })?;
        let target_repo = files
            .repository(ctx, &project.to_string())
            .await
            .map_err(|e| Refusal::Invalid(format!("{e:#}")))?;
        let repo = build::RepoRef {
            tenant: target_repo.tenant,
            connection_id: target_repo.connection_id.ok_or_else(|| {
                Refusal::Precondition(
                    "REPOSITORY_HAS_NO_CONNECTION",
                    "the project's repository is reached through no connection the server can use"
                        .into(),
                )
            })?,
            repo: target_repo.repo,
            branch: target_repo.base_branch,
        };
        let product_file = match self.saved_product_file(ctx, project).await {
            Ok(f) => f,
            // An uninstall reads no description: the product's own path does.
            Err(_) if req.action == DeploymentAction::Uninstall => {
                crate::product::port::product_gdl_path(req.product.trim())
            }
            Err(e) => return Err(e),
        };

        let mut images = Vec::new();
        let mut product = req.product.trim().to_owned();
        let mut profile = req.profile.trim().to_owned();
        let (mut commit, mut lock_hash) = (None, None);
        if req.action == DeploymentAction::Install {
            let builds = self
                .hub
                .get::<dyn crate::artifact_ingest::port::BuildRecords>()
                .map_err(|_| {
                    Refusal::Unavailable("builds are not available in this deployment".into())
                })?;
            let b = builds
                .build(ctx, &project.to_string(), &build_id)
                .await
                .map_err(|e| Refusal::Internal(format!("{e:#}")))?
                .ok_or_else(|| {
                    Refusal::NotFound(
                        build_id.clone(),
                        format!("the project has no build {build_id}"),
                    )
                })?;
            if b.r#where.as_deref() != Some("research") {
                return Err(Refusal::Precondition(
                    "BUILD_NOT_MADE_IN_RESEARCH",
                    format!(
                        "build {build_id} was not made in Constructor Research, which runs only \
                         images it built"
                    ),
                ));
            }
            if b.status != "passed" {
                return Err(Refusal::Precondition(
                    "BUILD_NOT_PASSED",
                    format!("build {build_id} is {}, not passed", b.status),
                ));
            }
            images = b
                .images
                .into_iter()
                .map(|(app, image)| DeployImage { app, image })
                .collect();
            if product.is_empty() {
                product = b.product.unwrap_or_default();
            }
            if profile.is_empty() {
                profile = b.profile.unwrap_or_default();
            }
            commit = b.commit;
            lock_hash = b.lock_hash;
        }
        let product = Self::release_name(&product)?;
        let project_name = self.project_name(ctx, project).await?;
        let namespace = model::namespace_for(&env.namespace_pattern, &project_name, &env.name)?;
        let person = self.person(ctx).await;
        let d = Deployment {
            id: Uuid::new_v4(),
            project_id: project,
            project_name,
            environment_id: env.id,
            environment_name: env.name.clone(),
            profile: profile.clone(),
            product,
            action: req.action,
            redeploy_of: req.redeploy_of,
            commit: commit.clone(),
            lock_hash,
            build: (!build_id.is_empty()).then_some(build_id),
            images,
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
            preview: None,
            warnings: Vec::new(),
            research: Some(research::ResearchDeploy {
                research_project: target.project,
                hardware: target.hardware,
                repo,
                product_file,
                profile,
                commit: commit.unwrap_or_default(),
                requested_by: Some(research::Requester::of(ctx)),
                sign_in: Some(self.own_research(ctx, org, Some(project)).await?),
            }),
        };
        if d.action == DeploymentAction::Install {
            self.check_promoted(ctx, org, env, &d).await?;
        }
        let config = self
            .project_config(ctx, project, env, &d.profile, d.build.as_deref())
            .await?;
        self.submit(org, env, d, None, config).await
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
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
        let Some(connection) = env.registry_connection_id else {
            return Err(Refusal::Precondition(
                "ENVIRONMENT_HAS_NO_REGISTRY",
                format!("environment '{}' has no registry login", env.name),
            ));
        };
        // Only under the project's own path (ADR-0062 §2).
        let place = self.place(ctx, org, project, &env).await?;
        let paths = model::push_paths(&place.prefix, &repositories)?;
        let from = env.connections_from(org);
        let svc = self.service(from)?;
        let access = deploy::registry_access(&self.hub, &svc, from, connection)
            .await
            .map_err(|e| Refusal::Invalid(format!("{e:#}")))?;
        let (token, expires_in) = access
            .push_token(&self.http, &paths)
            .await
            .map_err(|e| Refusal::Unavailable(format!("{e:#}")))?;
        Ok(PushToken {
            registry: access.host.clone(),
            prefix: place.prefix,
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
        config.check(d.action)?;
        if env.protected {
            d.state = DeploymentState::AwaitingApproval;
            // A published chart is named on the record; only an uploaded one
            // has to be kept until the decision.
            d.pending_chart = chart;
            // One request waits for a decision; a second of the same release
            // would be a second install once both are approved.
            let svc = self.service(org)?;
            self.store
                .update::<DeploymentList, (), Refusal>(
                    &svc,
                    org,
                    DEPLOYMENTS_METADATA_TYPE,
                    |list| {
                        if let Some(waiting) = list.waiting_like(&d) {
                            return Err(already_waiting(waiting));
                        }
                        list.record(d.clone());
                        Ok(())
                    },
                )
                .await??;
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
            let env = self
                .project_environment(ctx, org, d.project_id, d.environment_id)
                .await?;
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
                .project_config(&svc, d.project_id, &env, &d.profile, d.build.as_deref())
                .await
            {
                Ok(c) => c,
                Err(_) => {
                    self.project_config(ctx, d.project_id, &env, &d.profile, d.build.as_deref())
                        .await?
                }
            };
            config.check(d.action)?;
            d.state = DeploymentState::Queued;
            d.warnings = config.warnings.clone();
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
        let env = self
            .project_environment(ctx, org, d.project_id, d.environment_id)
            .await?;
        if let (EnvironmentKind::Research, Some(target)) = (env.kind, &env.research) {
            let api = self.own_research_api(ctx, org, Some(d.project_id)).await?;
            let rollout = research::rollout(&api, &target.project, &d.namespace)
                .await
                .map_err(|e| {
                    Refusal::Precondition("ENVIRONMENT_RESEARCH_UNREACHABLE", format!("{e:#}"))
                })?;
            let mut d = d;
            d.pending_chart = None;
            return Ok((d, rollout));
        }
        // The member asked through a deployment they can see; the cluster is
        // read as the service, which can read the connection: the
        // organization's, or the project's for its own environment.
        let from = env.connections_from(org);
        let svc = self.service(from)?;
        let access = deploy::cluster_access(&self.hub, &svc, from, env.connection_id)
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

    /// The end of each container's log of a deployed release, read from its
    /// cluster now, as `status` reads the rollout.
    pub async fn logs(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
        lines: i64,
    ) -> Result<Vec<deploy::ContainerLog>> {
        let d = self.deployment(ctx, org, id).await?;
        let env = self
            .project_environment(ctx, org, d.project_id, d.environment_id)
            .await?;
        if let (EnvironmentKind::Research, Some(target)) = (env.kind, &env.research) {
            let api = self.own_research_api(ctx, org, Some(d.project_id)).await?;
            let lines = usize::try_from(lines.clamp(1, deploy::LOG_LINES_MAX)).unwrap_or(200);
            return research::logs(&api, &target.project, &d.namespace, lines)
                .await
                .map_err(|e| {
                    Refusal::Precondition("ENVIRONMENT_RESEARCH_UNREACHABLE", format!("{e:#}"))
                });
        }
        let from = env.connections_from(org);
        let svc = self.service(from)?;
        let access = deploy::cluster_access(&self.hub, &svc, from, env.connection_id)
            .await
            .map_err(|e| Refusal::Precondition("ENVIRONMENT_CLUSTER_UNUSABLE", format!("{e:#}")))?;
        deploy::logs(&access, &d.namespace, &d.product, lines)
            .await
            .map_err(|e| Refusal::Precondition("ENVIRONMENT_CLUSTER_UNREACHABLE", format!("{e:#}")))
    }

    /// A build Studio runs, step by step with the end of each step's log, as
    /// its pod has them now. The build must be one of the project's the
    /// caller can see; its pod is looked for in the project's namespace of
    /// each environment the project may use, the build not naming which.
    pub async fn build_log(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        build_id: &str,
    ) -> Result<BuildLog> {
        let records = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
            .map_err(|_| {
                Refusal::Unavailable("builds are not available in this deployment".into())
            })?;
        let missing = || {
            Refusal::NotFound(
                build_id.to_owned(),
                format!("project {project} has no build {build_id}"),
            )
        };
        let record = records
            .build(ctx, &project.to_string(), build_id)
            .await
            .map_err(|e| Refusal::Internal(format!("{e:#}")))?
            .ok_or_else(missing)?;
        // A build that failed as it started never had a pod: its record
        // says why, and is the whole log.
        if let Some(log) = start_failure_log(&record) {
            return Ok(log);
        }
        let org = self.organization_of_project(ctx, project).await?;
        let mut unreachable = None;
        let (admitted, own) = self.visible(ctx, org, project).await?;
        let ran_in = record.place.environment_id.clone();
        for env in admitted.into_iter().chain(own) {
            if ran_in.as_deref().is_some_and(|id| id != env.id.to_string()) {
                continue;
            }
            let from = env.connections_from(org);
            let svc = self.service(from)?;
            // Where it ran, as its record says; else the project's build
            // namespace there, then its namespace (a build from before
            // builds had their own).
            let namespace = match record.place.namespace.clone() {
                Some(ns) => ns,
                None => match self.place(ctx, org, project, &env).await {
                    Ok(p) => p.namespace,
                    Err(_) => continue,
                },
            };
            let found = match deploy::cluster_access(&self.hub, &svc, from, env.connection_id).await
            {
                Ok(access) => match access.client().await {
                    Ok(client) => build::step_logs(&client, &namespace, build_id).await,
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            };
            match found {
                Ok(Some(steps)) => {
                    return Ok(BuildLog {
                        environment: env.name,
                        namespace,
                        steps,
                    });
                }
                Ok(None) => {}
                Err(e) => unreachable = Some(format!("{}: {e:#}", env.name)),
            }
        }
        Err(match unreachable {
            Some(why) => Refusal::Precondition("ENVIRONMENT_CLUSTER_UNREACHABLE", why),
            None => Refusal::NotFound(
                build_id.to_owned(),
                format!(
                    "build {build_id} has no pod left in any of the project's environments: \
                     a build's pod is kept for a day after it ends"
                ),
            ),
        })
    }
}

/// The log of a build that failed as it started (`failure_step` `start`):
/// one failed `start` step whose log is the reason its record keeps. `None`
/// for any other build, whose log is its pod's.
fn start_failure_log(record: &crate::artifact_ingest::port::BuildRecord) -> Option<BuildLog> {
    if record.status != "failed" || record.failure_step.as_deref() != Some("start") {
        return None;
    }
    Some(BuildLog {
        environment: record.place.environment.clone().unwrap_or_default(),
        namespace: record.place.namespace.clone().unwrap_or_default(),
        steps: vec![build::StepLog {
            step: "start".into(),
            state: "failed".into(),
            log: record
                .failure
                .clone()
                .unwrap_or_else(|| "the build failed before it reached the cluster".into()),
        }],
    })
}

/// A build's steps, read from its pod.
#[derive(Debug, Clone)]
pub struct BuildLog {
    /// The environment it runs in.
    pub environment: String,
    pub namespace: String,
    pub steps: Vec<build::StepLog>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_description_that_cannot_be_read_is_not_a_product_never_saved() {
        let r = saved_description_unreadable(anyhow::anyhow!("graph storage timed out"));
        let Refusal::Unavailable(why) = r else {
            panic!("a failed read is the store's answer, not PRODUCT_NOT_SAVED");
        };
        assert!(
            why.contains("could not be read") && why.contains("graph storage timed out"),
            "{why}"
        );
    }

    #[test]
    fn a_project_name_that_cannot_be_read_refuses_with_its_cause() {
        let project = Uuid::from_u128(3);
        let Refusal::Unavailable(why) =
            project_name_unreadable(project, anyhow::anyhow!("tenant {project} has no name"))
        else {
            panic!("refused as unavailable");
        };
        assert!(
            why.contains("namespace") && why.contains("has no name"),
            "{why}"
        );
    }

    #[test]
    fn a_build_that_failed_as_it_started_logs_its_reason_not_a_missing_pod() {
        use crate::artifact_ingest::port::{BuildPlace, BuildRecord};
        let failed = BuildRecord {
            build_id: "studio-1".into(),
            status: "failed".into(),
            failure: Some("the token for connection 'GitHub (alice)' is not readable".into()),
            failure_step: Some("start".into()),
            place: BuildPlace {
                environment: Some("dev".into()),
                namespace: Some("shop-dev".into()),
                ..BuildPlace::default()
            },
            ..BuildRecord::default()
        };
        let log = start_failure_log(&failed).expect("the start's reason");
        assert_eq!(log.environment, "dev");
        assert_eq!(log.namespace, "shop-dev");
        assert_eq!(log.steps.len(), 1);
        assert_eq!(log.steps[0].step, "start");
        assert_eq!(log.steps[0].state, "failed");
        assert!(log.steps[0].log.contains("not readable"));
        // Any other build's log is its pod's.
        for (status, step) in [
            ("failed", Some("build")),
            ("running", None),
            ("passed", None),
        ] {
            let other = BuildRecord {
                status: status.into(),
                failure_step: step.map(str::to_owned),
                ..failed.clone()
            };
            assert!(start_failure_log(&other).is_none(), "{status}");
        }
    }

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
