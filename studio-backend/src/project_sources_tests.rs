use serde_json::json;
use uuid::Uuid;

use super::*;

#[test]
fn a_directory_is_the_last_segment_as_the_portal_spells_it() {
    assert_eq!(checkout_dir("acme/studio-web"), "studio-web");
    assert_eq!(checkout_dir("group/sub/Studio.Web"), "studio-web");
    assert_eq!(checkout_dir("acme/api/"), "api");
    assert_eq!(checkout_dir(""), "source");
}

#[test]
fn sources_are_read_in_order_with_their_connection_and_branch() {
    let id = Uuid::new_v4();
    let got = parse(&json!({ "sources": [
        { "connection_id": id.to_string(), "full_path": "acme/api",
          "clone_url": "https://github.com/acme/api.git", "branch": "dev" },
        { "connection_id": "not-a-uuid", "full_path": "acme/docs",
          "clone_url": "https://github.com/acme/docs.git" },
    ]}));
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].connection_id, Some(id));
    assert_eq!(got[0].branch.as_deref(), Some("dev"));
    assert_eq!(got[0].dir, "api");
    assert_eq!(
        got[1].connection_id, None,
        "an unreadable id clones without credentials"
    );
    assert_eq!(got[1].branch, None);
}

#[test]
fn two_sources_with_one_name_get_the_portals_suffixes() {
    let got = parse(&json!({ "sources": [
        { "full_path": "a/app", "clone_url": "https://h/a/app" },
        { "full_path": "b/app", "clone_url": "https://h/b/app" },
        { "full_path": "c/app" },
        { "full_path": "d/app", "clone_url": "https://h/d/app" },
    ]}));
    let dirs: Vec<_> = got.iter().map(|s| s.dir.as_str()).collect();
    assert_eq!(
        dirs,
        ["app", "app-2", "app-3"],
        "an entry with nothing to clone takes no name"
    );
}

#[test]
fn a_config_without_sources_has_none() {
    assert!(parse(&json!({})).is_empty());
    assert!(parse(&json!({ "sources": "nope" })).is_empty());
}

#[test]
fn a_pasted_url_and_the_providers_name_one_repository() {
    assert!(same_repository(
        "https://github.com/acme/api.git",
        "https://GitHub.com/Acme/api/"
    ));
    assert!(same_repository(
        "https://github.com/acme/api",
        "http://x-access-token@github.com/acme/api.git"
    ));
    assert!(!same_repository(
        "https://github.com/acme/api",
        "https://github.com/acme/api-docs"
    ));
    assert!(!same_repository(
        "https://github.com/acme/api",
        "https://gitlab.com/acme/api"
    ));
    assert!(!same_repository(
        "git@github.com:acme/api.git",
        "git@github.com:acme/api.git"
    ));
    assert!(!same_repository(
        "https://github.com/",
        "https://github.com"
    ));
}

fn resolved(secret_ref: Option<&str>, personal: bool) -> Resolved {
    Resolved {
        source: parse(&json!({ "sources": [
            { "full_path": "acme/api", "clone_url": "https://github.com/acme/api.git", "branch": "dev" }
        ]}))
        .remove(0),
        secret_ref: secret_ref.map(str::to_owned),
        personal,
        holder: None,
        held_outside: None,
    }
}

/// A source whose connection the platform's root holds -- the project sees
/// it because connections are inherited downwards -- lends no token to a
/// clone or a push, and says whose it was, so the proxy refuses it.
#[test]
fn a_connection_held_outside_the_organization_lends_no_token() {
    let root = Uuid::from_u128(1);
    let mut r = resolved(Some("studio-connection-root"), false);
    r.holder = Some(root);
    r.held_outside = Some(root);
    let got = to_git_source(r);
    assert_eq!(got.token_ref, None);
    assert_eq!(got.held_outside, Some(root));
    // The organization's own still lends its token.
    let own = to_git_source(resolved(Some("studio-connection-1"), false));
    assert_eq!(own.held_outside, None);
    assert_eq!(own.token_ref.as_deref(), Some("studio-connection-1"));
}

