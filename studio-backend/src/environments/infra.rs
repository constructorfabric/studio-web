//! A product's infra services (ADR-0064): the third-party services its gears
//! need running beside them -- PostgreSQL, Keycloak -- described by a
//! `service.gdl` with `kind = "infra"`, added to a project, and deployed
//! with the product.
//!
//! Everything here needs no I/O: what a project may say about its infra
//! services, where an environment runs them, what a deploy will install,
//! the values each service provides to the product's configuration, and the
//! minimal chart Studio generates when no ready chart is given. The run
//! applies it (`deploy::infra_install`).
//!
//! **Binding.** A service `provides` capabilities (`oidc.issuer`,
//! `database.url`). A gear's configuration reads each as an environment
//! variable, `${OIDC_ISSUER}` ([`variable`]); a deploy resolves the value,
//! keeps it in credstore as one of the release's configuration secrets, and
//! the chart hands it to every application (`existingSecret`/`secretKeys`).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::components_catalog::port::{self as service_gdl, TemplateRef};

pub(crate) use crate::components_catalog::port::variable;

/// How many infra services a project may add.
pub const MAX_SERVICES: usize = 20;

/// The volume a stateful service gets unless its passport says otherwise.
pub const DEFAULT_STORAGE: &str = "10Gi";

/// The capability a service that is a database server provides: such a
/// service is installed by the database step (ADR-0048 §7), with its image.
pub const POSTGRES: &str = "postgres";

/// Where an environment runs a product's infra services (ADR-0064 §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    /// In the product's namespace, one instance per environment, installed
    /// with each deploy.
    #[default]
    WithProduct,
    /// In a place the organization keeps for every product: Studio installs
    /// nothing and gives the product the place's values.
    Shared,
}

impl Placement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WithProduct => "with_product",
            Self::Shared => "shared",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "" | "with_product" => Some(Self::WithProduct),
            "shared" => Some(Self::Shared),
            _ => None,
        }
    }
}

/// An environment's setting for infra services.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfraPlacement {
    #[serde(default)]
    pub placement: Placement,
    /// The organization's shared places, by service, for `shared`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared: Vec<SharedService>,
}

/// One service an organization runs for every product of an environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedService {
    /// The infra service's name, as its passport gives it (`keycloak`).
    pub service: String,
    /// Where it runs, for people; Studio does not reach into it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// What it provides, by capability (`oidc.issuer` ->
    /// `https://id.acme.example/realms/shop`). Not secret: a password a
    /// shared place gives is set as a configuration secret of the project.
    #[serde(default)]
    pub provides: BTreeMap<String, String>,
}

/// An environment's infra placement as written, checked. `dev` says the
/// environment is checked as a development one: there the product's
/// services always run with it (ADR-0064 §3).
pub fn check_placement(
    p: Option<InfraPlacement>,
    dev: bool,
) -> Result<Option<InfraPlacement>, String> {
    let Some(mut p) = p else { return Ok(None) };
    if dev && p.placement == Placement::Shared {
        return Err(
            "a dev environment runs the product's infra services with the product, one of each \
             per environment; a shared place is for a prod environment"
                .into(),
        );
    }
    let mut seen = BTreeSet::new();
    for s in &mut p.shared {
        s.service = s.service.trim().to_owned();
        service_gdl_kebab(&s.service)?;
        if !seen.insert(s.service.clone()) {
            return Err(format!(
                "the shared place of '{}' is given twice",
                s.service
            ));
        }
        s.namespace = s
            .namespace
            .take()
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        for (k, v) in &s.provides {
            service_gdl::capability(k).map_err(|e| format!("{}: '{k}' {e}", s.service))?;
            if v.trim().is_empty() || v.contains(['\n', '\r']) {
                return Err(format!(
                    "{}: what '{k}' is, on one line, is not empty",
                    s.service
                ));
            }
        }
    }
    if p == InfraPlacement::default() {
        return Ok(None);
    }
    Ok(Some(p))
}

fn service_gdl_kebab(name: &str) -> Result<(), String> {
    let ok = name.starts_with(|c: char| c.is_ascii_lowercase())
        && !name.ends_with('-')
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "'{name}' is not a service name (lowercase letters, digits and '-', at most 40)"
        ))
    }
}

