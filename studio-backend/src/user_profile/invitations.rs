//! Who may accept an invitation, and what an invitation is worth.
//!
//! An invitation is a **bearer secret that becomes a membership**. Everything
//! dangerous about it follows from that: whoever holds the token can join an
//! organization, so the token must be unguessable, usable once, short-lived,
//! and bound to a person the invitation was actually meant for.
//!
//! No IO here, so the rules are stated as tests rather than discovered in
//! production — the same shape as `alias_policy`.

use anyhow::{Result, anyhow};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// How long an invitation stands before it has to be sent again.
///
/// Long enough that somebody on holiday is not locked out, short enough that a
/// token forgotten in an inbox is not a standing key to an organization.
pub const VALID_FOR_DAYS: i64 = 14;

/// Fold an address into the form both sides are compared in.
///
/// Lowercased and trimmed. Addresses are compared, never displayed back as
/// authority, so the only thing that matters is that the invitation side and
/// the acceptance side fold identically — which is why both go through here.
#[must_use]
pub fn normalize_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// Refuse an address that is not one before it is stored.
///
/// Deliberately not a full grammar: the address is never sent to, only
/// compared, and a strict parser would refuse valid addresses the realm accepts
/// while adding nothing. What matters is that it is non-empty, has the one
/// shape every address has, and is not long enough to be a payload.
pub fn validate_email(raw: &str) -> Result<String> {
    let email = normalize_email(raw);
    if email.is_empty() {
        return Err(anyhow!("an invitation needs an e-mail address"));
    }
    if email.len() > 320 {
        return Err(anyhow!("that e-mail address is too long"));
    }
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if local.is_empty() || domain.is_empty() || parts.next().is_some() || !domain.contains('.') {
        return Err(anyhow!("'{raw}' does not look like an e-mail address"));
    }
    Ok(email)
}

/// The roles an invitation may carry.
///
/// Not `owner`: ownership arises from creating an organization or from an owner
/// handing over deliberately (ADR-0018 §6), and an invitation is neither. An
/// invitation that could mint owners would make a forwarded e-mail a way to take
/// an organization.
pub const INVITABLE_ROLES: [&str; 2] = ["member", "admin"];

pub fn validate_role(raw: &str) -> Result<String> {
    let role = raw.trim().to_lowercase();
    if INVITABLE_ROLES.contains(&role.as_str()) {
        Ok(role)
    } else {
        Err(anyhow!(
            "role must be one of {}",
            INVITABLE_ROLES.join(", ")
        ))
    }
}

/// A fresh secret and the digest to store beside it.
///
/// The secret is returned once, to be handed to the invited person; only the
/// digest is kept. An invitation table that could be read back into working
/// tokens would turn a database read into an organization takeover.
///
/// The secret is two v4 UUIDs — 244 bits from the operating system's generator,
/// so guessing is not an attack, and it needs no dependency this crate does not
/// already have.
#[must_use]
pub fn mint_token() -> (String, String) {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let digest = digest_of(&token);
    (token, digest)
}

/// The stored form of a token.
#[must_use]
pub fn digest_of(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.trim().as_bytes());
    hex::encode(hasher.finalize())
}

/// Why an invitation cannot be accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No invitation has that token. Also the answer for one that never
    /// existed — the two are not distinguished, because telling them apart
    /// would turn this into an oracle for guessing tokens.
    Unknown,
    Expired,
    AlreadyAccepted,
    /// The caller's verified address is not the one that was invited.
    NotYours,
    /// The caller has no verified address at all, so nothing can be matched.
    NoVerifiedEmail,
}

impl Refusal {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Unknown => "that invitation does not exist",
            Self::Expired => "that invitation has expired — ask for a new one",
            Self::AlreadyAccepted => "that invitation has already been used",
            Self::NotYours => {
                "that invitation was sent to a different address than the one your account has \
                 verified"
            }
            Self::NoVerifiedEmail => {
                "your account has no verified e-mail address, so an invitation cannot be matched \
                 to you"
            }
        }
    }
}

/// What an acceptance attempt knows about the invitation it found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub email: String,
    pub expired: bool,
    pub accepted: bool,
}

