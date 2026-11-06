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
    /// How a service placed with the product is reached at its
    /// `public_url`: the Ingress its generated chart carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingress: Option<InfraIngress>,
}

/// The Ingress a generated chart routes a service's `public_url` with
/// (ADR-0064, amended): what the cluster's ingress controller asks of it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfraIngress {
    /// The `ingressClassName`; `None`: the environment's preview class, else
    /// the cluster's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    /// The TLS secret of an `https://` address; `None`: the controller's
    /// default certificate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_secret: Option<String>,
    /// Annotations the controller reads (`cert-manager.io/cluster-issuer`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub annotations: BTreeMap<String, String>,
}

/// How many annotations an infra Ingress may carry.
pub const MAX_INGRESS_ANNOTATIONS: usize = 20;

fn check_ingress(i: Option<InfraIngress>) -> Result<Option<InfraIngress>, String> {
    let Some(mut i) = i else { return Ok(None) };
    let tidy = |v: Option<String>| v.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    i.class = tidy(i.class.take());
    i.tls_secret = tidy(i.tls_secret.take());
    for (what, v) in [("ingress class", &i.class), ("TLS secret", &i.tls_secret)] {
        if let Some(v) = v
            && !super::model::is_dns_name(v)
        {
            return Err(format!("'{v}' is not an {what} name"));
        }
    }
    if i.annotations.len() > MAX_INGRESS_ANNOTATIONS {
        return Err(format!(
            "an infra Ingress takes at most {MAX_INGRESS_ANNOTATIONS} annotations"
        ));
    }
    for (k, v) in &i.annotations {
        if k.is_empty() || k.contains(char::is_whitespace) || k.len() > 253 {
            return Err(format!("'{k}' is not an annotation name"));
        }
        if v.contains(['\n', '\r']) || v.contains("{{") {
            return Err(format!(
                "the annotation {k} is one line without `{{{{`: it goes into a chart"
            ));
        }
    }
    Ok((i != InfraIngress::default()).then_some(i))
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
    p.ingress = check_ingress(p.ingress.take())?;
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
    /// Placed with the product, its generated chart routes it with an
    /// Ingress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    /// Files its container reads, by absolute path (a realm to import at
    /// `/opt/keycloak/data/import/product.json`): text whose `{secret.KEY}`,
    /// `{host}`, `{public_url}`, `{namespace}`, `{port.x}` and `{config.K}`
    /// are filled as in `provides`; any other brace is the file's own. The
    /// generated chart mounts them read-only.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, String>,
    /// Arguments after the passport's (`--import-realm`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
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

/// How large a service's files may be, all together.
pub const MAX_FILES_BYTES: usize = 256 * 1024;

/// How many files a service may be given.
pub const MAX_FILES: usize = 20;

/// How many arguments a service may be given after its passport's.
pub const MAX_ARGS: usize = 20;

/// One name a file's text refers to: a `provides` template name, or
/// `{env.KEY}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FileRef {
    Template(TemplateRef),
    /// `{env.KEY}`: the project's configuration value `KEY` in the
    /// environment -- a configuration secret, made once per environment when
    /// none is set. A realm's client reads the same secret as the gear that
    /// signs in with it (`client_secret = "${KEY}"`).
    Env(String),
}

impl std::fmt::Display for FileRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Template(t) => write!(f, "{t}"),
            Self::Env(k) => write!(f, "{{env.{k}}}"),
        }
    }
}

/// Where the value of `{env.KEY}` is handed to [`files`] and
/// [`generated_chart`], beside the service's own secrets: `env.KEY`, which
/// no secret of a passport can be named.
pub fn env_slot(key: &str) -> String {
    format!("env.{key}")
}

/// The template name at the start of `text` (`{secret.KEY}…`) and the
/// length it takes; `None` when the brace there is the file's own.
fn template_at(text: &str) -> Option<(FileRef, usize)> {
    let after = text.strip_prefix('{')?;
    let close = after.find(['}', '{'])?;
    if !after[close..].starts_with('}') {
        return None;
    }
    if let Some(key) = after[..close].strip_prefix("env.")
        && service_gdl::env_name(key).is_ok()
    {
        return Some((FileRef::Env(key.to_owned()), close + 2));
    }
    let r = service_gdl::template_refs(&text[..close + 2])
        .ok()?
        .into_iter()
        .next()?;
    Some((FileRef::Template(r), close + 2))
}

