//! An organization's catalogue sources over REST: the tenant a source reads
//! connections from is the organization's own, never the platform's root.

use std::sync::Arc;

use axum::response::IntoResponse;

use super::*;
use crate::catalog_graph::MemorySink;

const ORG: Uuid = Uuid::from_u128(0x0a6);
const ROOT: Uuid = super::super::tiers::PLATFORM_TENANT;

fn catalog() -> Catalog {
    let service = Arc::new(CatalogService::new(
        Arc::new(MemorySink::default()),
        "k".to_string(),
        None,
    ));
    Catalog::new(service, Arc::new(ClientHub::new()), None)
}

fn caller() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(7))
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

fn dto(tenant: Uuid) -> RepoSourceDto {
    RepoSourceDto {
        tenant,
        connection_id: None,
        repo: "acme/gears".into(),
        git_ref: None,
        mode: None,
        shadowed_by_platform: None,
    }
}

fn refused_for_the_tenant(e: CanonicalError) {
    let problem = format!("{e:?}");
    assert!(problem.contains("SOURCE_TENANT_NOT_OWNED"), "{problem}");
    assert_eq!(e.into_response().status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_organizations_stored_source_naming_the_root_is_refused() {
    let c = catalog();
    let Err(e) = update_sources(
        OrgCtx(caller()),
        Extension(c.clone()),
        Json(ReplaceSourcesRequest {
            items: vec![dto(Uuid::nil()), dto(ROOT)],
        }),
    )
    .await
    else {
        panic!("a source naming the platform's root is stored");
    };
    refused_for_the_tenant(e);
    assert!(
        c.service.list_sources(&caller()).await.unwrap().is_empty(),
        "nothing is stored"
    );

    // No tenant named: the organization's.
    let Ok(Json(stored)) = update_sources(
        OrgCtx(caller()),
        Extension(c.clone()),
        Json(ReplaceSourcesRequest {
            items: vec![dto(Uuid::nil())],
        }),
    )
    .await
    else {
        panic!("the organization's own source is refused");
    };
    assert_eq!(stored.items.len(), 1);
    assert_eq!(stored.items[0].tenant, ORG);
    let kept = c.service.list_sources(&caller()).await.unwrap();
    assert_eq!(kept[0].tenant, ORG);
}

#[tokio::test]
async fn a_sync_body_naming_the_root_is_refused() {
    let Err(e) = sync(
        OrgCtx(caller()),
        Extension(catalog()),
        HeaderMap::new(),
        Some(Json(SyncRequestDto {
            crates_io: None,
            repositories: Some(vec![dto(ROOT)]),
            roadmaps: None,
        })),
    )
    .await
    else {
        panic!("a sync naming the platform's root is queued");
    };
    refused_for_the_tenant(e);

    let Err(e) = sync(
        OrgCtx(caller()),
        Extension(catalog()),
        HeaderMap::new(),
        Some(Json(SyncRequestDto {
            crates_io: None,
            repositories: None,
            roadmaps: Some(vec![RoadmapSourceDto {
                tenant: ROOT,
                connection_id: None,
                owner: "acme".into(),
                number: 1,
                consumers: None,
                stage_field: None,
                commitment_field: None,
                priority_field: None,
                effort_field: None,
                roots: None,
            }]),
        })),
    )
    .await
    else {
        panic!("a board read through the platform's root is queued");
    };
    refused_for_the_tenant(e);
}