#[test]
fn a_shared_connection_lends_its_token_to_the_clone() {
    let got = to_git_source(resolved(Some("studio-connection-1"), false));
    assert_eq!(got.name, "api");
    assert_eq!(got.url, "https://github.com/acme/api.git");
    assert_eq!(got.branch.as_deref(), Some("dev"));
    assert_eq!(got.token_ref.as_deref(), Some("studio-connection-1"));
}

#[test]
fn a_personal_connection_does_not() {
    assert_eq!(
        to_git_source(resolved(Some("studio-connection-1"), true)).token_ref,
        None
    );
    assert_eq!(to_git_source(resolved(None, false)).token_ref, None);
}

#[test]
fn a_source_shares_through_a_pull_request_only_when_it_says_so() {
    let got = parse(&json!({ "sources": [
        { "full_path": "acme/api", "clone_url": "https://h/acme/api", "share_mode": "pull_request" },
        { "full_path": "acme/web", "clone_url": "https://h/acme/web", "share_mode": "branch" },
        { "full_path": "acme/docs", "clone_url": "https://h/acme/docs" },
        { "full_path": "acme/ops", "clone_url": "https://h/acme/ops", "share_mode": "Pull_Request" },
        { "full_path": "acme/lib", "clone_url": "https://h/acme/lib", "share_mode": 1 },
    ]}));
    let modes: Vec<_> = got.iter().map(|s| s.share_mode).collect();
    assert_eq!(
        modes,
        [
            ShareMode::PullRequest,
            ShareMode::Branch,
            ShareMode::Branch,
            ShareMode::Branch,
            ShareMode::Branch,
        ],
        "absent or unknown is the branch mode every project had before"
    );
}

#[test]
fn a_share_mode_is_spelled_as_the_config_spells_it() {
    for mode in [ShareMode::Branch, ShareMode::PullRequest] {
        assert_eq!(ShareMode::parse(Some(mode.as_str())), mode);
    }
    assert_eq!(ShareMode::default(), ShareMode::Branch);
}

#[test]
fn a_fork_names_its_upstream_among_the_project_repositories() {
    let config = json!({
        "sources": [{
            "full_path": "AndrejK666/studio-web",
            "clone_url": "https://github.com/AndrejK666/studio-web.git",
        }],
        "source_git_url": "https://github.com/constructorfabric/studio-web.git",
        "build": { "repo": "constructorfabric/studio-web", "workflow": "build.yml" },
    });
    assert_eq!(
        repositories(&config),
        vec![
            "andrejk666/studio-web".to_owned(),
            "constructorfabric/studio-web".to_owned()
        ],
    );
}

#[test]
fn a_git_url_gives_its_owner_and_name() {
    assert_eq!(
        url_path("https://github.com/acme/api.git").as_deref(),
        Some("acme/api")
    );
    assert_eq!(
        url_path("git@github.com:acme/api.git").as_deref(),
        Some("acme/api")
    );
    assert_eq!(
        url_path("https://gitlab.example/group/sub/api/").as_deref(),
        Some("group/sub/api")
    );
    assert_eq!(url_path("https://github.com/acme").as_deref(), None);
    assert_eq!(url_path("").as_deref(), None);
}

#[test]
fn a_project_has_one_list_and_its_flags_say_what_each_source_is_for() {
    let c = Uuid::new_v4().to_string();
    let config = json!({ "sources": [
        { "connection_id": c, "full_path": "acme/app", "clone_url": "https://github.com/acme/app.git" },
        { "connection_id": c, "full_path": "acme/gears", "clone_url": "https://github.com/acme/gears.git",
          "gears_here": true },
        { "connection_id": c, "full_path": "acme/release", "clone_url": "https://github.com/acme/release.git",
          "publish_here": true },
    ]});
    let sources = parse(&config);
    assert_eq!(gears_source(&sources).unwrap().full_path, "acme/gears");
    assert_eq!(publish_source(&sources).unwrap().full_path, "acme/release");
    assert_eq!(
        description_home(&sources).unwrap().full_path,
        "acme/release",
        "the description travels with the source it is published to"
    );
    // Nothing marked: Studio keeps revisions only, and the description
    // travels with the first source read through a connection.
    let plain = parse(&json!({ "sources": [
        { "full_path": "acme/docs", "clone_url": "https://github.com/acme/docs.git" },
        { "connection_id": c, "full_path": "acme/app", "clone_url": "https://github.com/acme/app.git" },
    ]}));
    assert!(publish_source(&plain).is_none());
    assert!(gears_source(&plain).is_none());
    assert_eq!(description_home(&plain).unwrap().full_path, "acme/app");
    assert!(description_home(&[]).is_none());
}

