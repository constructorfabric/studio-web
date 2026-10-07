//! The plan's people, matched to Studio's.
//!
//! The plan names a person by GitHub login, because that is who the board's
//! assignees are. Studio knows a person by their canonical id, and knows which
//! GitHub accounts are theirs only where the account is a **confirmed** alias
//! (ADR-0012): a claim or a guess attributes nothing, so it links nothing here
//! either. Nothing is stored by the match: it is read each time, so a person
//! who confirms their GitHub account tomorrow is linked tomorrow.
//!
//! Two answers come out of it. For each person in the plan, the Studio person
//! behind the login, if any, and whether they are a member of the
//! organization. And the members who have a confirmed GitHub account the plan
//! does not list -- the people a planner most likely forgot.

use std::collections::{BTreeMap, BTreeSet};

use super::plan_edit::PersonDto;

/// One person in the plan, and who they are in Studio.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct PlanPersonLinkDto {
    pub login: String,
    pub alias: Option<String>,
    pub team: Option<String>,
    /// The Studio person whose confirmed GitHub account this login is.
    pub person_id: Option<String>,
    /// Whether that person is an active member of this organization.
    pub member: bool,
}

/// An active member whose confirmed GitHub account the plan does not list.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct UnplannedMemberDto {
    pub person_id: String,
    /// Their confirmed GitHub logins.
    pub github: Vec<String>,
}

/// The plan's people against the organization's.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct PlanPeopleDto {
    /// Every person in the plan, in its order.
    pub people: Vec<PlanPersonLinkDto>,
    pub unplanned: Vec<UnplannedMemberDto>,
    /// Active members with no confirmed GitHub account: the plan cannot name
    /// them until they confirm one.
    pub members_without_github: u32,
    /// False when this deployment cannot tell (studio-user is not running):
    /// every `person_id` is then absent for that reason, not for want of one.
    pub identities_available: bool,
}

/// GitHub logins compare without case, the way GitHub treats them and the
/// alias store keeps them.
pub fn key(login: &str) -> String {
    login.trim().to_lowercase()
}

/// Match the plan's people.
///
/// `owners` is login → person for the plan's logins that are confirmed;
/// `members` the organization's active members; `held` member → their
/// confirmed GitHub logins.
pub fn link(
    people: &[PersonDto],
    owners: &BTreeMap<String, String>,
    members: &BTreeSet<String>,
    held: &BTreeMap<String, Vec<String>>,
) -> PlanPeopleDto {
    let owners: BTreeMap<String, &String> = owners.iter().map(|(k, v)| (key(k), v)).collect();
    let items: Vec<PlanPersonLinkDto> = people
        .iter()
        .map(|p| {
            let person_id = owners.get(&key(&p.login)).map(|s| (*s).clone());
            PlanPersonLinkDto {
                member: person_id.as_ref().is_some_and(|id| members.contains(id)),
                login: p.login.clone(),
                alias: p.alias.clone(),
                team: p.team.clone(),
                person_id,
            }
        })
        .collect();
    let planned: BTreeSet<String> = people.iter().map(|p| key(&p.login)).collect();
    let mut unplanned = Vec::new();
    let mut without = 0u32;
    for m in members {
        match held.get(m).filter(|logins| !logins.is_empty()) {
            None => without += 1,
            Some(logins) => {
                if !logins.iter().any(|l| planned.contains(&key(l))) {
                    unplanned.push(UnplannedMemberDto {
                        person_id: m.clone(),
                        github: logins.clone(),
                    });
                }
            }
        }
    }
    PlanPeopleDto {
        people: items,
        unplanned,
        members_without_github: without,
        identities_available: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(login: &str) -> PersonDto {
        PersonDto {
            login: login.into(),
            alias: None,
            team: None,
            unit: None,
            power: None,
            email: None,
        }
    }

    #[test]
    fn a_login_is_linked_by_a_confirmed_alias_and_a_member_is_told_from_an_outsider() {
        let people = [
            person("Zed-Example"),
            person("outside-example"),
            person("nobody-example"),
        ];
        // The alias store keeps logins lower-cased.
        let owners = BTreeMap::from([
            ("zed-example".to_string(), "p-zed".to_string()),
            ("outside-example".to_string(), "p-out".to_string()),
        ]);
        let members =
            BTreeSet::from(["p-zed".to_string(), "p-amy".to_string(), "p-bo".to_string()]);
        let held = BTreeMap::from([
            ("p-zed".to_string(), vec!["zed-example".to_string()]),
            ("p-amy".to_string(), vec!["amy-example".to_string()]),
        ]);
        let out = link(&people, &owners, &members, &held);
        assert_eq!(out.people.len(), 3);
        assert_eq!(
            (out.people[0].person_id.as_deref(), out.people[0].member),
            (Some("p-zed"), true),
            "found whatever the case of the login"
        );
        assert_eq!(
            (out.people[1].person_id.as_deref(), out.people[1].member),
            (Some("p-out"), false),
            "a Studio person who is not in this organization"
        );
        assert_eq!(out.people[2].person_id, None);
        // A member with a GitHub account the plan does not list, and one with none.
        assert_eq!(
            out.unplanned,
            vec![UnplannedMemberDto {
                person_id: "p-amy".into(),
                github: vec!["amy-example".into()],
            }]
        );
        assert_eq!(out.members_without_github, 1);
    }
}
