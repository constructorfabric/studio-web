//! What an environment, a binding and a deployment are, and the rules about
//! them that need no I/O (ADR-0043). Everything here is tested without a
//! server; the service applies it over account-management and the cluster.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The namespace pattern an environment gets unless it says otherwise: one
/// namespace per project and environment (ADR-0043 §1).
pub const DEFAULT_NAMESPACE_PATTERN: &str = "{project}-{environment}";

/// How many deployments an organization's history keeps. The latest one per
/// project and environment is always kept on top of these, so "what runs
/// where" never loses its answer to a busy week.
pub const HISTORY: usize = 200;

/// How large a chart a deploy request may carry. A generated chart is a few
/// kilobytes; this is the limit of a mistake, not of a product.
pub const MAX_CHART_BYTES: usize = 512 * 1024;

/// How an environment gives a product's `db` gears a database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseMode {
    /// The product brings its own, or has none.
    #[default]
    None,
    /// A Postgres server of the environment, one database per gear. Recorded,
    /// not used: a generated chart fixes its host and database names, so two
    /// projects on one server would collide (ADR-0048 §7).
    Shared,
    /// A Postgres of the product's own in the project's namespace, under the
    /// host the profile names, with the databases the chart's gears keep
    /// (ADR-0048 §7).
    Namespace,
}

/// One place an organization's products run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Environment {
    pub id: Uuid,
    /// `dev`, `stage`, `prod`: what people choose and see. A DNS label, since
    /// it goes into namespaces.
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The cluster: a connection of the `kubernetes` kind the organization
    /// holds.
    pub connection_id: Uuid,
    /// The prefix images are pushed to and the chart pulls from
    /// (`ghcr.io/acme`). Empty: the images are used as generated.
    #[serde(default)]
    pub registry: String,
    /// The `registry` connection images are pulled and the chart fetched
    /// with (ADR-0048 §1); `None` for a public registry or none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_connection_id: Option<Uuid>,
    #[serde(default = "default_pattern")]
    pub namespace_pattern: String,
    #[serde(default)]
    pub database: DatabaseMode,
    /// The image of a `namespace` database; `None` for
    /// `pgvector/pgvector:pg18`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_image: Option<String>,
    /// A deploy waits for an organization administrator's approval.
    #[serde(default)]
    pub protected: bool,
    /// The environment a release must run in first (ADR-0048 §5): `prod`
    /// takes what succeeded in `stage`. `None` takes anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promote_from: Option<Uuid>,
    /// The projects that may deploy here; `None` is all of them.
    #[serde(default)]
    pub projects: Option<Vec<Uuid>>,
    pub updated_by: String,
    pub updated_at: String,
}

fn default_pattern() -> String {
    DEFAULT_NAMESPACE_PATTERN.to_owned()
}

/// The organization's environments: one metadata row on the organization.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentList {
    #[serde(default)]
    pub items: Vec<Environment>,
}

/// What a person may set on an environment.
#[derive(Debug, Clone)]
pub struct EnvironmentInput {
    pub name: String,
    pub description: String,
    pub connection_id: Uuid,
    pub registry: String,
    pub registry_connection_id: Option<Uuid>,
    pub namespace_pattern: Option<String>,
    pub database: DatabaseMode,
    pub database_image: Option<String>,
    pub protected: bool,
    pub promote_from: Option<Uuid>,
    pub projects: Option<Vec<Uuid>>,
}

/// A refusal of an environment as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub field: &'static str,
    pub reason: String,
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.field, self.reason)
    }
}

fn invalid(field: &'static str, reason: impl Into<String>) -> Invalid {
    Invalid {
        field,
        reason: reason.into(),
    }
}

/// Is `s` a DNS-1123 label: lowercase letters, digits and `-`, starting and
/// ending with an alphanumeric, at most 63 characters? What Kubernetes asks
/// of a namespace, and so of everything that goes into one.
pub fn is_dns_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// A name made fit for a namespace: lowercased, every run of other characters
/// one `-`, trimmed of `-`. `Studio Web 2` → `studio-web-2`.
pub fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

/// The namespace `pattern` gives `project` in `environment`. Refused when the
/// result is not a namespace, which says the pattern or the names need
/// changing -- never truncated into a namespace somebody else might have.
pub fn namespace_for(pattern: &str, project: &str, environment: &str) -> Result<String, Invalid> {
    let ns = pattern
        .replace("{project}", &slug(project))
        .replace("{environment}", &slug(environment));
    if is_dns_label(&ns) {
        Ok(ns)
    } else {
        Err(invalid(
            "namespace_pattern",
            format!(
                "'{pattern}' gives '{ns}' for project '{project}', which is not a Kubernetes \
                 namespace (lowercase letters, digits and '-', at most 63)"
            ),
        ))
    }
}

