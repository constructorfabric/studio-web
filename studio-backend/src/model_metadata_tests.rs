//! Tenant documents kept as domain objects: the move out of account-management,
//! versions, lists and maps, deletes, inheritance and who may write them.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    TenantId, TenantStatus, UpdateTenantRequest, UpsertMetadataRequest,
};
use async_trait::async_trait;
use gts::GtsTypeId;
use serde_json::{Value, json};
use time::OffsetDateTime;
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::{ODataQuery, Page};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{Kind, ModelMetadata, Part, not_found};
use crate::domain_model::port::{DomainObjects, in_memory};

const LIST: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.test.list.v1~";
const MAP: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.test.map.v1~";
const OTHER: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.test.other.v1~";

static KINDS: &[Kind] = &[
    Kind {
        type_id: LIST,
        gear: "studio-test",
        parts: &[Part {
            field: "items",
            entity: "test-thing",
            name: "Test Thing",
            description: "A record of a test document.",
            key: &["id"],
        }],
    },
    Kind {
        type_id: MAP,
        gear: "studio-test",
        parts: &[Part {
            field: "items",
            entity: "test-note",
            name: "Test Note",
            description: "A note keyed by name.",
            key: &[],
        }],
    },
];

/// Account-management as far as these tests need it: rows and parents.
#[derive(Default)]
struct Am {
    rows: Mutex<HashMap<(Uuid, String), (Value, i64)>>,
    parents: HashMap<Uuid, Uuid>,
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(Uuid::from_u128(1))
        .subject_type("service")
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

fn rig(am: Am) -> (ModelMetadata, Arc<Am>, Arc<dyn DomainObjects>) {
    let am = Arc::new(am);
    let port = in_memory();
    (
        ModelMetadata::with_port(Arc::clone(&am) as _, Arc::clone(&port), KINDS),
        am,
        port,
    )
}

fn upsert(type_id: &str, value: Value) -> UpsertMetadataRequest {
    UpsertMetadataRequest::new(GtsTypeId::new(type_id), value)
}

#[tokio::test]
async fn a_row_moves_once_with_its_version_and_the_model_answers_after() {
    let tenant = Uuid::new_v4();
    let am = Am::default();
    am.rows.lock().unwrap().insert(
        (tenant, LIST.to_owned()),
        (
            json!({"limit": 3, "items": [{"id": "a", "n": 1}, {"id": "b", "n": 2}]}),
            7,
        ),
    );
    let (m, am, port) = rig(am);

    let got = m
        .get_metadata(&ctx(), tenant, GtsTypeId::new(LIST))
        .await
        .unwrap();
    assert_eq!(got.version, 7);
    assert_eq!(
        got.value,
        json!({"limit": 3, "items": [{"id": "a", "n": 1}, {"id": "b", "n": 2}]})
    );

    let (things, _) = port
        .query(&ctx(), json!({"type": "test-thing"}))
        .await
        .unwrap();
    assert_eq!(things.len(), 2, "each record is an object of its own");
    assert!(
        !am.rows
            .lock()
            .unwrap()
            .contains_key(&(tenant, LIST.to_owned())),
        "the account-management copy is dropped once the model holds it"
    );

    am.rows
        .lock()
        .unwrap()
        .insert((tenant, LIST.to_owned()), (json!({"items": []}), 8));
    let again = m
        .get_metadata(&ctx(), tenant, GtsTypeId::new(LIST))
        .await
        .unwrap();
    assert_eq!(again.version, 7, "the old row is not read again");
}

#[tokio::test]
async fn a_write_is_version_checked_and_replaces_the_records() {
    let tenant = Uuid::new_v4();
    let (m, _, port) = rig(Am::default());
    let first = m
        .upsert_metadata(
            &ctx(),
            tenant,
            upsert(LIST, json!({"items": [{"id": "a"}, {"id": "b"}]})),
        )
        .await
        .unwrap();
    assert_eq!(first.version, 1);

    let stale = m
        .upsert_metadata(
            &ctx(),
            tenant,
            upsert(LIST, json!({"items": []})).with_expected_version(5),
        )
        .await
        .unwrap_err();
    assert!(matches!(stale, CanonicalError::Aborted { .. }), "{stale:?}");

    let second = m
        .upsert_metadata(
            &ctx(),
            tenant,
            upsert(
                LIST,
                json!({"items": [{"id": "b", "x": true}, {"id": "c"}]}),
            )
            .with_expected_version(1),
        )
        .await
        .unwrap();
    assert_eq!(second.version, 2);
    let got = m
        .get_metadata(&ctx(), tenant, GtsTypeId::new(LIST))
        .await
        .unwrap();
    assert_eq!(
        got.value,
        json!({"items": [{"id": "b", "x": true}, {"id": "c"}]}),
        "in order, `a` gone"
    );

    let (things, _) = port
        .query(&ctx(), json!({"type": "test-thing"}))
        .await
        .unwrap();
    assert_eq!(things.len(), 2);
}

#[tokio::test]
async fn a_version_another_writer_holds_is_refused_and_an_abandoned_one_skipped() {
    let tenant = Uuid::new_v4();
    let (m, _, port) = rig(Am::default());
    m.upsert_metadata(
        &ctx(),
        tenant,
        upsert(LIST, json!({"items": [{"id": "a"}]})),
    )
    .await
    .unwrap();
    // Another writer has just claimed version 2.
    let claim = format!("{}#v2", super::header_id(tenant, LIST));
    assert!(
        port.claim(
            &ctx(),
            "sync-state",
            &claim,
            json!({"status": "claimed", "updated_at": "2099-01-01T00:00:00Z"})
        )
        .await
        .unwrap()
    );
    let refused = m
        .upsert_metadata(&ctx(), tenant, upsert(LIST, json!({"items": []})))
        .await
        .unwrap_err();
    assert!(
        matches!(refused, CanonicalError::Aborted { .. }),
        "{refused:?}"
    );

    // It gave up: the next writer skips its version.
    port.put_objects(
        &ctx(),
        "sync-state",
        vec![crate::domain_model::port::OwnedObject {
            id: claim,
            scope: String::new(),
            payload: json!({"status": "released"}),
        }],
    )
    .await
    .unwrap();
    let written = m
        .upsert_metadata(&ctx(), tenant, upsert(LIST, json!({"items": []})))
        .await
        .unwrap();
    assert_eq!(written.version, 3);
}

#[tokio::test]
async fn a_map_keeps_its_keys() {
    let tenant = Uuid::new_v4();
    let (m, _, _) = rig(Am::default());
    let doc = json!({"items": {"core": {"text": "the core"}, "auth": {"text": "sign-in"}}});
    m.upsert_metadata(&ctx(), tenant, upsert(MAP, doc.clone()))
        .await
        .unwrap();
    let got = m
        .get_metadata(&ctx(), tenant, GtsTypeId::new(MAP))
        .await
        .unwrap();
    assert_eq!(got.value, doc);
}

#[tokio::test]
async fn a_deleted_document_stays_deleted() {
    let tenant = Uuid::new_v4();
    let am = Am::default();
    am.rows.lock().unwrap().insert(
        (tenant, LIST.to_owned()),
        (json!({"items": [{"id": "a"}]}), 1),
    );
    let (m, _, _) = rig(am);
    m.delete_metadata(&ctx(), tenant, GtsTypeId::new(LIST))
        .await
        .unwrap();
    let gone = m
        .get_metadata(&ctx(), tenant, GtsTypeId::new(LIST))
        .await
        .unwrap_err();
    assert!(matches!(gone, CanonicalError::NotFound { .. }), "{gone:?}");
}

#[tokio::test]
async fn resolving_walks_up_to_the_nearest_ancestor_that_has_one() {
    let org = Uuid::new_v4();
    let workspace = Uuid::new_v4();
    let mut am = Am::default();
    am.parents.insert(workspace, org);
    let (m, _, _) = rig(am);
    m.upsert_metadata(
        &ctx(),
        org,
        upsert(LIST, json!({"items": [{"id": "inherited"}]})),
    )
    .await
    .unwrap();
    let got = m
        .resolve_metadata(&ctx(), workspace, GtsTypeId::new(LIST))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.value["items"][0]["id"], "inherited");
}

