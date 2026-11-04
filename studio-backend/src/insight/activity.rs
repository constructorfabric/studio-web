//! The [`RepositoryAnalytics`] seam: what moved in a set of repositories.
//!
//! A leader's dashboard asks Insight about the repositories its projects are
//! made of, because that is the finest owner the warehouse can be asked by
//! today (people resolve thinly and there are no org units; see
//! `docs/insight-quickstart.md`, "Why the gold views read empty"). Three
//! statements, built here and never by the caller, each aggregating in SQL:
//!
//! * the measures -- git and CI observations sliced by their `repository`
//!   dimension, and task evidence whose issue lives in one of the
//!   repositories (`owner/name#123`) -- totalled per window and per bucket of
//!   the current window;
//! * how reviews spread over reviewers, per window (bots left out);
//! * whether the AI connectors ever wrote a row.
//!
//! Every interpolated value is validated (repository charset) and escaped.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use super::client::{InsightClient, InsightError};
use super::components::sql_string;
use super::port::{
    ActivityBucket, ActivityCell, ActivityQuery, ActivityUnavailable, RepositoryActivity,
    RepositoryAnalytics, ReviewSpread,
};

/// Git measures read, per window and per bucket.
pub const GIT_MEASURES: [&str; 8] = [
    "pr_merged",
    "pr_created",
    "pr_cycle_hours",
    "pr_first_review_hours",
    "pr_merged_without_approval",
    "commit_count",
    "test_lines_added",
    "code_lines_added",
];
/// CI measures read.
pub const CI_MEASURES: [&str; 3] = ["deployments", "gate_runs", "gate_first_try_passed"];
/// Task measures read, as evidence (one row per issue).
pub const TASK_MEASURES: [&str; 3] = ["bugs_fixed", "reopened_within_14d", "tasks_closed"];

/// The most repositories one statement names; a scope with more is cut, and
/// the answer says it was.
pub const MAX_REPOSITORIES: usize = 200;

/// A repository the warehouse could hold: `owner/name` (or a group path),
/// lower-cased. `None` for anything else, which is left out rather than sent.
pub fn repository(raw: &str) -> Option<String> {
    let r = raw.trim().trim_matches('/').to_ascii_lowercase();
    let ok = !r.is_empty()
        && r.len() <= 200
        && r.contains('/')
        && r.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'));
    ok.then_some(r)
}

fn repo_list(repos: &[String]) -> String {
    repos
        .iter()
        .map(|r| sql_string(r))
        .collect::<Vec<_>>()
        .join(", ")
}

fn quoted(keys: &[&str]) -> String {
    keys.iter()
        .map(|k| sql_string(k))
        .collect::<Vec<_>>()
        .join(", ")
}

fn date(d: time::Date) -> String {
    format!("toDate({})", sql_string(&d.to_string()))
}

/// The measures statement: one row per `(domain, measure, bucket)`.
pub fn measures_sql(q: &ActivityQuery, repos: &[String]) -> String {
    let repos = repo_list(repos);
    let from = date(q.previous_from);
    let cur = date(q.current_from);
    let to = date(q.to);
    let bucket = match q.bucket {
        ActivityBucket::Day => "toString(day)",
        ActivityBucket::Week => "toString(toMonday(day))",
    };
    let git = quoted(&GIT_MEASURES);
    let ci = quoted(&CI_MEASURES);
    let task = quoted(&TASK_MEASURES);
    format!(
        "WITH obs AS (\
SELECT 'git' AS domain, measure_key AS measure, metric_date AS day, toFloat64(ifNull(value, 0)) AS v, entity_id AS who \
FROM insight.git_metric_observations ARRAY JOIN dimensions AS d \
WHERE d.key = 'repository' AND lower(d.label) IN ({repos}) AND metric_date >= {from} AND metric_date <= {to} AND measure_key IN ({git}) \
UNION ALL \
SELECT 'git', 'contributors', metric_date, 1.0, entity_id \
FROM insight.git_metric_observations ARRAY JOIN dimensions AS d \
WHERE d.key = 'repository' AND lower(d.label) IN ({repos}) AND metric_date >= {from} AND metric_date <= {to} \
AND measure_key = 'commit_count' AND ifNull(value, 0) > 0 AND entity_id NOT LIKE '%[bot]%' \
UNION ALL \
SELECT 'ci', measure_key, metric_date, toFloat64(ifNull(value, 0)), entity_id \
FROM insight.ci_metric_observations ARRAY JOIN dimensions AS d \
WHERE d.key = 'repository' AND lower(d.label) IN ({repos}) AND metric_date >= {from} AND metric_date <= {to} AND measure_key IN ({ci}) \
UNION ALL \
SELECT DISTINCT 'task', measure_key, metric_date, 1.0, record_id \
FROM insight.task_metric_evidence \
WHERE lower(splitByChar('#', record_label)[1]) IN ({repos}) AND metric_date >= {from} AND metric_date <= {to} AND measure_key IN ({task})\
) \
SELECT domain, measure, if(day < {cur}, 'prev', 'cur') AS bucket, sum(v) AS total, quantileExact(0.5)(v) AS median, count() AS n, uniqExact(who) AS people \
FROM obs GROUP BY domain, measure, bucket \
UNION ALL \
SELECT domain, measure, {bucket} AS bucket, sum(v) AS total, quantileExact(0.5)(v) AS median, count() AS n, uniqExact(who) AS people \
FROM obs WHERE day >= {cur} GROUP BY domain, measure, bucket \
LIMIT 5000"
    )
}

