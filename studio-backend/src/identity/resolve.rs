//! Verification-wins resolution: the pure core (ADR-0012 §3).
//!
//! No IO, no database types, no HTTP. Given the journal rows for one external
//! account, decide who the account belongs to and what is merely proposed.
//! Everything the rest of the gear does is loading rows for this function and
//! rendering what it returns.
//!
//! The vocabulary lives here in both directions — [`Kind::as_i16`] /
//! [`Kind::from_i16`] for the column and [`Kind::as_str`] for the API — so the
//! write side and the read side cannot disagree about what a row means. That is
//! the one habit worth keeping from Insight's `domain/provenance.rs`; the policy
//! it encodes is the opposite of theirs.

use std::collections::BTreeMap;

use time::OffsetDateTime;

/// The reserved subject meaning "not a human": bots, CI and shared team
/// credentials bind here, and every consumer treats it as no person.
///
/// Unmintable on purpose — no UUID version produces an all-ones value — so it
/// can never collide with a Keycloak subject. Same trick, and the same reason,
/// as Insight's `EXCLUDED_PERSON`.
pub const EXCLUDED_SUBJECT: &str = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/// What one journal row asserts.
///
/// Not an ordered scale: `Revoked` is a tombstone, not a stronger claim, which
/// is why [`Kind::strength`] returns an `Option` instead of a number for it. A
/// naive `max()` over the discriminants would make a revocation win as though
/// it were the best evidence available.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The system noticed a similarity. Shown to the subject, binds nothing.
    Suggested,
    /// The subject asserted the account is theirs, with nothing behind it yet.
    Claimed,
    /// The provider confirmed the subject controls the account.
    Verified,
    /// The subject withdrew an earlier assertion.
    Revoked,
}

impl Kind {
    /// Every variant. A new one cannot be added without updating this array,
    /// which is what the round-trip tests iterate. Test-only: nothing in the
    /// running gear enumerates the kinds.
    #[cfg(test)]
    pub const ALL: [Self; 4] = [
        Self::Suggested,
        Self::Claimed,
        Self::Verified,
        Self::Revoked,
    ];

    /// How much this row is worth as evidence, or `None` for a tombstone.
    /// Only `Verified` may bind (ADR-0012 §1).
    const fn strength(self) -> Option<u8> {
        match self {
            Self::Suggested => Some(0),
            Self::Claimed => Some(1),
            Self::Verified => Some(2),
            Self::Revoked => None,
        }
    }

    /// Order used only to break a tie between two rows of the same subject
    /// carrying the identical timestamp. A revocation wins such a tie: when the
    /// journal cannot say which act came last, the safe reading is that the
    /// account is not claimed.
    const fn tie_rank(self) -> u8 {
        match self {
            Self::Revoked => 3,
            Self::Verified => 2,
            Self::Claimed => 1,
            Self::Suggested => 0,
        }
    }

    #[must_use]
    pub const fn as_i16(self) -> i16 {
        match self {
            Self::Suggested => 0,
            Self::Claimed => 1,
            Self::Verified => 2,
            Self::Revoked => 3,
        }
    }

    #[must_use]
    pub const fn from_i16(value: i16) -> Option<Self> {
        match value {
            0 => Some(Self::Suggested),
            1 => Some(Self::Claimed),
            2 => Some(Self::Verified),
            3 => Some(Self::Revoked),
            _ => None,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Suggested => "suggested",
            Self::Claimed => "claimed",
            Self::Verified => "verified",
            Self::Revoked => "revoked",
        }
    }
}

/// One journal row, reduced to what resolution actually reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    /// Studio platform subject, or [`EXCLUDED_SUBJECT`].
    pub subject: String,
    pub kind: Kind,
    pub observed_at: OffsetDateTime,
}

/// Who an external account belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    /// Nobody has proven control. Attribute nothing.
    Unbound,
    /// A bot, CI or shared credential. Attribute nothing, and do not ask
    /// anybody to claim it.
    Excluded,
    /// The platform subject that proved control.
    Subject(String),
}

impl Binding {
    /// The subject to attribute activity to, if any. `Excluded` deliberately
    /// answers `None`: it is a decision that the account is not a person, not a
    /// missing answer.
    #[must_use]
    pub fn attributable_subject(&self) -> Option<&str> {
        match self {
            Self::Subject(subject) => Some(subject),
            Self::Unbound | Self::Excluded => None,
        }
    }
}

/// A live assertion that does not bind: shown to a human, acted on by nobody.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub subject: String,
    /// `Suggested` or `Claimed` — a `Proposal` is never built from anything else.
    pub kind: Kind,
}

