use super::*;

const D1: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const D2: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const D3: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

fn record(repo: &str, digest: &str, at: i64) -> ImageRecord {
    ImageRecord {
        id: Uuid::new_v4(),
        organization_id: Uuid::nil(),
        project_id: Uuid::nil(),
        registry_connection_id: None,
        registry_host: "ghcr.io".into(),
        repository: repo.into(),
        tags: vec![],
        digest: digest.into(),
        media_type: None,
        size_bytes: None,
        platforms: vec![],
        build_id: None,
        app: None,
        commit: None,
        description_revision: None,
        lock_hash: None,
        pushed_by: None,
        pushed_at_ms: at,
        kind: ImageKind::Image,
        state: ImageState::Present,
        pinned: false,
        promoted_from: None,
        source_ref: None,
    }
}

#[test]
fn a_reference_is_read_the_way_a_container_runtime_reads_it() {
    let r = Reference::parse("postgres:16").unwrap();
    assert_eq!(
        (r.host.as_str(), r.repository.as_str(), r.tag.as_deref()),
        ("docker.io", "library/postgres", Some("16"))
    );
    let r = Reference::parse("bitnami/keycloak").unwrap();
    assert_eq!(r.to_text(), "docker.io/bitnami/keycloak");
    let r = Reference::parse(&format!("ghcr.io/acme/shop/api:sha-1@{D1}")).unwrap();
    assert_eq!(r.repository, "acme/shop/api");
    assert_eq!(r.digest.as_deref(), Some(D1));
    let r = Reference::parse("registry.example:5000/x/y").unwrap();
    assert_eq!((r.host.as_str(), r.tag), ("registry.example:5000", None));
    let r = Reference::parse("oci://ghcr.io/acme/shop/charts/shop").unwrap();
    assert_eq!(r.repository, "acme/shop/charts/shop");
    for bad in [
        "",
        "https://ghcr.io/x",
        "ghcr.io/ACME/x",
        "x@sha256:12",
        "a b",
    ] {
        assert!(Reference::parse(bad).is_none(), "{bad}");
    }
}

#[test]
fn a_project_owns_one_path_and_a_deploy_takes_nothing_from_outside_it() {
    let own = project_prefix("ghcr.io/acme/", "shop");
    assert_eq!(own, "ghcr.io/acme/shop");
    assert!(is_under(&format!("ghcr.io/acme/shop/api@{D1}"), &own));
    assert!(is_under("oci://ghcr.io/acme/shop/charts/shop", &own));
    assert!(!is_under("ghcr.io/acme/shopping/api", &own));
    assert!(!is_under("ghcr.io/acme/other/api", &own));
    assert!(!is_under("docker.io/library/postgres:16", &own));
}

#[test]
fn an_import_is_named_after_its_source_unless_a_name_is_given() {
    let src = Reference::parse("quay.io/keycloak/keycloak:26.0").unwrap();
    assert_eq!(default_mirror_name(&src), "keycloak");
    assert_eq!(checked_mirror_name(" infra/pg ").unwrap(), "infra/pg");
    assert!(checked_mirror_name("Pg").is_err());
    assert!(checked_mirror_name("a//b").is_err());
}

#[test]
fn a_manifest_makes_one_record_per_image_and_one_for_the_chart() {
    let images = vec![
        (
            "api".to_owned(),
            format!("ghcr.io/acme/shop/api:sha-abc@{D1}"),
        ),
        ("ui".to_owned(), "ghcr.io/acme/shop/ui:sha-abc".to_owned()),
    ];
    let recs = from_manifest(
        Uuid::nil(),
        Uuid::nil(),
        None,
        "studio-1",
        Some("abc"),
        Some(3),
        None,
        "studio",
        1,
        &images,
        Some((
            "oci://ghcr.io/acme/shop/charts/shop",
            "0.1.0-sha.abc",
            Some(D2),
        )),
    );
    assert_eq!(recs.len(), 2, "an image without a digest is not a record");
    assert_eq!(recs[0].app.as_deref(), Some("api"));
    assert_eq!(recs[0].tags, vec!["sha-abc".to_owned()]);
    assert_eq!(recs[1].kind, ImageKind::Chart);
    assert_eq!(recs[1].repository, "acme/shop/charts/shop");
    assert_eq!(recs[1].tags, vec!["0.1.0-sha.abc".to_owned()]);
    assert_eq!(recs[0].reference(), format!("ghcr.io/acme/shop/api@{D1}"));
}

