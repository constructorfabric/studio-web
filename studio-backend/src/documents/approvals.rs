//! Review requests on a project's documents and the approvals given on them
//! (`docs/design/studio-documents.md`, "Reviews and approvals").
//!
//! A request names one version of one document, the people asked to review
//! it, which of them are required, and when it is due. An approval is a
//! record of one person's verdict on that version, kept as written and never
//! edited: a later verdict is another record. Everything here is the pure
//! part — who is still awaited, whether it is late, whom to suggest — so the
//! gate and the inbox read the same answer. How much a review holds a stage
//! follows the document's maturity ([`holding`]): below `stable` it is advice,
//! and a security concern holds it at every level.
//!
//! A reviewer may speak for a stakeholder -- an organization the document
//! answers to, as a gear's demand names its consumers (Acronis, Constructor,
//! Virtuozzo). One approval from a stakeholder answers for it: the other
//! required reviewers of the same stakeholder are no longer awaited. A request
//! may also name the stakeholders that must approve ([`stakeholders`]); one
//! nobody of theirs has approved for holds the request like a required
//! reviewer.
//!
//! What a review is judged by is fixed when it is asked for: the maturity the
//! version declared then ([`governing_maturity`]) and the type's template and
//! review guide then (`review_guide::RulesSnapshot`). A level lowered or a
//! convention changed mid-review does not move the bar under it.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// One person asked to review.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reviewer {
    /// Canonical person id (ADR-0025).
    pub person: String,
    #[serde(default)]
    pub name: Option<String>,
    /// The request is not approved until every required reviewer approves.
    #[serde(default = "yes")]
    pub required: bool,
    /// The stakeholder they speak for (an organization), when the requester
    /// named one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stakeholder: Option<String>,
}

fn yes() -> bool {
    true
}

/// `approved`, or `changes_requested`.
pub const VERDICTS: [&str; 2] = ["approved", "changes_requested"];

/// One verdict as it was recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub approver: String,
    pub verdict: String,
    /// The reviewer marked the changes they ask for as a security concern:
    /// what holds a stage at every maturity.
    pub security: bool,
    pub decided_at: OffsetDateTime,
}

/// The maturities below `stable` (gears-rust #5275). A review of a document
/// at one of them is advice: it records what people think, and only a
/// security concern holds the stage on it.
pub const ADVISORY_MATURITIES: [&str; 3] = ["design", "experimental", "preview"];

/// Whether a review of a document at this maturity is advice rather than a
/// gate. `stable`, `deprecated`, an unknown level and no level at all keep
/// the full gate.
pub fn advisory(maturity: Option<&str>) -> bool {
    maturity.is_some_and(|m| ADVISORY_MATURITIES.contains(&m))
}

/// The maturity a review is held to: the one the version declared when the
/// review was asked for, unless the document declares a stricter one now. A
/// level lowered mid-review does not turn a gate into advice; a level raised
/// does raise the bar. `at_start` is `None` for a request from before the
/// text was kept, which then follows the document as it is now.
pub fn governing_maturity(at_start: Option<&str>, now: Option<&str>) -> Option<String> {
    match at_start {
        Some(start) if !advisory(Some(start)) => Some(start.to_owned()),
        _ => now.map(str::to_owned),
    }
}

/// A stakeholder's name as it is compared: trimmed, case ignored.
fn stakeholder_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Each reviewer's latest verdict, by person.
fn latest(verdicts: &[Verdict]) -> BTreeMap<&str, &Verdict> {
    let mut out: BTreeMap<&str, &Verdict> = BTreeMap::new();
    for v in verdicts {
        match out.get(v.approver.as_str()) {
            Some(prev) if prev.decided_at > v.decided_at => {}
            _ => {
                out.insert(v.approver.as_str(), v);
            }
        }
    }
    out
}

