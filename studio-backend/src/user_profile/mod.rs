//! studio-user — the canonical user, its sign-in methods, memberships and the
//! identity mapper.
//!
//! Keycloak authenticates; this gear owns *who the person is*: a Studio-owned
//! `user` record (the profile, role-free) to which sign-in methods (`login`),
//! organization memberships (`membership`, role per org) and non-login
//! identifiers (`alias`) bind, and the mapper that turns a token subject into a
//! stable user id. Storage is the gear's own relational database (SeaORM) — the
//! records are looked up and constrained, not traversed; a graph projection for
//! visualization/path-finding is a later, derived concern (ADR-0023).
//!
//! No database configured → the gear stands down (routes answer 503) rather
//! than failing a boot, mirroring studio-credstore-pg.

mod alias_policy;
mod entity;
#[cfg(test)]
mod grants_tests;
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

    /// Studio's own service identity (ADR-0030): what a shared IDE session
    /// acts as when it acts on nobody's behalf. Seeded at every start as a
    /// person with no membership, so the directory can name it and it can do
    /// nothing.
    #[serde(default)]
    pub service_account: ServiceAccount,
}

/// The subject of Studio's service identity: the fixed id of the
/// `service-account-studio-service` user in both realm files, so the backend
/// knows it without asking Keycloak.
pub const STUDIO_SERVICE_SUBJECT: &str = "00000000-0000-4000-8000-00000000057d";

/// A configured service subject, where blank means the fixed one.
///
/// The config's `${STUDIO_SERVICE_SUBJECT:-…}` does not cover it: expansion
/// treats a variable that is set but empty as a value (see `load_config`), and
/// the Helm chart sets it empty by default. On studio-dev (2026-09-28) that
/// handed every shared session `STUDIO_ACTOR_ID=`, and Theia refused to start
/// (the IDE answered "Cannot GET /").
pub fn service_subject_or_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let value = value.trim();
    Ok(if value.is_empty() {
        STUDIO_SERVICE_SUBJECT.to_owned()
    } else {
        value.to_owned()
    })
}

/// Who Studio's service identity is, as the directory shows it.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServiceAccount {
    #[serde(deserialize_with = "service_subject_or_default")]
    pub subject: String,
    pub display_name: String,
    /// The neutral git author's address too — one name for both.
    pub email: String,
}

impl Default for ServiceAccount {
    fn default() -> Self {
        Self {
            subject: STUDIO_SERVICE_SUBJECT.to_owned(),
            display_name: "Constructor Studio (service)".to_owned(),
            email: "studio@constructor.tech".to_owned(),
        }
    }
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

/// What emptying an organization took with it ([`MembershipEvictor`]).
/// Exported because the interface hands it out: a consumer names it from here,
/// never from this gear's `service` module.
pub use service::Eviction;

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

    /// The other way round: the confirmed identities of one `kind` each of
    /// `people` holds, keyed by person. A person holding none is absent.
    /// Confirmed only, for the same reason.
    async fn confirmed_identities(
        &self,
        kind: &str,
        people: &[String],
    ) -> anyhow::Result<BTreeMap<String, Vec<String>>>;
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

    async fn confirmed_identities(
        &self,
        kind: &str,
        people: &[String],
    ) -> anyhow::Result<BTreeMap<String, Vec<String>>> {
        let mut out = BTreeMap::new();
        for person in people {
            let held: Vec<String> = self
                .list_aliases(person)
                .await?
                .into_iter()
                .filter(|a| {
                    a.kind.eq_ignore_ascii_case(kind)
                        && alias_policy::Confidence::parse(&a.confidence)
                            .is_some_and(alias_policy::Confidence::attributes)
                })
                .map(|a| a.external_id)
                .collect();
            if !held.is_empty() {
                out.insert(person.clone(), held);
            }
        }
        Ok(out)
    }
}