/// The state of one external account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub binding: Binding,
    /// Strongest first, then most recent. Never contains the bound subject.
    pub proposals: Vec<Proposal>,
    /// More than one subject holds a live verification. Reported, never acted
    /// on: under verification-wins the most recent one still binds (ADR-0012 §3).
    pub contested: bool,
}

/// Identifies one external account across the journal.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct AccountKey {
    pub provider: String,
    pub account: String,
}

/// Fold a provider key or account name into its stored form.
///
/// Provider logins are compared case-insensitively — GitHub resolves `Alice`
/// and `alice` to the same account, and a claim typed with different casing
/// than the connector reported must not read as a second account. Applied at
/// every boundary, so a lookup cannot miss a row that a write normalized.
#[must_use]
pub fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Resolve one external account from its journal rows.
///
/// Rows may arrive in any order and may contain several kinds per subject; the
/// caller is only required to have filtered them to a single
/// `(tenant, provider, account)`.
#[must_use]
pub fn resolve(observations: &[Observation]) -> Resolution {
    // Each subject speaks with its newest row only. Everything else it ever
    // said is history, which is what makes revoke-then-claim-again work without
    // a state machine.
    let mut newest: BTreeMap<&str, &Observation> = BTreeMap::new();
    for row in observations {
        newest
            .entry(row.subject.as_str())
            .and_modify(|current| {
                if is_newer(row, current) {
                    *current = row;
                }
            })
            .or_insert(row);
    }

    // A subject whose last word was a revocation has withdrawn; it is neither a
    // binding nor a proposal, and it must not linger as either.
    let live: Vec<&Observation> = newest
        .into_values()
        .filter(|row| row.kind != Kind::Revoked)
        .collect();

    let mut verified: Vec<&Observation> = live
        .iter()
        .copied()
        .filter(|row| row.kind == Kind::Verified)
        .collect();
    // Most recent verification first: that is the whole of verification-wins.
    verified.sort_by(|a, b| {
        b.observed_at
            .cmp(&a.observed_at)
            .then(a.subject.cmp(&b.subject))
    });

    let contested = verified.len() > 1;
    let binding = match verified.first() {
        None => Binding::Unbound,
        Some(row) if row.subject == EXCLUDED_SUBJECT => Binding::Excluded,
        Some(row) => Binding::Subject(row.subject.clone()),
    };

    // Whoever bound the account is not also proposing it. Every other live
    // subject is — including the losers of a contested account, so the state is
    // visible rather than swallowed.
    let bound_subject = verified.first().map(|row| row.subject.as_str());
    let mut proposals: Vec<Proposal> = live
        .iter()
        .copied()
        .filter(|row| Some(row.subject.as_str()) != bound_subject)
        .filter_map(|row| {
            row.kind.strength().map(|_| Proposal {
                subject: row.subject.clone(),
                kind: row.kind,
            })
        })
        .collect();
    proposals.sort_by(|a, b| {
        b.kind
            .strength()
            .cmp(&a.kind.strength())
            .then(a.subject.cmp(&b.subject))
    });

    Resolution {
        binding,
        proposals,
        contested,
    }
}

/// Group journal rows by the account they are about, so a caller holding rows
/// for several accounts can resolve each one.
///
/// `BTreeMap` rather than `HashMap`: the "my identities" view renders this
/// directly and a stable order beats sorting it again downstream.
#[must_use]
pub fn group_by_account<I>(rows: I) -> BTreeMap<AccountKey, Vec<Observation>>
where
    I: IntoIterator<Item = (AccountKey, Observation)>,
{
    let mut grouped: BTreeMap<AccountKey, Vec<Observation>> = BTreeMap::new();
    for (key, row) in rows {
        grouped.entry(key).or_default().push(row);
    }
    grouped
}

