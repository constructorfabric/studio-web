//! Who may write an alias, and what an alias is worth (ADR-0012).
//!
//! `identity_alias` holds **one row per external identity** — its primary key is
//! the v5 UUID of `(kind, external_id)`. So an upsert by a second person does
//! not add a row, it *repoints* the existing one. That is fine while the route
//! is platform-admin only, and it is an account-takeover primitive the moment
//! the route becomes self-service, which is what ADR-0012 makes it. This module
//! is the gate that makes self-service safe.
//!
//! The rule, in one line: **only a proof of control displaces somebody else.**
//! An unproven assertion can take an unclaimed slot or overwrite a machine's
//! guess, and nothing more.
//!
//! No IO and no database types, so the rules are stated as tests rather than
//! discovered in production.

/// How much an alias attribution is worth.
///
/// Ordered by [`Confidence::strength`], which is what every comparison below
/// goes through — the `enum` order itself is not load-bearing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    /// The system noticed a similarity. A hypothesis; grants nothing, and any
    /// human assertion displaces it.
    Suggested,
    /// The person says the account is theirs, with nothing behind it yet.
    /// Records intent so it survives until a ceremony can upgrade it; grants
    /// nothing.
    Claimed,
    /// The provider confirmed the person controls the account. The only value
    /// that attributes anything, and the only one that displaces another
    /// person.
    Confirmed,
}

impl Confidence {
    /// Every variant, for the tests that must not miss one.
    #[cfg(test)]
    pub const ALL: [Self; 3] = [Self::Suggested, Self::Claimed, Self::Confirmed];

    /// How much this attribution is worth, as a total order. Public because
    /// callers sort by it — deriving an order from anything else (the variant
    /// order, the length of `as_str`) is how a comparison quietly stops meaning
    /// what it says.
    #[must_use]
    pub const fn strength(self) -> u8 {
        match self {
            Self::Suggested => 0,
            Self::Claimed => 1,
            Self::Confirmed => 2,
        }
    }

    /// Does an alias at this confidence attribute activity to its user?
    #[must_use]
    pub const fn attributes(self) -> bool {
        matches!(self, Self::Confirmed)
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Suggested => "suggested",
            Self::Claimed => "claimed",
            Self::Confirmed => "confirmed",
        }
    }

    /// Read a stored or requested confidence.
    ///
    /// Returns `None` for anything unrecognised rather than defaulting: the
    /// previous `add_alias` coerced every unknown value to `suggested`, which
    /// silently turned a typo'd `"confirmd"` into a hypothesis. A caller that
    /// cannot be understood is answered, not guessed at.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "suggested" => Some(Self::Suggested),
            "claimed" => Some(Self::Claimed),
            "confirmed" => Some(Self::Confirmed),
            _ => None,
        }
    }
}

/// The alias row that already exists for an external identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub user_id: String,
    pub confidence: Confidence,
}

/// Why a write was refused. Each maps to a distinct message the person can act
/// on — "it is taken" and "you would be downgrading your own proof" are
/// different problems.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Another person has asserted or proven this identity, and the incoming
    /// write carries no proof.
    HeldByAnother,
    /// The writer already holds it at a higher confidence. Accepting would
    /// throw away their own proof.
    WouldDowngrade,
}

impl Refusal {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::HeldByAnother => {
                "this external identity is already attributed to another user; prove control of \
                 it (add a personal connection for the provider) to claim it"
            }
            Self::WouldDowngrade => {
                "this external identity is already confirmed for you; a weaker assertion would \
                 discard that proof"
            }
        }
    }
}

/// What to do with an incoming alias write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Write the row.
    Write,
    /// The identical assertion is already recorded — a no-op, reported as
    /// success so a retry is safe.
    AlreadyHeld,
    Refused(Refusal),
}

/// Decide whether `writer` may attribute an external identity to itself at
/// `incoming` confidence, given the row that exists now.
///
/// `held` is `None` when the identity is unattributed.
#[must_use]
pub fn decide(held: Option<&Held>, writer: &str, incoming: Confidence) -> Decision {
    let Some(held) = held else {
        // Unattributed: first assertion takes it, at whatever confidence it
        // carries. A `claimed` row here grants nothing, it only records intent.
        return Decision::Write;
    };

    if held.user_id == writer {
        return match incoming.strength().cmp(&held.confidence.strength()) {
            // The upgrade path: claimed -> confirmed once the ceremony passes.
            std::cmp::Ordering::Greater => Decision::Write,
            std::cmp::Ordering::Equal => Decision::AlreadyHeld,
            std::cmp::Ordering::Less => Decision::Refused(Refusal::WouldDowngrade),
        };
    }

    // Somebody else's row. Only proof displaces it — that is the whole policy.
    if incoming == Confidence::Confirmed {
        return Decision::Write;
    }
    // ...except a machine's guess, which yields to any human assertion. A
    // suggestion must never stand in the way of the person it is about.
    if held.confidence == Confidence::Suggested
        && incoming.strength() >= Confidence::Claimed.strength()
    {
        return Decision::Write;
    }
    Decision::Refused(Refusal::HeldByAnother)
}

