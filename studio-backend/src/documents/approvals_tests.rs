use super::*;

fn reviewer(person: &str, required: bool) -> Reviewer {
    Reviewer {
        person: person.to_string(),
        name: Some(person.to_uppercase()),
        required,
        stakeholder: None,
    }
}

fn verdict(approver: &str, verdict: &str, at: OffsetDateTime) -> Verdict {
    Verdict {
        approver: approver.to_string(),
        verdict: verdict.to_string(),
        security: false,
        decided_at: at,
    }
}

fn security_concern(approver: &str, at: OffsetDateTime) -> Verdict {
    Verdict {
        security: true,
        ..verdict(approver, "changes_requested", at)
    }
}

/// 2026-10-13 10:00 and 11:00 UTC.
fn t(hour: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_791_885_600 + (hour - 10) * 3600)
        .expect("a valid instant")
}

#[test]
fn a_request_waits_on_its_required_reviewers_until_their_latest_verdict_approves() {
    let reviewers = [
        reviewer("ann", true),
        reviewer("bob", true),
        reviewer("cy", false),
    ];
    let none: Vec<Verdict> = Vec::new();
    let names = |rs: Vec<&Reviewer>| rs.into_iter().map(|r| r.person.clone()).collect::<Vec<_>>();
    assert_eq!(names(outstanding(&reviewers, &none)), ["ann", "bob"]);
    assert_eq!(names(awaiting(&reviewers, &none)), ["ann", "bob", "cy"]);

    let some = [
        verdict("ann", "changes_requested", t(10)),
        verdict("ann", "approved", t(11)),
        verdict("bob", "approved", t(10)),
    ];
    assert!(outstanding(&reviewers, &some).is_empty());
    assert!(approved(&reviewers, &some, &[]));
    // An optional reviewer who never answered does not hold it, but is
    // still awaited.
    assert_eq!(names(awaiting(&reviewers, &some)), ["cy"]);
}

#[test]
fn the_latest_verdict_wins_whatever_order_they_are_read_in() {
    let reviewers = [reviewer("ann", true)];
    let back_to_changes = [
        verdict("ann", "changes_requested", t(11)),
        verdict("ann", "approved", t(10)),
    ];
    assert!(!approved(&reviewers, &back_to_changes, &[]));
}

#[test]
fn with_no_required_reviewer_one_approval_is_enough() {
    let reviewers = [reviewer("ann", false), reviewer("bob", false)];
    assert!(!approved(&reviewers, &[], &[]));
    assert!(approved(
        &reviewers,
        &[verdict("bob", "approved", t(10))],
        &[]
    ));
}

#[test]
fn late_means_past_due_and_not_approved() {
    let reviewers = [reviewer("ann", true)];
    assert!(overdue(Some(t(10)), &reviewers, &[], t(11)));
    assert!(!overdue(Some(t(11)), &reviewers, &[], t(10)));
    assert!(!overdue(None, &reviewers, &[], t(11)));
    assert!(!overdue(
        Some(t(10)),
        &reviewers,
        &[verdict("ann", "approved", t(10))],
        t(11)
    ));
}

#[test]
fn suggestions_rank_this_document_then_its_type_by_how_often_and_skip_the_requester() {
    let a = [reviewer("ann", true), reviewer("me", true)];
    let b = [reviewer("bob", false), reviewer("cy", true)];
    let c = [reviewer("cy", true), reviewer("dan", true)];
    let other_type = [reviewer("eve", true)];
    let earlier = [
        Earlier {
            subject_id: "doc-1",
            type_key: Some("prd"),
            reviewers: &a,
        },
        Earlier {
            subject_id: "doc-2",
            type_key: Some("prd"),
            reviewers: &b,
        },
        Earlier {
            subject_id: "doc-3",
            type_key: Some("prd"),
            reviewers: &c,
        },
        Earlier {
            subject_id: "doc-4",
            type_key: Some("adr"),
            reviewers: &other_type,
        },
    ];
    let got = suggest(&earlier, "doc-1", Some("prd"), "me", 10);
    let people: Vec<&str> = got.iter().map(|r| r.person.as_str()).collect();
    assert_eq!(people, ["ann", "cy", "bob", "dan"]);
    assert!(!got[2].required, "bob was optional when last asked");
    assert_eq!(suggest(&earlier, "doc-1", Some("prd"), "me", 2).len(), 2);
}

fn people(rs: Vec<&Reviewer>) -> Vec<String> {
    rs.into_iter().map(|r| r.person.clone()).collect()
}

