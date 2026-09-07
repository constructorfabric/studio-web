//! studio-identity service: record acts, fold the connector catalogue into
//! verifications, and answer the two questions the gear exists for —
//! "which accounts concern me?" and "who does this account belong to?".
//!
//! All policy is in [`super::resolve`]; this module only decides what may be
//! *written*, and by whom.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use anyhow::{Result, bail};
use time::OffsetDateTime;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::entity::Model;
use super::repo::{IdentityRepo, claim_row_id};
use super::resolve::{
    AccountKey, Binding, Kind, Observation, Resolution, group_by_account, normalize, resolve,
};
use crate::connectors::service::ConnectorService;

/// A connection whose scope makes it a team or bot credential rather than the
/// caller's own. `ConnectionScope::Personal` serialises as this string.
const PERSONAL_SCOPE: &str = "personal";

/// `method` values. The strength of a row is `kind` and only `kind`; these
/// exist so a dispute can be told what was actually seen.
const METHOD_CONNECTOR_PAT: &str = "connector-pat";
const METHOD_SELF_ASSERT: &str = "self-assert";
const METHOD_REVOKE: &str = "self-revoke";

/// One external account as it concerns one person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityView {
    pub provider: String,
    pub account: String,
    /// The caller's own newest assertion about this account.
    pub my_kind: Kind,
    /// The account is bound to the caller — activity is attributed to them.
    pub mine: bool,
    /// Bound to a different subject, so the caller's claim attributes nothing
    /// even if they later verify... until they do, at which point they win
    /// (ADR-0012 §3).
    pub taken_by_other: bool,
    /// Decided to be a bot or shared credential — not a person at all.
    pub excluded: bool,
    /// More than one subject holds a live verification.
    pub contested: bool,
    pub method: String,
    pub observed_at: OffsetDateTime,
}

/// What one fold of the connector catalogue did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VerifyReport {
    /// Accounts the caller now holds a verification for.
    pub verified: Vec<AccountKey>,
    /// Team/bot credentials: a successful `test()` proves control of *an*
    /// account, not of the caller's own, so these are not self-claims
    /// (ADR-0012 §4).
    pub skipped_shared: usize,
    /// Personal connections belonging to someone else. Their proof is theirs to
    /// record; recording it for them would forge a claim.
    pub skipped_other_owner: usize,
    /// Personal connections created before the record named its creator. Whose
    /// they are is unknown, and guessing is exactly the failure mode this gear
    /// exists to avoid.
    pub skipped_unknown_owner: usize,
}

pub struct IdentityService {
    repo: Arc<IdentityRepo>,
    account_management: Arc<dyn AccountManagementClient>,
    /// Attached in the gear's REST phase, once every connector driver plugin is
    /// known to have registered. `Some(None)` means there is no driver at all,
    /// which makes verification unavailable while claims and resolution keep
    /// working; `None` means the phase has not run yet.
    connectors: OnceLock<Option<Arc<ConnectorService>>>,
}

impl IdentityService {
    pub fn new(
        repo: Arc<IdentityRepo>,
        account_management: Arc<dyn AccountManagementClient>,
    ) -> Self {
        Self {
            repo,
            account_management,
            connectors: OnceLock::new(),
        }
    }

    /// Hand the service its view of the connection catalogue.
    ///
    /// Separate from `new` because resolution must be publishable at `init` —
    /// other gears resolve it in their own REST phase — while the catalogue is
    /// only safe to build once every driver plugin has registered. Calling it
    /// twice is ignored rather than fatal: the second view would be equivalent.
    pub fn attach_connectors(&self, connectors: Option<Arc<ConnectorService>>) {
        let _ = self.connectors.set(connectors);
    }

    /// Authorize the caller against a tenant from the request path. Resolving
    /// the tenant under the caller's `SecurityContext` both proves it exists and
    /// delegates hierarchy authorization to account-management — the same guard
    /// `studio-documents` and `studio-kits` put in front of their tenant routes.
    pub async fn authorize(&self, ctx: &SecurityContext, tenant_id: Uuid) -> Result<()> {
        self.account_management
            .get_tenant(ctx, tenant_id)
            .await
            .map_err(|e| anyhow::anyhow!("tenant {tenant_id} not accessible: {e}"))?;
        Ok(())
    }

    // ── writes ───────────────────────────────────────────────────────────────

    /// Record the caller's unproven assertion that an account is theirs.
    ///
    /// Binds nothing (ADR-0012 §1). It exists so the intent survives until a
    /// ceremony can upgrade it, and so the person can see what they have told
    /// us.
    pub async fn claim(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        provider: &str,
        account: &str,
    ) -> Result<()> {
        let (provider, account) = normalize_pair(provider, account)?;
        let subject = ctx.subject_id().to_string();
        self.append(
            tenant,
            &provider,
            &account,
            &subject,
            Kind::Claimed,
            METHOD_SELF_ASSERT,
            &subject,
            "{}",
        )
        .await
    }

