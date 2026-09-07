//! Identity service: the canonical user, its sign-in methods, memberships and
//! aliases, plus the mapper that turns a token subject into a stable Studio user
//! id. Storage is relational (see `store`); this layer holds the logic.
//!
//! Authority note: per-organization operations (membership) are gated on being
//! an OWNER of that organization, resolved here from Account Management's access
//! config — a platform-wide admin is not required, and one org's owner cannot
//! reach another org. Cross-org identity operations (merge) stay a narrow
//! platform action.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use account_management_sdk::AccountManagementClient;
use anyhow::{Result, anyhow};
use gts::GtsTypeId;
use serde::Deserialize;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::store::IdentityStore;

/// AM tenant-metadata type holding an organization's access config (the same
/// document the Studio PDP reads).
const ACCESS_METADATA_TYPE: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

/// Confidence of an alias attribution. `suggested` is a hypothesis and grants
/// nothing; only `confirmed` is trusted.
pub const ALIAS_CONFIRMED: &str = "confirmed";
pub const ALIAS_SUGGESTED: &str = "suggested";

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
}

impl IdentityService {
    pub(crate) fn new(store: Arc<dyn IdentityStore>, am: Arc<dyn AccountManagementClient>) -> Self {
        Self { store, am }
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

    /// Attribute a non-login external identifier to a user.
    pub async fn add_alias(
        &self,
        user_id: &str,
        kind: &str,
        external_id: &str,
        confidence: &str,
    ) -> Result<()> {
        if self.store.get_user(user_id).await?.is_none() {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        let confidence = if confidence == ALIAS_CONFIRMED {
            ALIAS_CONFIRMED
        } else {
            ALIAS_SUGGESTED
        };
        self.store
            .upsert_alias(&AliasRecord {
                kind: kind.to_owned(),
                external_id: external_id.to_owned(),
                user_id: user_id.to_owned(),
                confidence: confidence.to_owned(),
                added_at_epoch_ms: now_ms(),
            })
            .await
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
