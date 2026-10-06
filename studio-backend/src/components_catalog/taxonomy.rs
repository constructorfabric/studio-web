//! What a component IS, and what it is filed under — one vocabulary each.
//!
//! The catalogue is filled from four sources that each name things their own
//! way: crates.io (a crate, with registry categories such as "Web
//! programming"), the Gears repository scan (a `gear.toml`, with a domain such
//! as `bss`), the FrontX scan (a `package.json`, with npm keywords such as
//! `hai3` or `eslint`), and the Gearbox engine (a `gear.gdl`, with a role and
//! the same domain vocabulary as `gear.toml`). Shown side by side, the "type"
//! of a component was any of those words, and a lint configuration sat in the
//! same list as the account-management gear.
//!
//! This module decides both answers from evidence, in one place, and says
//! which evidence decided (`reason`), so a wrong answer can be argued with.
//!
//! ── Kinds ────────────────────────────────────────────────────────────────────
//!
//! | kind | what it is | decided by |
//! |---|---|---|
//! | `gear` | a runnable service gear | a `gear.gdl` (engine role `service`) or a `gear.toml` |
//! | `plugin` | fills another gear's extension point | engine role `plugin`, `is_plugin = true`, or a `-plugin` crate |
//! | `sdk` | the client/contract crate of a gear | crate name ends in `-sdk` / `-sdks` |
//! | `library` | any other crate (toolkit, macros, TLS providers…) | a crate with none of the above |
//! | `micro-frontend` | a FrontX MFE, loaded by module federation | federation config/dependency, or a `-mfe` package |
//! | `frontend-library` | an npm package other packages import | an npm package with no `bin` and no federation |
//! | `tool` | a command-line tool | a `bin` in `package.json`, or a `cli` package |
//! | `kit` | a Studio kit | a `.cf-studio-kit.toml` |
//!
//! And five classes that are **not components** — nothing a product is built
//! from — which the reference leaves out unless asked, each with its reason:
//! `config` (lint/dependency-cruiser presets, `internal/` packages),
//! `test-support` (test helpers, conformance suites), `docs` (a docs site),
//! `template` (a scaffold with `{{placeholders}}`, `_blank-mfe`) and `example`
//! (demo MFEs, `examples/`).
//!
//! ── Categories ───────────────────────────────────────────────────────────────
//!
//! The small set the engine's `gear.gdl` and `gear.toml` already use
//! ([`CATEGORIES`]). A component's category is the engine's when it has one,
//! then its `gear.toml` domain, then its host's (a plugin) or its gear's (an
//! SDK), then a crates.io category only where it maps unambiguously
//! ([`map_registry_category`]). Otherwise null: "Web programming" and `hai3`
//! are not categories of this platform, and are kept as `source_categories`.

use std::fmt;

/// What a component is. The last five are not components.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Gear,
    Plugin,
    Sdk,
    Library,
    MicroFrontend,
    FrontendLibrary,
    Tool,
    Kit,
    /// A gear a roadmap board plans that no repository has yet.
    Planned,
    Config,
    TestSupport,
    Docs,
    Template,
    Example,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gear => "gear",
            Self::Plugin => "plugin",
            Self::Sdk => "sdk",
            Self::Library => "library",
            Self::MicroFrontend => "micro-frontend",
            Self::FrontendLibrary => "frontend-library",
            Self::Tool => "tool",
            Self::Kit => "kit",
            Self::Planned => "planned",
            Self::Config => "config",
            Self::TestSupport => "test-support",
            Self::Docs => "docs",
            Self::Template => "template",
            Self::Example => "example",
        }
    }

    /// Whether a product can be built from it. The rest are listed only
    /// behind a filter, with the reason.
    pub fn is_component(self) -> bool {
        !matches!(
            self,
            Self::Config | Self::TestSupport | Self::Docs | Self::Template | Self::Example
        )
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The categories of this platform, as `gear.gdl` and `gear.toml` spell them.
/// `example` is deliberately absent: an example is not a component.
pub const CATEGORIES: [&str; 7] = [
    "api-ingress",
    "bss",
    "core-functionality",
    "core-platform-integration",
    "gen-ai",
    "oss",
    "serverless",
];

pub fn is_category(value: &str) -> bool {
    CATEGORIES.contains(&value)
}

/// A crates.io category that means one of ours without argument. Everything
/// else ("Web programming", "Development tools", …) says what a crate is
/// written in or for, not where it sits in the platform, and maps to nothing.
pub fn map_registry_category(value: &str) -> Option<&'static str> {
    match value {
        "Artificial intelligence" => Some("gen-ai"),
        "Authentication" => Some("core-platform-integration"),
        _ => None,
    }
}

