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
///
/// The database is part of the product: a product whose gears keep data
/// gets a Postgres of its own with every deploy, in the project's namespace
/// (in Research, as one more service of its application), under the host
/// the profile names, with the databases the chart's gears keep (ADR-0048
/// §7). A product whose gears keep none gets none. So `None` and
/// `Namespace` deploy alike; a Postgres already in the namespace under that
/// host that Studio did not make is left alone -- the product's own,
/// brought some other way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseMode {
    /// The product's own, when its gears keep data.
    #[default]
    None,
    /// A Postgres server of the environment, one database per gear. Recorded,
    /// not used: a generated chart fixes its host and database names, so two
    /// projects on one server would collide (ADR-0048 §7).
    Shared,
    /// The product's own, as `None`; kept as environments recorded it before
    /// the database followed the product.
    Namespace,
}

/// What runs an environment's products.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentKind {
    /// A Kubernetes cluster the organization reaches through a connection.
    #[default]
    Kubernetes,
    /// A member's Constructor Research, through its integration service
    /// (ADR-0049): a Research project, where each Studio project runs as one
    /// application per environment.
    Research,
}

/// Where in Constructor Research a Research environment runs its products.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchTarget {
    /// The Research project, as the integration service names it.
    pub project: String,
    /// The hardware configuration its services run on; `None` for
    /// Research's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware: Option<String>,
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
    #[serde(default)]
    pub kind: EnvironmentKind,
    /// The cluster: a connection of the `kubernetes` kind the organization
    /// holds; or, for `research`, the `research` connection it signs in with.
    pub connection_id: Uuid,
    /// The Research project and hardware; only for `research`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research: Option<ResearchTarget>,
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
    /// The projects that may deploy here; `None` is all of them. A project's
    /// own environment names none: it is its project's alone.
    #[serde(default)]
    pub projects: Option<Vec<Uuid>>,
    /// The project that keeps this environment (ADR-0054); `None` for one of
    /// the organization's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    /// Whether a project may preview a build here, and how (ADR-0055);
    /// `None` takes no previews.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previews: Option<PreviewSettings>,
    /// How strictly a product is checked for this environment (ADR-0060
    /// §5); `None` follows [`Environment::protected`] ([`Self::strictness`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strictness: Option<Strictness>,
    /// Who builds and pulls here, and where (ADR-0062).
    #[serde(flatten)]
    pub boundaries: Boundaries,
    pub updated_by: String,
    pub updated_at: String,
}

fn default_pattern() -> String {
    DEFAULT_NAMESPACE_PATTERN.to_owned()
}

/// The build namespace pattern an environment gets unless it says otherwise
/// (ADR-0062 §7): one per project, beside its runtime namespaces.
pub const DEFAULT_BUILD_NAMESPACE_PATTERN: &str = "{project}-build";

/// The warning an environment carries while the cluster pulls with the push
/// login: it names no read-only pull identity (ADR-0062 §2).
pub const PULL_USES_PUSH_LOGIN: &str = "PULL_USES_PUSH_LOGIN";

/// What [`PULL_USES_PUSH_LOGIN`] says.
pub const PULL_USES_PUSH_LOGIN_MESSAGE: &str = "the cluster gets a credential that can write: give \
     the environment a read-only pull connection";

/// What separates a project's build from Studio and from its runtime, per
/// environment (ADR-0062): the builder image, the registry identities, the
/// build namespace, and the namespaces a cluster gives when Studio may not
/// make its own. Every field is optional; absent, the platform's default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Boundaries {
    /// The image `prepare` and `publish` run in, by digest
    /// (`registry.acme.example/mirror/studio-builder@sha256:…`): an
    /// organization's mirror of the platform's builder. `None`: the
    /// platform's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_image: Option<String>,
    /// The `registry` connection the builder image is pulled with, when it
    /// is on another registry than the environment's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_registry_connection_id: Option<Uuid>,
    /// A read-only `registry` connection the cluster pulls with. `None`
    /// falls back to [`Environment::registry_connection_id`], which can
    /// write, and the environment says so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_pull_connection_id: Option<Uuid>,
    /// The pattern of the namespace builds run in; `None`:
    /// [`DEFAULT_BUILD_NAMESPACE_PATTERN`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_namespace: Option<String>,
    /// The namespaces the cluster gives Studio when its connection may not
    /// make namespaces: each project is assigned one, by an administrator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespaces: Option<Vec<String>>,
    /// A server build takes a registry token whose scopes reach past pushing
    /// and pulling. Off: refused, `REGISTRY_TOKEN_TOO_BROAD`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_broad_registry_token: bool,
    /// Where a product's infra services run here (ADR-0064 §3); `None`:
    /// with the product.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub infra: Option<super::infra::InfraPlacement>,
}

/// Is `image` an image reference: no scheme, the characters of one.
pub fn is_image_reference(image: &str) -> bool {
    !image.is_empty()
        && !image.contains("://")
        && image.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':' | b'@')
        })
}

/// `input`'s boundaries, checked.
fn check_boundaries(b: &Boundaries, env_name: &str, registry: &str) -> Result<Boundaries, Invalid> {
    let b = b.clone();
    let builder_image = b
        .builder_image
        .map(|i| i.trim().to_owned())
        .filter(|i| !i.is_empty());
    if let Some(image) = &builder_image
        && !is_image_reference(image)
    {
        return Err(invalid(
            "builder_image",
            format!(
                "'{image}' is not an image, e.g. registry.acme.example/studio-builder@sha256:…"
            ),
        ));
    }
    if b.builder_registry_connection_id.is_some() && builder_image.is_none() {
        return Err(invalid(
            "builder_registry_connection_id",
            "a builder's registry connection goes with a builder image of the environment's own",
        ));
    }
    if b.registry_pull_connection_id.is_some() && registry.is_empty() {
        return Err(invalid(
            "registry_pull_connection_id",
            "a pull connection goes with a registry the images are pulled from",
        ));
    }
    let build_namespace = b
        .build_namespace
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty());
    if let Some(p) = &build_namespace {
        if !p.contains("{project}") {
            return Err(invalid(
                "build_namespace",
                "the build namespace pattern must contain {project}: a project's builds are its own",
            ));
        }
        namespace_for(p, "a-project", env_name)
            .map_err(|e| invalid("build_namespace", e.reason))?;
    }
    let namespaces = match b.namespaces {
        None => None,
        Some(list) => {
            let mut out: Vec<String> = list
                .into_iter()
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
                .collect();
            if let Some(bad) = out.iter().find(|n| !is_dns_label(n)) {
                return Err(invalid(
                    "namespaces",
                    format!("'{bad}' is not a Kubernetes namespace"),
                ));
            }
            out.sort();
            out.dedup();
            (!out.is_empty()).then_some(out)
        }
    };
    Ok(Boundaries {
        builder_image,
        builder_registry_connection_id: b.builder_registry_connection_id,
        registry_pull_connection_id: b.registry_pull_connection_id,
        build_namespace,
        namespaces,
        allow_broad_registry_token: b.allow_broad_registry_token,
        infra: b.infra,
    })
}

/// The organization's environments: one metadata row on the organization.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentList {
    #[serde(default)]
    pub items: Vec<Environment>,
    /// The organization's clusters its projects may put environments of
    /// their own on (ADR-0054 §2): `kubernetes` connection ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_clusters: Vec<Uuid>,
}

/// How strictly the engine holds a product to the production rules for an
/// environment (ADR-0060 §5). `dev` checks the profile as a development one
/// -- Gearbox's `development = True`, the production rules' findings as
/// warnings -- so a dev cluster can run static sign-in while it is set up;
/// `prod` holds it to them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strictness {
    Dev,
    Prod,
}

impl Strictness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Prod => "prod",
        }
    }

    /// `dev` or `prod`; anything else is `None`.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "dev" => Some(Self::Dev),
            "prod" => Some(Self::Prod),
            _ => None,
        }
    }
}

