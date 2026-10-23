//! A connection made by signing in (ADR-0049 §1), end to end through the
//! service: the two halves of the sign-in, who may finish one, and the
//! refresh token a provider rotates on use.
//!
//! The identity provider is a driver that answers like one; credstore keeps
//! private secrets per caller, as the real one does, because "only the person
//! who started it can finish it" rests on exactly that.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::Mutex;

use account_management_sdk::{
    CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials, IdpServiceAccountSummary,
    IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant, UpdateTenantRequest,
};
use async_trait::async_trait;
use credstore_sdk::{CredStoreError, GetSecretResponse, TenantId, WriteOptions};
use serde_json::Value;
use time::OffsetDateTime;
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::{ODataQuery, Page};

use super::*;
use crate::connectors::driver::AccessToken;
use crate::connectors::oauth::{Pkce, Tokens};

const ORG: Uuid = Uuid::from_u128(0x0a);

fn person(n: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(n))
        .subject_type("user")
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

/* ── An identity provider and the service behind it ── */

#[derive(Default)]
struct SignedIn {
    /// The challenge the person was sent with, by state.
    challenges: Mutex<HashMap<String, String>>,
}

#[async_trait]
impl ConnectorDriver for SignedIn {
    fn provider(&self) -> &'static str {
        "research"
    }
    fn display_name(&self) -> &'static str {
        "Constructor Research"
    }
    fn default_base_url(&self) -> &'static str {
        "https://research.example.com/integration"
    }
    fn category(&self) -> super::super::driver::ConnectorCategory {
        super::super::driver::ConnectorCategory::Compute
    }
    fn signs_in(&self) -> bool {
        true
    }
    fn sign_in_url(&self, state: &str, pkce: &Pkce) -> anyhow::Result<String> {
        self.challenges
            .lock()
            .unwrap()
            .insert(state.to_owned(), pkce.challenge.clone());
        Ok(format!(
            "https://idp.example.com/connect/authorize?state={state}"
        ))
    }
    async fn exchange_code(&self, code: &str, verifier: &str) -> anyhow::Result<Tokens> {
        // The provider checks the verifier against the challenge it was sent.
        let challenge = Pkce::from_verifier(verifier.to_owned()).challenge;
        if code != "good"
            || !self
                .challenges
                .lock()
                .unwrap()
                .values()
                .any(|c| *c == challenge)
        {
            return Err(anyhow!("the identity provider refused: invalid_grant"));
        }
        Ok(Tokens {
            access_token: "at-rt-1".into(),
            refresh_token: Some("rt-1".into()),
            expires_in: Some(300),
        })
    }
    async fn access_token(&self, stored: &str) -> anyhow::Result<AccessToken> {
        // Rotates on every use, as IdentityServer does by default.
        let next = format!("{stored}+");
        Ok(AccessToken {
            token: format!("at-{stored}"),
            rotated: Some(next),
        })
    }
    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        if !auth.token.starts_with("at-") {
            return Err(anyhow!(
                "Constructor Research did not accept the sign-in (401)"
            ));
        }
        Ok(DriverIdentity {
            account: "research-user-7".into(),
            display_name: Some("Ada".into()),
        })
    }
}

/* ── credstore: private secrets are their creator's alone ── */

/// One stored secret: its creator, its sharing, its value.
type Row = (String, SharingMode, Vec<u8>);

#[derive(Default)]
struct Secrets {
    /// By reference.
    rows: Mutex<HashMap<String, Row>>,
}

impl Secrets {
    fn value(&self, key: &str) -> Option<String> {
        self.rows
            .lock()
            .unwrap()
            .get(key)
            .map(|(_, _, v)| String::from_utf8(v.clone()).unwrap())
    }

    fn keys(&self) -> Vec<String> {
        self.rows.lock().unwrap().keys().cloned().collect()
    }

    fn edit(&self, key: &str, f: impl FnOnce(&mut Vec<u8>)) {
        f(&mut self.rows.lock().unwrap().get_mut(key).unwrap().2);
    }
}

fn readable(row: &Row, ctx: &SecurityContext) -> bool {
    row.1 != SharingMode::Private || row.0 == ctx.subject_id().to_string()
}

