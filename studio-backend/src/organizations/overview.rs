//! What an organization's leaders ask of it, answered once on the server.
//!
//! The organization's overview answers four questions before anything else:
//! what is on fire and waits on them, where (by workspace, then project),
//! whether money grows and who grows it, and whether work moves. The portal
//! used to compose that itself — the rollups, the costs four times, the open
//! pull requests of every workspace, the background runs, the members and the
//! component registry, around ten requests across six gears — and stitched the
//! answers together with rules of its own. Those rules are here now, stated as
//! tests, and the portal draws one answer.
//!
//! ── The rules ──────────────────────────────────────────────────────────────
//!
//! **Spend is the last 30 days against the same 30 days a month earlier**,
//! UTC days as the Costs report counts them, today included; the month-end
//! forecast is this month so far at its own pace. People's own keys are shown
//! apart and never in the organization's spend.
//!
//! **A refused connection is the newest run of a repository failing with
//! 401 or 403.** A repository that failed and synced since is fine; a rate
//! limit is said with a 403 too and passes by itself, so it is not one.
//!
//! **A pull request is stuck after [`STUCK_DAYS`] days without a move.** A
//! draft waits on nobody yet.
//!
//! **Spend is a member's when the token subject that made the call is one of
//! their sign-ins.** Anything else — a subject no active member signs in with,
//! a session (the runtime does not say who) — is unattributed, counted and
//! said, never dropped. Members with no attributed spend and no open pull
//! request they wrote or review in the period are idle.
//!
//! **What cannot be read is unknown, never zero** — the rollups' rule. Costs
//! are read only for a caller holding `cost.view`; without it every money
//! field is null and the rest of the answer is the same.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use time::{Date, Duration, Month, OffsetDateTime, UtcOffset};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::rollups::{ORGANIZATION_TENANT_TYPE, Rollup, RollupKind, Sources};
use crate::artifact_ingest::port::{OpenPull, OpenPullRequests};
use crate::tasks::{RecentRuns, RunSummary};
use crate::usage::port::Payer;
use crate::usage::{Fact, FactKind, GroupBy, OrganizationUsage, PricedUsage};
use crate::user_profile::{MemberAliases, RosterMember};

/// A pull request waiting this many days without a move is stuck.
pub const STUCK_DAYS: u32 = 7;
/// Spend growing by this share against the same days last month is news.
pub const GROWTH_ALERT: f64 = 0.2;
/// A project with no activity for this many days is quiet.
pub const QUIET_DAYS: u32 = 14;
/// The newest runs read per tenant to find a refused connection.
const RUNS_PER_TENANT: u64 = 100;
/// Where unattributed spend goes in a by-person breakdown.
pub const UNATTRIBUTED: &str = "unattributed";
/// The alias kinds a pull request's accounts are read as people through.
const ACCOUNT_KINDS: [&str; 2] = ["github", "gitlab"];

// ── Periods ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Period {
    pub from: OffsetDateTime,
    pub to: OffsetDateTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Windows {
    /// The last 30 days, today included.
    pub current: Period,
    /// The same 30 days one month earlier.
    pub previous: Period,
    /// This month so far, today included.
    pub month: Period,
    pub elapsed_days: u32,
    pub month_days: u32,
}

fn midnight(d: Date) -> OffsetDateTime {
    d.midnight().assume_utc()
}

/// The periods the overview compares, in UTC days.
pub fn windows(now: OffsetDateTime) -> Windows {
    let today = now.to_offset(UtcOffset::UTC).date();
    let to = midnight(today) + Duration::days(1);
    // One month back; the 31st after a shorter month is that month's last day.
    let (year, month) = match today.month() {
        Month::January => (today.year() - 1, Month::December),
        m => (today.year(), m.previous()),
    };
    let day = today.day().min(month.length(year));
    let prev_to = Date::from_calendar_date(year, month, day)
        .map(midnight)
        .unwrap_or(to - Duration::days(30))
        + Duration::days(1);
    let first = today.replace_day(1).unwrap_or(today);
    Windows {
        current: Period {
            from: to - Duration::days(30),
            to,
        },
        previous: Period {
            from: prev_to - Duration::days(30),
            to: prev_to,
        },
        month: Period {
            from: midnight(first),
            to,
        },
        elapsed_days: u32::from(today.day()),
        month_days: u32::from(today.month().length(today.year())),
    }
}

/// How much `current` grew against `previous`, as a share; `None` when there
/// was nothing before to grow from.
pub fn growth(current: f64, previous: f64) -> Option<f64> {
    (previous > 0.0).then(|| (current - previous) / previous)
}

/// Where the month ends at this month's pace so far.
pub fn forecast(month_to_date: f64, elapsed_days: u32, month_days: u32) -> f64 {
    if elapsed_days == 0 {
        return month_to_date;
    }
    month_to_date / f64::from(elapsed_days) * f64::from(month_days)
}

// ── Refused connections ──────────────────────────────────────────────────────

/// The status a failure says the provider refused the credential with, or
/// `None` when it is about something else.
pub fn refusal(error: Option<&str>) -> Option<&'static str> {
    let e = error?.to_ascii_lowercase();
    // A rate limit is said with a 403 too, and passes by itself.
    if e.contains("rate limit") {
        return None;
    }
    let word = |w: &str| {
        e.match_indices(w).any(|(i, _)| {
            let before = e[..i].chars().next_back();
            let after = e[i + w.len()..].chars().next();
            !before.is_some_and(|c| c.is_ascii_alphanumeric())
                && !after.is_some_and(|c| c.is_ascii_alphanumeric())
        })
    };
    if word("401")
        || e.contains("unauthorized")
        || e.contains("unauthorised")
        || e.contains("bad credentials")
        || e.contains("invalid token")
        || e.contains("token expired")
        || e.contains("token has expired")
        || e.contains("token has been revoked")
    {
        return Some("401");
    }
    if word("403") || e.contains("forbidden") || e.contains("resource not accessible") {
        return Some("403");
    }
    None
}

