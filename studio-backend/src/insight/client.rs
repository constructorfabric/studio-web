//! The Insight integration seam.
//!
//! [`InsightClient`] is the contract every consumer uses — the REST surface in
//! this gear, and (published to the ClientHub) any other gear that needs to
//! reach Insight in-process.
//!
//! # What Insight actually exposes
//!
//! Insight's analytics surface is a *read-only SQL* endpoint over its
//! ClickHouse warehouse:
//!
//! ```text
//! POST {base}/api/sql/query
//! Authorization: Bearer <instance token>
//! {"sql": "SELECT …"}
//!
//! 200 {"columns":[{"name":"1","type":"UInt8"}],"rows":[{"1":1}],
//!      "row_count":1,"truncated":false}
//! ```
//!
//! It accepts a **single `SELECT` or `WITH` statement** and nothing else — a
//! `SHOW TABLES`, a second statement or any write is refused with a 400
//! carrying a canonical `invalid_argument` problem document. Schema discovery
//! therefore goes through ClickHouse's own catalog (`system.tables`,
//! `system.columns`) rather than a dedicated endpoint; the warehouse is layered
//! `bronze_* → staging → silver → insight`, and the `insight` database holds
//! the gold views (`exec_summary`, `people`, `ic_kpis`, `commits_daily`, …).
//!
//! [`InsightClient::query`] is that endpoint, typed. [`InsightClient::pull`]
//! and [`InsightClient::push`] stay as the generic escape hatch for resources
//! Insight adds later, so a new endpoint needs no new trait method.

use async_trait::async_trait;
use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What can go wrong on the way to Insight. Split by *who* is at fault, so the
/// REST surface can answer 400 for a rejected query and 5xx for our own wiring
/// instead of flattening every failure into one opaque 500.
#[derive(Debug)]
pub enum InsightError {
    /// The deployment never wired the upstream (no base URL, or no key).
    NotConfigured(String),
    /// The request never got an answer — DNS, TLS, timeout.
    Transport(String),
    /// Insight answered with a non-2xx. `body` is its problem document (or
    /// `null` when the body was empty or not JSON).
    Upstream { status: u16, body: Value },
}

impl InsightError {
    /// True when Insight blamed the request itself (a malformed or rejected SQL
    /// statement), as opposed to our credentials or its own state.
    pub fn is_caller_error(&self) -> bool {
        matches!(
            self,
            Self::Upstream {
                status: 400 | 422,
                ..
            }
        )
    }

    /// The upstream `detail` (plus its field violations) when the body is a
    /// canonical problem document — far more useful than the whole envelope.
    fn upstream_detail(body: &Value) -> Option<String> {
        let detail = body.get("detail")?.as_str()?;
        let violations = body
            .get("context")
            .and_then(|c| c.get("field_violations"))
            .and_then(Value::as_array)
            .map(|vs| {
                vs.iter()
                    .filter_map(|v| v.get("description").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .filter(|s| !s.is_empty());
        Some(match violations {
            Some(v) => format!("{detail}: {v}"),
            None => detail.to_string(),
        })
    }
}

impl std::fmt::Display for InsightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured(msg) => write!(f, "{msg}"),
            Self::Transport(msg) => write!(f, "insight is unreachable: {msg}"),
            Self::Upstream { status, body } => match Self::upstream_detail(body) {
                Some(detail) => write!(f, "insight answered {status}: {detail}"),
                None => write!(f, "insight answered {status}: {body}"),
            },
        }
    }
}

impl std::error::Error for InsightError {}

pub type Result<T> = std::result::Result<T, InsightError>;

/// One column of a [`SqlPage`], as Insight describes it (ClickHouse type names:
/// `String`, `UInt64`, `Nullable(DateTime)`, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlColumn {
    pub name: String,
    /// ClickHouse type name. Called `data_type` here because `type` is a
    /// keyword; the wire name stays `type`.
    #[serde(rename = "type")]
    pub data_type: String,
}

/// The result of one SQL query. `rows` are JSON objects keyed by column name,
/// passed through exactly as Insight returned them — a warehouse row has no
/// shape this gear could usefully impose on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlPage {
    #[serde(default)]
    pub columns: Vec<SqlColumn>,
    #[serde(default)]
    pub rows: Vec<Value>,
    #[serde(default)]
    pub row_count: u64,
    /// True when Insight capped the result set — the answer is a prefix, not
    /// the whole story, and a caller aggregating it would be wrong to ignore it.
    #[serde(default)]
    pub truncated: bool,
}