/// An infra service's passport, as the catalogue read it from its
/// `service.gdl` (ADR-0061 §2, ADR-0064 §1).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfraPassport {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The image as its publisher names it (`quay.io/keycloak/keycloak:26.0.7`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default)]
    pub ports: BTreeMap<String, u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<String>,
    #[serde(default)]
    pub provides: BTreeMap<String, String>,
    #[serde(default)]
    pub stateful: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_path: Option<String>,
    /// A ready chart, where its publisher publishes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_version: Option<String>,
}

/// One infra service of a project's product.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfraService {
    pub passport: InfraPassport,
    /// The image under the project's path in the organization's registry,
    /// imported by digest (`POST /images/imports`). A deploy runs only this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// A ready chart under the project's path (`oci://…`), imported the same
    /// way; absent, Studio generates one from the passport.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_version: Option<String>,
    /// Values for the ready chart; strings may use the passport's template
    /// names (`{secret.KEY}`, `{host}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_values: Option<Value>,
    /// Where people reach it (an issuer's public address), `{public_url}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
}

impl InfraService {
    pub fn name(&self) -> &str {
        &self.passport.name
    }

    /// It is a database server, made by the database step.
    pub fn is_database(&self) -> bool {
        self.passport.provides.contains_key(POSTGRES)
    }
}

/// How large a ready chart's values may be.
pub const MAX_CHART_VALUES_BYTES: usize = 32 * 1024;

/// The first name `template` refers to that `p` does not declare.
fn undeclared(p: &InfraPassport, template: &str) -> Result<Option<TemplateRef>, String> {
    Ok(service_gdl::template_refs(template)?
        .into_iter()
        .find(|r| match r {
            TemplateRef::Port(n) => !p.ports.contains_key(n),
            TemplateRef::Config(k) => !p.config.contains_key(k),
            TemplateRef::Secret(k) => !p.secrets.contains(k),
            TemplateRef::PublicUrl => p.ports.is_empty(),
            TemplateRef::Host | TemplateRef::Namespace => false,
        }))
}

/// A project's infra services as written, checked.
pub fn checked_services(mut list: Vec<InfraService>) -> Result<Vec<InfraService>, String> {
    if list.len() > MAX_SERVICES {
        return Err(format!("at most {MAX_SERVICES} infra services"));
    }
    let mut names = BTreeSet::new();
    let mut provided: BTreeMap<String, String> = BTreeMap::new();
    for s in &mut list {
        let p = &mut s.passport;
        p.name = p.name.trim().to_owned();
        service_gdl_kebab(&p.name)?;
        let name = p.name.clone();
        if !names.insert(name.clone()) {
            return Err(format!("'{name}' is added twice"));
        }
        let at = |e: String| format!("{name}: {e}");
        for (port, n) in &p.ports {
            service_gdl_kebab(port).map_err(at)?;
            if *n == 0 {
                return Err(at(format!("port '{port}' is 0")));
            }
        }
        if let Some(h) = &p.health
            && !h.starts_with('/')
        {
            return Err(at(format!("health '{h}' is not a route")));
        }
        for (k, v) in &p.config {
            service_gdl::env_name(k).map_err(|e| at(format!("config {k} {e}")))?;
            if v.contains("{{") || v.contains(['\n', '\r']) {
                return Err(at(format!(
                    "config {k} is one line without `{{{{`: it goes into a chart"
                )));
            }
        }
        if let Some(a) = p.args.iter().find(|a| a.contains("{{")) {
            return Err(at(format!(
                "argument '{a}' has `{{{{`: it goes into a chart"
            )));
        }
        p.secrets.sort();
        p.secrets.dedup();
        for k in &p.secrets {
            service_gdl::env_name(k).map_err(|e| at(format!("secret {k} {e}")))?;
            if p.config.contains_key(k) {
                return Err(at(format!("{k} is both config and a secret")));
            }
        }
        for (k, template) in &p.provides {
            service_gdl::capability(k).map_err(|e| at(format!("provides '{k}' {e}")))?;
            if let Some(r) = undeclared(p, template).map_err(|e| at(format!("'{k}' {e}")))? {
                return Err(at(format!(
                    "provides '{k}' refers to {r}, which the passport does not declare"
                )));
            }
            if let Some(other) = provided.insert(k.clone(), name.clone()) {
                return Err(format!(
                    "'{other}' and '{name}' both provide '{k}': the product reads one"
                ));
            }
        }
        if let Some(size) = &p.storage {
            service_gdl::volume_size(size).map_err(|e| at(format!("storage {e}")))?;
        }
        if p.stateful && p.data_path.as_deref().is_none_or(|d| !d.starts_with('/')) {
            return Err(at(
                "a stateful service says where its volume is mounted".into()
            ));
        }
        if p.image.is_none() && p.chart.is_none() {
            return Err(at("the passport names an image or a chart".into()));
        }
        s.image = s
            .image
            .take()
            .map(|i| i.trim().to_owned())
            .filter(|i| !i.is_empty());
        if let Some(i) = &s.image
            && !super::model::is_image_reference(i)
        {
            return Err(at(format!("'{i}' is not an image")));
        }
        s.chart_ref = s
            .chart_ref
            .take()
            .map(|c| c.trim().to_owned())
            .filter(|c| !c.is_empty());
        if let Some(c) = &s.chart_ref {
            if !c.starts_with("oci://") {
                return Err(at(format!(
                    "'{c}' is not a chart in the organization's registry (oci://…)"
                )));
            }
            if s.chart_version
                .as_deref()
                .is_none_or(|v| v.trim().is_empty())
            {
                return Err(at("a ready chart is installed at a version".into()));
            }
        } else if s.chart_values.is_some() {
            return Err(at("chart values go with a ready chart".into()));
        }
        if let Some(v) = &s.chart_values {
            if !v.is_object() {
                return Err(at("chart values are an object".into()));
            }
            if v.to_string().len() > MAX_CHART_VALUES_BYTES {
                return Err(at(format!(
                    "chart values are at most {MAX_CHART_VALUES_BYTES} bytes"
                )));
            }
        }
        s.public_url = s
            .public_url
            .take()
            .map(|u| u.trim().trim_end_matches('/').to_owned())
            .filter(|u| !u.is_empty());
        if let Some(u) = &s.public_url
            && !(u.starts_with("https://") || u.starts_with("http://"))
        {
            return Err(at(format!("'{u}' is not an address (https://…)")));
        }
    }
    Ok(list)
}