/// A connection a provider stopped accepting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Broken {
    /// The connection's id or credential reference.
    pub key: String,
    pub provider: String,
    pub status: &'static str,
    /// The newest failure, as the provider said it.
    pub error: String,
    pub repos: Vec<String>,
    pub projects: Vec<String>,
    pub since: OffsetDateTime,
}

fn text(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Connections whose last attempt at a repository was refused. `runs` come
/// newest first; only each repository's newest run counts.
pub fn broken_connections(runs: &[RunSummary]) -> Vec<Broken> {
    let mut seen = BTreeSet::new();
    let mut out: Vec<Broken> = Vec::new();
    for r in runs {
        let (Some(repo), Some(connection)) = (
            text(&r.payload, "repo_full_path"),
            text(&r.payload, "connection_id").or_else(|| text(&r.payload, "secret_ref")),
        ) else {
            continue;
        };
        let project = text(&r.payload, "project_id");
        if !seen.insert((
            r.task_type.clone(),
            connection.clone(),
            repo.clone(),
            project.clone(),
        )) {
            continue;
        }
        if r.state != "failed" {
            continue;
        }
        let Some(status) = refusal(r.last_error.as_deref()) else {
            continue;
        };
        let at = match out.iter().position(|b| b.key == connection) {
            Some(i) => i,
            None => {
                out.push(Broken {
                    key: connection.clone(),
                    provider: text(&r.payload, "provider").unwrap_or_else(|| "git".to_owned()),
                    status,
                    error: r.last_error.clone().unwrap_or_default().trim().to_owned(),
                    repos: Vec::new(),
                    projects: Vec::new(),
                    since: r.created_at,
                });
                out.len() - 1
            }
        };
        let b = &mut out[at];
        if !b.repos.contains(&repo) {
            b.repos.push(repo);
        }
        if let Some(p) = project
            && !b.projects.contains(&p)
        {
            b.projects.push(p);
        }
        b.since = b.since.min(r.created_at);
    }
    out
}

/// Failed runs that are not a refused connection: counted, never listed.
pub fn other_failures(runs: &[RunSummary]) -> u32 {
    let n = runs
        .iter()
        .filter(|r| r.state == "failed" && refusal(r.last_error.as_deref()).is_none())
        .count();
    u32::try_from(n).unwrap_or(u32::MAX)
}

// ── Work that does not move ─────────────────────────────────────────────────

fn idle_days(p: &OpenPull) -> u32 {
    p.days_since_update.or(p.days_open).unwrap_or(0)
}

/// Open pull requests waiting on someone for `days` or more without a move.
pub fn stuck(pulls: &[OpenPull], days: u32) -> Vec<&OpenPull> {
    pulls
        .iter()
        .filter(|p| p.waiting != "draft" && idle_days(p) >= days)
        .collect()
}

/// A person a pull request waits on, as the overview names them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Queue {
    /// The member, when the account is one of the organization's people.
    pub person_id: Option<String>,
    /// Their name, else the account; `None` for "nobody asked to review".
    pub who: Option<String>,
    pub count: u32,
    pub oldest_days: u32,
}

/// A member an account is: their person id and the name their profile carries.
pub type Member = (String, Option<String>);

/// Who the stuck pull requests wait on, longest queue first. `member` reads an
/// account as `(person, name)`.
pub fn waiting_on(stuck: &[&OpenPull], member: &dyn Fn(&str) -> Option<Member>) -> Vec<Queue> {
    let mut out: Vec<Queue> = Vec::new();
    let mut add = |person_id: Option<String>, who: Option<String>, days: u32| {
        let same = |q: &&mut Queue| match (&person_id, &q.person_id) {
            (Some(a), Some(b)) => a == b,
            (None, None) => q.who == who,
            _ => false,
        };
        match out.iter_mut().find(|q| same(q)) {
            Some(q) => {
                q.count += 1;
                q.oldest_days = q.oldest_days.max(days);
            }
            None => out.push(Queue {
                person_id,
                who,
                count: 1,
                oldest_days: days,
            }),
        }
    };
    for p in stuck {
        let days = idle_days(p);
        if p.waiting_on.is_empty() {
            add(None, None, days);
        }
        for login in &p.waiting_on {
            match member(login) {
                Some((person, name)) => add(
                    Some(person),
                    Some(name.unwrap_or_else(|| login.clone())),
                    days,
                ),
                None => add(None, Some(login.clone()), days),
            }
        }
    }
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then(b.oldest_days.cmp(&a.oldest_days))
            .then(a.who.cmp(&b.who))
    });
    out
}

/// The middle value; `None` for none.
pub fn median(values: &[u32]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut s = values.to_vec();
    s.sort_unstable();
    let mid = s.len() / 2;
    Some(if s.len() % 2 == 1 {
        f64::from(s[mid])
    } else {
        (f64::from(s[mid - 1]) + f64::from(s[mid])) / 2.0
    })
}

/// Whole days since `at` (RFC 3339); `None` when unknown.
pub fn days_since(at: Option<&str>, now: OffsetDateTime) -> Option<u32> {
    let t = OffsetDateTime::parse(at?, &time::format_description::well_known::Rfc3339).ok()?;
    let d = (now - t).whole_days().max(0);
    u32::try_from(d).ok()
}

// ── Spend, attributed to members ─────────────────────────────────────────────

