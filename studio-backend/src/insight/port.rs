//! What another gear may ask studio-insight for.
//!
//! The REST surface already answers "delivery per component, for ONE
//! repository, given the components". What it cannot answer is the question a
//! catalogue asks: "what moved in these gears?" — because the catalogue spans
//! several repositories and knows crate names rather than directories, and
//! joining the two answers back together is a rule, not a request.
//!
//! That rule belongs to whoever owns the catalogue, so it lives in
//! `components_catalog::activity`. This trait is the seam it reaches Insight
//! through: two queries, typed, with no SQL and no HTTP on the calling side.
//!
//! Published on the ClientHub like [`super::InsightClient`], and for the same
//! reason a consumer must tolerate its absence: this gear answers 503 for
//! every call when the upstream is not configured, and a portal screen that
//! cannot draw a chart should say so rather than fail the page.

use async_trait::async_trait;

/// One repository's worth of question: which components, over which window.
///
/// `segment` is the directory a component's files live under — `api-gateway`
/// for the crate `cf-gears-api-gateway`, matched wherever that name appears —
/// or, when it contains a `/`, a path from the repository root
/// (`gears/bss/ledger/`), matched as a prefix. Naming it is the caller's job because
/// the caller is the one holding the catalogue; matching it is Insight's,
/// because the warehouse holds the paths.
#[derive(Debug, Clone)]
pub struct DeliveryQuery {
    /// `owner/name`, as the warehouse keys it.
    pub repository: String,
    /// `YYYY-MM-DD`, inclusive. `None` lets the upstream default apply.
    pub from: Option<String>,
    pub to: Option<String>,
    /// `(key, path segment)` per component, at most the gear's own cap.
    pub components: Vec<(String, String)>,
    pub limit: Option<u32>,
}

/// One component's totals over the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryTotals {
    pub component: String,
    pub commits: u64,
    pub files_changed: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub authors: u64,
}

/// One component inside one bucket of the trend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryPoint {
    pub component: String,
    /// The bucket's first day, `YYYY-MM-DD`.
    pub date: String,
    pub commits: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// What a metrics query answered.
///
/// `from` and `to` are the window Insight ACTUALLY used, which is not always
/// the one asked for; a caller that fills gaps has to bucket over this pair
/// rather than over its own request.
#[derive(Debug, Clone, Default)]
pub struct DeliveryPage {
    pub from: String,
    pub to: String,
    /// Insight capped a page: the ranking is a prefix, not the whole of it.
    pub truncated: bool,
    pub totals: Vec<DeliveryTotals>,
    /// Weekly, and only for the components the ranking kept.
    pub series: Vec<DeliveryPoint>,
}

/// One component's pull requests, by the state they are in now.
#[derive(Debug, Clone, PartialEq)]
pub struct PullRequestTotals {
    pub component: String,
    pub open: u64,
    pub merged: u64,
    pub closed: u64,
    pub total: u64,
    /// Mean hours from opened to merged. `None` when nothing merged in the
    /// window, which is not the same fact as zero hours.
    pub merged_cycle_hours: Option<f64>,
    pub authors: u64,
}

#[derive(Debug, Clone, Default)]
pub struct PullRequestPage {
    pub truncated: bool,
    pub totals: Vec<PullRequestTotals>,
}

/// Delivery figures for named components of one repository.
///
/// Two methods rather than one because they are two questions with different
/// coverage, and a caller must be able to lose the second without losing the
/// first: a pull request is attributed through the files its commits touched,
/// which is dependable for what merged (~97% reach their files) and only
/// indicative for what was abandoned (~29% of closed, ~46% of open).
#[async_trait]
pub trait ComponentDelivery: Send + Sync + 'static {
    /// Commits, churn and authors per component, with a weekly trend.
    async fn metrics(&self, query: &DeliveryQuery) -> anyhow::Result<DeliveryPage>;

    /// Pull requests per component, counted by the state they are in now.
    async fn pull_requests(&self, query: &DeliveryQuery) -> anyhow::Result<PullRequestPage>;
}

// ── Activity of a set of repositories ────────────────────────────────────────

/// How a window is cut for a chart: days for a week, Monday weeks otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityBucket {
    Day,
    Week,
}

/// "What moved in these repositories over this window, against the one
/// before it?" -- the question an organization's (or a project's) dashboard
/// asks. The repositories are the scope: Insight resolves people thinly and
/// has no org units, so a repository is the finest owner it can be asked by.
#[derive(Debug, Clone)]
pub struct ActivityQuery {
    /// `owner/name`, as a project source names it; matched case-insensitively.
    pub repositories: Vec<String>,
    /// The previous window is `[previous_from, current_from)`.
    pub previous_from: time::Date,
    /// The current window is `[current_from, to]`, `to` included.
    pub current_from: time::Date,
    pub to: time::Date,
    pub bucket: ActivityBucket,
}

/// One measure over one bucket: `bucket` is `cur`, `prev`, or the first day
/// of a bucket of the current window (`YYYY-MM-DD`). Aggregated in SQL.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityCell {
    /// `git`, `ci` or `task`.
    pub domain: String,
    /// The warehouse's `measure_key`, or `contributors` (people who committed).
    pub measure: String,
    pub bucket: String,
    pub total: f64,
    /// The median observation; for the PR timings one observation is one PR.
    pub median: Option<f64>,
    /// How many observations.
    pub n: u64,
    /// How many distinct entities (people, bots left out where it matters).
    pub people: u64,
}

/// How reviews spread over reviewers in one period (`cur` or `prev`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSpread {
    pub period: String,
    pub reviewers: u64,
    pub reviews: u64,
    /// The fewest reviewers who did half of the reviews: the bus factor.
    pub half: u64,
    /// The five busiest reviewers' review counts, busiest first. No names.
    pub top: Vec<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct RepositoryActivity {
    pub cells: Vec<ActivityCell>,
    pub reviews: Vec<ReviewSpread>,
    /// Rows in Insight's `ai_*` observations, warehouse-wide. `Some(0)` is
    /// "the AI connectors were never ingested"; `None` is "could not ask".
    pub ai_rows: Option<u64>,
    /// Insight capped a page: some number above is over a prefix.
    pub truncated: bool,
}

/// Why there is no answer, said so a screen can tell the reader which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityUnavailable {
    /// This deployment never wired Insight.
    Unconfigured,
    /// Insight did not answer, or refused our credential.
    Unreachable(String),
    /// Insight answered and the answer was not one (our statement, or rows
    /// we could not read).
    Failed(String),
}

/// Repository-level delivery, quality and people figures from Insight.
#[async_trait]
pub trait RepositoryAnalytics: Send + Sync + 'static {
    async fn activity(
        &self,
        query: &ActivityQuery,
    ) -> Result<RepositoryActivity, ActivityUnavailable>;
}

/// A repository as [`RepositoryAnalytics`] keys it (`owner/name`, lower
/// case), or `None` for a path it would leave out.
pub fn repository_key(raw: &str) -> Option<String> {
    super::activity::repository(raw)
}