/// How a deploy brings one infra service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Install {
    /// The database step makes it, with the service's image (ADR-0048 §7).
    Database,
    /// From its ready chart, imported into the project's path.
    Chart,
    /// From the chart Studio generates from its passport.
    Generated,
    /// Nothing installed: the shared place's values.
    Shared,
}

impl Install {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::Chart => "chart",
            Self::Generated => "generated",
            Self::Shared => "shared",
        }
    }
}

/// What a deploy does with one infra service in an environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanItem {
    pub service: String,
    pub placement: Placement,
    pub install: Install,
    /// The image it runs (under the project's path).
    pub image: Option<String>,
    /// The ready chart and version.
    pub chart: Option<String>,
    /// The capabilities it gives the product, each with its variable.
    pub provides: Vec<(String, String)>,
    /// Why a deploy would be refused now, with its code.
    pub refusal: Option<(&'static str, String)>,
}

/// What a deploy to an environment placing infra services as `placement`
/// does with `services`. `in_project` says whether an image or a chart is
/// under the project's path (`Err` says why not).
pub fn plan(
    placement: Option<&InfraPlacement>,
    services: &[InfraService],
    in_project: impl Fn(&str) -> Result<(), String>,
) -> Vec<PlanItem> {
    let mode = placement.map(|p| p.placement).unwrap_or_default();
    services
        .iter()
        .map(|s| {
            let install = install_for(mode, s);
            let refusal = match install {
                Install::Shared => placement
                    .filter(|p| p.shared.iter().any(|x| x.service == s.name()))
                    .is_none()
                    .then(|| {
                        (
                            "INFRA_NOT_IN_SHARED_PLACE",
                            format!(
                                "the environment places infra services in a shared place, and \
                                 names none for '{}'",
                                s.name()
                            ),
                        )
                    }),
                Install::Chart => s.chart_ref.as_deref().and_then(|c| {
                    in_project(c)
                        .err()
                        .map(|why| ("IMAGE_NOT_IN_PROJECT_PATH", why))
                }),
                Install::Database | Install::Generated => match &s.image {
                    None => Some((
                        "INFRA_IMAGE_NOT_IMPORTED",
                        format!(
                            "'{}' runs {}, which is not in the organization's registry: import \
                             it into the project's path first (POST /images/imports)",
                            s.name(),
                            s.passport
                                .image
                                .as_deref()
                                .unwrap_or("an image it does not name")
                        ),
                    )),
                    Some(i) => in_project(i)
                        .err()
                        .map(|why| ("IMAGE_NOT_IN_PROJECT_PATH", why)),
                },
            };
            PlanItem {
                service: s.name().to_owned(),
                placement: mode,
                install,
                image: (install != Install::Shared && install != Install::Chart)
                    .then(|| s.image.clone())
                    .flatten(),
                chart: (install == Install::Chart).then(|| {
                    format!(
                        "{}:{}",
                        s.chart_ref.clone().unwrap_or_default(),
                        s.chart_version.clone().unwrap_or_default()
                    )
                }),
                provides: s
                    .passport
                    .provides
                    .keys()
                    .map(|k| (k.clone(), variable(k)))
                    .collect(),
                refusal,
            }
        })
        .collect()
}