/// Was an identity taken from someone who had proven it? Reported alongside a
/// successful displacing write so the loss is visible rather than silent.
///
/// Under verification-wins the most recent proof binds (ADR-0012 §3), so this
/// is not an error — but two people proving control of one account means a
/// shared credential or a stolen token, and somebody should see it.
#[must_use]
pub fn displaced_a_proof(held: Option<&Held>, writer: &str) -> bool {
    held.is_some_and(|h| h.user_id != writer && h.confidence == Confidence::Confirmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: &str = "11111111-1111-1111-1111-111111111111";
    const BOB: &str = "22222222-2222-2222-2222-222222222222";

    fn held(user: &str, confidence: Confidence) -> Held {
        Held {
            user_id: user.to_owned(),
            confidence,
        }
    }

    #[test]
    fn an_unattributed_identity_is_taken_by_the_first_assertion() {
        for confidence in Confidence::ALL {
            assert_eq!(decide(None, ALICE, confidence), Decision::Write);
        }
    }

    #[test]
    fn a_claim_grants_nothing_even_though_it_is_written() {
        // The row exists so the intent survives; it must not attribute.
        assert_eq!(decide(None, ALICE, Confidence::Claimed), Decision::Write);
        assert!(!Confidence::Claimed.attributes());
        assert!(!Confidence::Suggested.attributes());
        assert!(Confidence::Confirmed.attributes());
    }

    #[test]
    fn only_a_confirmation_attributes() {
        // Guards the table in ADR-0012 §1 against a later variant quietly
        // gaining the right to attribute activity.
        for confidence in Confidence::ALL {
            assert_eq!(
                confidence.attributes(),
                confidence == Confidence::Confirmed,
                "{confidence:?}"
            );
        }
    }

    #[test]
    fn a_claim_cannot_steal_what_another_person_claimed() {
        // The takeover this module exists to stop: before ADR-0012 the upsert
        // was unconditional and this write repointed Bob's alias to Alice.
        assert_eq!(
            decide(
                Some(&held(BOB, Confidence::Claimed)),
                ALICE,
                Confidence::Claimed
            ),
            Decision::Refused(Refusal::HeldByAnother)
        );
    }

    #[test]
    fn a_claim_cannot_steal_what_another_person_proved() {
        assert_eq!(
            decide(
                Some(&held(BOB, Confidence::Confirmed)),
                ALICE,
                Confidence::Claimed
            ),
            Decision::Refused(Refusal::HeldByAnother)
        );
    }

    #[test]
    fn a_proof_displaces_another_persons_claim() {
        assert_eq!(
            decide(
                Some(&held(BOB, Confidence::Claimed)),
                ALICE,
                Confidence::Confirmed
            ),
            Decision::Write
        );
    }

    #[test]
    fn a_proof_displaces_another_persons_proof_and_the_loss_is_reported() {
        // Verification-wins: the most recent proof binds. Two proofs on one
        // account mean a shared or stolen credential, so it is surfaced.
        let existing = held(BOB, Confidence::Confirmed);
        assert_eq!(
            decide(Some(&existing), ALICE, Confidence::Confirmed),
            Decision::Write
        );
        assert!(displaced_a_proof(Some(&existing), ALICE));
    }

    #[test]
    fn a_machines_guess_yields_to_any_human_assertion() {
        // A suggestion is a hypothesis about a person. It must never stand
        // between them and their own account.
        for incoming in [Confidence::Claimed, Confidence::Confirmed] {
            assert_eq!(
                decide(Some(&held(BOB, Confidence::Suggested)), ALICE, incoming),
                Decision::Write,
                "{incoming:?} should displace a suggestion"
            );
        }
    }

    #[test]
    fn one_guess_does_not_displace_another_guess() {
        // Nothing is gained by letting the suggestion generator churn the row
        // between candidates.
        assert_eq!(
            decide(
                Some(&held(BOB, Confidence::Suggested)),
                ALICE,
                Confidence::Suggested
            ),
            Decision::Refused(Refusal::HeldByAnother)
        );
    }

    #[test]
    fn a_person_upgrades_their_own_claim_by_proving_it() {
        assert_eq!(
            decide(
                Some(&held(ALICE, Confidence::Claimed)),
                ALICE,
                Confidence::Confirmed
            ),
            Decision::Write
        );
    }

    #[test]
    fn repeating_your_own_assertion_is_a_no_op() {
        // Idempotency: re-running the ceremony, or a double-clicked button,
        // must not read as an error.
        for confidence in Confidence::ALL {
            assert_eq!(
                decide(Some(&held(ALICE, confidence)), ALICE, confidence),
                Decision::AlreadyHeld,
                "{confidence:?}"
            );
        }
    }

    #[test]
    fn a_person_cannot_downgrade_their_own_proof() {
        // Re-running a suggestion pass, or a stray claim, must not throw away
        // a confirmation that already attributes activity.
        assert_eq!(
            decide(
                Some(&held(ALICE, Confidence::Confirmed)),
                ALICE,
                Confidence::Claimed
            ),
            Decision::Refused(Refusal::WouldDowngrade)
        );
        assert_eq!(
            decide(
                Some(&held(ALICE, Confidence::Claimed)),
                ALICE,
                Confidence::Suggested
            ),
            Decision::Refused(Refusal::WouldDowngrade)
        );
    }

    #[test]
    fn displacing_only_counts_when_a_proof_is_lost() {
        assert!(!displaced_a_proof(None, ALICE));
        assert!(!displaced_a_proof(
            Some(&held(ALICE, Confidence::Confirmed)),
            ALICE
        ));
        assert!(!displaced_a_proof(
            Some(&held(BOB, Confidence::Claimed)),
            ALICE
        ));
    }

    #[test]
    fn a_confidence_survives_the_column() {
        for confidence in Confidence::ALL {
            assert_eq!(Confidence::parse(confidence.as_str()), Some(confidence));
        }
        assert_eq!(
            Confidence::parse("  Confirmed "),
            Some(Confidence::Confirmed)
        );
    }

    #[test]
    fn an_unrecognised_confidence_is_refused_not_downgraded() {
        // The previous add_alias coerced anything that was not "confirmed" to
        // "suggested", so a typo silently became a hypothesis.
        assert_eq!(Confidence::parse("confirmd"), None);
        assert_eq!(Confidence::parse(""), None);
        assert_eq!(Confidence::parse("verified"), None);
    }
}
