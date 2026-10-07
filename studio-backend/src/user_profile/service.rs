//! Identity service: the canonical user, its sign-in methods, memberships and
//! aliases, plus the mapper that turns a token subject into a stable Studio user
//! id. Storage is relational (see `store`); this layer holds the logic.
//!
//! Authority note: per-organization operations (membership) are gated on being
//! an OWNER of that organization, resolved here from Account Management's access
//! config — a platform-wide admin is not required, and one org's owner cannot
//! reach another org. Cross-org identity operations (merge) stay a narrow
//! platform action.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use account_management_sdk::AccountManagementClient;
use anyhow::{Result, anyhow};
use sha2::{Digest, Sha256};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::alias_policy::{
    Confidence, Decision, Held, ProofOwner, decide, displaced_a_proof, proof_owner,
};
use super::invitations;
use super::leaving;
use super::store::IdentityStore;
use crate::connectors::service::ConnectorService;
use crate::identity_directory::IdpDirectoryReader;

/// A connection whose scope makes it a team or bot credential rather than the
/// caller's own. `ConnectionScope::Personal` serialises as this string.
const PERSONAL_SCOPE: &str = "personal";

/// `membership.source` for a row written by the assignment path, as opposed to
/// `manual` (an operator using the REST route directly).
const SOURCE_ASSIGNMENT: &str = "assignment";

/// `membership.source` for the owner row a person gets by creating the
/// organization. The third way in, beside being assigned and being added by
/// hand — and the one an owner's member list should be able to tell apart.
const SOURCE_CREATION: &str = "creation";

/// `membership.source` for a row an accepted invitation produced. The fourth
/// and last way in, and the one an owner most wants to be able to tell apart.
const SOURCE_INVITATION: &str = "invitation";

/// What emptying an organization removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Eviction {
    pub people: usize,
    pub connections: usize,
}

/// How an acceptance names the invitation it is taking.
#[derive(Debug, Clone, Copy)]
pub enum Offered<'a> {
    /// The token from the invitation message. Proof in itself.
    Token(&'a str),
    /// The id from this person's own waiting list, which the server built by
    /// matching invitations to addresses they have proven.
    Id(&'a str),
}

/// `membership.source` for a row the installation seeded from configuration.
const SOURCE_BOOTSTRAP: &str = "bootstrap";

/// `membership.source` for a row written because somebody signed in for the
/// first time into a deployment that says its IdP's users are its members.
const SOURCE_FIRST_LOGIN: &str = "first_login";

/// The tenant every organization hangs under, and the one whose membership
/// makes somebody a platform administrator.
pub const PLATFORM_ROOT_TENANT_ID: Uuid = Uuid::from_u128(1);

/// Bumped by every write that changes who belongs where.
///
/// Consumers that cache a person's organizations — the Studio PDP does, because
/// it is asked on every request — read this to know their copy is stale. A
/// counter rather than a per-person signal on purpose: memberships change
/// rarely, the whole cache is small, and one atomic load is cheaper than
/// keeping per-subject invalidation correct.
///
/// It exists because of a bug this found: creating an organization writes the
/// membership and then the owner grant, and the grant write is authorized by a
/// clamp that had already cached "this person belongs to nothing". The creator
/// could not finish creating their own organization until the cache expired.
static MEMBERSHIP_GENERATION: AtomicU64 = AtomicU64::new(0);

/// The current membership generation. See [`MEMBERSHIP_GENERATION`].
pub fn membership_generation() -> u64 {
    MEMBERSHIP_GENERATION.load(Ordering::Acquire)
}

fn memberships_changed() {
    MEMBERSHIP_GENERATION.fetch_add(1, Ordering::AcqRel);
}

/// Provider tag for a sign-in method minted through Studio's own Keycloak
/// realm. Every bearer the platform authenticates carries a subject from there,
/// so this is the provider a caller's `login` row is found under.
pub const PROVIDER_KEYCLOAK: &str = "keycloak";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

// ── Views (the service's public currency) ────────────────────────────────────

/// The canonical user profile, role-free.
#[derive(Clone, Debug, Default)]
pub struct UserProfile {
    pub id: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
    pub created_at_epoch_ms: i64,
    pub updated_at_epoch_ms: i64,
    /// Set when this user was merged into another; reads follow it.
    pub merged_into: Option<String>,
    /// When the person last made a request, to within
    /// [`LAST_SEEN_GRANULARITY_MS`]. Written only by [`IdentityService::seen`].
    pub last_seen_at_epoch_ms: Option<i64>,
}

/// How stale a recorded "last seen" may be before a request writes it again.
/// A write per request would turn every read into a write.
pub const LAST_SEEN_GRANULARITY_MS: i64 = 5 * 60 * 1000;

/// How long what the realm said about a person is trusted before it is asked
/// again. An address changed in the identity provider shows within a day.
pub const REALM_REFRESH_MS: i64 = 24 * 60 * 60 * 1000;

/// How an organization describes one of its people. Every field is optional,
/// and none of it decides anything: it is what a members screen shows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DirectoryProfile {
    /// The company the person works for, when it is not the organization's own.
    pub affiliation: Option<String>,
    pub department: Option<String>,
    /// Job title.
    pub title: Option<String>,
    /// The person they report to, as a canonical user id.
    pub reports_to: Option<String>,
}

/// Longest directory field. A label, not a biography.
pub const MAX_DIRECTORY_FIELD: usize = 120;

/// One address a person can be reached at, and where Studio learned it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersonEmail {
    /// Lowercased.
    pub address: String,
    /// `profile` (typed by the person), `sign_in` (the identity provider's
    /// address for one of their logins) or `alias` (an attributed `email`
    /// identity).
    pub source: &'static str,
    /// Whether something other than the person vouches for it: the identity
    /// provider, or a confirmed alias.
    pub verified: bool,
    /// The address to show first: the profile's, else the first verified one.
    pub primary: bool,
}

/// A stored photo.
#[derive(Clone, Debug)]
pub struct AvatarRecord {
    pub content_type: String,
    pub bytes: Vec<u8>,
    /// SHA-256 of `bytes`, hex.
    pub digest: String,
    pub updated_at_epoch_ms: i64,
}

/// Image types a photo may be stored as. SVG is refused: it is a document
/// that can carry script, not a picture.
pub const AVATAR_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];
/// Largest photo stored. Avatars render at a few dozen pixels.
pub const MAX_AVATAR_BYTES: usize = 1024 * 1024;

/// What a person has chosen about how Studio looks to them.
///
/// A flat map of short strings, and nothing more. The portal owns the meaning
/// of every key here — `projects.view` is `table` or `tiles` and the backend
/// has no opinion on either — but it does not own the size: an unbounded bag
/// keyed by the client is a database with no schema and no migration path, and
/// it grows until somebody stores a document in it. The limits below are what
/// keeps this a preferences store.
pub type UiPreferences = std::collections::BTreeMap<String, String>;

/// At most this many remembered choices per person. Sixty-four is far more
/// screens than Studio has; a client asking for more has a bug, not a user.
pub const MAX_UI_PREFERENCES: usize = 64;
/// Longest key. Long enough for `organization.projects.view`, short enough
/// that no one mistakes it for a place to put content.
pub const MAX_UI_PREFERENCE_KEY: usize = 64;
/// Longest value. A choice, not a payload.
pub const MAX_UI_PREFERENCE_VALUE: usize = 128;

/// Why a preferences map was refused. Returned as a sentence, because it goes
/// straight to a 400 and the caller is a developer reading a log.
pub fn check_ui_preferences(prefs: &UiPreferences) -> Result<(), String> {
    if prefs.len() > MAX_UI_PREFERENCES {
        return Err(format!(
            "at most {MAX_UI_PREFERENCES} preferences, got {}",
            prefs.len()
        ));
    }
    for (key, value) in prefs {
        if key.is_empty() {
            return Err("a preference key may not be empty".to_owned());
        }
        if key.len() > MAX_UI_PREFERENCE_KEY {
            return Err(format!(
                "preference key '{key}' is longer than {MAX_UI_PREFERENCE_KEY} characters"
            ));
        }
        // A closed charset, so a key is always safe to put in a log line, a
        // URL or a CSS selector without anyone having to wonder.
        if !key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        {
            return Err(format!(
                "preference key '{key}' may use only a-z, 0-9, '.', '_' and '-'"
            ));
        }
        if value.len() > MAX_UI_PREFERENCE_VALUE {
            return Err(format!(
                "preference '{key}' is longer than {MAX_UI_PREFERENCE_VALUE} characters"
            ));
        }
    }
    Ok(())
}

/// Read a stored document back into a map.
///
/// Tolerant on purpose: a row written by a future version of this code, or by
/// a hand at the psql prompt, reads as "no preferences" rather than as a 500
/// on every page load. Losing a remembered choice is a nuisance; a profile
/// endpoint that refuses to answer is not.
pub fn parse_ui_preferences(stored: Option<&str>) -> UiPreferences {
    stored
        .and_then(|raw| serde_json::from_str::<UiPreferences>(raw).ok())
        .unwrap_or_default()
}

/// A sign-in method resolved to a user.
#[derive(Clone, Debug)]
pub struct LoginView {
    pub provider: String,
    pub subject: String,
    pub user_id: String,
    pub verified: bool,
    pub linked_at_epoch_ms: i64,
    /// The address the identity provider holds for this sign-in, as last read
    /// by [`IdentityService::refresh_from_realm`]; `None` until then.
    pub email: Option<String>,
    pub email_verified: bool,
}

/// A person's membership in one organization, carrying the role held there.
#[derive(Clone, Debug)]
pub struct MembershipView {
    pub user_id: String,
    pub org_id: String,
    pub role: String,
    /// `active` or `suspended`. A suspended membership grants nothing while it
    /// stands and is still a record of where somebody belongs (ADR-0011 §2).
    pub status: String,
    pub source: String,
    pub created_at_epoch_ms: i64,
    pub updated_at_epoch_ms: i64,
}

/// A non-login external identifier attributed to a user.
#[derive(Clone, Debug)]
pub struct AliasRecord {
    pub kind: String,
    pub external_id: String,
    pub user_id: String,
    pub confidence: String,
    pub added_at_epoch_ms: i64,
}

/// A pending membership.
///
/// `token_digest` is write-only from the service's point of view: it is set when
/// the invitation is made and compared when one is accepted, and never read back
/// out to anybody.
#[derive(Clone, Debug)]
pub struct InvitationRecord {
    pub id: String,
    pub org_id: String,
    pub email: String,
    pub role: String,
    pub token_digest: String,
    pub invited_by: String,
    pub created_at_epoch_ms: i64,
    pub expires_at_epoch_ms: i64,
    pub accepted_at_epoch_ms: Option<i64>,
}

/// A patch to a profile; `None` fields are left untouched.
#[derive(Clone, Debug, Default)]
pub struct ProfilePatch {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
}

/// Outcome of a merge.
#[derive(Clone, Copy, Debug, Default)]
pub struct MergeResult {
    pub logins_moved: usize,
    pub aliases_moved: usize,
    pub memberships_moved: usize,
}

// ── Service ──────────────────────────────────────────────────────────────────

pub struct IdentityService {
    store: Arc<dyn IdentityStore>,
    am: Arc<dyn AccountManagementClient>,
    /// Attached in the gear's REST phase, once every connector driver plugin is
    /// known to have registered. `Some(None)` means no driver at all, which
    /// makes that proof channel unavailable while claims and reads keep
    /// working; `None` means the phase has not run yet.
    connectors: OnceLock<Option<Arc<ConnectorService>>>,
    /// The IdP proof channel, attached in the same phase and for the same
    /// reason. `Some(None)` means Keycloak admin is unconfigured.
    federated: OnceLock<Option<Arc<dyn IdpDirectoryReader>>>,
    /// The organization a person joins the first time they are seen, if the
    /// installation says there is one.
    first_login_join: OnceLock<Option<(Uuid, String)>>,
    /// When each person's "last seen" was last written by this process.
    last_seen: Mutex<HashMap<String, i64>>,
    /// When this process last asked the realm about each person.
    realm_read: Mutex<HashMap<String, i64>>,
}

impl IdentityService {
    pub(crate) fn new(store: Arc<dyn IdentityStore>, am: Arc<dyn AccountManagementClient>) -> Self {
        Self {
            store,
            am,
            connectors: OnceLock::new(),
            federated: OnceLock::new(),
            first_login_join: OnceLock::new(),
            last_seen: Mutex::new(HashMap::new()),
            realm_read: Mutex::new(HashMap::new()),
        }
    }

