//! Postgres-backed tests for the columns and table `m0005` added.
//!
//! What they guard is the one thing a compile cannot: that the upserts every
//! sign-in and role change already run leave the new facts alone. A role
//! change that rewrote the membership row would erase how the organization
//! describes the person; a re-link that rewrote the login row would forget the
//! address the identity provider gave it.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::{IdentityStore, PgStore};
use crate::user_profile::migrations::Migrator;
use crate::user_profile::service::{
    AvatarRecord, DirectoryProfile, LoginView, MembershipView, UserProfile,
};

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