#[async_trait]
impl CredStoreClientV1 for Secrets {
    async fn get(
        &self,
        ctx: &SecurityContext,
        key: &SecretRef,
    ) -> Result<Option<GetSecretResponse>, CredStoreError> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .get(key.as_ref())
            .filter(|row| readable(row, ctx))
            .map(|(_, sharing, v)| GetSecretResponse {
                value: SecretValue::new(v.clone()),
                id: Uuid::nil(),
                owner_tenant_id: TenantId(ORG),
                sharing: *sharing,
                is_inherited: false,
                version: 1,
                secret_type: String::new(),
                expires_at: None,
            }))
    }

    async fn put_opts(
        &self,
        ctx: &SecurityContext,
        key: &SecretRef,
        value: SecretValue,
        _sharing: SharingMode,
        _precondition: WritePrecondition,
        _opts: WriteOptions,
    ) -> Result<(), CredStoreError> {
        let mut rows = self.rows.lock().unwrap();
        match rows.get_mut(key.as_ref()).filter(|row| readable(row, ctx)) {
            Some(row) => {
                row.2 = value.as_bytes().to_vec();
                Ok(())
            }
            None => Err(CredStoreError::internal("no such secret")),
        }
    }

    async fn create_opts(
        &self,
        ctx: &SecurityContext,
        key: &SecretRef,
        value: SecretValue,
        sharing: SharingMode,
        _opts: WriteOptions,
    ) -> Result<(), CredStoreError> {
        self.rows.lock().unwrap().insert(
            key.as_ref().to_owned(),
            (
                ctx.subject_id().to_string(),
                sharing,
                value.as_bytes().to_vec(),
            ),
        );
        Ok(())
    }

    async fn delete(
        &self,
        ctx: &SecurityContext,
        key: &SecretRef,
        _precondition: WritePrecondition,
    ) -> Result<(), CredStoreError> {
        let mut rows = self.rows.lock().unwrap();
        if rows.get(key.as_ref()).is_some_and(|row| readable(row, ctx)) {
            rows.remove(key.as_ref());
        }
        Ok(())
    }
}

/* ── account-management: one catalogue document per tenant ── */

#[derive(Default)]
struct Catalogues {
    docs: Mutex<HashMap<Uuid, Value>>,
}

fn entry(value: Value) -> MetadataEntry {
    MetadataEntry::new(
        GtsTypeId::new(CONNECTIONS_METADATA_TYPE),
        value,
        OffsetDateTime::now_utc(),
        1,
    )
}

#[async_trait]
impl AccountManagementClient for Catalogues {
    async fn create_tenant(
        &self,
        _: &SecurityContext,
        _: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn get_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
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
            .ok_or_else(|| CanonicalError::internal("no catalogue").create())
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
        self.docs
            .lock()
            .unwrap()
            .insert(tenant, request.value.clone());
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

struct World {
    svc: Arc<ConnectorService>,
    secrets: Arc<Secrets>,
}

fn world() -> World {
    let secrets = Arc::new(Secrets::default());
    let driver: Arc<dyn ConnectorDriver> = Arc::new(SignedIn::default());
    let svc = ConnectorService::new(
        Arc::new(Catalogues::default()),
        secrets.clone(),
        vec![("research-instance".into(), driver)],
    );
    World { svc, secrets }
}

fn sign_in() -> NewSignIn<'static> {
    NewSignIn {
        owner_tenant: ORG,
        provider: "research",
        label: "My Research",
        base_url: None,
        scope: "personal",
    }
}

fn state_of(url: &str) -> String {
    url.split("state=").nth(1).unwrap().to_owned()
}

/* ── The tests ── */

#[tokio::test]
async fn a_sign_in_ends_as_a_personal_connection_holding_the_refresh_token() {
    let w = world();
    let ada = person(1);
    let url = w.svc.oauth_start(&ada, sign_in()).await.unwrap();
    let state = state_of(&url);

    let (c, identity) = w.svc.oauth_complete(&ada, &state, "good").await.unwrap();

    assert_eq!(c.provider, "research");
    assert_eq!(
        c.account, "research-user-7",
        "the account is whom Research says signed in"
    );
    assert_eq!(identity.display_name.as_deref(), Some("Ada"));
    assert_eq!(c.scope, "personal");
    assert_eq!(c.base_url, "https://research.example.com/integration");
    assert_eq!(w.secrets.value(&c.secret_ref).as_deref(), Some("rt-1"));
    assert_eq!(
        w.secrets.keys(),
        vec![c.secret_ref.clone()],
        "nothing of the sign-in is left behind"
    );
}

#[tokio::test]
async fn a_sign_in_is_finished_once() {
    let w = world();
    let ada = person(1);
    let state = state_of(&w.svc.oauth_start(&ada, sign_in()).await.unwrap());
    w.svc.oauth_complete(&ada, &state, "good").await.unwrap();

    let again = w
        .svc
        .oauth_complete(&ada, &state, "good")
        .await
        .unwrap_err();
    assert!(again.to_string().contains("start it again"), "{again}");
}

#[tokio::test]
async fn nobody_but_the_person_who_started_it_can_finish_it() {
    let w = world();
    let (ada, eve) = (person(1), person(2));
    let state = state_of(&w.svc.oauth_start(&ada, sign_in()).await.unwrap());

    let stolen = w
        .svc
        .oauth_complete(&eve, &state, "good")
        .await
        .unwrap_err();
    assert!(
        stolen.to_string().contains("not started by you"),
        "{stolen}"
    );
    // And it did not spend Ada's.
    w.svc.oauth_complete(&ada, &state, "good").await.unwrap();
}

#[tokio::test]
async fn a_refused_code_stores_nothing_and_spends_the_sign_in() {
    let w = world();
    let ada = person(1);
    let state = state_of(&w.svc.oauth_start(&ada, sign_in()).await.unwrap());

    let refused = w
        .svc
        .oauth_complete(&ada, &state, "forged")
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("invalid_grant"), "{refused}");
    assert!(w.secrets.keys().is_empty());
}