    /// Hand the service its view of the connection catalogue.
    ///
    /// Separate from `new` because the driver plugins are separate gears and the
    /// REST phase is the first point where all of them are known to have
    /// registered. Calling it twice is ignored: the second view is equivalent.
    pub fn attach_connectors(&self, connectors: Option<Arc<ConnectorService>>) {
        let _ = self.connectors.set(connectors);
    }

    /// Tell the service which organization a new person joins, if any.
    pub fn set_first_login_join(&self, join: Option<(Uuid, String)>) {
        let _ = self.first_login_join.set(join);
    }

    /// Hand the service its view of the IdP's brokered logins.
    ///
    /// Separate from `new` for the same reason as `attach_connectors`: the
    /// directory gear is a separate gear, and the REST phase is the first point
    /// where it is known to have registered.
    pub fn attach_federated(&self, federated: Option<Arc<dyn IdpDirectoryReader>>) {
        let _ = self.federated.set(federated);
    }

    /// Every sign-in subject belonging to the same person as `subject`.
    ///
    /// One query behind the scenes and one answer in front: resolve the person
    /// the subject belongs to, then list the logins bound to them. A subject no
    /// login knows — a service account, a person not provisioned yet — is its
    /// own answer, so every caller can match against this set alone without a
    /// second code path.
    ///
    /// Never provisions. Nobody has authenticated a subject read out of a
    /// stored document, which is exactly what a grant's `subjectId` is.
    pub async fn subjects_of(&self, subject: &str) -> Result<Vec<String>> {
        let Some(person) = self.resolve_subject(PROVIDER_KEYCLOAK, subject).await? else {
            return Ok(vec![subject.to_owned()]);
        };
        let mut subjects: Vec<String> = self
            .list_logins(&person)
            .await?
            .into_iter()
            .map(|login| login.subject)
            .collect();
        // The caller's own subject is in the set whether or not a login row
        // knows it — a matcher fed this list must never be narrower than the
        // one that matched on the bare subject.
        if !subjects.iter().any(|s| s == subject) {
            subjects.push(subject.to_owned());
        }
        Ok(subjects)
    }

    /// May the caller administer `org_id` — is one privilege theirs to use?
    ///
    /// Replaces `is_org_owner`, which asked the same question with no room for
    /// an answer other than ownership. It was deleted rather than kept beside
    /// this: a second door to one rule is how the two drift, and the caller that
    /// takes the older one silently stops honouring roles.
    ///
    /// Ownership answers yes on its own, whatever the access model, which is
    /// what keeps every organization that exists behaving exactly as it does
    /// today: they are all on the `tenant` model, where this is the only arm
    /// that can fire (ADR-0019 §6).
    ///
    /// A privilege is the second arm and only opens for an organization that
    /// deliberately switched to roles. It can only ever widen — an owner never
    /// loses a route by somebody enabling the model.
    ///
    /// Deliberately not asked of the PDP. For a `tenant`-model organization the
    /// PDP answers a mapped resource with the tenant clamp, which admits every
    /// member; taking that as authority would let any member change memberships
    /// where today an owner is required. The clamp bounds which rows a person
    /// may see, not whether they may administer the place (ADR-0019 §3).
    pub async fn may_administer(
        &self,
        ctx: &SecurityContext,
        org_id: Uuid,
        privilege: &str,
    ) -> bool {
        let subject = ctx.subject_id().to_string();
        // Every way this person signs in, not the one they used today: a grant
        // records whichever login wrote it, and asking about that login alone
        // makes authority depend on which door somebody came through
        // (ADR-0023 follow-up 2). A failed lookup falls back to the bare
        // subject, which is what this asked before.
        let subjects = self
            .subjects_of(&subject)
            .await
            .unwrap_or_else(|_| vec![subject.clone()]);
        let cfg = crate::access_config::read(self.am.as_ref(), ctx, org_id).await;
        cfg.grants_ownership_to(&subjects)
            || (cfg.is_roles_model() && cfg.grants_privilege_to(&subjects, privilege))
    }

    /// The canonical person behind an authenticated caller, provisioning on
    /// first sight.
    ///
    /// The one way a Studio gear turns "who is calling" into "which person", so
    /// that no consumer re-derives it from the token and no two consumers key
    /// the same human differently (ADR-0025). The subject comes off a bearer the
    /// platform has already authenticated, which is both why provisioning here
    /// is safe and why the login is recorded as verified.
    pub async fn resolve_caller(&self, ctx: &SecurityContext) -> Result<String> {
        let subject = ctx.subject_id().to_string();
        let user_id = self
            .resolve_or_provision(PROVIDER_KEYCLOAK, &subject, None, None, true)
            .await?;
        self.seen(&user_id).await;
        Ok(user_id)
    }

    /// The person behind a sign-in method, or `None` when no `login` row knows
    /// it.
    ///
    /// Deliberately does **not** provision. The caller is asking about a subject
    /// read off an existing record rather than off a live token — nobody has
    /// authenticated it here — and minting a person for such a subject would
    /// invent people out of stale data. This is the read that lets a
    /// subject-keyed column be interpreted as a person without rewriting it.
    pub async fn resolve_subject(&self, provider: &str, subject: &str) -> Result<Option<String>> {
        Ok(self
            .store
            .find_login(provider, subject)
            .await?
            .map(|login| login.user_id))
    }

    /// Resolve `(provider, subject)` to a canonical user id, provisioning a new
    /// user the first time an identity is seen (JIT). Seed values fill the fresh
    /// profile; on an already-known login they are ignored.
    pub async fn resolve_or_provision(
        &self,
        provider: &str,
        subject: &str,
        seed_display: Option<&str>,
        seed_email: Option<&str>,
        verified: bool,
    ) -> Result<String> {
        if let Some(login) = self.store.find_login(provider, subject).await? {
            return Ok(login.user_id);
        }
        let user_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let profile = UserProfile {
            id: user_id.clone(),
            display_name: seed_display
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            email: seed_email
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            avatar_url: None,
            locale: None,
            created_at_epoch_ms: now,
            updated_at_epoch_ms: now,
            merged_into: None,
            last_seen_at_epoch_ms: None,
        };
        self.store.upsert_user(&profile).await?;
        let login = LoginView {
            provider: provider.to_owned(),
            subject: subject.to_owned(),
            user_id: user_id.clone(),
            verified,
            linked_at_epoch_ms: now,
            email: None,
            email_verified: false,
        };
        self.store.upsert_login(&login).await?;

        // The deployment's statement that its identity provider's users are the
        // members of one organization (ADR-0018 §4), made true here — at the one
        // moment a person begins to exist. Recorded as a row, so it can be
        // revoked later without touching the corporate directory, and so it
        // remembers how it came about.
        //
        // Not fatal: a person who exists but has not joined yet is a person the
        // next request can still join, whereas failing here would leave them
        // unable to sign in at all.
        if let Some(Some((org_id, role))) = self.first_login_join.get()
            && let Err(error) = self
                .record_membership(&user_id, &org_id.to_string(), role, SOURCE_FIRST_LOGIN)
                .await
        {
            tracing::warn!(
                user = %user_id,
                organization = %org_id,
                "studio-user: could not join the new person to the configured organization:                  {error:#}"
            );
        }
        Ok(user_id)
    }

    /// Note that the person made a request. Written at most once per
    /// [`LAST_SEEN_GRANULARITY_MS`] per person and process, and never fatal:
    /// a members screen reading "last active" is not worth refusing a request
    /// over.
    pub async fn seen(&self, user_id: &str) {
        let now = now_ms();
        {
            let mut seen = self.last_seen.lock().unwrap_or_else(|e| e.into_inner());
            if seen
                .get(user_id)
                .is_some_and(|at| now - at < LAST_SEEN_GRANULARITY_MS)
            {
                return;
            }
            seen.insert(user_id.to_owned(), now);
        }
        if let Err(error) = self.store.touch_last_seen(user_id, now).await {
            tracing::debug!(user = %user_id, "studio-user: could not record last seen: {error:#}");
        }
    }

    /// Ask the identity provider about each of the person's realm sign-ins:
    /// record the address it holds for each, and give a blank profile the
    /// name and address it lacks.
    ///
    /// A person first seen through a token carries no name in Studio — the
    /// token's subject is all `resolve_caller` has — so without this a
    /// members screen shows ids. At most once per person per
    /// [`REALM_REFRESH_MS`] and process; a failed read is retried by the next
    /// call. Never fatal, for the same reason as `seen`.
    pub async fn refresh_from_realm(&self, user_id: &str) {
        let Some(Some(directory)) = self.federated.get() else {
            return;
        };
        {
            let now = now_ms();
            let mut read = self.realm_read.lock().unwrap_or_else(|e| e.into_inner());
            if read
                .get(user_id)
                .is_some_and(|at| now - at < REALM_REFRESH_MS)
            {
                return;
            }
            read.insert(user_id.to_owned(), now);
        }
        let logins = match self.store.logins_of(user_id).await {
            Ok(logins) => logins,
            Err(error) => {
                self.forget_realm_read(user_id);
                tracing::warn!(user = %user_id, "studio-user: could not list logins: {error:#}");
                return;
            }
        };
        let mut people = Vec::new();
        for login in logins.iter().filter(|l| l.provider == PROVIDER_KEYCLOAK) {
            match directory.realm_person(&login.subject).await {
                Ok(Some(person)) => {
                    if let Err(error) = self
                        .store
                        .set_login_email(
                            &login.provider,
                            &login.subject,
                            person.email.as_deref(),
                            person.email_verified,
                        )
                        .await
                    {
                        tracing::warn!(user = %user_id, "studio-user: could not record a sign-in address: {error:#}");
                    }
                    people.push(person);
                }
                Ok(None) => {}
                Err(error) => {
                    self.forget_realm_read(user_id);
                    tracing::debug!(user = %user_id, "studio-user: the realm could not name a sign-in: {error:#}");
                }
            }
        }
        let name = people
            .iter()
            .find_map(|p| p.display_name.clone())
            .or_else(|| {
                people
                    .iter()
                    .map(|p| p.username.trim())
                    .find(|u| !u.is_empty())
                    .map(str::to_owned)
            });
        let email = people
            .iter()
            .filter(|p| p.email_verified)
            .chain(people.iter())
            .find_map(|p| p.email.clone());
        if let Err(error) = self
            .fill_blank_profile(user_id, name.as_deref(), email.as_deref())
            .await
        {
            tracing::warn!(user = %user_id, "studio-user: could not name a person: {error:#}");
        }
    }

    fn forget_realm_read(&self, user_id: &str) {
        self.realm_read
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(user_id);
    }

    /// Every address the person can be reached at: the profile's, each
    /// sign-in's, and each attributed `email` identity.
    pub async fn emails_of(
        &self,
        user_id: &str,
        profile_email: Option<&str>,
    ) -> Result<Vec<PersonEmail>> {
        let logins = self.store.logins_of(user_id).await?;
        let aliases = self.store.aliases_of(user_id).await?;
        Ok(person_emails(profile_email, &logins, &aliases))
    }

    /// Every address of each of these people, read in two queries whatever
    /// their number. `people` pairs a user id with their profile address.
    pub async fn emails_of_people(
        &self,
        people: &[(String, Option<String>)],
    ) -> Result<HashMap<String, Vec<PersonEmail>>> {
        let ids: Vec<String> = people.iter().map(|(id, _)| id.clone()).collect();
        let mut logins: HashMap<String, Vec<LoginView>> = HashMap::new();
        for login in self.store.logins_of_many(&ids).await? {
            logins.entry(login.user_id.clone()).or_default().push(login);
        }
        let mut aliases: HashMap<String, Vec<AliasRecord>> = HashMap::new();
        for alias in self.store.aliases_of_many(&ids).await? {
            aliases
                .entry(alias.user_id.clone())
                .or_default()
                .push(alias);
        }
        Ok(people
            .iter()
            .map(|(id, email)| {
                let mut own_logins = logins.remove(id).unwrap_or_default();
                own_logins.sort_by_key(|l| l.linked_at_epoch_ms);
                let own_aliases = aliases.remove(id).unwrap_or_default();
                (
                    id.clone(),
                    person_emails(email.as_deref(), &own_logins, &own_aliases),
                )
            })
            .collect())
    }

    /// How one organization describes its people, by user id.
    pub async fn directory_of(&self, org_id: &str) -> Result<HashMap<String, DirectoryProfile>> {
        self.store.directory_in_org(org_id).await
    }

