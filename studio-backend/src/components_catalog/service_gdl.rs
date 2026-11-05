//! An own service's passport, `service.gdl` (GDL 1.6, ADR-0061), read
//! without evaluating it.
//!
//! A service that is not a gear -- its own image, built from its own
//! Dockerfile -- says what it is in one file beside it:
//!
//! ```text
//! gdl_version = "1.6"
//!
//! service(
//!     name = "studio-theia",
//!     version = "1.4.0",
//!     description = "The IDE a project's session runs",
//!     image = "ghcr.io/constructorfabric/studio-theia",
//!     dockerfile = "Dockerfile",
//!     context = ".",
//!     ports = {"http": 3000},
//!     health = "/healthz",
//!     env = {"STUDIO_API_URL": "gateway.url"},
//!     requires = ["studio-session"],
//!     provides = ["ide"],
//!     docs = ["README.md"],
//! )
//! ```
//!
//! Only `name` is required. Paths (`dockerfile`, `context`, `docs`) are
//! relative to the passport's directory and may not leave the repository.
//!
//! An **infra service** (ADR-0064) is a third-party service a product runs
//! beside its gears -- PostgreSQL, Keycloak -- and says `kind = "infra"`:
//!
//! ```text
//! service(
//!     name = "keycloak",
//!     kind = "infra",
//!     image = "quay.io/keycloak/keycloak:26.0.7",   # a tag or a digest is fine here
//!     args = ["start-dev"],
//!     ports = {"http": 8080, "management": 9000},
//!     health = "/health/ready",
//!     config = {"KC_HEALTH_ENABLED": "true"},       # literal values
//!     secrets = ["KC_BOOTSTRAP_ADMIN_PASSWORD"],    # Studio makes and keeps them
//!     provides = {"oidc.issuer": "{public_url}/realms/product"},
//!     stateful = False,
//!     chart = "oci://registry-1.docker.io/bitnamicharts/keycloak",
//!     chart_version = "24.4.0",
//! )
//! ```
//!
//! Its `provides` is a dict: each key a capability a gear's configuration
//! reads (as `${OIDC_ISSUER}`, the key's [`variable`]), each value a
//! template of `{host}`, `{namespace}`, `{public_url}`, `{port.<name>}`,
//! `{config.<KEY>}` and `{secret.<KEY>}`. It has no Dockerfile: it is
//! pulled, never built.

use std::collections::BTreeMap;

use super::gdl_literal::{self, Args, DictValue, Lit};

/// The GDL version `service.gdl` was introduced in.
pub(crate) const GDL_VERSION: &str = "1.6";

/// The file that marks an own service.
pub(crate) const FILE: &str = "service.gdl";

/// What a `service.gdl` declares.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ServicePassport {
    /// Its id, kebab-case.
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    /// The image it is published as, without a tag; an infra service's is
    /// its publisher's, with one.
    pub image: Option<String>,
    /// Its Dockerfile, relative to the passport's directory.
    pub dockerfile: Option<String>,
    /// Its build context, relative to the passport's directory.
    pub context: Option<String>,
    /// Each port it listens on, by name.
    pub ports: BTreeMap<String, u16>,
    /// The route that answers when it is healthy.
    pub health: Option<String>,
    /// The variables it reads, each to what fills it.
    pub env: BTreeMap<String, String>,
    /// The platform gears it calls.
    pub requires: Vec<String>,
    /// What it offers others, by capability key.
    pub provides: Vec<String>,
    /// Its documents, relative to the passport's directory.
    pub docs: Vec<String>,
    /// What an infra service adds (`kind = "infra"`); `None` for an own one.
    pub infra: Option<Infra>,
}

/// What an infra service's passport says beyond an own service's
/// (ADR-0064 §1).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Infra {
    /// The container's arguments.
    pub args: Vec<String>,
    /// Variables with literal values.
    pub config: BTreeMap<String, String>,
    /// Variables whose values Studio makes once per environment and keeps.
    pub secrets: Vec<String>,
    /// Each capability it provides, to the template of its value (empty
    /// when the passport lists the key without one).
    pub provides: BTreeMap<String, String>,
    /// It keeps data: a volume of its own.
    pub stateful: bool,
    /// The volume's size (`10Gi`); `None` for the default.
    pub storage: Option<String>,
    /// Where the volume is mounted.
    pub data_path: Option<String>,
    /// A ready chart it may be installed from, where it is published.
    pub chart: Option<String>,
    pub chart_version: Option<String>,
}

