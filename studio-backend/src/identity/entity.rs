//! `SeaORM` entity for the identity claim journal.
//!
//! One table, scoped by the organization tenant (ADR-0012 §6). Rows are
//! appended, never edited in place: a claim, a verification and a revocation are
//! three rows, and resolution reads whichever is newest per subject
//! ([`super::resolve`]).
//!
//! `id` is not a surrogate. It is the deterministic v5 UUID of
//! `(tenant, provider, account, subject, kind)` (see [`super::repo::claim_row_id`]),
//! which makes the primary key itself the uniqueness constraint on the act and
//! gives the recording upsert an `ON CONFLICT` target without a second index.
//! Repeating the *same* act therefore touches `observed_at` instead of growing
//! the table — which is what makes re-running suggestion generation idempotent.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "studio_identity_claims")]
// `no_owner`: `subject` is the person a row is ABOUT, not an authorization
// dimension. Resolution has to see every subject's rows for an account —
// answering "is this account contested?" or "did somebody else already prove
// control?" is impossible from your own rows alone — so letting the scope
// builder filter on the caller would silently break the policy. The tenant is
// the boundary; visibility inside it is decided by the queries in `repo`.
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    /// Deterministic v5 UUID of `(tenant, provider, account, subject, kind)`.
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// Organization tenant that owns this journal row.
    pub tenant_id: Uuid,
    /// Driver key, normalized: `github` | `gitlab` | `bitbucket` | `keycloak`.
    pub provider: String,
    /// Provider-native login/username, normalized (`resolve::normalize`).
    pub account: String,
    /// Studio platform subject (`ctx.subject_id()`), or
    /// `resolve::EXCLUDED_SUBJECT` for a bot or shared credential.
    pub subject: String,
    /// `resolve::Kind` as stored — 0 suggested, 1 claimed, 2 verified, 3 revoked.
    pub kind: i16,
    /// How the row came about: `connector-pat`, `connector-shared`,
    /// `self-assert`, `login-match`, … Free text on purpose; the *strength* of
    /// the row lives in `kind`, and only `kind` decides anything.
    pub method: String,
    /// JSON blob describing what was actually observed, for a later dispute.
    pub evidence: String,
    /// Subject that wrote the row; empty for the system (a suggestion).
    pub author: String,
    pub observed_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