    /// A description of one member as it would be stored, or why it cannot
    /// be. A manager must be a member of the same organization, and not the
    /// person themselves.
    pub async fn checked_directory(
        &self,
        org_id: &str,
        user_id: &str,
        profile: DirectoryProfile,
    ) -> Result<DirectoryProfile> {
        let profile = check_directory(profile).map_err(|why| anyhow!("{why}"))?;
        if let Some(manager) = profile.reports_to.as_deref() {
            if manager == user_id {
                return Err(anyhow!("a person cannot report to themselves"));
            }
            let room = self.store.memberships_in_org(org_id).await?;
            if !room.iter().any(|m| m.user_id == manager) {
                return Err(anyhow!("reports_to must be a member of this organization"));
            }
        }
        Ok(profile)
    }

    /// Replace how the organization describes one member. `Ok(None)` when the
    /// person holds no membership there.
    pub async fn set_member_directory(
        &self,
        org_id: &str,
        user_id: &str,
        profile: DirectoryProfile,
    ) -> Result<Option<DirectoryProfile>> {
        let profile = self.checked_directory(org_id, user_id, profile).await?;
        Ok(self
            .store
            .set_directory(user_id, org_id, &profile)
            .await?
            .then_some(profile))
    }

    /// Store the person's photo and point their profile at it.
    ///
    /// The bytes decide the type, not the declaration: a body that does not
    /// start like the image it claims to be is refused, so the route that
    /// serves it back never serves anything but a picture.
    pub async fn set_avatar(
        &self,
        user_id: &str,
        declared: &str,
        bytes: Vec<u8>,
    ) -> Result<UserProfile> {
        let content_type = check_avatar(declared, &bytes).map_err(|why| anyhow!("{why}"))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let digest = hex::encode(hasher.finalize());
        let now = now_ms();
        self.store
            .put_avatar(
                user_id,
                &AvatarRecord {
                    content_type: content_type.to_owned(),
                    bytes,
                    digest: digest.clone(),
                    updated_at_epoch_ms: now,
                },
            )
            .await?;
        let mut profile = self
            .store
            .get_user(user_id)
            .await?
            .ok_or_else(|| anyhow!("user {user_id} does not exist"))?;
        profile.avatar_url = Some(avatar_path(user_id, &digest));
        profile.updated_at_epoch_ms = now;
        self.store.upsert_user(&profile).await?;
        Ok(profile)
    }

    /// Remove the person's stored photo. A photo they linked from elsewhere
    /// is not Studio's to remove, and stays.
    pub async fn remove_avatar(&self, user_id: &str) -> Result<UserProfile> {
        self.store.delete_avatar(user_id).await?;
        let mut profile = self
            .store
            .get_user(user_id)
            .await?
            .ok_or_else(|| anyhow!("user {user_id} does not exist"))?;
        if profile
            .avatar_url
            .as_deref()
            .is_some_and(|url| url.starts_with(&avatar_path(user_id, "")))
        {
            profile.avatar_url = None;
            profile.updated_at_epoch_ms = now_ms();
            self.store.upsert_user(&profile).await?;
        }
        Ok(profile)
    }

    /// The stored photo, when `digest` names its current version.
    ///
    /// The digest is what makes the anonymous route safe to serve: it is only
    /// learned from a profile read the caller was allowed to make, and a stale
    /// or guessed one finds nothing.
    pub async fn avatar(&self, user_id: &str, digest: &str) -> Result<Option<AvatarRecord>> {
        if Uuid::parse_str(user_id).is_err() {
            return Ok(None);
        }
        Ok(self
            .store
            .avatar_of(user_id)
            .await?
            .filter(|a| a.digest == digest))
    }

    /// Read a profile by user id, following a merge pointer if present. Bounded
    /// so a corrupt cyclic pointer cannot loop forever.
    pub async fn get_profile(&self, user_id: &str) -> Result<Option<UserProfile>> {
        let mut current = user_id.to_string();
        for _ in 0..8 {
            let Some(profile) = self.store.get_user(&current).await? else {
                return Ok(None);
            };
            match profile.merged_into.as_deref() {
                Some(into) if into != current => current = into.to_string(),
                _ => return Ok(Some(profile)),
            }
        }
        Err(anyhow!("merge chain too deep or cyclic for user {user_id}"))
    }

    /// Apply a patch to a profile and return the updated view.
    pub async fn update_profile(&self, user_id: &str, patch: ProfilePatch) -> Result<UserProfile> {
        let mut profile = self
            .store
            .get_user(user_id)
            .await?
            .ok_or_else(|| anyhow!("user {user_id} does not exist"))?;
        if let Some(v) = patch.display_name {
            profile.display_name = Some(v.trim().to_owned());
        }
        if let Some(v) = patch.email {
            profile.email = Some(v.trim().to_owned());
        }
        if let Some(v) = patch.avatar_url {
            profile.avatar_url = Some(v.trim().to_owned());
        }
        if let Some(v) = patch.locale {
            profile.locale = Some(v.trim().to_owned());
        }
        profile.updated_at_epoch_ms = now_ms();
        self.store.upsert_user(&profile).await?;
        Ok(profile)
    }

    /// What this person has chosen about how Studio looks to them.
    pub async fn ui_preferences(&self, user_id: &str) -> Result<UiPreferences> {
        Ok(parse_ui_preferences(
            self.store.ui_preferences_of(user_id).await?.as_deref(),
        ))
    }

