use super::*;

const SPEC_MAPPING: &str = r#"//! studio-spec-mapping: from a project's specification to the gears that
//! build it.
//!
//! One place for every rule of that path.

pub(crate) mod plan;

#[toolkit::gear(name = "studio-spec-mapping", capabilities = [rest])]
#[derive(Default)]
pub struct SpecMappingGear;
"#;

const DOCUMENTS: &str = r#"//! studio-documents — document management gear.
//!
//! Document types are registered in the platform types-registry.

#[toolkit::gear(
    name = "studio-documents",
    deps = [account_management, types_registry],
    capabilities = [db, rest]
)]
#[derive(Default)]
pub struct StudioDocumentsGear {}
"#;

#[test]
fn a_gear_is_read_off_its_attribute() {
    assert_eq!(
        code_declarations(SPEC_MAPPING),
        vec![CodeGear {
            name: "studio-spec-mapping".into(),
            runtime: vec!["rest".into()],
        }]
    );
}

#[test]
fn an_attribute_over_several_lines_is_one_gear() {
    assert_eq!(
        code_declarations(DOCUMENTS),
        vec![CodeGear {
            name: "studio-documents".into(),
            runtime: vec!["db".into(), "rest".into()],
        }]
    );
}

#[test]
fn every_gear_of_a_file_is_found_and_none_a_test_declares() {
    let body = r#"//! Connector driver plugins.
mod gitlab_plugin {
    #[toolkit::gear(name = "gitlab-connector-plugin", deps = [types_registry])]
    pub struct GitLabPlugin;
}
mod github_plugin {
    #[toolkit::gear(name = "github-connector-plugin", deps = [types_registry])]
    pub struct GitHubPlugin;
}
#[cfg(test)]
mod tests {
    #[toolkit::gear(name = "a-test-gear")]
    struct TestGear;
}
"#;
    let names: Vec<String> = code_declarations(body)
        .into_iter()
        .map(|g| g.name)
        .collect();
    assert_eq!(
        names,
        vec!["gitlab-connector-plugin", "github-connector-plugin"]
    );
}

#[test]
fn an_attribute_in_a_comment_or_a_string_is_not_a_gear() {
    let body = "// #[toolkit::gear(name = \"commented\")]\n\
                /// `#[toolkit::gear(deps = [...])]` expands to...\n\
                const T: &str = \"\\\n         #[toolkit::gear(\\n    name = \\\"{crate_name}\\\",\\n)]\";\n\
                #[toolkit::gear]\nstruct Unnamed;\n";
    assert!(code_declarations(body).is_empty());
}

#[test]
fn the_older_macro_name_is_read_too() {
    let body = "#[modkit::module(name = \"api-gateway\", capabilities = [rest, stateful])]\npub struct M;\n";
    assert_eq!(code_declarations(body)[0].name, "api-gateway");
}

#[test]
fn a_module_doc_is_its_first_paragraph_without_the_gears_name() {
    assert_eq!(
        module_doc(SPEC_MAPPING).as_deref(),
        Some("from a project's specification to the gears that build it.")
    );
    assert_eq!(
        module_doc(DOCUMENTS).as_deref(),
        Some("document management gear.")
    );
    assert_eq!(
        module_doc("//! Studio AuthZ plugin — the Studio PDP (ADR-0009).\n").as_deref(),
        Some("Studio AuthZ plugin — the Studio PDP (ADR-0009).")
    );
    assert_eq!(module_doc("use std::sync::Arc;\n"), None);
}

#[test]
fn only_the_files_a_gear_is_declared_in_are_read() {
    let paths = [
        "studio-backend/src/main.rs",
        "studio-backend/src/spec_mapping/mod.rs",
        "studio-backend/src/spec_mapping/plan.rs",
        "studio-backend/src/git_proxy/gear.rs",
        "studio-backend/src/studio_authz_plugin.rs",
        "studio-backend/target/debug/build/x/out/mod.rs",
        "studio-backend/tests/common/mod.rs",
        "crates/foo/src/lib.rs",
        // Test modules: their fixtures write gear attributes in strings.
        "studio-backend/src/components_catalog/project_gears_tests.rs",
        "studio-backend/src/plugin_test.rs",
        "studio-backend/src/gearbox/tests.rs",
    ];
    assert_eq!(
        rust_candidates(&paths),
        vec![
            "studio-backend/src/studio_authz_plugin.rs",
            "crates/foo/src/lib.rs",
            "studio-backend/src/git_proxy/gear.rs",
            "studio-backend/src/spec_mapping/mod.rs",
        ]
    );
}

#[test]
fn a_gear_lives_in_its_module_or_its_crate() {
    assert_eq!(
        rust_home("studio-backend/src/spec_mapping/mod.rs"),
        "studio-backend/src/spec_mapping"
    );
    assert_eq!(
        rust_home("studio-backend/src/git_proxy/gear.rs"),
        "studio-backend/src/git_proxy"
    );
    assert_eq!(rust_home("gears/x/src/lib.rs"), "gears/x");
    assert_eq!(rust_home("src/lib.rs"), "");
    assert_eq!(
        rust_home("studio-backend/src/connectors/plugin.rs"),
        "studio-backend/src/connectors/plugin.rs"
    );
}

#[test]
fn a_gear_declared_beside_its_module_is_described_by_the_module() {
    let paths = ["s/git_proxy/mod.rs", "s/git_proxy/gear.rs", "s/x/gear.rs"];
    assert_eq!(
        doc_file("s/git_proxy/gear.rs", &paths),
        "s/git_proxy/mod.rs"
    );
    assert_eq!(doc_file("s/x/gear.rs", &paths), "s/x/gear.rs");
    assert_eq!(
        readme("s/git_proxy", &["s/git_proxy/README.md", "s/README.md"]),
        Some("s/git_proxy/README.md")
    );
    assert_eq!(
        readme("s/connectors/plugin.rs", &["s/connectors/README.md"]),
        None
    );
}

