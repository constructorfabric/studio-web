//! Delivery metrics sliced by **component** — a gear, a library, a service —
//! rather than by person or by repository.
//!
//! # Why this is built rather than read
//!
//! Insight's ready-made observations (`insight.git_metric_observations`) carry
//! a `repository` dimension and nothing finer. A repository in this
//! organisation is not a component: `gears-rust` alone holds ~90 gear crates
//! under `gears/<area>/<name>/`, and `studio-web` holds the backend assembly,
//! the portal and the prototype. Asking "how much moved in graph-storage last
//! month" therefore has to go one level below the dimension Insight offers, to
//! the per-file commit records it also publishes:
//! `insight.git_commit_file_changes` (path, lines, `committer_date`) joined to
//! `insight.git_authored_commits` for the author.
//!
//! Two ways to say what a component *is*:
//!
//! * **Derived** — group by the first `depth` path segments. `depth: 2` over
//!   `gears-rust` yields `gears/bss`, `libs/toolkit`, `docs/api`, …; `depth: 3`
//!   walks down to the individual gear. Good for a first look at a repository
//!   nobody has mapped yet.
//! * **Declared** — pass `components`, each a key plus either a `path_prefix`
//!   or a `path_segment` (a directory name, which defaults to the key). The
//!   segment form is what a caller that knows names but not paths wants: a
//!   portal listing gears knows `api-gateway`, the warehouse holds
//!   `gears/system/api-gateway/src/…`. The longest matcher wins, so a nested
//!   component beats the one containing it and `credstore-sdk` is not swallowed
//!   by `credstore`. Everything unmatched lands in `other`, which is
//!   deliberately kept: a component map that silently drops half the diff is
//!   worse than one that shows the gap.
//!
//! # On building SQL
//!
//! Insight only accepts a single read-only `SELECT`, so a broken statement
//! cannot write anything — but it could still read across the warehouse, so
//! every value interpolated here is both **validated** (charset and shape) and
//! **escaped** ([`sql_string`]). The two are not redundant: validation makes
//! the failure a clear 400 instead of a confusing upstream error, and escaping
//! is what actually holds if a new caller reaches the builder another way.

use serde::Deserialize;

/// Rendered as a ClickHouse string literal: backslash and quote escaped, so an
/// apostrophe in a path cannot end the literal early.
pub fn sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        match ch {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
        }
    }
    out.push('\'');
    out
}

/// How a file is decided to belong to a component.
///
/// `Segment` exists because the caller usually knows the component's *name* and
/// not where it sits: a portal listing gears knows `api-gateway`, while the
/// warehouse holds `gears/system/api-gateway/src/…`. Matching a whole path
/// segment finds it without anybody maintaining a path map — and whole-segment,
/// not substring, so `credstore` does not swallow `credstore-sdk`.
#[derive(Debug, Clone)]
pub enum ComponentMatch {
    /// Everything under this path prefix.
    Prefix(String),
    /// Every file with this exact directory (or file) name somewhere in its path.
    Segment(String),
}

impl ComponentMatch {
    fn value(&self) -> &str {
        match self {
            Self::Prefix(v) | Self::Segment(v) => v,
        }
    }

    /// The ClickHouse predicate for one file path.
    fn predicate(&self) -> String {
        match self {
            Self::Prefix(p) => format!("startsWith(f.file_path, {})", sql_string(p)),
            Self::Segment(s) => {
                format!("has(splitByChar('/', f.file_path), {})", sql_string(s))
            }
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Prefix(_) => "path_prefix",
            Self::Segment(_) => "path_segment",
        }
    }
}

/// One component: a name to report under, and the rule that defines it.
#[derive(Debug, Clone)]
pub struct ComponentSpec {
    pub key: String,
    pub matcher: ComponentMatch,
}

/// How a trend is bucketed over time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    Day,
    Week,
    Month,
}