    /// Withdraw whatever the caller has said about an account.
    ///
    /// A row, not a delete: the history of who claimed what is the point of a
    /// journal, and a dispute two months from now will ask for it.
    pub async fn revoke(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        provider: &str,
        account: &str,
    ) -> Result<()> {
        let (provider, account) = normalize_pair(provider, account)?;
        let subject = ctx.subject_id().to_string();
        self.append(
            tenant,
            &provider,
            &account,
            &subject,
            Kind::Revoked,
            METHOD_REVOKE,
            &subject,
            "{}",
        )
        .await
    }

    /// Turn the caller's own connector credentials into verifications.
    ///
    /// This is the ceremony (ADR-0012 §2): every connection in the catalogue
    /// already passed `ConnectorDriver::test()`, which asked the provider "who
    /// am I?" with that credential and stored the answer in
    /// `Connection.account`. A personal connection is therefore standing proof
    /// that its creator controls that account, and this call is only the act of
    /// recording it.
    ///
    /// Nothing is re-probed and no token is read: the proof was obtained when
    /// the connection was created.
    pub async fn verify_from_connections(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> Result<VerifyReport> {
        let Some(connectors) = self.connectors.get().and_then(Option::as_ref) else {
            bail!(
                "no connector driver plugin is registered, so there is no credential to verify \
                 an identity with"
            );
        };
        let subject = ctx.subject_id().to_string();
        let connections = connectors.list(ctx, tenant).await?;

        let mut report = VerifyReport::default();
        for connection in connections {
            if connection.account.trim().is_empty() {
                // A provider that reports no account (an AI model key) has no
                // identity to claim.
                continue;
            }
            if connection.scope != PERSONAL_SCOPE {
                report.skipped_shared += 1;
                continue;
            }
            if connection.created_by.trim().is_empty() {
                report.skipped_unknown_owner += 1;
                continue;
            }
            if connection.created_by != subject {
                report.skipped_other_owner += 1;
                continue;
            }

            let Ok((provider, account)) =
                normalize_pair(&connection.provider, &connection.account)
            else {
                continue;
            };
            let evidence = serde_json::json!({
                "connection_id": connection.id,
                "label": connection.label,
                "base_url": connection.base_url,
            })
            .to_string();
            self.append(
                tenant,
                &provider,
                &account,
                &subject,
                Kind::Verified,
                METHOD_CONNECTOR_PAT,
                &subject,
                &evidence,
            )
            .await?;
            report.verified.push(AccountKey { provider, account });
        }
        Ok(report)
    }

    // ── reads ────────────────────────────────────────────────────────────────

    /// Every external account that concerns the caller, with what the caller
    /// has said about it and what the journal makes of it.
    pub async fn my_identities(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> Result<Vec<IdentityView>> {
        let subject = ctx.subject_id().to_string();
        let mine = self.repo.of_subject(tenant, &subject).await?;
        if mine.is_empty() {
            return Ok(Vec::new());
        }

        // Which accounts concern me, and the account names to widen the second
        // query to. The widened read is what lets the view say "somebody else
        // already proved this one".
        let my_keys: BTreeSet<AccountKey> = mine.iter().map(account_key).collect();
        let names: Vec<String> = my_keys
            .iter()
            .map(|key| key.account.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();

        let all = self.repo.for_accounts(tenant, &names).await?;
        let grouped = group_by_account(all.iter().filter_map(observation_of));

        let mut views = Vec::with_capacity(my_keys.len());
        for key in my_keys {
            let Some(rows) = grouped.get(&key) else {
                // Only reachable if the row vanished between the two queries.
                continue;
            };
            let resolution = resolve(rows);
            let Some(my_newest) = newest_of_subject(rows, &subject) else {
                continue;
            };
            // `method`/`observed_at` come from the row, not from the fold, so
            // the view can say *how* the caller's own standing was obtained.
            let source = mine
                .iter()
                .filter(|row| account_key(row) == key)
                .filter(|row| Kind::from_i16(row.kind) == Some(my_newest.kind))
                .max_by_key(|row| row.observed_at);

            views.push(IdentityView {
                provider: key.provider.clone(),
                account: key.account.clone(),
                my_kind: my_newest.kind,
                mine: resolution.binding == Binding::Subject(subject.clone()),
                taken_by_other: matches!(&resolution.binding, Binding::Subject(bound) if bound != &subject),
                excluded: resolution.binding == Binding::Excluded,
                contested: resolution.contested,
                method: source.map(|row| row.method.clone()).unwrap_or_default(),
                observed_at: source.map_or(my_newest.observed_at, |row| row.observed_at),
            });
        }
        Ok(views)
    }

    /// Who one external account belongs to.
    pub async fn resolve_account(
        &self,
        tenant: Uuid,
        provider: &str,
        account: &str,
    ) -> Result<Resolution> {
        let (provider, account) = normalize_pair(provider, account)?;
        let rows = self.repo.for_account(tenant, &provider, &account).await?;
        let observations: Vec<Observation> = rows
            .iter()
            .filter_map(observation_of)
            .map(|(_, observation)| observation)
            .collect();
        Ok(resolve(&observations))
    }

    /// Bindings for many accounts of one provider, in one query.
    ///
    /// The shape the knowledge-graph sync needs: it walks one provider's
    /// contributor list and has to key every person node before writing any of
    /// them. Accounts with no journal row are absent from the map, which the
    /// caller reads as [`Binding::Unbound`].
    pub async fn resolve_bindings(
        &self,
        tenant: Uuid,
        provider: &str,
        accounts: &[String],
    ) -> Result<BTreeMap<String, Binding>> {
        let provider = normalize(provider);
        let names: Vec<String> = accounts.iter().map(|a| normalize(a)).collect();
        let rows = self.repo.for_accounts(tenant, &names).await?;
        let grouped = group_by_account(rows.iter().filter_map(observation_of));
        Ok(grouped
            .into_iter()
            .filter(|(key, _)| key.provider == provider)
            .map(|(key, rows)| (key.account, resolve(&rows).binding))
            .collect())
    }

    // ── internals ────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    async fn append(
        &self,
        tenant: Uuid,
        provider: &str,
        account: &str,
        subject: &str,
        kind: Kind,
        method: &str,
        author: &str,
        evidence: &str,
    ) -> Result<()> {
        let kind_value = kind.as_i16();
        self.repo
            .record(Model {
                id: claim_row_id(tenant, provider, account, subject, kind_value),
                tenant_id: tenant,
                provider: provider.to_owned(),
                account: account.to_owned(),
                subject: subject.to_owned(),
                kind: kind_value,
                method: method.to_owned(),
                evidence: evidence.to_owned(),
                author: author.to_owned(),
                observed_at: OffsetDateTime::now_utc(),
            })
            .await
    }
}

/// Normalize and bounds-check a `(provider, account)` pair.
///
/// The length ceilings match the `CHECK` constraints in `migrations`, so a
/// too-long value is a 400 from the service rather than a 500 from the database.
fn normalize_pair(provider: &str, account: &str) -> Result<(String, String)> {
    let provider = normalize(provider);
    let account = normalize(account);
    if provider.is_empty() || provider.len() > 40 {
        bail!("provider must be 1..=40 characters");
    }
    if account.is_empty() || account.len() > 320 {
        bail!("account must be 1..=320 characters");
    }
    Ok((provider, account))
}

fn account_key(row: &Model) -> AccountKey {
    AccountKey {
        provider: row.provider.clone(),
        account: row.account.clone(),
    }
}

/// A stored row as resolution reads it. A `kind` this build does not know (a
/// row written by a newer version) is dropped rather than guessed at.
fn observation_of(row: &Model) -> Option<(AccountKey, Observation)> {
    Some((
        account_key(row),
        Observation {
            subject: row.subject.clone(),
            kind: Kind::from_i16(row.kind)?,
            observed_at: row.observed_at,
        },
    ))
}

/// One subject's newest word in a group, by the same rule resolution uses.
fn newest_of_subject(rows: &[Observation], subject: &str) -> Option<Observation> {
    rows.iter()
        .filter(|row| row.subject == subject)
        .max_by_key(|row| row.observed_at)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pair_is_normalized_before_it_is_stored() {
        let (provider, account) = normalize_pair(" GitHub ", " Alice ").expect("valid");
        assert_eq!(provider, "github");
        assert_eq!(account, "alice");
    }

    #[test]
    fn an_empty_or_oversized_pair_is_rejected_before_the_database_sees_it() {
        assert!(normalize_pair("", "alice").is_err());
        assert!(normalize_pair("github", "  ").is_err());
        assert!(normalize_pair(&"g".repeat(41), "alice").is_err());
        assert!(normalize_pair("github", &"a".repeat(321)).is_err());
    }

    #[test]
    fn the_same_act_has_the_same_id_and_a_different_act_does_not() {
        let tenant = Uuid::from_u128(7);
        let base = claim_row_id(tenant, "github", "alice", "s1", Kind::Claimed.as_i16());
        assert_eq!(
            base,
            claim_row_id(tenant, "github", "alice", "s1", Kind::Claimed.as_i16()),
            "repeating an act must be an upsert, not a second row"
        );
        for other in [
            claim_row_id(tenant, "gitlab", "alice", "s1", Kind::Claimed.as_i16()),
            claim_row_id(tenant, "github", "bob", "s1", Kind::Claimed.as_i16()),
            claim_row_id(tenant, "github", "alice", "s2", Kind::Claimed.as_i16()),
            claim_row_id(tenant, "github", "alice", "s1", Kind::Verified.as_i16()),
            claim_row_id(Uuid::from_u128(8), "github", "alice", "s1", Kind::Claimed.as_i16()),
        ] {
            assert_ne!(base, other, "distinct acts must not collide");
        }
    }

    #[test]
    fn a_row_from_a_newer_version_is_dropped_not_guessed_at() {
        let row = Model {
            id: Uuid::from_u128(1),
            tenant_id: Uuid::from_u128(7),
            provider: "github".into(),
            account: "alice".into(),
            subject: "s1".into(),
            kind: 99,
            method: String::new(),
            evidence: "{}".into(),
            author: String::new(),
            observed_at: OffsetDateTime::UNIX_EPOCH,
        };
        assert!(observation_of(&row).is_none());
    }
}
