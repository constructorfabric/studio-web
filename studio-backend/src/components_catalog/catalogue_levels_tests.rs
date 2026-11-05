use super::*;

fn source(repo: &str) -> RepoSource {
    RepoSource {
        tenant: Uuid::from_u128(1),
        connection_id: None,
        repo: repo.to_owned(),
        git_ref: "main".to_owned(),
        mode: "gears".to_owned(),
    }
}

fn pin(repo: &str, git_ref: &str) -> PlatformPin {
    PlatformPin {
        repo: repo.to_owned(),
        git_ref: git_ref.to_owned(),
        note: None,
        pinned_by: "p".to_owned(),
        pinned_by_name: None,
        at: "2026-11-04T00:00:00Z".to_owned(),
    }
}

fn node(type_id: &str, id: &str, value: Value) -> CatalogNodeView {
    CatalogNodeView {
        type_id: type_id.to_owned(),
        instance_id: id.to_owned(),
        value,
    }
}

#[test]
fn a_pin_names_a_platform_source_once() {
    let platform = [source("constructorfabric/gears-rust")];
    let pins = normalize_pins(
        vec![
            pin(" constructorfabric/gears-rust/ ", "v0.9.0"),
            pin("Constructorfabric/Gears-Rust", "v0.10.0"),
        ],
        &platform,
    )
    .unwrap();
    assert_eq!(pins.len(), 1);
    assert_eq!(pins[0].git_ref, "v0.10.0");
    let e = normalize_pins(vec![pin("someone/else", "v1")], &platform).unwrap_err();
    assert!(
        matches!(e, LevelError::Invalid { field: "repo", .. }),
        "{e}"
    );
    let e =
        normalize_pins(vec![pin("constructorfabric/gears-rust", "a b")], &platform).unwrap_err();
    assert!(
        matches!(
            e,
            LevelError::Invalid {
                field: "git_ref",
                ..
            }
        ),
        "{e}"
    );
}

#[test]
fn a_pinned_platform_component_says_its_version_and_is_never_hidden() {
    let mut nodes = vec![
        node(
            gts::GEAR_TYPE,
            "a",
            json!({"name": "a", "tier": "platform", "synced_from": "constructorfabric/gears-rust"}),
        ),
        node(
            gts::GEAR_TYPE,
            "b",
            json!({"name": "b", "tier": "organization", "synced_from": "constructorfabric/gears-rust"}),
        ),
        node(
            gts::FRONTX_TYPE,
            "c",
            json!({"name": "c", "tier": "platform", "synced_from": "constructorfabric/gears-frontx"}),
        ),
    ];
    apply_pins(
        &mut nodes,
        &[pin("constructorfabric/gears-rust", "v0.10.0")],
    );
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[0].value["pinned_ref"], "v0.10.0");
    assert!(nodes[1].value.get("pinned_ref").is_none());
    assert!(nodes[2].value.get("pinned_ref").is_none());
}

#[test]
fn a_project_sees_its_own_components_beside_the_organizations() {
    let project = Uuid::from_u128(9);
    let org = vec![
        node(
            gts::GEAR_TYPE,
            "x",
            json!({"name": "x", "tier": "platform"}),
        ),
        node(
            gts::FRONTX_TYPE,
            "y",
            json!({"name": "y", "tier": "organization"}),
        ),
    ];
    let own = vec![
        node(gts::FRONTX_TYPE, "y", json!({"name": "y", "own": true})),
        node(
            gts::FRONTX_TYPE,
            "z",
            json!({"name": "@constructor-studio/projects-mfe"}),
        ),
    ];
    let joined = join_project(org, own, project);
    assert_eq!(joined.len(), 3);
    let y = joined.iter().find(|n| n.instance_id == "y").unwrap();
    assert_eq!(y.value["own"], true);
    assert_eq!(y.value["tier"], "project");
    assert_eq!(y.value["project_id"], project.to_string());
    assert_eq!(
        joined.iter().find(|n| n.instance_id == "x").unwrap().value["tier"],
        "platform"
    );
}

fn read(project: Uuid, key: &str, print: &str) -> (String, ReadRecord) {
    (
        format!("{project}{key}"),
        ReadRecord {
            organization_id: Uuid::from_u128(1),
            project_id: project,
            repo: "o/r".into(),
            repo_key: key.into(),
            git_ref: "main".into(),
            fingerprint: print.into(),
            commit: None,
            read_at: String::new(),
            cargo_deps: Vec::new(),
        },
    )
}