/// Turn the caller of a request into the canonical person behind them.
///
/// The one interface a Studio gear uses to answer "whose is this?" (ADR-0025).
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
/// The seam ADR-0023 follow-up 1 left open: the act of assigning somebody to an
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
    /// person if this login has not been seen before. `display_name` and
    /// `email` are the IdP's: they name a new person and fill a profile's
    /// blanks, never overwrite it.
    ///
    /// Writes the organization's owner grant too — given to an `owner`, taken
    /// from anyone else — because the grant is a projection of the membership
    /// and this gear is its only writer (ADR-0040 §2). `ctx` is the caller's:
    /// the grant is an account-management write the PDP decides as them.
    async fn record_assignment(
        &self,
        ctx: &SecurityContext,
        subject: &str,
        org_id: uuid::Uuid,
        role: &str,
        display_name: Option<&str>,
        email: Option<&str>,
    ) -> anyhow::Result<()>;

    /// Record that `subject` created `org_id` and owns it — the membership and
    /// the owner grant, in that order.
    ///
    /// The role is not a parameter: creating an organization makes you its
    /// owner and nothing else, so letting a caller pass a role here would only
    /// create a way to get it wrong.
    async fn record_creation(
        &self,
        ctx: &SecurityContext,
        subject: &str,
        org_id: uuid::Uuid,
    ) -> anyhow::Result<()>;
}

#[async_trait]
impl AssignmentRecorder for IdentityService {
    async fn record_assignment(
        &self,
        ctx: &SecurityContext,
        subject: &str,
        org_id: uuid::Uuid,
        role: &str,
        display_name: Option<&str>,
        email: Option<&str>,
    ) -> anyhow::Result<()> {
        IdentityService::record_assignment(self, ctx, subject, org_id, role, display_name, email)
            .await
    }

    async fn record_creation(
        &self,
        ctx: &SecurityContext,
        subject: &str,
        org_id: uuid::Uuid,
    ) -> anyhow::Result<()> {
        IdentityService::record_creation(self, ctx, subject, org_id).await
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
    ) -> anyhow::Result<Eviction>;
}

#[async_trait]
impl MembershipEvictor for IdentityService {
    async fn evict_everybody(
        &self,
        ctx: &SecurityContext,
        org_id: uuid::Uuid,
    ) -> anyhow::Result<Eviction> {
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

    /// Every key a grant may name this subject's person by: the person id,
    /// then every sign-in subject of theirs, `subject` itself always included.
    ///
    /// A grant names the person (ADR-0040 §5). One written before that names
    /// the subject of whichever login was in front of whoever wrote it, and
    /// matching the caller's subject alone would answer a question about a
    /// *login* — a person with two sign-in methods holding a privilege through
    /// one and not the other. Matching against this whole set answers about
    /// the person, for grants old and new, without rewriting any of them first.
    ///
    /// A subject no login knows answers with just itself, so a caller can
    /// always match against this set alone.
    async fn grant_keys_of(&self, subject: &str) -> anyhow::Result<Vec<String>>;

    /// Does this subject's person hold a membership of the platform root?
    ///
    /// One spelling of the rule, so a gear deciding whether somebody is a
    /// platform administrator cannot drift from the gear that records it.
    async fn is_platform_admin(&self, subject: &str) -> anyhow::Result<bool>;

    /// Every membership the person behind `subject` holds, suspended ones
    /// included, for a screen that shows where somebody belongs. Unlike
    /// [`Self::organizations_of`] this decides nothing — so it answers with the
    /// standing rather than leaving the suspended out. A subject no login knows
    /// has none.
    async fn memberships_of_subject(&self, subject: &str)
    -> anyhow::Result<Vec<SubjectMembership>>;

    /// Changes whenever any membership is written anywhere.
    ///
    /// A caller that caches an answer from `organizations_of` keeps this beside
    /// it and throws the answer away when it moves. Without it a cache outlives
    /// the write that invalidates it — which is how a person briefly could not
    /// finish creating their own organization.
    fn membership_generation(&self) -> u64;
}

/// May the caller administer an organization: is one privilege theirs to use?
///
/// The administrative half of ADR-0019 §3, published so a gear other than this
/// one asks the same question the same way, rather than re-deriving it from
/// the access config and drifting from it. The answer is the platform
/// administrator arm plus [`IdentityService::may_administer`]: ownership on any
/// model, and the privilege on the roles model.
///
/// Never the PDP's to answer. On the `tenant` model its clamp admits every
/// member, which is the widening this exists to prevent.
#[async_trait]
pub trait OrgAuthority: Send + Sync + 'static {
    async fn may_administer(
        &self,
        ctx: &SecurityContext,
        org_id: uuid::Uuid,
        privilege: &str,
    ) -> bool;

