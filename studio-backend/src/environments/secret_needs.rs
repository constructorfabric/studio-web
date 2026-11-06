//! Which configuration secrets a project's product needs in an environment,
//! and which of them are not set: read from the product's description and
//! its infra services, never from a value.
//!
//! **The description.** A `${NAME}` in the latest revision is a variable the
//! running product reads, and a deploy hands each configuration secret to
//! every application as one (`<release>-config`). One written outside
//! `profiles = [...]` (a gear's configuration) is needed everywhere; one
//! inside a profile only where that profile runs. Inside a profile's
//! `postgres(...)` with `existing_secret`, the database step writes it: it is
//! provided, not asked for. Comments are not read.
//!
//! **The infra services.** A capability a service passport leaves without a
//! value (`provides = {"smtp.password": ""}`) is the project's to set, as its
//! variable (`SMTP_PASSWORD`). What a service does provide is written by the
//! deploy and answers a `${NAME}` of the same name.

use std::collections::BTreeMap;

use super::infra::{InfraInstall, Install, variable};

/// One configuration secret the product needs in an environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretNeed {
    /// The variable: `SMTP_PASSWORD`.
    pub key: String,
    /// What needs it: `description`, `profile prod`, `infra keycloak`.
    pub needed_by: Vec<String>,
    /// What gives it without the project setting it: `database`,
    /// `infra keycloak`. `None`: only a set secret does.
    pub provided_by: Option<String>,
    /// Set for the environment (its key is kept; the value never is here).
    pub set: bool,
}

impl SecretNeed {
    /// Needed, not set, and nothing else gives it: a deploy would run the
    /// product without it.
    pub fn missing(&self) -> bool {
        !self.set && self.provided_by.is_none()
    }
}

/// What the product needs in an environment running `profile`, from its
/// description `text` (none before one is saved) and the infra services the
/// deploy brings, against the keys `set` there. By key.
pub fn needs(
    text: Option<&str>,
    profile: &str,
    installs: &[InfraInstall],
    set: &[String],
) -> Vec<SecretNeed> {
    let mut out: BTreeMap<String, SecretNeed> = BTreeMap::new();
    let mut need = |key: String, by: String, provided: Option<String>| {
        let n = out.entry(key.clone()).or_insert_with(|| SecretNeed {
            set: set.contains(&key),
            key,
            needed_by: Vec::new(),
            provided_by: None,
        });
        if !n.needed_by.contains(&by) {
            n.needed_by.push(by);
        }
        if n.provided_by.is_none() {
            n.provided_by = provided;
        }
    };
    // What the infra services write for the product, by variable.
    let mut produced: BTreeMap<String, String> = BTreeMap::new();
    for i in installs {
        let name = i.service.name().to_owned();
        match (i.install, &i.shared) {
            (Install::Database, _) => {}
            (Install::Shared, Some(place)) => {
                for k in place.provides.keys() {
                    produced.insert(variable(k), format!("infra {name}"));
                }
            }
            (Install::Shared, None) => {}
            _ => {
                for (k, template) in &i.service.passport.provides {
                    if template.is_empty() {
                        need(variable(k), format!("infra {name}"), None);
                    } else {
                        produced.insert(variable(k), format!("infra {name}"));
                    }
                }
            }
        }
    }
    if let Some(text) = text {
        for p in placeholders(text, profile) {
            let provided = if p.in_database {
                Some("database".to_owned())
            } else {
                produced.get(&p.name).cloned()
            };
            let by = if p.in_profile {
                format!("profile {profile}")
            } else {
                "description".to_owned()
            };
            need(p.name, by, provided);
        }
    }
    out.into_values().collect()
}

/// One `${NAME}` of a description.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Placeholder {
    name: String,
    /// Inside the profile asked for (not outside every profile).
    in_profile: bool,
    /// Inside that profile's `postgres(...)` with an `existing_secret`.
    in_database: bool,
}