/// `text` with each template name in it given to `value`, and replaced by
/// what it answers; every other brace -- a JSON object's -- kept.
fn fill_file(
    text: &str,
    value: &mut dyn FnMut(&FileRef) -> Result<String, String>,
) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        rest = &rest[open..];
        match template_at(rest) {
            Some((r, len)) => {
                out.push_str(&value(&r)?);
                rest = &rest[len..];
            }
            None => {
                out.push('{');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// The template names a file's text refers to.
pub(crate) fn file_refs(text: &str) -> Vec<FileRef> {
    let mut refs = Vec::new();
    let _ = fill_file(text, &mut |r| {
        refs.push(r.clone());
        Ok(String::new())
    });
    refs
}

/// Is `path` an absolute path in a container: `/`-separated names, none
/// empty, `.` or `..`.
fn file_path(path: &str) -> Result<(), String> {
    let ok = path.len() > 1
        && path.len() <= 255
        && path.starts_with('/')
        && path[1..]
            .split('/')
            .all(|n| !n.is_empty() && n != "." && n != "..")
        && !path.chars().any(|c| c.is_control() || c == '\\');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "'{path}' is not an absolute path in the container (/…, no `..`)"
        ))
    }
}

/// The host and path of an address: `https://id.shop.example/auth` is
/// `id.shop.example` and `/auth`; without a path, `/`.
pub fn host_and_path(url: &str) -> Option<(&str, &str)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (authority, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => (rest, "/"),
    };
    let host = authority.split(':').next().unwrap_or(authority);
    (super::model::is_dns_name(host) && !path.contains(['?', '#', ' '])).then_some((host, path))
}

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
            && host_and_path(u).is_none()
        {
            return Err(at(format!(
                "'{u}' is not an address (https://host/path, the host a DNS name)"
            )));
        }
        s.args.retain(|a| !a.trim().is_empty());
        if s.args.len() > MAX_ARGS {
            return Err(at(format!("at most {MAX_ARGS} more arguments")));
        }
        if let Some(a) = s
            .args
            .iter()
            .find(|a| a.contains("{{") || a.contains(['\n', '\r']))
        {
            return Err(at(format!(
                "argument '{a}' is one line without `{{{{`: it goes into a chart"
            )));
        }
        if s.files.len() > MAX_FILES {
            return Err(at(format!("at most {MAX_FILES} files")));
        }
        let size: usize = s.files.iter().map(|(k, v)| k.len() + v.len()).sum();
        if size > MAX_FILES_BYTES {
            return Err(at(format!(
                "its files are at most {MAX_FILES_BYTES} bytes together, not {size}"
            )));
        }
        for (path, text) in &s.files {
            file_path(path).map_err(at)?;
            let p = &s.passport;
            if let Some(r) = file_refs(text).into_iter().find(|r| match r {
                FileRef::Template(t) => matches!(undeclared(p, &t.to_string()), Ok(Some(_))),
                FileRef::Env(_) => false,
            }) {
                return Err(at(format!(
                    "the file {path} refers to {r}, which the passport does not declare"
                )));
            }
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
    /// The address its generated chart routes with an Ingress: its
    /// `public_url`.
    pub route: Option<String>,
    /// What the deploy does not do with what the project says of it: files
    /// and arguments only a generated chart applies.
    pub notes: Vec<String>,
    /// What the deploy goes on with and says, with its code: an issuer pods
    /// may not reach ([`ISSUER_UNREACHABLE`]).
    pub warnings: Vec<(&'static str, String)>,
}

/// The code a deploy is refused with when a capability's value would be
/// an address only the cluster reaches.
pub const PUBLIC_URL_MISSING: &str = "INFRA_PUBLIC_URL_MISSING";

/// Why `s`, installed by Studio, cannot give what it provides: a template
/// says `{public_url}`, and the project gives the service none.
fn public_url_missing(s: &InfraService) -> Option<String> {
    if s.public_url.is_some() {
        return None;
    }
    let uses =
        |t: &str| service_gdl::template_refs(t).is_ok_and(|r| r.contains(&TemplateRef::PublicUrl));
    let capabilities: Vec<&str> = s
        .passport
        .provides
        .iter()
        .filter(|(_, t)| uses(t))
        .map(|(k, _)| k.as_str())
        .collect();
    let files: Vec<&str> = s
        .files
        .iter()
        .filter(|(_, t)| file_refs(t).contains(&FileRef::Template(TemplateRef::PublicUrl)))
        .map(|(k, _)| k.as_str())
        .collect();
    if capabilities.is_empty() && files.is_empty() {
        return None;
    }
    let what = if capabilities.is_empty() {
        format!("its file(s) {}", files.join(", "))
    } else {
        format!("what it gives as {}", capabilities.join(", "))
    };
    Some(format!(
        "'{name}' fills {what} with {{public_url}}, and the project gives it no public address: \
         a browser cannot reach the cluster's own http://{name}. Set its public_url to the \
         address people reach it at (https://id.<your domain>, in Product › Infrastructure or \
         PUT /infra-services); placed with the product, its chart then routes that address to it",
        name = s.name()
    ))
}

/// The code a deploy is refused with when the issuer a service gives the
/// product is not `https://`: oidc-authn-plugin refuses any other, and has
/// no switch for a dev stand.
pub const ISSUER_NOT_HTTPS: &str = "INFRA_ISSUER_NOT_HTTPS";

/// The code of a warning: the issuer's host is one only the machine it is
/// typed on reaches (`localhost`, `*.localtest.me`, `*.local`), never a pod.
pub const ISSUER_UNREACHABLE: &str = "INFRA_ISSUER_UNREACHABLE_IN_CLUSTER";

/// The capability an identity provider gives: its issuer.
pub const OIDC_ISSUER: &str = "oidc.issuer";

/// The issuer address `s`, brought as `install`, gives the product: the
/// shared place's, else the public address its `oidc.issuer` is filled with.
/// `None` when it gives no issuer, or one not made of its `public_url`.
fn issuer_url(
    s: &InfraService,
    install: Install,
    shared: Option<&SharedService>,
) -> Option<String> {
    match install {
        Install::Shared => shared.and_then(|p| p.provides.get(OIDC_ISSUER)).cloned(),
        Install::Database => None,
        Install::Chart | Install::Generated => {
            let template = s.passport.provides.get(OIDC_ISSUER)?;
            let uses_url = service_gdl::template_refs(template)
                .is_ok_and(|r| r.contains(&TemplateRef::PublicUrl));
            uses_url
                .then(|| s.public_url.clone())
                .flatten()
                .map(|u| template.replace("{public_url}", &u))
        }
    }
}

/// Why a deploy of `s` is refused for its issuer: it is not `https://`.
pub fn issuer_refusal(
    s: &InfraService,
    install: Install,
    shared: Option<&SharedService>,
) -> Option<(&'static str, String)> {
    let url = issuer_url(s, install, shared)?;
    if url.starts_with("https://") {
        return None;
    }
    let what = match install {
        Install::Shared => "the shared place gives it",
        _ => "its public_url makes it",
    };
    Some((
        ISSUER_NOT_HTTPS,
        format!(
            "'{name}' gives the product the issuer {url} ({what}), which is not https: \
             oidc-authn-plugin refuses any other issuer, so every gear that checks a token \
             would crash at start. Give it an https:// address (Product › Infrastructure or \
             PUT /infra-services; a shared place in the environment's settings), with a \
             certificate the ingress serves",
            name = s.name()
        ),
    ))
}

/// Whether `host` is one only the machine it is typed on reaches: it names
/// the loopback, or a domain that resolves to it, or mDNS.
pub fn local_only_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let under = |d: &str| h == d || h.ends_with(&format!(".{d}"));
    under("localhost")
        || under("localtest.me")
        || under("lvh.me")
        || h.ends_with(".local")
        || h.starts_with("127.")
        || h == "0.0.0.0"
        || h.contains("127.0.0.1")
        || h.contains("127-0-0-1")
}

