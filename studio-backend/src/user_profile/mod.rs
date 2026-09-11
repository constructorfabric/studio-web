//! studio-user — the canonical user, its sign-in methods, memberships and the
//! identity mapper.
//!
//! Keycloak authenticates; this gear owns *who the person is*: a Studio-owned
//! `user` record (the profile, role-free) to which sign-in methods (`login`),
//! organization memberships (`membership`, role per org) and non-login
//! identifiers (`alias`) bind, and the mapper that turns a token subject into a
//! stable user id. Storage is the gear's own relational database (SeaORM) — the
//! records are looked up and constrained, not traversed; a graph projection for
//! visualization/path-finding is a later, derived concern (ADR-0006).
//!
//! No database configured → the gear stands down (routes answer 503) rather
//! than failing a boot, mirroring studio-credstore-pg.

mod alias_policy;
mod entity;
mod invitations;
mod leaving;
mod migrations;
mod rest;
mod service;
mod store;

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use toolkit_db::DBProvider;
use toolkit_security::SecurityContext;
use tracing::{info, warn};

use serde::Deserialize;

use service::IdentityService;

/// What the installation states about itself.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StudioUserConfig {
    /// The sign-in subjects that are platform administrators here.
    ///
    /// ADR-0011 §4: the first administrator is a deliberately provisioned
    /// identity, not the first person to open the portal. Each one named here
    /// gets a membership of the platform root at every start, which is what
    /// being a platform administrator *is* after ADR-0018 §3.
    #[serde(default)]
    pub platform_admins: Vec<String>,

    /// What a person gets the first time they are seen, if anything.
    ///
    /// Absent in the cloud: people arrive with no organization and create one.
    /// Set in an installation inside one company, where the deployment is
    /// stating *the users of this identity provider are the members of this
    /// organization* (ADR-0018 §4).
    ///
    /// That statement is recorded as a membership row, which is not the same as
    /// deriving access from authentication: a row can be revoked — suspending
    /// somebody in Studio without removing them from the corporate directory —
    /// and it records how it came about. Access that followed the token could do
    /// neither.
    #[serde(default)]
    pub on_first_login: Option<FirstLoginJoin>,
}

/// The organization a new person joins, and as what.
#[derive(Debug, Clone, Deserialize)]
pub struct FirstLoginJoin {
    #[serde(with = "uuid_text")]
    pub organization: uuid::Uuid,
    /// `member` unless the installation says otherwise. Never `owner`:
    /// ownership is not something a deployment hands to everybody who signs in.
    #[serde(default = "default_join_role")]
    pub role: String,
}

fn default_join_role() -> String {
    "member".to_owned()
}

/// A uuid written as a string in YAML.
mod uuid_text {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<uuid::Uuid, D::Error> {
        let raw = String::deserialize(d)?;
        raw.parse().map_err(serde::de::Error::custom)
    }
}

/// Fold an alias key into its stored form. Re-exported because the
/// knowledge-graph sync must normalize a login the same way a write did,
/// or the lookup misses the row.
pub use service::normalize_key;

/// ClientHub key under which the alias resolver is published for other gears.
///
/// Not a plugin: nothing selects between implementations, so unlike
/// `studio-credstore-pg` this is not published to the types-registry — the id is
/// the hub's scope key and nothing more.
pub const IDENTITY_INSTANCE_ID: &str = "cf.studio._.user_identity.v1~";

/// Read-only alias resolution for other gears in this assembly.
///
/// Deliberately narrow: a consumer may ask who a confirmed external identity
/// belongs to and nothing else. Writing an attribution is a self-service act
/// that needs the person's own `SecurityContext`, so it has no place on a
/// gear-to-gear interface.
#[async_trait]
pub trait AliasResolver: Send + Sync + 'static {
    /// Confirmed owners of `external_ids` for one `kind`, keyed by identifier.
    ///
    /// Identifiers with no confirmed alias are absent from the map; read that as
    /// "nobody has proven this one". Claims and suggestions are never returned:
    /// they attribute nothing, so a consumer must not be able to mistake one for
    /// an attribution (ADR-0012).
    async fn confirmed_owners(
        &self,
        kind: &str,
        external_ids: &[String],
    ) -> anyhow::Result<BTreeMap<String, String>>;
}

#[async_trait]
impl AliasResolver for IdentityService {
    async fn confirmed_owners(
        &self,
        kind: &str,
        external_ids: &[String],
    ) -> anyhow::Result<BTreeMap<String, String>> {
        self.confirmed_alias_owners(kind, external_ids).await
    }
}