/// The `${NAME}`s of `text` an environment running `profile` reads: those
/// outside `profiles = [...]`, and those of the profile whose `id` is
/// `profile`.
fn placeholders(text: &str, profile: &str) -> Vec<Placeholder> {
    let text = without_comments(text);
    let mut out = Vec::new();
    let Some((open, close)) = profiles_list(&text) else {
        out.extend(names(&text).into_iter().map(|name| Placeholder {
            name,
            in_profile: false,
            in_database: false,
        }));
        return out;
    };
    for part in [&text[..open], &text[close..]] {
        out.extend(names(part).into_iter().map(|name| Placeholder {
            name,
            in_profile: false,
            in_database: false,
        }));
    }
    for call in top_level_calls(&text[open + 1..close]) {
        if profile_id(call) != Some(profile) {
            continue;
        }
        let databases: Vec<&str> = calls_named(call, "postgres")
            .into_iter()
            .filter(|c| c.contains("existing_secret"))
            .collect();
        for name in names(call) {
            let in_database = databases.iter().any(|d| names(d).contains(&name));
            out.push(Placeholder {
                name,
                in_profile: true,
                in_database,
            });
        }
    }
    out
}

/// `text` with each `#` comment blanked out, a `#` inside a string kept.
fn without_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let mut in_string = false;
        let mut prev = '\0';
        let mut end = line.len();
        for (at, c) in line.char_indices() {
            match c {
                '"' if prev != '\\' => in_string = !in_string,
                '#' if !in_string => {
                    end = at;
                    break;
                }
                _ => {}
            }
            prev = c;
        }
        out.push_str(&line[..end]);
        out.push('\n');
    }
    out
}

/// The byte offsets of the `[` and `]` of `profiles = [...]`.
fn profiles_list(text: &str) -> Option<(usize, usize)> {
    let mut from = 0;
    while let Some(at) = text[from..].find("profiles") {
        let start = from + at;
        from = start + "profiles".len();
        let before = text[..start].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let rest = text[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        if !rest.starts_with('[') {
            continue;
        }
        let open = text.len() - rest.len();
        return Some((open, matching(text, open)?));
    }
    None
}

/// The offset of the bracket closing the one at `open`, strings skipped.
fn matching(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut prev = '\0';
    for (at, c) in text[open..].char_indices() {
        match c {
            '"' if prev != '\\' => in_string = !in_string,
            '(' | '[' | '{' if !in_string => depth += 1,
            ')' | ']' | '}' if !in_string => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(open + at);
                }
            }
            _ => {}
        }
        prev = c;
    }
    None
}

/// The calls of a list's body, each as written (`kubernetes(id = …)`).
fn top_level_calls(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(open) = body[at..].find('(').map(|o| at + o) {
        let start = body[..open]
            .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))
            .map_or(0, |s| s + 1);
        let Some(close) = matching(body, open) else {
            break;
        };
        out.push(&body[start..=close]);
        at = close + 1;
    }
    out
}

/// Every `name(...)` call inside `text`, at any depth.
fn calls_named<'a>(text: &'a str, name: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut from = 0;
    let call = format!("{name}(");
    while let Some(at) = text[from..].find(&call) {
        let start = from + at;
        let open = start + name.len();
        from = open + 1;
        let before = text[..start].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        if let Some(close) = matching(text, open) {
            out.push(&text[start..=close]);
        }
    }
    out
}

/// The `id = "…"` of a profile call.
fn profile_id(call: &str) -> Option<&str> {
    let mut from = 0;
    while let Some(at) = call[from..].find("id") {
        let start = from + at;
        from = start + 2;
        let before = call[..start].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let Some(rest) = call[from..].trim_start().strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start().strip_prefix('"')?;
        return rest.find('"').map(|end| &rest[..end]);
    }
    None
}

