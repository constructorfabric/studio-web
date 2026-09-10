//! studio-secrets-bootstrap — self-heal for config-seeded credstore secrets.
//!
//! The dev credstore value-store (static-credstore-plugin) is in-memory: its
//! values and fence key die with every backend restart, while the secret
//! METADATA lives in Postgres and survives. A restart therefore leaves
//! references like `openai-key` fence-poisoned — `GET` fails closed — and
//! consumers (mini-chat's OAGW upstream provisioning) spin on
//! `failed_precondition` until someone manually PUTs the secret with
//! `If-Match: *`.
//!
//! This gear performs that heal automatically at start: for every configured
//! `(ref, env var)` pair it checks accessibility and, when broken or missing,
//! rewrites the secret via [`WritePrecondition::Exists`] — the SDK's
//! documented healing path for fence-poisoned references (credstore ADR-0003)
//! — falling back to `create` when no metadata exists at all. Boot never
//! fails because of a seed: problems are warnings, consumers keep retrying.

use async_trait::async_trait;
use credstore_sdk::{CredStoreClientV1, SecretRef, SecretValue, SharingMode, WritePrecondition};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use toolkit::{Gear, GearCtx};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

/// One secret to ensure at boot.
#[derive(Debug, Clone, Deserialize)]
pub struct SeedSpec {
    /// credstore reference (e.g. "openai-key").
    #[serde(rename = "ref")]
    pub reference: String,
    /// Environment variable holding the value. Empty/unset = skip (warn).
    pub value_env: String,
    /// "shared" (default — cross-tenant, what LLM egress needs) | "tenant" | "private".
    #[serde(default = "default_sharing")]
    pub sharing: String,
}

fn default_sharing() -> String {
    "shared".into()
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SecretsBootstrapConfig {
    #[serde(default)]
    pub secrets: Vec<SeedSpec>,
}

/// Platform root tenant — where cross-tenant (shared) seeds live.
const ROOT_TENANT: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0001);
/// Stable synthetic subject for the bootstrap writes (shows up in audit).
const BOOTSTRAP_ACTOR: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_b007);

#[toolkit::gear(name = "studio-secrets-bootstrap", deps = [credstore], capabilities = [stateful])]
pub struct SecretsBootstrapGear {
    state: std::sync::OnceLock<(
        SecretsBootstrapConfig,
        std::sync::Arc<dyn CredStoreClientV1>,
    )>,
}

