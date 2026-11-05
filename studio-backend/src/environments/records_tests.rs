//! The environments' tables against PostgreSQL ([`crate::test_pg`]): a suite
//! that migrates, so it takes a database of its own.

use std::sync::Arc;

use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::super::images::{ImageKind, ImageRecord, ImageState, Retention};
use super::super::migrations::Migrator;
use super::{Assigned, Assignment, ImageFilter, Records};

static DSN: OnceCell<String> = OnceCell::const_new();

async fn records() -> Arc<Records> {
    let dsn = DSN
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("environments_records").await;
            let conn = connect_db(&dsn, ConnectOpts::default())
                .await
                .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
            run_migrations_for_testing(&conn, Migrator::migrations())
                .await
                .expect("run migrations");
            dsn
        })
        .await;
    let conn = connect_db(dsn, ConnectOpts::default())
        .await
        .expect("connect");
    Arc::new(Records::new(DBProvider::<anyhow::Error>::new(conn).db()))
}

fn digest(n: u8) -> String {
    format!(
        "sha256:{}",
        format!("{n:x}")
            .repeat(64)
            .chars()
            .take(64)
            .collect::<String>()
    )
}

fn image(org: Uuid, project: Uuid, repo: &str, n: u8) -> ImageRecord {
    ImageRecord {
        id: Uuid::new_v4(),
        organization_id: org,
        project_id: project,
        registry_connection_id: None,
        registry_host: "ghcr.io".into(),
        repository: repo.into(),
        tags: vec![format!("t{n}")],
        digest: digest(n),
        media_type: None,
        size_bytes: None,
        platforms: vec![],
        build_id: Some(format!("studio-{n}")),
        app: Some("api".into()),
        commit: None,
        description_revision: None,
        lock_hash: None,
        pushed_by: Some("studio".into()),
        pushed_at_ms: i64::from(n),
        kind: ImageKind::Image,
        state: ImageState::Present,
        pinned: false,
        promoted_from: None,
        source_ref: None,
    }
}

#[tokio::test]
async fn a_slug_is_made_once_and_never_shared() {
    let r = records().await;
    let org = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    let name = format!("Shop {}", &org.simple().to_string()[..6]);
    let first = r.slug(org, a, &name).await.unwrap();
    assert_eq!(
        r.slug(org, a, "Renamed").await.unwrap(),
        first,
        "a rename keeps it"
    );
    let second = r.slug(org, b, &name).await.unwrap();
    assert_ne!(first, second);
    assert_eq!(second, format!("{first}-2"));
    // Another organization's project with the same name gets its own too.
    let other = r.slug(Uuid::new_v4(), Uuid::new_v4(), &name).await.unwrap();
    assert_ne!(other, first);
    assert_eq!(r.slugs(org).await.unwrap().len(), 2);
}

#[tokio::test]
async fn a_namespace_is_recorded_once_and_held_by_one_project() {
    let r = records().await;
    let org = Uuid::new_v4();
    let cluster = Uuid::new_v4();
    let (a, b, env) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let ns = format!("shop-{}", &org.simple().to_string()[..6]);
    let mine = Assignment {
        project_id: a,
        environment_id: env,
        cluster_connection_id: cluster,
        namespace: ns.clone(),
        build_namespace: format!("{ns}-build"),
        assigned_by: "studio".into(),
        assigned_at_ms: 1,
    };
    assert!(matches!(
        r.assign(org, &mine, false).await.unwrap(),
        Assigned::Kept(_)
    ));
    let again = Assignment {
        namespace: "elsewhere".into(),
        ..mine.clone()
    };
    let Assigned::Kept(kept) = r.assign(org, &again, false).await.unwrap() else {
        panic!("kept");
    };
    assert_eq!(kept.namespace, ns, "the first record wins unless replaced");
    let theirs = Assignment {
        project_id: b,
        ..mine.clone()
    };
    assert_eq!(
        r.assign(org, &theirs, false).await.unwrap(),
        Assigned::Taken
    );
    assert_eq!(r.assignments(org).await.unwrap().len(), 1);
}

#[tokio::test]
async fn an_image_record_merges_by_digest_and_belongs_to_its_project() {
    let r = records().await;
    let (org, project) = (Uuid::new_v4(), Uuid::new_v4());
    let repo = format!("acme/{}/api", project.simple());
    let one = r
        .record_image(&image(org, project, &repo, 1))
        .await
        .unwrap();
    let mut same = image(org, project, &repo, 1);
    same.tags = vec!["latest".into()];
    let merged = r.record_image(&same).await.unwrap();
    assert_eq!(merged.id, one.id);
    assert_eq!(merged.tags, vec!["t1".to_owned(), "latest".to_owned()]);
    r.record_image(&image(org, project, &repo, 2))
        .await
        .unwrap();

    let (list, total) = r
        .images(org, project, &ImageFilter::default(), 0, 10)
        .await
        .unwrap();
    assert_eq!(total, 2);
    assert_eq!(list[0].digest, digest(2), "newest first");
    let other = Uuid::new_v4();
    assert!(r.image(org, other, one.id).await.unwrap().is_none());
    r.set_pinned(org, one.id, true).await.unwrap();
    r.set_state(org, one.id, ImageState::Deleted).await.unwrap();
    let got = r.image(org, project, one.id).await.unwrap().unwrap();
    assert!(got.pinned);
    assert_eq!(got.state, ImageState::Deleted);
    let filtered = r
        .images(
            org,
            project,
            &ImageFilter {
                state: Some(ImageState::Present),
                ..ImageFilter::default()
            },
            0,
            10,
        )
        .await
        .unwrap();
    assert_eq!(filtered.1, 1);
    assert_eq!(r.images_on(org, "ghcr.io").await.unwrap().len(), 2);
}

#[tokio::test]
async fn a_retention_policy_is_kept_per_scope() {
    let r = records().await;
    let (org, project) = (Uuid::new_v4(), Uuid::new_v4());
    assert_eq!(r.retention(org, project).await.unwrap(), None);
    let p = Retention {
        keep_last: Some(5),
        keep_days: None,
    };
    r.put_retention(org, project, p, "alice").await.unwrap();
    r.put_retention(
        org,
        org,
        Retention {
            keep_last: None,
            keep_days: Some(30),
        },
        "alice",
    )
    .await
    .unwrap();
    assert_eq!(r.retention(org, project).await.unwrap(), Some(p));
    assert_eq!(
        r.retention(org, org).await.unwrap(),
        Some(Retention {
            keep_last: None,
            keep_days: Some(30)
        })
    );
}