/// Every sign-in subject of the organization's active members, to the person.
pub fn subjects_of(members: &[RosterMember]) -> HashMap<String, String> {
    members
        .iter()
        .flat_map(|m| m.subjects.iter().map(|s| (s.clone(), m.person.clone())))
        .collect()
}

/// Whose a fact is: a member's person id, [`UNATTRIBUTED`] for a subject no
/// active member signs in with, `""` for a session (nobody in particular).
pub fn owner_of(fact: &Fact, subjects: &HashMap<String, String>) -> String {
    match (fact.kind, fact.person) {
        (FactKind::Session, _) | (_, None) => String::new(),
        (_, Some(subject)) => subjects
            .get(&subject.to_string())
            .cloned()
            .unwrap_or_else(|| UNATTRIBUTED.to_owned()),
    }
}

/// One row of a breakdown: now, before, and whether part had no price.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MoneyRow {
    pub key: String,
    pub cost: f64,
    pub previous: f64,
    pub unpriced: bool,
}

/// One period folded by `group`; by person through the members.
fn fold(
    usage: &PricedUsage,
    group: GroupBy,
    include_personal: bool,
    subjects: &HashMap<String, String>,
) -> BTreeMap<String, (f64, bool)> {
    if group != GroupBy::Person {
        return usage
            .report(group, include_personal)
            .rows
            .into_iter()
            .map(|r| (r.key, (r.cost, r.unpriced)))
            .collect();
    }
    let mut out: BTreeMap<String, (f64, bool)> = BTreeMap::new();
    for f in &usage.facts {
        if !include_personal && f.payer == Some(Payer::Personal) {
            continue;
        }
        let row = out.entry(owner_of(f, subjects)).or_default();
        match usage.cost_of(f) {
            Some(c) => row.0 += c,
            None => row.1 = true,
        }
    }
    out
}

/// Two periods side by side, biggest spend first. A key spent on in only one
/// of them is still a row: what stopped costing is news too.
pub fn breakdown(
    current: &PricedUsage,
    previous: &PricedUsage,
    group: GroupBy,
    include_personal: bool,
    subjects: &HashMap<String, String>,
) -> Vec<MoneyRow> {
    let mut rows: BTreeMap<String, MoneyRow> = BTreeMap::new();
    for (key, (cost, unpriced)) in fold(current, group, include_personal, subjects) {
        rows.insert(
            key.clone(),
            MoneyRow {
                key,
                cost,
                previous: 0.0,
                unpriced,
            },
        );
    }
    for (key, (cost, _)) in fold(previous, group, include_personal, subjects) {
        rows.entry(key.clone())
            .or_insert_with(|| MoneyRow {
                key,
                ..MoneyRow::default()
            })
            .previous += cost;
    }
    let mut rows: Vec<MoneyRow> = rows.into_values().collect();
    rows.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then(b.previous.total_cmp(&a.previous))
            .then(a.key.cmp(&b.key))
    });
    rows
}

/// What a period's spend says about people.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attribution {
    /// Members who used a model in the period, own keys included.
    pub spenders: BTreeSet<String>,
    /// The organization's spend (own keys left out) that is a member's.
    pub attributed: f64,
    /// The rest of it: subjects no active member signs in with.
    pub unattributed: f64,
    /// Sessions, which name nobody.
    pub sessions: f64,
}

pub fn attribute(usage: &PricedUsage, subjects: &HashMap<String, String>) -> Attribution {
    let mut out = Attribution::default();
    for f in &usage.facts {
        let owner = owner_of(f, subjects);
        if !owner.is_empty() && owner != UNATTRIBUTED && f.kind == FactKind::Llm {
            out.spenders.insert(owner.clone());
        }
        if f.payer == Some(Payer::Personal) {
            continue;
        }
        let cost = usage.cost_of(f).unwrap_or(0.0);
        match owner.as_str() {
            "" => out.sessions += cost,
            UNATTRIBUTED => out.unattributed += cost,
            _ => out.attributed += cost,
        }
    }
    out
}

/// Active members with no model use and no open pull request they wrote or
/// review: `active` are the people whose accounts show up on pull requests.
pub fn idle(
    members: &[RosterMember],
    spenders: &BTreeSet<String>,
    active: &BTreeSet<String>,
) -> Vec<String> {
    members
        .iter()
        .map(|m| m.person.clone())
        .filter(|p| !spenders.contains(p) && !active.contains(p))
        .collect()
}

// ── Workspaces, worst first ──────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectHealth {
    pub id: Uuid,
    pub name: String,
    pub workspace_id: Uuid,
    pub specs_failing: Option<u32>,
    pub open_findings: Option<u32>,
    pub spend: Option<f64>,
    pub previous: Option<f64>,
    pub stuck: u32,
    pub quiet_days: Option<u32>,
    pub broken: bool,
    /// What is wrong, worst first; empty when nothing is.
    pub reasons: Vec<Reason>,
    pub score: u32,
}

/// One thing wrong with a project, for the portal to word.
#[derive(Clone, Debug, PartialEq)]
pub enum Reason {
    Refused,
    SpecsFailing(u32),
    Stuck(u32),
    SpendGrows(f64),
    Quiet(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceHealth {
    pub id: Uuid,
    pub name: String,
    pub projects: Vec<ProjectHealth>,
    pub spend: Option<f64>,
    pub previous: Option<f64>,
    pub specs_failing: u32,
    pub stuck: u32,
    /// The most recently active project's quiet days.
    pub quiet_days: Option<u32>,
    pub score: u32,
}

pub struct HealthInputs<'a> {
    pub spend: Option<&'a BTreeMap<String, f64>>,
    pub previous: Option<&'a BTreeMap<String, f64>>,
    pub stuck: &'a BTreeMap<String, u32>,
    pub broken: &'a BTreeSet<String>,
    pub now: OffsetDateTime,
}

/// What the overview reads off a rollup row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub id: Uuid,
    pub name: String,
    /// The project's workspace; `None` on a workspace's own row.
    pub workspace: Option<Uuid>,
    pub specs: Option<u32>,
    pub specs_failing: Option<u32>,
    pub open_findings: Option<u32>,
    pub pulls_open: Option<u32>,
    pub pulls_merged: Option<u32>,
    /// The newest event the Activity feed lists, RFC 3339.
    pub last_at: Option<String>,
}

