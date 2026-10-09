//! Publishing and suggestions over REST: who may mark an entry published,
//! and what the suggest route answers without studio-llm-proxy or a key.

use std::sync::Arc;

use axum::response::IntoResponse;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::registry::{EntryRecord, STATE_PUBLISHED, STATE_REGISTERED};
use crate::llm_proxy::port::{
    Completion, CompletionError, CompletionRequest, ModelInfo, ModelProviders,
};

const ORG: Uuid = Uuid::from_u128(0x0a6);
/// May decide about the registry; not a platform administrator.
const ADMIN: u128 = 7;
/// A platform administrator (who may decide about any registry too).
const PLATFORM_ADMIN: u128 = 9;

struct Authority;

#[async_trait::async_trait]
impl crate::user_profile::OrgAuthority for Authority {
    async fn may_administer(&self, ctx: &SecurityContext, _org: Uuid, privilege: &str) -> bool {
        privilege == REGISTRY_PRIVILEGE
            && [ADMIN, PLATFORM_ADMIN].contains(&ctx.subject_id().as_u128())
    }
    async fn may_dispose(&self, _ctx: &SecurityContext, _org: Uuid) -> bool {
        false
    }
}

struct Reader;

#[async_trait::async_trait]
impl crate::user_profile::OrganizationReader for Reader {
    async fn organizations_of(&self, _subject: &str) -> anyhow::Result<Vec<Uuid>> {
        Ok(vec![ORG])
    }
    async fn grant_keys_of(&self, subject: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec![subject.to_owned()])
    }
    async fn is_platform_admin(&self, subject: &str) -> anyhow::Result<bool> {
        Ok(subject == Uuid::from_u128(PLATFORM_ADMIN).to_string())
    }
    async fn memberships_of_subject(
        &self,
        _subject: &str,
    ) -> anyhow::Result<Vec<crate::user_profile::SubjectMembership>> {
        Ok(Vec::new())
    }
    fn membership_generation(&self) -> u64 {
        0
    }
}

/// A caller without a model key.
struct Keyless;

#[async_trait::async_trait]
impl ModelProviders for Keyless {
    async fn list_models(
        &self,
        _provider: &str,
        _base_url: Option<&str>,
        _key: &str,
    ) -> anyhow::Result<Vec<ModelInfo>> {
        Ok(Vec::new())
    }
    async fn complete(
        &self,
        _ctx: &SecurityContext,
        _request: &CompletionRequest,
    ) -> Result<Completion, CompletionError> {
        Err(CompletionError::NoKey("No anthropic key for you.".into()))
    }
}

fn catalog(with_model: bool) -> Catalog {
    let hub = Arc::new(ClientHub::new());
    hub.register_scoped::<dyn crate::user_profile::OrgAuthority>(
        ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
        Arc::new(Authority),
    );
    hub.register_scoped::<dyn crate::user_profile::OrganizationReader>(
        ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
        Arc::new(Reader),
    );
    if with_model {
        hub.register::<dyn ModelProviders>(Arc::new(Keyless));
    }
    let service = Arc::new(CatalogService::new(
        Arc::new(MemorySink::default()),
        "k".to_string(),
        None,
    ));
    Catalog::new(service, hub, None)
}

fn caller(id: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(id))
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

fn status(e: CanonicalError) -> StatusCode {
    e.into_response().status()
}

async fn registered(catalog: &Catalog) {
    let record = EntryRecord {
        organization_id: ORG,
        name: "ledger".into(),
        kind: "gear".into(),
        state: STATE_REGISTERED.into(),
        ..EntryRecord::default()
    };
    catalog
        .service
        .sink
        .upsert(
            &caller(ADMIN),
            &[crate::components_catalog::gts::registry_entry_node(
                &ORG.to_string(),
                "ledger",
                serde_json::to_value(&record).unwrap(),
            )],
            &[],
        )
        .await
        .unwrap();
}

fn mark(version: Option<&str>) -> RegistryDecisionRequest {
    RegistryDecisionRequest {
        action: "mark_published".into(),
        reason: None,
        owner: None,
        kind: None,
        category: None,
        capabilities: None,
        description: None,
        replaced_by: None,
        merge_into: None,
        version: version.map(str::to_owned),
        dry_run: None,
    }
}

/// studio-user's answer for the caller: a person with a name.
struct People;

#[async_trait::async_trait]
impl crate::user_profile::PersonResolver for People {
    async fn resolve_caller(&self, _ctx: &SecurityContext) -> anyhow::Result<String> {
        Ok("person-ada".into())
    }
    async fn resolve_recorded_subject(&self, _subject: &str) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
    async fn resolve_caller_named(
        &self,
        _ctx: &SecurityContext,
    ) -> anyhow::Result<(String, Option<String>)> {
        Ok(("person-ada".into(), Some("Ada Lovelace".into())))
    }
}

