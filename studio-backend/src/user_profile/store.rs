//! The identity store: a typed repository over the gear's four tables.
//!
//! Relational, not a graph — a person's account is looked up and constrained,
//! not traversed. All rows live in the platform-root partition, so every query
//! is scoped to it through toolkit-db's secure runner (the framework never
//! hands out a raw connection).

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
use super::service::{AliasRecord, InvitationRecord, LoginView, MembershipView, UserProfile};

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
    async fn upsert_login(&self, login: &LoginView) -> Result<()>;
    async fn logins_of(&self, user_id: &str) -> Result<Vec<LoginView>>;
    async fn upsert_membership(&self, m: &MembershipView) -> Result<()>;
    async fn memberships_of(&self, user_id: &str) -> Result<Vec<MembershipView>>;
    /// Everybody in one organization. The last-owner rule needs to see the
    /// whole room, not one person's side of it.
    async fn memberships_in_org(&self, org_id: &str) -> Result<Vec<MembershipView>>;
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
    }
}
fn login_to_view(m: entity::login::Model) -> LoginView {
    LoginView {
        provider: m.provider,
        subject: m.subject,
        user_id: m.user_id.to_string(),
        verified: m.verified,
        linked_at_epoch_ms: to_ms(m.linked_at),
    }
}
fn membership_to_view(m: entity::membership::Model) -> MembershipView {
    MembershipView {
        user_id: m.user_id.to_string(),
        org_id: m.org_id.to_string(),
        role: m.role,
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
            merged_into: ActiveValue::Set(merged),
            created_at: ActiveValue::Set(from_ms(profile.created_at_epoch_ms)),
            updated_at: ActiveValue::Set(from_ms(profile.updated_at_epoch_ms)),
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
            source: ActiveValue::Set(m.source.clone()),
            created_at: ActiveValue::Set(from_ms(m.created_at_epoch_ms)),
            updated_at: ActiveValue::Set(from_ms(m.updated_at_epoch_ms)),
        };
        let on_conflict = SecureOnConflict::<entity::membership::Entity>::columns([
            entity::membership::Column::Id,
        ])
        .update_columns([
            entity::membership::Column::Role,
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
}
