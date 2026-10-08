//! The owner grant as a projection of membership (ADR-0040), on Postgres.
//!
//! What these guard is the seam the two past bugs came through: a grant and a
//! membership written on different keys, and a grant written by somebody other
//! than the gear that owns the membership. Account-management is an in-memory
//! document store here, because the grant's whole life is a read-modify-write
//! of one tenant-metadata document.
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
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use toolkit_odata::{ODataQuery, Page};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::migrations::Migrator;
use super::rest::UserProfileError;
use super::service::{IdentityService, LoginView};
use super::store::{IdentityStore, PgStore};

/// Account-management as far as the access config needs it: tenants that
/// exist, and one metadata document per tenant.
#[derive(Default)]
struct Documents {
    docs: Mutex<HashMap<Uuid, Value>>,
}

impl Documents {
    fn grants(&self, org: Uuid) -> Vec<Value> {
        self.docs
            .lock()
            .unwrap()
            .get(&org)
            .and_then(|d| d.get("grants").cloned())
            .and_then(|g| g.as_array().cloned())
            .unwrap_or_default()
    }

    fn put(&self, org: Uuid, doc: Value) {
        self.docs.lock().unwrap().insert(org, doc);
    }

    fn owner_keys(&self, org: Uuid) -> Vec<String> {
        self.grants(org)
            .iter()
            .filter(|g| g["roleKey"] == "owner" && g["scopeType"] == "org")
            .map(|g| g["subjectId"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn entry(value: Value) -> MetadataEntry {
    MetadataEntry::new(
        GtsTypeId::new(crate::access_config::ACCESS_METADATA_TYPE),
        value,
        OffsetDateTime::now_utc(),
        1,
    )
}

#[async_trait]
impl AccountManagementClient for Documents {
    async fn create_tenant(
        &self,
        _: &SecurityContext,
        _: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn get_tenant(&self, _: &SecurityContext, id: Uuid) -> Result<Tenant, CanonicalError> {
        let now = OffsetDateTime::now_utc();
        Ok(Tenant {
            id: TenantId(id),
            name: "Acme".to_owned(),
            status: TenantStatus::Active,
            tenant_type: None,
            parent_id: None,
            self_managed: false,
            depth: 1,
            child_count: 0,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        })
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
    async fn get_metadata(
        &self,
        _: &SecurityContext,
        tenant: Uuid,
        _: GtsTypeId,
    ) -> Result<MetadataEntry, CanonicalError> {
        self.docs
            .lock()
            .unwrap()
            .get(&tenant)
            .cloned()
            .map(entry)
            .ok_or_else(|| {
                UserProfileError::not_found("no access config")
                    .with_resource(tenant.to_string())
                    .create()
            })
    }
    async fn resolve_metadata(
        &self,
        _: &SecurityContext,
        tenant: Uuid,
        _: GtsTypeId,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        Ok(self.docs.lock().unwrap().get(&tenant).cloned().map(entry))
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
        request: UpsertMetadataRequest,
    ) -> Result<MetadataEntry, CanonicalError> {
        self.put(tenant, request.value.clone());
        Ok(entry(request.value))
    }
    async fn delete_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
}

async fn service() -> (IdentityService, Arc<PgStore>, Arc<Documents>) {
    let dsn = crate::test_pg::fresh_database("studio_user").await;
    let db = connect_db(
        &dsn,
        ConnectOpts {
            max_conns: Some(1),
            min_conns: Some(1),
            ..Default::default()
        },
    )
    .await
    .expect("connect");
    run_migrations_for_testing(&db, Migrator::migrations())
        .await
        .expect("run migrations");
    let store = Arc::new(PgStore::new(Arc::new(DBProvider::<anyhow::Error>::new(db))));
    let am = Arc::new(Documents::default());
    let service = IdentityService::new(store.clone(), am.clone());
    (service, store, am)
}

fn caller(subject: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(subject)
        .subject_type("user")
        .subject_tenant_id(Uuid::from_u128(1))
        .token_scopes(vec!["studio".into()])
        .bearer_token("t0ken".to_string())
        .build()
        .unwrap()
}

/// A person with two sign-in methods: the one that created them, and a second
/// linked afterwards. Returns the person id.
async fn person_with_two_logins(
    service: &IdentityService,
    store: &PgStore,
    first: Uuid,
    second: Uuid,
) -> String {
    let person = service
        .resolve_or_provision("keycloak", &first.to_string(), None, None, true)
        .await
        .unwrap();
    store
        .upsert_login(&LoginView {
            provider: "keycloak".to_owned(),
            subject: second.to_string(),
            user_id: person.clone(),
            verified: true,
            linked_at_epoch_ms: 2_000,
            email: None,
            email_verified: false,
        })
        .await
        .unwrap();
    person
}

#[tokio::test]
async fn a_grant_key_set_leads_with_the_person_and_keeps_every_login() {
    let (service, store, _) = service().await;
    let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
    let person = person_with_two_logins(&service, &store, first, second).await;

    let keys = service.grant_keys_of(&second.to_string()).await.unwrap();
    assert_eq!(keys[0], person, "the person is the key a grant names");
    assert!(keys.contains(&first.to_string()));
    assert!(keys.contains(&second.to_string()));

    // Nobody provisioned: the subject is its own answer, and nothing is minted.
    let stranger = Uuid::new_v4().to_string();
    assert_eq!(
        service.grant_keys_of(&stranger).await.unwrap(),
        vec![stranger.clone()]
    );
    assert!(
        service
            .resolve_subject("keycloak", &stranger)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn creating_an_organization_grants_the_person_not_the_login() {
    let (service, store, am) = service().await;
    let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
    let person = person_with_two_logins(&service, &store, first, second).await;
    let org = Uuid::new_v4();

    service
        .record_creation(&caller(first), &first.to_string(), org)
        .await
        .unwrap();

    assert_eq!(am.owner_keys(org), vec![person.clone()]);
    let membership = store.memberships_of(&person).await.unwrap();
    assert_eq!(membership.len(), 1);
    assert_eq!(membership[0].role, "owner");
    // Whichever way the creator signs in, they may dispose of it and
    // administer it: the grant is on the person.
    assert!(service.may_dispose(&caller(second), org).await);
    assert!(
        service
            .may_administer(&caller(second), org, "people.manage")
            .await
    );
    // And somebody else may not.
    assert!(!service.may_dispose(&caller(Uuid::new_v4()), org).await);
}

#[tokio::test]
async fn a_demotion_takes_the_grant_from_the_person_and_from_every_login() {
    let (service, store, am) = service().await;
    let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
    let person = person_with_two_logins(&service, &store, first, second).await;
    let org = Uuid::new_v4();
    // What the older writers left: an owner grant on each login.
    am.put(
        org,
        json!({ "model": "tenant", "roles": [], "grants": [
            { "subjectType": "member", "subjectId": first.to_string(), "roleKey": "owner", "scopeType": "org" },
            { "subjectType": "member", "subjectId": second.to_string(), "roleKey": "owner", "scopeType": "org" },
            { "subjectType": "member", "subjectId": "somebody-else", "roleKey": "owner", "scopeType": "org" },
        ]}),
    );

    // Promote: the login grants fold into one on the person.
    service
        .sync_owner_grant(&caller(first), &person, org, true)
        .await
        .unwrap();
    let mut keys = am.owner_keys(org);
    keys.sort();
    let mut expected = vec![person.clone(), "somebody-else".to_owned()];
    expected.sort();
    assert_eq!(keys, expected);

    // Demote: nothing of theirs is left; nobody else's grant is touched.
    service
        .sync_owner_grant(&caller(first), &person, org, false)
        .await
        .unwrap();
    assert_eq!(am.owner_keys(org), vec!["somebody-else".to_owned()]);
}

#[tokio::test]
async fn an_assignment_writes_the_membership_and_the_grant_in_one_call() {
    let (service, store, am) = service().await;
    let org = Uuid::new_v4();
    let subject = Uuid::new_v4();

    service
        .record_assignment(
            &caller(Uuid::new_v4()),
            &subject.to_string(),
            org,
            "owner",
            Some("Ada"),
            None,
        )
        .await
        .unwrap();
    let person = service
        .resolve_subject("keycloak", &subject.to_string())
        .await
        .unwrap()
        .expect("provisioned by the assignment");
    assert_eq!(am.owner_keys(org), vec![person.clone()]);
    assert_eq!(am.grants(org)[0]["subjectName"], "Ada");

    // Re-assigned as a member: the row and the grant agree again.
    service
        .record_assignment(
            &caller(Uuid::new_v4()),
            &subject.to_string(),
            org,
            "member",
            None,
            None,
        )
        .await
        .unwrap();
    assert!(am.owner_keys(org).is_empty());
    assert_eq!(
        store.memberships_of(&person).await.unwrap()[0].role,
        "member"
    );
}

#[tokio::test]
async fn the_platform_root_never_gets_a_grant() {
    let (service, _, am) = service().await;
    let root = super::service::PLATFORM_ROOT_TENANT_ID;
    service
        .record_assignment(
            &caller(Uuid::new_v4()),
            &Uuid::new_v4().to_string(),
            root,
            "owner",
            None,
            None,
        )
        .await
        .unwrap();
    assert!(
        am.grants(root).is_empty(),
        "a document on the root is inherited by every organization"
    );
}

#[tokio::test]
async fn the_rekey_points_login_grants_at_their_person_once() {
    let (service, store, am) = service().await;
    let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
    let person = person_with_two_logins(&service, &store, first, second).await;
    let org = Uuid::new_v4();
    service
        .record_membership(&person, &org.to_string(), "member", "manual")
        .await
        .unwrap();
    am.put(
        org,
        json!({ "model": "roles", "roles": [], "grants": [
            { "id": "a", "subjectType": "member", "subjectId": first.to_string(), "roleKey": "editor", "scopeType": "project", "scopeId": "p1" },
            { "id": "b", "subjectType": "member", "subjectId": second.to_string(), "roleKey": "editor", "scopeType": "project", "scopeId": "p1" },
            { "id": "c", "subjectType": "member", "subjectId": second.to_string(), "roleKey": "viewer", "scopeType": "org" },
            { "id": "d", "subjectType": "member", "subjectId": "nobody-knows-me", "roleKey": "viewer", "scopeType": "org" },
            { "id": "e", "subjectType": "team", "subjectId": first.to_string(), "roleKey": "viewer", "scopeType": "org" },
        ]}),
    );

    let report = service.rekey_all_grants(&caller(first)).await.unwrap();
    assert_eq!(report.organizations, 1);
    assert_eq!(report.failed, 0);
    // Three rewritten, and the two project grants became one.
    assert_eq!(report.rewritten, 4);
    let ids: Vec<(String, String)> = am
        .grants(org)
        .iter()
        .map(|g| {
            (
                g["id"].as_str().unwrap().to_owned(),
                g["subjectId"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        ids,
        vec![
            ("a".to_owned(), person.clone()),
            ("c".to_owned(), person.clone()),
            ("d".to_owned(), "nobody-knows-me".to_owned()),
            ("e".to_owned(), first.to_string()),
        ]
    );

    let again = service.rekey_all_grants(&caller(first)).await.unwrap();
    assert_eq!(again.rewritten, 0, "a second run rewrites nothing");
}

#[tokio::test]
async fn a_merge_carries_the_grants_that_named_the_merged_person() {
    let (service, store, am) = service().await;
    let from = service
        .resolve_or_provision("keycloak", &Uuid::new_v4().to_string(), None, None, true)
        .await
        .unwrap();
    let into = service
        .resolve_or_provision("keycloak", &Uuid::new_v4().to_string(), None, None, true)
        .await
        .unwrap();
    let org = Uuid::new_v4();
    service
        .record_membership(&from, &org.to_string(), "owner", "manual")
        .await
        .unwrap();
    service
        .sync_owner_grant(&caller(Uuid::new_v4()), &from, org, true)
        .await
        .unwrap();

    let result = service
        .merge_with_grants(&caller(Uuid::new_v4()), &from, &into)
        .await
        .unwrap();
    assert_eq!(result.grants_moved, 1);
    assert_eq!(am.owner_keys(org), vec![into.clone()]);
    assert_eq!(store.memberships_of(&into).await.unwrap()[0].role, "owner");
}