/// The seam to Constructor Insight.
#[async_trait]
pub trait InsightClient: Send + Sync + 'static {
    /// Run one read-only SQL statement against Insight's warehouse.
    ///
    /// `sql` must be a single `SELECT` or `WITH`; Insight refuses anything else,
    /// and that refusal arrives as [`InsightError::Upstream`] with status 400.
    async fn query(&self, sql: &str) -> Result<SqlPage>;

    /// GET `{base}{api_path}/{resource}` with query params — the generic escape
    /// hatch for Insight resources that are not the SQL endpoint.
    async fn pull(&self, resource: &str, params: &[(String, String)]) -> Result<Value>;

    /// POST `{base}{api_path}/{resource}` with a JSON body.
    async fn push(&self, resource: &str, payload: Value) -> Result<Value>;

    /// Whether a base URL and key are configured (a call otherwise errors).
    fn is_configured(&self) -> bool;

    /// The resolved base URL (empty when unconfigured), for a health probe.
    fn base_url(&self) -> &str;
}

/// HTTP client over Insight's REST API, holding the server-side instance token.
pub struct HttpInsightClient {
    client: reqwest::Client,
    base_url: String,
    api_path: String,
    sql_resource: String,
    api_key: Option<String>,
}

impl HttpInsightClient {
    pub fn new(
        client: reqwest::Client,
        base_url: String,
        api_path: String,
        sql_resource: String,
        api_key: Option<String>,
    ) -> Self {
        Self {
            client,
            base_url,
            api_path,
            sql_resource,
            api_key,
        }
    }

    fn url(&self, resource: &str) -> String {
        format!(
            "{}{}/{}",
            self.base_url,
            self.api_path,
            resource.trim_start_matches('/')
        )
    }

    fn auth(&self, rb: RequestBuilder) -> RequestBuilder {
        match &self.api_key {
            Some(key) => rb.bearer_auth(key),
            None => rb,
        }
    }

    /// Insight authenticates every call with the instance token, so a missing
    /// key is as fatal as a missing host — refuse before the round trip rather
    /// than let it come back as an opaque 401.
    fn ensure_configured(&self) -> Result<()> {
        if self.base_url.is_empty() || self.api_key.is_none() {
            return Err(InsightError::NotConfigured(
                "insight integration is not configured (set STUDIO_INSIGHT_BASE_URL / \
                 STUDIO_INSIGHT_API_KEY, or the YAML equivalents, and restart)"
                    .into(),
            ));
        }
        Ok(())
    }

    /// Read the response body as JSON (or `null` if empty/non-JSON) and turn a
    /// non-2xx into an [`InsightError::Upstream`] carrying both.
    async fn finish(res: reqwest::Response) -> Result<Value> {
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            Err(InsightError::Upstream {
                status: status.as_u16(),
                body,
            })
        }
    }

    async fn send(&self, rb: RequestBuilder) -> Result<Value> {
        let res = self
            .auth(rb)
            .send()
            .await
            .map_err(|e| InsightError::Transport(e.to_string()))?;
        Self::finish(res).await
    }
}

#[async_trait]
impl InsightClient for HttpInsightClient {
    async fn query(&self, sql: &str) -> Result<SqlPage> {
        self.ensure_configured()?;
        let sql = sql.trim();
        if sql.is_empty() {
            return Err(InsightError::Upstream {
                status: 400,
                body: serde_json::json!({ "detail": "sql is empty" }),
            });
        }
        let url = self.url(&self.sql_resource);
        let body = self
            .send(
                self.client
                    .post(url)
                    .json(&serde_json::json!({ "sql": sql })),
            )
            .await?;
        serde_json::from_value(body.clone()).map_err(|e| InsightError::Upstream {
            status: 502,
            body: serde_json::json!({
                "detail": format!("insight returned a body this gear cannot read: {e}"),
                "context": { "body": body },
            }),
        })
    }

    async fn pull(&self, resource: &str, params: &[(String, String)]) -> Result<Value> {
        self.ensure_configured()?;
        self.send(self.client.get(self.url(resource)).query(params))
            .await
    }

    async fn push(&self, resource: &str, payload: Value) -> Result<Value> {
        self.ensure_configured()?;
        self.send(self.client.post(self.url(resource)).json(&payload))
            .await
    }

    fn is_configured(&self) -> bool {
        !self.base_url.is_empty() && self.api_key.is_some()
    }

    fn base_url(&self) -> &str {
        &self.base_url
    }
}

#[cfg(test)]
mod tests {
    //! Where a call to Insight lands, what happens when there is nowhere to
    //! send it, and how its answers read on the way back.

    use super::*;
    use serde_json::json;

    fn client(base_url: &str) -> HttpInsightClient {
        configured(base_url, Some("key"))
    }

    fn configured(base_url: &str, key: Option<&str>) -> HttpInsightClient {
        HttpInsightClient::new(
            reqwest::Client::new(),
            base_url.to_string(),
            "/api".to_string(),
            "sql/query".to_string(),
            key.map(str::to_string),
        )
    }