    /// May the caller dispose of an organization — delete it, or hand it over?
    /// Its owner, or a platform administrator; never a privilege (ADR-0019
    /// §2). Asked here so a gear that disposes of organizations does not read
    /// the access config itself (ADR-0040 §2).
    async fn may_dispose(&self, ctx: &SecurityContext, org_id: uuid::Uuid) -> bool;
}

#[async_trait]
impl OrgAuthority for IdentityService {
    async fn may_administer(
        &self,
        ctx: &SecurityContext,
        org_id: uuid::Uuid,
        privilege: &str,
    ) -> bool {
        IdentityService::is_platform_admin(self, &ctx.subject_id().to_string())
            .await
            .unwrap_or(false)
            || IdentityService::may_administer(self, ctx, org_id, privilege).await
    }

    async fn may_dispose(&self, ctx: &SecurityContext, org_id: uuid::Uuid) -> bool {
        IdentityService::may_dispose(self, ctx, org_id).await
    }
}

#[async_trait]
impl OrganizationReader for IdentityService {
    async fn organizations_of(&self, subject: &str) -> anyhow::Result<Vec<uuid::Uuid>> {
        IdentityService::organizations_of(self, subject).await
    }

    async fn grant_keys_of(&self, subject: &str) -> anyhow::Result<Vec<String>> {
        IdentityService::grant_keys_of(self, subject).await
    }

    async fn is_platform_admin(&self, subject: &str) -> anyhow::Result<bool> {
        IdentityService::is_platform_admin(self, subject).await
    }

    async fn memberships_of_subject(
        &self,
        subject: &str,
    ) -> anyhow::Result<Vec<SubjectMembership>> {
        IdentityService::memberships_of_subject(self, subject).await
    }

    fn membership_generation(&self) -> u64 {
        service::membership_generation()
    }
}

/// One of a person's memberships, as [`OrganizationReader::memberships_of_subject`]
/// reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubjectMembership {
    pub org_id: uuid::Uuid,
    /// `owner`, `admin` or `member`.
    pub role: String,
    /// `active` or `suspended`.
    pub status: String,
}

/// One active member of an organization: the person, and every sign-in
/// subject that is theirs.
///
/// The subjects are carried because an access-config grant names a token
/// subject, not a person (`set_owner_grant`). Matching a grant against the
/// person's whole set is what makes a person with two logins one head, not
/// two, and a grant written through either login still theirs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterMember {
    pub person: String,
    pub subjects: Vec<String>,
}

/// Who is in an organization, for a gear that has to count them.
///
/// Membership is the authority for who belongs (ADR-0011 §2), and this is the
/// read of it that crosses a gear boundary. It hands out **active** members
/// only: a suspended membership grants nothing while it stands, so a headcount
/// that included it would count somebody who cannot open the project.
///
/// Deliberately not the members screen. That one returns names and emails and
/// is gated on `people.view`; this one exists for a count, and the consumer is
/// expected to reach `org_id` through its caller's tenant scope before asking
/// (the rollup does, by reading the workspace's parent as that caller).
#[async_trait]
pub trait OrganizationRoster: Send + Sync + 'static {
    /// The active members of `org_id`. An organization nobody belongs to
    /// answers with an empty list, which is a real answer; a failed read is an
    /// error, which is not.
    async fn active_members(&self, org_id: uuid::Uuid) -> anyhow::Result<Vec<RosterMember>>;
}

#[async_trait]
impl OrganizationRoster for IdentityService {
    async fn active_members(&self, org_id: uuid::Uuid) -> anyhow::Result<Vec<RosterMember>> {
        let mut out = Vec::new();
        for membership in self.members_of(&org_id.to_string()).await? {
            if membership.status != leaving::STATUS_ACTIVE {
                continue;
            }
            let subjects = self
                .list_logins(&membership.user_id)
                .await?
                .into_iter()
                .map(|login| login.subject)
                .collect();
            out.push(RosterMember {
                person: membership.user_id,
                subjects,
            });
        }
        Ok(out)
    }
}

/// A member of one organization that an external account is attributed to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttributedMember {
    /// The canonical person id.
    pub person: String,
    /// The name their profile carries, when it carries one.
    pub display_name: Option<String>,
}

