//! What must still be true after somebody stops being a member.
//!
//! One rule, and it is the only thing standing between self-service departure
//! and organizations nobody can administer: **an organization always has an
//! owner**. ADR-0011 §4 stated it; ADR-0018 §6 gave it a self-service path into
//! it, which is what makes it worth enforcing in one place rather than at each
//! route that could break it.
//!
//! No IO, so the rule is stated as tests.

use crate::access_config::ROLE_OWNER;

/// One person's standing in an organization, as far as this rule cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub user_id: String,
    pub role: String,
}

impl Member {
    fn is_owner(&self) -> bool {
        self.role == ROLE_OWNER
    }
}

/// Why a change to somebody's membership is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// They are not in this organization to begin with.
    NotAMember,
    /// They are the only owner, and the change would leave none.
    LastOwner,
    /// They are the only person here at all. Leaving would abandon the
    /// organization rather than hand it over, so it is deletion that is being
    /// asked for — and deletion is a different act with a different
    /// confirmation.
    LastPerson,
}

impl Refusal {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::NotAMember => "you are not a member of that organization",
            Self::LastOwner => {
                "you are its only owner — make somebody else an owner first, then leave"
            }
            Self::LastPerson => {
                "you are the only person in that organization, so leaving it would mean deleting \
                 it — which is a separate, deliberate act"
            }
        }
    }
}

/// May `user_id`'s membership change to `new_role`, or end entirely?
///
/// `new_role` is `None` for leaving or being removed. `members` is everybody in
/// the organization, including the person in question.
///
/// The order matters: being the last person is reported ahead of being the last
/// owner, because it is the more useful thing to be told. "Make somebody else
/// an owner first" is not advice a person alone in an organization can act on.
pub fn may_change(
    members: &[Member],
    user_id: &str,
    new_role: Option<&str>,
) -> Result<(), Refusal> {
    let Some(subject) = members.iter().find(|m| m.user_id == user_id) else {
        return Err(Refusal::NotAMember);
    };
    // Changing somebody who is not an owner, or making somebody an owner, can
    // never remove the last one.
    if !subject.is_owner() || new_role == Some(ROLE_OWNER) {
        return Ok(());
    }
    if members.len() == 1 {
        return Err(Refusal::LastPerson);
    }
    let other_owners = members
        .iter()
        .filter(|m| m.user_id != user_id && m.is_owner())
        .count();
    if other_owners == 0 {
        return Err(Refusal::LastOwner);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(user_id: &str, role: &str) -> Member {
        Member {
            user_id: user_id.to_owned(),
            role: role.to_owned(),
        }
    }

    const ADA: &str = "ada";
    const BOB: &str = "bob";

    #[test]
    fn an_ordinary_member_may_always_leave() {
        let org = [member(ADA, "owner"), member(BOB, "member")];
        assert_eq!(may_change(&org, BOB, None), Ok(()));
    }

    #[test]
    fn one_of_two_owners_may_leave() {
        let org = [member(ADA, "owner"), member(BOB, "owner")];
        assert_eq!(may_change(&org, ADA, None), Ok(()));
    }

    #[test]
    fn the_only_owner_may_not_leave_while_others_remain() {
        // The organization would still have people in it, and nobody able to
        // administer them.
        let org = [member(ADA, "owner"), member(BOB, "member")];
        assert_eq!(may_change(&org, ADA, None), Err(Refusal::LastOwner));
    }

    #[test]
    fn demoting_the_only_owner_is_the_same_refusal_as_removing_them() {
        // Otherwise the invariant would be enforced on one route and walked
        // around on another.
        let org = [member(ADA, "owner"), member(BOB, "member")];
        assert_eq!(
            may_change(&org, ADA, Some("member")),
            Err(Refusal::LastOwner)
        );
        assert_eq!(
            may_change(&org, ADA, Some("admin")),
            Err(Refusal::LastOwner)
        );
    }

    #[test]
    fn promoting_somebody_first_unblocks_the_owner() {
        let org = [member(ADA, "owner"), member(BOB, "owner")];
        assert_eq!(may_change(&org, ADA, None), Ok(()));
    }

    #[test]
    fn making_somebody_an_owner_is_never_refused() {
        let org = [member(ADA, "owner")];
        assert_eq!(may_change(&org, ADA, Some("owner")), Ok(()));
    }

    #[test]
    fn the_only_person_is_told_that_rather_than_to_find_an_owner() {
        // "Make somebody else an owner first" is not advice somebody alone in
        // an organization can act on.
        let org = [member(ADA, "owner")];
        assert_eq!(may_change(&org, ADA, None), Err(Refusal::LastPerson));
    }

    #[test]
    fn somebody_who_is_not_there_is_told_so() {
        let org = [member(ADA, "owner")];
        assert_eq!(may_change(&org, BOB, None), Err(Refusal::NotAMember));
    }
}