#[tokio::test]
async fn other_rows_stay_with_account_management() {
    let tenant = Uuid::new_v4();
    let (m, am, _) = rig(Am::default());
    m.upsert_metadata(&ctx(), tenant, upsert(OTHER, json!({"a": 1})))
        .await
        .unwrap();
    assert!(
        am.rows
            .lock()
            .unwrap()
            .contains_key(&(tenant, OTHER.to_owned()))
    );
}

#[tokio::test]
async fn the_records_are_the_gears_and_refused_to_the_generic_writes() {
    let tenant = Uuid::new_v4();
    let (m, _, port) = rig(Am::default());
    m.upsert_metadata(
        &ctx(),
        tenant,
        upsert(LIST, json!({"items": [{"id": "a"}]})),
    )
    .await
    .unwrap();
    let refused = port
        .upsert(&ctx(), "test-thing", "forged", json!({"id": "forged"}))
        .await
        .unwrap_err();
    assert!(
        refused.to_string().contains("kept by studio-test"),
        "{refused}"
    );
}

// ── the fake ─────────────────────────────────────────────────────────────

fn tenant(id: Uuid, parent: Option<Uuid>) -> Tenant {
    let now = OffsetDateTime::now_utc();
    Tenant {
        id: TenantId(id),
        name: "t".to_owned(),
        status: TenantStatus::Active,
        tenant_type: None,
        parent_id: parent.map(TenantId),
        self_managed: false,
        depth: 1,
        child_count: 0,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    }
}