/// Turn the caller of a request into the canonical person behind them.
///
/// The one interface a Studio gear uses to answer "whose is this?" (ADR-0014).
/// Before it existed, every gear that needed to record an actor reached for
/// `ctx.subject_id()` — the *sign-in method*, not the person — so a human with
/// two logins was two actors, and anything keyed that way (a personal
/// connection's `created_by`, a document's author) stopped being theirs the
/// moment they signed in the other way.
///
/// Takes a `SecurityContext` rather than a subject string on purpose: a gear can
/// resolve **its own caller** and nobody else, so this cannot become a way to
/// look up arbitrary people. Reading somebody else's records is a platform
/// action and lives on the REST surface, behind its own authority gate.
#[async_trait]
pub trait PersonResolver: Send + Sync + 'static {
    /// The caller's canonical user id, provisioning a person the first time this
    /// sign-in method is seen.
    ///
    /// Provisioning is safe here because the subject comes off a bearer the
    /// platform has already authenticated — this is the same act `/me` performs,
    /// made available to every gear instead of only to the profile screen.
    async fn resolve_caller(&self, ctx: &SecurityContext) -> anyhow::Result<String>;

    /// The person behind a sign-in method already recorded somewhere, or `None`
    /// when no login knows it.
    ///
    /// The migration seam: a column that stores a token subject (`created_by`,
    /// `requested_by`, an author id) can be read *as a person* through this
    /// without being rewritten. Never provisions — nobody has authenticated a
    /// subject read out of storage.
    async fn resolve_recorded_subject(&self, subject: &str) -> anyhow::Result<Option<String>>;
}

#[async_trait]
impl PersonResolver for IdentityService {
    async fn resolve_caller(&self, ctx: &SecurityContext) -> anyhow::Result<String> {
        IdentityService::resolve_caller(self, ctx).await
    }

    async fn resolve_recorded_subject(&self, subject: &str) -> anyhow::Result<Option<String>> {
        self.resolve_subject(service::PROVIDER_KEYCLOAK, subject)
            .await
    }
}

/// Record that an IdP identity belongs to an organization.
///
/// The seam ADR-0006 follow-up 1 left open: the act of assigning somebody to an
/// organization happens in the IdP directory, but the membership record — the
/// thing ADR-0011 §2 makes the authority for organization access — belongs to
/// this gear. Rather than have the directory learn about person ids, it hands
/// over the subject it already has and this resolves it.
///
/// Narrow on purpose: record an assignment, and nothing else. Removing a
/// membership, changing a role and reading anybody's memberships all stay on the
/// REST surface behind their own authority gates.
#[async_trait]
pub trait AssignmentRecorder: Send + Sync + 'static {
    /// Record `subject`'s membership of `org_id` with `role`, provisioning the
    /// person if this login has not been seen before.
    async fn record_assignment(
        &self,
        subject: &str,
        org_id: uuid::Uuid,
        role: &str,
    ) -> anyhow::Result<()>;

    /// Record that `subject` created `org_id` and owns it.
    ///
    /// The role is not a parameter: creating an organization makes you its
    /// owner and nothing else, so letting a caller pass a role here would only
    /// create a way to get it wrong.
    async fn record_creation(&self, subject: &str, org_id: uuid::Uuid) -> anyhow::Result<()>;
}

#[async_trait]
impl AssignmentRecorder for IdentityService {
    async fn record_assignment(
        &self,
        subject: &str,
        org_id: uuid::Uuid,
        role: &str,
    ) -> anyhow::Result<()> {
        IdentityService::record_assignment(self, subject, org_id, role).await
    }

    async fn record_creation(&self, subject: &str, org_id: uuid::Uuid) -> anyhow::Result<()> {
        IdentityService::record_creation(self, subject, org_id).await
    }
}

/// Emptying an organization that is being deleted.
///
/// Separate from [`AssignmentRecorder`] because it is the opposite act with the
/// opposite risk: recording an assignment can be wrong and corrected, while this
/// removes every membership of an organization at once and takes credentials
/// with it. A gear asks for this one deliberately.
///
/// It does not check the last-owner rule, and that is the point: the rule keeps
/// an organization administrable, and an organization being deleted has nothing
/// left to administer. The authority to delete is checked where deletion is
/// decided — this is the consequence, not the decision.
#[async_trait]
pub trait MembershipEvictor: Send + Sync + 'static {
    /// End every membership of `org_id`, removing each person's personal
    /// connections in it as they go.
    async fn evict_everybody(
        &self,
        ctx: &SecurityContext,
        org_id: uuid::Uuid,
    ) -> anyhow::Result<service::Eviction>;
}

