//! The manifest: the gears this process linked, said in words a reader can use.
//!
//! Everything here is a pure function of what the gear registry reports and
//! what was compiled in, so the rules are tested without booting an assembly.

use std::collections::BTreeSet;

include!(concat!(env!("OUT_DIR"), "/design_docs.rs"));

/// One gear as the toolkit registry knows it.
#[derive(Debug, Clone)]
pub struct Linked {
    pub name: String,
    pub deps: Vec<String>,
    /// The registry's own labels: `rest`, `db`, `stateful`, `system`, …
    pub capabilities: Vec<String>,
}

/// Where a gear comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Written in this repository.
    Studio,
    /// Pulled in from the platform (gears-rust crates).
    Platform,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Studio => "studio",
            Self::Platform => "platform",
        }
    }
}

/// What a gear is to the others.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The platform's runtime: gateway, registries, resolvers' hosts.
    System,
    /// An implementation another gear selects at run time.
    Plugin,
    /// Everything else: a gear with work of its own.
    Gear,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Plugin => "plugin",
            Self::Gear => "gear",
        }
    }
}

/// One gear, described.
#[derive(Debug, Clone)]
pub struct Described {
    pub name: String,
    pub origin: Origin,
    pub role: Role,
    /// For a plugin: the gear whose extension point it fills, when its name says.
    pub extends: Option<String>,
    pub depends_on: Vec<String>,
    pub capabilities: Vec<String>,
    /// Position in the order the runtime initialises gears (dependencies first).
    pub order: u32,
    pub purpose: Option<String>,
    /// Repository path of the gear's design, when there is one.
    pub design_doc: Option<String>,
}

/// `docs/design/<name>.md`'s first paragraph of section 1.1, when it exists.
pub fn purpose_of(name: &str) -> Option<&'static str> {
    DESIGN_DOCS
        .iter()
        .find(|(stem, _)| *stem == name)
        .map(|(_, purpose)| *purpose)
}

/// The gear whose extension point a plugin fills, read off the plugin's name.
///
/// The platform names a plugin `<implementation>-<point>-plugin`
/// (`static-authn-plugin`, `gitlab-connector-plugin`), and the gear that hosts
/// the point carries `<point>` as a whole word of its own name
/// (`authn-resolver`, `studio-connector`, `credstore`). A plugin's
/// registration in the types registry names its GTS spec but not the gear that
/// selects it, so the name is the only link the process has. The match is
/// tried in three tiers — the exact name, `<point>-…`, `…-<point>` — and a tier
/// with two candidates answers nothing rather than a guess.
pub fn extension_point(plugin: &str, gears: &[&str]) -> Option<String> {
    let stem = plugin.strip_suffix("-plugin")?;
    let point = stem.rsplit('-').next()?;
    let prefix = format!("{point}-");
    let suffix = format!("-{point}");
    let hosts: Vec<&str> = gears.iter().copied().filter(|g| !is_plugin(g)).collect();
    for tier in 0..3 {
        let found: Vec<&str> = hosts
            .iter()
            .copied()
            .filter(|g| match tier {
                0 => *g == point,
                1 => g.starts_with(&prefix),
                _ => g.ends_with(&suffix),
            })
            .collect();
        match found.as_slice() {
            [one] => return Some((*one).to_owned()),
            [] => {}
            _ => return None,
        }
    }
    None
}

fn is_plugin(name: &str) -> bool {
    name.ends_with("-plugin")
}

/// Describe the linked gears, in the order given (the registry's topo order).
///
/// A gear is Studio's when its name says so (`studio-…`, rule A1 of the API
/// conventions) or when it is a plugin of a Studio gear — the connector
/// drivers are written here and named after their provider.
pub fn describe(linked: &[Linked]) -> Vec<Described> {
    let names: Vec<&str> = linked.iter().map(|g| g.name.as_str()).collect();
    linked
        .iter()
        .enumerate()
        .map(|(order, gear)| {
            let plugin = is_plugin(&gear.name);
            let extends = if plugin {
                extension_point(&gear.name, &names)
            } else {
                None
            };
            let studio = gear.name.starts_with("studio-")
                || extends.as_deref().is_some_and(|e| e.starts_with("studio-"));
            let role = if gear.capabilities.iter().any(|c| c == "system") {
                Role::System
            } else if plugin {
                Role::Plugin
            } else {
                Role::Gear
            };
            let purpose = purpose_of(&gear.name);
            let capabilities: BTreeSet<&str> =
                gear.capabilities.iter().map(String::as_str).collect();
            Described {
                name: gear.name.clone(),
                origin: if studio {
                    Origin::Studio
                } else {
                    Origin::Platform
                },
                role,
                extends,
                depends_on: gear.deps.clone(),
                capabilities: capabilities.into_iter().map(str::to_owned).collect(),
                order: u32::try_from(order).unwrap_or(u32::MAX),
                purpose: purpose.map(str::to_owned),
                design_doc: purpose.map(|_| format!("docs/design/{}.md", gear.name)),
            }
        })
        .collect()
}