    /// Replace them wholesale, and answer with what is now stored.
    ///
    /// Wholesale rather than merged: the client holds the whole map anyway,
    /// and a merge gives no way to forget a preference — the key would live
    /// forever because removing it would read as "did not mention it".
    pub async fn set_ui_preferences(
        &self,
        user_id: &str,
        prefs: UiPreferences,
    ) -> Result<UiPreferences> {
        check_ui_preferences(&prefs).map_err(|why| anyhow!("{why}"))?;
        // An empty map stores NULL, not "{}": a person who cleared every
        // choice is back to never having made one, which is the same state and
        // should not be two rows apart.
        let json = if prefs.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&prefs)?)
        };
        if !self
            .store
            .set_ui_preferences(user_id, json.as_deref())
            .await?
        {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        Ok(prefs)
    }

    /// Every sign-in method that resolves to this user.
    pub async fn list_logins(&self, user_id: &str) -> Result<Vec<LoginView>> {
        self.store.logins_of(user_id).await
    }

    /// Bind another sign-in method to an existing user. Refuses if the login is
    /// already bound to a different user (merge is the explicit path). The
    /// verified-only auto-link policy is enforced by the caller.
    ///
    /// Not yet exposed over REST: a caller cannot be trusted to *claim* another
    /// identity without an identity-provider flow proving ownership (that would
    /// be an account-takeover vector). This is the primitive the future account-
    /// linking callback (Keycloak linking / a verified flow) will call.
    #[allow(dead_code)]
    pub async fn link_login(
        &self,
        user_id: &str,
        provider: &str,
        subject: &str,
        verified: bool,
    ) -> Result<()> {
        if let Some(existing) = self.store.find_login(provider, subject).await?
            && existing.user_id != user_id
        {
            return Err(anyhow!(
                "login {provider}:{subject} is already bound to another user; merge instead"
            ));
        }
        if self.store.get_user(user_id).await?.is_none() {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        self.store
            .upsert_login(&LoginView {
                provider: provider.to_owned(),
                subject: subject.to_owned(),
                user_id: user_id.to_owned(),
                verified,
                linked_at_epoch_ms: now_ms(),
                email: None,
                email_verified: false,
            })
            .await
    }

    /// Attribute a non-login external identifier to a user, subject to the
    /// write policy.
    ///
    /// `identity_alias` holds one row per external identity, so this is a
    /// repoint, not an append — every caller goes through
    /// [`super::alias_policy::decide`] (ADR-0012). Before that gate the upsert
    /// was unconditional, which was safe only because the route was
    /// platform-admin; self-service makes the gate a precondition, not a
    /// refinement.
    pub async fn attribute_alias(
        &self,
        user_id: &str,
        kind: &str,
        external_id: &str,
        confidence: Confidence,
    ) -> Result<AliasOutcome> {
        attribute_alias_in(self.store.as_ref(), user_id, kind, external_id, confidence).await
    }

    /// Every external identity attributed to a user, strongest first.
    ///
    /// There was no way to read these before: the store could answer
    /// "what does this user hold" but nothing exposed it, so a person could not
    /// see what had been attributed to them. Self-service needs it.
    pub async fn list_aliases(&self, user_id: &str) -> Result<Vec<AliasRecord>> {
        let mut out = self.store.aliases_of(user_id).await?;
        out.sort_by(|a, b| {
            let strength = |record: &AliasRecord| {
                Confidence::parse(&record.confidence).map_or(0, Confidence::strength)
            };
            strength(b)
                .cmp(&strength(a))
                .then_with(|| a.kind.cmp(&b.kind))
                .then_with(|| a.external_id.cmp(&b.external_id))
        });
        Ok(out)
    }

    /// The caller says an external identity is theirs, with nothing behind it
    /// yet. Records intent; attributes nothing until the ceremony confirms it.
    pub async fn claim_alias(
        &self,
        user_id: &str,
        kind: &str,
        external_id: &str,
    ) -> Result<AliasOutcome> {
        self.attribute_alias(user_id, kind, external_id, Confidence::Claimed)
            .await
    }

    /// Withdraw an attribution the caller holds.
    ///
    /// Deletes rather than tombstones: the row is one slot per external
    /// identity, and leaving a withdrawn row behind would keep the slot
    /// occupied against the next person. Refuses to touch somebody else's row.
    pub async fn revoke_alias(
        &self,
        user_id: &str,
        kind: &str,
        external_id: &str,
    ) -> Result<AliasOutcome> {
        let (kind, external_id) = normalize_alias(kind, external_id)?;
        match self.store.find_alias(&kind, &external_id).await? {
            None => Ok(AliasOutcome::AlreadyHeld),
            Some(record) if record.user_id != user_id => Ok(AliasOutcome::Refused(
                "this external identity is not attributed to you",
            )),
            Some(_) => {
                self.store.delete_alias(&kind, &external_id).await?;
                Ok(AliasOutcome::Written)
            }
        }
    }

    /// Record every proof of control the platform already holds about the
    /// caller, from whichever channels are available.
    ///
    /// Two channels, and neither costs the person a new step (ADR-0012,
    /// ADR-0025):
    ///
    /// - **their connector credentials.** Every connection in the catalogue
    ///   passed `ConnectorDriver::test()`, which asked the provider "who am I?"
    ///   with that credential and stored the answer in `Connection.account`.
    /// - **their brokered logins.** Signing in through GitHub means the person
    ///   completed that provider's authorization flow and the provider named
    ///   the account — the same class of proof, arriving from the IdP.
    ///
    /// Nothing is re-probed and no token is read; both channels only *record*
    /// what already happened. Available if either channel is; an identity
    /// confirmed through both is written once and reported as already
    /// confirmed.
    pub async fn confirm_aliases(
        &self,
        ctx: &SecurityContext,
        user_id: &str,
        tenant: Uuid,
    ) -> Result<ConfirmReport> {
        let connectors = self.connectors.get().and_then(Option::as_ref);
        let federated = self.federated.get().and_then(Option::as_ref);
        if connectors.is_none() && federated.is_none() {
            return Err(anyhow!(
                "no proof channel is available: neither a connector driver plugin nor the IdP \
                 directory is configured, so there is nothing to confirm an identity with"
            ));
        }

        let mut report = ConfirmReport::default();
        if let Some(connectors) = connectors {
            self.confirm_from_connections(ctx, user_id, tenant, connectors, &mut report)
                .await?;
        }
        if let Some(federated) = federated {
            Self::confirm_from_idp(
                self.store.as_ref(),
                user_id,
                federated.as_ref(),
                &mut report,
            )
            .await?;
        }
        Ok(report)
    }

    /// The connector-credential channel.
    ///
    /// Ownership is compared between *people*, not between token subjects, so a
    /// proof left behind under one of the caller's other logins is still theirs
    /// (ADR-0025).
    async fn confirm_from_connections(
        &self,
        ctx: &SecurityContext,
        user_id: &str,
        tenant: Uuid,
        connectors: &Arc<ConnectorService>,
        report: &mut ConfirmReport,
    ) -> Result<()> {
        for connection in connectors.list(ctx, tenant).await? {
            if connection.account.trim().is_empty() {
                // A provider that reports no account (an AI model key) has no
                // identity to confirm.
                continue;
            }
            if connection.scope != PERSONAL_SCOPE {
                // A team or bot credential proves control of *an* account, not
                // of the caller's own (ADR-0012).
                report.skipped_shared += 1;
                continue;
            }
            // `created_by` names the sign-in method that wrote the row, so it is
            // resolved to a person before being compared to one: the caller may
            // be signed in through a different login than the one that left the
            // proof, and the proof is theirs under either (ADR-0025).
            let creator = if connection.created_by.trim().is_empty() {
                None
            } else {
                self.resolve_subject(PROVIDER_KEYCLOAK, &connection.created_by)
                    .await?
            };
            match proof_owner(&connection.created_by, creator.as_deref(), user_id) {
                ProofOwner::Caller => {}
                ProofOwner::AnotherPerson => {
                    // Somebody else's proof is theirs to record.
                    report.skipped_other_owner += 1;
                    continue;
                }
                ProofOwner::Unknown => {
                    // A row written before the record named its creator, or one
                    // naming a subject no login knows. There is a proof but
                    // nothing says whose, and guessing is the failure this whole
                    // flow exists to avoid.
                    report.skipped_unknown_owner += 1;
                    continue;
                }
            }

            match self
                .attribute_alias(
                    user_id,
                    &connection.provider,
                    &connection.account,
                    Confidence::Confirmed,
                )
                .await?
            {
                AliasOutcome::Written | AliasOutcome::WrittenOverAProof => {
                    report.confirmed.push((
                        normalize_key(&connection.provider),
                        normalize_key(&connection.account),
                    ));
                }
                AliasOutcome::AlreadyHeld => report.already_confirmed += 1,
                AliasOutcome::Refused(reason) => report.refused.push(reason.to_owned()),
            }
        }
        Ok(())
    }

    /// The IdP channel: what the broker already confirmed about this person.
    ///
    /// Walks **every** Keycloak login the person holds, not only the one they
    /// are signed in with. A person who merged two accounts may have brokered a
    /// different provider onto each, and each of those is a proof they own —
    /// which is the whole point of one person holding several logins (ADR-0025).
    ///
    /// The alias is keyed on the provider handle rather than the provider's
    /// numeric id, because the handle is what the artefacts being attributed
    /// carry: a commit names an author, not an account id. A handle renamed at
    /// the provider is therefore a re-confirmation rather than a silent break —
    /// the old row keeps pointing at this person until something displaces it.
    async fn confirm_from_idp(
        store: &dyn IdentityStore,
        user_id: &str,
        federated: &dyn IdpDirectoryReader,
        report: &mut ConfirmReport,
    ) -> Result<()> {
        for login in store.logins_of(user_id).await? {
            if login.provider != PROVIDER_KEYCLOAK {
                // Only a realm subject has brokered logins to read.
                continue;
            }
            for account in federated.federated_accounts(&login.subject).await? {
                if account.user_name.trim().is_empty() {
                    // A broker reporting no handle proves control of an account
                    // that nothing else can name, so there is nothing for an
                    // attribution to match against.
                    report.skipped_no_handle += 1;
                    continue;
                }
                match attribute_alias_in(
                    store,
                    user_id,
                    &account.provider,
                    &account.user_name,
                    Confidence::Confirmed,
                )
                .await?
                {
                    AliasOutcome::Written | AliasOutcome::WrittenOverAProof => {
                        report.confirmed.push((
                            normalize_key(&account.provider),
                            normalize_key(&account.user_name),
                        ));
                    }
                    AliasOutcome::AlreadyHeld => report.already_confirmed += 1,
                    AliasOutcome::Refused(reason) => report.refused.push(reason.to_owned()),
                }
            }
        }
        Ok(())
    }

    /// Which of `external_ids` are confirmed, mapped to the user holding them.
    ///
    /// Only `confirmed` rows are returned: a claim or a suggestion attributes
    /// nothing, so a consumer must not be able to read one as an attribution
    /// (ADR-0012). The knowledge-graph sync is the caller.
    pub async fn confirmed_alias_owners(
        &self,
        kind: &str,
        external_ids: &[String],
    ) -> Result<BTreeMap<String, String>> {
        let kind = normalize_key(kind);
        let ids: Vec<String> = external_ids.iter().map(|id| normalize_key(id)).collect();
        Ok(self
            .store
            .find_aliases(&kind, &ids)
            .await?
            .into_iter()
            .filter(|record| {
                Confidence::parse(&record.confidence).is_some_and(Confidence::attributes)
            })
            .map(|record| (record.external_id, record.user_id))
            .collect())
    }

    /// Every organization membership of a user, with the role held in each.
    pub async fn list_memberships(&self, user_id: &str) -> Result<Vec<MembershipView>> {
        let mut out = self.store.memberships_of(user_id).await?;
        out.sort_by(|a, b| a.org_id.cmp(&b.org_id));
        Ok(out)
    }

    /// Record (upsert) a person's membership in an organization with the role
    /// held there. Role lives on the membership, never on the profile.
    ///
    /// Active: every path that records a membership is recording one that
    /// applies. Suspension is a later, deliberate edit through
    /// `set_membership_standing`, never something a write arrives already in.
    pub async fn record_membership(
        &self,
        user_id: &str,
        org_id: &str,
        role: &str,
        source: &str,
    ) -> Result<MembershipView> {
        self.write_membership(user_id, org_id, &leaving::Standing::active(role), source)
            .await
    }

    /// Record a membership in a given standing — role and status together.
    async fn write_membership(
        &self,
        user_id: &str,
        org_id: &str,
        standing: &leaving::Standing,
        source: &str,
    ) -> Result<MembershipView> {
        if self.store.get_user(user_id).await?.is_none() {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        let now = now_ms();
        let view = MembershipView {
            user_id: user_id.to_owned(),
            org_id: org_id.to_owned(),
            role: standing.role.clone(),
            status: standing.status.clone(),
            source: source.to_owned(),
            // On an update the stored created_at is preserved (the store's
            // conflict update excludes it); this value seeds a first insert.
            created_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        self.store.upsert_membership(&view).await?;
        memberships_changed();
        Ok(view)
    }

    /// Record that the identity `subject` belongs to `org_id` holding `role`.
    ///
    /// The assignment path's entry point (ADR-0016). It provisions a person if
    /// this login has never been seen, which is the right call *here* and not in
    /// `resolve_recorded_subject`: this subject comes from the IdP's own user
    /// list, so the identity demonstrably exists — where a subject read out of
    /// some other gear's column demonstrates nothing.
    ///
    /// `display_name` and `email` are what the IdP calls the identity. They
    /// name a person created here, and fill an existing profile's blanks —
    /// never overwrite it, since a profile is the person's own to edit. Without
    /// them every assigned person read as "Person 1a2b3c4d" on the members
    /// screen until they edited their own profile.
    pub async fn record_assignment(
        &self,
        subject: &str,
        org_id: Uuid,
        role: &str,
        display_name: Option<&str>,
        email: Option<&str>,
    ) -> Result<()> {
        let user_id = self
            .resolve_or_provision(PROVIDER_KEYCLOAK, subject, display_name, email, true)
            .await?;
        self.fill_blank_profile(&user_id, display_name, email)
            .await?;
        self.record_membership(&user_id, &org_id.to_string(), role, SOURCE_ASSIGNMENT)
            .await?;
        Ok(())
    }

    /// Give a profile the name and address it lacks, leaving any it has.
    async fn fill_blank_profile(
        &self,
        user_id: &str,
        display_name: Option<&str>,
        email: Option<&str>,
    ) -> Result<()> {
        let Some(mut profile) = self.store.get_user(user_id).await? else {
            return Ok(());
        };
        if fill_blanks(&mut profile, display_name, email) {
            profile.updated_at_epoch_ms = now_ms();
            self.store.upsert_user(&profile).await?;
        }
        Ok(())
    }

    /// Record that `subject` created `org_id` and therefore owns it.
    ///
    /// Separate from [`Self::record_assignment`] only in what it records as the
    /// source: ownership that arises from creating an organization did not come
    /// from an operator, and an owner reading their member list should see the
    /// difference (ADR-0018 §2).
    pub async fn record_creation(&self, subject: &str, org_id: Uuid) -> Result<()> {
        let user_id = self
            .resolve_or_provision(PROVIDER_KEYCLOAK, subject, None, None, true)
            .await?;
        self.record_membership(
            &user_id,
            &org_id.to_string(),
            crate::access_config::ROLE_OWNER,
            SOURCE_CREATION,
        )
        .await?;
        Ok(())
    }

    /// Is the person behind `subject` a platform administrator?
    ///
    /// The question is "do they hold a membership of the platform root", not
    /// "what does their token say". A token names the tenant of *one login*, so
    /// reading administrative rights from it made a person an administrator
    /// through one sign-in method and an ordinary member through another
    /// (ADR-0018 §3).
    ///
    /// This is the half of that ADR that replaces the token reading. The
    /// callers still accept the old signal as well while the migration runs —
    /// see the note on each one.
    pub async fn is_platform_admin(&self, subject: &str) -> Result<bool> {
        Ok(self
            .organizations_of(subject)
            .await?
            .contains(&PLATFORM_ROOT_TENANT_ID))
    }

    /// Seed the memberships that make the configured identities administrators.
    ///
    /// Idempotent, and run at every start: an installation states who its
    /// administrators are, and the row that makes it true is written from that
    /// statement rather than from whoever happens to carry an attribute.
    ///
    /// Without this there is a lockout waiting at the end of the migration: once
    /// the token signal is removed, a deployment whose administrators were only
    /// ever administrators *by token* would have none, and no way to make one.
    /// Studio's own service identity, as a person nobody is (ADR-0030).
    pub async fn seed_service_account(&self, account: &super::ServiceAccount) -> Result<String> {
        seed_service_account_in(self.store.as_ref(), account).await
    }

    pub async fn seed_platform_admins(&self, subjects: &[String]) -> Result<usize> {
        let mut seeded = 0;
        for subject in subjects {
            let subject = subject.trim();
            if subject.is_empty() {
                continue;
            }
            let user_id = self
                .resolve_or_provision(PROVIDER_KEYCLOAK, subject, None, None, true)
                .await?;
            self.record_membership(
                &user_id,
                &PLATFORM_ROOT_TENANT_ID.to_string(),
                crate::access_config::ROLE_OWNER,
                SOURCE_BOOTSTRAP,
            )
            .await?;
            seeded += 1;
        }
        Ok(seeded)
    }

    /// The organizations the person behind `subject` is a member of.
    ///
    /// Never provisions: a subject nobody has seen is a subject with no
    /// memberships, and minting a person for one during an authorization
    /// decision would create people out of traffic.
    pub async fn organizations_of(&self, subject: &str) -> Result<Vec<Uuid>> {
        let Some(user_id) = self.resolve_subject(PROVIDER_KEYCLOAK, subject).await? else {
            return Ok(Vec::new());
        };
        Ok(self
            .store
            .memberships_of(&user_id)
            .await?
            .into_iter()
            // A suspended membership records where somebody belongs and grants
            // nothing while it stands, so it must not appear here: this answer
            // is what the PDP clamps on and what decides administrative rights.
            .filter(|m| m.status == leaving::STATUS_ACTIVE)
            .filter_map(|m| Uuid::parse_str(&m.org_id).ok())
            .collect())
    }

    /// Every membership of the person behind `subject`, suspended included.
    /// Never provisions: the subject comes from the IdP's user list, and a
    /// person nobody has recorded simply belongs nowhere yet.
    pub async fn memberships_of_subject(
        &self,
        subject: &str,
    ) -> Result<Vec<super::SubjectMembership>> {
        let Some(user_id) = self.resolve_subject(PROVIDER_KEYCLOAK, subject).await? else {
            return Ok(Vec::new());
        };
        Ok(self
            .store
            .memberships_of(&user_id)
            .await?
            .into_iter()
            .filter_map(|m| {
                Some(super::SubjectMembership {
                    org_id: Uuid::parse_str(&m.org_id).ok()?,
                    role: m.role,
                    status: m.status,
                })
            })
            .collect())
    }

    /// Invite an address into an organization.
    ///
    /// Returns the token **once**. It is not stored and cannot be shown again:
    /// only its digest is kept, so a later read of the table yields nothing
    /// that works.
    pub async fn invite(
        &self,
        org_id: Uuid,
        inviter: &str,
        email: &str,
        role: &str,
    ) -> Result<(InvitationRecord, String)> {
        let email = invitations::validate_email(email)?;
        let role = invitations::validate_role(role)?;
        let (token, digest) = invitations::mint_token();
        let now = now_ms();
        let record = InvitationRecord {
            id: Uuid::new_v4().to_string(),
            org_id: org_id.to_string(),
            email,
            role,
            token_digest: digest,
            invited_by: inviter.to_owned(),
            created_at_epoch_ms: now,
            expires_at_epoch_ms: now + invitations::VALID_FOR_DAYS * 24 * 60 * 60 * 1000,
            accepted_at_epoch_ms: None,
        };
        self.store.insert_invitation(&record).await?;
        Ok((record, token))
    }

    /// What an organization has outstanding.
    pub async fn invitations_of(&self, org_id: Uuid) -> Result<Vec<InvitationRecord>> {
        self.store.invitations_of_org(&org_id.to_string()).await
    }

    /// Withdraw one. Returns whether there was one to withdraw.
    pub async fn revoke_invitation(&self, org_id: Uuid, id: &str) -> Result<bool> {
        self.store.delete_invitation(id, &org_id.to_string()).await
    }

    /// The invitations waiting for a verified address.
    ///
    /// One row per invitation waiting for any address this person has verified.
    pub async fn invitations_waiting_for(
        &self,
        verified_emails: &[String],
    ) -> Result<Vec<InvitationRecord>> {
        let mut out = Vec::new();
        for email in verified_emails {
            for invitation in self
                .store
                .invitations_for_email(&invitations::normalize_email(email))
                .await?
            {
                if !out.iter().any(|i: &InvitationRecord| i.id == invitation.id) {
                    out.push(invitation);
                }
            }
        }
        Ok(out)
    }

    /// Every address the identity provider vouches for, across all of this
    /// person's realm logins.
    ///
    /// Empty when the directory is not configured — which refuses an
    /// acceptance rather than falling back to the profile address. The profile
    /// address is self-service, so believing it here would let anybody claim
    /// any invitation by typing the address it was sent to.
    pub async fn verified_emails(&self, user_id: &str) -> Result<Vec<String>> {
        let Some(Some(directory)) = self.federated.get() else {
            return Ok(Vec::new());
        };
        let mut found = Vec::new();
        for login in self.store.logins_of(user_id).await? {
            if login.provider != PROVIDER_KEYCLOAK {
                continue;
            }
            if let Some(email) = directory.verified_email(&login.subject).await?
                && !found.contains(&email)
            {
                found.push(email);
            }
        }
        Ok(found)
    }

    /// Accept an invitation and become a member.
    ///
    /// `verified_email` is what the identity provider vouches for; `None` means
    /// it vouches for nothing, which refuses. The membership is written only
    /// after the database has confirmed that this call is the one that took the
    /// invitation, so a race produces one member and one refusal rather than
    /// two members.
    pub async fn accept_invitation(
        &self,
        user_id: &str,
        offered: &Offered<'_>,
        verified_emails: &[String],
    ) -> Result<Result<MembershipView, invitations::Refusal>> {
        let found = match offered {
            Offered::Token(token) => {
                let digest = invitations::digest_of(token);
                self.store.find_invitation_by_digest(&digest).await?
            }
            // No weaker: the same verified-address check decides both, and the
            // id was only ever learned from a listing that had already applied
            // it. What the token adds is a way in for somebody the listing
            // cannot reach — an address the provider vouches for but this
            // person has not signed in with yet.
            Offered::Id(id) => self.store.find_invitation_by_id(id).await?,
        };
        let pending = found.as_ref().map(|r| invitations::Pending {
            email: r.email.clone(),
            expired: r.expires_at_epoch_ms <= now_ms(),
            accepted: r.accepted_at_epoch_ms.is_some(),
        });
        if let Err(refusal) = invitations::may_accept(pending.as_ref(), verified_emails) {
            return Ok(Err(refusal));
        }
        let record = found.expect("checked above");
        if !self.store.accept_invitation(&record.id, user_id).await? {
            // Somebody else took it between the read and the write.
            return Ok(Err(invitations::Refusal::AlreadyAccepted));
        }
        let membership = self
            .record_membership(user_id, &record.org_id, &record.role, SOURCE_INVITATION)
            .await?;
        Ok(Ok(membership))
    }

    /// Everybody in one organization, so a caller can see the room before
    /// changing who is in it.
    pub async fn members_of(&self, org_id: &str) -> Result<Vec<MembershipView>> {
        self.store.memberships_in_org(org_id).await
    }

    /// Everybody in one organization with who they are, for a members screen:
    /// the membership, and the person's profile when it can be read.
    pub async fn members_with_profiles(
        &self,
        org_id: &str,
    ) -> Result<Vec<(MembershipView, Option<UserProfile>)>> {
        let mut out = Vec::new();
        for membership in self.members_of(org_id).await? {
            let profile = self.store.get_user(&membership.user_id).await?;
            out.push((membership, profile));
        }
        Ok(out)
    }

    /// One member's identities — every sign-in method and every attributed
    /// external account — for a members screen that opens a row.
    ///
    /// `None` when `user_id` holds no membership in `org_id`: authority over an
    /// organization is authority over its room, so an owner reads the people in
    /// it and nobody else. Only what this gear recorded; nothing is asked of the
    /// IdP, whose reader answers about the signed-in person alone.
    pub async fn member_identities(
        &self,
        org_id: &str,
        user_id: &str,
    ) -> Result<Option<(Vec<LoginView>, Vec<AliasRecord>)>> {
        let member = self
            .store
            .memberships_of(user_id)
            .await?
            .iter()
            .any(|m| m.org_id == org_id);
        if !member {
            return Ok(None);
        }
        let mut logins = self.store.logins_of(user_id).await?;
        logins.sort_by_key(|l| l.linked_at_epoch_ms);
        Ok(Some((logins, self.list_aliases(user_id).await?)))
    }

    /// Make the organization's owner grant agree with one person's membership.
    ///
    /// Two records say "owner" and they must not disagree. The membership's
    /// role is what the last-owner rule counts; the org-scoped `owner` grant in
    /// the access config is what `may_administer` reads (ADR-0019). Creation
    /// and the identity directory's assignment write both; a membership written
    /// here must too, or an "owner" in the member list could administer
    /// nothing — and a demoted one still could.
    ///
    /// The grant is written for every sign-in of the person, since authority
    /// is asked about all of them (`subjects_of`), and removed from every one.
    pub async fn sync_owner_grant(
        &self,
        ctx: &SecurityContext,
        user_id: &str,
        org_id: Uuid,
        owner: bool,
    ) -> Result<()> {
        let tenant = self
            .am
            .get_tenant(ctx, org_id)
            .await
            .map_err(|error| anyhow!("cannot read organization {org_id}: {error}"))?;
        let logins = self.list_logins(user_id).await?;
        for login in logins
            .iter()
            .filter(|login| !owner || login.provider == PROVIDER_KEYCLOAK)
        {
            crate::access_config::set_owner_grant(
                self.am.as_ref(),
                ctx,
                org_id,
                &tenant.name,
                &login.subject,
                owner,
            )
            .await?;
        }
        Ok(())
    }

    /// May this membership end, or become `after`?
    ///
    /// One gate for leaving, for being removed, for being demoted and for being
    /// suspended — otherwise the rule would hold on one route and be walked
    /// around on another.
    pub async fn may_change_membership(
        &self,
        user_id: &str,
        org_id: &str,
        after: Option<&leaving::Standing>,
    ) -> Result<Result<(), leaving::Refusal>> {
        let members: Vec<leaving::Member> = self
            .members_of(org_id)
            .await?
            .into_iter()
            .map(|m| leaving::Member {
                user_id: m.user_id,
                role: m.role,
                status: m.status,
            })
            .collect();
        Ok(leaving::may_change(&members, user_id, after))
    }

    /// Set somebody's role and status in one organization, subject to the rule.
    ///
    /// The one write behind both "change their role" and "suspend them": they
    /// are the same edit to the same row, and splitting them would be two ways
    /// to reach a state only one of them checked.
    pub async fn set_membership_standing(
        &self,
        user_id: &str,
        org_id: &str,
        after: &leaving::Standing,
        source: &str,
    ) -> Result<Result<MembershipView, leaving::Refusal>> {
        // Somebody being added is not a member yet, and that is not a reason to
        // refuse adding them — every other refusal is about the room they would
        // leave behind and applies.
        if let Err(refusal) = self
            .may_change_membership(user_id, org_id, Some(after))
            .await?
            && refusal != leaving::Refusal::NotAMember
        {
            return Ok(Err(refusal));
        }
        Ok(Ok(self
            .write_membership(user_id, org_id, after, source)
            .await?))
    }

    /// Leave an organization: the membership ends, and the leaver's own
    /// credentials go with them.
    ///
    /// Access goes; authorship does not. Documents, projects and workspaces
    /// belong to the organization and stay, and attribution in the knowledge
    /// graph stays with the person who earned it — history is not rewritten
    /// because somebody left (ADR-0018 §6).
    ///
    /// What does leave with them is every *personal* connection they created
    /// here. Without that the organization keeps a working credential of
    /// somebody no longer in it, and under ADR-0012 it keeps their proof of
    /// controlling that external account too.
    pub async fn leave_organization(
        &self,
        ctx: &SecurityContext,
        user_id: &str,
        org_id: Uuid,
    ) -> Result<Result<usize, leaving::Refusal>> {
        let org = org_id.to_string();
        if let Err(refusal) = self.may_change_membership(user_id, &org, None).await? {
            return Ok(Err(refusal));
        }
        self.store.delete_membership(user_id, &org).await?;
        memberships_changed();

        // After the membership, not before: the credentials are the tidy-up,
        // and leaving somebody a member while their connections disappear would
        // be the worse of the two half-states.
        let removed = match self.connectors.get().and_then(Option::as_ref) {
            // This gear *is* the person resolver, so it hands itself over
            // rather than looking one up.
            Some(connectors) => connectors
                .delete_personal_of(ctx, org_id, self, user_id)
                .await
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        user = %user_id,
                        organization = %org_id,
                        "studio-user: left the organization but could not remove their personal \
                         connections: {error:#}"
                    );
                    0
                }),
            None => 0,
        };
        Ok(Ok(removed))
    }

    /// Remove a person's membership in an organization.
    /// End every membership of one organization, and take the personal
    /// connections with them.
    ///
    /// Not `leave_organization` in a loop: the last-owner rule exists to keep an
    /// organization administrable, and an organization that is being deleted has
    /// nothing left to administer. Refusing here would make the rule the reason
    /// an organization can never be disposed of.
    ///
    /// Ordered the way leaving is, and for the same reason: each person's
    /// credentials go after their membership, so a failure part-way leaves
    /// people out rather than leaving people in with their credentials gone.
    pub async fn evict_everybody(&self, ctx: &SecurityContext, org_id: Uuid) -> Result<Eviction> {
        let org = org_id.to_string();
        let mut evicted = Eviction::default();
        for member in self.store.memberships_in_org(&org).await? {
            self.store.delete_membership(&member.user_id, &org).await?;
            evicted.people += 1;
            if let Some(connectors) = self.connectors.get().and_then(Option::as_ref) {
                match connectors
                    .delete_personal_of(ctx, org_id, self, &member.user_id)
                    .await
                {
                    Ok(n) => evicted.connections += n,
                    Err(error) => tracing::warn!(
                        user = %member.user_id,
                        organization = %org_id,
                        "studio-user: could not remove a member's personal connections while \
                         emptying the organization: {error:#}"
                    ),
                }
            }
        }
        memberships_changed();
        Ok(evicted)
    }

    /// Merge `from_user` into `into_user`: repoint every login, alias and
    /// membership, then tombstone the source with a `merged_into` pointer.
    pub async fn merge(&self, from_user: &str, into_user: &str) -> Result<MergeResult> {
        if from_user == into_user {
            return Err(anyhow!("cannot merge a user into itself"));
        }
        if self.store.get_user(into_user).await?.is_none() {
            return Err(anyhow!("target user {into_user} does not exist"));
        }
        let mut source = self
            .store
            .get_user(from_user)
            .await?
            .ok_or_else(|| anyhow!("source user {from_user} does not exist"))?;

        let mut result = MergeResult::default();

        for mut login in self.store.logins_of(from_user).await? {
            login.user_id = into_user.to_owned();
            self.store.upsert_login(&login).await?;
            result.logins_moved += 1;
        }
        for mut alias in self.store.aliases_of(from_user).await? {
            alias.user_id = into_user.to_owned();
            self.store.upsert_alias(&alias).await?;
            result.aliases_moved += 1;
        }
        for membership in self.store.memberships_of(from_user).await? {
            self.record_membership(
                into_user,
                &membership.org_id,
                &membership.role,
                &membership.source,
            )
            .await?;
            self.carry_directory(&membership.org_id, from_user, into_user)
                .await?;
            self.store
                .delete_membership(from_user, &membership.org_id)
                .await?;
            result.memberships_moved += 1;
        }
        self.carry_avatar(from_user, into_user).await?;

        source.merged_into = Some(into_user.to_owned());
        source.updated_at_epoch_ms = now_ms();
        self.store.upsert_user(&source).await?;
        // A merge repoints memberships, so anything caching where this person
        // may go is now wrong.
        memberships_changed();
        Ok(result)
    }
}

