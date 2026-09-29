//! What has been happening, folded out of the graph a sync already filled.
//!
//! Two questions, both answered from the same nodes and both previously
//! answered in the browser:
//!
//! * **Per repository** — a week of pull-request and commit movement, for the
//!   Sources table. The product's own version of that table labels its numbers
//!   "demo values"; these are not, which is the whole point of folding them
//!   from real nodes rather than inventing a plausible seven.
//! * **Per project** — one feed of what was checked and what was said, for the
//!   Activity page.
//!
//! ── Why this is not in the browser any more ──────────────────────────────────
//!
//! Both folds needed their inputs in the page first, and both got them by
//! PAGING THE GRAPH. The Sources table walked `pull_request` and `commit`
//! newest-first until it fell out of the window — commits outnumber everything
//! else in a repository — and the Activity page walked `spec_finding` and
//! `comment` to a cap. The projection cannot narrow by a payload field, so
//! every one of those pages is a slice of the tenant's whole typed node set.
//!
//! One consequence is worth stating because it does NOT survive the move:
//! `olderThanWindow`, which let the browser stop its walk early, has no
//! counterpart here. There is no walk to stop — the projection is read once,
//! in this process, and the window is applied to what it holds.
//!
//! ── What the history can and cannot say ──────────────────────────────────────
//!
//! The feed shows the LATEST check per document and nothing before it, and that
//! is a property of the data rather than a shortcut: a `spec_finding`'s
//! instance id is keyed on (detector, subject), so re-running a detector
//! UPSERTS. There is one finding per detector per document, carrying when it
//! was last produced — a current state with a timestamp on it, not a log.
//! Comments are the other half and are a genuine history: every comment a sync
//! pulled is its own node with its own `created_at`.

use serde_json::Value;
use std::collections::BTreeMap;

/// A day, in milliseconds.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// One repository's movement over the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoActivity {
    /// Pull requests open RIGHT NOW, however old. Deliberately not windowed:
    /// one opened three weeks ago and still open is the one most worth seeing,
    /// and counting only the last seven days would hide it.
    pub open: u32,
    /// Pull requests merged inside the window. Windowed, because a merge rate
    /// is only interesting recently.
    pub merged: u32,
    /// Commits inside the window, for the same reason.
    pub commits: u32,
    /// One bucket per day, oldest first, always `days` long — so a sparkline
    /// never has to guess its own axis and a quiet repository draws a flat
    /// line rather than nothing.
    pub days: Vec<u32>,
}

impl RepoActivity {
    fn empty(days: usize) -> Self {
        Self {
            open: 0,
            merged: 0,
            commits: 0,
            days: vec![0; days],
        }
    }
}

/// Fold pull-request and commit nodes into one summary per repository.
///
/// `now` is a parameter rather than the clock so every row on one screen is
/// measured against the same instant: a render spanning midnight would
/// otherwise put two repositories on different axes.
#[must_use]
pub fn repo_activity(
    pulls: &[Value],
    commits: &[Value],
    now: i64,
    days: usize,
) -> BTreeMap<String, RepoActivity> {
    let mut out: BTreeMap<String, RepoActivity> = BTreeMap::new();
    // Buckets run to the END of today, so the last one is the day in progress
    // rather than a stub three hours wide that reads as a quiet day.
    let end = now.div_euclid(DAY_MS) * DAY_MS + DAY_MS;
    let start = end - days as i64 * DAY_MS;
    let bucket = |ms: Option<i64>| -> Option<usize> {
        let ms = ms?;
        if ms < start || ms >= end {
            return None;
        }
        usize::try_from((ms - start) / DAY_MS).ok()
    };

    for pull in pulls {
        let Some(repo) = field_str(pull, "repo") else {
            continue;
        };
        let activity = out
            .entry(repo.to_owned())
            .or_insert_with(|| RepoActivity::empty(days));
        let merged = pull.get("merged").and_then(Value::as_bool) == Some(true)
            || field_str(pull, "state") == Some("merged");
        let closed = merged || field_str(pull, "state") == Some("closed");
        if !closed {
            activity.open += 1;
        }
        // `updated_at` is when the pull request last moved, which for a merged
        // one is the merge. The node carries no `merged_at` of its own, and
        // inventing a more precise claim than the data supports is worse.
        let moved = bucket(instant(pull, "updated_at").or_else(|| instant(pull, "created_at")));
        if let Some(day) = moved {
            if merged {
                activity.merged += 1;
            }
            activity.days[day] += 1;
        }
    }

    for commit in commits {
        let Some(repo) = field_str(commit, "repo") else {
            continue;
        };
        let activity = out
            .entry(repo.to_owned())
            .or_insert_with(|| RepoActivity::empty(days));
        if bucket(instant(commit, "created_at")).is_some() {
            activity.commits += 1;
        }
    }
    out
}