/// An image registry prefix: `host[:port]/path`, no scheme, no tag.
fn check_registry(registry: &str) -> Result<(), Invalid> {
    if registry.is_empty() {
        return Ok(());
    }
    if registry.contains("://") {
        return Err(invalid(
            "registry",
            "write the registry without a scheme, e.g. ghcr.io/acme",
        ));
    }
    let ok = registry
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':'));
    if !ok || registry.starts_with('/') || registry.contains("//") {
        return Err(invalid(
            "registry",
            format!("'{registry}' is not an image registry prefix, e.g. ghcr.io/acme"),
        ));
    }
    Ok(())
}

/// The environment `input` describes, checked against the others in `list`
/// (`id` is the one being edited, if any).
pub fn checked(
    list: &EnvironmentList,
    id: Option<Uuid>,
    input: EnvironmentInput,
    by: String,
    at: String,
) -> Result<Environment, Invalid> {
    let name = input.name.trim().to_owned();
    if !is_dns_label(&name) {
        return Err(invalid(
            "name",
            "an environment name is lowercase letters, digits and '-' (dev, stage, prod)",
        ));
    }
    if list
        .items
        .iter()
        .any(|e| e.name == name && Some(e.id) != id)
    {
        return Err(invalid(
            "name",
            format!("the organization already has an environment '{name}'"),
        ));
    }
    let pattern = input
        .namespace_pattern
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(default_pattern);
    // A pattern without the project would put every project into one
    // namespace, where one product's release overwrites another's.
    if !pattern.contains("{project}") {
        return Err(invalid(
            "namespace_pattern",
            "the pattern must contain {project}: each project gets its own namespace",
        ));
    }
    namespace_for(&pattern, "a-project", &name)?;
    let database_image = input
        .database_image
        .map(|i| i.trim().to_owned())
        .filter(|i| !i.is_empty());
    if let Some(image) = &database_image {
        let ok = !image.contains("://")
            && image.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':' | b'@')
            });
        if !ok {
            return Err(invalid(
                "database_image",
                format!("'{image}' is not an image, e.g. pgvector/pgvector:pg18"),
            ));
        }
    }
    let own = id.unwrap_or_else(Uuid::new_v4);
    if let Some(from) = input.promote_from {
        check_promotion(list, own, from)?;
    }
    let registry = input.registry.trim().trim_end_matches('/').to_owned();
    check_registry(&registry)?;
    if input.registry_connection_id.is_some() && registry.is_empty() {
        return Err(invalid(
            "registry",
            "an environment with a registry connection says where in it the images go, \
             e.g. ghcr.io/acme",
        ));
    }
    Ok(Environment {
        id: own,
        name,
        description: input.description.trim().to_owned(),
        connection_id: input.connection_id,
        registry,
        registry_connection_id: input.registry_connection_id,
        namespace_pattern: pattern,
        database: input.database,
        database_image,
        protected: input.protected,
        promote_from: input.promote_from,
        projects: input.projects.map(|mut p| {
            p.sort();
            p.dedup();
            p
        }),
        updated_by: by,
        updated_at: at,
    })
}

/// `own` taking releases from `from`: another environment of the list, and
/// no circle back to `own` along the chain, which would let nothing in.
fn check_promotion(list: &EnvironmentList, own: Uuid, from: Uuid) -> Result<(), Invalid> {
    if from == own {
        return Err(invalid(
            "promote_from",
            "an environment cannot take releases from itself",
        ));
    }
    let mut at = Some(from);
    let mut steps = 0usize;
    while let Some(id) = at {
        let Some(env) = list.items.iter().find(|e| e.id == id) else {
            return Err(invalid(
                "promote_from",
                format!("the organization has no environment {id}"),
            ));
        };
        at = env.promote_from;
        steps += 1;
        if at == Some(own) || steps > list.items.len() {
            return Err(invalid(
                "promote_from",
                format!(
                    "'{}' already takes its releases, through the chain, from this one",
                    env.name
                ),
            ));
        }
    }
    Ok(())
}

impl Environment {
    /// May `project` deploy here?
    pub fn admits(&self, project: Uuid) -> bool {
        self.projects.as_ref().is_none_or(|p| p.contains(&project))
    }

    /// An image as this environment's registry holds it. One already named
    /// under the registry (a CI build's, with its digest) is left as it is.
    pub fn image(&self, image: &str) -> String {
        if self.registry.is_empty()
            || image
                .strip_prefix(&self.registry)
                .is_some_and(|rest| rest.starts_with('/'))
        {
            image.to_owned()
        } else {
            format!("{}/{image}", self.registry)
        }
    }
}