/// The required reviewers whose latest verdict is not an approval: what keeps
/// the request, and the stage gated on it, open.
/// A required reviewer is not awaited once somebody speaking for the same
/// stakeholder approved: one approval answers for the stakeholder.
pub fn outstanding<'r>(reviewers: &'r [Reviewer], verdicts: &[Verdict]) -> Vec<&'r Reviewer> {
    let latest = latest(verdicts);
    let approves = |r: &Reviewer| {
        latest
            .get(r.person.as_str())
            .is_some_and(|v| v.verdict == "approved")
    };
    let answered: BTreeSet<String> = reviewers
        .iter()
        .filter(|r| approves(r))
        .filter_map(|r| r.stakeholder.as_deref().map(stakeholder_key))
        .collect();
    reviewers
        .iter()
        .filter(|r| r.required)
        .filter(|r| !approves(r))
        .filter(|r| {
            !r.stakeholder
                .as_deref()
                .is_some_and(|s| answered.contains(&stakeholder_key(s)))
        })
        .collect()
}

/// Where one stakeholder stands on a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StakeholderState {
    /// As the request or the first reviewer spelled it.
    pub name: String,
    /// The request names it as one that must approve.
    pub required: bool,
    /// Its reviewers whose latest verdict is an approval, by name.
    pub approved_by: Vec<String>,
    /// Every reviewer asked on its behalf, by name.
    pub asked: Vec<String>,
}

/// Every stakeholder of a request: the ones it requires, in its order, then
/// any other a reviewer speaks for, by name.
pub fn stakeholders(
    required: &[String],
    reviewers: &[Reviewer],
    verdicts: &[Verdict],
) -> Vec<StakeholderState> {
    let latest = latest(verdicts);
    let shown = |r: &Reviewer| r.name.clone().unwrap_or_else(|| r.person.clone());
    let mut others: Vec<&str> = reviewers
        .iter()
        .filter_map(|r| r.stakeholder.as_deref())
        .collect();
    others.sort_by_key(|s| stakeholder_key(s));
    let names = required
        .iter()
        .map(|s| (s.as_str(), true))
        .chain(others.into_iter().map(|s| (s, false)));
    let mut seen = BTreeSet::new();
    let mut out: Vec<StakeholderState> = Vec::new();
    for (name, is_required) in names {
        let key = stakeholder_key(name);
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        let theirs: Vec<&Reviewer> = reviewers
            .iter()
            .filter(|r| {
                r.stakeholder.as_deref().map(stakeholder_key).as_deref() == Some(key.as_str())
            })
            .collect();
        out.push(StakeholderState {
            name: name.trim().to_owned(),
            required: is_required,
            approved_by: theirs
                .iter()
                .filter(|r| {
                    latest
                        .get(r.person.as_str())
                        .is_some_and(|v| v.verdict == "approved")
                })
                .map(|r| shown(r))
                .collect(),
            asked: theirs.iter().map(|r| shown(r)).collect(),
        });
    }
    out
}

/// The required stakeholders nobody of theirs has approved for: each holds
/// the request, whether anyone was asked on its behalf or not.
pub fn silent_stakeholders(
    required: &[String],
    reviewers: &[Reviewer],
    verdicts: &[Verdict],
) -> Vec<String> {
    stakeholders(required, reviewers, verdicts)
        .into_iter()
        .filter(|s| s.required && s.approved_by.is_empty())
        .map(|s| s.name)
        .collect()
}

/// The reviewers who have given no verdict yet, required or not: whose
/// action the request waits on.
pub fn awaiting<'r>(reviewers: &'r [Reviewer], verdicts: &[Verdict]) -> Vec<&'r Reviewer> {
    let latest = latest(verdicts);
    reviewers
        .iter()
        .filter(|r| !latest.contains_key(r.person.as_str()))
        .collect()
}

/// The reviewers, required or not, whose latest verdict asks for changes over
/// a security concern. Each holds the request until they give another.
pub fn security_concerns<'r>(reviewers: &'r [Reviewer], verdicts: &[Verdict]) -> Vec<&'r Reviewer> {
    let latest = latest(verdicts);
    reviewers
        .iter()
        .filter(|r| {
            latest
                .get(r.person.as_str())
                .is_some_and(|v| v.security && v.verdict == "changes_requested")
        })
        .collect()
}