/// Everything the classifier looks at. Each field is evidence a source
/// actually recorded; absent evidence is `None`/`false`, never a guess.
#[derive(Debug, Default, Clone)]
pub struct Evidence<'a> {
    pub name: &'a str,
    /// Whether the node is a kit (its own node type).
    pub is_kit: bool,
    /// Whether it is an npm package (FrontX scan, or an `@scope/name`).
    pub is_npm: bool,
    /// The directory the scan read it from, repository-relative.
    pub path: Option<&'a str>,
    /// The repository scan found a gear description for it.
    pub gear_toml: bool,
    /// The description said it is a plugin (`is_plugin = …`, or `implements`).
    pub gear_toml_plugin: Option<bool>,
    /// The file that description is, `gear.gdl` or `gear.toml`. `None` is a
    /// profile scanned before the scan recorded it, when only `gear.toml` was
    /// read.
    pub manifest: Option<&'a str>,
    /// The roles of the engine gears it is (`service`, `plugin`).
    pub engine_roles: Vec<&'a str>,
    /// The engine's category for it, when a descriptor gives one.
    pub engine_category: Option<&'a str>,
    /// The kind the node was stored with (`toolkit`, `sdk`, …): a hint only.
    pub stored_kind: Option<&'a str>,
    /// `package.json` evidence, when the scan recorded it.
    pub npm_bin: Option<bool>,
    pub npm_mfe: Option<bool>,
    pub npm_private: Option<bool>,
}

/// A kind and the evidence that decided it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub kind: Kind,
    pub reason: String,
}

fn classified(kind: Kind, reason: impl Into<String>) -> Classified {
    Classified {
        kind,
        reason: reason.into(),
    }
}

