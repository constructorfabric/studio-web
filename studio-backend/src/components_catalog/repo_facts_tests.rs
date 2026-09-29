use super::*;

/// `gears/system/event-broker/event-broker/Cargo.toml`, the head of it.
const EVENT_BROKER: &str = r#"[package]
name = "cf-gears-event-broker"
description = "Event Broker: Ingest/Delivery/Dispatcher composite module"
version = "0.2.8"
edition.workspace = true
license.workspace = true

[features]
# Exposes `test_support` to other crates' tests.
default = []
test-utils = ["dep:tower"]
sqlite = ["sea-orm/sqlx-sqlite"]

[dependencies]
cf-gears-types-registry-sdk = { workspace = true }
sea-orm = { workspace = true, features = ["sqlx-postgres"] }
"#;

#[test]
fn a_manifest_names_its_package_and_its_version() {
    assert_eq!(
        cargo_package(EVENT_BROKER),
        Some(("cf-gears-event-broker".into(), Some("0.2.8".into())))
    );
    let inherited = "[package]\nname = \"cf-gears-x\"\nversion.workspace = true\n";
    assert_eq!(cargo_package(inherited), Some(("cf-gears-x".into(), None)));
    assert_eq!(cargo_package("[workspace]\nmembers = []\n"), None);
}

#[test]
fn a_workspace_hands_down_its_version_and_licence() {
    let root = "[workspace]\nmembers = [\"a\"]\n\n[workspace.package]\nversion = \"0.9.1\"\nlicense = \"Apache-2.0\" # SPDX\n";
    assert_eq!(workspace_package(root, "version").as_deref(), Some("0.9.1"));
    assert_eq!(
        workspace_package(root, "license").as_deref(),
        Some("Apache-2.0")
    );
    assert_eq!(workspace_package(EVENT_BROKER, "license"), None);
}

#[test]
fn features_are_counted_without_default_and_databases_are_named() {
    assert_eq!(feature_names(EVENT_BROKER), vec!["test-utils", "sqlite"]);
    assert_eq!(db_engines([EVENT_BROKER]), vec!["PostgreSQL", "SQLite"]);
    assert!(db_engines(["[dependencies]\nserde = \"1\"\n"]).is_empty());
}

#[test]
fn releases_are_read_off_tags_under_old_and_new_names() {
    let tags = [
        "cf-mini-chat-v0.1.6",
        "cf-mini-chat-v0.1.7",
        "cf-gears-mini-chat-v0.2.0-rc.1",
        "cf-gears-mini-chat-sdk-v0.3.0",
        "cf-gears-account-management-v0.7.2",
        "cf-gears-account-management-v0.7.10",
        "not-a-release",
    ];
    let index = tag_index(tags);
    // Numeric, not lexical: 0.7.10 is newer than 0.7.2.
    assert_eq!(
        latest_release(&index, "cf-gears-account-management").map(|v| v.to_string()),
        Some("0.7.10".into())
    );
    // The new name's pre-release still beats the old name's releases.
    assert_eq!(
        latest_release(&index, "cf-gears-mini-chat").map(|v| v.to_string()),
        Some("0.2.0-rc.1".into())
    );
    // An SDK's tag is the SDK's, not the gear's.
    assert_eq!(latest_release(&index, "cf-gears-ledger"), None);
}

#[test]
fn a_prerelease_sorts_below_its_release() {
    let rc = Version::parse("1.0.0-rc.1").unwrap();
    let ga = Version::parse("v1.0.0").unwrap();
    assert!(rc < ga);
    assert!(Version::parse("1.0").is_none());
}

#[test]
fn lifecycle_follows_the_rule() {
    let v = |s: &str| Version::parse(s).unwrap();
    assert_eq!(lifecycle(Some(&v("1.2.0")), true, false), "mature");
    assert_eq!(lifecycle(Some(&v("1.0.0-rc.1")), true, true), "in prod");
    assert_eq!(lifecycle(Some(&v("0.7.2")), true, false), "in qa");
    assert_eq!(lifecycle(Some(&v("0.2.8")), false, true), "in development");
    assert_eq!(lifecycle(None, false, false), "in development");
}