#[async_trait]
impl MembershipEvictor for IdentityService {
    async fn evict_everybody(
        &self,
        ctx: &SecurityContext,
        org_id: uuid::Uuid,
    ) -> anyhow::Result<service::Eviction> {
        IdentityService::evict_everybody(self, ctx, org_id).await
    }
}

/// The organizations a sign-in method's person belongs to.
///
/// Published for the Studio PDP, which has a token subject and needs to know
/// what that person may reach. Deliberately not `PersonResolver`: that one
/// provisions, and an authorization decision must not create a person as a side
/// effect of somebody knocking.
///
/// Read-only and one subject at a time, like every other interface this gear
/// publishes.
#[async_trait]
pub trait OrganizationReader: Send + Sync + 'static {
    /// The organizations the person behind `subject` is a member of. A subject
    /// no login knows has none.
    async fn organizations_of(&self, subject: &str) -> anyhow::Result<Vec<uuid::Uuid>>;

    /// Does this subject's person hold a membership of the platform root?
    ///
    /// One spelling of the rule, so a gear deciding whether somebody is a
    /// platform administrator cannot drift from the gear that records it.
    async fn is_platform_admin(&self, subject: &str) -> anyhow::Result<bool>;

    /// Changes whenever any membership is written anywhere.
    ///
    /// A caller that caches an answer from `organizations_of` keeps this beside
    /// it and throws the answer away when it moves. Without it a cache outlives
    /// the write that invalidates it — which is how a person briefly could not
    /// finish creating their own organization.
    fn membership_generation(&self) -> u64;
}

#[async_trait]
impl OrganizationReader for IdentityService {
    async fn organizations_of(&self, subject: &str) -> anyhow::Result<Vec<uuid::Uuid>> {
        IdentityService::organizations_of(self, subject).await
    }

    async fn is_platform_admin(&self, subject: &str) -> anyhow::Result<bool> {
        IdentityService::is_platform_admin(self, subject).await
    }

    fn membership_generation(&self) -> u64 {
        service::membership_generation()
    }
}

#[toolkit::gear(
    name = "studio-user",
    deps = [account_management],
    capabilities = [rest, db]
)]
#[derive(Default)]
pub struct StudioUserGear {
    service: OnceLock<Option<Arc<IdentityService>>>,
}

#[async_trait]
impl Gear for StudioUserGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let service = match ctx.db_required() {
            Ok(db_raw) => {
                let db = Arc::new(DBProvider::<anyhow::Error>::new(db_raw.db()));
                let store = Arc::new(store::PgStore::new(db));
                let am = ctx.client_hub().get::<dyn AccountManagementClient>()?;
                info!("studio-user: relational identity store configured");
                Some(Arc::new(IdentityService::new(store, am)))
            }
            Err(e) => {
                warn!(
                    "studio-user: no database configured — gear stands down (identity API \
                     answers 503 until a `database:` section is added): {e}"
                );
                None
            }
        };
        // Published in `init`, not in the REST phase: every gear's `init` runs
        // before any gear's `register_rest`, so a consumer resolving this in its
        // own REST phase cannot lose a race with us. Resolution needs only the
        // store, which is why it can be published this early — the confirmation
        // ceremony needs the connector catalogue and is attached later (see
        // `register_rest`).
        if let Some(svc) = service.clone() {
            let resolver: Arc<dyn AliasResolver> = svc.clone();
            ctx.client_hub().register_scoped::<dyn AliasResolver>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                resolver,
            );
            // Published under the same scope key: the hub keys an entry by
            // (interface, scope), so the two interfaces coexist and a consumer
            // asks for the narrow one it actually needs.
            let people: Arc<dyn PersonResolver> = svc.clone();
            ctx.client_hub().register_scoped::<dyn PersonResolver>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                people,
            );
            let assignments: Arc<dyn AssignmentRecorder> = svc.clone();
            ctx.client_hub().register_scoped::<dyn AssignmentRecorder>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                assignments,
            );
            let evictor: Arc<dyn MembershipEvictor> = svc.clone();
            ctx.client_hub().register_scoped::<dyn MembershipEvictor>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                evictor,
            );
            let organizations: Arc<dyn OrganizationReader> = svc;
            ctx.client_hub().register_scoped::<dyn OrganizationReader>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                organizations,
            );
        }

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-user already initialized"))?;
        Ok(())
    }
}