    #[test]
    fn a_resource_is_appended_under_the_api_path() {
        let client = client("https://insight.example");
        assert_eq!(client.url("reports"), "https://insight.example/api/reports");
    }

    /// The endpoint this seam exists for. Its two halves come from config, and
    /// the join has to land on the path Insight actually serves.
    #[test]
    fn the_sql_endpoint_lands_where_insight_serves_it() {
        assert_eq!(
            client("https://insight.cfabric.org").url("sql/query"),
            "https://insight.cfabric.org/api/sql/query"
        );
    }

    /// Callers write the resource both ways, and both mean the same thing. The
    /// leading slash is stripped rather than trusted, because the path already
    /// ends without one and the two would otherwise make `//reports`.
    #[test]
    fn a_leading_slash_on_the_resource_makes_no_difference() {
        let client = client("https://insight.example");
        assert_eq!(client.url("/reports"), client.url("reports"));
        assert!(!client.url("/reports").contains("api//"));
    }

    #[test]
    fn a_nested_resource_keeps_its_own_slashes() {
        assert_eq!(
            client("https://insight.example").url("reports/2026/summary"),
            "https://insight.example/api/reports/2026/summary"
        );
    }

    /// Unconfigured is a valid state for this seam: the gear loads, and a call
    /// says what to set instead of sending a request to `/api/sql/query` with
    /// no host in front of it.
    #[test]
    fn an_unconfigured_client_reports_itself_and_refuses() {
        let unconfigured = client("");
        assert!(!unconfigured.is_configured());

        let refusal = unconfigured
            .ensure_configured()
            .expect_err("an unconfigured client must refuse")
            .to_string();
        assert!(
            refusal.contains("STUDIO_INSIGHT_BASE_URL"),
            "the refusal must name the variable to set, got: {refusal}"
        );

        assert!(client("https://insight.example").is_configured());
    }

    /// A host without a key is as unusable as no host: Insight authenticates
    /// every call with the instance token, so the round trip would come back
    /// 401 `INVALID_INSTANCE_TOKEN` — a worse message than this one.
    #[tokio::test]
    async fn a_missing_key_is_refused_before_the_round_trip() {
        let no_key = configured("https://insight.cfabric.org", None);
        assert!(!no_key.is_configured());

        let err = no_key.query("SELECT 1").await.expect_err("no key");
        assert!(matches!(err, InsightError::NotConfigured(_)), "{err}");
        assert!(!err.is_caller_error());
    }

    #[test]
    fn the_base_url_is_reported_as_configured() {
        assert_eq!(
            client("https://insight.example").base_url(),
            "https://insight.example"
        );
    }

    #[tokio::test]
    async fn empty_sql_is_the_callers_error() {
        let err = client("https://insight.cfabric.org")
            .query("   ")
            .await
            .expect_err("empty sql");
        assert!(err.is_caller_error(), "{err}");
    }

    /// Insight's refusals are canonical problem documents. Flattening one into
    /// its envelope loses the sentence that says what was wrong with the query.
    #[test]
    fn an_upstream_rejection_reads_as_the_message_insight_wrote() {
        // Verbatim shape of what `POST /api/sql/query` answers for `SHOW TABLES`.
        let err = InsightError::Upstream {
            status: 400,
            body: json!({
                "title": "Invalid Argument",
                "status": 400,
                "detail": "Request validation failed",
                "context": { "field_violations": [
                    { "field": "sql", "reason": "INVALID",
                      "description": "query must be a single SELECT or WITH statement" }
                ]},
            }),
        };
        assert!(err.is_caller_error());
        assert_eq!(
            err.to_string(),
            "insight answered 400: Request validation failed: \
             query must be a single SELECT or WITH statement"
        );
    }

    /// A 401 is ours, not the caller's: the key we hold was refused.
    #[test]
    fn an_authentication_failure_is_not_blamed_on_the_caller() {
        let err = InsightError::Upstream {
            status: 401,
            body: json!({ "detail": "Authentication required" }),
        };
        assert!(!err.is_caller_error());
        assert_eq!(
            err.to_string(),
            "insight answered 401: Authentication required"
        );
    }

    #[test]
    fn a_sql_page_deserialises_from_insights_wire_shape() {
        let page: SqlPage = serde_json::from_value(json!({
            "columns": [{ "name": "1", "type": "UInt8" }],
            "row_count": 1,
            "rows": [{ "1": 1 }],
            "truncated": false,
        }))
        .expect("wire shape");
        assert_eq!(page.columns[0].data_type, "UInt8");
        assert_eq!(page.row_count, 1);
        assert!(!page.truncated);
    }
}