#[test]
fn a_spec_counts_priority_markers_and_traceability_ids() {
    let prd = "# PRD\n\n\
- [x] `p1` - **ID**: `cpt-cf-evbk-fr-topic-registration`\n\
- [ ] `p1` - **ID**: `cpt-cf-evbk-fr-publish-single`\n\
- [ ] `p2` - **ID**: `cpt-cf-evbk-fr-publish-single`\n\
- [ ] a template checklist line, not a requirement\n\
See cpt-cf-evbk-fr-topic-registration and xcpt-not-an-id.\n";
    let mut s = SpecStats::default();
    s.add(prd);
    assert_eq!(s.markers, 3);
    assert_eq!(s.ticked, 1);
    assert_eq!(s.ids.len(), 2);
    assert!(s.ids.contains("cpt-cf-evbk-fr-publish-single"));
    assert_eq!(s.lines, 7);
}

#[test]
fn a_shared_changelog_names_the_crate_of_each_release() {
    let log = "# Changelog\n\n## [Unreleased]\n\n\
## [0.2.8](https://github.com/o/r/compare/cf-gears-event-broker-v0.2.7...cf-gears-event-broker-v0.2.8) - 2026-09-23\n\
- fix\n\n\
## [0.2.6](https://github.com/o/r/compare/cf-gears-event-broker-sdk-v0.2.5...cf-gears-event-broker-sdk-v0.2.6) - 2026-09-23\n\
## [0.1.0](https://github.com/o/r/releases/tag/cf-gears-rating-v0.1.0)\n";
    let r = changelog_releases(log);
    assert_eq!(r.len(), 3);
    assert_eq!(
        r[0],
        ChangelogEntry {
            crate_name: "cf-gears-event-broker".into(),
            version: "0.2.8".into(),
            date: Some("2026-09-23".into()),
        }
    );
    assert_eq!(r[1].crate_name, "cf-gears-event-broker-sdk");
    assert_eq!(r[2].crate_name, "cf-gears-rating");
    assert_eq!(r[2].date, None);
}

#[test]
fn code_is_split_into_production_unit_and_integration_lines() {
    let mut s = CodeStats::default();
    s.add(
        "event-broker/src/lib.rs",
        "use gts::EventType;
fn a() {}
// gts::lowercase_is_a_module
",
    );
    s.add(
        "event-broker/src/api/rest_tests.rs",
        "#[test]
fn t() {}
",
    );
    s.add(
        "event-broker/tests/it.rs",
        "#[tokio::test]
async fn it() {}
fn h() {}
",
    );
    s.add(
        "event-broker/src/infra/health.rs",
        "route(\"/readyz\")
",
    );
    s.add(
        "docs/PRD.md",
        "not code
",
    );
    assert_eq!((s.code, s.unit, s.integration), (4, 2, 3));
    assert!(s.health);
    assert_eq!(
        s.gts_types.into_iter().collect::<Vec<_>>(),
        vec!["EventType"]
    );
    assert_eq!(spec_to_code(100, 530).as_deref(), Some("1 : 5.3"));
    assert_eq!(spec_to_code(0, 530), None);
}

#[test]
fn experts_and_sign_off_leave_bots_out() {
    let c = |a: &str, m: &str| CommitFacts {
        author: a.into(),
        message: m.into(),
    };
    let commits = vec![
        c("Artifizer", "feat: x\n\nSigned-off-by: Artifizer <a@x>"),
        c("Artifizer", "fix: y"),
        c("diffora", "feat: z\n\nSigned-off-by: diffora <d@x>"),
        c("github-actions[bot]", "chore(release): 0.2.0"),
        c("github-actions[bot]", "chore(release): 0.2.1"),
        c("github-actions[bot]", "chore(release): 0.2.2"),
    ];
    assert_eq!(experts(&commits, 3), vec!["Artifizer", "diffora"]);
    assert_eq!(sign_off(&commits), (2, 3));
}
