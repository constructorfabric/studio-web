//! Postgres-backed tests for the columns and table `m0005` added.
//!
//! What they guard is the one thing a compile cannot: that the upserts every
//! sign-in and role change already run leave the new facts alone. A role
//! change that rewrote the membership row would erase how the organization
//! describes the person; a re-link that rewrote the login row would forget the
//! address the identity provider gave it.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    TenantId, TenantStatus, UpdateTenantRequest, UpsertMetadataRequest,
};
use async_trait::async_trait;
use gts::GtsTypeId;
use time::OffsetDateTime;
use toolkit_canonical_errors::CanonicalError;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use toolkit_odata::{ODataQuery, Page};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{IdentityStore, PgStore};
use crate::user_profile::migrations::Migrator;
use crate::user_profile::service::{
    AvatarRecord, DirectoryProfile, LoginView, MembershipView, UserProfile,
};
use crate::user_profile::service::{IdentityService, avatar_path};

async fn store() -> PgStore {
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
    PgStore::new(Arc::new(DBProvider::<anyhow::Error>::new(db)))
}

fn person(id: &str) -> UserProfile {
    UserProfile {
        id: id.to_owned(),
        display_name: Some("Ada".to_owned()),
        email: Some("ada@work.example".to_owned()),
        created_at_epoch_ms: 1_000,
        updated_at_epoch_ms: 1_000,
        ..UserProfile::default()
    }
}

fn membership(user_id: &str, org_id: &str, role: &str) -> MembershipView {
    MembershipView {
        user_id: user_id.to_owned(),
        org_id: org_id.to_owned(),
        role: role.to_owned(),
        status: "active".to_owned(),
        source: "manual".to_owned(),
        created_at_epoch_ms: 1_000,
        updated_at_epoch_ms: 1_000,
    }
}

fn login(user_id: &str) -> LoginView {
    LoginView {
        provider: "keycloak".to_owned(),
        subject: "subject-1".to_owned(),
        user_id: user_id.to_owned(),
        verified: true,
        linked_at_epoch_ms: 1_000,
        email: None,
        email_verified: false,
    }
}

#[tokio::test]
async fn a_role_change_keeps_how_the_organization_describes_the_member() {
    let store = store().await;
    let user = Uuid::new_v4().to_string();
    let manager = Uuid::new_v4().to_string();
    let org = Uuid::new_v4().to_string();
    store.upsert_user(&person(&user)).await.unwrap();
    store
        .upsert_membership(&membership(&user, &org, "member"))
        .await
        .unwrap();
    store
        .upsert_membership(&membership(&manager, &org, "owner"))
        .await
        .unwrap();
    let described = DirectoryProfile {
        affiliation: Some("Acronis".to_owned()),
        department: Some("Product".to_owned()),
        title: Some("Product manager".to_owned()),
        reports_to: Some(manager.clone()),
    };
    assert!(store.set_directory(&user, &org, &described).await.unwrap());

    store
        .upsert_membership(&membership(&user, &org, "admin"))
        .await
        .unwrap();

    let directory = store.directory_in_org(&org).await.unwrap();
    assert_eq!(directory.get(&user), Some(&described));
    // A member nobody described is absent rather than blank.
    assert!(!directory.contains_key(&manager));
    let roles: Vec<_> = store
        .memberships_in_org(&org)
        .await
        .unwrap()
        .into_iter()
        .filter(|m| m.user_id == user)
        .map(|m| m.role)
        .collect();
    assert_eq!(roles, vec!["admin".to_owned()]);
}