/// The last `/`-segment of a name (`@gears-frontx/ui-kit` → `ui-kit`).
fn leaf(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

fn path_has(path: Option<&str>, segment: &str) -> bool {
    path.is_some_and(|p| p.split('/').any(|s| s == segment))
}

/// Decide a component's kind. The order is the precedence: what makes a thing
/// NOT a component is checked first, because a template or an example of a
/// micro-frontend looks exactly like a micro-frontend otherwise.
pub fn classify(e: &Evidence<'_>) -> Classified {
    let name = e.name;
    let short = leaf(name);
    let path = e.path;
    let at = |p: Option<&str>| p.map(|p| format!(" at {p}")).unwrap_or_default();

    if e.is_kit {
        return classified(Kind::Kit, "a Studio kit (.cf-studio-kit.toml)");
    }
    if e.stored_kind == Some("planned") {
        return classified(
            Kind::Planned,
            "a gear on the roadmap board that no catalogued repository has yet",
        );
    }

    // ── not components ───────────────────────────────────────────────────
    if name.contains("{{") || name.contains("}}") {
        return classified(
            Kind::Template,
            "the name is an unfilled {{placeholder}}: a scaffold, not a package",
        );
    }
    if short.starts_with("_blank") || short == "blank-mfe" || path_has(path, "templates") {
        return classified(
            Kind::Template,
            format!(
                "a blank scaffold{} that new packages are copied from",
                at(path)
            ),
        );
    }
    if short.starts_with("demo-")
        || short.contains("-fixture")
        || short.starts_with("widgets-fixture")
    {
        return classified(Kind::Example, format!("a demo/fixture package{}", at(path)));
    }
    if path_has(path, "examples") || path_has(path, "example") {
        return classified(Kind::Example, format!("lives under examples/{}", at(path)));
    }
    if e.engine_category == Some("example") {
        return classified(
            Kind::Example,
            "its gear.gdl files it under category `example`",
        );
    }
    if e.is_npm && (short == "docs" || path_has(path, "docs") || short.ends_with("-docs")) {
        return classified(Kind::Docs, format!("a documentation site{}", at(path)));
    }
    if short.ends_with("test-support")
        || short.ends_with("-conformance")
        || short.ends_with("-test-utils")
        || short.ends_with("-testing")
        || path_has(path, "test-support")
    {
        return classified(
            Kind::TestSupport,
            format!("test helpers or a conformance suite (`{short}`)"),
        );
    }
    if e.is_npm
        && (path.is_some_and(|p| p.starts_with("internal/"))
            || short.ends_with("-config")
            || short.starts_with("eslint-plugin")
            || short.contains("eslint-config"))
    {
        let why = if path.is_some_and(|p| p.starts_with("internal/")) {
            format!("an internal package{}", at(path))
        } else {
            format!("a shared tool configuration (`{short}`)")
        };
        return classified(Kind::Config, why);
    }

    // ── npm packages ────────────────────────────────────────────────────
    if e.is_npm {
        if e.npm_bin == Some(true) {
            return classified(Kind::Tool, "package.json declares a `bin`");
        }
        if short == "cli" || short.ends_with("-cli") {
            return classified(Kind::Tool, format!("a command-line package (`{short}`)"));
        }
        if e.npm_mfe == Some(true) {
            return classified(
                Kind::MicroFrontend,
                "module federation is configured (a remote entry is built)",
            );
        }
        if short.ends_with("-mfe") || path_has(path, "mfe_packages") {
            return classified(
                Kind::MicroFrontend,
                format!("a micro-frontend package (`{short}`)"),
            );
        }
        let private = if e.npm_private == Some(true) {
            " (private)"
        } else {
            ""
        };
        return classified(
            Kind::FrontendLibrary,
            format!("an npm package{private} with no `bin` and no module federation"),
        );
    }

    // ── crates ──────────────────────────────────────────────────────────
    if e.engine_roles.contains(&"plugin") && !e.engine_roles.contains(&"service") {
        return classified(
            Kind::Plugin,
            "its gear.gdl fills another gear's extension point",
        );
    }
    if e.engine_roles.contains(&"service") {
        return classified(Kind::Gear, "described by a gear.gdl (a service gear)");
    }
    // The toolkit is the platform's library, `cf-gears-toolkit-sdk` included:
    // it is the SDK for writing gears, not the SDK of a gear.
    if e.stored_kind == Some("toolkit") || name.contains("-toolkit") {
        return classified(Kind::Library, "a toolkit crate");
    }
    if name.ends_with("-sdk") || name.ends_with("-sdks") {
        return classified(Kind::Sdk, "the crate name ends in -sdk/-sdks");
    }
    if e.gear_toml {
        let manifest = e.manifest.unwrap_or("gear.toml");
        if e.gear_toml_plugin == Some(true) || name.ends_with("-plugin") {
            return classified(
                Kind::Plugin,
                format!("a {manifest}{} declaring a plugin", at(path)),
            );
        }
        return classified(Kind::Gear, format!("a {manifest}{}", at(path)));
    }
    if name.ends_with("-plugin") {
        return classified(
            Kind::Plugin,
            "the crate name ends in -plugin (no gear.gdl or gear.toml describes it)",
        );
    }
    if name.ends_with("-macros") || name.ends_with("-macro") {
        return classified(Kind::Library, "a procedural-macro crate");
    }
    classified(
        Kind::Library,
        "a crate with no gear.gdl, no gear.toml and no -sdk/-plugin suffix",
    )
}

/// Where a category came from, for the reason line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Categorised {
    pub category: Option<String>,
    pub reason: Option<String>,
}

