//! An organization's metrics board, for the people who lead it: delivery,
//! quality, money and people over 7, 30 or 90 days against the days before.
//!
//! `GET /studio-organizations/v1/metrics?organization_id=&range=` composes two
//! sources on the server, so the browser never sends a statement:
//!
//! * **Studio** -- the spend, per bucket and per workspace, from studio-usage
//!   (only for a caller holding `cost.view`; people's own keys never count);
//! * **Insight** -- git, CI and task figures for the repositories the scope's
//!   projects are made of (`project.config` `sources[]`), through
//!   studio-insight's [`RepositoryAnalytics`]. Repositories, because that is
//!   the finest owner Insight can be asked by today.
//!
//! **A scope is an organization, one of its workspaces or one of its
//! projects** (`workspace_id=` / `project_id=`): the same board then means
//! that workspace's or project's own repositories and spend. The organization
//! is always the one the caller reaches; a workspace or project outside it is
//! a 404.
//!
//! **Unknown is never zero.** Insight unconfigured, unreachable or failing is
//! a state with a reason and the Studio half still answers; spend the caller
//! may not see is `hidden`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use time::{Date, Duration, OffsetDateTime, UtcOffset};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::overview::Overview;
use super::rollups::{OrgProject, projects_of};
use crate::insight::port::{
    ActivityBucket, ActivityCell, ActivityQuery, ActivityUnavailable, RepositoryActivity,
    RepositoryAnalytics, ReviewSpread,
};
use crate::usage::port::Payer;
use crate::usage::{OrganizationUsage, PricedUsage};

// ── Windows ──────────────────────────────────────────────────────────────────

/// How far back the board looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Range {
    Week,
    Month,
    Quarter,
}

impl Range {
    /// `7d`, `30d` or `90d`; absent is `30d`.
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw.map(str::trim).unwrap_or("30d") {
            "7d" | "7" => Some(Self::Week),
            "" | "30d" | "30" => Some(Self::Month),
            "90d" | "90" => Some(Self::Quarter),
            _ => None,
        }
    }
    pub fn days(self) -> u32 {
        match self {
            Self::Week => 7,
            Self::Month => 30,
            Self::Quarter => 90,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Week => "7d",
            Self::Month => "30d",
            Self::Quarter => "90d",
        }
    }
}

/// The windows a range compares, in UTC days, `to` included: the current
/// one ends today, the previous one is as long and ends the day before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub previous_from: Date,
    pub current_from: Date,
    pub to: Date,
    pub bucket: ActivityBucket,
    /// Each bucket's first day: every day for a week, else Monday weeks
    /// (the first and last of which may be partial).
    pub buckets: Vec<Date>,
}

pub fn span(range: Range, now: OffsetDateTime) -> Span {
    let to = now.to_offset(UtcOffset::UTC).date();
    let days = i64::from(range.days());
    let current_from = to - Duration::days(days - 1);
    let previous_from = current_from - Duration::days(days);
    let (bucket, buckets) = match range {
        Range::Week => (
            ActivityBucket::Day,
            (0..days)
                .map(|i| current_from + Duration::days(i))
                .collect(),
        ),
        _ => {
            let mut first = current_from
                - Duration::days(i64::from(current_from.weekday().number_days_from_monday()));
            let mut out = Vec::new();
            while first <= to {
                out.push(first);
                first += Duration::days(7);
            }
            (ActivityBucket::Week, out)
        }
    };
    Span {
        previous_from,
        current_from,
        to,
        bucket,
        buckets,
    }
}

impl Span {
    fn step(&self) -> i64 {
        match self.bucket {
            ActivityBucket::Day => 1,
            ActivityBucket::Week => 7,
        }
    }

    /// A bucket's own days, clipped to the current window, as `[from, to)`.
    pub fn bucket_window(&self, start: Date) -> (OffsetDateTime, OffsetDateTime) {
        let from = start.max(self.current_from);
        let end = (start + Duration::days(self.step())).min(self.to + Duration::days(1));
        (midnight(from), midnight(end))
    }

    pub fn previous_window(&self) -> (OffsetDateTime, OffsetDateTime) {
        (midnight(self.previous_from), midnight(self.current_from))
    }
}

fn midnight(d: Date) -> OffsetDateTime {
    d.midnight().assume_utc()
}

// ── Scope ────────────────────────────────────────────────────────────────────

/// What the board is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    Organization,
    Workspace(Uuid),
    Project(Uuid),
}

