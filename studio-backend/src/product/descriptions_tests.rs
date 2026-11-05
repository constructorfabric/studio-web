//! The description store against PostgreSQL ([`crate::test_pg`]): a suite
//! that migrates, so it takes a database of its own (`fresh_database`).

use std::sync::Arc;

use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::super::migrations::Migrator;
use super::{DescriptionStore, NewRevision, SOURCE_STUDIO, Saved};

static DSN: OnceCell<String> = OnceCell::const_new();

async fn store() -> Arc<DescriptionStore> {
    let dsn = DSN
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("product_descriptions").await;
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
    Arc::new(DescriptionStore::new(
        DBProvider::<anyhow::Error>::new(conn).db(),
    ))
}

fn save<'a>(base: Option<i64>, text: &'a str) -> NewRevision<'a> {
    NewRevision {
        base_revision: base,
        text,
        author: "person-1",
        source: SOURCE_STUDIO,
    }
}

#[tokio::test]
async fn revisions_count_up_and_each_is_kept() {
    let store = store().await;
    let (tenant, project) = (Uuid::new_v4(), Uuid::new_v4());
    assert_eq!(store.latest(tenant, project).await.unwrap(), None);

    let Saved::Created(one) = store
        .save(tenant, project, &save(None, "product shop {}"))
        .await
        .unwrap()
    else {
        panic!("the first save makes revision 1");
    };
    assert_eq!(one.revision, 1);
    assert_eq!(one.sha256, super::digest("product shop {}"));

    let Saved::Created(two) = store
        .save(tenant, project, &save(Some(1), "product shop { gears {} }"))
        .await
        .unwrap()
    else {
        panic!("a save against the latest makes the next");
    };
    assert_eq!(two.revision, 2);
    assert_eq!(
        store
            .latest(tenant, project)
            .await
            .unwrap()
            .map(|r| r.revision),
        Some(2)
    );
    assert_eq!(
        store.get(tenant, project, 1).await.unwrap().map(|r| r.text),
        Some("product shop {}".to_owned())
    );
    let listed: Vec<i64> = store
        .list(tenant, project, 10)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.revision)
        .collect();
    assert_eq!(listed, vec![2, 1]);
}

#[tokio::test]
async fn a_save_against_an_old_revision_is_refused_with_the_latest() {
    let store = store().await;
    let (tenant, project) = (Uuid::new_v4(), Uuid::new_v4());
    store.save(tenant, project, &save(None, "a")).await.unwrap();
    store
        .save(tenant, project, &save(Some(1), "b"))
        .await
        .unwrap();
    match store
        .save(tenant, project, &save(Some(1), "c"))
        .await
        .unwrap()
    {
        Saved::Stale(latest) => {
            assert_eq!(latest.revision, 2);
            assert_eq!(latest.text, "b");
        }
        other => panic!("expected a stale save, got {other:?}"),
    }
    assert_eq!(
        store.latest(tenant, project).await.unwrap().map(|r| r.text),
        Some("b".to_owned())
    );
}

#[tokio::test]
async fn the_same_text_again_is_no_new_revision() {
    let store = store().await;
    let (tenant, project) = (Uuid::new_v4(), Uuid::new_v4());
    store.save(tenant, project, &save(None, "a")).await.unwrap();
    assert!(matches!(
        store.save(tenant, project, &save(Some(1), "a")).await.unwrap(),
        Saved::Unchanged(r) if r.revision == 1
    ));
}

/// A save sent again after its answer was lost (the gateway gave up on it)
/// is the revision the first attempt made, not a conflict with it and not a
/// second revision; a different text against the same old base still is a
/// conflict.
#[tokio::test]
async fn a_save_repeated_is_the_revision_it_made() {
    let store = store().await;
    let (tenant, project) = (Uuid::new_v4(), Uuid::new_v4());
    store.save(tenant, project, &save(None, "a")).await.unwrap();
    assert!(matches!(
        store.save(tenant, project, &save(Some(1), "b")).await.unwrap(),
        Saved::Created(r) if r.revision == 2
    ));
    assert!(matches!(
        store.save(tenant, project, &save(Some(1), "b")).await.unwrap(),
        Saved::Unchanged(r) if r.revision == 2
    ));
    assert!(matches!(
        store.save(tenant, project, &save(Some(1), "c")).await.unwrap(),
        Saved::Stale(r) if r.revision == 2 && r.text == "b"
    ));
    assert_eq!(
        store.list(tenant, project, 10).await.unwrap().len(),
        2,
        "the repeat made no revision"
    );
}

#[tokio::test]
async fn another_tenant_sees_none_of_it() {
    let store = store().await;
    let project = Uuid::new_v4();
    store
        .save(Uuid::new_v4(), project, &save(None, "a"))
        .await
        .unwrap();
    assert_eq!(store.latest(Uuid::new_v4(), project).await.unwrap(), None);
}

fn acting_in(tenant: Uuid) -> toolkit_security::SecurityContext {
    toolkit_security::SecurityContext::builder()
        .subject_id(Uuid::from_u128(7))
        .subject_tenant_id(tenant)
        .build()
        .unwrap()
}

/// One project has one description, whichever tenant the request acts in:
/// the portal acts in the organization it shows, the desktop in the member's
/// home tenant, and both reach the same revisions -- they are kept under the
/// organization the project hangs under, not the request's tenant.
#[tokio::test]
async fn one_project_has_one_description_whichever_tenant_asks() {
    use crate::product::service::ProductService;
    let service = ProductService::new(
        Arc::new(crate::catalog_graph::MemorySink::default()),
        crate::connectors::sdk::Connectors::new(Arc::new(toolkit::client_hub::ClientHub::new())),
    );
    service.set_descriptions(store().await);
    let (organization, home, project) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    service.set_project_organization(project, organization);
    let portal = acting_in(organization);
    let desktop = acting_in(home);

    let saved = service
        .save_description(
            &portal,
            project,
            None,
            "product shop {}",
            SOURCE_STUDIO,
            None,
        )
        .await
        .unwrap();
    assert!(matches!(saved, Saved::Created(ref r) if r.revision == 1));
    let read = service
        .latest_description(&desktop, project)
        .await
        .unwrap()
        .expect("the desktop reads what the portal saved");
    assert_eq!((read.revision, read.text.as_str()), (1, "product shop {}"));

    // The desktop's save is the portal's next revision, and a stale one from
    // the portal is refused with it.
    service
        .save_description(
            &desktop,
            project,
            Some(1),
            "product shop { a }",
            SOURCE_STUDIO,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .latest_description(&portal, project)
            .await
            .unwrap()
            .map(|r| r.revision),
        Some(2)
    );
    assert!(matches!(
        service
            .save_description(&portal, project, Some(1), "product shop { b }", SOURCE_STUDIO, None)
            .await
            .unwrap(),
        Saved::Stale(ref l) if l.revision == 2
    ));

    // A project the caller cannot place under an organization is refused,
    // never kept under the request's tenant.
    let elsewhere = Uuid::new_v4();
    let refused = service
        .latest_description(&portal, elsewhere)
        .await
        .unwrap_err();
    assert!(
        refused
            .downcast_ref::<crate::product::service::description_service::ProjectNotReachable>()
            .is_some()
    );
}