/// The cargo features this binary was built with, of the ones that change
/// what is linked.
pub fn features() -> Vec<String> {
    let mut out = Vec::new();
    if cfg!(feature = "llm") {
        out.push("llm".to_owned());
    }
    if cfg!(feature = "graph") {
        out.push("graph".to_owned());
    }
    if cfg!(feature = "theia-bridge") {
        out.push("theia-bridge".to_owned());
    }
    if cfg!(feature = "theia-event-broker") {
        out.push("theia-event-broker".to_owned());
    }
    out
}

/// The commit CI built this binary from; `None` for a local build.
pub fn build_commit() -> Option<String> {
    let commit = env!("STUDIO_BUILD_COMMIT");
    (!commit.is_empty()).then(|| commit.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linked(name: &str, deps: &[&str], caps: &[&str]) -> Linked {
        Linked {
            name: name.to_owned(),
            deps: deps.iter().map(|d| (*d).to_owned()).collect(),
            capabilities: caps.iter().map(|c| (*c).to_owned()).collect(),
        }
    }

    const GEARS: &[&str] = &[
        "types-registry",
        "authn-resolver",
        "authz-resolver",
        "credstore",
        "studio-credstore-pg",
        "studio-connector",
        "account-management",
        "static-authn-plugin",
        "studio-authz-plugin",
        "gitlab-connector-plugin",
        "slack-webhook-connector-plugin",
        "static-credstore-plugin",
        "keycloak-idp-plugin",
    ];

    #[test]
    fn a_plugin_extends_the_gear_its_name_points_at() {
        assert_eq!(
            extension_point("static-authn-plugin", GEARS).as_deref(),
            Some("authn-resolver")
        );
        assert_eq!(
            extension_point("studio-authz-plugin", GEARS).as_deref(),
            Some("authz-resolver")
        );
        assert_eq!(
            extension_point("slack-webhook-connector-plugin", GEARS).as_deref(),
            Some("studio-connector")
        );
        // The exact name wins over `studio-credstore-pg`, which also carries
        // the word.
        assert_eq!(
            extension_point("static-credstore-plugin", GEARS).as_deref(),
            Some("credstore")
        );
    }

    #[test]
    fn a_name_that_points_nowhere_says_nothing() {
        // The IdP plugins fill account-management's point, and nothing in
        // their names says so.
        assert_eq!(extension_point("keycloak-idp-plugin", GEARS), None);
        assert_eq!(extension_point("studio-connector", GEARS), None);
    }

    #[test]
    fn two_candidates_in_one_tier_are_not_guessed_between() {
        let gears = ["authn-resolver", "authn-cache", "x-authn-plugin"];
        assert_eq!(extension_point("x-authn-plugin", &gears), None);
    }

    #[test]
    fn origin_and_role_follow_the_names_and_capabilities() {
        let described = describe(&[
            linked("types-registry", &[], &["system", "rest"]),
            linked("studio-connector", &["types-registry"], &["rest", "db"]),
            linked("gitlab-connector-plugin", &["types-registry"], &[]),
            linked("static-authn-plugin", &["types-registry"], &[]),
            linked("authn-resolver", &["types-registry"], &["system"]),
        ]);
        let by = |name: &str| described.iter().find(|d| d.name == name).unwrap();

        assert_eq!(by("types-registry").role, Role::System);
        assert_eq!(by("types-registry").origin, Origin::Platform);
        assert_eq!(by("studio-connector").origin, Origin::Studio);
        assert_eq!(by("studio-connector").role, Role::Gear);
        // Written here, named after its provider: Studio's by what it extends.
        assert_eq!(by("gitlab-connector-plugin").origin, Origin::Studio);
        assert_eq!(by("gitlab-connector-plugin").role, Role::Plugin);
        assert_eq!(
            by("gitlab-connector-plugin").extends.as_deref(),
            Some("studio-connector")
        );
        assert_eq!(by("static-authn-plugin").origin, Origin::Platform);
        assert_eq!(by("static-authn-plugin").order, 3);
        assert_eq!(by("studio-connector").capabilities, ["db", "rest"]);
    }

    /// The table is built from `docs/design/` at compile time; every gear
    /// design there has the section it is read from, so a design that loses
    /// it (or a build that loses the directory) is noticed here.
    #[test]
    fn every_gear_design_contributes_a_purpose() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/design");
        let designs: Vec<String> = std::fs::read_dir(&dir)
            .expect("docs/design next to the crate")
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                name.strip_suffix(".md")
                    .filter(|stem| stem.starts_with("studio-"))
                    .map(str::to_owned)
            })
            .collect();
        assert!(!designs.is_empty());
        for stem in designs {
            let purpose = purpose_of(&stem)
                .unwrap_or_else(|| panic!("docs/design/{stem}.md has no `### 1.1` paragraph"));
            assert!(
                purpose.len() > 20 && !purpose.contains("](") && !purpose.contains('`'),
                "{stem}: the purpose should read as plain text, got {purpose:?}"
            );
        }
        assert!(purpose_of("studio-assembly").is_some());
    }
}