impl Scope {
    pub fn kind(self) -> &'static str {
        match self {
            Self::Organization => "organization",
            Self::Workspace(_) => "workspace",
            Self::Project(_) => "project",
        }
    }

    /// The scope's projects, or `None` when it names one the organization
    /// does not hold. A workspace with no projects is still a scope.
    pub fn projects<'a>(
        self,
        all: &'a [OrgProject],
        workspaces: &BTreeSet<Uuid>,
    ) -> Option<Vec<&'a OrgProject>> {
        match self {
            Self::Organization => Some(all.iter().collect()),
            Self::Workspace(w) => workspaces
                .contains(&w)
                .then(|| all.iter().filter(|p| p.workspace_id == w).collect()),
            Self::Project(p) => {
                let found: Vec<_> = all.iter().filter(|x| x.id == p).collect();
                (!found.is_empty()).then_some(found)
            }
        }
    }

    /// Whose spend counts: `None` is everybody's in the organization.
    fn tenants(self, projects: &[&OrgProject]) -> Option<BTreeSet<Uuid>> {
        match self {
            Self::Organization => None,
            Self::Workspace(w) => {
                let mut t: BTreeSet<Uuid> = projects.iter().map(|p| p.id).collect();
                t.insert(w);
                Some(t)
            }
            Self::Project(p) => Some(BTreeSet::from([p])),
        }
    }
}

// ── Money ────────────────────────────────────────────────────────────────────

/// The scope's spend in one read: the organization's own money (people's own
/// keys left out), per tenant, and what had no price.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Spent {
    pub total: f64,
    pub by_tenant: BTreeMap<Uuid, f64>,
    pub unpriced: BTreeSet<String>,
}

pub fn spent(usage: &PricedUsage, tenants: Option<&BTreeSet<Uuid>>) -> Spent {
    let mut out = Spent::default();
    for f in &usage.facts {
        if f.payer == Some(Payer::Personal) {
            continue;
        }
        if tenants.is_some_and(|t| !t.contains(&f.tenant)) {
            continue;
        }
        match usage.cost_of(f) {
            Some(c) => {
                out.total += c;
                *out.by_tenant.entry(f.tenant).or_default() += c;
            }
            None => {
                out.unpriced.insert(format!("{}/{}", f.provider, f.item));
            }
        }
    }
    out
}

/// Spend per workspace, most first: a project's spend is its workspace's, a
/// workspace's own is its own, and the organization's own (or anything the
/// tree no longer lists) is the organization's.
pub fn by_workspace(
    org: Uuid,
    org_name: &str,
    projects: &[OrgProject],
    current: &BTreeMap<Uuid, f64>,
    previous: &BTreeMap<Uuid, f64>,
) -> Vec<(Uuid, String, f64, f64)> {
    let mut home: HashMap<Uuid, (Uuid, String)> = HashMap::new();
    for p in projects {
        home.insert(p.id, (p.workspace_id, p.workspace_name.clone()));
        home.insert(p.workspace_id, (p.workspace_id, p.workspace_name.clone()));
    }
    let mut sums: BTreeMap<Uuid, (String, f64, f64)> = BTreeMap::new();
    let mut add = |tenant: &Uuid, cost: f64, prev: bool| {
        let (id, name) = home
            .get(tenant)
            .cloned()
            .unwrap_or_else(|| (org, org_name.to_owned()));
        let e = sums.entry(id).or_insert((name, 0.0, 0.0));
        if prev {
            e.2 += cost;
        } else {
            e.1 += cost;
        }
    };
    for (t, c) in current {
        add(t, *c, false);
    }
    for (t, c) in previous {
        add(t, *c, true);
    }
    let mut out: Vec<_> = sums
        .into_iter()
        .map(|(id, (name, cur, prev))| (id, name, cur, prev))
        .collect();
    out.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.1.cmp(&b.1)));
    out
}

// ── Insight's answer, grouped per measure ────────────────────────────────────

/// One measure's cells: the current window, the previous one, and the
/// current one per bucket.
pub type Grouped<'a> = (
    Option<&'a ActivityCell>,
    Option<&'a ActivityCell>,
    Vec<&'a ActivityCell>,
);

/// Cells grouped as `domain.measure` -> (current, previous, series).
pub fn measures(cells: &[ActivityCell]) -> BTreeMap<String, Grouped<'_>> {
    let mut out: BTreeMap<String, Grouped<'_>> = BTreeMap::new();
    for c in cells {
        let e = out
            .entry(format!("{}.{}", c.domain, c.measure))
            .or_default();
        match c.bucket.as_str() {
            "cur" => e.0 = Some(c),
            "prev" => e.1 = Some(c),
            _ => e.2.push(c),
        }
    }
    for e in out.values_mut() {
        e.2.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    }
    out
}