/// One name a `provides` template refers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TemplateRef {
    /// `{host}`: the Service's name in the namespace.
    Host,
    /// `{namespace}`: the namespace it runs in.
    Namespace,
    /// `{public_url}`: where people reach it, as the project says; a deploy
    /// of a service without one is refused (`INFRA_PUBLIC_URL_MISSING`),
    /// never filled with the cluster's own address.
    PublicUrl,
    /// `{port.<name>}`.
    Port(String),
    /// `{config.<KEY>}`.
    Config(String),
    /// `{secret.<KEY>}`.
    Secret(String),
}

impl std::fmt::Display for TemplateRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Host => write!(f, "{{host}}"),
            Self::Namespace => write!(f, "{{namespace}}"),
            Self::PublicUrl => write!(f, "{{public_url}}"),
            Self::Port(p) => write!(f, "{{port.{p}}}"),
            Self::Config(k) => write!(f, "{{config.{k}}}"),
            Self::Secret(k) => write!(f, "{{secret.{k}}}"),
        }
    }
}

/// The names `template` refers to, in order; `Err` names the first one this
/// does not know, or a brace left open.
pub(crate) fn template_refs(template: &str) -> Result<Vec<TemplateRef>, String> {
    let mut out = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        if rest[..open].contains('}') {
            return Err(format!("closes a `}}` it never opened in \"{template}\""));
        }
        let after = &rest[open + 1..];
        let close = after
            .find('}')
            .ok_or_else(|| format!("leaves `{{` open in \"{template}\""))?;
        let name = &after[..close];
        out.push(match name.split_once('.') {
            None if name == "host" => TemplateRef::Host,
            None if name == "namespace" => TemplateRef::Namespace,
            None if name == "public_url" => TemplateRef::PublicUrl,
            Some(("port", p)) if gdl_literal::kebab(p).is_ok() => TemplateRef::Port(p.to_owned()),
            Some(("config", k)) if env_name(k).is_ok() => TemplateRef::Config(k.to_owned()),
            Some(("secret", k)) if env_name(k).is_ok() => TemplateRef::Secret(k.to_owned()),
            _ => {
                return Err(format!(
                    "refers to `{{{name}}}`; a template knows {{host}}, {{namespace}}, \
                     {{public_url}}, {{port.<name>}}, {{config.<KEY>}} and {{secret.<KEY>}}"
                ));
            }
        });
        rest = &after[close + 1..];
    }
    if rest.contains('}') {
        return Err(format!("closes a `}}` it never opened in \"{template}\""));
    }
    Ok(out)
}

