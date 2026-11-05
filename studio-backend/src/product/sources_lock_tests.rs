use super::*;

const SHA: &str = "75f5d9eaffe1a78552e004dfed0aab14cbb266d7";

/// Revision 5 of Studioweb: studio-web named twice.
const TWICE: &str = r#"gdl_version = "1.5"
# source(id = "commented", at = path("x"))
product(
    id = "studioweb",
    sources = [source(id = "gears-rust", at = git(url = "https://github.com/MikeFalcon77/gears-rust.git", rev = "75f5d9eaffe1a78552e004dfed0aab14cbb266d7")),
               source(id = "studio-backend", at = git(url = "https://github.com/AndrejK666/studio-web.git", rev = "fadb42ff")),
               source(id = "frontx-studio-web", at = path("../.."))],
    frontend = frontx_product(
        source = "frontx-studio-web",
        shell = path("studio-frontend"),
    ),
    gears = [use_gear("api-gateway", source = "gears-rust")],
)
"#;

fn project(path: &str, branch: &str) -> ProjectSource {
    ProjectSource {
        connection_id: None,
        full_path: path.into(),
        clone_url: format!("https://github.com/{path}.git"),
        branch: Some(branch.into()),
        dir: crate::project_sources::checkout_dir(path),
        ..ProjectSource::default()
    }
}

#[test]
fn a_description_says_each_source_and_where_it_is() {
    let got = sources(TWICE);
    assert_eq!(
        got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["gears-rust", "studio-backend", "frontx-studio-web"],
        "a commented-out source and a frontend's `source =` are not sources"
    );
    assert_eq!(
        got[0].at,
        At::Git {
            url: "https://github.com/MikeFalcon77/gears-rust.git".into(),
            rev: SHA.into()
        }
    );
    assert_eq!(got[2].at, At::Path("../..".into()));
}

#[test]
fn a_path_is_a_directory_of_the_repository_the_description_is_in() {
    let at = "products/studioweb/product.gdl";
    assert_eq!(resolve_path(at, "../..").as_deref(), Some(""));
    assert_eq!(
        resolve_path(at, "../../studio-backend").as_deref(),
        Some("studio-backend")
    );
    assert_eq!(resolve_path(at, "../../../gears-rust"), None);
    assert_eq!(
        resolve_path("product.gdl", "studio-backend").as_deref(),
        Some("studio-backend")
    );
}

#[test]
fn one_repository_named_twice_is_refused_with_both_names() {
    let found = duplicates(
        &sources(TWICE),
        "products/studioweb/product.gdl",
        Some("https://github.com/AndrejK666/studio-web"),
    );
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("`studio-backend`") && found[0].contains("`frontx-studio-web`"));

    let nested = vec![
        GdlSource {
            id: "studio-web".into(),
            at: At::Path("../..".into()),
        },
        GdlSource {
            id: "studio-backend".into(),
            at: At::Path("../../studio-backend".into()),
        },
    ];
    let found = duplicates(&nested, "products/x/product.gdl", None);
    assert_eq!(found.len(), 1);
    assert!(found[0].contains("GBX0105"));

    let two_git = vec![
        GdlSource {
            id: "a".into(),
            at: At::Git {
                url: "https://github.com/acme/gears.git".into(),
                rev: "main".into(),
            },
        },
        GdlSource {
            id: "b".into(),
            at: At::Git {
                url: "https://GitHub.com/acme/gears/".into(),
                rev: SHA.into(),
            },
        },
    ];
    assert_eq!(duplicates(&two_git, "product.gdl", None).len(), 1);
}

#[test]
fn directories_side_by_side_and_one_source_per_repository_stand() {
    // Revision 6: one studio-web.
    let one = r#"product(id = "studioweb", sources = [
        source(id = "gears-rust", at = git(url = "https://github.com/MikeFalcon77/gears-rust.git", rev = "75f5d9eaffe1a78552e004dfed0aab14cbb266d7")),
        source(id = "studio-web", at = path("../.."))])"#;
    assert!(
        duplicates(
            &sources(one),
            "products/studioweb/product.gdl",
            Some("https://github.com/AndrejK666/studio-web.git")
        )
        .is_empty()
    );
    let side = vec![
        GdlSource {
            id: "studio-backend".into(),
            at: At::Path("studio-backend".into()),
        },
        GdlSource {
            id: "docs".into(),
            at: At::Path("docs".into()),
        },
    ];
    assert!(duplicates(&side, "product.gdl", None).is_empty());
}

#[test]
fn a_dev_build_takes_each_branch_and_a_protected_one_the_lock() {
    let text = r#"product(id = "shop", sources = [
        source(id = "gears-rust", at = git(url = "https://github.com/acme/gears-rust.git", rev = "75f5d9eaffe1a78552e004dfed0aab14cbb266d7")),
        source(id = "shop", at = path("../..")),
        source(id = "billing", at = git(url = "https://github.com/acme/billing.git", rev = "main"))])"#;
    let home = project("acme/shop", "dev");
    let billing = project("acme/billing", "feature/x");
    let all = vec![home.clone(), billing];
    let planned: Vec<LockedSource> = plan(
        &sources(text),
        "products/shop/product.gdl",
        &all,
        Some(&home),
    )
    .into_iter()
    .map(|(l, _)| l)
    .collect();
    assert_eq!(planned.len(), 3);
    assert_eq!(
        planned[0].commit.as_deref(),
        Some(SHA),
        "a commit rev is pinned already"
    );
    assert_eq!(
        planned[0].repository, None,
        "the platform's is not a project source"
    );
    assert_eq!(planned[1].repository.as_deref(), Some("acme/shop"));
    assert_eq!(planned[2].repository.as_deref(), Some("acme/billing"));

    let dev = build_refs(None, &planned, false).unwrap();
    assert_eq!(dev.home.as_deref(), Some("dev"));
    assert_eq!(
        dev.git,
        vec![("billing".to_owned(), "feature/x".to_owned())]
    );

    assert!(
        build_refs(None, &planned, true)
            .unwrap_err()
            .contains("pins nothing")
    );
    let mut lock = SourcesLock {
        sources: planned.clone(),
    };
    assert!(!lock.complete());
    assert!(
        build_refs(Some(&lock), &planned, true)
            .unwrap_err()
            .contains("`shop`")
    );
    lock.sources[1].commit = Some("a".repeat(40));
    lock.sources[2].commit = Some("b".repeat(40));
    assert!(lock.complete());
    let prot = build_refs(Some(&lock), &planned, true).unwrap();
    assert_eq!(prot.home, Some("a".repeat(40)));
    assert_eq!(prot.git, vec![("billing".to_owned(), "b".repeat(40))]);
    assert_eq!(lock.commit_of("billing"), Some("b".repeat(40).as_str()));
}

#[test]
fn a_lock_reads_back_as_it_was_written() {
    let lock = SourcesLock {
        sources: vec![LockedSource {
            id: "shop".into(),
            kind: "path".into(),
            repository: Some("acme/shop".into()),
            url: "https://github.com/acme/shop.git".into(),
            branch: Some("main".into()),
            commit: Some(SHA.into()),
        }],
    };
    let text = serde_json::to_string(&lock).unwrap();
    assert_eq!(serde_json::from_str::<SourcesLock>(&text).unwrap(), lock);
    assert!(is_commit(SHA));
    assert!(!is_commit("main"));
}