impl Bucket {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "day" => Ok(Self::Day),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            other => Err(format!(
                "`bucket` must be `day`, `week` or `month`, got `{other}`"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    /// The ClickHouse expression that snaps a date column to this bucket's
    /// start. `toMonday` rather than `toStartOfWeek`, which needs a mode
    /// argument to say which day a week begins on.
    fn expr(self, column: &str) -> String {
        match self {
            Self::Day => column.to_string(),
            Self::Week => format!("toMonday({column})"),
            Self::Month => format!("toStartOfMonth({column})"),
        }
    }
}

/// A validated request for component metrics, ready to render as SQL.
#[derive(Debug, Clone)]
pub struct ComponentQuery {
    /// `project_key` in the warehouse — the GitHub org. `None` when the caller
    /// named a bare repository, which then matches in any org.
    pub project_key: Option<String>,
    pub repo_slug: String,
    /// Inclusive `YYYY-MM-DD` bounds. `None` means "the last 30 days", resolved
    /// by ClickHouse's `today()` rather than by a clock on this side — the
    /// warehouse's idea of today is the one the data is keyed by.
    pub from: Option<String>,
    pub to: Option<String>,
    /// Path segments to group by when `components` is empty.
    pub depth: u8,
    pub components: Vec<ComponentSpec>,
    /// Whether the remainder — everything matching no declared component — is
    /// reported. Only meaningful when `components` is non-empty.
    pub include_other: bool,
    pub limit: u32,
}

pub const DEFAULT_DEPTH: u8 = 2;
pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 500;
pub const MAX_COMPONENTS: usize = 200;
/// Ceiling on trend points, so a day bucket over a year of a large repository
/// cannot turn one request into a five-figure payload.
pub const MAX_TREND_POINTS: u32 = 5000;
/// The bucket every file that matches no declared component falls into.
pub const OTHER_KEY: &str = "other";

/// What a caller asks for, before validation. A struct rather than seven
/// positional arguments: every field here is optional-ish and easy to swap by
/// accident, and the REST layer builds it straight from the request DTO.
#[derive(Debug, Clone, Default)]
pub struct ComponentQueryInput {
    pub repository: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub depth: Option<u8>,
    pub components: Vec<ComponentSpec>,
    /// Default `true`: the remainder is shown unless the caller says otherwise.
    pub include_other: bool,
    pub limit: Option<u32>,
}

/// Rejects what would otherwise reach Insight as a confusing upstream error.
/// Returned strings are user-facing: they name the field and what is wrong.
impl ComponentQuery {
    pub fn new(input: ComponentQueryInput) -> Result<Self, String> {
        let ComponentQueryInput {
            repository,
            from,
            to,
            depth,
            components,
            include_other,
            limit,
        } = input;
        let (project_key, repo_slug) = parse_repository(&repository)?;
        let from = from.as_deref().map(validate_date).transpose()?;
        let to = to.as_deref().map(validate_date).transpose()?;
        if let (Some(f), Some(t)) = (&from, &to)
            && f > t
        {
            return Err(format!("`from` ({f}) is after `to` ({t})"));
        }

        let depth = depth.unwrap_or(DEFAULT_DEPTH);
        if !(1..=6).contains(&depth) {
            return Err(format!("`depth` must be between 1 and 6, got {depth}"));
        }

        if components.len() > MAX_COMPONENTS {
            return Err(format!(
                "at most {MAX_COMPONENTS} components can be declared, got {}",
                components.len()
            ));
        }
        for c in &components {
            validate_component(c)?;
        }

        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        if limit == 0 || limit > MAX_LIMIT {
            return Err(format!(
                "`limit` must be between 1 and {MAX_LIMIT}, got {limit}"
            ));
        }

        Ok(Self {
            project_key,
            repo_slug,
            from,
            to,
            depth,
            components,
            include_other,
            limit,
        })
    }

    /// Start of the window, as a ClickHouse expression.
    fn lower_bound(&self) -> String {
        match &self.from {
            Some(d) => format!("toDate({})", sql_string(d)),
            None => "today() - 29".to_string(),
        }
    }

    /// End of the window, inclusive.
    fn upper_bound(&self) -> String {
        match &self.to {
            Some(d) => format!("toDate({})", sql_string(d)),
            None => "today()".to_string(),
        }
    }

    /// The expression that names a file's component.
    ///
    /// Declared prefixes are tested longest-first so that a nested component
    /// (`gears/bss/ledger/`) wins over the one that contains it (`gears/`);
    /// `multiIf` takes the first match, so the order *is* the precedence.
    fn component_expr(&self) -> String {
        if self.components.is_empty() {
            return format!(
                "arrayStringConcat(arraySlice(splitByChar('/', f.file_path), 1, {}), '/')",
                self.depth
            );
        }
        let mut specs = self.components.clone();
        specs.sort_by(|a, b| {
            b.matcher
                .value()
                .len()
                .cmp(&a.matcher.value().len())
                .then_with(|| a.key.cmp(&b.key))
        });
        let arms = specs
            .iter()
            .map(|c| format!("{}, {}", c.matcher.predicate(), sql_string(&c.key)))
            .collect::<Vec<_>>()
            .join(", ");
        format!("multiIf({arms}, {})", sql_string(OTHER_KEY))
    }

    /// The statement to send to Insight.
    ///
    /// The inner `DISTINCT` is not cosmetic: a commit reachable from several
    /// branches appears once per reachability row, and summing lines over that
    /// would inflate every busy component. De-duplicating on
    /// (commit, file, lines, author) before aggregating is what makes
    /// `lines_added` a number about the repository rather than about the
    /// mirror's branch topology.
    pub fn to_sql(&self) -> String {
        format!(
            "SELECT component, \
             toString({from_expr}) AS range_from, \
             toString({to_expr}) AS range_to, \
             count(DISTINCT commit_hash) AS commits, \
             count(DISTINCT file_path) AS files_changed, \
             sum(lines_added) AS lines_added, \
             sum(lines_removed) AS lines_removed, \
             count(DISTINCT author_name) AS authors \
             FROM ({inner}){other_filter} \
             GROUP BY component, range_from, range_to \
             ORDER BY lines_added + lines_removed DESC, component ASC \
             LIMIT {limit}",
            from_expr = self.lower_bound(),
            to_expr = self.upper_bound(),
            inner = self.inner_select(false),
            other_filter = self.other_filter(),
            limit = self.limit,
        )
    }

    /// The same slice, bucketed over time — what a chart needs.
    ///
    /// Restricted to `keys`, which the caller takes from [`Self::to_sql`]'s
    /// answer: a trend over every component in a large repository is thousands
    /// of points nobody asked for, and the ranking already decided which
    /// components are worth drawing.
    pub fn to_trend_sql(&self, bucket: Bucket, keys: &[String]) -> String {
        let key_filter = if keys.is_empty() {
            String::new()
        } else {
            format!(
                " WHERE component IN ({})",
                keys.iter()
                    .map(|k| sql_string(k))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        format!(
            "SELECT component, \
             toString({bucket_expr}) AS bucket_date, \
             count(DISTINCT commit_hash) AS commits, \
             sum(lines_added) AS lines_added, \
             sum(lines_removed) AS lines_removed \
             FROM ({inner}){key_filter} \
             GROUP BY component, bucket_date \
             ORDER BY bucket_date ASC, component ASC \
             LIMIT {MAX_TREND_POINTS}",
            bucket_expr = bucket.expr("day"),
            inner = self.inner_select(true),
            key_filter = key_filter,
        )
    }

    /// `WHERE component != 'other'`, when the caller declared components and
    /// asked not to see the remainder.
    fn other_filter(&self) -> String {
        if self.include_other || self.components.is_empty() {
            String::new()
        } else {
            format!(" WHERE component != {}", sql_string(OTHER_KEY))
        }
    }

    /// Pull requests touching each component, counted by their **current**
    /// state, over the window they were *opened* in.
    ///
    /// Three things this statement has to get right, each of which is silently
    /// wrong if skipped:
    ///
    /// * **De-duplicate by `_version`.** The PR table keeps every ingested
    ///   version of a row, and a row carries the state it had *then* — so one
    ///   pull request appears as OPEN and again as MERGED. `argMax(…, _version)`
    ///   collapses it to the state it is in now.
    /// * **Join on the merge commit *and* the PR's own commits.** Which one
    ///   carries the files depends on how the repository merges: a squash
    ///   leaves one new commit the PR's commits never became, a merge commit
    ///   has an empty diff of its own. Taking either alone loses most of a
    ///   repository — `gears-frontx` attributes 70 of 75 merged PRs through the
    ///   merge sha and 4 through their commits; `gears-rust` is the exact
    ///   opposite.
    /// * **Attribution is partial for what did not merge.**
    ///   `git_commit_file_changes` is built from repository history, and an
    ///   abandoned PR's commits usually never entered it. A PR that reaches no
    ///   file is absent here rather than counted against some fallback
    ///   component, which is why these totals sit below the repository's.
    ///
    /// A pull request that touches three components is counted in all three.
    /// The rows are not a partition of the repository's pull requests, and
    /// saying so is the caller's job.
    pub fn to_pull_request_sql(&self) -> String {
        // The PR side of the join is narrowed by when a pull request was
        // OPENED. An open PR older than the window is therefore out of scope —
        // the alternative (state as of now, no window) makes a date filter mean
        // nothing for two of the three states.
        let opened_in_window = format!(
            "toDate(opened_at) >= {} AND toDate(opened_at) <= {}",
            self.lower_bound(),
            self.upper_bound(),
        );
        format!(
            "SELECT component, \
             toString({from_expr}) AS range_from, \
             toString({to_expr}) AS range_to, \
             countIf(state = 'OPEN') AS open, \
             countIf(state = 'MERGED') AS merged, \
             countIf(state = 'CLOSED') AS closed, \
             count() AS total, \
             round(avgIf(cycle_hours, state = 'MERGED'), 1) AS merged_cycle_hours, \
             uniqExact(author) AS authors \
             FROM (SELECT DISTINCT \
             pr.pr_id AS pr_id, \
             pr.state AS state, \
             pr.author AS author, \
             pr.cycle_hours AS cycle_hours, \
             {component_expr} AS component \
             FROM ({prs}) AS pr \
             INNER JOIN ({pr_commits}) AS pc ON pc.pr_id = pr.pr_id \
             INNER JOIN insight.git_commit_file_changes AS f \
             ON f.commit_hash = pc.commit_hash \
             WHERE {file_repo}){other_filter} \
             GROUP BY component, range_from, range_to \
             ORDER BY total DESC, component ASC \
             LIMIT {limit}",
            from_expr = self.lower_bound(),
            to_expr = self.upper_bound(),
            component_expr = self.component_expr(),
            prs = self.pull_requests_select(&opened_in_window),
            pr_commits = self.pr_commit_select(),
            file_repo = self.repo_filter("f"),
            other_filter = self.other_filter(),
            limit = self.limit,
        )
    }

    /// One row per pull request, collapsed to its current version.
    ///
    /// Cycle time is computed in minutes and divided, not taken in hours:
    /// `dateDiff('hour', …)` truncates, so a pull request merged inside an hour
    /// records as zero and drags the mean down — and excluding those to avoid
    /// that drags it up instead. 23 of `gears-rust`'s 590 are exactly that, so
    /// neither bias is hypothetical. Minutes avoid both.
    fn pull_requests_select(&self, having: &str) -> String {
        format!(
            "SELECT pr_id, \
             argMax(state, _version) AS state, \
             argMax(author_name, _version) AS author, \
             argMax(created_on, _version) AS opened_at, \
             dateDiff('minute', argMax(created_on, _version), argMax(closed_on, _version)) / 60 \
             AS cycle_hours \
             FROM silver.class_git_pull_requests AS p \
             WHERE {repo} \
             GROUP BY pr_id \
             HAVING {having}",
            repo = self.repo_filter("p"),
            having = having,
        )
    }

    /// Every commit a pull request can be recognised by: the ones it carries,
    /// and the squash/merge commit it became.
    fn pr_commit_select(&self) -> String {
        format!(
            "SELECT pr_id, commit_hash \
             FROM silver.class_git_pull_requests_commits AS c \
             WHERE {commits_repo} \
             UNION DISTINCT \
             SELECT pr_id, argMax(merge_commit_hash, _version) AS commit_hash \
             FROM silver.class_git_pull_requests AS m \
             WHERE {merge_repo} \
             GROUP BY pr_id \
             HAVING commit_hash != ''",
            commits_repo = self.repo_filter("c"),
            merge_repo = self.repo_filter("m"),
        )
    }

    /// `<alias>.project_key = … AND <alias>.repo_slug = …`, for whichever table
    /// is being narrowed. A caller that named a bare repository gets the slug
    /// alone, which then matches in any org.
    fn repo_filter(&self, alias: &str) -> String {
        match &self.project_key {
            Some(p) => format!(
                "{alias}.project_key = {} AND {alias}.repo_slug = {}",
                sql_string(p),
                sql_string(&self.repo_slug),
            ),
            None => format!("{alias}.repo_slug = {}", sql_string(&self.repo_slug)),
        }
    }

    /// The de-duplicated per-file rows both statements aggregate over.
    ///
    /// The `DISTINCT` is not cosmetic: a commit reachable from several branches
    /// appears once per reachability row, and summing lines over that would
    /// inflate every busy component. De-duplicating on (commit, file, lines,
    /// author) before aggregating is what makes `lines_added` a number about
    /// the repository rather than about the mirror's branch topology.
    fn inner_select(&self, with_day: bool) -> String {
        let repo_filter = self.repo_filter("f");
        // A commit has exactly one committer_date, so carrying the day through
        // the DISTINCT cannot split a row that would otherwise collapse.
        let day = if with_day {
            "toDate(f.committer_date) AS day, "
        } else {
            ""
        };
        format!(
            "SELECT DISTINCT \
             f.commit_hash AS commit_hash, \
             f.file_path AS file_path, \
             coalesce(f.lines_added, 0) AS lines_added, \
             coalesce(f.lines_removed, 0) AS lines_removed, \
             {day}{component_expr} AS component, \
             a.author_name AS author_name \
             FROM insight.git_commit_file_changes AS f \
             LEFT JOIN insight.git_authored_commits AS a \
             ON a.commit_hash = f.commit_hash \
             AND a.project_key = f.project_key \
             AND a.repo_slug = f.repo_slug \
             WHERE {repo_filter} \
             AND toDate(f.committer_date) >= {from_expr} \
             AND toDate(f.committer_date) <= {to_expr}",
            day = day,
            component_expr = self.component_expr(),
            repo_filter = repo_filter,
            from_expr = self.lower_bound(),
            to_expr = self.upper_bound(),
        )
    }
}

/// One row of the answer, read back off Insight's generic SQL page.
#[derive(Debug, Clone, Deserialize)]
pub struct ComponentRow {
    pub component: String,
    pub range_from: String,
    pub range_to: String,
    pub commits: u64,
    pub files_changed: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub authors: u64,
}

/// One component's pull-request counts, read back off Insight's generic page.
#[derive(Debug, Clone, Deserialize)]
pub struct PullRequestRow {
    pub component: String,
    pub range_from: String,
    pub range_to: String,
    pub open: u64,
    pub merged: u64,
    pub closed: u64,
    pub total: u64,
    /// Average hours from opened to merged, over the merged ones. `None` when
    /// nothing merged in the window — which is not the same as zero hours.
    pub merged_cycle_hours: Option<f64>,
    pub authors: u64,
}

/// One point of a trend: what a component did inside one bucket.
#[derive(Debug, Clone, Deserialize)]
pub struct ComponentPoint {
    pub component: String,
    /// The bucket's first day, `YYYY-MM-DD`.
    pub bucket_date: String,
    pub commits: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// `owner/name` or a bare `name`. Anything else is rejected rather than escaped
/// and sent, because a repository with a quote in it does not exist and a
/// caller who wrote one has a bug worth seeing.
fn parse_repository(repository: &str) -> Result<(Option<String>, String), String> {
    let repo = repository.trim().trim_matches('/');
    if repo.is_empty() {
        return Err("`repository` is required, e.g. `constructorfabric/gears-rust`".into());
    }
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    let mut parts = repo.split('/');
    let (owner, name) = match (parts.next(), parts.next(), parts.next()) {
        (Some(name), None, _) => (None, name),
        (Some(owner), Some(name), None) => (Some(owner), name),
        _ => {
            return Err(format!(
                "`repository` must be `owner/name` or `name`, got `{repository}`"
            ));
        }
    };
    if !ok(name) || owner.is_some_and(|o| !ok(o)) {
        return Err(format!(
            "`repository` may only contain letters, digits, `.`, `_`, `-` and one `/`, got `{repository}`"
        ));
    }
    Ok((owner.map(str::to_string), name.to_string()))
}

/// `YYYY-MM-DD`, checked for shape and for plausible month/day so a typo does
/// not come back as an empty result set that looks like "no activity".
fn validate_date(value: &str) -> Result<String, String> {
    let d = value.trim();
    let bytes = d.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit());
    if !shaped {
        return Err(format!("dates must be `YYYY-MM-DD`, got `{value}`"));
    }
    let month: u32 = d[5..7].parse().map_err(|_| "bad month".to_string())?;
    let day: u32 = d[8..10].parse().map_err(|_| "bad day".to_string())?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(format!("`{value}` is not a real date"));
    }
    Ok(d.to_string())
}

fn validate_component(c: &ComponentSpec) -> Result<(), String> {
    if c.key.trim().is_empty() {
        return Err("every component needs a non-empty `key`".into());
    }
    if c.key.len() > 120 {
        return Err(format!(
            "component key `{}` is longer than 120 bytes",
            c.key
        ));
    }
    let matcher = c.matcher.value();
    if matcher.trim().is_empty() {
        return Err(format!(
            "component `{}` needs a non-empty `{}`",
            c.key,
            c.matcher.kind()
        ));
    }
    if matcher.len() > 400 {
        return Err(format!(
            "component `{}` has a `{}` longer than 400 bytes",
            c.key,
            c.matcher.kind()
        ));
    }
    if let ComponentMatch::Segment(s) = &c.matcher
        && s.contains('/')
    {
        return Err(format!(
            "component `{}`: `path_segment` is one directory name, not a path — \
             use `path_prefix` for `{s}`",
            c.key
        ));
    }
    if c.key.chars().any(char::is_control) || matcher.chars().any(char::is_control) {
        return Err(format!(
            "component `{}` contains a control character",
            c.key.escape_debug()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(key: &str, prefix: &str) -> ComponentSpec {
        ComponentSpec {
            key: key.into(),
            matcher: ComponentMatch::Prefix(prefix.into()),
        }
    }

    fn seg(key: &str) -> ComponentSpec {
        ComponentSpec {
            key: key.into(),
            matcher: ComponentMatch::Segment(key.into()),
        }
    }

    /// The usual input: a repository, everything else defaulted.
    fn input(repository: &str) -> ComponentQueryInput {
        ComponentQueryInput {
            repository: repository.into(),
            include_other: true,
            ..Default::default()
        }
    }

    fn err_of(input: ComponentQueryInput) -> String {
        ComponentQuery::new(input).expect_err("should be refused")
    }

    #[test]
    fn a_quote_cannot_escape_the_literal_it_sits_in() {
        assert_eq!(sql_string("o'neil"), r"'o\'neil'");
        assert_eq!(sql_string(r"back\slash"), r"'back\\slash'");
        // The shape an injection attempt takes: the closing quote stays escaped,
        // so the payload is data, not syntax.
        assert_eq!(
            sql_string("x' UNION ALL SELECT * FROM system.users --"),
            r"'x\' UNION ALL SELECT * FROM system.users --'"
        );
    }

    #[test]
    fn a_repository_is_owner_slash_name_or_a_bare_name() {
        let q = ComponentQuery::new(input("constructorfabric/gears-rust")).expect("valid");
        assert_eq!(q.project_key.as_deref(), Some("constructorfabric"));
        assert_eq!(q.repo_slug, "gears-rust");

        let bare = ComponentQuery::new(input("gears-rust")).expect("valid");
        assert_eq!(bare.project_key, None);
        assert_eq!(bare.repo_slug, "gears-rust");
    }

    #[test]
    fn a_repository_that_could_carry_sql_is_refused_outright() {
        for bad in [
            "",
            "a/b/c",
            "constructorfabric/gears'; SELECT 1 --",
            "owner/na me",
        ] {
            assert!(
                ComponentQuery::new(input(bad)).is_err(),
                "`{bad}` should be refused"
            );
        }
    }

    #[test]
    fn bounds_and_sizes_are_checked_before_the_round_trip() {
        let with = |f: fn(&mut ComponentQueryInput)| {
            let mut i = input("r");
            f(&mut i);
            err_of(i)
        };
        assert!(
            with(|i| i.from = Some("2026-13-01".into())).contains("not a real date"),
            "an impossible month must be caught here, not read as no activity"
        );
        assert!(with(|i| i.from = Some("01-01-2026".into())).contains("YYYY-MM-DD"));
        assert!(
            with(|i| {
                i.from = Some("2026-09-11".into());
                i.to = Some("2026-09-01".into());
            })
            .contains("is after")
        );
        assert!(with(|i| i.depth = Some(0)).contains("depth"));
        assert!(with(|i| i.depth = Some(7)).contains("depth"));
        assert!(with(|i| i.limit = Some(MAX_LIMIT + 1)).contains("limit"));
        assert!(with(|i| i.components = vec![spec("", "gears/")]).contains("key"));
        assert!(with(|i| i.components = vec![spec("k", "  ")]).contains("path_prefix"));
    }

    #[test]
    fn without_declared_components_it_groups_by_path_depth() {
        let sql = ComponentQuery::new(ComponentQueryInput {
            depth: Some(3),
            ..input("constructorfabric/gears-rust")
        })
        .expect("valid")
        .to_sql();
        assert!(
            sql.contains("arraySlice(splitByChar('/', f.file_path), 1, 3)"),
            "{sql}"
        );
        // Defaulted window is resolved by the warehouse, not by our clock.
        assert!(sql.contains("today() - 29"), "{sql}");
        assert!(sql.contains("f.project_key = 'constructorfabric'"), "{sql}");
        assert!(sql.contains("LIMIT 50"), "{sql}");
    }

    #[test]
    fn a_bare_repository_name_does_not_filter_on_the_org() {
        let sql = ComponentQuery::new(input("gears-rust"))
            .expect("valid")
            .to_sql();
        assert!(sql.contains("f.repo_slug = 'gears-rust'"), "{sql}");
        assert!(!sql.contains("f.project_key ="), "{sql}");
    }

    #[test]
    fn declared_prefixes_are_matched_longest_first() {
        let sql = ComponentQuery::new(ComponentQueryInput {
            from: Some("2026-08-01".into()),
            to: Some("2026-09-11".into()),
            components: vec![spec("gears", "gears/"), spec("ledger", "gears/bss/ledger/")],
            ..input("constructorfabric/gears-rust")
        })
        .expect("valid")
        .to_sql();
        let nested = sql.find("'gears/bss/ledger/'").expect("nested arm");
        let outer = sql.find("'gears/'").expect("outer arm");
        assert!(
            nested < outer,
            "the nested component must be tested first, or it never matches:\n{sql}"
        );
        assert!(sql.contains("'other'"), "unmatched files must stay visible");
        assert!(sql.contains("toDate('2026-08-01')"), "{sql}");
        assert!(sql.contains("toDate('2026-09-11')"), "{sql}");
    }

    #[test]
    fn a_segment_matcher_finds_a_component_by_name_without_a_path_map() {
        let sql = ComponentQuery::new(ComponentQueryInput {
            components: vec![seg("api-gateway"), seg("credstore"), seg("credstore-sdk")],
            include_other: false,
            ..input("constructorfabric/gears-rust")
        })
        .expect("valid")
        .to_sql();
        assert!(
            sql.contains("has(splitByChar('/', f.file_path), 'api-gateway')"),
            "{sql}"
        );
        // Whole-segment, and the longer name is tested first: files under
        // `gears/credstore/credstore-sdk/` carry BOTH segments, so the order is
        // the only thing keeping the SDK out of the gear's numbers.
        let sdk = sql.find("'credstore-sdk'").expect("sdk arm");
        let gear = sql
            .find("f.file_path), 'credstore')")
            .expect("credstore arm");
        assert!(
            sdk < gear,
            "the longer segment must be tested first:\n{sql}"
        );
    }

    #[test]
    fn pull_requests_collapse_to_their_current_state_and_reach_files_both_ways() {
        let sql = ComponentQuery::new(ComponentQueryInput {
            from: Some("2026-05-01".into()),
            components: vec![seg("api-gateway"), seg("credstore")],
            include_other: false,
            ..input("constructorfabric/gears-rust")
        })
        .expect("valid")
        .to_pull_request_sql();

        // One row per pull request, at the state it is in now: the table keeps
        // a row per ingested version, each carrying the state it had then.
        assert!(sql.contains("argMax(state, _version) AS state"), "{sql}");
        assert!(sql.contains("GROUP BY pr_id"), "{sql}");

        // Both ways a pull request reaches its files, or a squash-merging
        // repository (or a merge-committing one) silently reports almost none.
        assert!(sql.contains("class_git_pull_requests_commits"), "{sql}");
        assert!(sql.contains("UNION DISTINCT"), "{sql}");
        assert!(sql.contains("argMax(merge_commit_hash, _version)"), "{sql}");

        // Hours would truncate every sub-hour merge to zero.
        assert!(sql.contains("dateDiff('minute'"), "{sql}");
        assert!(!sql.contains("dateDiff('hour'"), "{sql}");

        // The window is on when a pull request was opened.
        assert!(
            sql.contains("toDate(opened_at) >= toDate('2026-05-01')"),
            "{sql}"
        );

        // Every table in the join is narrowed to the repository — a missing one
        // would join the whole warehouse and still look like a plausible answer.
        for alias in ["p", "c", "m", "f"] {
            assert!(
                sql.contains(&format!("{alias}.project_key = 'constructorfabric'")),
                "`{alias}` is not narrowed to the repository:{nl}{sql}",
                nl = "
"
            );
        }
        assert!(sql.contains("WHERE component != 'other'"), "{sql}");
    }

    #[test]
    fn a_pull_request_row_reads_back_off_insights_generic_page() {
        let row: PullRequestRow = serde_json::from_value(serde_json::json!({
            "component": "api-gateway",
            "range_from": "2026-05-01",
            "range_to": "2026-09-11",
            "open": 1,
            "merged": 36,
            "closed": 15,
            "total": 52,
            "merged_cycle_hours": 149.8,
            "authors": 14,
        }))
        .expect("wire shape");
        assert_eq!(row.merged, 36);
        assert_eq!(row.merged_cycle_hours, Some(149.8));

        // Nothing merged in the window is absent, not zero hours.
        let quiet: PullRequestRow = serde_json::from_value(serde_json::json!({
            "component": "graph-storage",
            "range_from": "2026-05-01", "range_to": "2026-09-11",
            "open": 0, "merged": 0, "closed": 2, "total": 2,
            "merged_cycle_hours": null, "authors": 1,
        }))
        .expect("wire shape");
        assert_eq!(quiet.merged_cycle_hours, None);
    }

    #[test]
    fn a_path_is_not_a_segment() {
        let detail = err_of(ComponentQueryInput {
            components: vec![ComponentSpec {
                key: "insight".into(),
                matcher: ComponentMatch::Segment("studio-backend/src/insight".into()),
            }],
            ..input("constructorfabric/studio-web")
        });
        assert!(detail.contains("path_prefix"), "{detail}");
    }

    #[test]
    fn the_remainder_can_be_dropped_when_only_named_components_matter() {
        let declared = |include_other| {
            ComponentQuery::new(ComponentQueryInput {
                components: vec![spec("insight", "studio-backend/src/insight/")],
                include_other,
                ..input("constructorfabric/studio-web")
            })
            .expect("valid")
            .to_sql()
        };
        assert!(
            declared(false).contains("WHERE component != 'other'"),
            "{}",
            declared(false)
        );
        assert!(!declared(true).contains("component != 'other'"));

        // Nothing to exclude when components are derived: every file is in one.
        let derived = ComponentQuery::new(ComponentQueryInput {
            include_other: false,
            ..input("constructorfabric/studio-web")
        })
        .expect("valid")
        .to_sql();
        assert!(!derived.contains("component != 'other'"), "{derived}");
    }

    #[test]
    fn a_trend_buckets_the_same_slice_and_stays_on_the_ranked_components() {
        let q = ComponentQuery::new(ComponentQueryInput {
            depth: Some(3),
            ..input("constructorfabric/gears-rust")
        })
        .expect("valid");
        let sql = q.to_trend_sql(Bucket::Week, &["gears/bss".into(), "libs/toolkit".into()]);
        assert!(sql.contains("toMonday(day)"), "{sql}");
        assert!(
            sql.contains("component IN ('gears/bss', 'libs/toolkit')"),
            "{sql}"
        );
        assert!(sql.contains("GROUP BY component, bucket_date"), "{sql}");
        assert!(sql.contains(&format!("LIMIT {MAX_TREND_POINTS}")), "{sql}");
        // The day column only exists in the trend statement.
        assert!(sql.contains("toDate(f.committer_date) AS day"), "{sql}");
        assert!(!q.to_sql().contains("AS day"), "{}", q.to_sql());
    }

    #[test]
    fn bucket_names_are_the_three_the_api_documents() {
        assert_eq!(Bucket::parse("Week").expect("week"), Bucket::Week);
        assert_eq!(Bucket::parse(" day ").expect("day"), Bucket::Day);
        assert_eq!(Bucket::parse("month").expect("month"), Bucket::Month);
        assert!(Bucket::parse("quarter").is_err());
        assert_eq!(Bucket::Month.expr("day"), "toStartOfMonth(day)");
        assert_eq!(Bucket::Day.expr("day"), "day");
    }

    #[test]
    fn a_row_reads_back_off_insights_generic_page() {
        let row: ComponentRow = serde_json::from_value(serde_json::json!({
            "component": "gears/bss",
            "range_from": "2026-08-01",
            "range_to": "2026-09-11",
            "commits": 46,
            "files_changed": 858,
            "lines_added": 381968,
            "lines_removed": 4806,
            "authors": 10,
        }))
        .expect("wire shape");
        assert_eq!(row.component, "gears/bss");
        assert_eq!(row.lines_added, 381_968);

        let point: ComponentPoint = serde_json::from_value(serde_json::json!({
            "component": "gears/bss",
            "bucket_date": "2026-08-31",
            "commits": 9,
            "lines_added": 1200,
            "lines_removed": 40,
        }))
        .expect("wire shape");
        assert_eq!(point.bucket_date, "2026-08-31");
        assert_eq!(point.commits, 9);
    }
}