#[test]
fn a_projects_fingerprint_moves_with_any_of_its_repositories() {
    let p = Uuid::from_u128(7);
    let q = Uuid::from_u128(8);
    let one = vec![
        read(p, "o/a@main", "1"),
        read(p, "o/b@main", "2"),
        read(q, "o/c@main", "3"),
    ];
    let same = vec![read(p, "o/b@main", "2"), read(p, "o/a@main", "1")];
    let moved = vec![read(p, "o/a@main", "1"), read(p, "o/b@main", "9")];
    let added = vec![
        read(p, "o/a@main", "1"),
        read(p, "o/b@main", "2"),
        read(p, "o/d@main", "4"),
    ];
    let base = project_fingerprint(&one, p).unwrap();
    assert_eq!(project_fingerprint(&same, p).unwrap(), base);
    assert_ne!(project_fingerprint(&moved, p).unwrap(), base);
    assert_ne!(project_fingerprint(&added, p).unwrap(), base);
    assert!(project_fingerprint(&one, Uuid::from_u128(99)).is_none());
}

fn publication(state: &str) -> Publication {
    Publication {
        id: Uuid::from_u128(3),
        organization_id: Uuid::from_u128(1),
        project_id: Uuid::from_u128(2),
        project_name: Some("Studioweb".into()),
        type_id: gts::FRONTX_TYPE.into(),
        name: "@constructor-studio/projects-mfe".into(),
        kind: Some("frontx".into()),
        repo: Some("constructorfabric/studio-web".into()),
        path: Some("studio-frontend/src-app/mfe_packages/projects-mfe".into()),
        git_ref: "v1.2.0".into(),
        commit: Some("abc".into()),
        version: Some("1.2.0".into()),
        artifact: None,
        reason: None,
        requested_by: "me".into(),
        requested_by_name: None,
        at: "2026-11-04T00:00:00Z".into(),
        state: state.into(),
        decided_by: None,
        decided_by_name: None,
        decided_at: None,
        decline_reason: None,
    }
}

#[test]
fn a_publication_is_answered_once_and_a_decline_says_why() {
    let mut queue = vec![publication(REQUESTED)];
    let by = ("admin".to_string(), Some("Admin".to_string()));
    let e = answer(
        &mut queue,
        Uuid::from_u128(3),
        false,
        by.clone(),
        "t".into(),
        None,
    )
    .unwrap_err();
    assert!(matches!(
        e,
        LevelError::Invalid {
            field: "reason",
            ..
        }
    ));
    let p = answer(
        &mut queue,
        Uuid::from_u128(3),
        true,
        by.clone(),
        "t".into(),
        None,
    )
    .unwrap();
    assert_eq!(p.state, APPROVED);
    assert_eq!(p.decided_by.as_deref(), Some("admin"));
    let e = answer(
        &mut queue,
        Uuid::from_u128(3),
        true,
        by.clone(),
        "t".into(),
        None,
    )
    .unwrap_err();
    assert_eq!(e, LevelError::Answered(APPROVED.into()));
    let e = answer(&mut queue, Uuid::from_u128(4), true, by, "t".into(), None).unwrap_err();
    assert!(matches!(e, LevelError::NotFound(_)));
}

#[test]
fn a_published_copy_keeps_the_version_and_is_not_pruned_by_a_sync() {
    let n = node(
        gts::FRONTX_TYPE,
        "id",
        json!({"name": "@constructor-studio/projects-mfe", "tier": "project", "project_id": "x", "synced_from": "constructorfabric/studio-web", "version": "1.1.0"}),
    );
    let mut p = publication(APPROVED);
    p.decided_at = Some("t".into());
    let out = published_node(&n, &p);
    assert_eq!(out.type_id, gts::FRONTX_TYPE);
    assert_eq!(out.instance_id, "id");
    assert!(out.value.get("tier").is_none());
    assert!(out.value.get("project_id").is_none());
    assert_eq!(out.value["version"], "1.2.0");
    assert_eq!(out.value["published_from"]["git_ref"], "v1.2.0");
    assert_eq!(out.value["published_from"]["project_name"], "Studioweb");
    assert!(
        out.value["synced_from"]
            .as_str()
            .unwrap()
            .starts_with("publication:")
    );
}

#[test]
fn a_project_is_read_for_gears_and_for_frontx() {
    let repos = vec![super::super::service::ProjectRepo {
        tenant: Uuid::from_u128(1),
        holder: Uuid::from_u128(1),
        connection_id: Some(Uuid::from_u128(5)),
        repo: "constructorfabric/studio-web".into(),
        branch: "main".into(),
        owned: true,
    }];
    let sources = project_sources(&repos);
    let modes: Vec<&str> = sources.iter().map(|s| s.mode.as_str()).collect();
    assert_eq!(modes, vec!["gears", "frontx"]);
    assert!(
        sources
            .iter()
            .all(|s| s.repo == "constructorfabric/studio-web")
    );
}

#[test]
fn a_walks_projects_are_the_ones_it_resolved() {
    let org = Uuid::from_u128(1);
    let walk = |id: u128, error: Option<&str>| registry::ProjectWalk {
        project_id: Uuid::from_u128(id),
        error: error.map(str::to_owned),
        ..registry::ProjectWalk::default()
    };
    let statuses = vec![
        walk(1, None),
        walk(3, None),
        walk(2, Some("x")),
        walk(3, None),
    ];
    assert_eq!(walked_projects(&statuses, org), vec![Uuid::from_u128(3)]);
}