// ── the feed ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Check,
    Comment,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Check => "check",
            EventKind::Comment => "comment",
        }
    }
}

/// One thing that happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityEvent {
    pub id: String,
    pub kind: EventKind,
    /// What happened, in the product's words.
    pub event: String,
    /// What it happened to — a document, or the issue a comment is on.
    pub subject: String,
    /// Who or what did it. A detector is a "who" here: the product writes
    /// "Studio" for its own checks and this names the detector, which is the
    /// same claim with more in it.
    pub by: String,
    /// RFC 3339, or `None` when the node carries no time.
    pub recorded: Option<String>,
    /// The detector's own word for how it went, when there is one.
    pub severity: Option<String>,
}

/// One feed out of findings and comments, newest first.
///
/// `name_of` turns a subject node id into something worth reading. A subject
/// nothing can name falls back to its own path and then to its id: a row
/// naming an opaque id is still a row somebody can chase, and DROPPING it
/// would hide a check that really happened.
#[must_use]
pub fn activity_feed(
    findings: &[(String, Value)],
    comments: &[(String, Value)],
    name_of: &dyn Fn(&str) -> Option<String>,
) -> Vec<ActivityEvent> {
    let mut out: Vec<ActivityEvent> = Vec::with_capacity(findings.len() + comments.len());

    for (id, value) in findings {
        let subject = field_str(value, "subject");
        let path = field_str(value, "path");
        let named = subject
            .and_then(name_of)
            .or_else(|| path.map(leaf))
            .or_else(|| subject.map(str::to_owned))
            .unwrap_or_else(|| id.clone());
        out.push(ActivityEvent {
            id: id.clone(),
            kind: EventKind::Check,
            event: "Document checked".to_owned(),
            subject: named,
            by: field_str(value, "detector").unwrap_or("Studio").to_owned(),
            recorded: field_str(value, "recorded_at").map(str::to_owned),
            severity: field_str(value, "severity").map(str::to_owned),
        });
    }

    for (id, value) in comments {
        let number = value.get("target_number").and_then(Value::as_i64);
        out.push(ActivityEvent {
            id: id.clone(),
            kind: EventKind::Comment,
            event: "Comment".to_owned(),
            // The comment's own text is its title; what it is ON is the number.
            subject: match number {
                Some(n) => format!("#{n}"),
                None => field_str(value, "title")
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.clone()),
            },
            by: field_str(value, "author").unwrap_or("unknown").to_owned(),
            recorded: field_str(value, "created_at")
                .or_else(|| field_str(value, "updated_at"))
                .map(str::to_owned),
            severity: None,
        });
    }

    // Newest first, and everything undated LAST rather than first: a missing
    // timestamp sorting to the top would put the least informative rows where
    // the most recent ones belong. Findings written before `recorded_at`
    // existed are exactly that case.
    out.sort_by(|a, b| {
        let at = a.recorded.as_deref().and_then(parse_rfc3339_ms);
        let bt = b.recorded.as_deref().and_then(parse_rfc3339_ms);
        match (at, bt) {
            (Some(x), Some(y)) if x != y => y.cmp(&x),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => a.id.cmp(&b.id),
        }
    });
    out
}

// ── one project's row ────────────────────────────────────────────────────────

/// The severities a detector writes for something still wrong. The rest —
/// `gate-passed`, `clean`, `analyzed` — are verdicts too, but nothing is left
/// to do about them, and a row counting them would call a checked project
/// busy.
const OPEN_SEVERITIES: [&str; 3] = ["high", "gate-failed", "some"];

