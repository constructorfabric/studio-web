//! studio-credstore-pg — a credstore value-store plugin that survives a restart.
//!
//! ## Why this gear exists (issue #66)
//!
//! credstore splits a secret in two: the metadata row lives in its own
//! Postgres database, the value lives in whatever backend plugin is selected.
//! The only plugin shipped with CF/Gears is `static-credstore-plugin`, whose
//! backend is a `HashMap` seeded from YAML. So every `docker compose restart
//! backend` left the metadata intact and the values gone: `get` fails closed on
//! the value fingerprint fence and answers `Ok(None)`, and any token a user had
//! typed into the portal — source PATs (`studio-repo-*`, `studio-root-*`),
//! connector tokens (`studio-connection-*`) — was unrecoverable, because unlike
//! `openai-key` / `anthropic-key` there is no environment variable to re-seed
//! it from. This gear makes the value store a table.
//!
//! ## One plugin wins, so this one replaces the static one
//!
//! `credstore` resolves its backend through
//! `toolkit::plugins::choose_plugin_instance`, which filters instances by
//! `vendor` and returns the single one with the lowest `priority`. There is no
//! chain and no fallback: at `priority: 50` this gear displaces
//! `static-credstore-plugin` (100) outright, and its config-seeded secrets stop
//! being reachable. That costs nothing in the Studio profiles, where those
//! entries are already empty and the values arrive from the environment via
//! `studio-secrets-bootstrap` on every boot.
//!
//! The one intentional escape hatch is the key: with no `STUDIO_CREDSTORE_KEY`
//! this gear logs a WARN and does not register at all, so the static plugin
//! wins again and the deployment behaves exactly as it did before #66. A key
//! that is present but malformed fails the boot instead — a silent downgrade
//! there would only be discovered as lost secrets after the next restart.
//!
//! ## Why it is a `system` gear
//!
//! `GtsPluginSelector` memoises the *successful* resolution for the lifetime of
//! the process. If a feature gear (`mini-chat` provisioning its OAGW upstream
//! at init, say) touched a secret before this plugin had published its instance
//! to the types-registry, credstore would latch onto the static plugin forever
//! and this whole gear would silently do nothing. System gears initialize
//! before every non-system gear, which closes that window by construction
//! rather than by luck of initialization order.
//!
//! ## Storage
//!
//! One table, `studio_credstore_values`, in its own database — values and
//! metadata deliberately do not share one. Each value is sealed with
//! AES-256-GCM under a deployment key from the environment, with the key class
//! (`tenant | reference | owner`) as associated data. That mirrors credstore's
//! own split-knowledge stance: the fingerprints live in the credstore DB, the
//! values here, and the key in neither.
//!
//! A bonus falls out of persistence: credstore keeps its fence key in the value
//! store too (`cfs-internal-fence-key`, nil tenant). Once the store is durable
//! the fence key stops being regenerated on every boot, which is what made
//! surviving metadata rows read as poisoned in the first place.

mod config;
mod crypto;
mod entity;
mod migrations;
mod store;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use credstore_sdk::{CredStorePluginClientV1, CredStorePluginSpecV1};
use toolkit::client_hub::ClientScope;
use toolkit::context::GearCtx;
use toolkit::contracts::{DatabaseCapability, SystemCapability};
use toolkit::gts::PluginV1;
use toolkit_db::DBProvider;
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use config::PgCredStorePluginConfig;
use crypto::ValueCipher;
use store::PgValueStore;

/// GTS instance segment for this plugin, alongside the upstream
/// `cf.core._.static_credstore.v1`.
pub(crate) const INSTANCE_SEGMENT: &str = "cf.studio._.pg_credstore.v1";

/// Persistent credstore value-store plugin gear.
#[toolkit::gear(
    name = "studio-credstore-pg",
    deps = [types_registry],
    capabilities = [system, db]
)]
#[derive(Default)]
pub struct StudioCredStorePgPlugin {
    store: OnceLock<Arc<PgValueStore>>,
}

#[async_trait]
impl toolkit::Gear for StudioCredStorePgPlugin {
    #[tracing::instrument(skip_all, fields(module = "studio-credstore-pg"))]
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: PgCredStorePluginConfig = ctx.config_or_default()?;

        // Absent key: stand down and let static-credstore-plugin win, rather
        // than failing a boot over a feature the operator may not have
        // configured yet. Same shape as keycloak-idp-plugin without a
        // client_secret.
        let Some(raw_key) = std::env::var(&cfg.key_env)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        else {
            warn!(
                env = %cfg.key_env,
                "studio-credstore-pg: {} is unset — plugin NOT registered. credstore falls back \
                 to static-credstore-plugin, so secret VALUES will not survive a restart \
                 (issue #66). Generate one with: openssl rand -base64 32",
                cfg.key_env
            );
            return Ok(());
        };

        // Present but malformed is an operator typo, and degrading quietly here
        // would hide it until the next restart ate somebody's PAT.
        let cipher = ValueCipher::from_encoded(&raw_key).map_err(|e| {
            anyhow::anyhow!(
                "studio-credstore-pg: {} must be a base64-encoded 32-byte key: {e}",
                cfg.key_env
            )
        })?;

        let db_raw = ctx.db_required().map_err(|e| {
            anyhow::anyhow!(
                "studio-credstore-pg needs its own database — add a `database:` section \
                 (server + dbname) to the studio-credstore-pg gear config: {e}"
            )
        })?;
        let db = Arc::new(DBProvider::<anyhow::Error>::new(db_raw.db()));
        let store = Arc::new(PgValueStore::new(db, cipher));

        let (instance_id, instance_json) = PluginV1::<CredStorePluginSpecV1>::build_registration(
            INSTANCE_SEGMENT,
            cfg.vendor.clone(),
            cfg.priority,
        )?;

        // Fail the boot if the instance cannot be published: unlike an optional
        // driver plugin, a value store that is configured but unreachable would
        // present as "all secrets silently missing".
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(vec![instance_json]).await?;
        RegisterResult::ensure_all_ok(&results)?;

        // All fallible steps are done — commit the shared state, then publish.
        self.store
            .set(Arc::clone(&store))
            .map_err(|_| anyhow::anyhow!("{} gear already initialized", Self::MODULE_NAME))?;

        let api: Arc<dyn CredStorePluginClientV1> = store;
        ctx.client_hub()
            .register_scoped::<dyn CredStorePluginClientV1>(ClientScope::gts_id(&instance_id), api);

        info!(
            instance_id = %instance_id,
            vendor = %cfg.vendor,
            priority = cfg.priority,
            "studio-credstore-pg: persistent credstore value store registered — \
             secret values now survive a restart"
        );
        Ok(())
    }
}

// Empty system capability: no pre/post-init work is needed, only the
// system-priority init ordering (see the module docs).
impl SystemCapability for StudioCredStorePgPlugin {}

impl DatabaseCapability for StudioCredStorePgPlugin {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}