/// What a person may set on an environment.
#[derive(Debug, Clone)]
pub struct EnvironmentInput {
    pub name: String,
    pub description: String,
    pub kind: EnvironmentKind,
    pub connection_id: Uuid,
    pub research: Option<ResearchTarget>,
    pub registry: String,
    pub registry_connection_id: Option<Uuid>,
    pub namespace_pattern: Option<String>,
    pub database: DatabaseMode,
    pub database_image: Option<String>,
    pub protected: bool,
    pub promote_from: Option<Uuid>,
    pub projects: Option<Vec<Uuid>>,
    pub previews: Option<PreviewSettings>,
    pub strictness: Option<Strictness>,
    pub boundaries: Boundaries,
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
    let research = check_research(&input, input.registry.trim())?;
    let previews = check_previews(&input)?;
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
            format!("there is already an environment '{name}' here"),
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
    let mut boundaries = check_boundaries(&input.boundaries, &name, &registry)?;
    let dev = input.strictness.unwrap_or(if input.protected {
        Strictness::Prod
    } else {
        Strictness::Dev
    }) == Strictness::Dev;
    boundaries.infra = super::infra::check_placement(boundaries.infra.take(), dev)
        .map_err(|e| invalid("infra", e))?;
    Ok(Environment {
        id: own,
        name,
        description: input.description.trim().to_owned(),
        kind: input.kind,
        connection_id: input.connection_id,
        research,
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
        project_id: None,
        previews,
        strictness: input.strictness,
        boundaries,
        updated_by: by,
        updated_at: at,
    })
}

/// A project's own environment (ADR-0054 §3), checked against every
/// environment the project sees: `admitted`, the organization's that take
/// its deploys, and `own`, its own (`id` is the one being edited, if any).
/// It lists no projects and needs no approval: both are the organization's
/// to say, on an environment of its own.
pub fn checked_for_project(
    admitted: &[Environment],
    own: &[Environment],
    project: Uuid,
    id: Option<Uuid>,
    input: EnvironmentInput,
    by: String,
    at: String,
) -> Result<Environment, Invalid> {
    if input.projects.is_some() {
        return Err(invalid(
            "projects",
            "a project's own environment is its project's alone: it lists no projects",
        ));
    }
    if input.protected {
        return Err(invalid(
            "protected",
            "an environment whose deploys need approval is the organization's: ask an \
             organization administrator for one",
        ));
    }
    let visible = EnvironmentList {
        items: admitted.iter().chain(own).cloned().collect(),
        open_clusters: Vec::new(),
    };
    let mut env = checked(&visible, id, input, by, at)?;
    env.project_id = Some(project);
    Ok(env)
}

/// An environment of the organization that admits `project`, on the same
/// cluster as `env`, that gives the project the same namespace: two releases
/// there would overwrite each other (ADR-0054 §6).
pub fn namespace_clash<'a>(
    env: &Environment,
    admitted: &'a [Environment],
    project_name: &str,
) -> Option<&'a Environment> {
    let ns = namespace_for(&env.namespace_pattern, project_name, &env.name).ok()?;
    admitted.iter().find(|o| {
        o.id != env.id
            && o.kind == EnvironmentKind::Kubernetes
            && o.connection_id == env.connection_id
            && namespace_for(&o.namespace_pattern, project_name, &o.name).ok() == Some(ns.clone())
    })
}

/// A Research environment's target, checked; `None` for a cluster. Research
/// keeps the registry and the namespace itself, and has no shared database
/// server (ADR-0049 §2), so a Research environment names none of them.
fn check_research(
    input: &EnvironmentInput,
    registry: &str,
) -> Result<Option<ResearchTarget>, Invalid> {
    if input.kind == EnvironmentKind::Kubernetes {
        if input.research.is_some() {
            return Err(invalid(
                "research",
                "only a research environment names a Research project",
            ));
        }
        return Ok(None);
    }
    let Some(target) = &input.research else {
        return Err(invalid(
            "research",
            "a research environment names its Research project",
        ));
    };
    let project = target.project.trim().to_owned();
    if project.is_empty() {
        return Err(invalid(
            "research",
            "a research environment names its Research project",
        ));
    }
    if !registry.is_empty() || input.registry_connection_id.is_some() {
        return Err(invalid(
            "registry",
            "Constructor Research keeps the images in its own registry: leave the registry empty",
        ));
    }
    if input.database == DatabaseMode::Shared {
        return Err(invalid(
            "database",
            "Constructor Research has no shared database server: choose none, or the product's own",
        ));
    }
    Ok(Some(ResearchTarget {
        project,
        hardware: target
            .hardware
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(str::to_owned),
    }))
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
    /// How strictly a product is checked here: as set, else `prod` for a
    /// protected environment and `dev` for any other.
    pub fn strictness(&self) -> Strictness {
        self.strictness.unwrap_or(if self.protected {
            Strictness::Prod
        } else {
            Strictness::Dev
        })
    }

    /// May `project` deploy here? A project's own environment takes only
    /// its project's deploys.
    pub fn admits(&self, project: Uuid) -> bool {
        match self.project_id {
            Some(owner) => owner == project,
            None => self.projects.as_ref().is_none_or(|p| p.contains(&project)),
        }
    }

    /// The tenant its connections are found from and read as (ADR-0054 §5):
    /// its project for a project's own environment, so a connection the
    /// project holds is found and the organization's still inherited.
    pub fn connections_from(&self, org: Uuid) -> Uuid {
        self.project_id.unwrap_or(org)
    }

    /// The connection the cluster pulls with: the pull identity, else the
    /// push one (which can write: [`Self::warnings`] says so).
    pub fn pull_connection(&self) -> Option<Uuid> {
        self.boundaries
            .registry_pull_connection_id
            .or(self.registry_connection_id)
    }

    /// What is not wrong enough to refuse but should be fixed, in a
    /// sentence each.
    pub fn warnings(&self) -> Vec<String> {
        self.coded_warnings()
            .into_iter()
            .map(|(_, message)| message.to_owned())
            .collect()
    }

    /// The codes of [`Self::warnings`], in the same order: what a screen
    /// keys a warning on.
    pub fn warning_codes(&self) -> Vec<String> {
        self.coded_warnings()
            .into_iter()
            .map(|(code, _)| code.to_owned())
            .collect()
    }

    fn coded_warnings(&self) -> Vec<(&'static str, &'static str)> {
        let mut out = Vec::new();
        if self.pulls_with_push_login() {
            out.push((PULL_USES_PUSH_LOGIN, PULL_USES_PUSH_LOGIN_MESSAGE));
        }
        out
    }

    /// The cluster pulls with the push login: no pull identity is named, so
    /// [`Self::pull_connection`] falls back to the registry connection.
    pub fn pulls_with_push_login(&self) -> bool {
        self.registry_connection_id.is_some()
            && self.boundaries.registry_pull_connection_id.is_none()
    }

    /// The namespace builds of a project with `slug` run in here.
    pub fn build_namespace_for(&self, slug: &str) -> Result<String, Invalid> {
        let pattern = self
            .boundaries
            .build_namespace
            .as_deref()
            .unwrap_or(DEFAULT_BUILD_NAMESPACE_PATTERN);
        namespace_for(pattern, slug, &self.name).map_err(|e| invalid("build_namespace", e.reason))
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

/// An environment of the project and the product profile it runs
/// (ADR-0057): each environment bound once, a profile to any number of them,
/// so stage and prod may both run `prod`. Rows written when a profile could
/// be bound only once have the same shape and still load.
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
    /// The project's own environments (ADR-0054), kept with its bindings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environments: Vec<Environment>,
    /// How Studio builds the project (ADR-0054 §7): `None` from its
    /// `product.gdl`, on gears; `Some` from the repository's own Dockerfiles
    /// and Helm chart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<OwnBuild>,
    /// The infra services the product runs beside its gears (ADR-0064).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub infra: Vec<super::infra::InfraService>,
    /// The infra services each recent build's lock resolved (ADR-0065 §3),
    /// newest first: what a deploy of that build runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub built_infra: Vec<super::infra::BuiltInfra>,
}

/// A project built without a product description (ADR-0054 §7): the
/// repository's own Dockerfiles, one image each, and its own Helm chart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnBuild {
    pub images: Vec<OwnImage>,
    /// The chart's folder in the repository (`chart/shop`).
    pub chart: String,
}