impl IdentityService {
    /// In one organization, give the merge target the source's description
    /// when it has none of its own, and point whoever reported to the source
    /// at the target.
    async fn carry_directory(&self, org_id: &str, from_user: &str, into_user: &str) -> Result<()> {
        let directory = self.store.directory_in_org(org_id).await?;
        if let Some(described) = directory.get(from_user)
            && !directory.contains_key(into_user)
        {
            let mut carried = described.clone();
            if carried.reports_to.as_deref() == Some(into_user) {
                carried.reports_to = None;
            }
            self.store
                .set_directory(into_user, org_id, &carried)
                .await?;
        }
        for (user_id, described) in &directory {
            if user_id == from_user || described.reports_to.as_deref() != Some(from_user) {
                continue;
            }
            let mut repointed = described.clone();
            repointed.reports_to = (user_id != into_user).then(|| into_user.to_owned());
            self.store
                .set_directory(user_id, org_id, &repointed)
                .await?;
        }
        Ok(())
    }

    /// Give the merge target the source's stored photo when it has none, and
    /// remove the source's: a merged-away person is never shown.
    async fn carry_avatar(&self, from_user: &str, into_user: &str) -> Result<()> {
        let Some(photo) = self.store.avatar_of(from_user).await? else {
            return Ok(());
        };
        let mut target = self
            .store
            .get_user(into_user)
            .await?
            .ok_or_else(|| anyhow!("target user {into_user} does not exist"))?;
        if self.store.avatar_of(into_user).await?.is_none() && target.avatar_url.is_none() {
            self.store.put_avatar(into_user, &photo).await?;
            target.avatar_url = Some(avatar_path(into_user, &photo.digest));
            target.updated_at_epoch_ms = now_ms();
            self.store.upsert_user(&target).await?;
        }
        self.store.delete_avatar(from_user).await?;
        Ok(())
    }
}