/// What a project's row in the projects table says about its review and its
/// sources, folded from the nodes those columns are about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSignals {
    /// Findings whose verdict is still something to fix.
    pub open_findings: u32,
    /// Unresolved threads the project's repositories report: on documents and
    /// on pull requests under review. `None` when no repository could say —
    /// a GitLab source, or one never synced from a checkout.
    pub open_comments: Option<u32>,
    /// Pull requests, folded across every repository of the project, over the
    /// same window and by the same rules as the Sources table.
    pub pulls: RepoActivity,
    /// Whether any pull request was ever synced. A project whose sources were
    /// never read has no activity to show, which is a different sentence from
    /// a quiet week.
    pub pulls_known: bool,
    /// The newest thing the feed would list first, if anything.
    pub last_event: Option<ActivityEvent>,
}

/// Fold one project's nodes into its row.
///
/// `now` is a parameter for the reason [`repo_activity`] gives: every row of
/// one table is measured against the same instant.
#[must_use]
pub fn project_signals(
    findings: &[(String, Value)],
    comments: &[(String, Value)],
    pulls: &[Value],
    repos: &[Value],
    now: i64,
    days: usize,
) -> ProjectSignals {
    let open_findings = findings
        .iter()
        .filter(|(_, f)| field_str(f, "severity").is_some_and(|s| OPEN_SEVERITIES.contains(&s)))
        .count();

    let mut open_comments: Option<u32> = None;
    for repo in repos {
        for key in ["open_document_threads", "open_review_threads"] {
            if let Some(n) = repo.get(key).and_then(Value::as_u64) {
                let n = u32::try_from(n).unwrap_or(u32::MAX);
                open_comments = Some(open_comments.unwrap_or(0).saturating_add(n));
            }
        }
    }

    // Every repository on one axis: the project's row is one sparkline, not
    // one per repository. Folded from the per-repository answer so the two
    // screens cannot disagree about what counts as merged.
    let mut total = RepoActivity::empty(days);
    for a in repo_activity(pulls, &[], now, days).into_values() {
        total.open += a.open;
        total.merged += a.merged;
        for (day, n) in total.days.iter_mut().zip(a.days) {
            *day += n;
        }
    }

    ProjectSignals {
        open_findings: u32::try_from(open_findings).unwrap_or(u32::MAX),
        open_comments,
        pulls: total,
        pulls_known: !pulls.is_empty(),
        // Names only matter for reading the feed; the row shows what happened
        // and when, and falls back to the path exactly as the feed does.
        last_event: activity_feed(findings, comments, &|_| None)
            .into_iter()
            .next()
            .filter(|e| e.recorded.is_some()),
    }
}

// ── reading the nodes ────────────────────────────────────────────────────────

fn field_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn instant(value: &Value, key: &str) -> Option<i64> {
    parse_rfc3339_ms(field_str(value, key)?)
}

/// The last path segment, which is what a reader recognises.
fn leaf(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// An RFC 3339 timestamp as epoch milliseconds.
///
/// Hand-parsed rather than pulled from a date crate, because the whole of what
/// is needed is "is this before that": the nodes carry what a connector wrote,
/// which is `YYYY-MM-DDTHH:MM:SS` with an optional fraction and an optional
/// zone. Anything that is not that shape is `None`, and every caller treats
/// `None` as "no time on this node" rather than as a time.
fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !matches!(bytes[10], b'T' | b't' | b' ') || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > 31 || hour > 23 || minute > 59 || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let mut ms = ((days * 24 + hour) * 60 + minute) * 60 + second;
    ms *= 1000;

    // The offset, when there is one. `Z` and a missing zone both mean UTC
    // here: a connector that omits it is writing UTC, and guessing a local
    // zone would move every row by hours.
    let rest = &value[19..];
    let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if let Some(sign) = rest.chars().next()
        && (sign == '+' || sign == '-')
    {
        let offset = &rest[1..];
        let (oh, om) = match offset.split_once(':') {
            Some((h, m)) => (h, m),
            None if offset.len() >= 4 => (&offset[0..2], &offset[2..4]),
            None => return Some(ms),
        };
        let oh: i64 = oh.parse().ok()?;
        let om: i64 = om.get(0..2).unwrap_or(om).parse().ok()?;
        let delta = (oh * 60 + om) * 60 * 1000;
        ms += if sign == '-' { delta } else { -delta };
    }
    Some(ms)
}