/// The variable a gear's configuration reads a capability as:
/// `oidc.issuer` -> `OIDC_ISSUER`.
pub(crate) fn variable(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// A capability key: `oidc.issuer`, `database.url`, `postgres`.
pub(crate) fn capability(s: &str) -> Result<(), String> {
    let ok = s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        && !s.ends_with('.');
    if ok {
        Ok(())
    } else {
        Err("is not a capability key (lowercase, dotted: oidc.issuer)".into())
    }
}

const ARGS: [&str; 21] = [
    "name",
    "kind",
    "version",
    "description",
    "image",
    "dockerfile",
    "context",
    "ports",
    "health",
    "env",
    "requires",
    "provides",
    "docs",
    "args",
    "config",
    "secrets",
    "stateful",
    "storage",
    "data_path",
    "chart",
    "chart_version",
];

/// The arguments only an infra service takes.
const INFRA_ONLY: [&str; 8] = [
    "args",
    "config",
    "secrets",
    "stateful",
    "storage",
    "data_path",
    "chart",
    "chart_version",
];

/// Read a `service.gdl`. `Err` says why it is not one this reads.
pub(crate) fn read(src: &str) -> Result<ServicePassport, String> {
    let call = gdl_literal::read_call(src, FILE, &["service"], GDL_VERSION)?;
    let a = Args { call: &call };
    a.only(&ARGS)?;
    let infra_kind = match a.string("kind", gdl_literal::word)?.as_deref() {
        None | Some("own") => false,
        Some("infra") => true,
        Some(other) => {
            return Err(format!(
                "line {}: kind = \"{other}\" is not a kind; a service is \"own\" or \"infra\"",
                call.line
            ));
        }
    };
    let name = a.string("name", gdl_literal::kebab)?.ok_or_else(|| {
        format!(
            "line {}: `service()` must name itself: `name = \"…\"`",
            call.line
        )
    })?;
    let image = a.string("image", |s| {
        gdl_literal::word(s)?;
        // An infra service is someone else's image, named as they publish
        // it; it is imported by digest before it runs (ADR-0064 §4).
        if infra_kind {
            return Ok(());
        }
        if s.contains('@') || s.rsplit('/').next().is_some_and(|last| last.contains(':')) {
            return Err(
                "names a tag or a digest; the image is named without one, a build tags it".into(),
            );
        }
        Ok(())
    })?;
    let ports: BTreeMap<String, u16> = a
        .dict("ports", gdl_literal::kebab, |v| match v {
            DictValue::Int(n) if (1..=65535).contains(n) => Ok(()),
            DictValue::Str(s) if s.parse::<u16>().is_ok_and(|n| n > 0) => Ok(()),
            _ => Err("is not a port (1 to 65535)".into()),
        })?
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| {
            let n = match v {
                DictValue::Int(n) => u16::try_from(n).unwrap_or_default(),
                DictValue::Str(s) => s.parse::<u16>().unwrap_or_default(),
            };
            (k, n)
        })
        .collect();
    let env = a
        .dict("env", env_name, |v| match v {
            DictValue::Str(s) => gdl_literal::one_line(s),
            DictValue::Int(_) => {
                Err("is not what fills it (a string such as \"gateway.url\")".into())
            }
        })?
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, v.text()))
        .collect();
    let mut requires = a.list("requires", gdl_literal::kebab)?.unwrap_or_default();
    requires.sort();
    requires.dedup();
    let infra = if infra_kind {
        Some(read_infra(&a, &ports, call.line)?)
    } else {
        if let Some((arg, l)) = INFRA_ONLY
            .iter()
            .find_map(|arg| a.get(arg).map(|(_, l)| (arg, l)))
        {
            return Err(format!(
                "line {l}: `{arg}` goes with kind = \"infra\": an own service is built from its \
                 Dockerfile and filled through `env`"
            ));
        }
        if let Some((Lit::Dict(_), l)) = a.get("provides") {
            return Err(format!(
                "line {l}: `provides` is a list of capability keys; a dict of values goes with \
                 kind = \"infra\""
            ));
        }
        None
    };
    let provides = match &infra {
        Some(i) => i.provides.keys().cloned().collect(),
        None => a.list("provides", gdl_literal::word)?.unwrap_or_default(),
    };
    Ok(ServicePassport {
        name,
        version: a.string("version", gdl_literal::word)?,
        description: a.string("description", gdl_literal::one_line)?,
        image,
        dockerfile: a.string("dockerfile", gdl_literal::relative_path)?,
        context: a.string("context", gdl_literal::relative_path)?,
        ports,
        health: a.string("health", gdl_literal::route)?,
        env,
        requires,
        provides,
        docs: a
            .list("docs", gdl_literal::relative_path)?
            .unwrap_or_default(),
        infra,
    })
}

