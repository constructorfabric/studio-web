//! A gear's type stays the gear's, and stays extensible: an administrator adds
//! fields beside the gear's, people fill them in, and the gear's next write
//! keeps them; the gear's own fields cannot be renamed, dropped or set from
//! outside.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::ontology::{FieldEdit, FieldSpec};
use super::port::{DomainObjects, Objects, OwnedObject, TypeNeed};
use super::service::DomainModelService;
use super::store::InMemoryDomainStore;
use super::validate::ValidateMode;

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(Uuid::from_u128(7))
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

fn need() -> TypeNeed {
    TypeNeed {
        id: "test-environment".into(),
        name: "Test Environment".into(),
        description: "A gear's record.".into(),
        extends: Some("record".into()),
        bucket: Some("operations".into()),
        fields: vec![("namespace".into(), "string".into(), String::new())],
        relations: Vec::new(),
        held_by: Some("studio-test".into()),
        searchable: false,
    }
}

async fn rig() -> (Arc<DomainModelService>, Objects, String) {
    let service = Arc::new(DomainModelService::new(Arc::new(
        InMemoryDomainStore::default(),
    )));
    let port = Objects(Arc::clone(&service));
    port.ensure_type(&ctx(), &need()).await.unwrap();
    port.put_objects(
        &ctx(),
        "test-environment",
        vec![OwnedObject {
            id: "env-1".into(),
            scope: String::new(),
            payload: json!({"namespace": "dev"}),
        }],
    )
    .await
    .unwrap();
    let (rows, _) = port
        .query(&ctx(), json!({"type": "test-environment"}))
        .await
        .unwrap();
    let id = rows[0].instance_id.clone();
    (service, port, id)
}

fn set(field: &str, value: Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(field.into(), value);
    m
}

#[tokio::test]
async fn an_added_field_is_filled_in_by_people_and_kept_by_the_gears_next_write() {
    let (service, port, id) = rig().await;
    service
        .add_field(
            &ctx(),
            "test-environment",
            FieldSpec {
                name: "owner".into(),
                type_name: "string?".into(),
                description: None,
                required: false,
            },
        )
        .await
        .unwrap();
    service
        .patch_object(
            &ctx(),
            &id,
            set("owner", json!("Ann")),
            &[],
            ValidateMode::Warn,
        )
        .await
        .unwrap();

    // The gear writes its record again, knowing nothing of `owner`.
    port.put_objects(
        &ctx(),
        "test-environment",
        vec![OwnedObject {
            id: "env-1".into(),
            scope: String::new(),
            payload: json!({"namespace": "prod"}),
        }],
    )
    .await
    .unwrap();
    let (rows, _) = port
        .query(&ctx(), json!({"type": "test-environment"}))
        .await
        .unwrap();
    assert_eq!(rows[0].payload["namespace"], "prod");
    assert_eq!(
        rows[0].payload["owner"], "Ann",
        "the person's value survives"
    );
}

#[tokio::test]
async fn the_gears_own_fields_are_not_changed_from_outside() {
    let (service, _, id) = rig().await;
    let e = service
        .patch_object(
            &ctx(),
            &id,
            set("namespace", json!("x")),
            &[],
            ValidateMode::Warn,
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("kept by studio-test"), "{e}");

    let e = service
        .remove_field(&ctx(), "test-environment", "namespace")
        .await
        .unwrap_err();
    assert!(e.to_string().contains("written by studio-test"), "{e}");
    let e = service
        .edit_field(
            &ctx(),
            "test-environment",
            "namespace",
            FieldEdit {
                rename_to: Some("ns".into()),
                ..FieldEdit::default()
            },
            true,
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("written by studio-test"), "{e}");
}

#[tokio::test]
async fn a_revert_never_takes_a_gears_type_away() {
    let (service, port, _) = rig().await;
    let revisions = service.revisions(&ctx()).await.unwrap();
    let created = revisions
        .iter()
        .filter(|r| r.target == "test-environment")
        .map(|r| r.version)
        .min()
        .expect("the gear's type was recorded");
    service.revert(&ctx(), created - 1).await.unwrap();

    let (rows, _) = port
        .query(
            &ctx(),
            json!({"type": "test-environment", "where": {"namespace": {"_eq": "dev"}}}),
        )
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "the type, its field and its records are still there"
    );
    let e = service
        .remove_field(&ctx(), "test-environment", "namespace")
        .await
        .unwrap_err();
    assert!(
        e.to_string().contains("written by studio-test"),
        "still held: {e}"
    );
}