/// What a deploy of `s` goes on with and says about its issuer: a host pods
/// cannot reach. A gear that signs in at start (`client_credentials`) or
/// reads the issuer's discovery document runs inside the cluster.
pub fn issuer_warnings(
    s: &InfraService,
    install: Install,
    shared: Option<&SharedService>,
) -> Vec<(&'static str, String)> {
    let Some(url) = issuer_url(s, install, shared) else {
        return Vec::new();
    };
    let Some((host, _)) = host_and_path(&url) else {
        return Vec::new();
    };
    if !local_only_host(host) {
        return Vec::new();
    }
    vec![(
        ISSUER_UNREACHABLE,
        format!(
            "'{name}' gives the product the issuer {url}, and {host} reaches only the machine \
             it is typed on, not a pod: a gear that signs in at start (client_credentials, as \
             mini-chat does) or reads the issuer's discovery document fails inside the \
             cluster. Give it a host the cluster resolves to its ingress",
            name = s.name()
        ),
    )]
}

/// What a deploy leaves undone of what the project says of `s`, installed
/// as `install`.
fn notes_for(install: Install, s: &InfraService) -> Vec<String> {
    let given = match (s.files.is_empty(), s.args.is_empty()) {
        (true, true) => return Vec::new(),
        (false, true) => "its files are",
        (true, false) => "its extra arguments are",
        (false, false) => "its files and extra arguments are",
    };
    match install {
        Install::Generated => Vec::new(),
        Install::Chart => vec![format!(
            "{given} not applied: a ready chart takes what it mounts and runs from its values"
        )],
        Install::Database => vec![format!(
            "{given} not applied: the database step runs the server with its image alone"
        )],
        Install::Shared => vec![format!(
            "{given} not applied: the shared place is the organization's"
        )],
    }
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
            }
            .or_else(|| match install {
                Install::Chart | Install::Generated => {
                    public_url_missing(s).map(|why| (PUBLIC_URL_MISSING, why))
                }
                Install::Database | Install::Shared => None,
            });
            let shared = placement
                .filter(|_| install == Install::Shared)
                .and_then(|p| p.shared.iter().find(|x| x.service == s.name()));
            let refusal = refusal.or_else(|| issuer_refusal(s, install, shared));
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
                route: (install == Install::Generated)
                    .then(|| s.public_url.clone())
                    .flatten(),
                notes: notes_for(install, s),
                warnings: issuer_warnings(s, install, shared),
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
    /// The Ingress its generated chart routes its `public_url` with; `None`
    /// routes nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingress: Option<InfraIngress>,
}

