//! Who an open pull request is waiting on.
//!
//! A pull request is a queue with one person at the front of it at a time:
//! somebody asked to review it, its author, or — the case worth finding —
//! nobody at all. This module says which, from what a sync stored on the
//! `pull_request` node, and nothing else: no provider call, no clock but the
//! one handed in, no IO. The rules are stated as tests below because they are
//! the product here, and a reader who disagrees with a bucket should be able
//! to find the line that put it there.
//!
//! Every open pull request lands in exactly ONE bucket, checked in this order:
//!
//! 1. **draft** — the author marked it as not ready. Whatever else is on it,
//!    nobody is expected to act before the author does.
//! 2. **author** — a reviewer asked for changes and was not asked to look
//!    again since. Changes outrank a pending review: a second reviewer has
//!    little to say about code that is about to change.
//! 3. **review** — somebody (or a team) was asked to review it and has not
//!    answered. GitHub keeps that list current: a review removes the login, a
//!    request to look again puts it back. So a reviewer who asked for changes
//!    and was asked again is owed by the reviewer, not the author.
//! 4. **author** — review conversations are still open, or it was reviewed
//!    with comments only and nobody approved it.
//! 5. **merge** — approved, nothing outstanding: it is waiting to be merged,
//!    which is the author's move by default.
//! 6. **nobody** — open, not a draft, and nobody was ever asked. The stuck
//!    pull request a manager cannot see from anywhere else.

use serde_json::Value;

use super::activity::parse_rfc3339_ms;

/// What an open pull request is waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Waiting {
    Review,
    Author,
    Merge,
    Draft,
    Nobody,
}

impl Waiting {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Author => "author",
            Self::Merge => "merge",
            Self::Draft => "draft",
            Self::Nobody => "nobody",
        }
    }
}

/// One reviewer's last word, as the sync stored it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub login: String,
    /// `approved`, `changes_requested` or `commented`.
    pub state: String,
}

/// What a pull request is classified on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PullFacts {
    pub author: Option<String>,
    pub draft: bool,
    /// Logins still owing a review.
    pub requested_reviewers: Vec<String>,
    /// Teams still owing a review.
    pub requested_teams: Vec<String>,
    /// `None` when the reviews could not be read — not the same as nobody
    /// having reviewed it, and the verdict says so.
    pub reviews: Option<Vec<Review>>,
    pub open_threads: Option<usize>,
}

/// The bucket, who is at the front of it, and why — in words a person who
/// has never opened a pull request can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub waiting: Waiting,
    /// Logins it is waiting on. Empty for `nobody`, and for an author the
    /// provider did not name.
    pub on: Vec<String>,
    /// Teams it is waiting on (only ever for `review`).
    pub teams: Vec<String>,
    pub reason: String,
}

fn same_login(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Decisions of one kind still standing: made by somebody who has not been
/// asked to look again since. Asking again is asking for a new decision, so
/// the old one, approval or request for changes, no longer stands.
fn standing<'a>(requested: &[String], reviews: &'a [Review], state: &str) -> Vec<&'a str> {
    reviews
        .iter()
        .filter(|r| r.state == state)
        .filter(|r| !requested.iter().any(|q| same_login(q, &r.login)))
        .map(|r| r.login.as_str())
        .collect()
}

fn outstanding_changes<'a>(requested: &[String], reviews: &'a [Review]) -> Vec<&'a str> {
    standing(requested, reviews, "changes_requested")
}

