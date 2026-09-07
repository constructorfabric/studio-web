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
use gts::GtsTypeId;
use serde::Deserialize;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::alias_policy::{Confidence, Decision, Held, decide, displaced_a_proof};
use super::store::IdentityStore;
use crate::connectors::service::ConnectorService;

/// AM tenant-metadata type holding an organization's access config (the same
/// document the Studio PDP reads).
const ACCESS_METADATA_TYPE: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

/// A connection whose scope makes it a team or bot credential rather than the
/// caller's own. `ConnectionScope::Personal` serialises as this string.
const PERSONAL_SCOPE: &str = "personal";

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

// ── Access config (subset; mirrors the PDP's view) ───────────────────────────

#[derive(Debug, Clone, Deserialize, Default)]
struct AccessConfig {
    #[serde(default)]
    grants: Vec<GrantDef>,
}
#[derive(Debug, Clone, Deserialize)]
struct GrantDef {
    #[serde(rename = "subjectType")]
    subject_type: String,
    #[serde(rename = "subjectId")]
    subject_id: String,
    #[serde(rename = "roleKey")]
    role_key: String,
    #[serde(rename = "scopeType")]
    scope_type: String,
}

// ── Service ──────────────────────────────────────────────────────────────────

pub struct IdentityService {
    store: Arc<dyn IdentityStore>,
    am: Arc<dyn AccountManagementClient>,
    /// Attached in the gear's REST phase, once every connector driver plugin is
    /// known to have registered. `Some(None)` means no driver at all, which
    /// makes the confirmation ceremony unavailable while claims and reads keep
    /// working; `None` means the phase has not run yet.
    connectors: OnceLock<Option<Arc<ConnectorService>>>,
}

impl IdentityService {
    pub(crate) fn new(store: Arc<dyn IdentityStore>, am: Arc<dyn AccountManagementClient>) -> Self {
        Self {
            store,
            am,
            connectors: OnceLock::new(),
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

    /// Is the caller an OWNER of `org_id`? Read from that organization's access
    /// config — the same owner grant the Studio PDP recognizes. This is the
    /// per-org authority gate: no platform-wide admin needed, and it is scoped
    /// to the one organization.
    pub async fn is_org_owner(&self, ctx: &SecurityContext, org_id: Uuid) -> bool {
        let subject = ctx.subject_id().to_string();
        let cfg = match self
            .am
            .resolve_metadata(ctx, org_id, GtsTypeId::new(ACCESS_METADATA_TYPE))
            .await
        {
            Ok(Some(entry)) => {
                serde_json::from_value::<AccessConfig>(entry.value).unwrap_or_default()
            }
            _ => return false,
        };
        cfg.grants.iter().any(|g| {
            g.subject_type == "member"
                && g.subject_id == subject
                && g.role_key == "owner"
                && g.scope_type == "org"
        })
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
        let (kind, external_id) = normalize_alias(kind, external_id)?;
        if self.store.get_user(user_id).await?.is_none() {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        let existing = self.store.find_alias(&kind, &external_id).await?;
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
                self.store
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

    /// Turn the caller's own connector credentials into confirmed aliases.
    ///
    /// This is the proof of control (ADR-0012). Every connection in the
    /// catalogue already passed `ConnectorDriver::test()`, which asked the
    /// provider "who am I?" with that credential and stored the answer in
    /// `Connection.account`. A personal connection is therefore standing proof
    /// that its creator controls that account, and this call only records it:
    /// nothing is re-probed and no token is read.
    pub async fn confirm_aliases_from_connections(
        &self,
        ctx: &SecurityContext,
        user_id: &str,
        tenant: Uuid,
    ) -> Result<ConfirmReport> {
        let Some(connectors) = self.connectors.get().and_then(Option::as_ref) else {
            return Err(anyhow!(
                "no connector driver plugin is registered, so there is no credential to confirm \
                 an identity with"
            ));
        };
        let subject = ctx.subject_id().to_string();
        let mut report = ConfirmReport::default();

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
            if connection.created_by.trim().is_empty() {
                // Written before the record named its creator. There is a proof
                // but nothing says whose, and guessing is the failure this whole
                // flow exists to avoid.
                report.skipped_unknown_owner += 1;
                continue;
            }
            if connection.created_by != subject {
                // Somebody else's proof is theirs to record.
                report.skipped_other_owner += 1;
                continue;
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
        Ok(report)
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
    /// Refusals from the write policy, in the policy's own words.
    pub refused: Vec<String>,
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