/// May this caller accept this invitation?
///
/// `verified_email` is the address the identity provider vouches for — never
/// the profile address, which the person sets themselves.
///
/// The order of the checks is deliberate: existence and state are decided
/// before identity, so a caller learns "used" or "expired" about an invitation
/// they hold the token for, and learns nothing at all about one they do not.
pub fn may_accept(found: Option<&Pending>, verified_emails: &[String]) -> Result<(), Refusal> {
    let Some(pending) = found else {
        return Err(Refusal::Unknown);
    };
    if pending.accepted {
        return Err(Refusal::AlreadyAccepted);
    }
    if pending.expired {
        return Err(Refusal::Expired);
    }
    if verified_emails.is_empty() {
        return Err(Refusal::NoVerifiedEmail);
    }
    // Every address the person has verified, not only the one they happen to be
    // signed in with: one human holds several logins, and an invitation sent to
    // the address on one of them is theirs whichever way they came in today.
    if verified_emails
        .iter()
        .any(|mine| normalize_email(mine) == pending.email)
    {
        Ok(())
    } else {
        Err(Refusal::NotYours)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(s: &str) -> String {
        s.to_owned()
    }

    /// A person whose second login carries the invited address still gets in.
    #[test]
    fn any_verified_address_of_the_person_matches() {
        assert_eq!(
            may_accept(
                Some(&pending("ada@work.example")),
                &[mail("ada@personal.example"), mail("ada@work.example")]
            ),
            Ok(())
        );
    }

    fn pending(email: &str) -> Pending {
        Pending {
            email: normalize_email(email),
            expired: false,
            accepted: false,
        }
    }

    #[test]
    fn the_invited_person_may_accept() {
        assert_eq!(
            may_accept(
                Some(&pending("Ada@Example.COM")),
                &[mail("ada@example.com")]
            ),
            Ok(())
        );
    }

    #[test]
    fn somebody_else_holding_the_token_may_not() {
        // The whole point of binding an invitation to an address: a forwarded
        // e-mail is not a way into an organization.
        assert_eq!(
            may_accept(
                Some(&pending("ada@example.com")),
                &[mail("bob@example.com")]
            ),
            Err(Refusal::NotYours)
        );
    }

    #[test]
    fn without_a_verified_address_nothing_can_be_matched() {
        // The profile address is self-service, so "no verified address" must
        // refuse rather than fall back to what the person typed about themselves.
        assert_eq!(
            may_accept(Some(&pending("ada@example.com")), &[]),
            Err(Refusal::NoVerifiedEmail)
        );
    }

    #[test]
    fn a_used_or_expired_invitation_is_refused_before_identity_is_considered() {
        let used = Pending {
            accepted: true,
            ..pending("ada@example.com")
        };
        assert_eq!(
            may_accept(Some(&used), &[mail("bob@example.com")]),
            Err(Refusal::AlreadyAccepted)
        );
        let expired = Pending {
            expired: true,
            ..pending("ada@example.com")
        };
        assert_eq!(
            may_accept(Some(&expired), &[mail("bob@example.com")]),
            Err(Refusal::Expired)
        );
    }

    #[test]
    fn an_unknown_token_says_only_that() {
        // No distinction between "never existed" and "not yours": the pair
        // would let somebody probe for valid tokens.
        assert_eq!(
            may_accept(None, &[mail("ada@example.com")]),
            Err(Refusal::Unknown)
        );
    }

    #[test]
    fn a_token_is_stored_as_its_digest_and_never_as_itself() {
        let (token, digest) = mint_token();
        assert_ne!(token, digest);
        assert_eq!(digest_of(&token), digest, "the same token digests the same");
        let (other, _) = mint_token();
        assert_ne!(token, other, "two invitations do not share a token");
    }

    #[test]
    fn an_address_is_compared_in_one_form() {
        assert_eq!(normalize_email("  Ada@Example.COM "), "ada@example.com");
        assert_eq!(
            validate_email(" Ada@Example.com ").expect("valid"),
            "ada@example.com"
        );
    }

    #[test]
    fn something_that_is_not_an_address_is_refused() {
        for bad in [
            "",
            "   ",
            "ada",
            "ada@",
            "@example.com",
            "ada@example",
            "a@b@c.com",
        ] {
            assert!(validate_email(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn an_invitation_cannot_mint_an_owner() {
        // Ownership comes from creating an organization or from an owner
        // handing over — never from a link somebody forwarded.
        assert!(validate_role("owner").is_err());
        assert_eq!(validate_role(" Member ").expect("valid"), "member");
        assert_eq!(validate_role("admin").expect("valid"), "admin");
    }
}
