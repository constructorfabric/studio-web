//! Identity service: the canonical user, its sign-in methods, memberships and
//! aliases, plus the mapper that turns a token subject into a stable Studio user
//! id. Storage is relational (see `store`); this layer holds the logic.
//!
//! Authority note: per-organization operations (membership) are gated on being
//! an OWNER of that organization, resolved here from Account Management's access
//! config — a platform-wide admin is not required, and one org's owner cannot
//! reach another org. Cross-org identity operations (merge) stay a narrow
//! platform action.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use account_management_sdk::AccountManagementClient;
use anyhow::{Result, anyhow};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::alias_policy::{
    Confidence, Decision, Held, ProofOwner, decide, displaced_a_proof, proof_owner,
};
use super::store::IdentityStore;
use crate::connectors::service::ConnectorService;
use crate::identity_directory::FederatedIdentityReader;

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
}

/// A sign-in method resolved to a user.
#[derive(Clone, Debug)]
pub struct LoginView {
    pub provider: String,
    pub subject: String,
    pub user_id: String,
    pub verified: bool,
    pub linked_at_epoch_ms: i64,
}

/// A person's membership in one organization, carrying the role held there.
#[derive(Clone, Debug)]
pub struct MembershipView {
    pub user_id: String,
    pub org_id: String,
    pub role: String,
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
    federated: OnceLock<Option<Arc<dyn FederatedIdentityReader>>>,
}

impl IdentityService {
    pub(crate) fn new(store: Arc<dyn IdentityStore>, am: Arc<dyn AccountManagementClient>) -> Self {
        Self {
            store,
            am,
            connectors: OnceLock::new(),
            federated: OnceLock::new(),
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

    /// Hand the service its view of the IdP's brokered logins.
    ///
    /// Separate from `new` for the same reason as `attach_connectors`: the
    /// directory gear is a separate gear, and the REST phase is the first point
    /// where it is known to have registered.
    pub fn attach_federated(&self, federated: Option<Arc<dyn FederatedIdentityReader>>) {
        let _ = self.federated.set(federated);
    }

    /// Is the caller an OWNER of `org_id`? Read from that organization's access
    /// config — the same owner grant the Studio PDP recognizes. This is the
    /// per-org authority gate: no platform-wide admin needed, and it is scoped
    /// to the one organization.
    pub async fn is_org_owner(&self, ctx: &SecurityContext, org_id: Uuid) -> bool {
        crate::access_config::read(self.am.as_ref(), ctx, org_id)
            .await
            .grants_ownership_to(&ctx.subject_id().to_string())
    }

    /// The canonical person behind an authenticated caller, provisioning on
    /// first sight.
    ///
    /// The one way a Studio gear turns "who is calling" into "which person", so
    /// that no consumer re-derives it from the token and no two consumers key
    /// the same human differently (ADR-0014). The subject comes off a bearer the
    /// platform has already authenticated, which is both why provisioning here
    /// is safe and why the login is recorded as verified.
    pub async fn resolve_caller(&self, ctx: &SecurityContext) -> Result<String> {
        let subject = ctx.subject_id().to_string();
        self.resolve_or_provision(PROVIDER_KEYCLOAK, &subject, None, None, true)
            .await
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
        };
        self.store.upsert_user(&profile).await?;
        let login = LoginView {
            provider: provider.to_owned(),
            subject: subject.to_owned(),
            user_id: user_id.clone(),
            verified,
            linked_at_epoch_ms: now,
        };
        self.store.upsert_login(&login).await?;
        Ok(user_id)
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
    /// ADR-0014):
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
    /// (ADR-0014).
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
            // proof, and the proof is theirs under either (ADR-0014).
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
    /// which is the whole point of one person holding several logins (ADR-0014).
    ///
    /// The alias is keyed on the provider handle rather than the provider's
    /// numeric id, because the handle is what the artefacts being attributed
    /// carry: a commit names an author, not an account id. A handle renamed at
    /// the provider is therefore a re-confirmation rather than a silent break —
    /// the old row keeps pointing at this person until something displaces it.
    async fn confirm_from_idp(
        store: &dyn IdentityStore,
        user_id: &str,
        federated: &dyn FederatedIdentityReader,
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
    pub async fn record_membership(
        &self,
        user_id: &str,
        org_id: &str,
        role: &str,
        source: &str,
    ) -> Result<MembershipView> {
        if self.store.get_user(user_id).await?.is_none() {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        let now = now_ms();
        let view = MembershipView {
            user_id: user_id.to_owned(),
            org_id: org_id.to_owned(),
            role: role.to_owned(),
            source: source.to_owned(),
            // On an update the stored created_at is preserved (the store's
            // conflict update excludes it); this value seeds a first insert.
            created_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        self.store.upsert_membership(&view).await?;
        Ok(view)
    }

    /// Record that the identity `subject` belongs to `org_id` holding `role`.
    ///
    /// The assignment path's entry point (ADR-0016). It provisions a person if
    /// this login has never been seen, which is the right call *here* and not in
    /// `resolve_recorded_subject`: this subject comes from the IdP's own user
    /// list, so the identity demonstrably exists — where a subject read out of
    /// some other gear's column demonstrates nothing.
    pub async fn record_assignment(&self, subject: &str, org_id: Uuid, role: &str) -> Result<()> {
        let user_id = self
            .resolve_or_provision(PROVIDER_KEYCLOAK, subject, None, None, true)
            .await?;
        self.record_membership(&user_id, &org_id.to_string(), role, SOURCE_ASSIGNMENT)
            .await?;
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

    /// Remove a person's membership in an organization.
    pub async fn remove_membership(&self, user_id: &str, org_id: &str) -> Result<()> {
        self.store.delete_membership(user_id, org_id).await
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
            self.store
                .delete_membership(from_user, &membership.org_id)
                .await?;
            result.memberships_moved += 1;
        }

        source.merged_into = Some(into_user.to_owned());
        source.updated_at_epoch_ms = now_ms();
        self.store.upsert_user(&source).await?;
        Ok(result)
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

/// Normalize and bounds-check an alias key.
///
/// The ceilings match the `CHECK` constraints in `migrations`, so an oversized
/// value is a 400 from the service rather than a 500 from the database.
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
    }

    /// The IdP, answering per subject. Records which subjects were asked about.
    struct Broker {
        accounts: Vec<(&'static str, Vec<FederatedAccount>)>,
        asked: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl FederatedIdentityReader for Broker {
        async fn federated_accounts(&self, subject: &str) -> anyhow::Result<Vec<FederatedAccount>> {
            self.asked.lock().expect("lock").push(subject.to_owned());
            Ok(self
                .accounts
                .iter()
                .find(|(s, _)| *s == subject)
                .map(|(_, accounts)| accounts.clone())
                .unwrap_or_default())
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
        // both are proofs they own (ADR-0014).
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