/// Howard Hinnant's `days_from_civil`.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 2026-09-23T12:00:00Z, a Wednesday.
    const NOW: i64 = 1_790_164_800_000;

    fn ago(days: i64) -> String {
        let ms = NOW - days * DAY_MS;
        let secs = ms / 1000;
        let day = secs.div_euclid(86_400);
        let rest = secs.rem_euclid(86_400);
        let (y, m, d) = civil(day);
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
            rest / 3600,
            (rest % 3600) / 60,
            rest % 60
        )
    }

    fn civil(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    fn pull(state: &str, updated: &str, repo: &str) -> Value {
        json!({ "repo": repo, "state": state, "updated_at": updated })
    }

    fn commit_at(created: &str, repo: &str) -> Value {
        json!({ "repo": repo, "created_at": created })
    }

    // ---- reading the clock -------------------------------------------------

    #[test]
    fn a_timestamp_reads_back_as_the_instant_it_names() {
        assert_eq!(parse_rfc3339_ms("2026-09-23T12:00:00Z"), Some(NOW));
        // A fraction and a missing zone are both things connectors write.
        assert_eq!(parse_rfc3339_ms("2026-09-23T12:00:00.123Z"), Some(NOW));
        assert_eq!(parse_rfc3339_ms("2026-09-23T12:00:00"), Some(NOW));
        // An offset moves it, in the direction that makes the instant equal.
        assert_eq!(parse_rfc3339_ms("2026-09-23T14:00:00+02:00"), Some(NOW));
        assert_eq!(parse_rfc3339_ms("2026-09-23T10:00:00-0200"), Some(NOW));
    }

    #[test]
    fn a_time_that_is_not_one_is_no_time_rather_than_a_wrong_one() {
        for value in ["", "yesterday", "2026-09-23", "2026-13-01T00:00:00Z", "x"] {
            assert_eq!(parse_rfc3339_ms(value), None, "{value}");
        }
    }

    // ---- a week of movement ------------------------------------------------

    #[test]
    fn an_open_pull_request_counts_however_old_it_is() {
        // The one most worth seeing, and a window would hide it.
        let out = repo_activity(&[pull("open", &ago(90), "r1")], &[], NOW, 7);
        assert_eq!(out["r1"].open, 1);
        assert_eq!(out["r1"].merged, 0);
    }

    #[test]
    fn a_merge_counts_only_inside_the_window() {
        let inside = repo_activity(&[pull("merged", &ago(2), "r1")], &[], NOW, 7);
        assert_eq!(inside["r1"].merged, 1);
        let outside = repo_activity(&[pull("merged", &ago(30), "r1")], &[], NOW, 7);
        assert_eq!(outside["r1"].merged, 0);
        assert_eq!(outside["r1"].open, 0, "merged is not open");
    }

    #[test]
    fn the_merged_flag_counts_as_much_as_the_state() {
        let out = repo_activity(
            &[json!({ "repo": "r1", "merged": true, "updated_at": ago(1) })],
            &[],
            NOW,
            7,
        );
        assert_eq!(out["r1"].merged, 1);
        assert_eq!(out["r1"].open, 0);
    }

    #[test]
    fn a_closed_unmerged_pull_request_is_not_open() {
        let out = repo_activity(&[pull("closed", &ago(1), "r1")], &[], NOW, 7);
        assert_eq!(out["r1"].open, 0);
        assert_eq!(out["r1"].merged, 0);
    }

    #[test]
    fn today_is_the_last_bucket_not_a_stub_at_the_end() {
        // The window runs to the END of today, so the day in progress is a
        // whole bucket rather than three hours that read as a quiet day.
        let out = repo_activity(&[pull("open", &ago(0), "r1")], &[], NOW, 7);
        assert_eq!(out["r1"].days.last().copied(), Some(1));
    }

    #[test]
    fn days_run_oldest_first() {
        let out = repo_activity(
            &[pull("open", &ago(6), "r1"), pull("open", &ago(0), "r1")],
            &[],
            NOW,
            7,
        );
        assert_eq!(out["r1"].days.first().copied(), Some(1));
        assert_eq!(out["r1"].days.last().copied(), Some(1));
    }

    #[test]
    fn a_quiet_repository_still_gets_a_full_week_of_buckets() {
        // So a sparkline draws a flat line rather than nothing at all.
        let out = repo_activity(&[], &[commit_at(&ago(1), "r1")], NOW, 7);
        assert_eq!(out["r1"].days.len(), 7);
        assert!(out["r1"].days.iter().all(|n| *n == 0));
        assert_eq!(out["r1"].commits, 1);
    }

    #[test]
    fn repositories_are_kept_apart() {
        let out = repo_activity(
            &[pull("open", &ago(1), "r1")],
            &[commit_at(&ago(1), "r2")],
            NOW,
            7,
        );
        assert_eq!(out["r1"].open, 1);
        assert_eq!(out["r1"].commits, 0);
        assert_eq!(out["r2"].open, 0);
        assert_eq!(out["r2"].commits, 1);
    }

    #[test]
    fn a_node_with_no_repository_on_it_is_ignored() {
        let out = repo_activity(
            &[json!({ "state": "open", "updated_at": ago(1) })],
            &[json!({ "created_at": ago(1) })],
            NOW,
            7,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn a_date_that_cannot_be_read_costs_the_bucket_not_the_row() {
        // The pull request is still open; only its place on the axis is lost.
        let out = repo_activity(
            &[json!({ "repo": "r1", "state": "open", "updated_at": "not a date" })],
            &[json!({ "repo": "r1", "created_at": "also not" })],
            NOW,
            7,
        );
        assert_eq!(out["r1"].open, 1);
        assert_eq!(out["r1"].commits, 0);
        assert!(out["r1"].days.iter().all(|n| *n == 0));
    }

    // ---- the feed ----------------------------------------------------------

    fn nothing_named(_: &str) -> Option<String> {
        None
    }

    fn finding(id: &str, value: Value) -> (String, Value) {
        (id.to_owned(), value)
    }

    #[test]
    fn a_finding_reads_as_a_check_naming_the_detector_that_made_it() {
        let out = activity_feed(
            &[finding(
                "f1",
                json!({ "subject": "n1", "detector": "bloat", "recorded_at": ago(1), "severity": "high" }),
            )],
            &[],
            &nothing_named,
        );
        assert_eq!(out[0].kind, EventKind::Check);
        assert_eq!(out[0].event, "Document checked");
        assert_eq!(out[0].by, "bloat");
        assert_eq!(out[0].severity.as_deref(), Some("high"));
    }

    #[test]
    fn a_check_with_no_detector_is_still_the_products_own() {
        let out = activity_feed(
            &[finding("f1", json!({ "subject": "n1" }))],
            &[],
            &nothing_named,
        );
        assert_eq!(out[0].by, "Studio");
    }

    #[test]
    fn a_subject_falls_back_to_its_file_then_to_its_id_rather_than_being_dropped() {
        let named = |id: &str| (id == "n1").then(|| "prd.md".to_owned());
        let out = activity_feed(
            &[
                finding("f1", json!({ "subject": "n1" })),
                finding(
                    "f2",
                    json!({ "subject": "n2", "path": "docs/adr/0007-shell.md" }),
                ),
                finding("f3", json!({})),
            ],
            &[],
            &named,
        );
        let by_id = |id: &str| out.iter().find(|e| e.id == id).unwrap();
        assert_eq!(by_id("f1").subject, "prd.md", "the name wins");
        assert_eq!(by_id("f2").subject, "0007-shell.md", "then the file");
        assert_eq!(by_id("f3").subject, "f3", "and a row is never dropped");
    }

    #[test]
    fn a_comment_reads_as_what_it_is_on_not_as_its_own_text() {
        let out = activity_feed(
            &[],
            &[finding(
                "c1",
                json!({ "target_number": 42, "title": "Looks good to me", "author": "ann" }),
            )],
            &nothing_named,
        );
        assert_eq!(out[0].kind, EventKind::Comment);
        assert_eq!(out[0].subject, "#42");
        assert_eq!(out[0].by, "ann");
    }

    #[test]
    fn a_comment_with_no_number_falls_back_to_its_title() {
        let out = activity_feed(
            &[],
            &[finding("c1", json!({ "title": "On the design" }))],
            &nothing_named,
        );
        assert_eq!(out[0].subject, "On the design");
        assert_eq!(out[0].by, "unknown");
    }

    #[test]
    fn the_feed_runs_newest_first() {
        let out = activity_feed(
            &[
                finding("old", json!({ "subject": "a", "recorded_at": ago(9) })),
                finding("new", json!({ "subject": "b", "recorded_at": ago(1) })),
            ],
            &[],
            &nothing_named,
        );
        assert_eq!(out[0].id, "new");
        assert_eq!(out[1].id, "old");
    }

    #[test]
    fn an_undated_row_goes_last_not_first() {
        // Findings written before `recorded_at` existed are exactly this case,
        // and they must not take the place where the most recent rows belong.
        let out = activity_feed(
            &[
                finding("undated", json!({ "subject": "a" })),
                finding("dated", json!({ "subject": "b", "recorded_at": ago(9) })),
            ],
            &[],
            &nothing_named,
        );
        assert_eq!(out[0].id, "dated");
        assert_eq!(out[1].id, "undated");
    }

    #[test]
    fn both_kinds_share_one_ordering() {
        let out = activity_feed(
            &[finding(
                "f",
                json!({ "subject": "a", "recorded_at": ago(5) }),
            )],
            &[finding(
                "c",
                json!({ "target_number": 1, "created_at": ago(1) }),
            )],
            &nothing_named,
        );
        assert_eq!(out[0].id, "c");
        assert_eq!(out[1].id, "f");
    }

    // ---- one project's row -------------------------------------------------

    fn verdict(id: &str, severity: &str, days_ago: i64) -> (String, Value) {
        (
            id.to_owned(),
            json!({ "subject": id, "path": format!("docs/{id}.md"), "severity": severity, "recorded_at": ago(days_ago) }),
        )
    }

    #[test]
    fn only_verdicts_left_to_fix_are_open() {
        let findings = [
            verdict("a", "high", 1),
            verdict("b", "gate-failed", 1),
            verdict("c", "some", 1),
            verdict("d", "gate-passed", 1),
            verdict("e", "clean", 1),
            verdict("f", "analyzed", 1),
        ];
        let s = project_signals(&findings, &[], &[], &[], NOW, 7);
        assert_eq!(s.open_findings, 3);
    }

    #[test]
    fn open_comments_are_unknown_until_a_repository_says() {
        let s = project_signals(&[], &[], &[], &[json!({ "repo": "a" })], NOW, 7);
        assert_eq!(s.open_comments, None);
        let repos = [
            json!({ "open_document_threads": 2 }),
            json!({ "open_review_threads": 1, "open_document_threads": 0 }),
        ];
        let s = project_signals(&[], &[], &[], &repos, NOW, 7);
        assert_eq!(s.open_comments, Some(3));
    }

    #[test]
    fn pull_requests_of_every_repository_share_one_axis() {
        let pulls = [
            pull("open", &ago(0), "a"),
            pull("merged", &ago(1), "a"),
            pull("merged", &ago(1), "b"),
            pull("merged", &ago(30), "b"),
        ];
        let s = project_signals(&[], &[], &pulls, &[], NOW, 7);
        assert!(s.pulls_known);
        assert_eq!(s.pulls.open, 1);
        assert_eq!(s.pulls.merged, 2);
        assert_eq!(s.pulls.days.len(), 7);
        assert_eq!(s.pulls.days[5], 2);
        assert_eq!(s.pulls.days[6], 1);
        // Never synced is not the same as a quiet week.
        assert!(!project_signals(&[], &[], &[], &[], NOW, 7).pulls_known);
    }

    #[test]
    fn the_last_event_is_the_newest_dated_one() {
        let findings = [verdict("old", "clean", 3), verdict("new", "high", 1)];
        let s = project_signals(&findings, &[], &[], &[], NOW, 7);
        let last = s.last_event.expect("an event");
        assert_eq!(last.id, "new");
        assert_eq!(last.subject, "new.md");
        let undated = [(
            "x".to_owned(),
            json!({ "subject": "x", "severity": "high" }),
        )];
        assert_eq!(
            project_signals(&undated, &[], &[], &[], NOW, 7).last_event,
            None
        );
    }
}