/// What a deploy's run installs, or reads from the shared place, for
/// `services` where infra services are placed as `placement`.
/// `default_class` is the environment's preview ingress class, which an
/// infra Ingress asks for unless the placement names its own.
pub fn installs(
    placement: Option<&InfraPlacement>,
    services: &[InfraService],
    default_class: Option<&str>,
) -> Vec<InfraInstall> {
    let mode = placement.map(|p| p.placement).unwrap_or_default();
    let mut settings = placement
        .and_then(|p| p.ingress.clone())
        .unwrap_or_default();
    if settings.class.is_none() {
        settings.class = default_class.map(str::to_owned);
    }
    services
        .iter()
        .map(|s| {
            let install = install_for(mode, s);
            InfraInstall {
                service: s.clone(),
                install,
                shared: placement
                    .filter(|_| mode == Placement::Shared)
                    .and_then(|p| p.shared.iter().find(|x| x.service == s.name()))
                    .cloned(),
                ingress: (install == Install::Generated && s.public_url.is_some())
                    .then(|| settings.clone()),
            }
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

/// The configuration values the files of `installs` read as `{env.KEY}`:
/// only a generated chart mounts files. Each is one of the release's
/// configuration secrets, so the gear that reads `${KEY}` gets the value the
/// file was filled with.
pub fn file_variables(installs: &[InfraInstall]) -> Vec<String> {
    let mut out: Vec<String> = installs
        .iter()
        .filter(|i| i.install == Install::Generated)
        .flat_map(|i| i.service.files.values())
        .flat_map(|t| file_refs(t))
        .filter_map(|r| match r {
            FileRef::Env(k) => Some(k),
            FileRef::Template(_) => None,
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

/// The port the probes and an Ingress use: `http`, else the first.
fn main_port(p: &InfraPassport) -> Option<(&str, u16)> {
    p.ports
        .get_key_value("http")
        .or_else(|| p.ports.iter().next())
        .map(|(k, v)| (k.as_str(), *v))
}

/// What the template name `r` is for `s` running in `namespace`.
fn value_of(
    s: &InfraService,
    r: &TemplateRef,
    namespace: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<String, String> {
    let p = &s.passport;
    match r {
        TemplateRef::Host => Ok(p.name.clone()),
        TemplateRef::Namespace => Ok(namespace.to_owned()),
        // Never the cluster's own address: a browser does not reach it, and
        // the plan refuses the deploy before ([`PUBLIC_URL_MISSING`]).
        TemplateRef::PublicUrl => s.public_url.clone().ok_or_else(|| {
            format!(
                "{PUBLIC_URL_MISSING}: {} has no public address for {{public_url}}",
                p.name
            )
        }),
        TemplateRef::Port(n) => p
            .ports
            .get(n)
            .map(u16::to_string)
            .ok_or_else(|| format!("{} has no port '{n}'", p.name)),
        TemplateRef::Config(k) => p
            .config
            .get(k)
            .cloned()
            .ok_or_else(|| format!("{} has no config {k}", p.name)),
        TemplateRef::Secret(k) => secrets
            .get(k)
            .cloned()
            .ok_or_else(|| format!("{} has no secret {k} yet", p.name)),
    }
}

/// `template` with each name filled for `s` running in `namespace`.
pub fn resolve(
    s: &InfraService,
    template: &str,
    namespace: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<String, String> {
    // Checked against the passport on the way in: every name is known, and
    // none is `{env.*}`, which only a file reads.
    service_gdl::template_refs(template)?;
    fill_file(template, &mut |r| match r {
        FileRef::Template(t) => value_of(s, t, namespace, secrets),
        FileRef::Env(k) => Err(format!(
            "{} provides {{env.{k}}}, which only a file reads",
            s.name()
        )),
    })
}

/// `s`'s files with their template names filled, by path.
pub fn files(
    s: &InfraService,
    namespace: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    s.files
        .iter()
        .map(|(path, text)| {
            fill_file(text, &mut |r| match r {
                FileRef::Template(t) => value_of(s, t, namespace, secrets),
                FileRef::Env(k) => secrets
                    .get(&env_slot(k))
                    .cloned()
                    .ok_or_else(|| format!("the configuration value {k} it reads is not set yet")),
            })
            .map(|t| (path.clone(), t))
            .map_err(|e| format!("the file {path}: {e}"))
        })
        .collect()
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

/// The annotation on a generated pod with the hash of its files: a change
/// of a file is a change of the pod, which restarts it.
pub const FILES_HASH_ANNOTATION: &str = "studio.constructor.tech/files-sha256";

/// The Ingress routing `url` to `service`'s `port`, as `settings` ask: the
/// class, the annotations, and for `https://` a TLS section naming the
/// host (and the secret, when one is given). Like a preview's address
/// (`preview::ingress`), with the path the address has.
fn infra_ingress(
    service: &str,
    url: &str,
    port: Option<(&str, u16)>,
    settings: &InfraIngress,
) -> Result<Value, String> {
    let (host, path) =
        host_and_path(url).ok_or_else(|| format!("{service}: '{url}' is not an address"))?;
    let (_, port) = port.ok_or_else(|| format!("{service} has no port to route {url} to"))?;
    let mut spec = json!({
        "rules": [{
            "host": host,
            "http": { "paths": [{
                "path": path,
                "pathType": "Prefix",
                "backend": { "service": { "name": service, "port": { "number": port } } },
            }]},
        }],
    });
    if let Some(class) = &settings.class {
        spec["ingressClassName"] = class.as_str().into();
    }
    if url.starts_with("https://") {
        let mut tls = json!({ "hosts": [host] });
        if let Some(secret) = &settings.tls_secret {
            tls["secretName"] = secret.as_str().into();
        }
        spec["tls"] = json!([tls]);
    }
    let mut metadata = json!({ "name": service, "labels": labels(service) });
    if !settings.annotations.is_empty() {
        metadata["annotations"] = json!(settings.annotations);
    }
    Ok(json!({
        "apiVersion": "networking.k8s.io/v1",
        "kind": "Ingress",
        "metadata": metadata,
        "spec": spec,
    }))
}

/// The minimal chart Studio generates from `s`'s passport (ADR-0064 §5): a
/// Deployment, or a StatefulSet with a volume claim when it keeps data; a
/// Service for its ports; a Secret with what Studio made for it; the
/// project's files for it in a ConfigMap -- a Secret when one of them says a
/// `{secret.*}` -- mounted read-only at their paths, a hash of them on the
/// pod so a change restarts it; and, given `ingress`, an Ingress routing its
/// `public_url` to its http port. Each file as `(path in the chart,
/// contents)`. Nothing in it is templated -- data is base64 -- it is the
/// manifests as they apply, under Helm's release for its lifecycle.
pub fn generated_chart(
    s: &InfraService,
    image: &str,
    namespace: &str,
    secrets: &BTreeMap<String, String>,
    pull_secret: Option<&str>,
    ingress: Option<&InfraIngress>,
) -> Result<Vec<(String, String)>, String> {
    use base64::Engine as _;
    use sha2::Digest as _;
    let b64 = |v: &str| base64::engine::general_purpose::STANDARD.encode(v.as_bytes());
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
    let args: Vec<&String> = p.args.iter().chain(&s.args).collect();
    if !args.is_empty() {
        c.insert("args".into(), json!(args));
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
    let mut mounts = Vec::new();
    if let (true, Some(path)) = (p.stateful, &p.data_path) {
        mounts.push(json!({ "name": volume, "mountPath": path }));
    }
    // The project's files: one object, each file a key mounted by subPath
    // at its path, read-only.
    let filled = self::files(s, namespace, secrets)?;
    let mut volumes = Vec::new();
    let mut annotations = serde_json::Map::new();
    if !filled.is_empty() {
        let holder = format!("{name}-files");
        let secret = s.files.values().any(|t| {
            file_refs(t).iter().any(|r| {
                matches!(
                    r,
                    FileRef::Template(TemplateRef::Secret(_)) | FileRef::Env(_)
                )
            })
        });
        let mut data = serde_json::Map::new();
        let mut hash = sha2::Sha256::new();
        for (n, (path, text)) in filled.iter().enumerate() {
            let key = format!("file-{n}");
            data.insert(key.clone(), b64(text).into());
            mounts.push(json!({
                "name": "files", "mountPath": path, "subPath": key, "readOnly": true,
            }));
            hash.update(path.as_bytes());
            hash.update([0u8]);
            hash.update(text.as_bytes());
            hash.update([0u8]);
        }
        let object = if secret {
            volumes.push(json!({ "name": "files", "secret": { "secretName": holder } }));
            json!({
                "apiVersion": "v1", "kind": "Secret",
                "metadata": { "name": holder, "labels": labels(name) },
                "type": "Opaque",
                "data": data,
            })
        } else {
            volumes.push(json!({ "name": "files", "configMap": { "name": holder } }));
            json!({
                "apiVersion": "v1", "kind": "ConfigMap",
                "metadata": { "name": holder, "labels": labels(name) },
                "binaryData": data,
            })
        };
        files.push(("templates/files.yaml".to_owned(), yaml(&object)?));
        annotations.insert(
            FILES_HASH_ANNOTATION.into(),
            format!("{:x}", hash.finalize()).into(),
        );
    }
    if !mounts.is_empty() {
        c.insert("volumeMounts".into(), mounts.into());
    }
    let mut pod = json!({ "containers": [container] });
    if !volumes.is_empty() {
        merge_obj(&mut pod, json!({ "volumes": volumes }));
    }
    if let Some(secret) = pull_secret {
        merge_obj(
            &mut pod,
            json!({ "imagePullSecrets": [{ "name": secret }] }),
        );
    }
    let mut meta = json!({ "labels": labels(name) });
    if !annotations.is_empty() {
        meta["annotations"] = annotations.into();
    }
    let template = json!({
        "metadata": meta,
        "spec": pod,
    });
    if let (Some(settings), Some(url)) = (ingress, &s.public_url) {
        let object = infra_ingress(name, url, main_port(p), settings)?;
        files.push(("templates/ingress.yaml".to_owned(), yaml(&object)?));
    }
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

/* ── what a build's lock says (ADR-0065) ── */

/// How many builds' infra a project keeps: a deploy names a recent build,
/// and a rollback one a little older. A deploy of a build no longer kept is
/// refused rather than run with other services.
pub const MAX_LOCKED_BUILDS: usize = 50;

/// An image as the product chose it, and its digest when the reference
/// names one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockedImage {
    pub reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

/// One infra service as a build's lock resolved it for the build's profile
/// (ADR-0065 §3): the passport read from its source, the product's choice of
/// image and chart, and its configuration with the product's values over it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockedService {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub passport_hash: String,
    pub passport: InfraPassport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<LockedImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_version: Option<String>,
    #[serde(default)]
    pub config: BTreeMap<String, String>,
}

/// One build's infra services, kept on the project for its deploys.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuiltInfra {
    pub build: String,
    pub services: Vec<LockedService>,
}

/// The services of `resolved`, a `gearbox resolve --format json` answer;
/// empty for a product without `infra`. A passport's description is left
/// out: a deploy does not read it, and the manifest that carries these is
/// small.
pub fn locked_services(resolved: &Value) -> Result<Vec<LockedService>, String> {
    let Some(services) = resolved.pointer("/infra/services") else {
        return Ok(Vec::new());
    };
    let mut list: Vec<LockedService> = serde_json::from_value(services.clone())
        .map_err(|e| format!("the lock's infra services are not what Studio reads: {e}"))?;
    for s in &mut list {
        s.passport.description = None;
    }
    Ok(list)
}

/// Keep `services` as `build`'s, the newest first, at most
/// [`MAX_LOCKED_BUILDS`].
pub fn keep_built(kept: &mut Vec<BuiltInfra>, build: &str, services: Vec<LockedService>) {
    kept.retain(|b| b.build != build);
    kept.insert(
        0,
        BuiltInfra {
            build: build.to_owned(),
            services,
        },
    );
    kept.truncate(MAX_LOCKED_BUILDS);
}

/// The digest an image reference names (`…@sha256:…`).
fn digest_in(reference: &str) -> Option<&str> {
    reference
        .rsplit_once('@')
        .map(|(_, d)| d)
        .filter(|d| d.starts_with("sha256:"))
}

/// The tag an image reference names (`…/keycloak:26.0.7@sha256:…` is
/// `26.0.7`); a registry's port is not one.
fn tag_in(reference: &str) -> Option<&str> {
    let name = reference.split('@').next().unwrap_or(reference);
    let last = name.rsplit('/').next().unwrap_or(name);
    last.split_once(':')
        .map(|(_, t)| t)
        .filter(|t| !t.is_empty())
}

/// Is `copy` a copy of the image the lock chose? By its digest when the
/// lock names one; else by its tag, which an import keeps (ADR-0064 §4).
fn copies(copy: &str, locked: &LockedImage) -> bool {
    match locked.digest.as_deref() {
        Some(wanted) => digest_in(copy) == Some(wanted),
        None => match tag_in(&locked.reference) {
            Some(wanted) => tag_in(copy) == Some(wanted),
            None => true,
        },
    }
}

/// The services a deploy of a build runs (ADR-0065 §3): each one the lock
/// names, with its passport and configuration, joined by name with the
/// environment's side kept on the project (`records`): the copy of its
/// image, a ready chart's copy and values, its public address.
///
/// A copy of another image than the lock names -- another digest, or
/// another tag when the lock has no digest -- is no copy of it: the service
/// is left without an image, which the plan refuses as
/// `INFRA_IMAGE_NOT_IMPORTED` naming the lock's reference.
pub fn from_lock(locked: &[LockedService], records: &[InfraService]) -> Vec<InfraService> {
    locked
        .iter()
        .map(|l| {
            let record = records.iter().find(|r| r.name() == l.name);
            let mut passport = l.passport.clone();
            passport.name = l.name.clone();
            passport.config = l.config.clone();
            if let Some(i) = &l.image {
                passport.image = Some(i.reference.clone());
            }
            if l.chart.is_some() {
                passport.chart = l.chart.clone();
                passport.chart_version = l.chart_version.clone();
            }
            let image = record
                .and_then(|r| r.image.clone())
                .filter(|copy| l.image.as_ref().is_none_or(|i| copies(copy, i)));
            InfraService {
                passport,
                image,
                chart_ref: record.and_then(|r| r.chart_ref.clone()),
                chart_version: record.and_then(|r| r.chart_version.clone()),
                chart_values: record.and_then(|r| r.chart_values.clone()),
                public_url: record.and_then(|r| r.public_url.clone()),
                files: record.map(|r| r.files.clone()).unwrap_or_default(),
                args: record.map(|r| r.args.clone()).unwrap_or_default(),
            }
        })
        .collect()
}

/// The services a deploy of `built` runs: what its lock resolved
/// ([`from_lock`]), or the project's records as they are when the build kept
/// none (ADR-0064). One rule for the plan and the deploy, so the plan shows
/// what a deploy will install and refuse.
pub fn built_services(built: &BuiltInfra, records: &[InfraService]) -> Vec<InfraService> {
    if built.services.is_empty() {
        records.to_vec()
    } else {
        from_lock(&built.services, records)
    }
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