/// The `${NAME}`s of `text`, in order, each once.
fn names(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("${") {
        rest = &rest[at + 2..];
        let Some(end) = rest.find('}') else { break };
        let name = &rest[..end];
        let valid = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if valid && !out.iter().any(|n| n == name) {
            out.push(name.to_owned());
        }
        rest = &rest[end + 1..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environments::infra::{InfraPassport, InfraService, SharedService};

    const GDL: &str = r#"
product(
    id = "shop",
    # The password is only ever a `${NAME}` the deployment sets.
    profiles = [
        embedded(id = "dev", database = postgres(host = "127.0.0.1", password = "${DEV_PG_PASSWORD}")),
        kubernetes(id = "prod", discovery = "static",
                   database = postgres(host = "postgres", password = "${GEARS_PG_PASSWORD}",
                                       existing_secret = "shop-db"),
                   values = {"x": "${PROD_ONLY}"}),
    ],
    gears = [
        use_gear("mailer", config = {"smtp_password": "${SMTP_PASSWORD}", "issuer": "${OIDC_ISSUER}"}),
    ],
)
"#;

    fn install(name: &str, how: Install, provides: &[(&str, &str)]) -> InfraInstall {
        InfraInstall {
            service: InfraService {
                passport: InfraPassport {
                    name: name.to_owned(),
                    provides: provides
                        .iter()
                        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                        .collect(),
                    ..InfraPassport::default()
                },
                ..InfraService::default()
            },
            install: how,
            shared: None,
            ingress: None,
        }
    }

    fn by_key(needs: &[SecretNeed]) -> BTreeMap<&str, &SecretNeed> {
        needs.iter().map(|n| (n.key.as_str(), n)).collect()
    }

    #[test]
    fn a_profile_s_placeholders_count_only_where_it_runs_and_comments_never() {
        let all = needs(Some(GDL), "prod", &[], &[]);
        let keys: Vec<&str> = all.iter().map(|n| n.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "GEARS_PG_PASSWORD",
                "OIDC_ISSUER",
                "PROD_ONLY",
                "SMTP_PASSWORD"
            ]
        );
        let dev = needs(Some(GDL), "dev", &[], &[]);
        assert!(dev.iter().any(|n| n.key == "DEV_PG_PASSWORD"));
        assert!(!dev.iter().any(|n| n.key == "PROD_ONLY"));
        assert!(!dev.iter().any(|n| n.key == "NAME"));
    }

    #[test]
    fn a_database_password_with_an_existing_secret_is_provided() {
        let all = needs(Some(GDL), "prod", &[], &["SMTP_PASSWORD".to_owned()]);
        let k = by_key(&all);
        assert_eq!(
            k["GEARS_PG_PASSWORD"].provided_by.as_deref(),
            Some("database")
        );
        assert!(!k["GEARS_PG_PASSWORD"].missing());
        assert!(k["SMTP_PASSWORD"].set && !k["SMTP_PASSWORD"].missing());
        assert!(k["PROD_ONLY"].missing());
        assert_eq!(k["PROD_ONLY"].needed_by, ["profile prod"]);
        assert_eq!(k["SMTP_PASSWORD"].needed_by, ["description"]);
    }

    #[test]
    fn infra_answers_what_it_provides_and_asks_for_what_it_leaves_open() {
        let kc = install(
            "keycloak",
            Install::Generated,
            &[
                ("oidc.issuer", "{public_url}/realms/shop"),
                ("smtp.password", ""),
            ],
        );
        let all = needs(Some(GDL), "prod", &[kc], &[]);
        let k = by_key(&all);
        assert_eq!(
            k["OIDC_ISSUER"].provided_by.as_deref(),
            Some("infra keycloak")
        );
        assert!(k["SMTP_PASSWORD"].missing());
        assert_eq!(
            k["SMTP_PASSWORD"].needed_by,
            ["infra keycloak", "description"]
        );
        let mut shared = install("keycloak", Install::Shared, &[("oidc.issuer", "")]);
        shared.shared = Some(SharedService {
            service: "keycloak".into(),
            namespace: None,
            provides: [("oidc.issuer".to_owned(), "https://id".to_owned())].into(),
        });
        let k2 = needs(Some(GDL), "prod", &[shared], &[]);
        assert!(!by_key(&k2)["OIDC_ISSUER"].missing());
    }

    #[test]
    fn no_description_needs_nothing_of_its_own() {
        assert!(needs(None, "prod", &[], &[]).is_empty());
        assert_eq!(names("a ${X} ${X} ${1Y} ${Z_2} ${"), ["X", "Z_2"]);
        assert_eq!(profile_id(r#"kubernetes(id = "prod")"#), Some("prod"));
        assert_eq!(profile_id(r#"kubernetes(gid = "x", id="p")"#), Some("p"));
        assert_eq!(profile_id(r#"kubernetes(idle = 1, id = "q")"#), Some("q"));
    }
}
