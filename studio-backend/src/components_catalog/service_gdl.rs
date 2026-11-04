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

use std::collections::BTreeMap;

use super::gdl_literal::{self, Args, DictValue};

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
    /// The image it is published as, without a tag.
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
}

const ARGS: [&str; 12] = [
    "name",
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
];

/// Read a `service.gdl`. `Err` says why it is not one this reads.
pub(crate) fn read(src: &str) -> Result<ServicePassport, String> {
    let call = gdl_literal::read_call(src, FILE, &["service"], GDL_VERSION)?;
    let a = Args { call: &call };
    a.only(&ARGS)?;
    let name = a.string("name", gdl_literal::kebab)?.ok_or_else(|| {
        format!(
            "line {}: `service()` must name itself: `name = \"…\"`",
            call.line
        )
    })?;
    let image = a.string("image", |s| {
        gdl_literal::word(s)?;
        if s.contains('@') || s.rsplit('/').next().is_some_and(|last| last.contains(':')) {
            return Err(
                "names a tag or a digest; the image is named without one, a build tags it".into(),
            );
        }
        Ok(())
    })?;
    let ports = a
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
        provides: a.list("provides", gdl_literal::word)?.unwrap_or_default(),
        docs: a
            .list("docs", gdl_literal::relative_path)?
            .unwrap_or_default(),
    })
}

/// An environment variable name: `STUDIO_API_URL`.
fn env_name(s: &str) -> Result<(), String> {
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