// ── The answer ───────────────────────────────────────────────────────────────

/// The board, for one organization (or a workspace or project in it).
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsDto {
    pub organization_id: String,
    /// `organization`, `workspace` or `project`.
    pub scope: String,
    /// The tenant the board is about.
    pub scope_id: String,
    /// `7d`, `30d` or `90d`.
    pub range: String,
    pub days: u32,
    /// `day` (a 7-day range) or `week` (Monday weeks).
    pub bucket: String,
    /// The current window `[current_from, to]` and the previous one
    /// `[previous_from, previous_to]`, UTC days, both ends included.
    pub current_from: String,
    pub to: String,
    pub previous_from: String,
    pub previous_to: String,
    /// Every bucket's first day, oldest first: a series point missing from
    /// one of these is a bucket with nothing in it.
    pub buckets: Vec<String>,
    /// The repositories Insight was asked about (`owner/name`, lower case).
    pub repositories: Vec<String>,
    /// How many projects are in scope.
    pub projects: u32,
    /// Their ids, so a screen can narrow lists of its own (deployments) to
    /// the same scope.
    pub project_ids: Vec<String>,
    pub insight: OrgMetricsInsightDto,
    /// `shown`, `hidden` (the caller may not see costs) or `unreadable`.
    pub costs: String,
    /// Null unless `costs` is `shown`.
    pub spend: Option<OrgMetricsSpendDto>,
}