/// The review decision the stored facts amount to: `changes_requested`,
/// `approved`, `review_required`, or `None` when nobody was asked and nobody
/// decided anything.
///
/// Ours, not the provider's: GitHub's own `reviewDecision` is null on every
/// repository without a branch protection rule, which is most of them.
pub fn review_decision(
    requested: &[String],
    teams: &[String],
    reviews: &[Review],
) -> Option<&'static str> {
    if !outstanding_changes(requested, reviews).is_empty() {
        Some("changes_requested")
    } else if !standing(requested, reviews, "approved").is_empty() {
        Some("approved")
    } else if !requested.is_empty() || !teams.is_empty() || !reviews.is_empty() {
        Some("review_required")
    } else {
        None
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Which bucket a pull request is in. See the module comment for the order.
pub fn classify(f: &PullFacts) -> Verdict {
    let author: Vec<String> = f.author.iter().cloned().collect();
    let verdict = |waiting, on: Vec<String>, teams: Vec<String>, reason: String| Verdict {
        waiting,
        on,
        teams,
        reason,
    };
    if f.draft {
        return verdict(
            Waiting::Draft,
            author,
            vec![],
            "Marked as a draft: the author is still working on it.".into(),
        );
    }
    let reviews = f.reviews.as_deref().unwrap_or_default();
    if !outstanding_changes(&f.requested_reviewers, reviews).is_empty() {
        return verdict(
            Waiting::Author,
            author,
            vec![],
            "Changes were asked for in review.".into(),
        );
    }
    if !f.requested_reviewers.is_empty() || !f.requested_teams.is_empty() {
        let again = f
            .requested_reviewers
            .iter()
            .any(|q| reviews.iter().any(|r| same_login(&r.login, q)));
        return verdict(
            Waiting::Review,
            f.requested_reviewers.clone(),
            f.requested_teams.clone(),
            if again {
                "Asked to be reviewed again, and not reviewed since.".into()
            } else {
                "Asked to be reviewed, and not reviewed yet.".into()
            },
        );
    }
    if let Some(open) = f.open_threads.filter(|n| *n > 0) {
        return verdict(
            Waiting::Author,
            author,
            vec![],
            format!(
                "{} still open.",
                plural(open, "review conversation is", "review conversations are")
            ),
        );
    }
    if reviews.iter().any(|r| r.state == "approved") {
        return verdict(
            Waiting::Merge,
            author,
            vec![],
            "Approved, and not merged yet.".into(),
        );
    }
    if !reviews.is_empty() {
        return verdict(
            Waiting::Author,
            author,
            vec![],
            "Reviewed with comments; nobody has approved it.".into(),
        );
    }
    verdict(
        Waiting::Nobody,
        vec![],
        vec![],
        if f.reviews.is_none() {
            "Nobody has been asked to review it (its reviews could not be read).".into()
        } else {
            "Nobody has been asked to review it.".into()
        },
    )
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The reviews a node carries, or `None` when it carries none — a node a sync
/// wrote before the field existed, or one whose reviews could not be read.
pub fn reviews_of(value: &Value) -> Option<Vec<Review>> {
    value.get("reviews").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|r| {
                Some(Review {
                    login: r.get("login")?.as_str()?.to_owned(),
                    state: r.get("state")?.as_str()?.to_owned(),
                })
            })
            .collect()
    })
}

/// The facts of an OPEN pull request node; `None` for any other.
pub fn facts_of(value: &Value) -> Option<PullFacts> {
    let open = value.get("state").and_then(Value::as_str) == Some("open")
        && value.get("merged").and_then(Value::as_bool) != Some(true);
    if !open {
        return None;
    }
    Some(PullFacts {
        author: value
            .get("author")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned),
        draft: value.get("draft").and_then(Value::as_bool).unwrap_or(false),
        requested_reviewers: strings(value, "requested_reviewers"),
        requested_teams: strings(value, "requested_teams"),
        reviews: reviews_of(value),
        open_threads: value
            .get("open_threads")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok()),
    })
}