/// Which accounts on a provider are people of an organization.
///
/// What a screen about work in a repository needs to say "Bob" instead of
/// `bob-gh`: the login a pull request names, read as a member. Narrower than
/// the members screen on purpose — no address, no role, and only accounts
/// whose attribution is CONFIRMED (ADR-0012); a claim or a guess names nobody.
/// An account that belongs to somebody outside `org_id`, or to a suspended
/// member, is absent, which a caller reads as "not one of ours".
///
/// The consumer is expected to have reached `org_id` through its caller's
/// tenant scope before asking, as [`OrganizationRoster`]'s does.
#[async_trait]
pub trait MemberAliases: Send + Sync + 'static {
    /// Active members of `org_id` owning `external_ids` of `kind` (a provider
    /// key such as `github`), keyed by the identifier lowercased.
    async fn members_by_alias(
        &self,
        org_id: uuid::Uuid,
        kind: &str,
        external_ids: &[String],
    ) -> anyhow::Result<BTreeMap<String, AttributedMember>>;
}

#[async_trait]
impl MemberAliases for IdentityService {
    async fn members_by_alias(
        &self,
        org_id: uuid::Uuid,
        kind: &str,
        external_ids: &[String],
    ) -> anyhow::Result<BTreeMap<String, AttributedMember>> {
        let owners = self.confirmed_alias_owners(kind, external_ids).await?;
        let org = org_id.to_string();
        // One membership and one profile read per PERSON, not per account: a
        // person with three logins on the provider is asked about once.
        let mut people: BTreeMap<String, Option<AttributedMember>> = BTreeMap::new();
        let mut out = BTreeMap::new();
        for (external_id, person) in owners {
            if !people.contains_key(&person) {
                let member = self
                    .list_memberships(&person)
                    .await?
                    .iter()
                    .any(|m| m.org_id == org && m.status == leaving::STATUS_ACTIVE);
                let found = if member {
                    Some(AttributedMember {
                        person: person.clone(),
                        display_name: self
                            .get_profile(&person)
                            .await?
                            .and_then(|p| p.display_name)
                            .filter(|n| !n.trim().is_empty()),
                    })
                } else {
                    None
                };
                people.insert(person.clone(), found);
            }
            if let Some(Some(member)) = people.get(&person) {
                out.insert(normalize_key(&external_id), member.clone());
            }
        }
        Ok(out)
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
            let organizations: Arc<dyn OrganizationReader> = svc.clone();
            ctx.client_hub().register_scoped::<dyn OrganizationReader>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                organizations,
            );
            let authority: Arc<dyn OrgAuthority> = svc.clone();
            ctx.client_hub().register_scoped::<dyn OrgAuthority>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                authority,
            );
            let roster: Arc<dyn OrganizationRoster> = svc.clone();
            ctx.client_hub().register_scoped::<dyn OrganizationRoster>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                roster,
            );
            let aliases: Arc<dyn MemberAliases> = svc;
            ctx.client_hub().register_scoped::<dyn MemberAliases>(
                ClientScope::gts_id(IDENTITY_INSTANCE_ID),
                aliases,
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
            // One entry per administrator, and an entry may carry several
            // separated by commas.
            //
            // EMPTIES ARE DROPPED BEFORE THE CHECK BELOW, and that is what
            // makes the deployment's shape work. A subject id differs between
            // installations while the config file is shared by all of them, so
            // the value arrives through an environment variable and the file
            // reads `["${STUDIO_PLATFORM_ADMINS:-}"]`. Unset, that is a list of
            // one empty string — which is nobody, and has to warn like nobody
            // rather than quietly seeding zero administrators and saying
            // nothing.
            let admins: Vec<String> = cfg
                .platform_admins
                .iter()
                .flat_map(|entry| entry.split(','))
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_owned)
                .collect();
            if admins.is_empty() {
                warn!(
                    "studio-user: no platform_admins configured. Being a platform administrator \
                     is a membership of the platform root now, and nothing seeds one here \
                     (ADR-0018 §3) — conflict resolution and the directory's administrative \
                     routes have nobody to answer to until such a membership exists."
                );
            }
            {
                let svc = svc.clone();
                let account = cfg.service_account.clone();
                tokio::spawn(async move {
                    match svc.seed_service_account(&account).await {
                        Ok(id) => {
                            info!(person = %id, subject = %account.subject, "studio-user: Studio's service identity seeded")
                        }
                        Err(e) => {
                            warn!("studio-user: cannot seed Studio's service identity: {e:#}")
                        }
                    }
                });
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