impl DatabaseCapability for StudioUserGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl RestApiCapability for StudioUserGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self.service.get().cloned().flatten();

        // Attached here rather than in `init`: the connector driver plugins are
        // separate gears, and the REST phase is the first point where every one
        // of them is guaranteed to have registered. Without them there is no
        // credential to confirm an identity against, and /me/aliases/confirm
        // answers 400 while claims and reads keep working.
        if let Some(svc) = service.as_ref() {
            let connectors = build_connectors(ctx);
            if connectors.is_none() {
                warn!(
                    "studio-user: no connector driver plugin registered — the credential proof \
                     channel is unavailable"
                );
            }
            svc.attach_connectors(connectors);

            // The IdP proof channel. Same phase and the same reason: the
            // directory is a separate gear. Absent when Keycloak admin is
            // unconfigured — the ceremony then runs on credentials alone, and
            // answers 400 only if neither channel is there.
            let federated = ctx
                .client_hub()
                .get_scoped::<dyn crate::identity_directory::IdpDirectoryReader>(
                    &ClientScope::gts_id(crate::identity_directory::IDP_DIRECTORY_INSTANCE_ID),
                )
                .ok();
            if federated.is_none() {
                warn!(
                    "studio-user: IdP directory not configured — brokered logins cannot confirm \
                     an identity"
                );
            }
            svc.attach_federated(federated);

            // Seeded here rather than in `init` because it writes through the
            // same path everything else does and wants the gear fully built.
            // Failing to seed is logged, not fatal: an installation that cannot
            // reach its database has a larger problem than an unseeded
            // administrator, and refusing to boot would hide it.
            let cfg = ctx
                .config_or_default::<StudioUserConfig>()
                .unwrap_or_default();
            if let Some(join) = cfg.on_first_login.as_ref() {
                if join.role == crate::access_config::ROLE_OWNER {
                    warn!(
                        "studio-user: on_first_login.role is `owner` — refusing it. Everybody who \
                         signs in would own the organization; set `member` or `admin`."
                    );
                } else {
                    info!(
                        organization = %join.organization,
                        role = %join.role,
                        "studio-user: a new person joins this organization on first sight"
                    );
                    svc.set_first_login_join(Some((join.organization, join.role.clone())));
                }
            }
            let admins = cfg.platform_admins;
            if admins.is_empty() {
                warn!(
                    "studio-user: no platform_admins configured. Being a platform administrator \
                     is a membership of the platform root now, and nothing seeds one here \
                     (ADR-0018 §3) — conflict resolution and the directory's administrative \
                     routes have nobody to answer to until such a membership exists."
                );
            }
            if !admins.is_empty() {
                let svc = svc.clone();
                tokio::spawn(async move {
                    match svc.seed_platform_admins(&admins).await {
                        Ok(n) => info!("studio-user: {n} platform administrator(s) seeded"),
                        Err(e) => warn!("studio-user: cannot seed platform administrators: {e:#}"),
                    }
                });
            }
        }

        Ok(rest::register_routes(router, openapi, service))
    }
}

/// Build a connector service for reading the caller's connection catalogue.
///
/// The same in-crate construction `studio-components-catalog` uses: the pieces
/// come from ClientHub, so this is a second view onto the same catalogue rather
/// than a second copy of its state.
fn build_connectors(ctx: &GearCtx) -> Option<Arc<crate::connectors::service::ConnectorService>> {
    use crate::connectors::driver::ConnectorDriver;
    let mut drivers: Vec<(String, Arc<dyn ConnectorDriver>)> = Vec::new();
    for id in crate::connectors::source_driver_ids() {
        if let Ok(driver) = ctx
            .client_hub()
            .get_scoped::<dyn ConnectorDriver>(&ClientScope::gts_id(id))
        {
            drivers.push((id.to_string(), driver));
        }
    }
    if drivers.is_empty() {
        return None;
    }
    let am = ctx.client_hub().get::<dyn AccountManagementClient>().ok()?;
    let credstore = ctx
        .client_hub()
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .ok()?;
    Some(crate::connectors::service::ConnectorService::new(
        am, credstore, drivers,
    ))
}