/// Decide a component's category from, in order: the engine's descriptor,
/// the category the repository scan read (with the file it read it from), the category of the gear it belongs to (a plugin's
/// host, an SDK's gear), and a crates.io category that maps unambiguously.
pub fn categorise(
    engine: Option<&str>,
    scanned: Option<(&str, &str)>,
    owner: Option<(&str, &str)>,
    registry: &[&str],
) -> Categorised {
    let hit = |c: &str, why: String| Categorised {
        category: Some(c.to_string()),
        reason: Some(why),
    };
    if let Some(c) = engine.filter(|c| is_category(c)) {
        return hit(c, "gear.gdl".to_string());
    }
    if let Some((c, manifest)) = scanned.filter(|(c, _)| is_category(c)) {
        return hit(c, manifest.to_string());
    }
    if let Some((c, of)) = owner.filter(|(c, _)| is_category(c)) {
        return hit(c, format!("the category of {of}"));
    }
    for r in registry {
        if let Some(c) = map_registry_category(r) {
            return hit(c, format!("crates.io category \"{r}\""));
        }
    }
    Categorised {
        category: None,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npm<'a>(name: &'a str, path: &'a str) -> Evidence<'a> {
        Evidence {
            name,
            is_npm: true,
            path: Some(path),
            ..Evidence::default()
        }
    }

    fn krate(name: &str) -> Evidence<'_> {
        Evidence {
            name,
            ..Evidence::default()
        }
    }

    fn kind(e: &Evidence<'_>) -> &'static str {
        classify(e).kind.as_str()
    }

    // ── FrontX, as `constructorfabric/gears-frontx@develop` lays it out ─────

    #[test]
    fn frontx_libraries_are_frontend_libraries() {
        for (name, path) in [
            ("@gears-frontx/api", "packages/api"),
            ("@gears-frontx/state", "packages/state"),
            ("@gears-frontx/ui-kit", "packages/ui-kit"),
            ("@gears-frontx/telemetry", "packages/telemetry"),
            ("@gears-frontx/gts-plugin", "packages/gts-plugin"),
            ("@gears-frontx/mfes", "packages/mfes"),
            ("@gears-frontx/auth", "template-shell/packages/auth"),
            ("@gears-frontx/i18n", "template-shell/packages/i18n"),
            ("@gears-frontx/react", "template-shell/packages/react"),
            (
                "@gears-frontx/framework",
                "template-shell/packages/framework",
            ),
        ] {
            assert_eq!(kind(&npm(name, path)), "frontend-library", "{name}");
        }
    }

    #[test]
    fn a_cli_is_a_tool() {
        assert_eq!(kind(&npm("@gears-frontx/cli", "packages/cli")), "tool");
        let mut with_bin = npm("@gears-frontx/scaffold", "packages/scaffold");
        with_bin.npm_bin = Some(true);
        assert_eq!(classify(&with_bin).reason, "package.json declares a `bin`");
    }

    #[test]
    fn a_federated_package_is_a_micro_frontend() {
        let mut e = npm("@acme/orders", "packages/orders");
        e.npm_mfe = Some(true);
        assert_eq!(kind(&e), "micro-frontend");
        assert_eq!(
            kind(&npm("@acme/billing-mfe", "apps/billing-mfe")),
            "micro-frontend"
        );
    }

    #[test]
    fn templates_and_examples_are_not_components() {
        let cases = [
            (
                "@gears-frontx/{{mfeName}}-mfe",
                "template-mfe/src-app/mfe_packages/_blank-mfe",
                Kind::Template,
            ),
            (
                "@gears-frontx/blank-mfe",
                "template-mfe/src-app/mfe_packages/_blank-mfe",
                Kind::Template,
            ),
            (
                "@gears-frontx/demo-mfe",
                "template-mfe/src-app/mfe_packages/demo-mfe",
                Kind::Example,
            ),
            (
                "cf-api-contracts",
                "examples/toolkit/api-contracts/api-contracts",
                Kind::Example,
            ),
        ];
        for (name, path, want) in cases {
            let mut e = npm(name, path);
            e.is_npm = name.starts_with('@');
            let got = classify(&e);
            assert_eq!(got.kind, want, "{name}");
            assert!(!got.kind.is_component(), "{name}");
        }
    }

    #[test]
    fn config_test_support_and_docs_are_not_components() {
        assert_eq!(
            kind(&npm(
                "@gears-frontx/eslint-config",
                "internal/eslint-config"
            )),
            "config"
        );
        assert_eq!(
            kind(&npm(
                "@gears-frontx/depcruise-config",
                "internal/depcruise-config"
            )),
            "config"
        );
        assert_eq!(
            kind(&npm("eslint-plugin-local", "internal/eslint-plugin-local")),
            "config"
        );
        assert_eq!(
            kind(&npm("@gears-frontx/test-support", "internal/test-support")),
            "test-support"
        );
        assert_eq!(kind(&npm("@gears-frontx/docs", "docs")), "docs");
        assert_eq!(kind(&krate("cf-gears-cluster-conformance")), "test-support");
    }

    // ── crates ──────────────────────────────────────────────────────────

    #[test]
    fn a_gear_gdl_decides_gear_or_plugin() {
        let mut e = krate("cf-chat-engine");
        e.engine_roles = vec!["service"];
        assert_eq!(kind(&e), "gear");
        let mut p = krate("cf-gears-keycloak-idp-plugin");
        p.engine_roles = vec!["plugin"];
        assert_eq!(kind(&p), "plugin");
        // One crate that is a service and ships static plugins is a gear.
        let mut both = krate("cf-gears-mini-chat");
        both.engine_roles = vec!["service", "plugin", "plugin"];
        assert_eq!(kind(&both), "gear");
    }

    #[test]
    fn a_gear_toml_without_a_crate_is_still_a_gear() {
        let mut e = krate("cf-gears-approval-service");
        e.gear_toml = true;
        e.path = Some("gears/approval-service");
        assert_eq!(classify(&e).reason, "a gear.toml at gears/approval-service");
        let mut p = krate("cf-gears-ecb-plugin");
        p.gear_toml = true;
        p.gear_toml_plugin = Some(true);
        assert_eq!(kind(&p), "plugin");
    }

    #[test]
    fn the_reason_names_the_file_the_scan_read() {
        let mut e = krate("cf-gears-bss-ledger");
        e.gear_toml = true;
        e.manifest = Some("gear.gdl");
        e.path = Some("gears/bss/ledger");
        assert_eq!(classify(&e).reason, "a gear.gdl at gears/bss/ledger");
    }

    #[test]
    fn crates_that_are_not_gears_are_libraries_or_sdks() {
        for name in [
            "cf-gears-rustls-corecrypto-provider",
            "cf-gears-rustls-fips-shim",
            "cf-gears-system-sdk-directory",
            "cf-gears-toolkit-db",
            "cf-gears-toolkit-db-macros",
            "cf-gears-toolkit-macros",
            "cf-gears-toolkit-sdk",
        ] {
            assert_eq!(kind(&krate(name)), "library", "{name}");
        }
        assert_eq!(kind(&krate("cf-gears-system-sdks")), "sdk");
        assert_eq!(kind(&krate("cf-gears-account-management-sdk")), "sdk");
        assert_eq!(kind(&krate("cf-chat-engine-sdk")), "sdk");
    }

    #[test]
    fn a_plugin_crate_no_descriptor_names_is_a_plugin_by_its_name() {
        for name in [
            "cf-k8s-cluster-plugin",
            "cf-postgres-cluster-plugin",
            "cf-redis-cluster-plugin",
            "cf-gears-standalone-cluster-plugin",
        ] {
            let c = classify(&krate(name));
            assert_eq!(c.kind, Kind::Plugin, "{name}");
            assert!(c.reason.contains("-plugin"), "{name}: {}", c.reason);
        }
    }

    #[test]
    fn a_kit_is_a_kit() {
        let e = Evidence {
            name: "sdlc",
            is_kit: true,
            ..Evidence::default()
        };
        assert_eq!(kind(&e), "kit");
    }

    // ── categories ──────────────────────────────────────────────────────

    #[test]
    fn the_engine_category_wins_then_gear_toml_then_the_owner() {
        assert_eq!(
            categorise(
                Some("oss"),
                Some(("bss", "gear.gdl")),
                None,
                &["Web programming"]
            )
            .category
            .as_deref(),
            Some("oss")
        );
        let scanned = categorise(None, Some(("bss", "gear.gdl")), None, &[]);
        assert_eq!(scanned.category.as_deref(), Some("bss"));
        assert_eq!(scanned.reason.as_deref(), Some("gear.gdl"));
        let sdk = categorise(
            None,
            None,
            Some(("oss", "cf-gears-account-management")),
            &["Web programming"],
        );
        assert_eq!(sdk.category.as_deref(), Some("oss"));
        assert_eq!(
            sdk.reason.as_deref(),
            Some("the category of cf-gears-account-management")
        );
    }

    #[test]
    fn registry_categories_and_npm_tags_map_or_stay_null() {
        assert_eq!(
            categorise(None, None, None, &["Artificial intelligence"])
                .category
                .as_deref(),
            Some("gen-ai")
        );
        assert_eq!(
            categorise(None, None, None, &["Authentication"])
                .category
                .as_deref(),
            Some("core-platform-integration")
        );
        for raw in [
            "Web programming",
            "Development tools",
            "Cryptography",
            "hai3",
            "eslint",
            "dependency-cruiser",
            "test-support",
        ] {
            assert_eq!(
                categorise(None, Some((raw, "gear.toml")), None, &[raw]).category,
                None,
                "{raw}"
            );
        }
        assert_eq!(categorise(Some("example"), None, None, &[]).category, None);
    }
}