/// What one alias write did. Not an error type: a refusal is a normal answer to
/// a normal request ("that account is somebody else's"), and the caller renders
/// it rather than treating it as a fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AliasOutcome {
    Written,
    /// Written, and it took an identity somebody else had proven. Verification
    /// wins (ADR-0012), but the loss is surfaced rather than silent.
    WrittenOverAProof,
    /// The identical assertion was already recorded. Reported as success so a
    /// retry is safe.
    AlreadyHeld,
    Refused(&'static str),
}

/// What one confirmation pass over the connection catalogue did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfirmReport {
    /// `(kind, external_id)` pairs now confirmed for the caller.
    pub confirmed: Vec<(String, String)>,
    /// Already confirmed before this pass.
    pub already_confirmed: usize,
    /// Team or bot credentials: proving control of a shared account says
    /// nothing about who the caller is.
    pub skipped_shared: usize,
    /// Personal connections belonging to somebody else.
    pub skipped_other_owner: usize,
    /// Personal connections written before the record named its creator.
    pub skipped_unknown_owner: usize,
    /// Brokered logins whose provider reported no handle to attribute.
    pub skipped_no_handle: usize,
    /// Refusals from the write policy, in the policy's own words.
    pub refused: Vec<String>,
}

/// Make Studio's service identity a person the directory can name
/// (ADR-0030): a login for its Keycloak subject and a profile saying what it
/// is. Idempotent — run at every start — and it keeps the profile's name and
/// address in step with the configuration.
///
/// Deliberately NOT `resolve_or_provision`: that is a person's first sign-in,
/// and the installation's `on_first_login` join would make the service
/// identity a member of an organization. It must hold no membership, so it
/// can do nothing — it is a name for what a shared session does on nobody's
/// behalf, not an actor with rights.
pub(crate) async fn seed_service_account_in(
    store: &dyn IdentityStore,
    account: &super::ServiceAccount,
) -> Result<String> {
    let now = now_ms();
    let existing = store
        .find_login(PROVIDER_KEYCLOAK, &account.subject)
        .await?;
    let user_id = existing
        .as_ref()
        .map(|login| login.user_id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let profile = store.get_user(&user_id).await?;
    let current = profile
        .as_ref()
        .map(|p| (p.display_name.as_deref(), p.email.as_deref()));
    if current
        != Some((
            Some(account.display_name.as_str()),
            Some(account.email.as_str()),
        ))
    {
        let mut profile = profile.unwrap_or(UserProfile {
            id: user_id.clone(),
            display_name: None,
            email: None,
            avatar_url: None,
            locale: None,
            created_at_epoch_ms: now,
            updated_at_epoch_ms: now,
            merged_into: None,
            last_seen_at_epoch_ms: None,
        });
        profile.display_name = Some(account.display_name.clone());
        profile.email = Some(account.email.clone());
        profile.updated_at_epoch_ms = now;
        store.upsert_user(&profile).await?;
    }
    if existing.is_none() {
        store
            .upsert_login(&LoginView {
                provider: PROVIDER_KEYCLOAK.to_owned(),
                subject: account.subject.clone(),
                user_id: user_id.clone(),
                verified: true,
                linked_at_epoch_ms: now,
                email: None,
                email_verified: false,
            })
            .await?;
    }
    Ok(user_id)
}

/// Attribute an external identity to a user, subject to the write policy.
///
/// A free function over the store rather than a method: the policy needs the
/// alias rows and nothing else about the service. Saying so in the signature is
/// what lets the ceremony be tested without standing up Account Management or a
/// connector catalogue.
async fn attribute_alias_in(
    store: &dyn IdentityStore,
    user_id: &str,
    kind: &str,
    external_id: &str,
    confidence: Confidence,
) -> Result<AliasOutcome> {
    let (kind, external_id) = normalize_alias(kind, external_id)?;
    if store.get_user(user_id).await?.is_none() {
        return Err(anyhow!("user {user_id} does not exist"));
    }
    let existing = store.find_alias(&kind, &external_id).await?;
    let held = existing.as_ref().and_then(|record| {
        Confidence::parse(&record.confidence).map(|confidence| Held {
            user_id: record.user_id.clone(),
            confidence,
        })
    });

    match decide(held.as_ref(), user_id, confidence) {
        Decision::AlreadyHeld => Ok(AliasOutcome::AlreadyHeld),
        Decision::Refused(refusal) => Ok(AliasOutcome::Refused(refusal.message())),
        Decision::Write => {
            let took_a_proof = displaced_a_proof(held.as_ref(), user_id);
            store
                .upsert_alias(&AliasRecord {
                    kind,
                    external_id,
                    user_id: user_id.to_owned(),
                    confidence: confidence.as_str().to_owned(),
                    added_at_epoch_ms: now_ms(),
                })
                .await?;
            Ok(if took_a_proof {
                AliasOutcome::WrittenOverAProof
            } else {
                AliasOutcome::Written
            })
        }
    }
}
/// The gateway prefix every route is served under (`prefix_path` in every
/// config profile). A photo's URL goes straight into an `<img>`, which cannot
/// add it the way an API client does.
const GATEWAY_PREFIX: &str = "/cf";

/// Where a stored photo is served. Anonymous, because an `<img>` sends no
/// token; the digest is what keeps it from being guessed.
pub fn avatar_path(user_id: &str, digest: &str) -> String {
    format!("{GATEWAY_PREFIX}/studio-user/v1/avatars/{user_id}/{digest}")
}

/// The image type the bytes actually are, when it is one a photo may be.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

/// Decide whether a photo may be stored, and as what.
pub fn check_avatar(declared: &str, bytes: &[u8]) -> Result<&'static str, String> {
    let declared = declared.trim().to_ascii_lowercase();
    if !AVATAR_TYPES.contains(&declared.as_str()) {
        return Err(format!(
            "a photo must be one of {}; got {declared}",
            AVATAR_TYPES.join(", ")
        ));
    }
    if bytes.is_empty() {
        return Err("the photo is empty".to_owned());
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(format!(
            "a photo may be at most {} KiB; this one is {} KiB",
            MAX_AVATAR_BYTES / 1024,
            bytes.len().div_ceil(1024)
        ));
    }
    match sniff_image(bytes) {
        Some(actual) if actual == declared => Ok(actual),
        Some(actual) => Err(format!("the photo is {actual}, not {declared}")),
        None => Err("the photo is not an image of a supported type".to_owned()),
    }
}

/// Trim every field, drop the empty ones, and refuse the oversized.
pub fn check_directory(profile: DirectoryProfile) -> Result<DirectoryProfile, String> {
    let field = |name: &str, value: Option<String>| -> Result<Option<String>, String> {
        let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        match value {
            Some(v) if v.chars().count() > MAX_DIRECTORY_FIELD => Err(format!(
                "{name} may be at most {MAX_DIRECTORY_FIELD} characters"
            )),
            other => Ok(other),
        }
    };
    let reports_to = profile
        .reports_to
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    if let Some(manager) = reports_to.as_deref()
        && Uuid::parse_str(manager).is_err()
    {
        return Err("reports_to must be a user id".to_owned());
    }
    Ok(DirectoryProfile {
        affiliation: field("affiliation", profile.affiliation)?,
        department: field("department", profile.department)?,
        title: field("title", profile.title)?,
        reports_to,
    })
}

/// Every address a person can be reached at, strongest claim kept.
///
/// The profile's comes first and is primary when present; then each
/// sign-in's, as the identity provider holds it; then each attributed `email`
/// identity. An address met twice keeps its first source and is verified if
/// either sighting was.
pub fn person_emails(
    profile_email: Option<&str>,
    logins: &[LoginView],
    aliases: &[AliasRecord],
) -> Vec<PersonEmail> {
    let mut out: Vec<PersonEmail> = Vec::new();
    let mut add = |address: &str, source: &'static str, verified: bool| {
        let address = address.trim().to_lowercase();
        if address.is_empty() {
            return;
        }
        if let Some(known) = out.iter_mut().find(|e| e.address == address) {
            known.verified |= verified;
        } else {
            out.push(PersonEmail {
                address,
                source,
                verified,
                primary: false,
            });
        }
    };
    if let Some(email) = profile_email {
        add(email, "profile", false);
    }
    for login in logins {
        if let Some(email) = login.email.as_deref() {
            add(email, "sign_in", login.email_verified);
        }
    }
    for alias in aliases.iter().filter(|a| a.kind == "email") {
        add(&alias.external_id, "alias", alias.confidence == "confirmed");
    }
    let primary = out
        .iter()
        .position(|e| e.source == "profile")
        .or_else(|| out.iter().position(|e| e.verified))
        .or(if out.is_empty() { None } else { Some(0) });
    if let Some(index) = primary {
        out[index].primary = true;
    }
    out
}

#[cfg(test)]
mod people_profile_tests {
    use super::*;

    fn login(email: Option<&str>, verified: bool) -> LoginView {
        LoginView {
            provider: PROVIDER_KEYCLOAK.to_owned(),
            subject: "s".to_owned(),
            user_id: "u".to_owned(),
            verified: true,
            linked_at_epoch_ms: 0,
            email: email.map(str::to_owned),
            email_verified: verified,
        }
    }

    fn alias(kind: &str, id: &str, confidence: &str) -> AliasRecord {
        AliasRecord {
            kind: kind.to_owned(),
            external_id: id.to_owned(),
            user_id: "u".to_owned(),
            confidence: confidence.to_owned(),
            added_at_epoch_ms: 0,
        }
    }