#[tokio::test]
async fn only_a_member_can_be_described() {
    let store = store().await;
    let stranger = Uuid::new_v4().to_string();
    let org = Uuid::new_v4().to_string();
    let described = DirectoryProfile {
        title: Some("Engineer".to_owned()),
        ..DirectoryProfile::default()
    };
    assert!(
        !store
            .set_directory(&stranger, &org, &described)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn a_relink_keeps_the_address_the_provider_gave_a_sign_in() {
    let store = store().await;
    let user = Uuid::new_v4().to_string();
    store.upsert_user(&person(&user)).await.unwrap();
    store.upsert_login(&login(&user)).await.unwrap();
    store
        .set_login_email("keycloak", "subject-1", Some("ada@home.example"), true)
        .await
        .unwrap();

    store.upsert_login(&login(&user)).await.unwrap();

    let logins = store.logins_of(&user).await.unwrap();
    assert_eq!(logins.len(), 1);
    assert_eq!(logins[0].email.as_deref(), Some("ada@home.example"));
    assert!(logins[0].email_verified);
}

#[tokio::test]
async fn a_sign_in_does_not_forget_when_the_person_was_last_seen() {
    let store = store().await;
    let user = Uuid::new_v4().to_string();
    store.upsert_user(&person(&user)).await.unwrap();
    assert_eq!(
        store
            .get_user(&user)
            .await
            .unwrap()
            .unwrap()
            .last_seen_at_epoch_ms,
        None
    );
    store
        .touch_last_seen(&user, 1_700_000_000_000)
        .await
        .unwrap();

    store.upsert_user(&person(&user)).await.unwrap();

    assert_eq!(
        store
            .get_user(&user)
            .await
            .unwrap()
            .unwrap()
            .last_seen_at_epoch_ms,
        Some(1_700_000_000_000)
    );
}

#[tokio::test]
async fn a_photo_is_stored_replaced_and_removed() {
    let store = store().await;
    let user = Uuid::new_v4().to_string();
    let photo = |bytes: &[u8], digest: &str| AvatarRecord {
        content_type: "image/png".to_owned(),
        bytes: bytes.to_vec(),
        digest: digest.to_owned(),
        updated_at_epoch_ms: 1_000,
    };
    assert!(store.avatar_of(&user).await.unwrap().is_none());

    store.put_avatar(&user, &photo(b"one", "d1")).await.unwrap();
    store.put_avatar(&user, &photo(b"two", "d2")).await.unwrap();

    let stored = store.avatar_of(&user).await.unwrap().unwrap();
    assert_eq!(stored.bytes, b"two");
    assert_eq!(stored.digest, "d2");
    assert!(store.delete_avatar(&user).await.unwrap());
    assert!(store.avatar_of(&user).await.unwrap().is_none());
    assert!(!store.delete_avatar(&user).await.unwrap());
}

// ── merge ────────────────────────────────────────────────────────────────

/// A merge never reaches account-management; every call here would be a bug.
struct NoAccountManagement;

#[async_trait]
impl AccountManagementClient for NoAccountManagement {
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
            name: "workspace".to_owned(),
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
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<MetadataEntry, CanonicalError> {
        unimplemented!()
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
        _: Uuid,
        _: UpsertMetadataRequest,
    ) -> Result<MetadataEntry, CanonicalError> {
        unimplemented!()
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

async fn service() -> (IdentityService, Arc<PgStore>) {
    let store = Arc::new(store().await);
    let service = IdentityService::new(store.clone(), Arc::new(NoAccountManagement));
    (service, store)
}

#[tokio::test]
async fn a_merge_carries_the_photo_and_the_description_the_target_lacks() {
    let (service, store) = service().await;
    let from = Uuid::new_v4().to_string();
    let into = Uuid::new_v4().to_string();
    let report = Uuid::new_v4().to_string();
    let org = Uuid::new_v4().to_string();
    for id in [&from, &into, &report] {
        store.upsert_user(&person(id)).await.unwrap();
        store
            .upsert_membership(&membership(id, &org, "member"))
            .await
            .unwrap();
    }
    let described = DirectoryProfile {
        title: Some("Staff engineer".to_owned()),
        ..DirectoryProfile::default()
    };
    store.set_directory(&from, &org, &described).await.unwrap();
    let reports = DirectoryProfile {
        title: Some("Engineer".to_owned()),
        reports_to: Some(from.clone()),
        ..DirectoryProfile::default()
    };
    store.set_directory(&report, &org, &reports).await.unwrap();
    let photo = AvatarRecord {
        content_type: "image/png".to_owned(),
        bytes: b"png".to_vec(),
        digest: "d".repeat(64),
        updated_at_epoch_ms: 1_000,
    };
    store.put_avatar(&from, &photo).await.unwrap();

    service.merge(&from, &into).await.unwrap();

    let directory = store.directory_in_org(&org).await.unwrap();
    assert_eq!(directory.get(&into), Some(&described));
    assert!(!directory.contains_key(&from));
    assert_eq!(
        directory.get(&report).and_then(|d| d.reports_to.clone()),
        Some(into.clone())
    );
    let target = store.get_user(&into).await.unwrap().unwrap();
    assert_eq!(target.avatar_url, Some(avatar_path(&into, &photo.digest)));
    assert_eq!(store.avatar_of(&into).await.unwrap().unwrap().bytes, b"png");
    assert!(store.avatar_of(&from).await.unwrap().is_none());
}

#[tokio::test]
async fn a_merge_keeps_what_the_target_already_has() {
    let (service, store) = service().await;
    let from = Uuid::new_v4().to_string();
    let into = Uuid::new_v4().to_string();
    let org = Uuid::new_v4().to_string();
    for id in [&from, &into] {
        store.upsert_user(&person(id)).await.unwrap();
        store
            .upsert_membership(&membership(id, &org, "member"))
            .await
            .unwrap();
    }
    let theirs = DirectoryProfile {
        title: Some("From".to_owned()),
        ..DirectoryProfile::default()
    };
    let mine = DirectoryProfile {
        title: Some("Into".to_owned()),
        ..DirectoryProfile::default()
    };
    store.set_directory(&from, &org, &theirs).await.unwrap();
    store.set_directory(&into, &org, &mine).await.unwrap();
    let photo = |digest: &str| AvatarRecord {
        content_type: "image/png".to_owned(),
        bytes: digest.as_bytes().to_vec(),
        digest: digest.to_owned(),
        updated_at_epoch_ms: 1_000,
    };
    store.put_avatar(&from, &photo("from")).await.unwrap();
    store.put_avatar(&into, &photo("into")).await.unwrap();

    service.merge(&from, &into).await.unwrap();

    assert_eq!(
        store.directory_in_org(&org).await.unwrap().get(&into),
        Some(&mine)
    );
    assert_eq!(
        store.avatar_of(&into).await.unwrap().unwrap().digest,
        "into"
    );
    assert!(store.avatar_of(&from).await.unwrap().is_none());
}

#[tokio::test]
async fn a_listing_reads_everybody_s_sign_ins_and_aliases_at_once() {
    let store = store().await;
    let ada = Uuid::new_v4().to_string();
    let max = Uuid::new_v4().to_string();
    let nobody = Uuid::new_v4().to_string();
    for id in [&ada, &max] {
        store.upsert_user(&person(id)).await.unwrap();
    }
    store.upsert_login(&login(&ada)).await.unwrap();
    let mut second = login(&max);
    second.subject = "subject-2".to_owned();
    store.upsert_login(&second).await.unwrap();

    let ids = vec![ada.clone(), max.clone(), nobody];
    let mut owners: Vec<String> = store
        .logins_of_many(&ids)
        .await
        .unwrap()
        .into_iter()
        .map(|l| l.user_id)
        .collect();
    owners.sort();
    let mut expected = vec![ada, max];
    expected.sort();
    assert_eq!(owners, expected);
    assert!(store.logins_of_many(&[]).await.unwrap().is_empty());
    assert!(store.aliases_of_many(&ids).await.unwrap().is_empty());
}