/// What a deployment does to its release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentAction {
    /// `helm upgrade --install`.
    #[default]
    Install,
    /// `helm uninstall`: the release leaves the environment (ADR-0048 §5).
    Uninstall,
}

impl DeploymentAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Uninstall => "uninstall",
        }
    }
}

/// One of a project's product profiles bound to an environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    /// The `kubernetes` profile's id in `product.gdl` (`prod`).
    pub profile: String,
    pub environment_id: Uuid,
    /// Chart values this project's release gets in that environment, under
    /// what a deploy sets (ADR-0048 §7). Not secret: kept in the open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<serde_json::Value>,
}

/// A secret value of the project's configuration in one environment: its
/// key here, its value in credstore under [`config_secret_ref`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigSecret {
    pub environment_id: Uuid,
    /// The variable the applications read it as: `SMTP_PASSWORD`.
    pub key: String,
}

/// A project's bindings: one metadata row on the project.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingList {
    #[serde(default)]
    pub items: Vec<Binding>,
    /// The secret keys set for it, per environment; the values never here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<ConfigSecret>,
}

/// How large a binding's values may be once written.
pub const MAX_VALUES_BYTES: usize = 64 * 1024;

/// A secret's key: an environment variable name, `[A-Z_][A-Z0-9_]*`.
pub fn is_secret_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && !key.as_bytes()[0].is_ascii_digit()
}

/// Where a configuration secret's value is kept in credstore: derived from
/// the project, the environment and the key, so nobody names another one.
pub fn config_secret_ref(project: Uuid, environment: Uuid, key: &str) -> String {
    format!(
        "studio-env-config-{project}-{environment}-{}",
        key.to_ascii_lowercase().replace('_', "-")
    )
}

/// The namespace secret a release's configuration secrets are written into.
pub fn config_secret_name(release: &str) -> String {
    format!("{release}-config")
}

