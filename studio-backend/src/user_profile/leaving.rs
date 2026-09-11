//! What must still be true after somebody's standing in an organization
//! changes.
//!
//! One rule, and it is the only thing standing between self-service departure
//! and organizations nobody can administer: **an organization always has an
//! active owner**. ADR-0011 §4 stated it; ADR-0018 §6 gave it a self-service
//! path into it, which is what makes it worth enforcing in one place rather
//! than at each route that could break it.
//!
//! Every way a membership can change asks the same question — leaving, being
//! removed, being demoted, being suspended — so the question is asked about the
//! *result*: here is the room as it would be afterwards, is somebody in it
//! still able to administer it?
//!
//! No IO, so the rule is stated as tests.

use crate::access_config::ROLE_OWNER;

/// A membership that grants what it says.
pub const STATUS_ACTIVE: &str = "active";
/// A membership that still records where somebody belongs and grants nothing
/// while it stands (ADR-0011 §2).
pub const STATUS_SUSPENDED: &str = "suspended";

/// The states a membership can be in, as the API accepts them.
pub const STATUSES: [&str; 2] = [STATUS_ACTIVE, STATUS_SUSPENDED];

/// One person's standing in an organization, as far as this rule cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub user_id: String,
    pub role: String,
    pub status: String,
}

impl Member {
    /// An owner who can act as one.
    ///
    /// A suspended owner is not one: their membership grants nothing while it
    /// stands, so an organization left with only suspended owners is an
    /// organization with nobody able to administer it — which is the state this
    /// module exists to prevent.
    fn is_active_owner(&self) -> bool {
        self.role == ROLE_OWNER && self.status == STATUS_ACTIVE
    }
}

/// What somebody's membership would become.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub role: String,
    pub status: String,
}

impl Standing {
    /// An ordinary active membership in `role`.
    pub fn active(role: &str) -> Self {
        Self {
            role: role.to_owned(),
            status: STATUS_ACTIVE.to_owned(),
        }
    }
}

/// Why a change to somebody's membership is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// They are not in this organization to begin with.
    NotAMember,
    /// They are the only owner who can act, and the change would leave none.
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
                "an organization needs an owner who can act — make somebody else an owner first"
            }
            Self::LastPerson => {
                "you are the only person in that organization, so leaving it would mean deleting \
                 it — which is a separate, deliberate act"
            }
        }
    }
}

