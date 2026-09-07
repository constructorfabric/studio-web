//! Persistence for studio-identity over `toolkit_db` (sea-orm), scoped to the
//! organization tenant. Mirrors the secure-CRUD shape of `studio-documents`:
//! `.secure().scope_with(..)` for reads, `.secure().scope_unchecked(..)` for
//! writes the service has already authorized, and an `ON CONFLICT (id)` upsert.
//!
//! Every method here answers one question and does no folding — the policy
//! lives entirely in [`super::resolve`].

use std::sync::Arc;

use anyhow::Result;
use sea_orm::{ColumnTrait, Condition, EntityTrait, IntoActiveModel, QueryFilter};
use toolkit_db::DBProvider;
use toolkit_db::secure::{SecureEntityExt, SecureInsertExt, SecureOnConflict};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::entity::{Column, Entity, Model};

/// UUIDv5 namespace for a journal row's deterministic id. Makes
/// `(tenant, provider, account, subject, kind)` the primary key, so repeating
/// the same act is an upsert rather than a duplicate row.
const CLAIM_NS: Uuid = Uuid::from_u128(0x4f2b_8c17_9a63_4d05_b1e8_37ca_6d94_02f1);

/// Deterministic id of one act by one subject on one account.
#[must_use]
pub fn claim_row_id(
    tenant: Uuid,
    provider: &str,
    account: &str,
    subject: &str,
    kind: i16,
) -> Uuid {
    Uuid::new_v5(
        &CLAIM_NS,
        format!("{tenant}|{provider}|{account}|{subject}|{kind}").as_bytes(),
    )
}

pub struct IdentityRepo {
    db: Arc<DBProvider<anyhow::Error>>,
}

impl IdentityRepo {
    pub fn new(db: Arc<DBProvider<anyhow::Error>>) -> Self {
        Self { db }
    }

    /// Append a journal row, or touch the identical earlier one.
    ///
    /// `observed_at` moving forward is the point: it is what makes a
    /// re-verification win over an intervening revocation, and what keeps
    /// suggestion generation idempotent.
    pub async fn record(&self, model: Model) -> Result<()> {
        let conn = self.db.conn()?;
        let tenant = model.tenant_id;
        let on_conflict = SecureOnConflict::<Entity>::columns([Column::Id]).update_columns([
            Column::Method,
            Column::Evidence,
            Column::Author,
            Column::ObservedAt,
        ])?;
        Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(tenant))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Every row about one external account, by every subject.
    ///
    /// Deliberately not filtered by caller: resolution cannot tell whether an
    /// account is contested, or already proven by somebody else, from one
    /// subject's rows (see the `no_owner` note in `entity`).
    pub async fn for_account(
        &self,
        tenant: Uuid,
        provider: &str,
        account: &str,
    ) -> Result<Vec<Model>> {
        let conn = self.db.conn()?;
        let rows = Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(Column::Provider.eq(provider))
                    .add(Column::Account.eq(account)),
            )
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// The rows one subject has written or been suggested for — used only to
    /// learn *which* accounts concern them, not to decide anything.
    pub async fn of_subject(&self, tenant: Uuid, subject: &str) -> Result<Vec<Model>> {
        let conn = self.db.conn()?;
        let rows = Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(Column::Subject.eq(subject)))
            .all(&conn)
            .await?;
        Ok(rows)
    }

    /// Every row for the named accounts.
    ///
    /// Filtered on `account` alone, so it over-fetches when two providers use
    /// the same login. The service groups by `(provider, account)` afterwards
    /// and drops what it did not ask for; the alternative — a tuple `IN` — buys
    /// nothing at the handful of accounts one person claims.
    pub async fn for_accounts(&self, tenant: Uuid, accounts: &[String]) -> Result<Vec<Model>> {
        if accounts.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn()?;
        let rows = Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(Column::Account.is_in(accounts.iter().cloned())))
            .all(&conn)
            .await?;
        Ok(rows)
    }
}