/// `over` merged into `base`: objects key by key, anything else replaced.
pub fn merge(base: &mut serde_json::Value, over: serde_json::Value) {
    match (base, over) {
        (serde_json::Value::Object(b), serde_json::Value::Object(o)) => {
            for (k, v) in o {
                merge(b.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (b, o) => *b = o,
    }
}

/// The values a deploy gives the chart: the binding's own, then the images
/// and the pull secret over them, then each application pointed at the
/// release's configuration secret when it has keys (`existingSecret`,
/// `secretKeys`, which a generated chart turns into environment variables).
pub fn deploy_values(
    env: &Environment,
    images: &[DeployImage],
    binding: Option<&serde_json::Value>,
    secret_keys: &[String],
    release: &str,
) -> serde_json::Value {
    let mut values = binding
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    merge(&mut values, image_values(env, images));
    if !secret_keys.is_empty() {
        for i in images {
            merge(
                &mut values,
                serde_json::json!({ i.app.clone(): {
                    "existingSecret": config_secret_name(release),
                    "secretKeys": secret_keys,
                }}),
            );
        }
    }
    values
}

/// Bindings as written: each profile once, each a profile id, values an
/// object of a sane size.
pub fn checked_bindings(items: Vec<Binding>) -> Result<BindingList, Invalid> {
    let mut seen = std::collections::BTreeSet::new();
    for b in &items {
        if let Some(v) = &b.values {
            if !v.is_object() {
                return Err(invalid(
                    "values",
                    "a binding's values are an object of chart values",
                ));
            }
            if v.to_string().len() > MAX_VALUES_BYTES {
                return Err(invalid(
                    "values",
                    format!("a binding's values are at most {MAX_VALUES_BYTES} bytes"),
                ));
            }
        }
        let ok = !b.profile.is_empty()
            && b.profile.len() <= 63
            && b.profile
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
        if !ok {
            return Err(invalid(
                "profile",
                format!("'{}' is not a profile id", b.profile),
            ));
        }
        if !seen.insert(b.profile.clone()) {
            return Err(invalid(
                "profile",
                format!("profile '{}' is bound twice", b.profile),
            ));
        }
    }
    Ok(BindingList {
        items,
        secrets: Vec::new(),
    })
}

/// Where a deployment has got to. `Queued`, `Running`, `Succeeded` and
/// `Failed` come from its run (ADR-0038); the first two states are this
/// gear's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentState {
    AwaitingApproval,
    Declined,
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl DeploymentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingApproval => "awaiting_approval",
            Self::Declined => "declined",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One image of the product, as Generate built it (`repository:tag`, no
/// registry) and the application whose chart values name it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeployImage {
    pub app: String,
    pub image: String,
}

/// The repository paths on the registry host that `names` (relative to the
/// environment's prefix: `gbx-api`, `charts/shop`) are: `acme/gbx-api`. A
/// name that would step outside the prefix is refused.
pub fn push_paths(prefix: &str, names: &[String]) -> Result<Vec<String>, Invalid> {
    if prefix.is_empty() {
        return Err(invalid(
            "registry",
            "the environment has no registry prefix",
        ));
    }
    if names.is_empty() || names.len() > 40 {
        return Err(invalid("repositories", "name 1 to 40 repositories to push"));
    }
    let under = prefix.split_once('/').map(|(_, path)| path).unwrap_or("");
    names
        .iter()
        .map(|n| {
            let n = n.trim().trim_matches('/');
            let ok = !n.is_empty()
                && !n.contains("..")
                && !n.contains("//")
                && n.bytes().all(|b| {
                    b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || matches!(b, b'.' | b'-' | b'_' | b'/')
                });
            if !ok {
                return Err(invalid(
                    "repositories",
                    format!("'{n}' is not a repository name"),
                ));
            }
            Ok(if under.is_empty() {
                n.to_owned()
            } else {
                format!("{under}/{n}")
            })
        })
        .collect()
}

/// A chart published to an environment's registry: `oci://…` and a version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChartRef {
    pub reference: String,
    pub version: String,
}

/// The chart reference a deploy request names, checked against the
/// environment: only its own registry, which the server can log in to and
/// which the organization connected. A reference elsewhere would have the
/// server fetch from a host nobody chose.
pub fn check_chart_ref(
    env: &Environment,
    reference: &str,
    version: &str,
) -> Result<ChartRef, Invalid> {
    let reference = reference.trim();
    let version = version.trim();
    if env.registry_connection_id.is_none() || env.registry.is_empty() {
        return Err(invalid(
            "chart_ref",
            format!(
                "environment '{}' has no registry connection: give it one, or send the chart itself",
                env.name
            ),
        ));
    }
    let Some(path) = reference.strip_prefix("oci://") else {
        return Err(invalid(
            "chart_ref",
            "a chart reference is oci://<registry>/<path>",
        ));
    };
    let on_registry = path
        .strip_prefix(&env.registry)
        .is_some_and(|rest| rest.len() > 1 && rest.starts_with('/'));
    if !on_registry {
        return Err(invalid(
            "chart_ref",
            format!(
                "'{reference}' is not under the environment's registry {}",
                env.registry
            ),
        ));
    }
    let path_ok = path.bytes().all(|b| {
        b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || matches!(b, b'.' | b'-' | b'_' | b'/' | b':')
    }) && !path.contains("//")
        && !path.contains("..")
        && !path.ends_with('/');
    if !path_ok {
        return Err(invalid(
            "chart_ref",
            format!("'{reference}' is not a chart reference"),
        ));
    }
    let version_ok = !version.is_empty()
        && version.len() <= 128
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+'));
    if !version_ok {
        return Err(invalid(
            "chart_version",
            "a published chart is deployed at a version (0.1.0, 0.1.0-sha.abc123)",
        ));
    }
    Ok(ChartRef {
        reference: reference.to_owned(),
        version: version.to_owned(),
    })
}

/// One deploy: asked for, decided, run. The record of "what runs where"
/// (ADR-0043 §4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deployment {
    pub id: Uuid,
    pub project_id: Uuid,
    #[serde(default)]
    pub project_name: String,
    pub environment_id: Uuid,
    #[serde(default)]
    pub environment_name: String,
    pub profile: String,
    /// The product id, which is the Helm release.
    pub product: String,
    #[serde(default)]
    pub action: DeploymentAction,
    /// The earlier deployment this one installs again: a rollback, or the
    /// same release promoted (ADR-0048 §5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redeploy_of: Option<Uuid>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub lock_hash: Option<String>,
    /// The build it came from (ADR-0045 §4): the IDE's build id, as its
    /// `build` record in the project's graph names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    /// The images as Generate built them; the environment's registry is put
    /// in front of them when the chart is installed.
    #[serde(default)]
    pub images: Vec<DeployImage>,
    pub namespace: String,
    /// The chart's sha256, so a record says which chart it installed; empty
    /// for a chart named by reference, which [`Self::chart_ref`] says.
    #[serde(default)]
    pub chart_sha256: String,
    /// The published chart it installs (ADR-0048 §3), when it named one
    /// rather than carrying it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_ref: Option<ChartRef>,
    pub state: DeploymentState,
    #[serde(default)]
    pub run_id: Option<Uuid>,
    pub requested_by: String,
    #[serde(default)]
    pub requested_by_name: String,
    pub requested_at: String,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub decided_by_name: Option<String>,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    /// What the run said: its summary, or why it failed.
    #[serde(default)]
    pub outcome: Option<String>,
    /// The chart, base64, kept only while the deploy waits for approval; the
    /// run carries it from then on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_chart: Option<String>,
}

impl Deployment {
    /// Whether `self` installs the same release as `other`: the same build
    /// when both name one, else the same chart and images.
    pub fn same_release(&self, other: &Deployment) -> bool {
        if let (Some(a), Some(b)) = (&self.build, &other.build) {
            return a == b;
        }
        self.product == other.product
            && self.chart_ref == other.chart_ref
            && self.chart_sha256 == other.chart_sha256
            && self.images == other.images
    }
}

/// Why `d` may not go into `env` yet: it has not run in the environment
/// `env` takes its releases from. `history` is the project's deployments
/// there; `from` names that environment.
pub fn promotion_gap(
    env: &Environment,
    from: &str,
    d: &Deployment,
    history: &[Deployment],
) -> Option<String> {
    let src = env.promote_from?;
    let promoted = history.iter().any(|p| {
        p.environment_id == src
            && p.project_id == d.project_id
            && p.action == DeploymentAction::Install
            && p.state == DeploymentState::Succeeded
            && p.same_release(d)
    });
    (!promoted).then(|| {
        format!(
            "environment '{}' takes only what runs in '{from}': deploy this release there first",
            env.name
        )
    })
}

/// The organization's deployments: one metadata row on the organization,
/// newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentList {
    #[serde(default)]
    pub items: Vec<Deployment>,
}

