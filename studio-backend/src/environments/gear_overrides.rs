//! A configuration secret that sets a gear's config field over the product's
//! description, and what a deploy does about it.
//!
//! The gear runtime reads its configuration in layers: the generated YAML,
//! then every `APP__GEARS__<GEAR>__CONFIG__<FIELD>` variable over it. A
//! configuration secret of that name is injected into every application, so
//! it silently replaces what `product.gdl` says for the field. On 2026-11-06
//! the dev environment of "Studioweb" carried
//! `APP__GEARS__MINI_CHAT__CONFIG__CLIENT_CREDENTIALS__CLIENT_SECRET` with a
//! value nobody chose; it overrode `client_secret = "${MINI_CHAT_CLIENT_SECRET}"`
//! and Keycloak refused mini-chat.
//!
//! Now, for each such secret, the deploy looks at the field in the
//! description:
//!
//! - the description fills it -- a literal, or a `${VAR}` the environment
//!   provides: the description wins, the secret is not injected, and the
//!   deploy says so ([`SHADOWED`], a warning);
//! - the description reads a `${VAR}` the environment does not provide: the
//!   two disagree on where the value comes from, and the deploy is refused
//!   until one goes ([`CONFLICT`]);
//! - the description does not set the field: the secret is the value, as
//!   before, and nothing is said.
//!
//! Setting such a secret is refused the same way when the description
//! already sets the field (`config_secret_set`), so nobody keeps a value
//! that a deploy would ignore. The infra plan lists every clash before a
//! deploy (`configuration`), and a deploy's record carries the warnings.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

/// A configuration secret is not injected: the description fills the field.
pub const SHADOWED: &str = "CONFIG_SECRET_SHADOWED_BY_DESCRIPTION";

/// A configuration secret and the description's `${VAR}` both claim a field,
/// and the environment does not provide `VAR`: the deploy is refused.
pub const CONFLICT: &str = "CONFIG_SECRET_CONFLICTS_WITH_DESCRIPTION";

/// What a deploy does about one configuration secret that sets a gear's
/// config field the description also sets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clash {
    /// The configuration secret: `APP__GEARS__MINI_CHAT__CONFIG__…`.
    pub key: String,
    /// The gear or plugin, as the description names it: `mini-chat`.
    pub gear: String,
    /// The field, dotted: `client_credentials.client_secret`.
    pub field: String,
    /// [`SHADOWED`] (a warning: the secret is dropped) or [`CONFLICT`] (a
    /// refusal).
    pub code: &'static str,
    pub message: String,
}

impl Clash {
    pub fn refuses(&self) -> bool {
        self.code == CONFLICT
    }

