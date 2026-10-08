//! The identity store: a typed repository over the gear's four tables.
//!
//! Relational, not a graph — a person's account is looked up and constrained,
//! not traversed. All rows live in the platform-root partition, so every query
//! is scoped to it through toolkit-db's secure runner (the framework never
//! hands out a raw connection).

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, QueryFilter};
use time::OffsetDateTime;
use toolkit_db::DBProvider;
use toolkit_db::secure::{
    SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureOnConflict, SecureUpdateExt,
};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::entity::{self, ROOT_TENANT};
use super::service::{
    AliasRecord, AvatarRecord, DirectoryProfile, InvitationRecord, LoginView, MembershipView,
    UserProfile,
};

fn scope() -> AccessScope {
    AccessScope::for_tenant(ROOT_TENANT)
}

fn to_ms(dt: OffsetDateTime) -> i64 {
    (dt.unix_timestamp_nanos() / 1_000_000) as i64
}
fn from_ms(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos((ms as i128) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}
fn parse_uuid(s: &str) -> Result<Uuid> {
    Uuid::parse_str(s).map_err(|e| anyhow!("invalid uuid '{s}': {e}"))
}

/// Where identity records live. One typed method per access the service needs.
#[async_trait]
pub(crate) trait IdentityStore: Send + Sync {
    async fn find_login(&self, provider: &str, subject: &str) -> Result<Option<LoginView>>;
    async fn get_user(&self, id: &str) -> Result<Option<UserProfile>>;
    async fn upsert_user(&self, profile: &UserProfile) -> Result<()>;
    /// The user's remembered UI choices, as the JSON document last stored.
    /// `None` when they have made none.
    async fn ui_preferences_of(&self, user_id: &str) -> Result<Option<String>>;
    /// Replace them wholesale. Deliberately not part of [`Self::upsert_user`]:
    /// that runs on every sign-in from a profile assembled out of the identity
    /// provider's claims, which knows nothing about UI choices and would blank
    /// them on each login.
    async fn set_ui_preferences(&self, user_id: &str, json: Option<&str>) -> Result<bool>;
    async fn upsert_login(&self, login: &LoginView) -> Result<()>;
    async fn logins_of(&self, user_id: &str) -> Result<Vec<LoginView>>;
    async fn upsert_membership(&self, m: &MembershipView) -> Result<()>;
    async fn memberships_of(&self, user_id: &str) -> Result<Vec<MembershipView>>;
    /// Everybody in one organization. The last-owner rule needs to see the
    /// whole room, not one person's side of it.
    async fn memberships_in_org(&self, org_id: &str) -> Result<Vec<MembershipView>>;
    /// Every organization at least one person holds a membership of, each
    /// once. For an administrative walk over every organization's access
    /// config (the grant rekey, ADR-0040 §5), never for a request path.
    async fn organizations_with_members(&self) -> Result<Vec<String>>;
    async fn delete_membership(&self, user_id: &str, org_id: &str) -> Result<()>;
    async fn upsert_alias(&self, alias: &AliasRecord) -> Result<()>;
    async fn aliases_of(&self, user_id: &str) -> Result<Vec<AliasRecord>>;
    /// The row that attributes one external identity, if any.
    ///
    /// The reverse direction of `aliases_of`, and the one the write policy and
    /// the knowledge-graph attribution both need: `aliases_of` can only answer
    /// "what does this user hold", never "who holds this account".
    async fn find_alias(&self, kind: &str, external_id: &str) -> Result<Option<AliasRecord>>;
    /// Bulk `find_alias` for one kind — the graph sync keys a whole contributor
    /// list before writing any of it.
    async fn find_aliases(&self, kind: &str, external_ids: &[String]) -> Result<Vec<AliasRecord>>;
    async fn delete_alias(&self, kind: &str, external_id: &str) -> Result<()>;

    async fn insert_invitation(&self, invitation: &InvitationRecord) -> Result<()>;
    /// The invitation a token identifies, whatever state it is in.
    ///
    /// State is not filtered here on purpose: the policy decides what "expired"
    /// and "used" mean to a caller, and a store that hid them would make those
    /// two indistinguishable from "no such invitation".
    async fn find_invitation_by_digest(&self, digest: &str) -> Result<Option<InvitationRecord>>;
    /// The invitation with this id, whatever state it is in.
    ///
    /// The other way in, for a person the server has already matched to an
    /// invitation by a verified address — they never saw the token, and the
    /// listing that showed it to them proved as much as the token would.
    async fn find_invitation_by_id(&self, id: &str) -> Result<Option<InvitationRecord>>;
    async fn invitations_of_org(&self, org_id: &str) -> Result<Vec<InvitationRecord>>;
    /// Pending, unexpired invitations for one address.
    async fn invitations_for_email(&self, email: &str) -> Result<Vec<InvitationRecord>>;
    /// Mark one accepted, but only if it is still open.
    ///
    /// Returns whether this call was the one that took it. Single use has to be
    /// decided by the database, not by a check followed by a write: two
    /// acceptances racing would both pass the check.
    async fn accept_invitation(&self, id: &str, user_id: &str) -> Result<bool>;
    async fn delete_invitation(&self, id: &str, org_id: &str) -> Result<bool>;

    // The methods below came with `m0005`. Each has a body so a test double
    // that has no use for them need not spell them out; the Postgres store
    // overrides every one.

    /// Record what the identity provider said about one sign-in's address.
    /// Separate from [`Self::upsert_login`], which knows nothing about it.
    async fn set_login_email(
        &self,
        _provider: &str,
        _subject: &str,
        _email: Option<&str>,
        _verified: bool,
    ) -> Result<()> {
        Ok(())
    }
    /// Every sign-in of any of these people, for a listing that would
    /// otherwise ask once per person.
    async fn logins_of_many(&self, user_ids: &[String]) -> Result<Vec<LoginView>> {
        let mut all = Vec::new();
        for id in user_ids {
            all.extend(self.logins_of(id).await?);
        }
        Ok(all)
    }
    /// Every alias of any of these people; see [`Self::logins_of_many`].
    async fn aliases_of_many(&self, user_ids: &[String]) -> Result<Vec<AliasRecord>> {
        let mut all = Vec::new();
        for id in user_ids {
            all.extend(self.aliases_of(id).await?);
        }
        Ok(all)
    }
    /// Record that the person made a request at `at_ms`.
    async fn touch_last_seen(&self, _user_id: &str, _at_ms: i64) -> Result<()> {
        Ok(())
    }
    /// How one organization describes its people, by user id. Members it has
    /// not described are absent.
    async fn directory_in_org(&self, _org_id: &str) -> Result<HashMap<String, DirectoryProfile>> {
        Ok(HashMap::new())
    }
    /// Replace how the organization describes one member. `false` when the
    /// person holds no membership there.
    async fn set_directory(
        &self,
        _user_id: &str,
        _org_id: &str,
        _profile: &DirectoryProfile,
    ) -> Result<bool> {
        Ok(false)
    }
    async fn put_avatar(&self, _user_id: &str, _avatar: &AvatarRecord) -> Result<()> {
        Err(anyhow!("this store keeps no photos"))
    }
    async fn avatar_of(&self, _user_id: &str) -> Result<Option<AvatarRecord>> {
        Ok(None)
    }
    async fn delete_avatar(&self, _user_id: &str) -> Result<bool> {
        Ok(false)
    }
}

// ── conversions (row -> view) ─────────────────────────────────────────────

fn user_to_view(m: entity::user::Model) -> UserProfile {
    UserProfile {
        id: m.id.to_string(),
        display_name: m.display_name,
        email: m.email,
        avatar_url: m.avatar_url,
        locale: m.locale,
        created_at_epoch_ms: to_ms(m.created_at),
        updated_at_epoch_ms: to_ms(m.updated_at),
        merged_into: m.merged_into.map(|u| u.to_string()),
        last_seen_at_epoch_ms: m.last_seen_at.map(to_ms),
    }
}
fn login_to_view(m: entity::login::Model) -> LoginView {
    LoginView {
        provider: m.provider,
        subject: m.subject,
        user_id: m.user_id.to_string(),
        verified: m.verified,
        linked_at_epoch_ms: to_ms(m.linked_at),
        email: m.email,
        email_verified: m.email_verified,
    }
}
fn membership_to_view(m: entity::membership::Model) -> MembershipView {
    MembershipView {
        user_id: m.user_id.to_string(),
        org_id: m.org_id.to_string(),
        role: m.role,
        status: m.status,
        source: m.source,
        created_at_epoch_ms: to_ms(m.created_at),
        updated_at_epoch_ms: to_ms(m.updated_at),
    }
}
fn alias_to_record(m: entity::alias::Model) -> AliasRecord {
    AliasRecord {
        kind: m.kind,
        external_id: m.external_id,
        user_id: m.user_id.to_string(),
        confidence: m.confidence,
        added_at_epoch_ms: to_ms(m.added_at),
    }
}

// ── Postgres store ────────────────────────────────────────────────────────

pub struct PgStore {
    db: Arc<DBProvider<anyhow::Error>>,
}

impl PgStore {
    #[must_use]
    pub fn new(db: Arc<DBProvider<anyhow::Error>>) -> Self {
        Self { db }
    }
}

fn invitation_to_view(m: entity::invitation::Model) -> InvitationRecord {
    InvitationRecord {
        id: m.id.to_string(),
        org_id: m.org_id.to_string(),
        email: m.email,
        role: m.role,
        token_digest: m.token_digest,
        invited_by: m.invited_by.to_string(),
        created_at_epoch_ms: to_ms(m.created_at),
        expires_at_epoch_ms: to_ms(m.expires_at),
        accepted_at_epoch_ms: m.accepted_at.map(to_ms),
    }
}

#[async_trait]
impl IdentityStore for PgStore {
    async fn find_login(&self, provider: &str, subject: &str) -> Result<Option<LoginView>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let id = entity::login_id(provider, subject);
        Ok(entity::login::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::login::Column::Id.eq(id)))
            .one(&conn)
            .await?
            .map(login_to_view))
    }

    async fn get_user(&self, id: &str) -> Result<Option<UserProfile>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let uid = parse_uuid(id)?;
        Ok(entity::user::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::user::Column::Id.eq(uid)))
            .one(&conn)
            .await?
            .map(user_to_view))
    }

    async fn upsert_user(&self, profile: &UserProfile) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let merged = match profile.merged_into.as_deref() {
            Some(s) => Some(parse_uuid(s)?),
            None => None,
        };
        let am = entity::user::ActiveModel {
            id: ActiveValue::Set(parse_uuid(&profile.id)?),
            tenant_id: ActiveValue::Set(ROOT_TENANT),
            display_name: ActiveValue::Set(profile.display_name.clone()),
            email: ActiveValue::Set(profile.email.clone()),
            avatar_url: ActiveValue::Set(profile.avatar_url.clone()),
            locale: ActiveValue::Set(profile.locale.clone()),
            // Untouched here, and absent from `update_columns` below, so a
            // sign-in never clears what the person chose in the UI.
            ui_preferences: ActiveValue::NotSet,
            merged_into: ActiveValue::Set(merged),
            created_at: ActiveValue::Set(from_ms(profile.created_at_epoch_ms)),
            updated_at: ActiveValue::Set(from_ms(profile.updated_at_epoch_ms)),
            // Written only by `touch_last_seen`, like `ui_preferences`.
            last_seen_at: ActiveValue::NotSet,
        };
        let on_conflict =
            SecureOnConflict::<entity::user::Entity>::columns([entity::user::Column::Id])
                .update_columns([
                    entity::user::Column::DisplayName,
                    entity::user::Column::Email,
                    entity::user::Column::AvatarUrl,
                    entity::user::Column::Locale,
                    entity::user::Column::MergedInto,
                    entity::user::Column::UpdatedAt,
                ])
                .map_err(|e| anyhow!("user upsert conflict: {e}"))?;
        entity::user::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope())
            .map_err(|e| anyhow!("user insert scope: {e}"))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn ui_preferences_of(&self, user_id: &str) -> Result<Option<String>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::user::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::user::Column::Id.eq(parse_uuid(user_id)?)))
            .one(&conn)
            .await?
            .and_then(|m| m.ui_preferences))
    }

    async fn set_ui_preferences(&self, user_id: &str, json: Option<&str>) -> Result<bool> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        // A targeted UPDATE rather than a read-modify-write: two tabs saving
        // different preferences should leave one of them winning, not a row
        // rebuilt from whichever read happened first.
        let result = entity::user::Entity::update_many()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::user::Column::Id.eq(parse_uuid(user_id)?)))
            .col_expr(
                entity::user::Column::UiPreferences,
                sea_orm::sea_query::Expr::value(json.map(str::to_owned)),
            )
            .col_expr(
                entity::user::Column::UpdatedAt,
                sea_orm::sea_query::Expr::value(OffsetDateTime::now_utc()),
            )
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    async fn upsert_login(&self, login: &LoginView) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let am = entity::login::ActiveModel {
            id: ActiveValue::Set(entity::login_id(&login.provider, &login.subject)),
            tenant_id: ActiveValue::Set(ROOT_TENANT),
            provider: ActiveValue::Set(login.provider.clone()),
            subject: ActiveValue::Set(login.subject.clone()),
            user_id: ActiveValue::Set(parse_uuid(&login.user_id)?),
            verified: ActiveValue::Set(login.verified),
            linked_at: ActiveValue::Set(from_ms(login.linked_at_epoch_ms)),
            // Written only by `set_login_email`: a re-link must not forget
            // what the provider said.
            email: ActiveValue::NotSet,
            email_verified: ActiveValue::NotSet,
        };
        let on_conflict =
            SecureOnConflict::<entity::login::Entity>::columns([entity::login::Column::Id])
                .update_columns([
                    entity::login::Column::UserId,
                    entity::login::Column::Verified,
                    entity::login::Column::LinkedAt,
                ])
                .map_err(|e| anyhow!("login upsert conflict: {e}"))?;
        entity::login::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope())
            .map_err(|e| anyhow!("login insert scope: {e}"))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn logins_of(&self, user_id: &str) -> Result<Vec<LoginView>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let uid = parse_uuid(user_id)?;
        Ok(entity::login::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::login::Column::UserId.eq(uid)))
            .all(&conn)
            .await?
            .into_iter()
            .map(login_to_view)
            .collect())
    }

    async fn upsert_membership(&self, m: &MembershipView) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let uid = parse_uuid(&m.user_id)?;
        let org = parse_uuid(&m.org_id)?;
        let am = entity::membership::ActiveModel {
            id: ActiveValue::Set(entity::membership_id(uid, org)),
            tenant_id: ActiveValue::Set(ROOT_TENANT),
            user_id: ActiveValue::Set(uid),
            org_id: ActiveValue::Set(org),
            role: ActiveValue::Set(m.role.clone()),
            status: ActiveValue::Set(m.status.clone()),
            source: ActiveValue::Set(m.source.clone()),
            created_at: ActiveValue::Set(from_ms(m.created_at_epoch_ms)),
            updated_at: ActiveValue::Set(from_ms(m.updated_at_epoch_ms)),
            // Written only by `set_directory`: a role change must not erase
            // how the organization describes the person.
            affiliation: ActiveValue::NotSet,
            department: ActiveValue::NotSet,
            title: ActiveValue::NotSet,
            reports_to: ActiveValue::NotSet,
        };
        let on_conflict = SecureOnConflict::<entity::membership::Entity>::columns([
            entity::membership::Column::Id,
        ])
        .update_columns([
            entity::membership::Column::Role,
            entity::membership::Column::Status,
            entity::membership::Column::Source,
            entity::membership::Column::UpdatedAt,
        ])
        .map_err(|e| anyhow!("membership upsert conflict: {e}"))?;
        entity::membership::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope())
            .map_err(|e| anyhow!("membership insert scope: {e}"))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn memberships_of(&self, user_id: &str) -> Result<Vec<MembershipView>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let uid = parse_uuid(user_id)?;
        Ok(entity::membership::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::membership::Column::UserId.eq(uid)))
            .all(&conn)
            .await?
            .into_iter()
            .map(membership_to_view)
            .collect())
    }

    async fn memberships_in_org(&self, org_id: &str) -> Result<Vec<MembershipView>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::membership::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::membership::Column::OrgId.eq(parse_uuid(org_id)?)))
            .all(&conn)
            .await?
            .into_iter()
            .map(membership_to_view)
            .collect())
    }

    async fn organizations_with_members(&self) -> Result<Vec<String>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        // The whole table, folded in memory: an administrative walk run once
        // per environment over a table of one row per person per organization.
        let orgs: std::collections::BTreeSet<String> = entity::membership::Entity::find()
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
            .into_iter()
            .map(|m| m.org_id.to_string())
            .collect();
        Ok(orgs.into_iter().collect())
    }

    async fn delete_membership(&self, user_id: &str, org_id: &str) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let uid = parse_uuid(user_id)?;
        let org = parse_uuid(org_id)?;
        entity::membership::Entity::delete_many()
            .filter(
                Condition::all()
                    .add(entity::membership::Column::Id.eq(entity::membership_id(uid, org))),
            )
            .secure()
            .scope_with(&scope())
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn upsert_alias(&self, alias: &AliasRecord) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let am = entity::alias::ActiveModel {
            id: ActiveValue::Set(entity::alias_id(&alias.kind, &alias.external_id)),
            tenant_id: ActiveValue::Set(ROOT_TENANT),
            kind: ActiveValue::Set(alias.kind.clone()),
            external_id: ActiveValue::Set(alias.external_id.clone()),
            user_id: ActiveValue::Set(parse_uuid(&alias.user_id)?),
            confidence: ActiveValue::Set(alias.confidence.clone()),
            added_at: ActiveValue::Set(from_ms(alias.added_at_epoch_ms)),
        };
        let on_conflict =
            SecureOnConflict::<entity::alias::Entity>::columns([entity::alias::Column::Id])
                .update_columns([
                    entity::alias::Column::UserId,
                    entity::alias::Column::Confidence,
                    entity::alias::Column::AddedAt,
                ])
                .map_err(|e| anyhow!("alias upsert conflict: {e}"))?;
        entity::alias::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope())
            .map_err(|e| anyhow!("alias insert scope: {e}"))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn aliases_of(&self, user_id: &str) -> Result<Vec<AliasRecord>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let uid = parse_uuid(user_id)?;
        Ok(entity::alias::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::alias::Column::UserId.eq(uid)))
            .all(&conn)
            .await?
            .into_iter()
            .map(alias_to_record)
            .collect())
    }

    async fn find_alias(&self, kind: &str, external_id: &str) -> Result<Option<AliasRecord>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        // Addressed by primary key: the id IS the v5 of (kind, external_id), so
        // this is a point lookup and needs no second index.
        Ok(entity::alias::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(
                Condition::all()
                    .add(entity::alias::Column::Id.eq(entity::alias_id(kind, external_id))),
            )
            .one(&conn)
            .await?
            .map(alias_to_record))
    }

    async fn find_aliases(&self, kind: &str, external_ids: &[String]) -> Result<Vec<AliasRecord>> {
        if external_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        // By primary key again, so one indexed `IN` rather than a scan over the
        // kind. Ids are derived here, which also means a caller cannot smuggle
        // in a row of a different kind.
        let ids: Vec<_> = external_ids
            .iter()
            .map(|external_id| entity::alias_id(kind, external_id))
            .collect();
        Ok(entity::alias::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::alias::Column::Id.is_in(ids)))
            .all(&conn)
            .await?
            .into_iter()
            .map(alias_to_record)
            .collect())
    }

    async fn delete_alias(&self, kind: &str, external_id: &str) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        entity::alias::Entity::delete_many()
            .filter(
                Condition::all()
                    .add(entity::alias::Column::Id.eq(entity::alias_id(kind, external_id))),
            )
            .secure()
            .scope_with(&scope())
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn insert_invitation(&self, invitation: &InvitationRecord) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let am = entity::invitation::ActiveModel {
            id: ActiveValue::Set(parse_uuid(&invitation.id)?),
            tenant_id: ActiveValue::Set(ROOT_TENANT),
            org_id: ActiveValue::Set(parse_uuid(&invitation.org_id)?),
            email: ActiveValue::Set(invitation.email.clone()),
            role: ActiveValue::Set(invitation.role.clone()),
            token_digest: ActiveValue::Set(invitation.token_digest.clone()),
            invited_by: ActiveValue::Set(parse_uuid(&invitation.invited_by)?),
            created_at: ActiveValue::Set(from_ms(invitation.created_at_epoch_ms)),
            expires_at: ActiveValue::Set(from_ms(invitation.expires_at_epoch_ms)),
            accepted_at: ActiveValue::Set(None),
            accepted_by: ActiveValue::Set(None),
        };
        entity::invitation::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope())
            .map_err(|e| anyhow!("invitation insert scope: {e}"))?
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn find_invitation_by_id(&self, id: &str) -> Result<Option<InvitationRecord>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::invitation::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::invitation::Column::Id.eq(parse_uuid(id)?)))
            .one(&conn)
            .await?
            .map(invitation_to_view))
    }

    async fn find_invitation_by_digest(&self, digest: &str) -> Result<Option<InvitationRecord>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::invitation::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::invitation::Column::TokenDigest.eq(digest)))
            .one(&conn)
            .await?
            .map(invitation_to_view))
    }

    async fn invitations_of_org(&self, org_id: &str) -> Result<Vec<InvitationRecord>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::invitation::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::invitation::Column::OrgId.eq(parse_uuid(org_id)?)))
            .all(&conn)
            .await?
            .into_iter()
            .map(invitation_to_view)
            .collect())
    }

    async fn invitations_for_email(&self, email: &str) -> Result<Vec<InvitationRecord>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::invitation::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(
                Condition::all()
                    .add(entity::invitation::Column::Email.eq(email))
                    .add(entity::invitation::Column::AcceptedAt.is_null())
                    .add(entity::invitation::Column::ExpiresAt.gt(OffsetDateTime::now_utc())),
            )
            .all(&conn)
            .await?
            .into_iter()
            .map(invitation_to_view)
            .collect())
    }

    async fn accept_invitation(&self, id: &str, user_id: &str) -> Result<bool> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        // `accepted_at IS NULL` in the WHERE is what makes this single-use: the
        // database decides who took it, so two acceptances racing cannot both
        // win.
        let result = entity::invitation::Entity::update_many()
            .secure()
            .scope_with(&scope())
            .filter(
                Condition::all()
                    .add(entity::invitation::Column::Id.eq(parse_uuid(id)?))
                    .add(entity::invitation::Column::AcceptedAt.is_null()),
            )
            .col_expr(
                entity::invitation::Column::AcceptedAt,
                sea_orm::sea_query::Expr::value(OffsetDateTime::now_utc()),
            )
            .col_expr(
                entity::invitation::Column::AcceptedBy,
                sea_orm::sea_query::Expr::value(parse_uuid(user_id)?),
            )
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    async fn delete_invitation(&self, id: &str, org_id: &str) -> Result<bool> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        // The organization is in the filter, not only checked beforehand: it is
        // what stops one organization's owner revoking another's invitation.
        let result = entity::invitation::Entity::delete_many()
            .secure()
            .scope_with(&scope())
            .filter(
                Condition::all()
                    .add(entity::invitation::Column::Id.eq(parse_uuid(id)?))
                    .add(entity::invitation::Column::OrgId.eq(parse_uuid(org_id)?)),
            )
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    async fn set_login_email(
        &self,
        provider: &str,
        subject: &str,
        email: Option<&str>,
        verified: bool,
    ) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        entity::login::Entity::update_many()
            .secure()
            .scope_with(&scope())
            .filter(
                Condition::all()
                    .add(entity::login::Column::Id.eq(entity::login_id(provider, subject))),
            )
            .col_expr(
                entity::login::Column::Email,
                sea_orm::sea_query::Expr::value(email.map(str::to_owned)),
            )
            .col_expr(
                entity::login::Column::EmailVerified,
                sea_orm::sea_query::Expr::value(verified),
            )
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn logins_of_many(&self, user_ids: &[String]) -> Result<Vec<LoginView>> {
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let ids = user_ids
            .iter()
            .map(|id| parse_uuid(id))
            .collect::<Result<Vec<_>>>()?;
        Ok(entity::login::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::login::Column::UserId.is_in(ids)))
            .all(&conn)
            .await?
            .into_iter()
            .map(login_to_view)
            .collect())
    }

    async fn aliases_of_many(&self, user_ids: &[String]) -> Result<Vec<AliasRecord>> {
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let ids = user_ids
            .iter()
            .map(|id| parse_uuid(id))
            .collect::<Result<Vec<_>>>()?;
        Ok(entity::alias::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::alias::Column::UserId.is_in(ids)))
            .all(&conn)
            .await?
            .into_iter()
            .map(alias_to_record)
            .collect())
    }

    async fn touch_last_seen(&self, user_id: &str, at_ms: i64) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        entity::user::Entity::update_many()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::user::Column::Id.eq(parse_uuid(user_id)?)))
            .col_expr(
                entity::user::Column::LastSeenAt,
                sea_orm::sea_query::Expr::value(Some(from_ms(at_ms))),
            )
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn directory_in_org(&self, org_id: &str) -> Result<HashMap<String, DirectoryProfile>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::membership::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::membership::Column::OrgId.eq(parse_uuid(org_id)?)))
            .all(&conn)
            .await?
            .into_iter()
            .filter_map(|m| {
                let profile = DirectoryProfile {
                    affiliation: m.affiliation,
                    department: m.department,
                    title: m.title,
                    reports_to: m.reports_to.map(|u| u.to_string()),
                };
                (profile != DirectoryProfile::default()).then(|| (m.user_id.to_string(), profile))
            })
            .collect())
    }

    async fn set_directory(
        &self,
        user_id: &str,
        org_id: &str,
        profile: &DirectoryProfile,
    ) -> Result<bool> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let id = entity::membership_id(parse_uuid(user_id)?, parse_uuid(org_id)?);
        let reports_to = match profile.reports_to.as_deref() {
            Some(s) => Some(parse_uuid(s)?),
            None => None,
        };
        let result = entity::membership::Entity::update_many()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::membership::Column::Id.eq(id)))
            .col_expr(
                entity::membership::Column::Affiliation,
                sea_orm::sea_query::Expr::value(profile.affiliation.clone()),
            )
            .col_expr(
                entity::membership::Column::Department,
                sea_orm::sea_query::Expr::value(profile.department.clone()),
            )
            .col_expr(
                entity::membership::Column::Title,
                sea_orm::sea_query::Expr::value(profile.title.clone()),
            )
            .col_expr(
                entity::membership::Column::ReportsTo,
                sea_orm::sea_query::Expr::value(reports_to),
            )
            .col_expr(
                entity::membership::Column::UpdatedAt,
                sea_orm::sea_query::Expr::value(OffsetDateTime::now_utc()),
            )
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }

    async fn put_avatar(&self, user_id: &str, avatar: &AvatarRecord) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let am = entity::avatar::ActiveModel {
            user_id: ActiveValue::Set(parse_uuid(user_id)?),
            tenant_id: ActiveValue::Set(ROOT_TENANT),
            content_type: ActiveValue::Set(avatar.content_type.clone()),
            bytes: ActiveValue::Set(avatar.bytes.clone()),
            digest: ActiveValue::Set(avatar.digest.clone()),
            updated_at: ActiveValue::Set(from_ms(avatar.updated_at_epoch_ms)),
        };
        let on_conflict =
            SecureOnConflict::<entity::avatar::Entity>::columns([entity::avatar::Column::UserId])
                .update_columns([
                    entity::avatar::Column::ContentType,
                    entity::avatar::Column::Bytes,
                    entity::avatar::Column::Digest,
                    entity::avatar::Column::UpdatedAt,
                ])
                .map_err(|e| anyhow!("avatar upsert conflict: {e}"))?;
        entity::avatar::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope())
            .map_err(|e| anyhow!("avatar insert scope: {e}"))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    async fn avatar_of(&self, user_id: &str) -> Result<Option<AvatarRecord>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::avatar::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::avatar::Column::UserId.eq(parse_uuid(user_id)?)))
            .one(&conn)
            .await?
            .map(|m| AvatarRecord {
                content_type: m.content_type,
                bytes: m.bytes,
                digest: m.digest,
                updated_at_epoch_ms: to_ms(m.updated_at),
            }))
    }

    async fn delete_avatar(&self, user_id: &str) -> Result<bool> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let result = entity::avatar::Entity::delete_many()
            .filter(Condition::all().add(entity::avatar::Column::UserId.eq(parse_uuid(user_id)?)))
            .secure()
            .scope_with(&scope())
            .exec(&conn)
            .await?;
        Ok(result.rows_affected > 0)
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;