impl DeploymentList {
    /// Put `d` first and trim the history to [`HISTORY`], keeping the latest
    /// deployment of every project and environment, and every one still
    /// waiting for a decision.
    pub fn record(&mut self, d: Deployment) {
        self.items.retain(|x| x.id != d.id);
        self.items.insert(0, d);
        let mut latest = std::collections::BTreeSet::new();
        let mut kept = 0usize;
        self.items.retain(|x| {
            let first = latest.insert((x.project_id, x.environment_id));
            let keep = first || x.state == DeploymentState::AwaitingApproval || kept < HISTORY;
            if keep {
                kept += 1;
            }
            keep
        });
    }
}

/// The values a deploy gives a chart: each application at the environment's
/// image (`{<app>: {image: {repository, tag}}}`, the keys Generate's charts
/// read), and, with a registry login, the pull secret under
/// `global.imagePullSecrets`, which a generated chart puts on every pod --
/// its applications run as service accounts of their own, so the namespace's
/// `default` account alone would not reach them (ADR-0048 §2).
pub fn image_values(env: &Environment, images: &[DeployImage]) -> serde_json::Value {
    let mut values = serde_json::Map::new();
    if env.registry_connection_id.is_some() {
        values.insert(
            "global".into(),
            serde_json::json!({ "imagePullSecrets": [PULL_SECRET_NAME] }),
        );
    }
    for i in images {
        let (repository, tag) = split_image(&env.image(&i.image));
        let mut image = serde_json::Map::new();
        image.insert("repository".into(), repository.into());
        if let Some(tag) = tag {
            image.insert("tag".into(), tag.into());
        }
        values.insert(i.app.clone(), serde_json::json!({ "image": image }));
    }
    serde_json::Value::Object(values)
}

/// The pull secret a deploy writes into the namespace (ADR-0048 §2).
pub const PULL_SECRET_NAME: &str = "studio-registry";

/// `repository:tag` split at the tag's colon, not at a registry's port. A
/// digest stays with the tag (`tag@sha256:…`), which a chart's
/// `repository:tag` then names exactly.
pub fn split_image(image: &str) -> (String, Option<String>) {
    if let Some((name, digest)) = image.split_once('@') {
        let (repository, tag) = split_image(name);
        return (
            repository,
            Some(format!(
                "{}@{digest}",
                tag.unwrap_or_else(|| "latest".into())
            )),
        );
    }
    match image.rfind(':') {
        Some(at) if !image[at..].contains('/') => {
            (image[..at].to_owned(), Some(image[at + 1..].to_owned()))
        }
        _ => (image.to_owned(), None),
    }
}