    /// `CODE: message`, as a deploy's progress and outcome say it.
    pub fn line(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

/// A name as the runtime's environment layer spells it: `mini-chat` ->
/// `MINI_CHAT`.
fn up(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// `APP__GEARS__<GEAR>__CONFIG__<A>__<B>`: the gear's segment and the
/// field's; `None` for any other key.
pub fn field_of(key: &str) -> Option<(&str, Vec<&str>)> {
    let rest = key.strip_prefix("APP__GEARS__")?;
    let (gear, field) = rest.split_once("__CONFIG__")?;
    let path: Vec<&str> = field.split("__").collect();
    (!gear.is_empty() && path.iter().all(|p| !p.is_empty())).then_some((gear, path))
}

/// The value at `path` (segments in the environment layer's spelling) of a
/// configuration, and the field as the description spells it.
fn value_at<'a>(config: &'a Value, path: &[&str]) -> Option<(&'a Value, String)> {
    let mut at = config;
    let mut names = Vec::new();
    for seg in path {
        let (name, next) = at.as_object()?.iter().find(|(k, _)| up(k) == *seg)?;
        names.push(name.as_str());
        at = next;
    }
    (!at.is_null()).then(|| (at, names.join(".")))
}

/// The variables a string reads without a default: `${VAR}`. A
/// `${VAR:-default}` fills the field either way, so it is not one.
fn references(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("${") {
        rest = &rest[at + 2..];
        let Some(end) = rest.find('}') else { break };
        let inner = &rest[..end];
        if !inner.contains(':') && !inner.is_empty() {
            out.push(inner.to_owned());
        }
        rest = &rest[end + 1..];
    }
    out
}

/// What a deploy does about each configuration secret in `secret_keys` that
/// sets a gear's config field `configs` (the description's, by gear id) also
/// sets. `provided` is every variable the environment gives the release:
/// its configuration secrets and what its infra services provide.
pub fn clashes(
    configs: &BTreeMap<String, Value>,
    secret_keys: &[String],
    provided: &BTreeSet<String>,
) -> Vec<Clash> {
    let mut out = Vec::new();
    for key in secret_keys {
        let Some((gear_seg, path)) = field_of(key) else {
            continue;
        };
        let Some((gear, config)) = configs.iter().find(|(id, _)| up(id) == gear_seg) else {
            continue;
        };
        let Some((value, field)) = value_at(config, &path) else {
            continue;
        };
        let refs = value.as_str().map(references).unwrap_or_default();
        let missing: Vec<&String> = refs.iter().filter(|r| !provided.contains(*r)).collect();
        // A literal may be a credential: named, never shown.
        let said = match value {
            Value::String(s) if !refs.is_empty() => format!("\"{s}\""),
            Value::String(_) | Value::Object(_) | Value::Array(_) => {
                "a value of its own".to_owned()
            }
            v => v.to_string(),
        };
        let clash = if missing.is_empty() {
            Clash {
                key: key.clone(),
                gear: gear.clone(),
                field: field.clone(),
                code: SHADOWED,
                message: format!(
                    "the configuration secret {key} would replace {gear}'s {field}, which the \
                     product description sets to {said}: the description wins and {key} is not \
                     given to the release. Delete the secret (config_secret_delete), or take \
                     the field out of the description to let the secret set it"
                ),
            }
        } else {
            let vars: Vec<&str> = missing.iter().map(|v| v.as_str()).collect();
            Clash {
                key: key.clone(),
                gear: gear.clone(),
                field: field.clone(),
                code: CONFLICT,
                message: format!(
                    "the configuration secret {key} and the product description both set \
                     {gear}'s {field}: the description reads it from {}, which this \
                     environment does not provide, and {key} would replace it. Keep one: set \
                     {} as a configuration secret and delete {key}, or take the field out of \
                     the description",
                    vars.iter()
                        .map(|v| format!("${{{v}}}"))
                        .collect::<Vec<_>>()
                        .join(", "),
                    vars.join(", ")
                ),
            }
        };
        out.push(clash);
    }
    out
}

/// `secret_keys` without the ones the description wins over.
pub fn injected(secret_keys: Vec<String>, clashes: &[Clash]) -> Vec<String> {
    secret_keys
        .into_iter()
        .filter(|k| !clashes.iter().any(|c| c.code == SHADOWED && &c.key == k))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str = "APP__GEARS__MINI_CHAT__CONFIG__CLIENT_CREDENTIALS__CLIENT_SECRET";

    fn configs() -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "mini-chat".to_owned(),
                json!({"client_credentials": {"client_id": "mini-chat",
                       "client_secret": "${MINI_CHAT_CLIENT_SECRET}"}}),
            ),
            (
                "file-storage".to_owned(),
                json!({"finalize_internal_secret": "dev-literal"}),
            ),
        ])
    }

    fn set(vars: &[&str]) -> BTreeSet<String> {
        vars.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn a_key_names_a_gear_and_a_field() {
        assert_eq!(
            field_of(KEY),
            Some(("MINI_CHAT", vec!["CLIENT_CREDENTIALS", "CLIENT_SECRET"]))
        );
        assert_eq!(field_of("SMTP_PASSWORD"), None);
        assert_eq!(field_of("APP__GEARS__X__CONFIG__"), None);
        assert_eq!(field_of("APP__GEARS____CONFIG__A"), None);
    }

    #[test]
    fn a_provided_reference_wins_and_the_secret_is_not_injected() {
        let keys = vec![KEY.to_owned(), "MINI_CHAT_CLIENT_SECRET".to_owned()];
        let found = clashes(&configs(), &keys, &set(&["MINI_CHAT_CLIENT_SECRET"]));
        assert_eq!(found.len(), 1, "{found:?}");
        let c = &found[0];
        assert_eq!(
            (c.code, c.gear.as_str(), c.field.as_str()),
            (SHADOWED, "mini-chat", "client_credentials.client_secret")
        );
        assert!(!c.refuses());
        assert!(
            c.message.contains("${MINI_CHAT_CLIENT_SECRET}"),
            "{}",
            c.message
        );
        assert_eq!(injected(keys, &found), vec!["MINI_CHAT_CLIENT_SECRET"]);
    }

    #[test]
    fn a_literal_wins_without_showing_it() {
        let key = "APP__GEARS__FILE_STORAGE__CONFIG__FINALIZE_INTERNAL_SECRET".to_owned();
        let found = clashes(&configs(), std::slice::from_ref(&key), &set(&[]));
        assert_eq!(found[0].code, SHADOWED);
        assert!(
            !found[0].message.contains("dev-literal"),
            "{}",
            found[0].message
        );
        assert!(injected(vec![key], &found).is_empty());
    }

    #[test]
    fn a_reference_the_environment_lacks_refuses() {
        let found = clashes(&configs(), &[KEY.to_owned()], &set(&[]));
        assert_eq!(found[0].code, CONFLICT);
        assert!(found[0].refuses());
        assert!(found[0].line().starts_with(CONFLICT));
        assert!(
            found[0].message.contains("set MINI_CHAT_CLIENT_SECRET"),
            "{}",
            found[0].message
        );
        // A refusal drops nothing: the deploy does not run.
        assert_eq!(injected(vec![KEY.to_owned()], &found), vec![KEY]);
    }

    #[test]
    fn a_field_the_description_leaves_unset_is_the_secrets() {
        let key = "APP__GEARS__MINI_CHAT__CONFIG__CLIENT_CREDENTIALS__TOKEN_URL".to_owned();
        assert!(clashes(&configs(), &[key], &set(&[])).is_empty());
        let other = "APP__GEARS__OAGW__CONFIG__KEY".to_owned();
        assert!(clashes(&configs(), &[other], &set(&[])).is_empty());
        let defaulted = BTreeMap::from([(
            "mini-chat".to_owned(),
            json!({"client_credentials": {"client_secret": "${S:-x}"}}),
        )]);
        assert_eq!(
            clashes(&defaulted, &[KEY.to_owned()], &set(&[]))[0].code,
            SHADOWED
        );
    }
}