/// How a service comes where infra services are placed as `mode`.
fn install_for(mode: Placement, s: &InfraService) -> Install {
    match mode {
        Placement::Shared => Install::Shared,
        Placement::WithProduct if s.is_database() => Install::Database,
        Placement::WithProduct if s.chart_ref.is_some() => Install::Chart,
        Placement::WithProduct => Install::Generated,
    }
}

/// One infra service as a deploy's run gets it: what it is, how it comes,
/// and the shared place's values when it is shared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfraInstall {
    pub service: InfraService,
    pub install: Install,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<SharedService>,
}

/// What a deploy's run installs, or reads from the shared place, for
/// `services` where infra services are placed as `placement`.
pub fn installs(
    placement: Option<&InfraPlacement>,
    services: &[InfraService],
) -> Vec<InfraInstall> {
    let mode = placement.map(|p| p.placement).unwrap_or_default();
    services
        .iter()
        .map(|s| InfraInstall {
            service: s.clone(),
            install: install_for(mode, s),
            shared: placement
                .filter(|_| mode == Placement::Shared)
                .and_then(|p| p.shared.iter().find(|x| x.service == s.name()))
                .cloned(),
        })
        .collect()
}

/// The image the database step runs: the imported image of the service
/// that is the product's database server, when one is placed with it.
pub fn database_image(installs: &[InfraInstall]) -> Option<String> {
    installs
        .iter()
        .find(|i| i.install == Install::Database)
        .and_then(|i| i.service.image.clone())
}