/// Is `candidate` a later word from the same subject than `current`?
///
/// Equal timestamps fall back to [`Kind::tie_rank`] instead of to insertion
/// order, so resolution does not depend on the order the database happened to
/// return rows in.
fn is_newer(candidate: &Observation, current: &Observation) -> bool {
    match candidate.observed_at.cmp(&current.observed_at) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => candidate.kind.tie_rank() > current.kind.tie_rank(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: &str = "11111111-1111-1111-1111-111111111111";
    const BOB: &str = "22222222-2222-2222-2222-222222222222";

    fn at(secs: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(secs).expect("valid timestamp")
    }

    fn row(subject: &str, kind: Kind, secs: i64) -> Observation {
        Observation {
            subject: subject.to_owned(),
            kind,
            observed_at: at(secs),
        }
    }

    #[test]
    fn an_account_nobody_has_touched_binds_to_nobody() {
        let resolved = resolve(&[]);
        assert_eq!(resolved.binding, Binding::Unbound);
        assert!(resolved.proposals.is_empty());
        assert!(!resolved.contested);
    }

    #[test]
    fn a_suggestion_is_shown_and_binds_nothing() {
        // The whole inversion from Insight in one assertion: a system-found
        // similarity is a question put to a human, not an answer.
        let resolved = resolve(&[row(ALICE, Kind::Suggested, 100)]);
        assert_eq!(resolved.binding, Binding::Unbound);
        assert_eq!(
            resolved.proposals,
            vec![Proposal {
                subject: ALICE.to_owned(),
                kind: Kind::Suggested
            }]
        );
    }

    #[test]
    fn a_bare_claim_binds_nothing() {
        let resolved = resolve(&[row(ALICE, Kind::Claimed, 100)]);
        assert_eq!(resolved.binding, Binding::Unbound);
        assert_eq!(resolved.proposals.len(), 1);
    }

    #[test]
    fn a_verification_binds() {
        let resolved = resolve(&[row(ALICE, Kind::Verified, 100)]);
        assert_eq!(resolved.binding, Binding::Subject(ALICE.to_owned()));
        assert!(resolved.proposals.is_empty());
        assert!(!resolved.contested);
    }

    #[test]
    fn an_unverified_claim_does_not_block_somebody_elses_verification() {
        // The policy, stated as a test: Alice claiming first changes nothing
        // about Bob proving control, and Alice's claim stays visible rather
        // than being deleted by his win.
        let resolved = resolve(&[
            row(ALICE, Kind::Claimed, 100),
            row(BOB, Kind::Verified, 200),
        ]);
        assert_eq!(resolved.binding, Binding::Subject(BOB.to_owned()));
        assert_eq!(
            resolved.proposals,
            vec![Proposal {
                subject: ALICE.to_owned(),
                kind: Kind::Claimed
            }]
        );
        assert!(!resolved.contested);
    }

    #[test]
    fn an_earlier_claim_does_not_win_by_being_earlier() {
        let resolved = resolve(&[
            row(ALICE, Kind::Claimed, 500),
            row(BOB, Kind::Verified, 100),
        ]);
        assert_eq!(resolved.binding, Binding::Subject(BOB.to_owned()));
    }

    #[test]
    fn a_revocation_unbinds() {
        let resolved = resolve(&[
            row(ALICE, Kind::Verified, 100),
            row(ALICE, Kind::Revoked, 200),
        ]);
        assert_eq!(resolved.binding, Binding::Unbound);
        assert!(
            resolved.proposals.is_empty(),
            "a withdrawn account must not linger as a proposal"
        );
    }

    #[test]
    fn a_verification_after_a_revocation_binds_again() {
        // The reason revocation is a row and not a status: this sequence has to
        // work without a state machine, and re-verifying is the same act as
        // verifying (`ON CONFLICT` touches `observed_at`).
        let resolved = resolve(&[
            row(ALICE, Kind::Verified, 300),
            row(ALICE, Kind::Revoked, 200),
        ]);
        assert_eq!(resolved.binding, Binding::Subject(ALICE.to_owned()));
    }

    #[test]
    fn two_verifications_let_the_most_recent_win_and_report_the_contest() {
        let resolved = resolve(&[
            row(ALICE, Kind::Verified, 100),
            row(BOB, Kind::Verified, 200),
        ]);
        assert_eq!(resolved.binding, Binding::Subject(BOB.to_owned()));
        assert!(
            resolved.contested,
            "a shared credential must be visible as contested"
        );
        assert_eq!(
            resolved.proposals,
            vec![Proposal {
                subject: ALICE.to_owned(),
                kind: Kind::Verified
            }],
            "the loser of a contest stays visible"
        );
    }

    #[test]
    fn a_shared_credential_binds_to_nobody_human() {
        let resolved = resolve(&[row(EXCLUDED_SUBJECT, Kind::Verified, 100)]);
        assert_eq!(resolved.binding, Binding::Excluded);
        assert_eq!(resolved.binding.attributable_subject(), None);
    }

    #[test]
    fn marking_an_account_excluded_overrides_an_earlier_person() {
        let resolved = resolve(&[
            row(ALICE, Kind::Verified, 100),
            row(EXCLUDED_SUBJECT, Kind::Verified, 200),
        ]);
        assert_eq!(resolved.binding, Binding::Excluded);
    }

    #[test]
    fn a_tie_between_a_verification_and_a_revocation_reads_as_withdrawn() {
        // Same instant, opposite meanings. Order of rows out of the database
        // must not decide it, and the safe reading is the withdrawal.
        let forwards = resolve(&[
            row(ALICE, Kind::Verified, 100),
            row(ALICE, Kind::Revoked, 100),
        ]);
        let backwards = resolve(&[
            row(ALICE, Kind::Revoked, 100),
            row(ALICE, Kind::Verified, 100),
        ]);
        assert_eq!(forwards.binding, Binding::Unbound);
        assert_eq!(forwards, backwards);
    }

    #[test]
    fn resolution_does_not_depend_on_row_order() {
        let rows = [
            row(ALICE, Kind::Suggested, 50),
            row(ALICE, Kind::Claimed, 150),
            row(BOB, Kind::Verified, 200),
        ];
        let mut reversed = rows.clone();
        reversed.reverse();
        assert_eq!(resolve(&rows), resolve(&reversed));
    }

    #[test]
    fn proposals_are_ordered_strongest_first() {
        let resolved = resolve(&[
            row(ALICE, Kind::Suggested, 100),
            row(BOB, Kind::Claimed, 100),
        ]);
        assert_eq!(
            resolved
                .proposals
                .iter()
                .map(|p| p.kind)
                .collect::<Vec<_>>(),
            vec![Kind::Claimed, Kind::Suggested]
        );
    }

    #[test]
    fn a_subject_speaks_with_its_newest_row_only() {
        // Alice was suggested, then claimed. She is one proposal, not two.
        let resolved = resolve(&[
            row(ALICE, Kind::Suggested, 100),
            row(ALICE, Kind::Claimed, 200),
        ]);
        assert_eq!(
            resolved.proposals,
            vec![Proposal {
                subject: ALICE.to_owned(),
                kind: Kind::Claimed
            }]
        );
    }

    #[test]
    fn the_excluded_subject_cannot_be_minted() {
        // The sentinel is only safe while no UUID version can produce it.
        let parsed = uuid::Uuid::parse_str(EXCLUDED_SUBJECT).expect("a valid UUID");
        assert_eq!(parsed.as_u128(), u128::MAX);
        assert_ne!(parsed.get_version_num(), 4);
        assert_ne!(parsed.get_version_num(), 5);
    }

    #[test]
    fn a_kind_survives_the_column() {
        for kind in Kind::ALL {
            assert_eq!(Kind::from_i16(kind.as_i16()), Some(kind));
        }
        assert_eq!(
            Kind::from_i16(99),
            None,
            "a value this build does not know must be dropped, not guessed at"
        );
    }

    #[test]
    fn every_kind_renders_as_its_own_name() {
        // The API name is what a client branches on, so two kinds sharing one
        // name would be indistinguishable to whoever renders the list.
        let names: BTreeMap<&str, Kind> = Kind::ALL.into_iter().map(|k| (k.as_str(), k)).collect();
        assert_eq!(names.len(), Kind::ALL.len());
        assert!(names.keys().all(|name| !name.is_empty()));
    }

    #[test]
    fn only_a_verification_is_allowed_to_bind() {
        // Guards the table in ADR-0012 §1 against a later variant quietly
        // gaining the right to attribute activity.
        for kind in Kind::ALL {
            let resolved = resolve(&[row(ALICE, kind, 100)]);
            let binds = resolved.binding != Binding::Unbound;
            assert_eq!(
                binds,
                kind == Kind::Verified,
                "{kind:?} must {} bind",
                if kind == Kind::Verified { "" } else { "not" }
            );
        }
    }

    #[test]
    fn casing_and_padding_do_not_make_a_second_account() {
        assert_eq!(normalize("  Alice "), "alice");
        assert_eq!(normalize("GitHub"), "github");
    }

    #[test]
    fn rows_group_into_the_accounts_they_are_about() {
        let key = |provider: &str, account: &str| AccountKey {
            provider: provider.to_owned(),
            account: account.to_owned(),
        };
        let grouped = group_by_account([
            (key("github", "alice"), row(ALICE, Kind::Verified, 100)),
            (key("gitlab", "alice"), row(ALICE, Kind::Claimed, 100)),
            (key("github", "alice"), row(BOB, Kind::Suggested, 100)),
        ]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[&key("github", "alice")].len(), 2);
        assert_eq!(
            resolve(&grouped[&key("github", "alice")]).binding,
            Binding::Subject(ALICE.to_owned())
        );
        assert_eq!(
            resolve(&grouped[&key("gitlab", "alice")]).binding,
            Binding::Unbound
        );
    }
}