/// A decision shows a person, not an id: the decider's name is resolved on
/// the server and stored with the decision.
#[tokio::test]
async fn a_decision_records_who_made_it_by_name() {
    let c = catalog(false);
    c.hub
        .register_scoped::<dyn crate::user_profile::PersonResolver>(
            ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
            Arc::new(People),
        );
    registered(&c).await;
    let Json(done) = decide_registry_entry(
        OrgCtx(caller(PLATFORM_ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
        Json(mark(Some("1.0.0"))),
    )
    .await
    .unwrap();
    let decisions = done.decisions.expect("decisions");
    assert_eq!(decisions[0].by, "person-ada");
    assert_eq!(decisions[0].by_name.as_deref(), Some("Ada Lovelace"));

    // Without studio-user: the token's subject, and no name to show.
    let bare = catalog(false);
    let by = bare.decider(&caller(ADMIN)).await;
    assert_eq!(by.id, Uuid::from_u128(ADMIN).to_string());
    assert_eq!(by.name, None);
}

#[tokio::test]
async fn only_a_publish_has_a_dry_run() {
    let c = catalog(false);
    registered(&c).await;
    let mut body = mark(Some("1.0.0"));
    body.dry_run = Some(true);
    let refused = decide_registry_entry(
        OrgCtx(caller(PLATFORM_ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
        Json(body),
    )
    .await
    .unwrap_err();
    assert_eq!(status(refused), StatusCode::BAD_REQUEST);
    let still = c
        .service
        .registry_entry(&caller(ADMIN), "ledger")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still.entry.state, STATE_REGISTERED, "nothing was decided");

    // A publish's dry run needs no writer: without studio-product it is
    // refused by the rules (here: the platform has no gear repository), not
    // as unavailable.
    let mut preview = mark(None);
    preview.action = "publish".into();
    preview.dry_run = Some(true);
    let refused = decide_registry_entry(
        OrgCtx(caller(ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
        Json(preview),
    )
    .await
    .unwrap_err();
    assert_eq!(status(refused), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn only_a_platform_administrator_marks_an_entry_published() {
    let c = catalog(false);
    registered(&c).await;
    let refused = decide_registry_entry(
        OrgCtx(caller(ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
        Json(mark(Some("1.0.0"))),
    )
    .await
    .unwrap_err();
    assert_eq!(status(refused), StatusCode::FORBIDDEN);
    let still = c
        .service
        .registry_entry(&caller(ADMIN), "ledger")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still.entry.state, STATE_REGISTERED);

    let Json(done) = decide_registry_entry(
        OrgCtx(caller(PLATFORM_ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
        Json(mark(Some("1.0.0"))),
    )
    .await
    .unwrap();
    assert_eq!(done.state, STATE_PUBLISHED);
    assert_eq!(done.version.as_deref(), Some("1.0.0"));
    let decisions = done.decisions.expect("decisions");
    assert_eq!(decisions[0].action, "mark_published");
}

#[tokio::test]
async fn publishing_without_studio_product_is_unavailable() {
    let c = catalog(false);
    registered(&c).await;
    let mut body = mark(None);
    body.action = "publish".into();
    let refused = decide_registry_entry(
        OrgCtx(caller(ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
        Json(body),
    )
    .await
    .unwrap_err();
    assert_eq!(status(refused), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn the_suggest_route_needs_an_administrator_the_proxy_and_a_key() {
    let c = catalog(false);
    registered(&c).await;
    let member = suggest_registry_entry(
        OrgCtx(caller(42)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
    )
    .await
    .unwrap_err();
    assert_eq!(status(member), StatusCode::FORBIDDEN);
    let no_proxy = suggest_registry_entry(
        OrgCtx(caller(ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
    )
    .await
    .unwrap_err();
    assert_eq!(status(no_proxy), StatusCode::SERVICE_UNAVAILABLE);

    let c = catalog(true);
    registered(&c).await;
    let no_key = suggest_registry_entry(
        OrgCtx(caller(ADMIN)),
        Extension(c.clone()),
        Path("ledger".to_owned()),
    )
    .await
    .unwrap_err();
    assert_eq!(status(no_key), StatusCode::BAD_REQUEST);
    let body = format!("{:?}", no_key_problem());
    assert!(body.contains("PROVIDER_KEY_REQUIRED"), "{body}");
}

fn no_key_problem() -> CanonicalError {
    suggest_problem(SuggestFailure::NoKey("No anthropic key for you.".into()))
}