pub fn row_of(r: &Rollup) -> Row {
    let pulls = r
        .signals
        .as_ref()
        .filter(|s| s.pulls_known)
        .map(|s| &s.pulls);
    Row {
        id: r.id,
        name: r.name.clone(),
        workspace: match r.kind {
            RollupKind::Workspace => None,
            RollupKind::Project => r.parent_id,
        },
        specs: r.specs.as_ref().map(|s| s.specs),
        specs_failing: r.specs.as_ref().map(|s| s.failing),
        open_findings: r.signals.as_ref().map(|s| s.open_findings),
        pulls_open: pulls.map(|p| p.open),
        pulls_merged: pulls.map(|p| p.merged),
        last_at: r
            .signals
            .as_ref()
            .and_then(|s| s.last_event.as_ref())
            .and_then(|e| e.recorded.clone()),
    }
}

fn project_health(r: &Row, workspace_id: Uuid, h: &HealthInputs<'_>) -> ProjectHealth {
    let key = r.id.to_string();
    let spend = h.spend.map(|m| m.get(&key).copied().unwrap_or(0.0));
    let previous = h.previous.map(|m| m.get(&key).copied().unwrap_or(0.0));
    let stuck = h.stuck.get(&key).copied().unwrap_or(0);
    let quiet_days = days_since(r.last_at.as_deref(), h.now);
    let broken = h.broken.contains(&key);
    let failing = r.specs_failing.unwrap_or(0);
    let findings = r.open_findings;
    let grows = match (spend, previous) {
        (Some(s), Some(p)) => growth(s, p).filter(|g| *g >= GROWTH_ALERT),
        _ => None,
    };
    let quiet = quiet_days.filter(|d| *d >= QUIET_DAYS);
    let mut reasons = Vec::new();
    if broken {
        reasons.push(Reason::Refused);
    }
    if failing > 0 {
        reasons.push(Reason::SpecsFailing(failing));
    }
    if stuck > 0 {
        reasons.push(Reason::Stuck(stuck));
    }
    if let Some(g) = grows {
        reasons.push(Reason::SpendGrows(g));
    }
    if let Some(d) = quiet {
        reasons.push(Reason::Quiet(d));
    }
    ProjectHealth {
        id: r.id,
        name: r.name.clone(),
        workspace_id,
        specs_failing: r.specs_failing,
        open_findings: findings,
        spend,
        previous,
        stuck,
        quiet_days,
        broken,
        reasons,
        score: if broken { 10 } else { 0 }
            + failing * 3
            + findings.unwrap_or(0)
            + stuck * 2
            + if grows.is_some() { 2 } else { 0 }
            + u32::from(quiet.is_some()),
    }
}

fn sum_known(vs: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    vs.fold(None, |acc, v| match (acc, v) {
        (None, None) => None,
        (a, v) => Some(a.unwrap_or(0.0) + v.unwrap_or(0.0)),
    })
}

/// The organization by workspace, the one in most trouble first; inside it,
/// its projects the same way.
pub fn workspace_health(rows: &[Row], h: &HealthInputs<'_>) -> Vec<WorkspaceHealth> {
    let mut out: Vec<WorkspaceHealth> = rows
        .iter()
        .filter(|r| r.workspace.is_none())
        .map(|ws| {
            let mut projects: Vec<ProjectHealth> = rows
                .iter()
                .filter(|r| r.workspace == Some(ws.id))
                .map(|r| project_health(r, ws.id, h))
                .collect();
            projects.sort_by(|a, b| b.score.cmp(&a.score).then(a.name.cmp(&b.name)));
            WorkspaceHealth {
                id: ws.id,
                name: ws.name.clone(),
                spend: sum_known(projects.iter().map(|p| p.spend)),
                previous: sum_known(projects.iter().map(|p| p.previous)),
                specs_failing: projects.iter().map(|p| p.specs_failing.unwrap_or(0)).sum(),
                stuck: projects.iter().map(|p| p.stuck).sum(),
                quiet_days: projects.iter().filter_map(|p| p.quiet_days).min(),
                score: projects.iter().map(|p| p.score).sum(),
                projects,
            }
        })
        .collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.name.cmp(&b.name)));
    out
}

// ── What waits on the organization's leader ─────────────────────────────────

/// One thing that needs the leader, for the portal to word.
#[derive(Clone, Debug, PartialEq)]
pub enum Need {
    Refused {
        provider: String,
        status: &'static str,
        projects: Vec<String>,
        repos: u32,
    },
    SpendGrows {
        current: f64,
        previous: f64,
        forecast: f64,
        grower: Option<String>,
    },
    Stuck {
        pulls: u32,
        people: u32,
    },
    Decide {
        components: u32,
    },
    RunsFailed {
        runs: u32,
    },
}

pub struct NeedInputs<'a> {
    pub broken: &'a [Broken],
    pub project_names: &'a BTreeMap<String, String>,
    /// Spend now, before and the forecast, and who grows most; `None` when
    /// costs are not the caller's to see.
    pub spend: Option<(f64, f64, f64, Option<String>)>,
    pub stuck: u32,
    pub waiting_on: u32,
    pub undecided: u32,
    pub other_failures: u32,
}