fn gear(name: &str, path: &str, declared_in: &str) -> LocalGear {
    LocalGear {
        name: name.into(),
        kind: "gear".into(),
        description: None,
        category: None,
        path: path.into(),
        declared_in: declared_in.into(),
        repo: "o/r".into(),
        capabilities: Vec::new(),
        runtime: Vec::new(),
        built: false,
        doc: None,
    }
}

#[test]
fn an_attribute_inside_a_described_gear_is_that_gear() {
    let mut gears = vec![gear(
        "cf-gears-api-gateway",
        "gears/api-gateway",
        "gears/api-gateway/gear.toml",
    )];
    let mut code = gear(
        "api-gateway",
        "gears/api-gateway/api-gateway",
        "gears/api-gateway/api-gateway/src/lib.rs",
    );
    code.runtime = vec!["rest".into()];
    code.description = Some("The gateway.".into());
    absorb(&mut gears, code);
    assert_eq!(gears.len(), 1);
    assert!(gears[0].built);
    assert_eq!(gears[0].runtime, vec!["rest"]);
    assert_eq!(gears[0].description.as_deref(), Some("The gateway."));

    // A sibling directory is another gear: `gears/api-gateway-x` is not inside.
    absorb(
        &mut gears,
        gear("x", "gears/api-gateway-x", "gears/api-gateway-x/src/lib.rs"),
    );
    assert_eq!(gears.len(), 2);
}

#[test]
fn a_gear_is_offered_in_the_catalogues_shape() {
    let mut g = gear(
        "studio-spec-mapping",
        "studio-backend/src/spec_mapping",
        "studio-backend/src/spec_mapping/mod.rs",
    );
    g.built = true;
    g.capabilities = vec!["spec-mapping".into(), "planning".into()];
    g.doc = Some((
        "studio-backend/src/spec_mapping/README.md".into(),
        "Maps specs to gears.".into(),
    ));
    let (nodes, profiles) = catalogue_shape(&[g]);
    assert_eq!(nodes[0]["origin"], "project");
    assert_eq!(nodes[0]["path"], "studio-backend/src/spec_mapping");
    let profile = &profiles["studio-spec-mapping"];
    assert_eq!(profile["auto"]["gear_status"], "built");
    assert_eq!(profile["auto"]["capabilities"], "spec-mapping, planning");
    assert_eq!(
        profile["auto"]["doc_text"][0]["l"],
        "studio-backend/src/spec_mapping/README.md"
    );
    // The catalogue's own reading of declared capabilities finds them.
    let values = crate::components_catalog::values::resolve(&nodes[0], Some(profile));
    assert_eq!(values["capabilities"]["v"], "spec-mapping, planning");
}

#[test]
fn the_fingerprint_moves_only_with_the_files_read() {
    let files = |readme: &str, other: &str| {
        vec![
            ("s/a/mod.rs".to_string(), "1".to_string()),
            ("s/a/README.md".to_string(), readme.to_string()),
            ("s/a/plan.rs".to_string(), other.to_string()),
        ]
    };
    assert_eq!(fingerprint(&files("r", "x")), fingerprint(&files("r", "y")));
    assert_ne!(fingerprint(&files("r", "x")), fingerprint(&files("q", "x")));
    // Stored by the registry, so it must not depend on the build: a uuid5 of
    // the pairs, the same string every time.
    assert_eq!(fingerprint(&files("r", "x")).len(), 36);
    assert_ne!(fingerprint(&[]), fingerprint(&files("r", "x")));
}

#[test]
fn a_cached_answer_is_served_only_for_the_same_files() {
    let cache = Cache::default();
    cache.put_found(
        "k".into(),
        "1".into(),
        Arc::new(vec![gear("a", "a", "a/mod.rs")]),
        None,
    );
    assert!(cache.get_found("k", "1", false).is_some());
    assert!(cache.get_found("k", "2", false).is_none());
    assert!(cache.get_found("other", "1", false).is_none());
    // Read without candidates: a walk that wants them reads again.
    assert!(cache.get_found("k", "1", true).is_none());
    cache.put_found(
        "k".into(),
        "1".into(),
        Arc::new(Vec::new()),
        Some(Arc::new(Vec::new())),
    );
    assert!(cache.get_found("k", "1", true).is_some());
}

/// studio-documents' own `mod.rs` names its test files above its attribute
/// (`#[cfg(test)] mod repo_tests;`). Those lines are not where the tests
/// begin: stopping there lost the gear on the local stand.
#[test]
fn a_test_file_named_above_the_attribute_does_not_hide_the_gear() {
    let body = "mod repo;\n\
                #[cfg(test)]\n\
                mod repo_tests;\n\
                #[cfg(test)]\n\
                // a comment\n\
                mod sync_analysis_tests;\n\
                \n\
                #[toolkit::gear(\n    name = \"studio-documents\",\n    deps = [types_registry]\n)]\n\
                pub struct Documents;\n\
                #[cfg(test)]\n\
                mod tests {\n\
                #[toolkit::gear(name = \"a-test-gear\")]\n\
                struct T;\n\
                }\n";
    let names: Vec<String> = code_declarations(body)
        .into_iter()
        .map(|g| g.name)
        .collect();
    assert_eq!(names, vec!["studio-documents"]);
}