#[test]
fn below_stable_a_review_is_advice_and_at_stable_or_undeclared_a_gate() {
    for level in ["design", "experimental", "preview"] {
        assert!(advisory(Some(level)), "{level}");
    }
    for level in [Some("stable"), Some("deprecated"), Some("alpha"), None] {
        assert!(!advisory(level), "{level:?}");
    }

    let reviewers = [reviewer("ann", true), reviewer("bob", true)];
    let asked = [verdict("ann", "changes_requested", t(10))];
    // Stable and undeclared hold on everyone required who has not approved,
    // as before; an experiment holds on nobody.
    assert_eq!(
        people(holding(&reviewers, &asked, Some("stable"), true)),
        ["ann", "bob"]
    );
    assert_eq!(
        people(holding(&reviewers, &asked, None, true)),
        ["ann", "bob"]
    );
    assert!(holding(&reviewers, &asked, Some("experimental"), true).is_empty());
    // An earlier version than the one there now: every required reviewer
    // holds a stable document, nobody an experimental one.
    assert_eq!(
        people(holding(&reviewers, &[], Some("stable"), false)),
        ["ann", "bob"]
    );
    assert!(holding(&reviewers, &[], Some("preview"), false).is_empty());
}

#[test]
fn a_security_concern_holds_at_any_maturity_until_its_reviewer_answers_again() {
    let reviewers = [reviewer("ann", true), reviewer("cy", false)];
    let concern = [
        verdict("ann", "approved", t(10)),
        security_concern("cy", t(10)),
    ];
    for level in [Some("design"), Some("preview"), Some("stable"), None] {
        assert_eq!(
            people(holding(&reviewers, &concern, level, true)),
            ["cy"],
            "{level:?}"
        );
        assert!(
            people(holding(&reviewers, &concern, level, false)).contains(&"cy".to_string()),
            "a new version does not lift it: {level:?}"
        );
    }
    // Every required reviewer approved, and still the request stays open.
    assert!(!approved(&reviewers, &concern, &[]));
    assert_eq!(people(security_concerns(&reviewers, &concern)), ["cy"]);

    let answered = [
        verdict("ann", "approved", t(10)),
        security_concern("cy", t(10)),
        verdict("cy", "approved", t(11)),
    ];
    assert!(holding(&reviewers, &answered, Some("experimental"), true).is_empty());
    assert!(approved(&reviewers, &answered, &[]));

    // Asking for changes without marking them a security concern is advice
    // below stable.
    let plain = [verdict("cy", "changes_requested", t(10))];
    assert!(holding(&reviewers, &plain, Some("experimental"), true).is_empty());
}

fn speaking_for(person: &str, stakeholder: &str) -> Reviewer {
    Reviewer {
        stakeholder: Some(stakeholder.to_string()),
        ..reviewer(person, true)
    }
}

#[test]
fn one_approval_answers_for_its_stakeholder() {
    let reviewers = [
        speaking_for("ann", "Acronis"),
        speaking_for("abe", "acronis "),
        speaking_for("vic", "Virtuozzo"),
    ];
    let ann = [verdict("ann", "approved", t(1))];
    let waiting: Vec<&str> = outstanding(&reviewers, &ann)
        .iter()
        .map(|r| r.person.as_str())
        .collect();
    assert_eq!(
        waiting,
        ["vic"],
        "abe speaks for Acronis, which ann answered for"
    );
    assert!(!approved(&reviewers, &ann, &[]));
    let both = [ann[0].clone(), verdict("vic", "approved", t(2))];
    assert!(approved(&reviewers, &both, &[]));
}

#[test]
fn a_required_stakeholder_nobody_approved_for_holds_the_request() {
    let reviewers = [speaking_for("ann", "Acronis"), reviewer("bob", false)];
    let required = ["Acronis".to_string(), "Constructor".to_string()];
    let ann = [verdict("ann", "approved", t(1))];
    assert_eq!(
        silent_stakeholders(&required, &reviewers, &ann),
        ["Constructor"]
    );
    assert!(
        !approved(&reviewers, &ann, &required),
        "nobody speaks for Constructor yet"
    );
    let states = stakeholders(&required, &reviewers, &ann);
    assert_eq!(states.len(), 2);
    assert_eq!(states[0].approved_by, ["ANN"]);
    assert!(states[1].required && states[1].asked.is_empty());
}

#[test]
fn a_maturity_lowered_mid_review_does_not_lower_the_bar() {
    assert_eq!(
        governing_maturity(Some("stable"), Some("design")).as_deref(),
        Some("stable")
    );
    assert_eq!(
        governing_maturity(Some("preview"), Some("stable")).as_deref(),
        Some("stable")
    );
    assert_eq!(
        governing_maturity(Some("preview"), None),
        None,
        "no level now is the full gate"
    );
    assert_eq!(
        governing_maturity(None, Some("experimental")).as_deref(),
        Some("experimental")
    );
}