/// Refused connections first, then money, then stuck work and decisions.
pub fn needs(n: &NeedInputs<'_>) -> Vec<Need> {
    let mut out = Vec::new();
    for b in n.broken {
        out.push(Need::Refused {
            provider: b.provider.clone(),
            status: b.status,
            projects: b
                .projects
                .iter()
                .filter_map(|id| n.project_names.get(id).cloned())
                .collect(),
            repos: u32::try_from(b.repos.len()).unwrap_or(u32::MAX),
        });
    }
    if let Some((current, previous, forecast, grower)) = &n.spend
        && growth(*current, *previous).is_some_and(|g| g >= GROWTH_ALERT)
    {
        out.push(Need::SpendGrows {
            current: *current,
            previous: *previous,
            forecast: *forecast,
            grower: grower.clone(),
        });
    }
    if n.stuck > 0 {
        out.push(Need::Stuck {
            pulls: n.stuck,
            people: n.waiting_on,
        });
    }
    if n.undecided > 0 {
        out.push(Need::Decide {
            components: n.undecided,
        });
    }
    if n.other_failures > 0 {
        out.push(Need::RunsFailed {
            runs: n.other_failures,
        });
    }
    out
}

// ── Reading it ───────────────────────────────────────────────────────────────

/// The organization's spend over the three periods.
pub struct Spend {
    pub current: PricedUsage,
    pub previous: PricedUsage,
    pub month: PricedUsage,
}

/// Everything the overview is computed from, as read.
pub struct Read {
    pub name: String,
    pub rows: Vec<Row>,
    pub members: Option<Vec<RosterMember>>,
    pub names: BTreeMap<String, String>,
    pub registry: Option<Vec<String>>,
    pub runs: Option<Vec<RunSummary>>,
    pub pulls: Option<Vec<OpenPull>>,
    /// Account (lowercased) to `(person, name)`.
    pub accounts: BTreeMap<String, Member>,
    /// `None` when the caller may not see costs; `Some(Err)` when they may
    /// and the read failed.
    pub spend: Option<Result<Spend, String>>,
    pub windows: Windows,
}

#[derive(Debug)]
pub enum Refusal {
    NotFound,
}

/// The gears an overview reads, resolved per request: several of them
/// publish in their own REST phase, after this gear's routes are built.
pub struct Overview {
    pub sources: Arc<Sources>,
    pub hub: Arc<ClientHub>,
    /// Answers kept for a minute, per organization and caller.
    pub answers: Answers,
}

/// How long one caller's overview of one organization is reused. A leader's
/// screen asks again on every open, and the answer is a dozen gears' worth
/// of reads that move by the hour, not the second.
const ANSWER_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// Overviews kept per `(organization, caller)`. The caller is part of the
/// key because the answer is theirs: the tree is read as them, and the money
/// is there only for someone who may see costs. The organization is checked
/// for this caller before a kept answer is served ([`Overview::answer`]).
pub struct Answers<V = OrganizationOverviewDto> {
    ttl: std::time::Duration,
    kept: std::sync::Mutex<HashMap<(Uuid, Uuid), (std::time::Instant, V)>>,
}

impl<V> Default for Answers<V> {
    fn default() -> Self {
        Self::with_ttl(ANSWER_TTL)
    }
}