#[tokio::test]
async fn a_sign_in_left_too_long_has_expired() {
    let w = world();
    let ada = person(1);
    let state = state_of(&w.svc.oauth_start(&ada, sign_in()).await.unwrap());
    w.secrets.edit(&format!("studio-oauth-{state}"), |v| {
        let mut p: serde_json::Value = serde_json::from_slice(v).unwrap();
        p["started_at_epoch_secs"] = (now_secs() - SIGN_IN_TTL_SECS - 1).into();
        *v = serde_json::to_vec(&p).unwrap();
    });

    let late = w
        .svc
        .oauth_complete(&ada, &state, "good")
        .await
        .unwrap_err();
    assert!(late.to_string().contains("expired"), "{late}");
}

#[tokio::test]
async fn a_state_that_never_came_from_studio_reads_nothing() {
    let w = world();
    let made_up = w
        .svc
        .oauth_complete(&person(1), "../studio-connection-x", "good")
        .await
        .unwrap_err();
    assert!(made_up.to_string().contains("start it again"), "{made_up}");
}

#[tokio::test]
async fn a_signed_in_provider_takes_no_pasted_credential() {
    let w = world();
    let pasted = w
        .svc
        .create(
            &person(1),
            NewConnection {
                owner_tenant: ORG,
                provider: "research",
                label: "pasted",
                base_url: None,
                token: "rt-somebody-elses",
                scope: "personal",
                options: Default::default(),
            },
        )
        .await
        .unwrap_err();
    assert!(pasted.to_string().contains("signing in"), "{pasted}");
}

#[tokio::test]
async fn a_rotated_refresh_token_replaces_the_stored_one_on_use() {
    let w = world();
    let ada = person(1);
    let state = state_of(&w.svc.oauth_start(&ada, sign_in()).await.unwrap());
    let (c, _) = w.svc.oauth_complete(&ada, &state, "good").await.unwrap();

    w.svc.test(&ada, ORG, c.id).await.unwrap();
    assert_eq!(w.secrets.value(&c.secret_ref).as_deref(), Some("rt-1+"));
    w.svc.test(&ada, ORG, c.id).await.unwrap();
    assert_eq!(w.secrets.value(&c.secret_ref).as_deref(), Some("rt-1++"));
}

#[tokio::test]
async fn the_provider_list_says_which_providers_sign_in() {
    let w = world();
    let p = w
        .svc
        .providers()
        .into_iter()
        .find(|p| p.provider == "research")
        .unwrap();
    assert!(p.sign_in);
    assert_eq!(p.category, "compute");
}