impl Default for SecretsBootstrapGear {
    fn default() -> Self {
        Self {
            state: std::sync::OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for SecretsBootstrapGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: SecretsBootstrapConfig = ctx.config_or_default()?;
        let client = ctx.client_hub().get::<dyn CredStoreClientV1>()?;
        info!(
            seeds = cfg.secrets.len(),
            "studio-secrets-bootstrap: initialized"
        );
        self.state
            .set((cfg, client))
            .map_err(|_| anyhow::anyhow!("studio-secrets-bootstrap already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RunnableCapability for SecretsBootstrapGear {
    /// Heal runs in start (all gears initialized, plugins registered) and in a
    /// spawned task so it never delays the boot sequence.
    async fn start(&self, _cancel: CancellationToken) -> anyhow::Result<()> {
        let Some((cfg, client)) = self.state.get().cloned() else {
            return Ok(());
        };
        tokio::spawn(async move {
            let sec_ctx = match SecurityContext::builder()
                .subject_id(BOOTSTRAP_ACTOR)
                .subject_type("service")
                .subject_tenant_id(ROOT_TENANT)
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    warn!("studio-secrets-bootstrap: cannot build security context: {e}");
                    return;
                }
            };
            for seed in &cfg.secrets {
                heal_seed(client.as_ref(), &sec_ctx, seed).await;
            }
        });
        Ok(())
    }

    async fn stop(&self, _deadline: CancellationToken) -> anyhow::Result<()> {
        Ok(())
    }
}

async fn heal_seed(client: &dyn CredStoreClientV1, ctx: &SecurityContext, seed: &SeedSpec) {
    let reference = seed.reference.as_str();
    let Some(value) = std::env::var(&seed.value_env)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    else {
        warn!(
            reference,
            env = %seed.value_env,
            "studio-secrets-bootstrap: env var unset/empty — secret not seeded; dependent features stay off"
        );
        return;
    };
    let sharing = match seed.sharing.as_str() {
        "private" => SharingMode::Private,
        "tenant" => SharingMode::Tenant,
        _ => SharingMode::Shared,
    };
    let key = match SecretRef::new(reference) {
        Ok(k) => k,
        Err(e) => {
            warn!(
                reference,
                "studio-secrets-bootstrap: invalid secret ref: {e}"
            );
            return;
        }
    };

    // Accessible already? Then leave it alone (the value store is re-seeded
    // from config every boot, so an accessible secret is also current).
    match client.get(ctx, &key).await {
        Ok(Some(_)) => {
            info!(
                reference,
                "studio-secrets-bootstrap: secret accessible — no heal needed"
            );
            return;
        }
        Ok(None) => {
            info!(
                reference,
                "studio-secrets-bootstrap: secret missing or fence-poisoned — healing"
            );
        }
        Err(e) => {
            warn!(
                reference,
                "studio-secrets-bootstrap: get failed ({e}) — attempting heal anyway"
            );
        }
    }

    // Heal: overwrite whatever generation holds the reference (If-Match: *);
    // when there is no metadata at all, put fails the precondition — create.
    match client
        .put(
            ctx,
            &key,
            SecretValue::new(value.clone().into_bytes()),
            sharing,
            WritePrecondition::Exists,
        )
        .await
    {
        Ok(()) => {
            info!(
                reference,
                "studio-secrets-bootstrap: healed (put If-Match:*)"
            );
            return;
        }
        Err(e) if e.is_not_found() || e.is_already_exists() => {
            // fall through to create
        }
        Err(e) => {
            warn!(reference, "studio-secrets-bootstrap: heal put failed: {e}");
            return;
        }
    }
    match client
        .create(ctx, &key, SecretValue::new(value.into_bytes()), sharing)
        .await
    {
        Ok(()) => info!(reference, "studio-secrets-bootstrap: created"),
        Err(e) => warn!(reference, "studio-secrets-bootstrap: create failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    //! What the heal decides, against a credstore that records what it was
    //! asked to do.
    //!
    //! This gear runs once at boot and writes nothing but log lines, so its
    //! behaviour is invisible until a secret is missing that should not be —
    //! and by then the boot is long over. The decisions are worth stating: an
    //! accessible secret is left alone, an inaccessible one is overwritten
    //! whatever generation holds it, and a reference with no metadata at all
    //! is created.
    //!
    //! The fake overrides `get`, `put_opts` and `create_opts` — the three the
    //! SDK leaves to an implementation; `put` and `create` route through the
    //! `_opts` pair.

    use std::sync::Mutex;

    use credstore_sdk::{CredStoreError, GetSecretResponse, TenantId, WriteOptions};

    use super::*;
    use crate::test_env::with_var_async;

    /// What the heal asked credstore to do, in order.
    #[derive(Debug, PartialEq, Eq)]
    enum Call {
        Get,
        Put(SharingMode),
        Create(SharingMode),
    }

    type GetAnswer =
        Box<dyn Fn() -> Result<Option<GetSecretResponse>, CredStoreError> + Send + Sync>;
    type PutAnswer = Box<dyn Fn() -> Result<(), CredStoreError> + Send + Sync>;

    struct FakeCredStore {
        /// What `get` answers: `Ok(None)` is the fence-poisoned or missing case.
        get: GetAnswer,
        /// What `put` answers. `Conflict` and `NotFound` are the fall-through
        /// to create.
        put: PutAnswer,
        calls: Mutex<Vec<Call>>,
    }

    impl FakeCredStore {
        fn new() -> Self {
            Self {
                get: Box::new(|| Ok(None)),
                put: Box::new(|| Ok(())),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn answering_get(
            mut self,
            f: impl Fn() -> Result<Option<GetSecretResponse>, CredStoreError> + Send + Sync + 'static,
        ) -> Self {
            self.get = Box::new(f);
            self
        }

        fn answering_put(
            mut self,
            f: impl Fn() -> Result<(), CredStoreError> + Send + Sync + 'static,
        ) -> Self {
            self.put = Box::new(f);
            self
        }

        fn calls(&self) -> Vec<Call> {
            std::mem::take(&mut *self.calls.lock().expect("calls"))
        }
    }

    #[async_trait]
    impl CredStoreClientV1 for FakeCredStore {
        async fn get(
            &self,
            _ctx: &SecurityContext,
            _key: &SecretRef,
        ) -> Result<Option<GetSecretResponse>, CredStoreError> {
            self.calls.lock().expect("calls").push(Call::Get);
            (self.get)()
        }

        async fn put_opts(
            &self,
            _ctx: &SecurityContext,
            _key: &SecretRef,
            _value: SecretValue,
            sharing: SharingMode,
            _precondition: WritePrecondition,
            _opts: WriteOptions,
        ) -> Result<(), CredStoreError> {
            self.calls.lock().expect("calls").push(Call::Put(sharing));
            (self.put)()
        }

        async fn create_opts(
            &self,
            _ctx: &SecurityContext,
            _key: &SecretRef,
            _value: SecretValue,
            sharing: SharingMode,
            _opts: WriteOptions,
        ) -> Result<(), CredStoreError> {
            self.calls
                .lock()
                .expect("calls")
                .push(Call::Create(sharing));
            Ok(())
        }
    }

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(BOOTSTRAP_ACTOR)
            .subject_type("service")
            .subject_tenant_id(ROOT_TENANT)
            .build()
            .expect("security context")
    }

    fn seed(env: &str, sharing: &str) -> SeedSpec {
        SeedSpec {
            reference: "openai-key".to_string(),
            value_env: env.to_string(),
            sharing: sharing.to_string(),
        }
    }

    /// Run the heal with the value variable set, and report what credstore saw.
    ///
    /// The variable has to stay set for as long as the future runs: the heal
    /// reads it when it runs, not when it is built.
    async fn heal_with_value(store: &FakeCredStore, spec: &SeedSpec) -> Vec<Call> {
        let ctx = ctx();
        with_var_async(&spec.value_env, "sk-live", heal_seed(store, &ctx, spec)).await;
        store.calls()
    }

    /// The value store is re-seeded from config every boot, so a secret that
    /// reads back is also current. Rewriting it would be a write for nothing.
    #[tokio::test]
    async fn an_accessible_secret_is_left_alone() {
        let store = FakeCredStore::new().answering_get(|| {
            Ok(Some(GetSecretResponse {
                value: SecretValue::new(b"already-there".to_vec()),
                id: Uuid::nil(),
                owner_tenant_id: TenantId(ROOT_TENANT),
                sharing: SharingMode::Shared,
                is_inherited: false,
                version: 1,
                secret_type: String::new(),
                expires_at: None,
            }))
        });
        let calls = heal_with_value(&store, &seed("STUDIO_TEST_SEED_ACCESSIBLE", "shared")).await;
        assert_eq!(calls, [Call::Get], "nothing should have been written");
    }

    /// The case the gear exists for: metadata survived in Postgres, the value
    /// did not, so `get` fails closed with `None` and the reference is
    /// overwritten whatever generation holds it.
    #[tokio::test]
    async fn a_fence_poisoned_secret_is_overwritten() {
        let store = FakeCredStore::new();
        let calls = heal_with_value(&store, &seed("STUDIO_TEST_SEED_POISONED", "shared")).await;
        assert_eq!(calls, [Call::Get, Call::Put(SharingMode::Shared)]);
    }

    /// No metadata at all: the put fails its precondition, and the heal falls
    /// through to a create rather than giving up.
    #[tokio::test]
    async fn a_reference_with_no_metadata_is_created() {
        for not_there in [false, true] {
            let store = FakeCredStore::new().answering_put(move || {
                Err(if not_there {
                    CredStoreError::NotFound
                } else {
                    CredStoreError::Conflict
                })
            });
            let calls = heal_with_value(&store, &seed("STUDIO_TEST_SEED_CREATE", "shared")).await;
            assert_eq!(
                calls,
                [
                    Call::Get,
                    Call::Put(SharingMode::Shared),
                    Call::Create(SharingMode::Shared),
                ]
            );
        }
    }

    /// Any other write failure stops there. Following an internal error with a
    /// create would turn one unexplained failure into two.
    #[tokio::test]
    async fn an_unexpected_write_failure_does_not_fall_through_to_create() {
        let store = FakeCredStore::new()
            .answering_put(|| Err(CredStoreError::internal("upstream is having a day")));
        let calls = heal_with_value(&store, &seed("STUDIO_TEST_SEED_FAILURE", "shared")).await;
        assert_eq!(calls, [Call::Get, Call::Put(SharingMode::Shared)]);
    }

    /// A `get` that errors is not evidence the secret is fine, so the heal
    /// proceeds — the write is idempotent and a needless one costs nothing.
    #[tokio::test]
    async fn a_failing_get_still_heals() {
        let store = FakeCredStore::new()
            .answering_get(|| Err(CredStoreError::service_unavailable("no plugin yet")));
        let calls = heal_with_value(&store, &seed("STUDIO_TEST_SEED_GET_ERR", "shared")).await;
        assert_eq!(calls, [Call::Get, Call::Put(SharingMode::Shared)]);
    }

    /// Nothing to seed with means nothing is written — not an empty secret,
    /// which would read back as a configured key and fail at the provider.
    #[tokio::test]
    async fn an_unset_variable_writes_nothing() {
        let store = FakeCredStore::new();
        heal_seed(
            &store,
            &ctx(),
            &seed("STUDIO_TEST_SEED_NEVER_SET", "shared"),
        )
        .await;
        assert!(store.calls().is_empty(), "an unset variable seeds nothing");
    }

    #[tokio::test]
    async fn a_blank_variable_writes_nothing() {
        let store = FakeCredStore::new();
        let spec = seed("STUDIO_TEST_SEED_BLANK", "shared");
        let ctx = ctx();
        with_var_async(&spec.value_env, "   ", heal_seed(&store, &ctx, &spec)).await;
        assert!(store.calls().is_empty(), "a blank variable seeds nothing");
    }

    /// `shared` is the default because cross-tenant is what LLM egress needs;
    /// anything unrecognised falls back to it rather than to the narrowest
    /// mode, which would leave the seed unreadable where it is used.
    #[tokio::test]
    async fn the_sharing_word_selects_the_mode_and_unknown_means_shared() {
        for (word, expected) in [
            ("private", SharingMode::Private),
            ("tenant", SharingMode::Tenant),
            ("shared", SharingMode::Shared),
            ("nonsense", SharingMode::Shared),
            ("", SharingMode::Shared),
        ] {
            let store = FakeCredStore::new();
            let calls = heal_with_value(&store, &seed("STUDIO_TEST_SEED_SHARING", word)).await;
            assert_eq!(
                calls,
                [Call::Get, Call::Put(expected)],
                "sharing `{word}` must select {expected:?}"
            );
        }
    }

    /// A reference the SDK refuses is a config mistake, and it must not reach
    /// credstore as a write.
    #[tokio::test]
    async fn an_invalid_reference_writes_nothing() {
        let store = FakeCredStore::new();
        let spec = SeedSpec {
            reference: String::new(),
            value_env: "STUDIO_TEST_SEED_BAD_REF".to_string(),
            sharing: "shared".to_string(),
        };
        let calls = heal_with_value(&store, &spec).await;
        assert!(calls.is_empty(), "an invalid ref must not be written");
    }
}