    #[test]
    fn a_person_with_several_sign_ins_has_several_addresses() {
        let emails = person_emails(
            Some("Ada@Work.example"),
            &[
                login(Some("ada@work.example"), true),
                login(Some("ada@home.example"), false),
                login(None, false),
            ],
            &[
                alias("email", "ada@commits.example", "confirmed"),
                alias("github", "ada", "confirmed"),
                alias("email", "maybe@ada.example", "suggested"),
            ],
        );
        let seen: Vec<_> = emails
            .iter()
            .map(|e| (e.address.as_str(), e.source, e.verified, e.primary))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("ada@work.example", "profile", true, true),
                ("ada@home.example", "sign_in", false, false),
                ("ada@commits.example", "alias", true, false),
                ("maybe@ada.example", "alias", false, false),
            ]
        );
    }

    #[test]
    fn without_a_profile_address_the_first_verified_one_is_primary() {
        let emails = person_emails(
            None,
            &[
                login(Some("first@x.example"), false),
                login(Some("second@x.example"), true),
            ],
            &[],
        );
        assert!(!emails[0].primary);
        assert!(emails[1].primary);
        assert!(person_emails(None, &[], &[]).is_empty());
    }

    #[test]
    fn a_photo_is_what_its_bytes_say() {
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        assert_eq!(check_avatar("image/png", &png), Ok("image/png"));
        assert_eq!(check_avatar(" IMAGE/PNG ", &png), Ok("image/png"));
        assert!(check_avatar("image/jpeg", &png).is_err());
        assert!(check_avatar("image/svg+xml", b"<svg/>").is_err());
        assert!(check_avatar("image/png", b"not an image").is_err());
        assert!(check_avatar("image/png", &[]).is_err());
        let mut big = png.clone();
        big.resize(MAX_AVATAR_BYTES + 1, 0);
        assert!(check_avatar("image/png", &big).is_err());
        let webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        assert_eq!(check_avatar("image/webp", &webp), Ok("image/webp"));
    }

    #[test]
    fn a_directory_entry_is_trimmed_and_bounded() {
        let checked = check_directory(DirectoryProfile {
            affiliation: Some("  Acronis ".to_owned()),
            department: Some("   ".to_owned()),
            title: None,
            reports_to: Some(" 6f1c3a52-1111-4222-8333-944455556666 ".to_owned()),
        })
        .unwrap();
        assert_eq!(checked.affiliation.as_deref(), Some("Acronis"));
        assert_eq!(checked.department, None);
        assert_eq!(
            checked.reports_to.as_deref(),
            Some("6f1c3a52-1111-4222-8333-944455556666")
        );
        assert!(
            check_directory(DirectoryProfile {
                title: Some("x".repeat(MAX_DIRECTORY_FIELD + 1)),
                ..DirectoryProfile::default()
            })
            .is_err()
        );
        assert!(
            check_directory(DirectoryProfile {
                reports_to: Some("max".to_owned()),
                ..DirectoryProfile::default()
            })
            .is_err()
        );
    }

    #[test]
    fn a_photo_is_served_under_the_gateway_prefix() {
        assert_eq!(
            avatar_path("u-1", "abc"),
            "/cf/studio-user/v1/avatars/u-1/abc"
        );
    }
}