/// The review-spread statement: one row per window.
pub fn reviews_sql(q: &ActivityQuery, repos: &[String]) -> String {
    let repos = repo_list(repos);
    let from = date(q.previous_from);
    let cur = date(q.current_from);
    let to = date(q.to);
    format!(
        "SELECT period, count() AS reviewers, sum(c) AS reviews, \
arrayFirstIndex(x -> x * 2 >= sum(c), arrayCumSum(arrayReverseSort(groupArray(c)))) AS half, \
arraySlice(arrayReverseSort(groupArray(c)), 1, 5) AS top \
FROM (SELECT if(metric_date < {cur}, 'prev', 'cur') AS period, entity_id, count() AS c \
FROM insight.git_review_events \
WHERE event_kind = 'review' AND lower(repository_label) IN ({repos}) \
AND metric_date >= {from} AND metric_date <= {to} AND entity_id NOT LIKE '%[bot]%' \
GROUP BY period, entity_id) \
GROUP BY period"
    )
}

/// Whether the AI connectors ever wrote a row, anywhere in the warehouse.
pub const AI_ROWS_SQL: &str = "SELECT (SELECT count() FROM insight.ai_metric_observations) \
+ (SELECT count() FROM insight.ai_cost_metric_observations) AS ai_rows";

/// A number as ClickHouse may send it: a JSON number, or a string for the
/// 64-bit integers some formats quote.
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|f: &f64| f.is_finite())
}

fn count(v: Option<&Value>) -> u64 {
    num(v).map(|f| f.max(0.0).round() as u64).unwrap_or(0)
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) if !other.is_null() => other.to_string(),
        _ => String::new(),
    }
}

/// The measures statement's rows.
pub fn read_cells(rows: &[Value]) -> Vec<ActivityCell> {
    rows.iter()
        .map(|r| ActivityCell {
            domain: text(r.get("domain")),
            measure: text(r.get("measure")),
            bucket: text(r.get("bucket")),
            total: num(r.get("total")).unwrap_or(0.0),
            median: num(r.get("median")),
            n: count(r.get("n")),
            people: count(r.get("people")),
        })
        .filter(|c| !c.measure.is_empty() && !c.bucket.is_empty())
        .collect()
}

/// The review statement's rows.
pub fn read_reviews(rows: &[Value]) -> Vec<ReviewSpread> {
    rows.iter()
        .map(|r| ReviewSpread {
            period: text(r.get("period")),
            reviewers: count(r.get("reviewers")),
            reviews: count(r.get("reviews")),
            half: count(r.get("half")),
            top: r
                .get("top")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|v| count(Some(v))).collect())
                .unwrap_or_default(),
        })
        .collect()
}

/// Which kind of "no answer" an Insight error is.
pub fn unavailable(e: &InsightError) -> ActivityUnavailable {
    match e {
        InsightError::NotConfigured(_) => ActivityUnavailable::Unconfigured,
        InsightError::Transport(_) => ActivityUnavailable::Unreachable(e.to_string()),
        InsightError::Upstream { status, .. } if *status >= 500 || matches!(status, 401 | 403) => {
            ActivityUnavailable::Unreachable(e.to_string())
        }
        InsightError::Upstream { .. } => ActivityUnavailable::Failed(e.to_string()),
    }
}

pub struct InsightActivity {
    client: Arc<dyn InsightClient>,
}

