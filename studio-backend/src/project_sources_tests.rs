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
    }
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