/// Who holds a stage on this request, for a document at `maturity`. A
/// security concern holds it at any level. Otherwise, at `stable` or with no
/// level declared, every required reviewer who has not approved -- all of
/// them when `same_version` is false, the request being about an earlier
/// version than the one there now; below `stable`, nobody else.
pub fn holding<'r>(
    reviewers: &'r [Reviewer],
    verdicts: &[Verdict],
    maturity: Option<&str>,
    same_version: bool,
) -> Vec<&'r Reviewer> {
    let concerns = security_concerns(reviewers, verdicts);
    let waiting: Vec<&Reviewer> = if advisory(maturity) {
        Vec::new()
    } else if same_version {
        outstanding(reviewers, verdicts)
    } else {
        reviewers.iter().filter(|r| r.required).collect()
    };
    reviewers
        .iter()
        .filter(|r| {
            concerns.iter().any(|c| c.person == r.person)
                || waiting.iter().any(|w| w.person == r.person)
        })
        .collect()
}

/// Whether every required reviewer and every required stakeholder approved
/// and nobody's latest verdict is a security concern. A request with no
/// required reviewer is approved by its first approval.
pub fn approved(reviewers: &[Reviewer], verdicts: &[Verdict], stakeholders: &[String]) -> bool {
    // A request closed as approved takes no more verdicts, so one closed over
    // a security concern would hold its stage with nobody able to lift it.
    if !security_concerns(reviewers, verdicts).is_empty() {
        return false;
    }
    if !silent_stakeholders(stakeholders, reviewers, verdicts).is_empty() {
        return false;
    }
    if reviewers.iter().any(|r| r.required) {
        outstanding(reviewers, verdicts).is_empty()
    } else {
        latest(verdicts).values().any(|v| v.verdict == "approved")
    }
}

/// Past its due date with somebody still awaited.
pub fn overdue(
    due_at: Option<OffsetDateTime>,
    reviewers: &[Reviewer],
    verdicts: &[Verdict],
    now: OffsetDateTime,
) -> bool {
    due_at.is_some_and(|due| due < now) && !approved(reviewers, verdicts, &[])
}

/// One earlier request, as a suggestion reads it.
pub struct Earlier<'a> {
    pub subject_id: &'a str,
    pub type_key: Option<&'a str>,
    pub reviewers: &'a [Reviewer],
}

/// Whom to ask, from who was asked before in this project: the reviewers of
/// this very document first, then of documents of its type, each ranked by
/// how often they were asked; never the requester. Required if they were
/// required the last time they were asked.
pub fn suggest(
    earlier: &[Earlier<'_>],
    subject_id: &str,
    type_key: Option<&str>,
    requester: &str,
    limit: usize,
) -> Vec<Reviewer> {
    // (rank: 0 same document, 1 same type), count, the last entry seen.
    let mut seen: BTreeMap<String, (u8, usize, Reviewer)> = BTreeMap::new();
    for e in earlier {
        let rank = if e.subject_id == subject_id {
            0
        } else if type_key.is_some() && e.type_key == type_key {
            1
        } else {
            continue;
        };
        for r in e.reviewers {
            if r.person == requester {
                continue;
            }
            let entry = seen
                .entry(r.person.clone())
                .or_insert_with(|| (rank, 0, r.clone()));
            entry.0 = entry.0.min(rank);
            entry.1 += 1;
            entry.2 = Reviewer {
                person: r.person.clone(),
                name: r.name.clone().or(entry.2.name.clone()),
                required: r.required,
                stakeholder: r.stakeholder.clone().or(entry.2.stakeholder.clone()),
            };
        }
    }
    let mut out: Vec<(u8, usize, Reviewer)> = seen.into_values().collect();
    out.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(b.1.cmp(&a.1))
            .then(a.2.person.cmp(&b.2.person))
    });
    out.into_iter().take(limit).map(|(_, _, r)| r).collect()
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