#[test]
fn the_old_gear_repository_becomes_a_source_marked_gears_here_once() {
    let gear_repo = json!({ "tenant": Uuid::nil(), "connection_id": "2aaca5b5-e283-45ec-8ce0-be6fcfcaf4e2",
                            "repo": "constructorfabric/studio-web", "branch": "main" });
    // Another repository: appended, marked.
    let mut config = json!({ "sources": [
        { "full_path": "AndrejK666/studio-web", "clone_url": "https://github.com/AndrejK666/studio-web.git",
          "branch": "AndrejK666/studio-web-gdl" } ]});
    assert!(fold_gear_repo(&mut config, &gear_repo, None));
    let sources = parse(&config);
    assert_eq!(sources.len(), 2);
    assert!(!sources[0].gears_here);
    assert!(sources[1].gears_here);
    assert_eq!(
        sources[1].clone_url,
        "https://github.com/constructorfabric/studio-web.git"
    );
    assert_eq!(sources[1].branch.as_deref(), Some("main"));
    assert_eq!(config["sources"][1]["folded_from"], "project_gear_repo");
    // Again: nothing changes.
    let before = config.clone();
    assert!(!fold_gear_repo(&mut config, &gear_repo, None));
    assert_eq!(config, before);

    // The same repository as a source: that source takes the flag.
    let mut same = json!({ "sources": [
        { "full_path": "constructorfabric/studio-web", "clone_url": "https://github.com/constructorfabric/studio-web" } ]});
    assert!(fold_gear_repo(
        &mut same,
        &gear_repo,
        Some("https://github.com/")
    ));
    assert_eq!(same["sources"].as_array().unwrap().len(), 1);
    assert_eq!(same["sources"][0]["gears_here"], true);
    // No config at all: one source.
    let mut none = json!(null);
    assert!(fold_gear_repo(&mut none, &gear_repo, None));
    assert_eq!(parse(&none).len(), 1);
}

#[test]
fn a_flag_moves_to_one_source() {
    let mut config = json!({ "sources": [
        { "full_path": "a/x", "clone_url": "https://h/a/x.git", "gears_here": true },
        { "full_path": "a/y", "clone_url": "https://h/a/y.git" } ]});
    assert!(mark_only(&mut config, "gears_here", Some("https://h/a/y")));
    let s = parse(&config);
    assert!(!s[0].gears_here && s[1].gears_here);
    assert!(!mark_only(&mut config, "gears_here", Some("https://h/a/z")));
    let repo = json!({ "repo": "a/z", "branch": "dev" });
    assert!(set_gears_here(
        &mut config,
        &repo,
        "https://h/a/z.git",
        Some("https://h")
    ));
    let s = parse(&config);
    assert_eq!(s.len(), 3);
    assert_eq!(s.iter().filter(|s| s.gears_here).count(), 1);
    assert!(s[2].gears_here);
}

#[test]
fn an_unreadable_config_is_a_reason_not_no_sources() {
    let read = sources_of(Ok(json!({ "sources": [
        { "full_path": "acme/api", "clone_url": "https://github.com/acme/api.git" },
    ]})))
    .unwrap()
    .unwrap();
    assert_eq!(read.len(), 1);
    let failed = sources_of(Err(toolkit_canonical_errors::CanonicalError::internal(
        "account-management is down",
    )
    .create()));
    let reason = failed.expect_err("a failed read is not an empty list");
    assert!(
        reason.contains("could not be read"),
        "the reason says what failed: {reason}"
    );
}