/// One open pull request, classified, with what a reader needs to find it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitingPull {
    /// Instance id of the node.
    pub id: String,
    /// Instance id of its repo node.
    pub repo: Option<String>,
    pub number: i64,
    pub title: String,
    pub url: Option<String>,
    pub facts: PullFacts,
    pub assignees: Vec<String>,
    pub verdict: Verdict,
    pub review_decision: Option<&'static str>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Whole days since it was opened, against the instant handed in.
    pub days_open: Option<u32>,
    /// Whole days since anything happened on it.
    pub days_since_update: Option<u32>,
}

const DAY_MS: i64 = 86_400_000;

fn whole_days(since: Option<&str>, now_ms: i64) -> Option<u32> {
    let then = parse_rfc3339_ms(since?)?;
    u32::try_from((now_ms - then).max(0) / DAY_MS).ok()
}

/// Every open pull request among `pulls`, classified — the longest-quiet
/// first, because that is the one somebody has forgotten. An undated one goes
/// last rather than first.
pub fn waiting_pulls(pulls: &[(String, Value)], now_ms: i64) -> Vec<WaitingPull> {
    let mut out: Vec<WaitingPull> = pulls
        .iter()
        .filter_map(|(id, value)| {
            let facts = facts_of(value)?;
            let text = |key: &str| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            };
            let verdict = classify(&facts);
            let review_decision = facts.reviews.as_deref().and_then(|reviews| {
                review_decision(&facts.requested_reviewers, &facts.requested_teams, reviews)
            });
            let created_at = text("created_at");
            let updated_at = text("updated_at");
            Some(WaitingPull {
                id: id.clone(),
                repo: text("repo"),
                number: value.get("number").and_then(Value::as_i64).unwrap_or(0),
                title: text("title").unwrap_or_default(),
                url: text("url"),
                assignees: strings(value, "assignees"),
                verdict,
                review_decision,
                days_open: whole_days(created_at.as_deref(), now_ms),
                days_since_update: whole_days(updated_at.as_deref(), now_ms),
                created_at,
                updated_at,
                facts,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        let quiet = |p: &WaitingPull| {
            p.updated_at
                .as_deref()
                .and_then(parse_rfc3339_ms)
                .unwrap_or(i64::MAX)
        };
        quiet(a)
            .cmp(&quiet(b))
            .then_with(|| a.repo.cmp(&b.repo))
            .then_with(|| a.number.cmp(&b.number))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn review(login: &str, state: &str) -> Review {
        Review {
            login: login.into(),
            state: state.into(),
        }
    }

    fn facts() -> PullFacts {
        PullFacts {
            author: Some("alice".into()),
            reviews: Some(vec![]),
            open_threads: Some(0),
            ..PullFacts::default()
        }
    }

    fn logins(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn nobody_asked_is_its_own_bucket() {
        let v = classify(&facts());
        assert_eq!(v.waiting, Waiting::Nobody);
        assert!(v.on.is_empty());
        assert_eq!(v.reason, "Nobody has been asked to review it.");
    }

    #[test]
    fn unread_reviews_are_said_rather_than_read_as_none() {
        let v = classify(&PullFacts {
            reviews: None,
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Nobody);
        assert!(v.reason.contains("could not be read"), "{}", v.reason);
    }

    #[test]
    fn a_requested_reviewer_who_has_not_answered_is_who_it_waits_on() {
        let v = classify(&PullFacts {
            requested_reviewers: logins(&["bob", "carol"]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Review);
        assert_eq!(v.on, logins(&["bob", "carol"]));
        assert_eq!(v.reason, "Asked to be reviewed, and not reviewed yet.");
    }

    #[test]
    fn a_team_asked_to_review_is_waited_on_too() {
        let v = classify(&PullFacts {
            requested_teams: logins(&["Backend"]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Review);
        assert!(v.on.is_empty());
        assert_eq!(v.teams, logins(&["Backend"]));
    }

    #[test]
    fn a_draft_waits_on_its_author_whatever_else_is_on_it() {
        let v = classify(&PullFacts {
            draft: true,
            requested_reviewers: logins(&["bob"]),
            reviews: Some(vec![review("carol", "changes_requested")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Draft);
        assert_eq!(v.on, logins(&["alice"]));
    }

    #[test]
    fn changes_requested_put_it_back_with_the_author() {
        let v = classify(&PullFacts {
            reviews: Some(vec![review("bob", "changes_requested")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Author);
        assert_eq!(v.on, logins(&["alice"]));
        assert_eq!(v.reason, "Changes were asked for in review.");
    }

    /// Changes outrank a second reviewer who has not looked yet: the code is
    /// about to change under them.
    #[test]
    fn changes_requested_outrank_a_pending_reviewer() {
        let v = classify(&PullFacts {
            requested_reviewers: logins(&["carol"]),
            reviews: Some(vec![review("bob", "changes_requested")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Author);
    }

    /// The author answered the changes and asked the same reviewer again: the
    /// ball is with the reviewer now.
    #[test]
    fn asked_again_after_changes_waits_on_the_reviewer() {
        let v = classify(&PullFacts {
            requested_reviewers: logins(&["Bob"]),
            reviews: Some(vec![review("bob", "changes_requested")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Review);
        assert_eq!(v.on, logins(&["Bob"]));
        assert_eq!(
            v.reason,
            "Asked to be reviewed again, and not reviewed since."
        );
    }

    #[test]
    fn open_conversations_wait_on_the_author_when_no_review_is_owed() {
        let v = classify(&PullFacts {
            open_threads: Some(3),
            reviews: Some(vec![review("bob", "approved")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Author);
        assert_eq!(v.reason, "3 review conversations are still open.");
        let one = classify(&PullFacts {
            open_threads: Some(1),
            ..facts()
        });
        assert_eq!(one.reason, "1 review conversation is still open.");
    }

    #[test]
    fn open_conversations_do_not_outrank_a_review_still_owed() {
        let v = classify(&PullFacts {
            open_threads: Some(3),
            requested_reviewers: logins(&["bob"]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Review);
    }

    #[test]
    fn approved_and_nothing_outstanding_is_ready_to_merge() {
        let v = classify(&PullFacts {
            reviews: Some(vec![review("bob", "approved"), review("dave", "commented")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Merge);
        assert_eq!(v.on, logins(&["alice"]));
    }

    #[test]
    fn comments_without_an_approval_wait_on_the_author() {
        let v = classify(&PullFacts {
            reviews: Some(vec![review("dave", "commented")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Author);
        assert_eq!(v.reason, "Reviewed with comments; nobody has approved it.");
    }

    #[test]
    fn an_author_nobody_named_leaves_the_queue_unnamed_not_wrong() {
        let v = classify(&PullFacts {
            author: None,
            reviews: Some(vec![review("bob", "approved")]),
            ..facts()
        });
        assert_eq!(v.waiting, Waiting::Merge);
        assert!(v.on.is_empty());
    }

    #[test]
    fn the_decision_follows_the_same_rules() {
        let none: [String; 0] = [];
        assert_eq!(review_decision(&none, &none, &[]), None);
        assert_eq!(
            review_decision(&logins(&["bob"]), &none, &[]),
            Some("review_required")
        );
        assert_eq!(
            review_decision(&none, &none, &[review("bob", "approved")]),
            Some("approved")
        );
        assert_eq!(
            review_decision(
                &none,
                &none,
                &[
                    review("bob", "approved"),
                    review("carol", "changes_requested")
                ]
            ),
            Some("changes_requested")
        );
        // Asked again: the request for changes is no longer standing.
        assert_eq!(
            review_decision(
                &logins(&["carol"]),
                &none,
                &[
                    review("bob", "approved"),
                    review("carol", "changes_requested")
                ]
            ),
            Some("approved")
        );
        // Nor is an approval: the one approver was asked to look again, which
        // GitHub also reads as "review required" (studio-web#648, 2026-10-07).
        assert_eq!(
            review_decision(&logins(&["bob"]), &none, &[review("bob", "approved")]),
            Some("review_required")
        );
        assert_eq!(
            review_decision(&none, &none, &[review("dave", "commented")]),
            Some("review_required")
        );
    }

    fn node(extra: Value) -> Value {
        let mut v = json!({
            "repo": "r1", "number": 7, "title": "Add the thing", "state": "open",
            "merged": false, "author": "alice", "url": "https://example.test/pull/7",
            "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-05T12:00:00Z",
        });
        if let (Some(obj), Some(more)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in more {
                obj.insert(k.clone(), val.clone());
            }
        }
        v
    }

    const NOW: i64 = 1_791_331_200_000; // 2026-10-07T00:00:00Z

    #[test]
    fn a_node_written_before_the_review_fields_still_reads() {
        let facts = facts_of(&node(json!({}))).expect("open");
        assert_eq!(facts.reviews, None);
        assert!(!facts.draft);
        assert!(facts.requested_reviewers.is_empty());
        assert_eq!(classify(&facts).waiting, Waiting::Nobody);
    }

    #[test]
    fn only_open_pull_requests_are_classified() {
        assert!(facts_of(&node(json!({ "state": "closed" }))).is_none());
        assert!(facts_of(&node(json!({ "state": "merged", "merged": true }))).is_none());
        assert!(facts_of(&node(json!({ "merged": true }))).is_none());
    }

    #[test]
    fn a_node_reads_into_the_facts_it_carries() {
        let facts = facts_of(&node(json!({
            "draft": false,
            "requested_reviewers": ["bob", ""],
            "requested_teams": ["Backend"],
            "reviews": [{ "login": "carol", "state": "approved" }, { "login": 3 }],
            "open_threads": 2,
        })))
        .unwrap();
        assert_eq!(facts.requested_reviewers, logins(&["bob"]));
        assert_eq!(facts.requested_teams, logins(&["Backend"]));
        assert_eq!(facts.reviews, Some(vec![review("carol", "approved")]));
        assert_eq!(facts.open_threads, Some(2));
    }

    #[test]
    fn ages_are_whole_days_against_one_instant() {
        let pulls = vec![("p7".to_owned(), node(json!({})))];
        let got = waiting_pulls(&pulls, NOW);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].days_open, Some(6));
        assert_eq!(got[0].days_since_update, Some(1));
        assert_eq!(got[0].url.as_deref(), Some("https://example.test/pull/7"));
        assert_eq!(got[0].verdict.waiting, Waiting::Nobody);
    }

    #[test]
    fn the_longest_quiet_comes_first_and_the_undated_last() {
        let pulls = vec![
            (
                "recent".to_owned(),
                node(json!({ "number": 1, "updated_at": "2026-10-06T00:00:00Z" })),
            ),
            (
                "undated".to_owned(),
                node(json!({ "number": 2, "updated_at": null })),
            ),
            (
                "stale".to_owned(),
                node(json!({ "number": 3, "updated_at": "2026-09-01T00:00:00Z" })),
            ),
            (
                "closed".to_owned(),
                node(json!({ "number": 4, "state": "closed" })),
            ),
        ];
        let order: Vec<String> = waiting_pulls(&pulls, NOW)
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(order, vec!["stale", "recent", "undated"]);
    }

    #[test]
    fn the_decision_is_unset_when_the_reviews_are_unknown() {
        let pulls = vec![
            (
                "known".to_owned(),
                node(json!({ "reviews": [{ "login": "bob", "state": "approved" }] })),
            ),
            ("unknown".to_owned(), node(json!({ "number": 8 }))),
        ];
        let got = waiting_pulls(&pulls, NOW);
        let by_id = |id: &str| got.iter().find(|p| p.id == id).unwrap().review_decision;
        assert_eq!(by_id("known"), Some("approved"));
        assert_eq!(by_id("unknown"), None);
    }
}