#[async_trait]
impl AccountManagementClient for Am {
    async fn get_metadata(
        &self,
        _: &SecurityContext,
        tenant: Uuid,
        type_id: GtsTypeId,
    ) -> Result<MetadataEntry, CanonicalError> {
        let key = (tenant, type_id.to_string());
        self.rows
            .lock()
            .unwrap()
            .get(&key)
            .map(|(v, n)| {
                MetadataEntry::new(type_id.clone(), v.clone(), OffsetDateTime::now_utc(), *n)
            })
            .ok_or_else(|| not_found(&key.1, tenant))
    }
    async fn resolve_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        unimplemented!()
    }
    async fn list_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<MetadataEntry>, CanonicalError> {
        unimplemented!()
    }
    async fn upsert_metadata(
        &self,
        _: &SecurityContext,
        tenant: Uuid,
        input: UpsertMetadataRequest,
    ) -> Result<MetadataEntry, CanonicalError> {
        let key = (tenant, input.type_id.to_string());
        let mut rows = self.rows.lock().unwrap();
        let version = rows.get(&key).map_or(0, |r| r.1) + 1;
        rows.insert(key, (input.value.clone(), version));
        Ok(MetadataEntry::new(
            input.type_id,
            input.value,
            OffsetDateTime::now_utc(),
            version,
        ))
    }
    async fn delete_metadata(
        &self,
        _: &SecurityContext,
        tenant: Uuid,
        type_id: GtsTypeId,
    ) -> Result<(), CanonicalError> {
        self.rows
            .lock()
            .unwrap()
            .remove(&(tenant, type_id.to_string()));
        Ok(())
    }
    async fn get_tenant(&self, _: &SecurityContext, id: Uuid) -> Result<Tenant, CanonicalError> {
        Ok(tenant(id, self.parents.get(&id).copied()))
    }
    async fn create_tenant(
        &self,
        _: &SecurityContext,
        _: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn list_children(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<Tenant>, CanonicalError> {
        unimplemented!()
    }
    async fn update_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: UpdateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn suspend_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn unsuspend_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn delete_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn create_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: IdpNewUser,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn get_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn list_users(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: ListUsersQuery,
    ) -> Result<Page<IdpUser>, CanonicalError> {
        unimplemented!()
    }
    async fn delete_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
    async fn update_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
        _: IdpUserPatch,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn create_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: String,
        _: Vec<String>,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn list_service_accounts(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Vec<IdpServiceAccountSummary>, CanonicalError> {
        unimplemented!()
    }
    async fn rotate_service_account_secret(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn revoke_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
}

#[tokio::test]
async fn switching_back_to_metadata_returns_the_document_and_empties_the_model() {
    let tenant = Uuid::new_v4();
    let am = Arc::new(Am::default());
    let port = in_memory();
    let model = ModelMetadata::with_port(Arc::clone(&am) as _, Arc::clone(&port), KINDS);
    model
        .upsert_metadata(
            &ctx(),
            tenant,
            upsert(LIST, json!({"limit": 2, "items": [{"id": "a"}]})),
        )
        .await
        .unwrap();
    assert!(
        !am.rows
            .lock()
            .unwrap()
            .contains_key(&(tenant, LIST.to_owned()))
    );

    let back = ModelMetadata::returning_with_port(Arc::clone(&am) as _, Arc::clone(&port), KINDS);
    let got = back
        .get_metadata(&ctx(), tenant, GtsTypeId::new(LIST))
        .await
        .unwrap();
    assert_eq!(got.value, json!({"limit": 2, "items": [{"id": "a"}]}));
    assert!(
        am.rows
            .lock()
            .unwrap()
            .contains_key(&(tenant, LIST.to_owned())),
        "account-management holds it again"
    );
    let (things, _) = port
        .query(&ctx(), json!({"type": "test-thing"}))
        .await
        .unwrap();
    assert!(things.is_empty(), "the model keeps no copy");
}