/// Fold a kind or an external identifier into its stored form.
///
/// Provider logins are compared case-insensitively — GitHub resolves `Alice`
/// and `alice` to the same account, and a claim typed with different casing
/// than the connector reported must not read as a second identity. Applied on
/// every path in and out, so a lookup cannot miss a row a write normalized.
#[must_use]
pub fn normalize_key(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Set the profile's name and address where it has none; `true` when either
/// changed. A value the profile already holds is the person's, and stays.
fn fill_blanks(profile: &mut UserProfile, display_name: Option<&str>, email: Option<&str>) -> bool {
    let given = |v: Option<&str>| {
        v.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let blank = |v: &Option<String>| v.as_deref().is_none_or(|s| s.trim().is_empty());
    let mut changed = false;
    if blank(&profile.display_name)
        && let Some(name) = given(display_name)
    {
        profile.display_name = Some(name);
        changed = true;
    }
    if blank(&profile.email)
        && let Some(address) = given(email)
    {
        profile.email = Some(address);
        changed = true;
    }
    changed
}

/// Normalize and bounds-check an alias key.
///
/// These ceilings are the only bound: `kind` and `external_id` are unbounded
/// `TEXT` in `migrations`, with no `CHECK` behind them, so an oversized value
/// is refused here, as a 400, or not at all.
fn normalize_alias(kind: &str, external_id: &str) -> Result<(String, String)> {
    let kind = normalize_key(kind);
    let external_id = normalize_key(external_id);
    if kind.is_empty() || kind.len() > 40 {
        return Err(anyhow!("kind must be 1..=40 characters"));
    }
    if external_id.is_empty() || external_id.len() > 320 {
        return Err(anyhow!("external_id must be 1..=320 characters"));
    }
    Ok((kind, external_id))
}

#[cfg(test)]
mod idp_channel_tests {
    use std::sync::Mutex;

    use super::*;
    use crate::identity_directory::FederatedAccount;
    use crate::user_profile::store::IdentityStore;

    const PERSON: &str = "11111111-1111-1111-1111-111111111111";
    const SUBJECT_A: &str = "kc-subject-a";
    const SUBJECT_B: &str = "kc-subject-b";

    /// Just enough store for the ceremony: the person's logins, and the alias
    /// slot it writes into. Everything else is not on this path, and saying so
    /// with `unimplemented!` keeps the fake from quietly answering a question
    /// the real store would answer differently.
    struct Logins {
        logins: Vec<(&'static str, &'static str)>,
        aliases: Mutex<Vec<AliasRecord>>,
    }

    impl Logins {
        fn with(logins: Vec<(&'static str, &'static str)>) -> Arc<Self> {
            Arc::new(Self {
                logins,
                aliases: Mutex::new(Vec::new()),
            })
        }
        fn written(&self) -> Vec<(String, String)> {
            self.aliases
                .lock()
                .expect("lock")
                .iter()
                .map(|a| (a.kind.clone(), a.external_id.clone()))
                .collect()
        }
    }

    #[async_trait::async_trait]
    impl IdentityStore for Logins {
        async fn ui_preferences_of(&self, _user_id: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn set_ui_preferences(&self, _user_id: &str, _json: Option<&str>) -> Result<bool> {
            Ok(true)
        }
        async fn logins_of(&self, _user_id: &str) -> Result<Vec<LoginView>> {
            Ok(self
                .logins
                .iter()
                .map(|(provider, subject)| LoginView {
                    provider: (*provider).to_owned(),
                    subject: (*subject).to_owned(),
                    user_id: PERSON.to_owned(),
                    verified: true,
                    linked_at_epoch_ms: 0,
                    email: None,
                    email_verified: false,
                })
                .collect())
        }
        async fn get_user(&self, id: &str) -> Result<Option<UserProfile>> {
            Ok(Some(UserProfile {
                id: id.to_owned(),
                ..UserProfile::default()
            }))
        }
        async fn find_alias(&self, kind: &str, external_id: &str) -> Result<Option<AliasRecord>> {
            Ok(self
                .aliases
                .lock()
                .expect("lock")
                .iter()
                .find(|a| a.kind == kind && a.external_id == external_id)
                .cloned())
        }
        async fn upsert_alias(&self, alias: &AliasRecord) -> Result<()> {
            let mut held = self.aliases.lock().expect("lock");
            held.retain(|a| !(a.kind == alias.kind && a.external_id == alias.external_id));
            held.push(alias.clone());
            Ok(())
        }

        async fn find_login(&self, _p: &str, _s: &str) -> Result<Option<LoginView>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn upsert_user(&self, _profile: &UserProfile) -> Result<()> {
            unimplemented!("not on the ceremony's path")
        }
        async fn upsert_login(&self, _login: &LoginView) -> Result<()> {
            unimplemented!("not on the ceremony's path")
        }
        async fn upsert_membership(&self, _m: &MembershipView) -> Result<()> {
            unimplemented!("not on the ceremony's path")
        }
        async fn memberships_of(&self, _user_id: &str) -> Result<Vec<MembershipView>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn memberships_in_org(&self, _org_id: &str) -> Result<Vec<MembershipView>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn delete_membership(&self, _user_id: &str, _org_id: &str) -> Result<()> {
            unimplemented!("not on the ceremony's path")
        }
        async fn aliases_of(&self, _user_id: &str) -> Result<Vec<AliasRecord>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn find_aliases(&self, _k: &str, _ids: &[String]) -> Result<Vec<AliasRecord>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn delete_alias(&self, _kind: &str, _external_id: &str) -> Result<()> {
            unimplemented!("not on the ceremony's path")
        }
        async fn insert_invitation(&self, _i: &InvitationRecord) -> Result<()> {
            unimplemented!("not on the ceremony's path")
        }
        async fn find_invitation_by_id(&self, _id: &str) -> Result<Option<InvitationRecord>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn find_invitation_by_digest(&self, _d: &str) -> Result<Option<InvitationRecord>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn invitations_of_org(&self, _org: &str) -> Result<Vec<InvitationRecord>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn invitations_for_email(&self, _email: &str) -> Result<Vec<InvitationRecord>> {
            unimplemented!("not on the ceremony's path")
        }
        async fn accept_invitation(&self, _id: &str, _user: &str) -> Result<bool> {
            unimplemented!("not on the ceremony's path")
        }
        async fn delete_invitation(&self, _id: &str, _org: &str) -> Result<bool> {
            unimplemented!("not on the ceremony's path")
        }
    }

    /// The IdP, answering per subject. Records which subjects were asked about.
    struct Broker {
        accounts: Vec<(&'static str, Vec<FederatedAccount>)>,
        asked: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl IdpDirectoryReader for Broker {
        async fn federated_accounts(&self, subject: &str) -> anyhow::Result<Vec<FederatedAccount>> {
            self.asked.lock().expect("lock").push(subject.to_owned());
            Ok(self
                .accounts
                .iter()
                .find(|(s, _)| *s == subject)
                .map(|(_, accounts)| accounts.clone())
                .unwrap_or_default())
        }

        async fn verified_email(&self, _subject: &str) -> anyhow::Result<Option<String>> {
            unimplemented!("not on the ceremony's path")
        }
    }

    fn account(provider: &str, user_name: &str) -> FederatedAccount {
        FederatedAccount {
            provider: provider.to_owned(),
            user_id: "provider-side-id".to_owned(),
            user_name: user_name.to_owned(),
        }
    }

    #[tokio::test]
    async fn every_login_the_person_holds_is_asked_about() {
        // The reason this walks logins instead of the current token: two
        // brokered providers, one on each of the person's Keycloak logins, and
        // both are proofs they own (ADR-0025).
        let store = Logins::with(vec![
            (PROVIDER_KEYCLOAK, SUBJECT_A),
            (PROVIDER_KEYCLOAK, SUBJECT_B),
        ]);
        let broker = Broker {
            accounts: vec![
                (SUBJECT_A, vec![account("github", "Alice")]),
                (SUBJECT_B, vec![account("gitlab", "alice-gl")]),
            ],
            asked: Mutex::new(Vec::new()),
        };
        let mut report = ConfirmReport::default();
        IdentityService::confirm_from_idp(store.as_ref(), PERSON, &broker, &mut report)
            .await
            .expect("ceremony ran");

        assert_eq!(
            broker.asked.lock().expect("lock").as_slice(),
            [SUBJECT_A, SUBJECT_B]
        );
        // Normalized on the way in, so a later lookup by handle cannot miss it.
        assert_eq!(
            store.written(),
            vec![
                ("github".to_owned(), "alice".to_owned()),
                ("gitlab".to_owned(), "alice-gl".to_owned()),
            ]
        );
        assert_eq!(report.confirmed.len(), 2);
    }

    #[tokio::test]
    async fn only_a_realm_login_has_brokered_accounts_to_read() {
        let store = Logins::with(vec![("github", "direct-github-subject")]);
        let broker = Broker {
            accounts: vec![],
            asked: Mutex::new(Vec::new()),
        };
        let mut report = ConfirmReport::default();
        IdentityService::confirm_from_idp(store.as_ref(), PERSON, &broker, &mut report)
            .await
            .expect("ceremony ran");

        assert!(broker.asked.lock().expect("lock").is_empty());
        assert!(report.confirmed.is_empty());
    }

    #[tokio::test]
    async fn a_broker_with_no_handle_is_reported_not_attributed() {
        // Proof of control over an account nothing else can name. There is
        // nothing for an attribution to match, so it is counted, not written.
        let store = Logins::with(vec![(PROVIDER_KEYCLOAK, SUBJECT_A)]);
        let broker = Broker {
            accounts: vec![(SUBJECT_A, vec![account("microsoft", "  ")])],
            asked: Mutex::new(Vec::new()),
        };
        let mut report = ConfirmReport::default();
        IdentityService::confirm_from_idp(store.as_ref(), PERSON, &broker, &mut report)
            .await
            .expect("ceremony ran");

        assert_eq!(report.skipped_no_handle, 1);
        assert!(report.confirmed.is_empty());
        assert!(store.written().is_empty());
    }

    #[tokio::test]
    async fn an_identity_already_proved_is_reported_rather_than_rewritten() {
        // The overlap case: the same GitHub account confirmed by a connector
        // credential and by the brokered login.
        let store = Logins::with(vec![(PROVIDER_KEYCLOAK, SUBJECT_A)]);
        let broker = Broker {
            accounts: vec![(SUBJECT_A, vec![account("github", "alice")])],
            asked: Mutex::new(Vec::new()),
        };
        let mut first = ConfirmReport::default();
        IdentityService::confirm_from_idp(store.as_ref(), PERSON, &broker, &mut first)
            .await
            .expect("ceremony ran");
        let mut again = ConfirmReport::default();
        IdentityService::confirm_from_idp(store.as_ref(), PERSON, &broker, &mut again)
            .await
            .expect("ceremony ran");

        assert_eq!(first.confirmed.len(), 1);
        assert_eq!(again.already_confirmed, 1);
        assert!(again.confirmed.is_empty());
        assert_eq!(store.written().len(), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(display_name: Option<&str>, email: Option<&str>) -> UserProfile {
        UserProfile {
            id: "p".into(),
            display_name: display_name.map(str::to_owned),
            email: email.map(str::to_owned),
            avatar_url: None,
            locale: None,
            created_at_epoch_ms: 0,
            updated_at_epoch_ms: 0,
            merged_into: None,
            last_seen_at_epoch_ms: None,
        }
    }

    /// An assignment names a person the members screen would otherwise call
    /// "Person 1a2b3c4d" — a blank name, or one that is only spaces, is filled.
    #[test]
    fn an_assignment_fills_a_nameless_profile() {
        let mut p = profile(None, Some("  "));
        assert!(fill_blanks(
            &mut p,
            Some(" Denis Kortunov "),
            Some("d@example.com")
        ));
        assert_eq!(p.display_name.as_deref(), Some("Denis Kortunov"));
        assert_eq!(p.email.as_deref(), Some("d@example.com"));
    }

    /// What the person typed into their own profile outranks the IdP.
    #[test]
    fn an_assignment_never_renames_somebody() {
        let mut p = profile(Some("Den"), Some("mine@example.com"));
        assert!(!fill_blanks(
            &mut p,
            Some("Denis Kortunov"),
            Some("idp@example.com")
        ));
        assert_eq!(p.display_name.as_deref(), Some("Den"));
        assert_eq!(p.email.as_deref(), Some("mine@example.com"));
        assert!(!fill_blanks(&mut profile(None, None), Some(" "), None));
    }

    fn prefs(pairs: &[(&str, &str)]) -> UiPreferences {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn an_ordinary_set_of_choices_is_accepted() {
        assert!(
            check_ui_preferences(&prefs(&[
                ("projects.view", "tiles"),
                ("organization.workspaces.view", "table"),
                ("specs.view", "tiles"),
            ]))
            .is_ok()
        );
        // Nothing chosen is a state, not a mistake.
        assert!(check_ui_preferences(&UiPreferences::new()).is_ok());
    }

    #[test]
    fn a_key_outside_the_charset_is_refused() {
        // The charset is closed so a key is always safe in a log line, a URL
        // or a CSS selector without anyone having to wonder.
        for bad in ["Projects.View", "projects view", "projects/view", "проекты"] {
            assert!(
                check_ui_preferences(&prefs(&[(bad, "tiles")])).is_err(),
                "{bad} should be refused"
            );
        }
        assert!(check_ui_preferences(&prefs(&[("", "tiles")])).is_err());
    }

    #[test]
    fn the_bag_may_not_grow_into_a_database() {
        let many: UiPreferences = (0..=MAX_UI_PREFERENCES)
            .map(|i| (format!("k{i}"), "x".to_owned()))
            .collect();
        assert!(check_ui_preferences(&many).is_err());

        let long_key = "k".repeat(MAX_UI_PREFERENCE_KEY + 1);
        assert!(check_ui_preferences(&prefs(&[(&long_key, "x")])).is_err());

        let long_value = "v".repeat(MAX_UI_PREFERENCE_VALUE + 1);
        assert!(check_ui_preferences(&prefs(&[("projects.view", &long_value)])).is_err());
    }

    #[test]
    fn the_limits_are_stated_in_the_refusal() {
        // The message goes straight to a 400 and the reader is a developer.
        let long_value = "v".repeat(MAX_UI_PREFERENCE_VALUE + 1);
        let why =
            check_ui_preferences(&prefs(&[("projects.view", &long_value)])).expect_err("too long");
        assert!(why.contains("projects.view"), "{why}");
        assert!(why.contains(&MAX_UI_PREFERENCE_VALUE.to_string()), "{why}");
    }

    #[test]
    fn a_stored_document_nobody_can_read_is_no_preferences_rather_than_an_error() {
        // A row written by a future version, or by a hand at the psql prompt,
        // must not make the profile endpoint refuse to answer: losing a
        // remembered choice is a nuisance, a 500 on every page load is not.
        assert_eq!(parse_ui_preferences(None), UiPreferences::new());
        assert_eq!(parse_ui_preferences(Some("not json")), UiPreferences::new());
        assert_eq!(parse_ui_preferences(Some("[1,2,3]")), UiPreferences::new());
        assert_eq!(
            parse_ui_preferences(Some(r#"{"projects.view":{"nested":true}}"#)),
            UiPreferences::new()
        );
    }

    #[test]
    fn a_stored_document_round_trips() {
        let chosen = prefs(&[("projects.view", "tiles"), ("sources.view", "table")]);
        let stored = serde_json::to_string(&chosen).expect("serializes");
        assert_eq!(parse_ui_preferences(Some(&stored)), chosen);
    }

    #[test]
    fn an_alias_key_is_normalized_before_it_is_stored() {
        let (kind, external_id) = normalize_alias(" GitHub ", " Alice ").expect("valid");
        assert_eq!(kind, "github");
        assert_eq!(external_id, "alice");
    }

    #[test]
    fn an_empty_or_oversized_alias_key_is_rejected_before_the_database_sees_it() {
        assert!(normalize_alias("", "alice").is_err());
        assert!(normalize_alias("github", "  ").is_err());
        assert!(normalize_alias(&"g".repeat(41), "alice").is_err());
        assert!(normalize_alias("github", &"a".repeat(321)).is_err());
    }
}

#[cfg(test)]
mod service_account_tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;
    use crate::user_profile::{STUDIO_SERVICE_SUBJECT, ServiceAccount};

    /// Logins and profiles in memory, and NOTHING ELSE: a membership write
    /// panics, which is what proves the seed never joins an organization.
    #[derive(Default)]
    struct People {
        logins: Mutex<HashMap<(String, String), LoginView>>,
        users: Mutex<HashMap<String, UserProfile>>,
    }

    #[async_trait::async_trait]
    impl IdentityStore for People {
        async fn find_login(&self, p: &str, s: &str) -> Result<Option<LoginView>> {
            Ok(self
                .logins
                .lock()
                .unwrap()
                .get(&(p.to_owned(), s.to_owned()))
                .cloned())
        }
        async fn get_user(&self, id: &str) -> Result<Option<UserProfile>> {
            Ok(self.users.lock().unwrap().get(id).cloned())
        }
        async fn upsert_user(&self, profile: &UserProfile) -> Result<()> {
            self.users
                .lock()
                .unwrap()
                .insert(profile.id.clone(), profile.clone());
            Ok(())
        }
        async fn upsert_login(&self, login: &LoginView) -> Result<()> {
            self.logins.lock().unwrap().insert(
                (login.provider.clone(), login.subject.clone()),
                login.clone(),
            );
            Ok(())
        }
        async fn ui_preferences_of(&self, _u: &str) -> Result<Option<String>> {
            unimplemented!()
        }
        async fn set_ui_preferences(&self, _u: &str, _j: Option<&str>) -> Result<bool> {
            unimplemented!()
        }
        async fn logins_of(&self, _u: &str) -> Result<Vec<LoginView>> {
            unimplemented!()
        }
        async fn upsert_membership(&self, _m: &MembershipView) -> Result<()> {
            panic!("the service identity was given a membership")
        }
        async fn memberships_of(&self, _u: &str) -> Result<Vec<MembershipView>> {
            unimplemented!()
        }
        async fn memberships_in_org(&self, _o: &str) -> Result<Vec<MembershipView>> {
            unimplemented!()
        }
        async fn delete_membership(&self, _u: &str, _o: &str) -> Result<()> {
            unimplemented!()
        }
        async fn upsert_alias(&self, _a: &AliasRecord) -> Result<()> {
            unimplemented!()
        }
        async fn aliases_of(&self, _u: &str) -> Result<Vec<AliasRecord>> {
            unimplemented!()
        }
        async fn find_alias(&self, _k: &str, _e: &str) -> Result<Option<AliasRecord>> {
            unimplemented!()
        }
        async fn find_aliases(&self, _k: &str, _e: &[String]) -> Result<Vec<AliasRecord>> {
            unimplemented!()
        }
        async fn delete_alias(&self, _k: &str, _e: &str) -> Result<()> {
            unimplemented!()
        }
        async fn insert_invitation(&self, _i: &InvitationRecord) -> Result<()> {
            unimplemented!()
        }
        async fn find_invitation_by_digest(&self, _d: &str) -> Result<Option<InvitationRecord>> {
            unimplemented!()
        }
        async fn find_invitation_by_id(&self, _i: &str) -> Result<Option<InvitationRecord>> {
            unimplemented!()
        }
        async fn invitations_of_org(&self, _o: &str) -> Result<Vec<InvitationRecord>> {
            unimplemented!()
        }
        async fn invitations_for_email(&self, _e: &str) -> Result<Vec<InvitationRecord>> {
            unimplemented!()
        }
        async fn accept_invitation(&self, _i: &str, _u: &str) -> Result<bool> {
            unimplemented!()
        }
        async fn delete_invitation(&self, _i: &str, _o: &str) -> Result<bool> {
            unimplemented!()
        }
    }

    /// The subject a shared session names as its actor resolves to a person
    /// called "Constructor Studio (service)" — and that person holds nothing.
    #[tokio::test]
    async fn the_session_actor_is_a_person_the_directory_can_name() {
        let store = People::default();
        let account = ServiceAccount::default();
        let person = seed_service_account_in(&store, &account)
            .await
            .expect("seeded");

        let login = store
            .find_login(PROVIDER_KEYCLOAK, STUDIO_SERVICE_SUBJECT)
            .await
            .unwrap()
            .expect("the session's actor has a login");
        assert_eq!(login.user_id, person);
        let profile = store.get_user(&person).await.unwrap().expect("a profile");
        assert_eq!(
            profile.display_name.as_deref(),
            Some("Constructor Studio (service)")
        );
        assert_eq!(profile.email.as_deref(), Some("studio@constructor.tech"));
    }

    /// The subject is fixed in the realm files, so the backend never asks
    /// Keycloak for it. Both realms must say the same, or the session's actor
    /// silently names nobody.
    #[test]
    fn both_realms_give_the_service_account_the_subject_the_backend_uses() {
        for (file, realm) in [
            (
                "keycloak/realm-studio.json",
                include_str!("../../../keycloak/realm-studio.json"),
            ),
            (
                "docker/keycloak/realm-studio.json",
                include_str!("../../../docker/keycloak/realm-studio.json"),
            ),
        ] {
            let realm: serde_json::Value = serde_json::from_str(realm).expect("realm json");
            let user = realm["users"]
                .as_array()
                .and_then(|users| {
                    users
                        .iter()
                        .find(|u| u["serviceAccountClientId"] == "studio-service")
                })
                .unwrap_or_else(|| panic!("{file}: no service account for studio-service"));
            assert_eq!(user["id"], STUDIO_SERVICE_SUBJECT, "{file}");
            let client = realm["clients"]
                .as_array()
                .and_then(|c| c.iter().find(|c| c["clientId"] == "studio-service"))
                .unwrap_or_else(|| panic!("{file}: no studio-service client"));
            assert_eq!(
                client["standardFlowEnabled"], false,
                "{file}: a browser may not sign in as it"
            );
            assert_eq!(
                client["directAccessGrantsEnabled"], false,
                "{file}: nobody may sign in as it with a password"
            );
            assert!(
                user.get("clientRoles").is_none() && user.get("realmRoles").is_none(),
                "{file}: it holds no roles"
            );
        }
    }

    /// Run at every start: the same person each time, kept in step with the
    /// configuration, and never a second one.
    #[tokio::test]
    async fn seeding_again_is_the_same_person_with_the_configured_name() {
        let store = People::default();
        let first = seed_service_account_in(&store, &ServiceAccount::default())
            .await
            .unwrap();
        let renamed = ServiceAccount {
            display_name: "Acme Studio (service)".into(),
            ..ServiceAccount::default()
        };
        let second = seed_service_account_in(&store, &renamed).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(store.users.lock().unwrap().len(), 1);
        assert_eq!(
            store
                .get_user(&first)
                .await
                .unwrap()
                .unwrap()
                .display_name
                .as_deref(),
            Some("Acme Studio (service)")
        );
    }
}