impl InsightActivity {
    pub fn new(client: Arc<dyn InsightClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl RepositoryAnalytics for InsightActivity {
    async fn activity(
        &self,
        query: &ActivityQuery,
    ) -> Result<RepositoryActivity, ActivityUnavailable> {
        if !self.client.is_configured() {
            return Err(ActivityUnavailable::Unconfigured);
        }
        let mut repos: Vec<String> = query
            .repositories
            .iter()
            .filter_map(|r| repository(r))
            .collect();
        repos.sort();
        repos.dedup();
        let cut = repos.len() > MAX_REPOSITORIES;
        repos.truncate(MAX_REPOSITORIES);
        if repos.is_empty() {
            return Ok(RepositoryActivity::default());
        }
        let measures = measures_sql(query, &repos);
        let reviews = reviews_sql(query, &repos);
        let (measures, reviews, ai) = tokio::join!(
            self.client.query(&measures),
            self.client.query(&reviews),
            self.client.query(AI_ROWS_SQL),
        );
        // The measures are the answer; the other two cost only their part.
        let measures = measures.map_err(|e| unavailable(&e))?;
        let mut out = RepositoryActivity {
            cells: read_cells(&measures.rows),
            truncated: cut || measures.truncated,
            ..RepositoryActivity::default()
        };
        if let Ok(page) = reviews {
            out.truncated = out.truncated || page.truncated;
            out.reviews = read_reviews(&page.rows);
        }
        out.ai_rows = ai
            .ok()
            .and_then(|page| page.rows.first().map(|r| count(r.get("ai_rows"))));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use time::macros::date;

    fn q() -> ActivityQuery {
        ActivityQuery {
            repositories: vec![],
            previous_from: date!(2026 - 09 - 06),
            current_from: date!(2026 - 10 - 06),
            to: date!(2026 - 11 - 04),
            bucket: ActivityBucket::Week,
        }
    }

    #[test]
    fn a_repository_is_owner_slash_name_and_nothing_else() {
        assert_eq!(
            repository(" ConstructorFabric/Studio-Web "),
            Some("constructorfabric/studio-web".into())
        );
        assert_eq!(
            repository("group/sub/repo.x"),
            Some("group/sub/repo.x".into())
        );
        assert_eq!(repository("noslash"), None);
        assert_eq!(repository("a/b' OR 1=1 --"), None);
        assert_eq!(repository(""), None);
    }

    #[test]
    fn the_statements_are_single_selects_over_the_named_window() {
        let repos = vec!["acme/api".to_owned()];
        let m = measures_sql(&q(), &repos);
        assert!(m.starts_with("WITH obs AS ("));
        assert!(!m.contains(';'));
        assert!(m.contains("lower(d.label) IN ('acme/api')"));
        assert!(m.contains("metric_date >= toDate('2026-09-06')"));
        assert!(m.contains("if(day < toDate('2026-10-06'), 'prev', 'cur')"));
        assert!(m.contains("toString(toMonday(day))"));
        assert!(m.contains("'pr_first_review_hours'"));
        let daily = measures_sql(
            &ActivityQuery {
                bucket: ActivityBucket::Day,
                ..q()
            },
            &repos,
        );
        assert!(daily.contains("toString(day) AS bucket"));
        let r = reviews_sql(&q(), &repos);
        assert!(r.starts_with("SELECT period"));
        assert!(r.contains("NOT LIKE '%[bot]%'"));
    }

    #[test]
    fn rows_are_read_whether_numbers_come_as_numbers_or_strings() {
        let cells = read_cells(&[
            json!({"domain":"git","measure":"pr_merged","bucket":"cur","total":431,"median":1,"n":"241","people":4}),
            json!({"domain":"git","measure":"pr_cycle_hours","bucket":"2026-10-05","total":3330.6,"median":null,"n":94,"people":3}),
            json!({"domain":"git","measure":"","bucket":"cur"}),
        ]);
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].n, 241);
        assert_eq!(cells[0].median, Some(1.0));
        assert_eq!(cells[1].median, None);
        let reviews = read_reviews(&[
            json!({"period":"cur","reviewers":41,"reviews":"4209","half":5,"top":[1041,365]}),
        ]);
        assert_eq!(reviews[0].reviews, 4209);
        assert_eq!(reviews[0].top, vec![1041, 365]);
    }

    #[test]
    fn a_failure_is_told_apart_from_a_missing_wire() {
        assert_eq!(
            unavailable(&InsightError::NotConfigured("x".into())),
            ActivityUnavailable::Unconfigured
        );
        assert!(matches!(
            unavailable(&InsightError::Transport("dns".into())),
            ActivityUnavailable::Unreachable(_)
        ));
        assert!(matches!(
            unavailable(&InsightError::Upstream {
                status: 503,
                body: Value::Null
            }),
            ActivityUnavailable::Unreachable(_)
        ));
        assert!(matches!(
            unavailable(&InsightError::Upstream {
                status: 400,
                body: Value::Null
            }),
            ActivityUnavailable::Failed(_)
        ));
    }
}