/// One image of an [`OwnBuild`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnImage {
    /// The application: unless [`Self::values`] says otherwise, a deploy
    /// sets `<app>.image.repository` and `<app>.image.tag`.
    pub app: String,
    /// The image's name under the environment's registry (`shop-api`).
    pub name: String,
    /// The Dockerfile, from the repository's root (`Dockerfile`, `api/Dockerfile`).
    pub dockerfile: String,
    /// The build context, from the repository's root; `.` by default.
    #[serde(default = "default_context")]
    pub context: String,
    /// Where the repository's chart reads this image and its configuration
    /// secret; each path not given is the Gearbox convention.
    #[serde(default, skip_serializing_if = "ValuesPaths::is_default")]
    pub values: ValuesPaths,
}

fn default_context() -> String {
    ".".to_owned()
}

/// Where a chart reads one application's image and configuration secret, as
/// dotted values paths (`backend.image.repository`). A path not given is the
/// convention Gearbox's charts follow: `<app>.image.repository`,
/// `<app>.image.tag`, `<app>.existingSecret`, `<app>.secretKeys`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValuesPaths {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// The whole image as one string (`host/repo:tag@digest`), for a chart
    /// that reads it so; in place of `repository` and `tag`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// The configuration secret's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_name: Option<String>,
    /// The configuration secret's keys, a list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_keys: Option<String>,
}

impl ValuesPaths {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    fn repository_at(&self, app: &str) -> String {
        self.repository
            .clone()
            .unwrap_or_else(|| format!("{app}.image.repository"))
    }

    fn tag_at(&self, app: &str) -> String {
        self.tag
            .clone()
            .unwrap_or_else(|| format!("{app}.image.tag"))
    }

    fn secret_name_at(&self, app: &str) -> String {
        self.secret_name
            .clone()
            .unwrap_or_else(|| format!("{app}.existingSecret"))
    }

    fn secret_keys_at(&self, app: &str) -> String {
        self.secret_keys
            .clone()
            .unwrap_or_else(|| format!("{app}.secretKeys"))
    }

    /// Trimmed, empty ones dropped, each a values path; `image` alone or
    /// `repository` and `tag`; no path named twice.
    fn checked(self, app: &str) -> Result<Self, Invalid> {
        let clean = |p: Option<String>| -> Result<Option<String>, Invalid> {
            match p.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()) {
                None => Ok(None),
                Some(p) if is_values_path(&p) => Ok(Some(p)),
                Some(p) => Err(invalid(
                    "images",
                    format!(
                        "'{p}' ({app}) is not a values path: keys of letters, digits, '_' and \
                         '-' joined by '.', e.g. backend.image.repository"
                    ),
                )),
            }
        };
        let v = Self {
            repository: clean(self.repository)?,
            tag: clean(self.tag)?,
            image: clean(self.image)?,
            secret_name: clean(self.secret_name)?,
            secret_keys: clean(self.secret_keys)?,
        };
        if v.image.is_some() && (v.repository.is_some() || v.tag.is_some()) {
            return Err(invalid(
                "images",
                format!(
                    "{app}: the chart reads its image as one string or as repository and tag, \
                     not both"
                ),
            ));
        }
        let image_paths = match &v.image {
            Some(i) => vec![i.clone()],
            None => vec![v.repository_at(app), v.tag_at(app)],
        };
        let mut seen = std::collections::BTreeSet::new();
        for p in image_paths
            .into_iter()
            .chain([v.secret_name_at(app), v.secret_keys_at(app)])
        {
            if !seen.insert(p.clone()) {
                return Err(invalid(
                    "images",
                    format!("{app}: values path '{p}' is named twice"),
                ));
            }
        }
        Ok(v)
    }
}