/// May `user_id`'s membership become `after`, or end entirely?
///
/// `after` is `None` for leaving or being removed. `members` is everybody in the
/// organization, including the person in question.
///
/// The order matters: being the last person is reported ahead of being the last
/// owner, because it is the more useful thing to be told. "Make somebody else an
/// owner first" is not advice a person alone in an organization can act on.
pub fn may_change(
    members: &[Member],
    user_id: &str,
    after: Option<&Standing>,
) -> Result<(), Refusal> {
    if !members.iter().any(|m| m.user_id == user_id) {
        return Err(Refusal::NotAMember);
    }

    // The room as it would be, and then one question asked of it.
    let mut afterwards: Vec<Member> = members
        .iter()
        .filter(|m| m.user_id != user_id)
        .cloned()
        .collect();
    if let Some(standing) = after {
        afterwards.push(Member {
            user_id: user_id.to_owned(),
            role: standing.role.clone(),
            status: standing.status.clone(),
        });
    }

    if afterwards.is_empty() {
        return Err(Refusal::LastPerson);
    }
    if !afterwards.iter().any(Member::is_active_owner) {
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
            status: STATUS_ACTIVE.to_owned(),
        }
    }

    fn suspended(user_id: &str, role: &str) -> Member {
        Member {
            status: STATUS_SUSPENDED.to_owned(),
            ..member(user_id, role)
        }
    }

    /// Leaving, spelled so the tests read as sentences.
    const LEAVE: Option<&Standing> = None;

    const ADA: &str = "ada";
    const BOB: &str = "bob";

    #[test]
    fn an_ordinary_member_may_always_leave() {
        let org = [member(ADA, "owner"), member(BOB, "member")];
        assert_eq!(may_change(&org, BOB, LEAVE), Ok(()));
    }

    #[test]
    fn one_of_two_owners_may_leave() {
        let org = [member(ADA, "owner"), member(BOB, "owner")];
        assert_eq!(may_change(&org, ADA, LEAVE), Ok(()));
    }

    #[test]
    fn the_only_owner_may_not_leave_while_others_remain() {
        // The organization would still have people in it, and nobody able to
        // administer them.
        let org = [member(ADA, "owner"), member(BOB, "member")];
        assert_eq!(may_change(&org, ADA, LEAVE), Err(Refusal::LastOwner));
    }

    #[test]
    fn demoting_the_only_owner_is_the_same_refusal_as_removing_them() {
        // Otherwise the invariant would be enforced on one route and walked
        // around on another.
        let org = [member(ADA, "owner"), member(BOB, "member")];
        for role in ["member", "admin"] {
            assert_eq!(
                may_change(&org, ADA, Some(&Standing::active(role))),
                Err(Refusal::LastOwner)
            );
        }
    }

    #[test]
    fn suspending_the_only_owner_is_refused_for_the_same_reason() {
        // A suspended membership grants nothing, so this leaves the
        // organization exactly as ownerless as removing them would.
        let org = [member(ADA, "owner"), member(BOB, "member")];
        let after = Standing {
            role: "owner".to_owned(),
            status: STATUS_SUSPENDED.to_owned(),
        };
        assert_eq!(may_change(&org, ADA, Some(&after)), Err(Refusal::LastOwner));
    }

    #[test]
    fn suspending_anybody_else_is_allowed() {
        let org = [member(ADA, "owner"), member(BOB, "member")];
        let after = Standing {
            role: "member".to_owned(),
            status: STATUS_SUSPENDED.to_owned(),
        };
        assert_eq!(may_change(&org, BOB, Some(&after)), Ok(()));
    }

    #[test]
    fn a_suspended_owner_does_not_cover_for_the_active_one() {
        // Two owners on paper, one of them suspended: the active one leaving
        // would leave nobody who can act.
        let org = [member(ADA, "owner"), suspended(BOB, "owner")];
        assert_eq!(may_change(&org, ADA, LEAVE), Err(Refusal::LastOwner));
    }

    #[test]
    fn reinstating_that_owner_is_what_unblocks_the_other_one() {
        let org = [member(ADA, "owner"), member(BOB, "owner")];
        assert_eq!(may_change(&org, ADA, LEAVE), Ok(()));
    }

    #[test]
    fn making_somebody_an_owner_is_never_refused() {
        let org = [member(ADA, "owner")];
        assert_eq!(
            may_change(&org, ADA, Some(&Standing::active("owner"))),
            Ok(())
        );
    }

    #[test]
    fn the_only_person_is_told_that_rather_than_to_find_an_owner() {
        // "Make somebody else an owner first" is not advice somebody alone in
        // an organization can act on.
        let org = [member(ADA, "owner")];
        assert_eq!(may_change(&org, ADA, LEAVE), Err(Refusal::LastPerson));
    }

    #[test]
    fn the_only_person_cannot_suspend_themselves_either() {
        // The row would stay and the organization would keep existing with
        // nobody able to administer it — the state the rule is about.
        let org = [member(ADA, "owner")];
        let after = Standing {
            role: "owner".to_owned(),
            status: STATUS_SUSPENDED.to_owned(),
        };
        assert_eq!(may_change(&org, ADA, Some(&after)), Err(Refusal::LastOwner));
    }

    #[test]
    fn somebody_who_is_not_there_is_told_so() {
        let org = [member(ADA, "owner")];
        assert_eq!(may_change(&org, BOB, LEAVE), Err(Refusal::NotAMember));
    }
}