/// The variables a deploy's run writes for the product from `installs`:
/// each capability with a value -- a template, or the shared place's.
pub fn produced_variables(installs: &[InfraInstall]) -> Vec<String> {
    let mut out: Vec<String> = installs
        .iter()
        .flat_map(|i| -> Vec<String> {
            match (&i.install, &i.shared) {
                (Install::Shared, Some(place)) => {
                    place.provides.keys().map(|k| variable(k)).collect()
                }
                (Install::Shared, None) => Vec::new(),
                // The database step wires the gears to their server itself
                // (ADR-0048 §7), under the host their configuration names.
                (Install::Database, _) => Vec::new(),
                _ => i
                    .service
                    .passport
                    .provides
                    .iter()
                    .filter(|(_, t)| !t.is_empty())
                    .map(|(k, _)| variable(k))
                    .collect(),
            }
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The configuration-secret key a service's own secret is kept under in
/// credstore, per project and environment: `INFRA_KEYCLOAK_KC_BOOTSTRAP_ADMIN_PASSWORD`.
pub fn secret_key(service: &str, key: &str) -> String {
    format!("INFRA_{}_{key}", variable(service))
}

/// The port a template's `{public_url}` and the probes use: `http`, else the
/// first.
fn main_port(p: &InfraPassport) -> Option<(&str, u16)> {
    p.ports
        .get_key_value("http")
        .or_else(|| p.ports.iter().next())
        .map(|(k, v)| (k.as_str(), *v))
}

/// `template` with each name filled for `s` running in `namespace`.
pub fn resolve(
    s: &InfraService,
    template: &str,
    namespace: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<String, String> {
    let p = &s.passport;
    let mut out = String::new();
    let mut rest = template;
    // Checked against the passport on the way in: every name is known.
    service_gdl::template_refs(template)?;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}').unwrap_or(after.len());
        let name = &after[..close];
        let value = match name.split_once('.') {
            None if name == "host" => p.name.clone(),
            None if name == "namespace" => namespace.to_owned(),
            None if name == "public_url" => match &s.public_url {
                Some(u) => u.clone(),
                None => {
                    let (_, port) = main_port(p)
                        .ok_or_else(|| format!("{} has no port to be reached at", p.name))?;
                    format!("http://{}:{port}", p.name)
                }
            },
            Some(("port", n)) => p
                .ports
                .get(n)
                .map(u16::to_string)
                .ok_or_else(|| format!("{} has no port '{n}'", p.name))?,
            Some(("config", k)) => p
                .config
                .get(k)
                .cloned()
                .ok_or_else(|| format!("{} has no config {k}", p.name))?,
            Some(("secret", k)) => secrets
                .get(k)
                .cloned()
                .ok_or_else(|| format!("{} has no secret {k} yet", p.name))?,
            _ => return Err(format!("`{{{name}}}` is not a template name")),
        };
        out.push_str(&value);
        rest = after.get(close + 1..).unwrap_or_default();
    }
    out.push_str(rest);
    Ok(out)
}

/// What `s` provides, by variable, running in `namespace` with `secrets`
/// (its own, by key); or, in a shared place, what the place says.
/// Capabilities without a value are left to the project's configuration.
pub fn provided_values(
    s: &InfraService,
    shared: Option<&SharedService>,
    namespace: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    if let Some(place) = shared {
        for (k, v) in &place.provides {
            out.insert(variable(k), v.clone());
        }
        return Ok(out);
    }
    for (k, template) in &s.passport.provides {
        if template.is_empty() {
            continue;
        }
        out.insert(variable(k), resolve(s, template, namespace, secrets)?);
    }
    Ok(out)
}

/// `values` with every string leaf filled as a template for `s`.
pub fn chart_values(
    s: &InfraService,
    namespace: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<Value, String> {
    fn fill(v: &mut Value, f: &dyn Fn(&str) -> Result<String, String>) -> Result<(), String> {
        match v {
            Value::String(text) if text.contains('{') => *text = f(text)?,
            Value::Array(items) => {
                for i in items {
                    fill(i, f)?;
                }
            }
            Value::Object(map) => {
                for (_, i) in map.iter_mut() {
                    fill(i, f)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut values = s.chart_values.clone().unwrap_or_else(|| json!({}));
    fill(&mut values, &|t| resolve(s, t, namespace, secrets))?;
    // The Service is named as the passport, as `{host}` says.
    super::model::merge(&mut values, json!({ "fullnameOverride": s.name() }));
    Ok(values)
}

/// The labels every object of an infra service carries.
fn labels(name: &str) -> Value {
    json!({
        "app.kubernetes.io/name": name,
        "app.kubernetes.io/part-of": "studio-infra",
        "studio.constructor.tech/infra": name,
    })
}

/// The minimal chart Studio generates from `s`'s passport (ADR-0064 §5): a
/// Deployment, or a StatefulSet with a volume claim when it keeps data; a
/// Service for its ports; a Secret with what Studio made for it. Each file
/// as `(path in the chart, contents)`. Nothing in it is templated: it is the
/// manifests as they apply, under Helm's release for its lifecycle.
pub fn generated_chart(
    s: &InfraService,
    image: &str,
    secrets: &BTreeMap<String, String>,
    pull_secret: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    use base64::Engine as _;
    let p = &s.passport;
    let name = p.name.as_str();
    let mut files = Vec::new();
    let chart = json!({
        "apiVersion": "v2",
        "name": name,
        "description": p.description.clone().unwrap_or_else(|| format!("{name}, an infra service")),
        "type": "application",
        "version": "0.1.0",
        "appVersion": p.version.clone().unwrap_or_else(|| "unversioned".into()),
    });
    files.push(("Chart.yaml".to_owned(), yaml(&chart)?));
    let secret_name = format!("{name}-secrets");
    if !p.secrets.is_empty() {
        let mut data = serde_json::Map::new();
        for k in &p.secrets {
            let v = secrets
                .get(k)
                .ok_or_else(|| format!("{name}: secret {k} has no value"))?;
            data.insert(
                k.clone(),
                base64::engine::general_purpose::STANDARD
                    .encode(v.as_bytes())
                    .into(),
            );
        }
        let secret = json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": secret_name, "labels": labels(name) },
            "type": "Opaque",
            "data": data,
        });
        files.push(("templates/secret.yaml".to_owned(), yaml(&secret)?));
    }
    if !p.ports.is_empty() {
        let ports: Vec<Value> = p
            .ports
            .iter()
            .map(|(n, port)| json!({ "name": n, "port": port, "targetPort": n }))
            .collect();
        let service = json!({
            "apiVersion": "v1", "kind": "Service",
            "metadata": { "name": name, "labels": labels(name) },
            "spec": { "selector": { "app.kubernetes.io/name": name }, "ports": ports },
        });
        files.push(("templates/service.yaml".to_owned(), yaml(&service)?));
    }
    let env: Vec<Value> = p
        .config
        .iter()
        .map(|(k, v)| json!({ "name": k, "value": v }))
        .collect();
    let mut container = json!({
        "name": name,
        "image": image,
        "env": env,
        "ports": p.ports.iter().map(|(n, port)| json!({ "name": n, "containerPort": port })).collect::<Vec<_>>(),
    });
    let c = container.as_object_mut().expect("an object");
    if !p.args.is_empty() {
        c.insert("args".into(), json!(p.args));
    }
    if !p.secrets.is_empty() {
        c.insert(
            "envFrom".into(),
            json!([{ "secretRef": { "name": secret_name } }]),
        );
    }
    let probe_port = p
        .ports
        .get_key_value("management")
        .map(|(k, _)| k.as_str())
        .or_else(|| main_port(p).map(|(k, _)| k));
    let probe = match (&p.health, probe_port) {
        (Some(path), Some(port)) => Some(json!({ "httpGet": { "path": path, "port": port } })),
        (None, Some(port)) => Some(json!({ "tcpSocket": { "port": port } })),
        _ => None,
    };
    if let Some(probe) = probe {
        let mut ready = probe.clone();
        merge_obj(
            &mut ready,
            json!({ "periodSeconds": 10, "failureThreshold": 30 }),
        );
        let mut live = probe;
        merge_obj(
            &mut live,
            json!({ "initialDelaySeconds": 60, "periodSeconds": 20, "failureThreshold": 6 }),
        );
        c.insert("readinessProbe".into(), ready);
        c.insert("livenessProbe".into(), live);
    }
    let volume = "data";
    if let (true, Some(path)) = (p.stateful, &p.data_path) {
        c.insert(
            "volumeMounts".into(),
            json!([{ "name": volume, "mountPath": path }]),
        );
    }
    let mut pod = json!({ "containers": [container] });
    if let Some(secret) = pull_secret {
        merge_obj(
            &mut pod,
            json!({ "imagePullSecrets": [{ "name": secret }] }),
        );
    }
    let template = json!({
        "metadata": { "labels": labels(name) },
        "spec": pod,
    });
    let selector = json!({ "matchLabels": { "app.kubernetes.io/name": name } });
    let workload = if p.stateful {
        json!({
            "apiVersion": "apps/v1", "kind": "StatefulSet",
            "metadata": { "name": name, "labels": labels(name) },
            "spec": {
                "serviceName": name,
                "replicas": 1,
                "selector": selector,
                "template": template,
                // The volume claim outlives the release: an uninstall keeps
                // the data.
                "volumeClaimTemplates": [{
                    "metadata": { "name": volume, "labels": labels(name) },
                    "spec": {
                        "accessModes": ["ReadWriteOnce"],
                        "resources": { "requests": {
                            "storage": p.storage.clone().unwrap_or_else(|| DEFAULT_STORAGE.into())
                        } },
                    },
                }],
            },
        })
    } else {
        json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": name, "labels": labels(name) },
            "spec": { "replicas": 1, "selector": selector, "template": template },
        })
    };
    files.push(("templates/workload.yaml".to_owned(), yaml(&workload)?));
    Ok(files)
}

fn merge_obj(base: &mut Value, over: Value) {
    super::model::merge(base, over);
}

fn yaml(v: &Value) -> Result<String, String> {
    serde_yaml::to_string(v).map_err(|e| format!("cannot write YAML: {e}"))
}

#[cfg(test)]
#[path = "infra_tests.rs"]
mod tests;