#[test]
fn a_sweep_keeps_the_policy_and_whatever_runs_or_is_pinned() {
    let day = 24 * 60 * 60 * 1000;
    let now = 100 * day;
    let newest = record("acme/shop/api", D1, now - day);
    let mut pinned = record("acme/shop/api", D2, now - 50 * day);
    pinned.pinned = true;
    let old = record("acme/shop/api", D3, now - 60 * day);
    let running_id = old.id;
    let mut gone = record("acme/shop/api", D3, now - 70 * day);
    gone.state = ImageState::Deleted;
    let all = vec![newest.clone(), pinned.clone(), old.clone(), gone];

    let policy = Retention {
        keep_last: Some(1),
        keep_days: Some(30),
    };
    let none_run = |_: &ImageRecord| false;
    let out = sweep(&all, policy, &none_run, now);
    assert_eq!(
        out,
        vec![(pinned.id, Sweep::Retain), (old.id, Sweep::Delete)]
    );
    let runs = move |r: &ImageRecord| r.id == running_id;
    let out = sweep(&all, policy, &runs, now);
    assert!(out.contains(&(old.id, Sweep::Retain)));
    assert!(sweep(&all, Retention::default(), &none_run, now).is_empty());
}

#[test]
fn a_retention_policy_is_bounded() {
    assert!(
        checked_retention(Retention {
            keep_last: Some(0),
            keep_days: None
        })
        .is_err()
    );
    assert!(
        checked_retention(Retention {
            keep_last: None,
            keep_days: Some(400)
        })
        .is_err()
    );
    assert!(
        checked_retention(Retention {
            keep_last: Some(5),
            keep_days: Some(30)
        })
        .is_ok()
    );
}

#[test]
fn orphans_are_told_apart_by_why() {
    let shop = Uuid::new_v4();
    let slugs = vec![("shop".to_owned(), shop)];
    let mut recorded = record("acme/shop/api", D1, 1);
    recorded.project_id = shop;
    let mut missing = record("acme/shop/api", D3, 1);
    missing.project_id = shop;
    let held = vec![
        RegistryVersion {
            repository: "acme/shop/api".into(),
            digest: Some(D1.into()),
            tags: vec!["sha-1".into()],
            size_bytes: None,
            pushed_at: None,
        },
        RegistryVersion {
            repository: "acme/shop/api".into(),
            digest: Some(D2.into()),
            tags: vec![],
            size_bytes: None,
            pushed_at: None,
        },
        RegistryVersion {
            repository: "acme/studio-backend".into(),
            digest: Some(D2.into()),
            tags: vec!["sha-x".into()],
            size_bytes: None,
            pushed_at: None,
        },
    ];
    let none_run = |_: &ImageRecord| false;
    let found = orphans(
        "acme",
        &held,
        &[recorded.clone(), missing.clone()],
        &slugs,
        &none_run,
    );
    let reasons: Vec<_> = found
        .iter()
        .map(|o| (o.repository.as_str(), o.reason))
        .collect();
    assert_eq!(
        reasons,
        vec![
            ("acme/shop/api", OrphanReason::Undeployed),
            ("acme/shop/api", OrphanReason::Unrecorded),
            ("acme/studio-backend", OrphanReason::Unowned),
            ("acme/shop/api", OrphanReason::Missing),
        ]
    );
    let runs = |r: &ImageRecord| r.digest == D1;
    let found = orphans("acme", &held, &[recorded], &slugs, &runs);
    assert!(found.iter().all(|o| o.reason != OrphanReason::Undeployed));
    assert_eq!(
        repository_owner("acme", "acme/shop/charts/shop", &slugs),
        Some(shop)
    );
    assert_eq!(repository_owner("acme", "other/shop/x", &slugs), None);
}

#[test]
fn a_builds_chart_digest_is_its_chart_record_at_the_version() {
    let mut chart = record("acme/shop/charts/shop", D2, 2);
    chart.kind = ImageKind::Chart;
    chart.tags = vec!["0.1.0-sha.abc.r4".into()];
    let mut image = record("acme/shop/charts/shop", D1, 1);
    image.tags = vec!["0.1.0-sha.abc.r4".into()];
    let wanted = super::super::model::ChartRef {
        reference: "oci://ghcr.io/acme/shop/charts/shop".into(),
        version: "0.1.0-sha.abc.r4".into(),
        digest: None,
    };
    let records = [image, chart];
    assert_eq!(chart_digest(&records, &wanted).as_deref(), Some(D2));
    let other = super::super::model::ChartRef {
        version: "0.1.0-sha.abc.r5".into(),
        ..wanted.clone()
    };
    assert_eq!(chart_digest(&records, &other), None, "another version");
}