/// What Insight said, or why it said nothing.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsInsightDto {
    /// `ok`, `unconfigured`, `unreachable`, `failed`, `absent` (no Insight
    /// gear in this deployment) or `no_repositories` (nothing to ask about).
    pub state: String,
    pub detail: Option<String>,
    /// Insight capped a page: a figure is over a prefix.
    pub truncated: bool,
    /// One per measure that had any observation, keyed `domain.measure`
    /// (`git.pr_merged`, `ci.gate_runs`, `task.bugs_fixed`,
    /// `git.contributors`, …). A measure absent here had no observation.
    pub measures: Vec<OrgMetricsMeasureDto>,
    /// How reviews spread over reviewers: `cur` and `prev`.
    pub reviews: Vec<OrgMetricsReviewsDto>,
    /// Rows Insight's AI connectors wrote, warehouse-wide; 0 is "never
    /// ingested", null is "could not ask".
    pub ai_rows: Option<u64>,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsMeasureDto {
    pub key: String,
    pub current: Option<OrgMetricsCellDto>,
    pub previous: Option<OrgMetricsCellDto>,
    /// The current window per bucket; sparse.
    pub series: Vec<OrgMetricsPointDto>,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsCellDto {
    pub total: f64,
    pub median: Option<f64>,
    /// Observations.
    pub count: u64,
    /// Distinct entities.
    pub people: u64,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsPointDto {
    pub bucket: String,
    pub total: f64,
    pub median: Option<f64>,
    pub count: u64,
    pub people: u64,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsReviewsDto {
    pub period: String,
    pub reviewers: u64,
    pub reviews: u64,
    /// The fewest reviewers who did half of the reviews.
    pub half: u64,
    /// The five busiest reviewers' counts, busiest first; no names.
    pub top: Vec<u64>,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsSpendDto {
    pub currency: String,
    pub current: f64,
    pub previous: f64,
    /// The current window per bucket, every bucket present.
    pub series: Vec<OrgMetricsSpendPointDto>,
    /// Per workspace, most first: `id` is the organization's own for spend
    /// no workspace holds.
    pub by_workspace: Vec<OrgMetricsWorkspaceSpendDto>,
    /// `provider/model` with no price: spent, but not in the sums.
    pub unpriced: Vec<String>,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsSpendPointDto {
    pub bucket: String,
    pub cost: f64,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OrgMetricsWorkspaceSpendDto {
    pub id: String,
    pub name: String,
    pub cost: f64,
    pub previous: f64,
}

fn cell(c: &ActivityCell) -> OrgMetricsCellDto {
    OrgMetricsCellDto {
        total: c.total,
        median: c.median,
        count: c.n,
        people: c.people,
    }
}

fn review(r: &ReviewSpread) -> OrgMetricsReviewsDto {
    OrgMetricsReviewsDto {
        period: r.period.clone(),
        reviewers: r.reviewers,
        reviews: r.reviews,
        half: r.half,
        top: r.top.clone(),
    }
}

/// Insight's part of the board, from what it answered.
pub fn insight_dto(
    answer: Option<Result<RepositoryActivity, ActivityUnavailable>>,
    repositories: usize,
) -> OrgMetricsInsightDto {
    let state = |state: &str, detail: Option<String>| OrgMetricsInsightDto {
        state: state.to_owned(),
        detail,
        truncated: false,
        measures: Vec::new(),
        reviews: Vec::new(),
        ai_rows: None,
    };
    match answer {
        None => state(
            "absent",
            Some("this deployment has no studio-insight gear".into()),
        ),
        Some(Err(ActivityUnavailable::Unconfigured)) => state(
            "unconfigured",
            Some("Insight is not configured here: STUDIO_INSIGHT_API_KEY is not set".into()),
        ),
        Some(Err(ActivityUnavailable::Unreachable(d))) => state("unreachable", Some(d)),
        Some(Err(ActivityUnavailable::Failed(d))) => state("failed", Some(d)),
        Some(Ok(_)) if repositories == 0 => state(
            "no_repositories",
            Some("no project in scope names a repository".into()),
        ),
        Some(Ok(a)) => OrgMetricsInsightDto {
            state: "ok".into(),
            detail: None,
            truncated: a.truncated,
            measures: measures(&a.cells)
                .into_iter()
                .map(|(key, (cur, prev, series))| OrgMetricsMeasureDto {
                    key,
                    current: cur.map(cell),
                    previous: prev.map(cell),
                    series: series
                        .into_iter()
                        .map(|c| OrgMetricsPointDto {
                            bucket: c.bucket.clone(),
                            total: c.total,
                            median: c.median,
                            count: c.n,
                            people: c.people,
                        })
                        .collect(),
                })
                .collect(),
            reviews: a.reviews.iter().map(review).collect(),
            ai_rows: a.ai_rows,
        },
    }
}

/// How long one caller's board for one scope and range is reused.
const ANSWER_TTL: std::time::Duration = std::time::Duration::from_secs(60);
const CAPACITY: usize = 256;

type Key = (Uuid, Uuid, Scope, Range);

pub struct Metrics {
    pub overview: Arc<Overview>,
    kept: Mutex<HashMap<Key, (std::time::Instant, OrgMetricsDto)>>,
}

#[derive(Debug)]
pub enum MetricsRefusal {
    /// The organization is not the caller's, or the workspace or project is
    /// not in it.
    NotFound,
}

impl Metrics {
    pub fn new(overview: Arc<Overview>) -> Self {
        Self {
            overview,
            kept: Mutex::new(HashMap::new()),
        }
    }

    pub async fn answer(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        scope: Scope,
        range: Range,
        now: OffsetDateTime,
    ) -> Result<OrgMetricsDto, MetricsRefusal> {
        let tenant = self
            .overview
            .admit(ctx, org)
            .await
            .map_err(|_| MetricsRefusal::NotFound)?;
        let key = (org, ctx.subject_id(), scope, range);
        if let Some((at, v)) = self.kept.lock().ok().and_then(|k| k.get(&key).cloned())
            && at.elapsed() < ANSWER_TTL
        {
            return Ok(v);
        }
        let answer = self.read(ctx, org, tenant.name, scope, range, now).await?;
        if let Ok(mut kept) = self.kept.lock() {
            if kept.len() >= CAPACITY && !kept.contains_key(&key) {
                kept.clear();
            }
            kept.insert(key, (std::time::Instant::now(), answer.clone()));
        }
        Ok(answer)
    }

    async fn read(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        org_name: String,
        scope: Scope,
        range: Range,
        now: OffsetDateTime,
    ) -> Result<OrgMetricsDto, MetricsRefusal> {
        let am = &self.overview.sources.am;
        let hub = &self.overview.hub;
        let span = span(range, now);
        let all = projects_of(am.as_ref(), ctx, org).await.unwrap_or_default();
        let workspaces: BTreeSet<Uuid> = all.iter().map(|p| p.workspace_id).collect();
        let in_scope = match scope {
            // A workspace with no project is not in the walk; it is a scope
            // all the same when it is one of the organization's children.
            Scope::Workspace(w) if !workspaces.contains(&w) => {
                let children = super::rollups::children_of(
                    am.as_ref(),
                    ctx,
                    org,
                    super::rollups::WORKSPACE_TENANT_TYPE,
                )
                .await
                .unwrap_or_default();
                if children.iter().any(|(id, _)| *id == w) {
                    Vec::new()
                } else {
                    return Err(MetricsRefusal::NotFound);
                }
            }
            _ => scope
                .projects(&all, &workspaces)
                .ok_or(MetricsRefusal::NotFound)?,
        };
        let scope_id = match scope {
            Scope::Organization => org,
            Scope::Workspace(w) => w,
            Scope::Project(p) => p,
        };

        // The repositories the scope's projects are made of: their sources,
        // and the upstream a fork was seeded from, which is where Insight
        // keeps the work.
        let reads = futures_util::future::join_all(
            in_scope
                .iter()
                .map(|p| crate::project_sources::read_repositories(am.as_ref(), ctx, p.id)),
        )
        .await;
        let repositories: Vec<String> = reads
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|r| crate::insight::port::repository_key(&r))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();

        let insight = async {
            let analytics = hub.get::<dyn RepositoryAnalytics>().ok()?;
            Some(
                analytics
                    .activity(&ActivityQuery {
                        repositories: repositories.clone(),
                        previous_from: span.previous_from,
                        current_from: span.current_from,
                        to: span.to,
                        bucket: span.bucket,
                    })
                    .await,
            )
        };

        let tenants = scope.tenants(&in_scope);
        let money = async {
            let usage = hub.get::<dyn OrganizationUsage>().ok()?;
            if !usage.may_view(ctx, org).await {
                return None;
            }
            let (pf, pt) = span.previous_window();
            let buckets = futures_util::future::join_all(span.buckets.iter().map(|b| {
                let (f, t) = span.bucket_window(*b);
                usage.usage(ctx, org, f, t)
            }));
            let (previous, buckets) = tokio::join!(usage.usage(ctx, org, pf, pt), buckets);
            Some((previous, buckets))
        };
        let (insight, money) = tokio::join!(insight, money);

        let (costs, spend) = match money {
            None => ("hidden", None),
            Some((previous, buckets)) => {
                match (previous, buckets.into_iter().collect::<Result<Vec<_>, _>>()) {
                    (Ok(previous), Ok(buckets)) => {
                        let prev = spent(&previous, tenants.as_ref());
                        let mut series = Vec::with_capacity(buckets.len());
                        let mut current = Spent::default();
                        for (b, u) in span.buckets.iter().zip(&buckets) {
                            let s = spent(u, tenants.as_ref());
                            series.push(OrgMetricsSpendPointDto {
                                bucket: b.to_string(),
                                cost: s.total,
                            });
                            current.total += s.total;
                            for (t, c) in s.by_tenant {
                                *current.by_tenant.entry(t).or_default() += c;
                            }
                            current.unpriced.extend(s.unpriced);
                        }
                        let currency = buckets
                            .first()
                            .map(|u| u.currency.clone())
                            .unwrap_or_else(|| previous.currency.clone());
                        (
                            "shown",
                            Some(OrgMetricsSpendDto {
                                currency,
                                current: current.total,
                                previous: prev.total,
                                series,
                                by_workspace: by_workspace(
                                    org,
                                    &org_name,
                                    &all,
                                    &current.by_tenant,
                                    &prev.by_tenant,
                                )
                                .into_iter()
                                .map(|(id, name, cost, previous)| OrgMetricsWorkspaceSpendDto {
                                    id: id.to_string(),
                                    name,
                                    cost,
                                    previous,
                                })
                                .collect(),
                                unpriced: current.unpriced.into_iter().collect(),
                            }),
                        )
                    }
                    _ => ("unreadable", None),
                }
            }
        };

        Ok(OrgMetricsDto {
            organization_id: org.to_string(),
            scope: scope.kind().into(),
            scope_id: scope_id.to_string(),
            range: range.label().into(),
            days: range.days(),
            bucket: match span.bucket {
                ActivityBucket::Day => "day".into(),
                ActivityBucket::Week => "week".into(),
            },
            current_from: span.current_from.to_string(),
            to: span.to.to_string(),
            previous_from: span.previous_from.to_string(),
            previous_to: (span.current_from - Duration::days(1)).to_string(),
            buckets: span.buckets.iter().map(Date::to_string).collect(),
            projects: u32::try_from(in_scope.len()).unwrap_or(u32::MAX),
            project_ids: in_scope.iter().map(|p| p.id.to_string()).collect(),
            insight: insight_dto(insight, repositories.len()),
            repositories,
            costs: costs.into(),
            spend,
        })
    }
}

#[cfg(test)]
#[path = "metrics_tests.rs"]
mod tests;