/// The arguments only an infra service takes, checked against each other.
fn read_infra(a: &Args<'_>, ports: &BTreeMap<String, u16>, line: usize) -> Result<Infra, String> {
    for own_only in ["dockerfile", "context"] {
        if let Some((_, l)) = a.get(own_only) {
            return Err(format!(
                "line {l}: an infra service is pulled, never built: it has no `{own_only}`"
            ));
        }
    }
    let chart = a.string("chart", |s| {
        gdl_literal::word(s)?;
        if s.starts_with("oci://") || s.starts_with("https://") {
            Ok(())
        } else {
            Err("is not where a chart is published (oci://… or https://…)".into())
        }
    })?;
    if a.get("image").is_none() && chart.is_none() {
        return Err(format!(
            "line {line}: an infra service names its `image`, or a ready `chart`, or both"
        ));
    }
    let chart_version = a.string("chart_version", gdl_literal::word)?;
    if chart_version.is_some() && chart.is_none() {
        return Err(format!(
            "line {line}: `chart_version` goes with the `chart` it is a version of"
        ));
    }
    let config: BTreeMap<String, String> = a
        .dict("config", env_name, |v| match v {
            DictValue::Str(s) if s.contains(['\n', '\r']) => Err("spans lines".into()),
            _ => Ok(()),
        })?
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, v.text()))
        .collect();
    let mut secrets = a.list("secrets", env_name)?.unwrap_or_default();
    secrets.sort();
    secrets.dedup();
    if let Some(both) = secrets.iter().find(|s| config.contains_key(*s)) {
        return Err(format!(
            "line {line}: {both} is both in `config` and in `secrets`; a secret is Studio's to make"
        ));
    }
    let provides = read_provides(a, ports, &config, &secrets)?;
    let stateful = match a.get("stateful") {
        None | Some((Lit::None, _)) => false,
        Some((Lit::Bool(b), _)) => *b,
        Some((_, l)) => return Err(format!("line {l}: `stateful` is True or False")),
    };
    let storage = a.string("storage", volume_size)?;
    let data_path = a.string("data_path", |s| {
        if s.starts_with('/') && !s.chars().any(char::is_whitespace) {
            Ok(())
        } else {
            Err("is not an absolute path in the container".into())
        }
    })?;
    if (storage.is_some() || data_path.is_some()) && !stateful {
        return Err(format!(
            "line {line}: `storage` and `data_path` go with stateful = True"
        ));
    }
    if stateful && data_path.is_none() {
        return Err(format!(
            "line {line}: a stateful service says where its volume is mounted: `data_path`"
        ));
    }
    Ok(Infra {
        args: a.list("args", gdl_literal::one_line)?.unwrap_or_default(),
        config,
        secrets,
        provides,
        stateful,
        storage,
        data_path,
        chart,
        chart_version,
    })
}

/// An infra service's `provides`: a dict of key to template, each name the
/// template refers to declared by the passport; or a list of keys.
fn read_provides(
    a: &Args<'_>,
    ports: &BTreeMap<String, u16>,
    config: &BTreeMap<String, String>,
    secrets: &[String],
) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    match a.get("provides") {
        None | Some((Lit::None, _)) => {}
        Some((Lit::Dict(entries), l)) => {
            for (k, v) in entries {
                capability(k).map_err(|e| format!("line {l}: provides: the key \"{k}\" {e}"))?;
                let DictValue::Str(template) = v else {
                    return Err(format!(
                        "line {l}: provides: \"{k}\" is a template string, such as \
                         \"{{host}}:{{port.http}}\""
                    ));
                };
                for r in template_refs(template)
                    .map_err(|e| format!("line {l}: provides: \"{k}\" {e}"))?
                {
                    let known = match &r {
                        TemplateRef::Port(p) => ports.contains_key(p),
                        TemplateRef::Config(c) => config.contains_key(c),
                        TemplateRef::Secret(s) => secrets.contains(s),
                        TemplateRef::PublicUrl => !ports.is_empty(),
                        TemplateRef::Host | TemplateRef::Namespace => true,
                    };
                    if !known {
                        return Err(format!(
                            "line {l}: provides: \"{k}\" refers to {r}, which the passport does \
                             not declare"
                        ));
                    }
                }
                out.insert(k.clone(), template.clone());
            }
        }
        Some((Lit::List(items), l)) => {
            // Keys without values: the shared place's, or the project's.
            for k in items {
                capability(k).map_err(|e| format!("line {l}: provides: \"{k}\" {e}"))?;
                out.insert(k.clone(), String::new());
            }
        }
        Some((_, l)) => {
            return Err(format!(
                "line {l}: `provides` is a dict of capability to template"
            ));
        }
    }
    Ok(out)
}

/// A volume size: `10Gi`, `512Mi`.
pub(crate) fn volume_size(s: &str) -> Result<(), String> {
    let digits = s.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let unit = &s[digits.len()..];
    if !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && ["Mi", "Gi", "Ti"].contains(&unit)
    {
        Ok(())
    } else {
        Err("is not a volume size (10Gi, 512Mi)".into())
    }
}

/// An environment variable name: `STUDIO_API_URL`.
pub(crate) fn env_name(s: &str) -> Result<(), String> {
    let valid = s.starts_with(|c: char| c.is_ascii_uppercase() || c == '_')
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if valid {
        Ok(())
    } else {
        Err("is not a variable name (uppercase letters, digits and `_`)".into())
    }
}

#[cfg(test)]
#[path = "service_gdl_tests.rs"]
mod tests;