impl<V> Answers<V> {
    fn with_ttl(ttl: std::time::Duration) -> Self {
        Self {
            ttl,
            kept: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl<V: Clone> Answers<V> {
    /// Answers remembered at most; past it, the cache starts over.
    const CAPACITY: usize = 256;

    fn get(&self, org: Uuid, caller: Uuid) -> Option<V> {
        let kept = self.kept.lock().ok()?;
        kept.get(&(org, caller))
            .filter(|(at, _)| at.elapsed() < self.ttl)
            .map(|(_, v)| v.clone())
    }

    fn put(&self, org: Uuid, caller: Uuid, answer: V) {
        if let Ok(mut kept) = self.kept.lock() {
            if kept.len() >= Self::CAPACITY && !kept.contains_key(&(org, caller)) {
                kept.clear();
            }
            kept.insert((org, caller), (std::time::Instant::now(), answer));
        }
    }
}

impl Overview {
    /// The organization's overview for this caller, from the last minute's
    /// answer when there is one. The organization is read as the caller
    /// first either way, so a caller who no longer reaches it is refused
    /// rather than served what they saw before.
    pub async fn answer(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        now: OffsetDateTime,
    ) -> Result<OrganizationOverviewDto, Refusal> {
        let tenant = self.admit(ctx, org).await?;
        let caller = ctx.subject_id();
        if let Some(kept) = self.answers.get(org, caller) {
            return Ok(kept);
        }
        let read = self.read_admitted(ctx, org, tenant.name, now).await;
        let answer = compose(org, &read, now);
        self.answers.put(org, caller, answer.clone());
        Ok(answer)
    }

    /// The organization as the caller reads it, or [`Refusal::NotFound`] when
    /// they do not reach it or it is not an organization.
    pub(super) async fn admit(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> Result<account_management_sdk::Tenant, Refusal> {
        let tenant = self
            .sources
            .am
            .get_tenant(ctx, org)
            .await
            .map_err(|_| Refusal::NotFound)?;
        if tenant.tenant_type.as_deref() != Some(ORGANIZATION_TENANT_TYPE) {
            return Err(Refusal::NotFound);
        }
        Ok(tenant)
    }

    /// Everything the overview is computed from, for an organization
    /// [`Self::admit`] let the caller into.
    async fn read_admitted(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        name: String,
        now: OffsetDateTime,
    ) -> Read {
        let windows = windows(now);

        // Three independent strands, read side by side: the organization's
        // tree with everything that hangs off its projects, the registry, and
        // the spend. Within the first, each read starts as soon as what it
        // needs is in: the roster feeds both the teams and the names, the
        // rows feed the runs and the pull requests, and the pull requests
        // feed whose accounts they are.
        let people_and_work = async {
            let members = match &self.sources.roster {
                Some(roster) => roster.active_members(org).await.ok(),
                None => None,
            };
            let names = async {
                match (&self.sources.roster, &members) {
                    (Some(roster), Some(members)) => {
                        let people: Vec<String> =
                            members.iter().map(|m| m.person.clone()).collect();
                        roster.display_names(&people).await.unwrap_or_default()
                    }
                    _ => BTreeMap::new(),
                }
            };
            let work = async {
                let rows: Vec<Row> = self
                    .sources
                    .organization_with(ctx, org, members.clone())
                    .await
                    .iter()
                    .map(row_of)
                    .collect();
                let projects: Vec<Uuid> = rows
                    .iter()
                    .filter(|r| r.workspace.is_some())
                    .map(|r| r.id)
                    .collect();
                let mut tenants = vec![org];
                tenants.extend(rows.iter().map(|r| r.id));
                let runs = async {
                    let source = self.hub.get::<dyn RecentRuns>().ok()?;
                    let reads = futures_util::future::join_all(
                        tenants
                            .iter()
                            .map(|t| source.recent_runs(*t, RUNS_PER_TENANT)),
                    )
                    .await;
                    let mut all: Vec<RunSummary> =
                        reads.into_iter().filter_map(Result::ok).flatten().collect();
                    all.sort_by_key(|r| std::cmp::Reverse(r.created_at));
                    Some(all)
                };
                let pulls_and_accounts = async {
                    let pulls = async {
                        let source = self.hub.get::<dyn OpenPullRequests>().ok()?;
                        let scopes: Vec<String> = projects.iter().map(Uuid::to_string).collect();
                        let reads = futures_util::future::join_all(
                            scopes.iter().map(|scope| source.open_pulls(ctx, scope)),
                        )
                        .await;
                        Some(
                            reads
                                .into_iter()
                                .filter_map(Result::ok)
                                .flatten()
                                .collect::<Vec<_>>(),
                        )
                    }
                    .await;
                    let accounts = self
                        .accounts(org, pulls.as_deref().unwrap_or_default())
                        .await;
                    (pulls, accounts)
                };
                let (runs, (pulls, accounts)) = tokio::join!(runs, pulls_and_accounts);
                (rows, runs, pulls, accounts)
            };
            let (names, (rows, runs, pulls, accounts)) = tokio::join!(names, work);
            (members, names, rows, runs, pulls, accounts)
        };
        let registry = async {
            let registry = self
                .hub
                .get::<dyn crate::components_catalog::port::Registry>()
                .ok()?;
            registry
                .entries(ctx, org)
                .await
                .ok()
                .map(|es| es.into_iter().map(|e| e.entry.state).collect::<Vec<_>>())
        };
        let spend = async {
            let usage = self.hub.get::<dyn OrganizationUsage>().ok()?;
            if !usage.may_view(ctx, org).await {
                return None;
            }
            let (current, previous, month) = tokio::join!(
                usage.usage(ctx, org, windows.current.from, windows.current.to),
                usage.usage(ctx, org, windows.previous.from, windows.previous.to),
                usage.usage(ctx, org, windows.month.from, windows.month.to),
            );
            Some(match (current, previous, month) {
                (Ok(current), Ok(previous), Ok(month)) => Ok(Spend {
                    current,
                    previous,
                    month,
                }),
                (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => Err(format!("{e:#}")),
            })
        };
        let started = std::time::Instant::now();
        let ((members, names, rows, runs, pulls, accounts), registry, spend) =
            tokio::join!(people_and_work, registry, spend);
        tracing::info!(
            %org,
            rows = rows.len(),
            elapsed_ms = started.elapsed().as_millis(),
            "organizations: overview read"
        );
        Read {
            name,
            rows,
            members,
            names,
            registry,
            runs,
            pulls,
            accounts,
            spend,
            windows,
        }
    }

    /// The pull requests' accounts that are the organization's people.
    async fn accounts(&self, org: Uuid, pulls: &[OpenPull]) -> BTreeMap<String, Member> {
        let mut out = BTreeMap::new();
        let Ok(directory) = self
            .hub
            .get_scoped::<dyn MemberAliases>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
        else {
            return out;
        };
        let logins: Vec<String> = pulls
            .iter()
            .flat_map(|p| p.author.iter().chain(&p.waiting_on).chain(&p.reviewers))
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if logins.is_empty() {
            return out;
        }
        // One lookup per kind, asked together; merged in the kinds' order, so
        // a login known under both is still the first kind's.
        let found = futures_util::future::join_all(
            ACCOUNT_KINDS
                .iter()
                .map(|kind| directory.members_by_alias(org, kind, &logins)),
        )
        .await;
        for found in found.into_iter().filter_map(Result::ok) {
            for (login, m) in found {
                out.entry(login).or_insert((m.person, m.display_name));
            }
        }
        out
    }
}

// ── The answer ───────────────────────────────────────────────────────────────

use super::rest::{
    OrganizationOverviewDto, OverviewDecisionsDto, OverviewDeliveryDto, OverviewMoneyDto,
    OverviewMoneyRowDto, OverviewNeedDto, OverviewPeopleDto, OverviewPersonDto, OverviewProjectDto,
    OverviewQueueDto, OverviewReasonDto, OverviewSpecsDto, OverviewSpendDto, OverviewWorkspaceDto,
};

const GROUPS: [(GroupBy, &str); 5] = [
    (GroupBy::Project, "project"),
    (GroupBy::Person, "person"),
    (GroupBy::Model, "model"),
    (GroupBy::Source, "source"),
    (GroupBy::Payer, "payer"),
];

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn sum_u32(vs: impl Iterator<Item = Option<u32>>) -> Option<u32> {
    vs.fold(None, |acc, v| match (acc, v) {
        (None, None) => None,
        (a, v) => Some(a.unwrap_or(0) + v.unwrap_or(0)),
    })
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn by_tenant(usage: &PricedUsage) -> BTreeMap<String, f64> {
    usage
        .report(GroupBy::Project, false)
        .rows
        .into_iter()
        .map(|r| (r.key, r.cost))
        .collect()
}

fn need_dto(need: Need) -> OverviewNeedDto {
    match need {
        Need::Refused {
            provider,
            status,
            projects,
            repos,
        } => OverviewNeedDto {
            kind: "connection".into(),
            tone: "danger".into(),
            provider: Some(provider),
            status: Some(status.into()),
            projects,
            repos: Some(repos),
            ..OverviewNeedDto::default()
        },
        Need::SpendGrows {
            current,
            previous,
            forecast,
            grower,
        } => OverviewNeedDto {
            kind: "spend".into(),
            tone: "warn".into(),
            current: Some(current),
            previous: Some(previous),
            forecast: Some(forecast),
            grower,
            ..OverviewNeedDto::default()
        },
        Need::Stuck { pulls, people } => OverviewNeedDto {
            kind: "pulls".into(),
            tone: "warn".into(),
            pulls: Some(pulls),
            people: Some(people),
            ..OverviewNeedDto::default()
        },
        Need::Decide { components } => OverviewNeedDto {
            kind: "components".into(),
            tone: "warn".into(),
            components: Some(components),
            ..OverviewNeedDto::default()
        },
        Need::RunsFailed { runs } => OverviewNeedDto {
            kind: "runs".into(),
            tone: "warn".into(),
            runs: Some(runs),
            ..OverviewNeedDto::default()
        },
    }
}

fn reason_dto(r: &Reason) -> OverviewReasonDto {
    let (kind, value) = match r {
        Reason::Refused => ("refused", None),
        Reason::SpecsFailing(n) => ("specs_failing", Some(f64::from(*n))),
        Reason::Stuck(n) => ("stuck", Some(f64::from(*n))),
        Reason::SpendGrows(g) => ("spend_grows", Some(*g)),
        Reason::Quiet(d) => ("quiet", Some(f64::from(*d))),
    };
    OverviewReasonDto {
        kind: kind.into(),
        value,
    }
}

/// Everything read, folded into the answer by the rules above.
pub fn compose(org: Uuid, read: &Read, now: OffsetDateTime) -> OrganizationOverviewDto {
    let w = read.windows;
    let subjects = read.members.as_deref().map(subjects_of).unwrap_or_default();
    // Names of every tenant a cost can be keyed by.
    let mut places: BTreeMap<String, String> = read
        .rows
        .iter()
        .map(|r| (r.id.to_string(), r.name.clone()))
        .collect();
    places.insert(org.to_string(), read.name.clone());
    let spend = match &read.spend {
        Some(Ok(s)) => Some(s),
        _ => None,
    };
    let costs = match &read.spend {
        None => "hidden",
        Some(Ok(_)) => "shown",
        Some(Err(_)) => "unreadable",
    };

    let runs = read.runs.as_deref().unwrap_or_default();
    let broken = broken_connections(runs);
    let broken_projects: BTreeSet<String> = broken
        .iter()
        .flat_map(|b| b.projects.iter().cloned())
        .collect();

    let pulls = read.pulls.as_deref().unwrap_or_default();
    let stuck_pulls = stuck(pulls, STUCK_DAYS);
    let mut stuck_by: BTreeMap<String, u32> = BTreeMap::new();
    for p in &stuck_pulls {
        if let Some(id) = &p.project_id {
            *stuck_by.entry(id.clone()).or_default() += 1;
        }
    }
    let member_of = |login: &str| read.accounts.get(&login.to_ascii_lowercase()).cloned();
    let queues = waiting_on(&stuck_pulls, &member_of);
    let people_waited = count(queues.iter().filter(|q| q.who.is_some()).count());

    let current_by = spend.map(|s| by_tenant(&s.current));
    let previous_by = spend.map(|s| by_tenant(&s.previous));
    let health = workspace_health(
        &read.rows,
        &HealthInputs {
            spend: current_by.as_ref(),
            previous: previous_by.as_ref(),
            stuck: &stuck_by,
            broken: &broken_projects,
            now,
        },
    );

    let spend_dto = spend.map(|s| {
        let current = s.current.report(GroupBy::Payer, false);
        let with_own = s.current.report(GroupBy::Payer, true);
        let previous = s.previous.report(GroupBy::Payer, false).total;
        let month = s.month.report(GroupBy::Payer, false).total;
        let who = attribute(&s.current, &subjects);
        OverviewSpendDto {
            currency: s.current.currency.clone(),
            current: current.total,
            previous,
            forecast: forecast(month, w.elapsed_days, w.month_days),
            own_keys: (with_own.total - current.total).max(0.0),
            attributed: who.attributed,
            unattributed: who.unattributed,
            sessions: who.sessions,
            unpriced: with_own.unpriced,
        }
    });

    let grower = match (&current_by, &previous_by) {
        (Some(cur), Some(prev)) => cur
            .iter()
            .map(|(k, c)| (k, c - prev.get(k).copied().unwrap_or(0.0)))
            .filter(|(_, d)| *d > 0.0)
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(k, _)| places.get(k).cloned().unwrap_or_else(|| k.clone())),
        _ => None,
    };
    let registry = read.registry.as_deref();
    let states = |s: &str| {
        count(
            registry
                .unwrap_or_default()
                .iter()
                .filter(|x| *x == s)
                .count(),
        )
    };
    let undecided = states("candidate") + states("declared");
    let needs = needs(&NeedInputs {
        broken: &broken,
        project_names: &places,
        spend: spend_dto
            .as_ref()
            .map(|s| (s.current, s.previous, s.forecast, grower.clone())),
        stuck: count(stuck_pulls.len()),
        waiting_on: people_waited,
        undecided,
        other_failures: other_failures(runs),
    });

    let projects: Vec<&Row> = read.rows.iter().filter(|r| r.workspace.is_some()).collect();
    let open_ages: Vec<u32> = pulls
        .iter()
        .filter(|p| p.waiting != "draft")
        .filter_map(|p| p.days_open)
        .collect();

    let people = match (spend, read.members.as_deref()) {
        (Some(s), Some(members)) => {
            let who = attribute(&s.current, &subjects);
            let on_pulls: BTreeSet<String> = pulls
                .iter()
                .flat_map(|p| p.author.iter().chain(&p.waiting_on).chain(&p.reviewers))
                .filter_map(|login| member_of(login).map(|(person, _)| person))
                .collect();
            let with_spend = count(who.spenders.len());
            OverviewPeopleDto {
                active: Some(count(members.len())),
                with_spend: Some(with_spend),
                per_person: (with_spend > 0).then(|| who.attributed / f64::from(with_spend)),
                idle: Some(
                    idle(members, &who.spenders, &on_pulls)
                        .into_iter()
                        .map(|person| OverviewPersonDto {
                            name: read.names.get(&person).cloned(),
                            person_id: person,
                        })
                        .collect(),
                ),
            }
        }
        (_, members) => OverviewPeopleDto {
            active: members.map(|m| count(m.len())),
            with_spend: None,
            per_person: None,
            idle: None,
        },
    };

    let money = spend.map(|s| {
        let mut out = Vec::new();
        for (group, name) in GROUPS {
            for include_personal in [false, true] {
                let rows = breakdown(&s.current, &s.previous, group, include_personal, &subjects)
                    .into_iter()
                    .map(|r| OverviewMoneyRowDto {
                        label: match group {
                            GroupBy::Project => places.get(&r.key).cloned(),
                            GroupBy::Person => read.names.get(&r.key).cloned(),
                            _ => None,
                        },
                        key: r.key,
                        cost: r.cost,
                        previous: r.previous,
                        unpriced: r.unpriced,
                    })
                    .collect();
                out.push(OverviewMoneyDto {
                    group_by: name.into(),
                    include_personal,
                    rows,
                });
            }
        }
        out
    });

    OrganizationOverviewDto {
        organization_id: org.to_string(),
        name: read.name.clone(),
        period_from: rfc3339(w.current.from),
        period_to: rfc3339(w.current.to),
        previous_from: rfc3339(w.previous.from),
        previous_to: rfc3339(w.previous.to),
        stuck_days: STUCK_DAYS,
        growth_alert: GROWTH_ALERT,
        quiet_days: QUIET_DAYS,
        costs: costs.into(),
        needs: needs.into_iter().map(need_dto).collect(),
        spend: spend_dto,
        delivery: OverviewDeliveryDto {
            merged: sum_u32(projects.iter().map(|r| r.pulls_merged)),
            window_days: count(super::rollups::ACTIVITY_DAYS),
            open: sum_u32(projects.iter().map(|r| r.pulls_open)),
            median_wait_days: median(&open_ages),
        },
        specs: OverviewSpecsDto {
            specs: sum_u32(projects.iter().map(|r| r.specs)),
            failing: sum_u32(projects.iter().map(|r| r.specs_failing)),
            open_findings: sum_u32(projects.iter().map(|r| r.open_findings)),
        },
        people,
        workspaces: health
            .into_iter()
            .map(|ws| OverviewWorkspaceDto {
                id: ws.id.to_string(),
                name: ws.name,
                spend: ws.spend,
                previous: ws.previous,
                specs_failing: ws.specs_failing,
                stuck: ws.stuck,
                quiet_days: ws.quiet_days,
                score: ws.score,
                projects: ws
                    .projects
                    .into_iter()
                    .map(|p| OverviewProjectDto {
                        reasons: p.reasons.iter().map(reason_dto).collect(),
                        id: p.id.to_string(),
                        name: p.name,
                        spend: p.spend,
                        previous: p.previous,
                        specs_failing: p.specs_failing,
                        open_findings: p.open_findings,
                        stuck: p.stuck,
                        quiet_days: p.quiet_days,
                        broken: p.broken,
                        score: p.score,
                    })
                    .collect(),
            })
            .collect(),
        money,
        waiting_on: read.pulls.as_ref().map(|_| {
            queues
                .into_iter()
                .map(|q| OverviewQueueDto {
                    person_id: q.person_id,
                    who: q.who,
                    count: q.count,
                    oldest_days: q.oldest_days,
                })
                .collect()
        }),
        decisions: registry.map(|_| OverviewDecisionsDto {
            undecided,
            candidates: states("candidate"),
            registered: states("registered"),
            published: states("published"),
        }),
    }
}

#[cfg(test)]
#[path = "overview_tests.rs"]
mod tests;