/// A dotted values path: at most 12 keys of `[A-Za-z0-9_-]`.
pub fn is_values_path(p: &str) -> bool {
    p.len() <= 200
        && p.split('.').count() <= 12
        && p.split('.').all(|k| {
            !k.is_empty()
                && k.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

/// `v` laid at the dotted `path` of `values`.
fn set_path(values: &mut serde_json::Value, path: &str, v: serde_json::Value) {
    let mut over = v;
    for key in path.rsplit('.') {
        over = serde_json::json!({ key: over });
    }
    merge(values, over);
}

/// A path inside the repository: relative, no `..`, no backslash.
fn is_repo_path(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && !p.contains('\\')
        && !p.contains(':')
        && p.split('/').all(|seg| seg != "..")
}

/// An [`OwnBuild`] as written, checked; paths normalised.
pub fn checked_own_build(mut b: OwnBuild) -> Result<OwnBuild, Invalid> {
    if b.images.is_empty() {
        return Err(invalid(
            "images",
            "a build of the repository's own names at least one Dockerfile",
        ));
    }
    if b.images.len() > 20 {
        return Err(invalid("images", "at most 20 images"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for i in &mut b.images {
        i.app = i.app.trim().to_owned();
        i.name = i.name.trim().to_owned();
        i.dockerfile = i.dockerfile.trim().trim_start_matches("./").to_owned();
        i.context = match i
            .context
            .trim()
            .trim_start_matches("./")
            .trim_end_matches('/')
        {
            "" => ".".to_owned(),
            c => c.to_owned(),
        };
        if !is_dns_label(&i.app) {
            return Err(invalid(
                "images",
                format!(
                    "'{}' is not a values key: lowercase letters, digits and '-'",
                    i.app
                ),
            ));
        }
        if !seen.insert(i.app.clone()) {
            return Err(invalid("images", format!("'{}' is named twice", i.app)));
        }
        let name_ok = !i.name.is_empty()
            && i.name.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'-' | b'_' | b'.' | b'/')
            })
            && !i.name.starts_with('/')
            && !i.name.ends_with('/');
        if !name_ok {
            return Err(invalid(
                "images",
                format!("'{}' is not an image name, e.g. shop-api", i.name),
            ));
        }
        if !is_repo_path(&i.dockerfile) {
            return Err(invalid(
                "images",
                format!("'{}' is not a Dockerfile in the repository", i.dockerfile),
            ));
        }
        if i.context != "." && !is_repo_path(&i.context) {
            return Err(invalid(
                "images",
                format!("'{}' is not a folder in the repository", i.context),
            ));
        }
        i.values = std::mem::take(&mut i.values).checked(&i.app)?;
    }
    b.chart = b
        .chart
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_owned();
    if !is_repo_path(&b.chart) {
        return Err(invalid(
            "chart",
            "the chart is the folder of a Helm chart in the repository, e.g. chart/shop",
        ));
    }
    Ok(b)
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
/// A repository's own build (`own`) names where its chart reads them.
pub fn deploy_values(
    env: &Environment,
    images: &[DeployImage],
    binding: Option<&serde_json::Value>,
    secret_keys: &[String],
    release: &str,
    own: Option<&OwnBuild>,
) -> serde_json::Value {
    let mut values = binding
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    merge(&mut values, image_values(env, images, own));
    if !secret_keys.is_empty() {
        for i in images.iter().filter(|i| !is_generated_ui(i)) {
            let paths = paths_of(&i.app, own);
            set_path(
                &mut values,
                &paths.secret_name_at(&i.app),
                config_secret_name(release).into(),
            );
            set_path(
                &mut values,
                &paths.secret_keys_at(&i.app),
                serde_json::json!(secret_keys),
            );
        }
    }
    values
}

/// Where `own`'s chart reads application `app`; the convention otherwise.
fn paths_of(app: &str, own: Option<&OwnBuild>) -> ValuesPaths {
    own.and_then(|o| o.images.iter().find(|i| i.app == app))
        .map(|i| i.values.clone())
        .unwrap_or_default()
}

/// Bindings as written: each environment once (it runs one profile), each a
/// profile id, values an object of a sane size. A profile may be bound to
/// many environments (ADR-0057).
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
        if !seen.insert(b.environment_id) {
            return Err(invalid(
                "environment_id",
                format!("environment {} is bound twice", b.environment_id),
            ));
        }
    }
    Ok(BindingList {
        items,
        secrets: Vec::new(),
        environments: Vec::new(),
        build: None,
        infra: Vec::new(),
        built_infra: Vec::new(),
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
    /// The digest the build pushed it as (`sha256:…`): a deploy of the build
    /// installs exactly that, whatever the version names by then. Absent for
    /// a chart a person names, and a build that recorded none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
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
        digest: None,
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
    /// The chart's sha256, so a record says which chart it installed: an
    /// uploaded chart's, or the digest a build pushed its published chart as
    /// (hex, without `sha256:`); empty for a chart named by reference alone,
    /// which [`Self::chart_ref`] says.
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
    /// For a Constructor Research environment: what the run prepares and
    /// where it puts the application (ADR-0049 §4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research: Option<super::research::ResearchDeploy>,
    /// A preview (ADR-0055): until when, where it answers, whether it is
    /// gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<Preview>,
    /// What the deploy said when it was asked and goes on with, `CODE:
    /// message` each: a configuration secret the description wins over
    /// (`CONFIG_SECRET_SHADOWED_BY_DESCRIPTION`), an issuer pods may not
    /// reach (`INFRA_ISSUER_UNREACHABLE_IN_CLUSTER`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
            // A preview there is not what runs there (ADR-0055).
            && p.preview.is_none()
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

/// How long a preview lives unless the environment says otherwise.
pub const PREVIEW_TTL_HOURS: u32 = 72;
/// The longest an environment may let a preview live: two weeks.
pub const MAX_PREVIEW_TTL_HOURS: u32 = 14 * 24;
/// How many previews a project may keep in an environment at once unless
/// the environment says otherwise.
pub const PREVIEW_MAX_LIVE: u32 = 3;
/// The most an environment may allow.
pub const MAX_PREVIEW_MAX_LIVE: u32 = 20;
/// A preview's name is short: it goes into the namespace after the
/// project's own, and the namespace into the host.
pub const MAX_PREVIEW_NAME: usize = 20;

/// What an environment says of previews (ADR-0055).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewSettings {
    /// A domain whose every name reaches the cluster's ingress controller
    /// (a wildcard DNS record): a preview answers at `<namespace>.<domain>`.
    /// Empty: previews get no address and are reached by port-forward.
    #[serde(default)]
    pub domain: String,
    /// The `ingressClassName` a preview's Ingress asks for; `None` for the
    /// cluster's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingress_class: Option<String>,
    /// How long a preview lives before the sweep removes it.
    #[serde(default = "default_preview_ttl")]
    pub ttl_hours: u32,
    /// How many previews one project may keep here at once.
    #[serde(default = "default_preview_max_live")]
    pub max_live: u32,
}

fn default_preview_ttl() -> u32 {
    PREVIEW_TTL_HOURS
}

fn default_preview_max_live() -> u32 {
    PREVIEW_MAX_LIVE
}

/// Is `s` a DNS name: dot-separated labels, at most 253 characters?
pub(super) fn is_dns_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && s.split('.').all(is_dns_label)
}

/// An environment's preview settings, checked. A preview is a namespace of
/// its own on a cluster, so a Research environment takes none, and a
/// protected one none either: a preview nobody may approve in time is no
/// preview.
fn check_previews(input: &EnvironmentInput) -> Result<Option<PreviewSettings>, Invalid> {
    let Some(p) = &input.previews else {
        return Ok(None);
    };
    if input.kind == EnvironmentKind::Research {
        return Err(invalid(
            "previews",
            "a preview is a namespace of its own on a cluster: Constructor Research takes none",
        ));
    }
    if input.protected {
        return Err(invalid(
            "previews",
            "a protected environment takes no previews: its deploys wait for approval",
        ));
    }
    let domain = p.domain.trim().trim_matches('.').to_ascii_lowercase();
    if !domain.is_empty() && !is_dns_name(&domain) {
        return Err(invalid(
            "preview_domain",
            format!("'{domain}' is not a domain, e.g. preview.example.com"),
        ));
    }
    let ingress_class = p
        .ingress_class
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    if let Some(class) = &ingress_class
        && !is_dns_name(class)
    {
        return Err(invalid(
            "preview_ingress_class",
            format!("'{class}' is not an ingress class name"),
        ));
    }
    if !(1..=MAX_PREVIEW_TTL_HOURS).contains(&p.ttl_hours) {
        return Err(invalid(
            "preview_ttl_hours",
            format!("a preview lives from 1 to {MAX_PREVIEW_TTL_HOURS} hours"),
        ));
    }
    if !(1..=MAX_PREVIEW_MAX_LIVE).contains(&p.max_live) {
        return Err(invalid(
            "preview_max_live",
            format!("a project keeps from 1 to {MAX_PREVIEW_MAX_LIVE} previews at once"),
        ));
    }
    Ok(Some(PreviewSettings {
        domain,
        ingress_class,
        ttl_hours: p.ttl_hours,
        max_live: p.max_live,
    }))
}

/// A preview: a deploy into a namespace of its own that the sweep removes,
/// namespace and all, once it expires or somebody removes it (ADR-0055).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preview {
    /// What distinguishes it from the project's other previews there.
    pub name: String,
    /// RFC 3339.
    pub expires_at: String,
    /// Where it answers; `None` when the environment has no preview domain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The cluster it was installed with, so its removal needs nothing that
    /// could have changed or gone since: the environment may be edited or
    /// removed while the preview lives.
    pub connection_id: Uuid,
    /// The tenant that connection is found from (ADR-0054 §5); `None` for
    /// the organization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections_from: Option<Uuid>,
    /// When the sweep removed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<String>,
    /// Why the last attempt to remove it failed; the next sweep tries again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removal_error: Option<String>,
}

impl Deployment {
    /// A preview whose namespace may still be there: not removed yet,
    /// whatever its install came to (a failed one leaves its namespace too).
    pub fn is_live_preview(&self) -> bool {
        self.preview
            .as_ref()
            .is_some_and(|p| p.removed_at.is_none())
    }

    /// A live preview that has expired by `now`.
    pub fn preview_due(&self, now: time::OffsetDateTime) -> bool {
        self.is_live_preview()
            && self.preview.as_ref().is_some_and(|p| {
                time::OffsetDateTime::parse(
                    &p.expires_at,
                    &time::format_description::well_known::Rfc3339,
                )
                // An expiry nobody can read is not kept for ever.
                .map_or(true, |at| at <= now)
            })
    }
}

/// The name a preview gets: the one asked for, or one made of the
/// deployment's id. Lowercase letters, digits and `-`, at most
/// [`MAX_PREVIEW_NAME`].
pub fn preview_name(asked: Option<&str>, id: Uuid) -> Result<String, Invalid> {
    let Some(asked) = asked.map(str::trim).filter(|a| !a.is_empty()) else {
        return Ok(format!("p{}", &id.simple().to_string()[..6]));
    };
    let name = asked.to_ascii_lowercase();
    if !is_dns_label(&name) || name.len() > MAX_PREVIEW_NAME {
        return Err(invalid(
            "preview_name",
            format!(
                "a preview's name is lowercase letters, digits and '-', at most \
                 {MAX_PREVIEW_NAME} (pr-42, login-fix)"
            ),
        ));
    }
    Ok(name)
}

/// The namespace of a preview: the project's namespace there, `-pv-`, its
/// name. Never the project's own namespace, so removing it never touches
/// what the environment runs.
pub fn preview_namespace(base: &str, name: &str) -> Result<String, Invalid> {
    let ns = format!("{base}-pv-{name}");
    if !is_dns_label(&ns) {
        return Err(invalid(
            "preview_name",
            format!(
                "namespace '{ns}' would be longer than 63 characters: choose a shorter preview \
                 name"
            ),
        ));
    }
    Ok(ns)
}

/// Where a preview in `namespace` answers: `<namespace>.<domain>`, when the
/// environment has a preview domain.
pub fn preview_host(settings: &PreviewSettings, namespace: &str) -> Option<String> {
    (!settings.domain.is_empty()).then(|| format!("{namespace}.{}", settings.domain))
}

/// Why `project` may not have one more preview in `env`: one of that name is
/// still there, or it already keeps as many as the environment allows.
pub fn preview_refusal(
    settings: &PreviewSettings,
    history: &[Deployment],
    project: Uuid,
    env: Uuid,
    name: &str,
) -> Option<String> {
    let live: Vec<&Deployment> = history
        .iter()
        .filter(|d| d.project_id == project && d.environment_id == env && d.is_live_preview())
        .collect();
    if live
        .iter()
        .any(|d| d.preview.as_ref().is_some_and(|p| p.name == name))
    {
        return Some(format!(
            "the project already has a preview '{name}' here: remove it first, or name this one \
             otherwise"
        ));
    }
    (live.len() >= settings.max_live as usize).then(|| {
        format!(
            "the project keeps {} previews here, as many as the environment allows: remove one \
             first",
            live.len()
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
    /// The deployment already waiting for a decision that `d` would repeat:
    /// the same project, environment and action, a preview or not alike,
    /// and the same release (the same build, when both name one).
    pub fn waiting_like(&self, d: &Deployment) -> Option<Uuid> {
        self.items
            .iter()
            .find(|x| {
                x.id != d.id
                    && x.state == DeploymentState::AwaitingApproval
                    && x.project_id == d.project_id
                    && x.environment_id == d.environment_id
                    && x.action == d.action
                    && x.preview.is_some() == d.preview.is_some()
                    && x.same_release(d)
            })
            .map(|x| x.id)
    }

    /// Put `d` first and trim the history to [`HISTORY`], keeping the latest
    /// deployment of every project and environment (a preview is not what
    /// runs there), every one still waiting for a decision, and every
    /// preview not yet removed, which the sweep must still find.
    pub fn record(&mut self, d: Deployment) {
        self.items.retain(|x| x.id != d.id);
        self.items.insert(0, d);
        let mut latest = std::collections::BTreeSet::new();
        let mut kept = 0usize;
        self.items.retain(|x| {
            let first = x.preview.is_none() && latest.insert((x.project_id, x.environment_id));
            let keep = first
                || x.state == DeploymentState::AwaitingApproval
                || x.is_live_preview()
                || kept < HISTORY;
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
pub fn image_values(
    env: &Environment,
    images: &[DeployImage],
    own: Option<&OwnBuild>,
) -> serde_json::Value {
    let mut values = serde_json::json!({});
    if env.registry_connection_id.is_some() {
        values["global"] = serde_json::json!({ "imagePullSecrets": [PULL_SECRET_NAME] });
    }
    for i in images {
        let full = env.image(&i.image);
        if is_generated_ui(i) {
            set_path(&mut values, &format!("{}.image", i.app), full.into());
            continue;
        }
        let paths = paths_of(&i.app, own);
        if let Some(at) = &paths.image {
            set_path(&mut values, at, full.into());
            continue;
        }
        let (repository, tag) = split_image(&full);
        set_path(&mut values, &paths.repository_at(&i.app), repository.into());
        if let Some(tag) = tag {
            set_path(&mut values, &paths.tag_at(&i.app), tag.into());
        }
    }
    values
}

/// A generated product's UI image: Gearbox's chart reads it as one string,
/// `ui.image`, and takes no configuration secret (its values allow nothing
/// else). Told apart from a repository's own `ui` image by Gearbox's `gbx-`
/// image names.
fn is_generated_ui(i: &DeployImage) -> bool {
    i.app == super::build::UI_APP
        && i.image
            .rsplit('/')
            .next()
            .is_some_and(|name| name.starts_with("gbx-"))
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

/// An image of a deploy as the project's own path holds it (ADR-0062 §4):
/// a bare name (`gbx-api:1`) is put under it; one already under it stays;
/// anything else -- another project's path, an external registry -- is
/// refused, since a deploy takes only images in the organization's registry
/// under the project's path. An external image is imported first.
pub fn project_image(
    env: &Environment,
    project_prefix: &str,
    image: &str,
) -> Result<String, Invalid> {
    if env.registry.is_empty() {
        return Ok(image.to_owned());
    }
    if super::images::is_under(image, project_prefix) {
        return Ok(image.to_owned());
    }
    let first = image.split('/').next().unwrap_or_default();
    let has_host =
        image.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost");
    if has_host || image.starts_with(&format!("{}/", env.registry)) {
        return Err(invalid(
            "images",
            format!(
                "'{image}' is not under the project's path {project_prefix}: a deploy takes only \
                 images in the organization's registry -- import an external image into the \
                 project first (IMAGE_NOT_IN_PROJECT_PATH)"
            ),
        ));
    }
    Ok(format!("{project_prefix}/{image}"))
}

/// A published chart a deploy names must be under the project's own path.
pub fn check_chart_in_project(chart: &ChartRef, project_prefix: &str) -> Result<(), Invalid> {
    if super::images::is_under(&chart.reference, project_prefix) {
        Ok(())
    } else {
        Err(invalid(
            "chart_ref",
            format!(
                "'{}' is not under the project's path {project_prefix} (IMAGE_NOT_IN_PROJECT_PATH)",
                chart.reference
            ),
        ))
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
            kind: EnvironmentKind::Kubernetes,
            connection_id: Uuid::from_u128(7),
            research: None,
            registry: "ghcr.io/acme/".into(),
            registry_connection_id: None,
            namespace_pattern: None,
            database: DatabaseMode::None,
            database_image: None,
            protected: false,
            promote_from: None,
            projects: None,
            previews: None,
            strictness: None,
            boundaries: Boundaries::default(),
        }
    }

    #[test]
    fn a_projects_images_are_its_own_path_and_nothing_else() {
        let e = env("dev");
        let own = "ghcr.io/acme/shop";
        assert_eq!(
            project_image(&e, own, "gbx-api:1").unwrap(),
            "ghcr.io/acme/shop/gbx-api:1"
        );
        assert_eq!(
            project_image(&e, own, "ghcr.io/acme/shop/api@sha256:1").unwrap(),
            "ghcr.io/acme/shop/api@sha256:1"
        );
        for bad in [
            "ghcr.io/acme/other/api:1",
            "ghcr.io/acme/api:1",
            "docker.io/library/postgres:16",
            "quay.io/x/y",
        ] {
            assert!(project_image(&e, own, bad).is_err(), "{bad}");
        }
        let chart = ChartRef {
            reference: "oci://ghcr.io/acme/charts/shop".into(),
            version: "1".into(),
            digest: None,
        };
        assert!(check_chart_in_project(&chart, own).is_err());
        let chart = ChartRef {
            reference: "oci://ghcr.io/acme/shop/charts/shop".into(),
            version: "1".into(),
            digest: None,
        };
        assert!(check_chart_in_project(&chart, own).is_ok());
    }

    #[test]
    fn an_environment_says_when_the_cluster_pulls_with_a_writing_credential() {
        let mut e = env("dev");
        assert!(
            e.warnings().is_empty(),
            "no registry, nothing pulled with it"
        );
        e.registry_connection_id = Some(Uuid::from_u128(1));
        assert_eq!(e.pull_connection(), Some(Uuid::from_u128(1)));
        assert!(e.warnings()[0].contains("can write"));
        assert_eq!(e.warning_codes(), [PULL_USES_PUSH_LOGIN]);
        assert!(e.pulls_with_push_login());
        e.boundaries.registry_pull_connection_id = Some(Uuid::from_u128(2));
        assert_eq!(e.pull_connection(), Some(Uuid::from_u128(2)));
        assert!(e.warnings().is_empty());
        assert!(e.warning_codes().is_empty());
        assert!(!e.pulls_with_push_login());
        assert_eq!(e.build_namespace_for("shop").unwrap(), "shop-build");
    }

    #[test]
    fn boundaries_are_checked_as_they_are_written() {
        let mut i = input("dev");
        i.boundaries.build_namespace = Some("builds".into());
        let e = checked(
            &EnvironmentList::default(),
            None,
            i,
            String::new(),
            "t".into(),
        )
        .unwrap_err();
        assert_eq!(e.field, "build_namespace");
        let mut i = input("dev");
        i.boundaries.namespaces = Some(vec!["Shop_Dev".into()]);
        let e = checked(
            &EnvironmentList::default(),
            None,
            i,
            String::new(),
            "t".into(),
        )
        .unwrap_err();
        assert_eq!(e.field, "namespaces");
        let mut i = input("dev");
        i.boundaries.builder_image = Some(" mirror.acme.example/studio-builder@sha256:ab ".into());
        i.boundaries.namespaces = Some(vec!["shop-dev".into(), "shop-dev".into()]);
        let e = checked(
            &EnvironmentList::default(),
            None,
            i,
            String::new(),
            "t".into(),
        )
        .unwrap();
        assert_eq!(
            e.boundaries.builder_image.as_deref(),
            Some("mirror.acme.example/studio-builder@sha256:ab")
        );
        assert_eq!(e.boundaries.namespaces, Some(vec!["shop-dev".to_owned()]));
        let json = serde_json::to_value(&e).unwrap();
        assert!(
            json.get("allow_broad_registry_token").is_none(),
            "off is not written"
        );
        let back: Environment = serde_json::from_value(json).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn a_protected_environment_is_checked_by_prod_rules_and_another_by_dev_ones() {
        let mut e = env("dev");
        assert_eq!(e.strictness(), Strictness::Dev);
        e.protected = true;
        assert_eq!(e.strictness(), Strictness::Prod);
        e.strictness = Some(Strictness::Dev);
        assert_eq!(e.strictness(), Strictness::Dev, "set, it is what was set");
        assert_eq!(Strictness::parse("prod"), Some(Strictness::Prod));
        assert_eq!(Strictness::parse("strict"), None);
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["strictness"], "dev");
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
            ..Default::default()
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
    fn a_release_waits_for_a_decision_once_per_environment() {
        let waiting = |n: u128, build: &str| {
            let mut d = deployment(n, 1, DeploymentState::AwaitingApproval);
            d.build = Some(build.into());
            d
        };
        let mut list = DeploymentList::default();
        list.record(waiting(1, "b-1"));
        assert_eq!(
            list.waiting_like(&waiting(2, "b-1")),
            Some(Uuid::from_u128(1))
        );
        assert_eq!(list.waiting_like(&waiting(1, "b-1")), None, "not itself");
        assert_eq!(list.waiting_like(&waiting(2, "b-2")), None, "another build");
        let mut elsewhere = waiting(2, "b-1");
        elsewhere.environment_id = Uuid::from_u128(10);
        assert_eq!(list.waiting_like(&elsewhere), None, "another environment");
        let mut other_project = waiting(2, "b-1");
        other_project.project_id = Uuid::from_u128(3);
        assert_eq!(list.waiting_like(&other_project), None);
        // Once decided, the release may be asked for again.
        let mut decided = waiting(1, "b-1");
        decided.state = DeploymentState::Succeeded;
        list.record(decided);
        assert_eq!(list.waiting_like(&waiting(2, "b-1")), None);
    }

    #[test]
    fn without_builds_a_release_is_its_chart_and_images() {
        let mut a = placed(DeploymentState::Succeeded, Uuid::from_u128(2));
        a.chart_ref = Some(ChartRef {
            reference: "oci://r/p".into(),
            version: "1".into(),
            digest: None,
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
            None,
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
        let plain = deploy_values(&e, &images, None, &[], "shop", None);
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
        let v = image_values(&e, &[], None);
        assert!(v.get("global").is_none(), "no login, no pull secret");
        e.registry_connection_id = Some(Uuid::from_u128(9));
        let v = image_values(&e, &[], None);
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
            ..Default::default()
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
    fn a_generated_ui_image_is_one_string_and_takes_no_secret() {
        let e = env("prod");
        let images = [
            DeployImage {
                app: "api".into(),
                image: "studio/gbx-api:sha-1".into(),
            },
            DeployImage {
                app: "ui".into(),
                image: "studio/gbx-shop-frontend:sha-1".into(),
            },
        ];
        let v = deploy_values(&e, &images, None, &["K".into()], "shop", None);
        assert_eq!(
            v["ui"],
            serde_json::json!({ "image": "ghcr.io/acme/studio/gbx-shop-frontend:sha-1" })
        );
        assert_eq!(v["api"]["existingSecret"], "shop-config");
        // A repository's own `ui` image keeps the usual keys.
        let own = image_values(
            &e,
            &[DeployImage {
                app: "ui".into(),
                image: "studio/web:1".into(),
            }],
            None,
        );
        assert_eq!(own["ui"]["image"]["repository"], "ghcr.io/acme/studio/web");
    }

    fn own_image(app: &str, values: ValuesPaths) -> OwnImage {
        OwnImage {
            app: app.into(),
            name: format!("shop-{app}"),
            dockerfile: "Dockerfile".into(),
            context: ".".into(),
            values,
        }
    }

    #[test]
    fn an_own_build_lays_images_and_its_secret_where_its_chart_reads_them() {
        let e = env("prod");
        let own = OwnBuild {
            images: vec![
                own_image(
                    "api",
                    ValuesPaths {
                        repository: Some("backend.container.repo".into()),
                        tag: Some("backend.container.version".into()),
                        secret_name: Some("backend.envFrom.secret".into()),
                        secret_keys: Some("backend.envFrom.keys".into()),
                        ..ValuesPaths::default()
                    },
                ),
                own_image(
                    "web",
                    ValuesPaths {
                        image: Some("frontend.image".into()),
                        ..ValuesPaths::default()
                    },
                ),
                own_image("worker", ValuesPaths::default()),
            ],
            chart: "chart/shop".into(),
        };
        let images = [
            DeployImage {
                app: "api".into(),
                image: "shop/api:sha-1@sha256:aa".into(),
            },
            DeployImage {
                app: "web".into(),
                image: "shop/web:sha-1".into(),
            },
            DeployImage {
                app: "worker".into(),
                image: "shop/worker:sha-1".into(),
            },
        ];
        let v = deploy_values(&e, &images, None, &["K".into()], "shop", Some(&own));
        assert_eq!(v["backend"]["container"]["repo"], "ghcr.io/acme/shop/api");
        assert_eq!(v["backend"]["container"]["version"], "sha-1@sha256:aa");
        assert_eq!(v["backend"]["envFrom"]["secret"], "shop-config");
        assert_eq!(v["backend"]["envFrom"]["keys"][0], "K");
        assert!(v.get("api").is_none(), "nothing at the convention's keys");
        assert_eq!(v["frontend"]["image"], "ghcr.io/acme/shop/web:sha-1");
        assert_eq!(v["web"]["existingSecret"], "shop-config");
        // An image that names no paths keeps Gearbox's convention.
        assert_eq!(v["worker"]["image"]["tag"], "sha-1");
        assert_eq!(v["worker"]["secretKeys"][0], "K");
    }

    #[test]
    fn an_own_builds_values_paths_are_checked() {
        let build = |values: ValuesPaths| OwnBuild {
            images: vec![own_image("api", values)],
            chart: "chart".into(),
        };
        let ok = checked_own_build(build(ValuesPaths {
            repository: Some(" backend.image.repo ".into()),
            tag: Some("  ".into()),
            ..ValuesPaths::default()
        }))
        .unwrap();
        assert_eq!(
            ok.images[0].values.repository.as_deref(),
            Some("backend.image.repo")
        );
        assert_eq!(
            ok.images[0].values.tag, None,
            "an empty path is the default"
        );
        for bad in [
            ValuesPaths {
                repository: Some("a..b".into()),
                ..ValuesPaths::default()
            },
            ValuesPaths {
                image: Some("a.b".into()),
                tag: Some("a.c".into()),
                ..ValuesPaths::default()
            },
            ValuesPaths {
                repository: Some("x.y".into()),
                tag: Some("x.y".into()),
                ..ValuesPaths::default()
            },
            ValuesPaths {
                secret_name: Some("a b".into()),
                ..ValuesPaths::default()
            },
        ] {
            assert!(checked_own_build(build(bad.clone())).is_err(), "{bad:?}");
        }
        // Written without paths, an image reads as it always did.
        let old: OwnImage =
            serde_json::from_str(r#"{"app":"api","name":"x","dockerfile":"Dockerfile"}"#).unwrap();
        assert!(old.values.is_default());
        assert!(!serde_json::to_string(&old).unwrap().contains("values"));
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
            None,
        );
        assert_eq!(v["api"]["image"]["repository"], "ghcr.io/acme/studio/api");
        assert_eq!(v["api"]["image"]["tag"], "0.1.0");
        assert_eq!(
            split_image("localhost:5000/api"),
            ("localhost:5000/api".into(), None)
        );
    }

    #[test]
    fn an_environment_is_bound_once_and_a_profile_to_many() {
        let b = |p: &str, env: u128| Binding {
            profile: p.into(),
            environment_id: Uuid::from_u128(env),
            values: None,
        };
        // Stage and prod both run `prod`.
        assert!(checked_bindings(vec![b("prod", 1), b("prod", 2)]).is_ok());
        assert_eq!(
            checked_bindings(vec![b("prod", 1), b("stage", 1)])
                .unwrap_err()
                .field,
            "environment_id"
        );
        assert!(checked_bindings(vec![b("pr od", 1)]).is_err());
    }

    #[test]
    fn bindings_written_one_per_profile_still_load() {
        let row = serde_json::json!({
            "items": [
                {"profile": "prod", "environment_id": Uuid::from_u128(1)},
                {"profile": "stage", "environment_id": Uuid::from_u128(2), "values": {"a": 1}}
            ]
        });
        let list: BindingList = serde_json::from_value(row).unwrap();
        assert_eq!(list.items.len(), 2);
        assert_eq!(list.items[1].profile, "stage");
        assert!(checked_bindings(list.items).is_ok());
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
            research: None,
            preview: None,
            warnings: Vec::new(),
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

    #[test]
    fn a_research_environment_names_its_project_and_no_registry() {
        let research = |project: &str| EnvironmentInput {
            kind: EnvironmentKind::Research,
            registry: String::new(),
            research: Some(ResearchTarget {
                project: project.into(),
                hardware: Some(" ".into()),
            }),
            ..input("research")
        };
        let e = checked(
            &EnvironmentList::default(),
            None,
            research(" ml-team "),
            String::new(),
            String::new(),
        )
        .expect("a research environment");
        assert_eq!(e.kind, EnvironmentKind::Research);
        assert_eq!(
            e.research,
            Some(ResearchTarget {
                project: "ml-team".into(),
                hardware: None
            })
        );

        let no_project = checked(
            &EnvironmentList::default(),
            None,
            research(""),
            String::new(),
            String::new(),
        );
        assert_eq!(no_project.unwrap_err().field, "research");
        let with_registry = EnvironmentInput {
            registry: "ghcr.io/acme".into(),
            ..research("ml-team")
        };
        let refused = checked(
            &EnvironmentList::default(),
            None,
            with_registry,
            String::new(),
            String::new(),
        );
        assert_eq!(refused.unwrap_err().field, "registry");
        let shared = EnvironmentInput {
            database: DatabaseMode::Shared,
            ..research("ml-team")
        };
        let refused = checked(
            &EnvironmentList::default(),
            None,
            shared,
            String::new(),
            String::new(),
        );
        assert_eq!(refused.unwrap_err().field, "database");

        let stray = EnvironmentInput {
            research: research("x").research,
            ..input("dev")
        };
        let refused = checked(
            &EnvironmentList::default(),
            None,
            stray,
            String::new(),
            String::new(),
        );
        assert_eq!(refused.unwrap_err().field, "research");
    }

    #[test]
    fn an_environment_written_before_kinds_reads_as_a_cluster() {
        let old = serde_json::json!({
            "id": Uuid::from_u128(1), "name": "dev", "connection_id": Uuid::from_u128(7),
            "updated_by": "", "updated_at": "",
        });
        let e: Environment = serde_json::from_value(old).unwrap();
        assert_eq!(e.kind, EnvironmentKind::Kubernetes);
        assert!(e.research.is_none());
        assert!(serde_json::to_value(&e).unwrap().get("research").is_none());
    }

    #[test]
    fn a_projects_own_environment_is_its_alone_and_never_protected() {
        let project = Uuid::from_u128(5);
        let other = Uuid::from_u128(6);
        let org_dev = env("dev");
        let mine = checked_for_project(
            std::slice::from_ref(&org_dev),
            &[],
            project,
            None,
            input("sandbox"),
            String::new(),
            "t".into(),
        )
        .unwrap();
        assert_eq!(mine.project_id, Some(project));
        assert!(mine.admits(project));
        assert!(!mine.admits(other));
        assert_eq!(mine.connections_from(Uuid::from_u128(1)), project);
        assert_eq!(
            org_dev.connections_from(Uuid::from_u128(1)),
            Uuid::from_u128(1)
        );

        // A name the project already sees, the organization's or its own.
        let taken = |name: &str| {
            checked_for_project(
                std::slice::from_ref(&org_dev),
                std::slice::from_ref(&mine),
                project,
                None,
                input(name),
                String::new(),
                "t".into(),
            )
            .unwrap_err()
            .field
        };
        assert_eq!(taken("dev"), "name");
        assert_eq!(taken("sandbox"), "name");

        let mut protected = input("prod");
        protected.protected = true;
        let mut listing = input("qa");
        listing.projects = Some(vec![other]);
        for (i, field) in [(protected, "protected"), (listing, "projects")] {
            assert_eq!(
                checked_for_project(&[], &[], project, None, i, String::new(), "t".into())
                    .unwrap_err()
                    .field,
                field
            );
        }

        // It may take releases from the organization's environment it sees.
        let mut promoted = input("stage");
        promoted.promote_from = Some(org_dev.id);
        assert!(
            checked_for_project(
                std::slice::from_ref(&org_dev),
                &[],
                project,
                None,
                promoted,
                String::new(),
                "t".into()
            )
            .is_ok()
        );
    }

    #[test]
    fn a_build_of_the_repositorys_own_stays_in_the_repository() {
        let image = |app: &str, dockerfile: &str, context: &str| OwnImage {
            app: app.into(),
            name: "shop-api".into(),
            dockerfile: dockerfile.into(),
            context: context.into(),
            values: ValuesPaths::default(),
        };
        let ok = checked_own_build(OwnBuild {
            images: vec![image("api", "./api/Dockerfile", "./")],
            chart: "./chart/shop/".into(),
        })
        .unwrap();
        assert_eq!(ok.images[0].dockerfile, "api/Dockerfile");
        assert_eq!(ok.images[0].context, ".");
        assert_eq!(ok.chart, "chart/shop");
        for bad in [
            OwnBuild {
                images: vec![],
                chart: "chart".into(),
            },
            OwnBuild {
                images: vec![image("api", "../Dockerfile", ".")],
                chart: "chart".into(),
            },
            OwnBuild {
                images: vec![image("api", "Dockerfile", "/etc")],
                chart: "chart".into(),
            },
            OwnBuild {
                images: vec![image("API", "Dockerfile", ".")],
                chart: "chart".into(),
            },
            OwnBuild {
                images: vec![
                    image("api", "Dockerfile", "."),
                    image("api", "x/Dockerfile", "."),
                ],
                chart: "chart".into(),
            },
            OwnBuild {
                images: vec![image("api", "Dockerfile", ".")],
                chart: "../chart".into(),
            },
        ] {
            assert!(checked_own_build(bad).is_err());
        }
    }

    #[test]
    fn a_project_environment_may_not_take_the_namespace_of_an_organization_one() {
        let org_dev = env("dev");
        let mut i = input("dev2");
        i.namespace_pattern = Some("{project}-dev".into());
        let mine = checked_for_project(
            &[],
            &[],
            Uuid::from_u128(5),
            None,
            i,
            String::new(),
            "t".into(),
        )
        .unwrap();
        let admitted = [org_dev.clone()];
        assert_eq!(
            namespace_clash(&mine, &admitted, "Shop").map(|e| e.id),
            Some(org_dev.id)
        );
        let mut elsewhere = mine.clone();
        elsewhere.connection_id = Uuid::from_u128(8);
        assert!(namespace_clash(&elsewhere, &admitted, "Shop").is_none());
    }
    fn settings() -> PreviewSettings {
        PreviewSettings {
            domain: "preview.example.com".into(),
            ingress_class: None,
            ttl_hours: PREVIEW_TTL_HOURS,
            max_live: 2,
        }
    }

    fn preview(n: u128, name: &str, expires_at: &str) -> Deployment {
        let mut d = deployment(n, 1, DeploymentState::Succeeded);
        d.namespace = format!("p-prod-pv-{name}");
        d.preview = Some(Preview {
            name: name.into(),
            expires_at: expires_at.into(),
            host: None,
            connection_id: Uuid::from_u128(7),
            connections_from: None,
            removed_at: None,
            removal_error: None,
        });
        d
    }

    #[test]
    fn an_environment_takes_previews_only_on_a_cluster_it_does_not_protect() {
        let with = |f: fn(&mut EnvironmentInput)| {
            let mut i = input("dev");
            i.previews = Some(PreviewSettings {
                domain: " Preview.Example.com. ".into(),
                ingress_class: Some(" ".into()),
                ..settings()
            });
            f(&mut i);
            checked(
                &EnvironmentList::default(),
                None,
                i,
                String::new(),
                String::new(),
            )
        };
        let ok = with(|_| {}).expect("previews on dev").previews.unwrap();
        assert_eq!(ok.domain, "preview.example.com");
        assert_eq!(ok.ingress_class, None);
        assert_eq!(with(|i| i.protected = true).unwrap_err().field, "previews");
        assert_eq!(
            with(|i| {
                i.kind = EnvironmentKind::Research;
                i.registry = String::new();
                i.research = Some(ResearchTarget {
                    project: "ml".into(),
                    hardware: None,
                });
            })
            .unwrap_err()
            .field,
            "previews"
        );
        let field = |f: fn(&mut PreviewSettings)| {
            let mut i = input("dev");
            let mut p = settings();
            f(&mut p);
            i.previews = Some(p);
            checked(
                &EnvironmentList::default(),
                None,
                i,
                String::new(),
                String::new(),
            )
            .unwrap_err()
            .field
        };
        assert_eq!(
            field(|p| p.domain = "not a domain".into()),
            "preview_domain"
        );
        assert_eq!(field(|p| p.ttl_hours = 0), "preview_ttl_hours");
        assert_eq!(
            field(|p| p.ttl_hours = MAX_PREVIEW_TTL_HOURS + 1),
            "preview_ttl_hours"
        );
        assert_eq!(field(|p| p.max_live = 0), "preview_max_live");
        // Stored before previews existed: none.
        let old: Environment = serde_json::from_value(serde_json::json!({
            "id": Uuid::from_u128(1), "name": "dev", "connection_id": Uuid::from_u128(7),
            "updated_by": "", "updated_at": "",
        }))
        .unwrap();
        assert_eq!(old.previews, None);
    }

    #[test]
    fn a_preview_lives_in_a_namespace_of_its_own_under_the_projects() {
        let id = Uuid::from_u128(0xabcdef12_0000_0000_0000_000000000000);
        assert_eq!(preview_name(None, id).unwrap(), "pabcdef");
        assert_eq!(preview_name(Some(" PR-42 "), id).unwrap(), "pr-42");
        assert_eq!(
            preview_name(Some("a name"), id).unwrap_err().field,
            "preview_name"
        );
        assert!(preview_name(Some(&"x".repeat(MAX_PREVIEW_NAME + 1)), id).is_err());
        assert_eq!(
            preview_namespace("shop-dev", "pr-42").unwrap(),
            "shop-dev-pv-pr-42"
        );
        assert!(preview_namespace(&"s".repeat(50), "pr-42-login-fix").is_err());
        assert_eq!(
            preview_host(&settings(), "shop-dev-pv-pr-42").as_deref(),
            Some("shop-dev-pv-pr-42.preview.example.com")
        );
        let none = PreviewSettings {
            domain: String::new(),
            ..settings()
        };
        assert_eq!(preview_host(&none, "shop-dev-pv-pr-42"), None);
    }

    #[test]
    fn a_project_keeps_as_many_previews_as_the_environment_allows_each_name_once() {
        let env = Uuid::from_u128(9);
        let project = Uuid::from_u128(1);
        let mut history = vec![preview(1, "a", "2030-01-01T00:00:00Z")];
        assert!(preview_refusal(&settings(), &history, project, env, "b").is_none());
        assert!(preview_refusal(&settings(), &history, project, env, "a").is_some());
        history.push(preview(2, "b", "2030-01-01T00:00:00Z"));
        assert!(preview_refusal(&settings(), &history, project, env, "c").is_some());
        // A removed one makes room, and its name is free again.
        history[0].preview.as_mut().unwrap().removed_at = Some("x".into());
        assert!(preview_refusal(&settings(), &history, project, env, "a").is_none());
        // Another project's previews are its own.
        assert!(preview_refusal(&settings(), &history, Uuid::from_u128(2), env, "b").is_none());
    }

    #[test]
    fn a_preview_is_due_once_it_expires_and_until_it_is_removed() {
        let now = time::OffsetDateTime::parse(
            "2026-10-30T12:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        assert!(preview(1, "a", "2026-10-30T11:59:59Z").preview_due(now));
        assert!(!preview(1, "a", "2026-10-30T12:00:01Z").preview_due(now));
        assert!(preview(1, "a", "garbled").preview_due(now));
        let mut removed = preview(1, "a", "2026-10-30T11:00:00Z");
        removed.preview.as_mut().unwrap().removed_at = Some("x".into());
        assert!(!removed.preview_due(now));
        assert!(!removed.is_live_preview());
        assert!(!deployment(1, 1, DeploymentState::Succeeded).preview_due(now));
        // A failed install leaves its namespace: still to remove.
        let mut failed = preview(1, "a", "2026-10-30T11:00:00Z");
        failed.state = DeploymentState::Failed;
        assert!(failed.preview_due(now));
    }

    #[test]
    fn the_history_keeps_every_live_preview_and_a_preview_is_not_what_runs_there() {
        let mut list = DeploymentList::default();
        list.record(deployment(1, 1, DeploymentState::Succeeded));
        list.record(preview(2, "a", "2030-01-01T00:00:00Z"));
        for n in 0..(HISTORY as u128 + 10) {
            list.record(deployment(100 + n, 3, DeploymentState::Succeeded));
        }
        assert!(list.items.iter().any(|d| d.id == Uuid::from_u128(1)));
        assert!(list.items.iter().any(|d| d.id == Uuid::from_u128(2)));
        let mut removed = preview(3, "b", "2030-01-01T00:00:00Z");
        removed.preview.as_mut().unwrap().removed_at = Some("x".into());
        let mut list = DeploymentList::default();
        list.record(removed);
        for n in 0..(HISTORY as u128 + 10) {
            list.record(deployment(100 + n, 3, DeploymentState::Succeeded));
        }
        assert!(!list.items.iter().any(|d| d.id == Uuid::from_u128(3)));
    }
}