/// An application name and an image as a deploy request may carry them.
pub fn check_images(images: &[DeployImage]) -> Result<(), Invalid> {
    for i in images {
        let app_ok = !i.app.is_empty()
            && i.app
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !app_ok {
            return Err(invalid(
                "images",
                format!("'{}' is not an application", i.app),
            ));
        }
        let image_ok = !i.image.is_empty()
            && !i.image.contains("://")
            && i.image.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':' | b'@')
            });
        if !image_ok {
            return Err(invalid("images", format!("'{}' is not an image", i.image)));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> EnvironmentInput {
        EnvironmentInput {
            name: name.into(),
            description: String::new(),
            connection_id: Uuid::from_u128(7),
            registry: "ghcr.io/acme/".into(),
            registry_connection_id: None,
            namespace_pattern: None,
            database: DatabaseMode::None,
            database_image: None,
            protected: false,
            promote_from: None,
            projects: None,
        }
    }

    fn env(name: &str) -> Environment {
        checked(
            &EnvironmentList::default(),
            None,
            input(name),
            String::new(),
            "t".into(),
        )
        .unwrap()
    }

    fn placed(state: DeploymentState, environment: Uuid) -> Deployment {
        let mut d = deployment(1, 1, state);
        d.environment_id = environment;
        d
    }

    #[test]
    fn an_environment_takes_releases_from_another_never_in_a_circle() {
        let stage = env("stage");
        let mut list = EnvironmentList {
            items: vec![stage.clone()],
        };
        let mut i = input("prod");
        i.promote_from = Some(stage.id);
        let prod = checked(&list, None, i, String::new(), "t".into()).unwrap();
        assert_eq!(prod.promote_from, Some(stage.id));
        list.items.push(prod.clone());
        // stage taking from prod would close the circle.
        let mut back = input("stage");
        back.promote_from = Some(prod.id);
        assert_eq!(
            checked(&list, Some(stage.id), back, String::new(), "t".into())
                .unwrap_err()
                .field,
            "promote_from"
        );
        let mut own = input("prod");
        own.promote_from = Some(prod.id);
        assert!(checked(&list, Some(prod.id), own, String::new(), "t".into()).is_err());
        let mut nowhere = input("qa");
        nowhere.promote_from = Some(Uuid::from_u128(99));
        assert!(checked(&list, None, nowhere, String::new(), "t".into()).is_err());
    }

    #[test]
    fn a_release_goes_on_only_after_it_ran_where_the_environment_takes_from() {
        let stage = env("stage");
        let mut prod = env("prod");
        prod.promote_from = Some(stage.id);
        let mut want = placed(DeploymentState::Queued, prod.id);
        want.build = Some("ci-42".into());
        let mut ran = placed(DeploymentState::Succeeded, stage.id);
        ran.build = Some("ci-41".into());
        assert!(
            promotion_gap(&prod, "stage", &want, &[ran.clone()]).is_some(),
            "another build"
        );
        ran.build = Some("ci-42".into());
        assert!(promotion_gap(&prod, "stage", &want, &[ran.clone()]).is_none());
        ran.state = DeploymentState::Failed;
        assert!(
            promotion_gap(&prod, "stage", &want, &[ran.clone()]).is_some(),
            "it failed there"
        );
        assert!(
            promotion_gap(&stage, "", &want, &[]).is_none(),
            "stage takes anything"
        );
    }

    #[test]
    fn without_builds_a_release_is_its_chart_and_images() {
        let mut a = placed(DeploymentState::Succeeded, Uuid::from_u128(2));
        a.chart_ref = Some(ChartRef {
            reference: "oci://r/p".into(),
            version: "1".into(),
        });
        let mut b = a.clone();
        assert!(a.same_release(&b));
        b.chart_ref.as_mut().unwrap().version = "2".into();
        assert!(!a.same_release(&b));
    }

    #[test]
    fn a_deploy_lays_its_images_over_the_bindings_values_and_names_its_secret() {
        let e = env("prod");
        let images = [DeployImage {
            app: "api".into(),
            image: "gbx-api:1".into(),
        }];
        let binding = serde_json::json!({
            "api": { "replicaCount": 2, "image": { "repository": "theirs", "pullPolicy": "Always" } },
        });
        let v = deploy_values(
            &e,
            &images,
            Some(&binding),
            &["SMTP_PASSWORD".into()],
            "shop",
        );
        assert_eq!(v["api"]["replicaCount"], 2);
        assert_eq!(
            v["api"]["image"]["repository"], "ghcr.io/acme/gbx-api",
            "the deploy's image wins"
        );
        assert_eq!(
            v["api"]["image"]["pullPolicy"], "Always",
            "the rest of the binding stays"
        );
        assert_eq!(v["api"]["existingSecret"], "shop-config");
        assert_eq!(v["api"]["secretKeys"][0], "SMTP_PASSWORD");
        let plain = deploy_values(&e, &images, None, &[], "shop");
        assert!(plain["api"].get("existingSecret").is_none());
    }

    #[test]
    fn a_secret_key_is_a_variable_and_its_reference_is_derived() {
        assert!(is_secret_key("SMTP_PASSWORD"));
        for bad in ["smtp", "1X", "A-B", "", "A B"] {
            assert!(!is_secret_key(bad), "{bad}");
        }
        let r = config_secret_ref(Uuid::nil(), Uuid::nil(), "SMTP_PASSWORD");
        assert!(r.ends_with("-smtp-password") && r.starts_with("studio-env-config-"));
    }

    #[test]
    fn a_bindings_values_are_an_object() {
        let b = |values| Binding {
            profile: "prod".into(),
            environment_id: Uuid::nil(),
            values: Some(values),
        };
        assert!(checked_bindings(vec![b(serde_json::json!({"a": 1}))]).is_ok());
        assert_eq!(
            checked_bindings(vec![b(serde_json::json!([1]))])
                .unwrap_err()
                .field,
            "values"
        );
    }

    #[test]
    fn a_push_is_only_under_the_environments_prefix() {
        let names = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            push_paths("ghcr.io/acme", &names(&["gbx-api", "charts/shop"])).unwrap(),
            ["acme/gbx-api", "acme/charts/shop"]
        );
        assert_eq!(push_paths("registry.local", &names(&["x"])).unwrap(), ["x"]);
        for bad in ["../other", "Up", "a//b", ""] {
            assert!(push_paths("ghcr.io/acme", &names(&[bad])).is_err(), "{bad}");
        }
        assert!(push_paths("", &names(&["x"])).is_err());
    }

    #[test]
    fn a_built_image_keeps_its_registry_and_digest() {
        let mut e = env("prod");
        assert_eq!(
            split_image("ghcr.io/acme/gbx-api:0.1.0@sha256:abc"),
            (
                "ghcr.io/acme/gbx-api".into(),
                Some("0.1.0@sha256:abc".into())
            )
        );
        assert_eq!(
            split_image("localhost:5000/x@sha256:abc"),
            ("localhost:5000/x".into(), Some("latest@sha256:abc".into()))
        );
        assert_eq!(e.image("ghcr.io/acme/gbx-api:1"), "ghcr.io/acme/gbx-api:1");
        assert_eq!(e.image("gbx-api:1"), "ghcr.io/acme/gbx-api:1");
        let v = image_values(&e, &[]);
        assert!(v.get("global").is_none(), "no login, no pull secret");
        e.registry_connection_id = Some(Uuid::from_u128(9));
        let v = image_values(&e, &[]);
        assert_eq!(v["global"]["imagePullSecrets"][0], PULL_SECRET_NAME);
    }

    #[test]
    fn a_registry_connection_needs_a_prefix_to_push_under() {
        let mut i = input("prod");
        i.registry = String::new();
        i.registry_connection_id = Some(Uuid::from_u128(9));
        let e = checked(
            &EnvironmentList::default(),
            None,
            i,
            String::new(),
            "t".into(),
        )
        .unwrap_err();
        assert_eq!(e.field, "registry");
    }

    #[test]
    fn a_chart_is_named_only_on_the_environments_registry() {
        let mut e = env("prod");
        assert_eq!(
            check_chart_ref(&e, "oci://ghcr.io/acme/charts/shop", "0.1.0")
                .unwrap_err()
                .field,
            "chart_ref",
            "no registry connection: nothing to log in with"
        );
        e.registry_connection_id = Some(Uuid::from_u128(9));
        let ok = check_chart_ref(&e, " oci://ghcr.io/acme/charts/shop ", "0.1.0-sha.abc").unwrap();
        assert_eq!(ok.reference, "oci://ghcr.io/acme/charts/shop");
        for bad in [
            "https://ghcr.io/acme/charts/shop",
            "oci://ghcr.io/other/shop",
            "oci://ghcr.io/acmeevil/shop",
            "oci://ghcr.io/acme/",
            "oci://ghcr.io/acme/../x",
            "oci://ghcr.io/acme/Shop",
        ] {
            assert!(check_chart_ref(&e, bad, "1.0.0").is_err(), "{bad}");
        }
        assert_eq!(
            check_chart_ref(&e, "oci://ghcr.io/acme/shop", "")
                .unwrap_err()
                .field,
            "chart_version"
        );
    }

    #[test]
    fn an_environment_gets_the_default_pattern_and_a_trimmed_registry() {
        let e = env("prod");
        assert_eq!(e.namespace_pattern, DEFAULT_NAMESPACE_PATTERN);
        assert_eq!(e.registry, "ghcr.io/acme");
    }

    #[test]
    fn two_environments_may_not_share_a_name_but_an_edit_keeps_its_own() {
        let list = EnvironmentList {
            items: vec![env("prod")],
        };
        let id = list.items[0].id;
        assert_eq!(
            checked(&list, None, input("prod"), String::new(), "t".into())
                .unwrap_err()
                .field,
            "name"
        );
        assert!(checked(&list, Some(id), input("prod"), String::new(), "t".into()).is_ok());
    }

    #[test]
    fn a_name_or_pattern_that_cannot_make_a_namespace_is_refused() {
        let list = EnvironmentList::default();
        assert!(checked(&list, None, input("Prod"), String::new(), "t".into()).is_err());
        let mut shared = input("prod");
        shared.namespace_pattern = Some("{environment}".into());
        assert_eq!(
            checked(&list, None, shared, String::new(), "t".into())
                .unwrap_err()
                .field,
            "namespace_pattern"
        );
        let mut scheme = input("prod");
        scheme.registry = "https://ghcr.io/acme".into();
        assert_eq!(
            checked(&list, None, scheme, String::new(), "t".into())
                .unwrap_err()
                .field,
            "registry"
        );
    }

    #[test]
    fn a_namespace_is_made_of_the_project_and_environment_names() {
        assert_eq!(
            namespace_for(DEFAULT_NAMESPACE_PATTERN, "Studio Web", "prod").unwrap(),
            "studio-web-prod"
        );
        assert!(namespace_for(DEFAULT_NAMESPACE_PATTERN, &"x".repeat(70), "prod").is_err());
    }

    #[test]
    fn an_environment_admits_the_projects_it_lists_or_all() {
        let mut e = env("prod");
        assert!(e.admits(Uuid::from_u128(1)));
        e.projects = Some(vec![Uuid::from_u128(2)]);
        assert!(!e.admits(Uuid::from_u128(1)));
        assert!(e.admits(Uuid::from_u128(2)));
    }

    #[test]
    fn image_values_point_each_application_at_the_registry() {
        let e = env("prod");
        let v = image_values(
            &e,
            &[DeployImage {
                app: "api".into(),
                image: "studio/api:0.1.0".into(),
            }],
        );
        assert_eq!(v["api"]["image"]["repository"], "ghcr.io/acme/studio/api");
        assert_eq!(v["api"]["image"]["tag"], "0.1.0");
        assert_eq!(
            split_image("localhost:5000/api"),
            ("localhost:5000/api".into(), None)
        );
    }

    #[test]
    fn a_profile_is_bound_once() {
        let b = |p: &str| Binding {
            profile: p.into(),
            environment_id: Uuid::nil(),
            values: None,
        };
        assert!(checked_bindings(vec![b("prod"), b("stage")]).is_ok());
        assert!(checked_bindings(vec![b("prod"), b("prod")]).is_err());
        assert!(checked_bindings(vec![b("pr od")]).is_err());
    }

    fn deployment(n: u128, project: u128, state: DeploymentState) -> Deployment {
        Deployment {
            id: Uuid::from_u128(n),
            project_id: Uuid::from_u128(project),
            project_name: String::new(),
            environment_id: Uuid::from_u128(9),
            environment_name: String::new(),
            profile: "prod".into(),
            product: "p".into(),
            action: DeploymentAction::Install,
            redeploy_of: None,
            commit: None,
            lock_hash: None,
            build: None,
            images: vec![],
            namespace: "p-prod".into(),
            chart_sha256: String::new(),
            chart_ref: None,
            state,
            run_id: None,
            requested_by: String::new(),
            requested_by_name: String::new(),
            requested_at: String::new(),
            decided_by: None,
            decided_by_name: None,
            decided_at: None,
            reason: None,
            outcome: None,
            pending_chart: None,
        }
    }

    #[test]
    fn the_history_keeps_the_latest_per_place_and_everything_waiting() {
        let mut list = DeploymentList::default();
        list.record(deployment(1, 1, DeploymentState::Succeeded));
        list.record(deployment(2, 2, DeploymentState::AwaitingApproval));
        for n in 0..(HISTORY as u128 + 10) {
            list.record(deployment(100 + n, 3, DeploymentState::Succeeded));
        }
        assert_eq!(list.items[0].id, Uuid::from_u128(100 + HISTORY as u128 + 9));
        assert!(list.items.iter().any(|d| d.id == Uuid::from_u128(1)));
        assert!(list.items.iter().any(|d| d.id == Uuid::from_u128(2)));
        assert!(list.items.len() <= HISTORY + 2);
    }

    #[test]
    fn recording_again_replaces_rather_than_duplicates() {
        let mut list = DeploymentList::default();
        list.record(deployment(1, 1, DeploymentState::AwaitingApproval));
        list.record(deployment(1, 1, DeploymentState::Queued));
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].state, DeploymentState::Queued);
    }

    #[test]
    fn images_from_a_request_are_checked() {
        let ok = DeployImage {
            app: "api".into(),
            image: "acme/api:1".into(),
        };
        assert!(check_images(&[ok]).is_ok());
        let bad = DeployImage {
            app: "api".into(),
            image: "acme/api:1 --set x".into(),
        };
        assert!(check_images(&[bad]).is_err());
    }
}
