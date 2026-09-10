//! The Insight integration seam.
//!
//! [`InsightClient`] is the contract every consumer uses — the REST surface in
//! this gear, and (published to the ClientHub) any other gear that needs to
//! reach Insight in-process. Two scenarios, deliberately generic while Insight
//! finalizes the contract for us: **pull** a resource (GET) and **push** a
//! resource (POST). Typed methods (metrics / events / identity) can be added on
//! top of the same client once their shapes are pinned.

use async_trait::async_trait;
use reqwest::RequestBuilder;
use serde_json::Value;

/// The seam to Constructor Insight. Generic on purpose: `resource` is appended
/// to the configured `{base_url}{api_path}`, so callers name the endpoint
/// (`"metrics/cycle_time"`, `"events"`, …) without this gear hard-coding one.
#[async_trait]
pub trait InsightClient: Send + Sync + 'static {
    /// GET `{base}{api_path}/{resource}` with query params — read data *from*
    /// Insight (analytics, metrics, identity resolution).
    async fn pull(&self, resource: &str, params: &[(String, String)]) -> anyhow::Result<Value>;

    /// POST `{base}{api_path}/{resource}` with a JSON body — save data *to*
    /// Insight (events, records the platform contributes).
    async fn push(&self, resource: &str, payload: Value) -> anyhow::Result<Value>;

    /// Whether a base URL and key are configured (a call otherwise errors).
    fn is_configured(&self) -> bool;

    /// The resolved base URL (empty when unconfigured), for a health probe.
    fn base_url(&self) -> &str;
}

/// HTTP client over Insight's REST API, holding the server-side key.
pub struct HttpInsightClient {
    client: reqwest::Client,
    base_url: String,
    api_path: String,
    api_key: Option<String>,
}

impl HttpInsightClient {
    pub fn new(
        client: reqwest::Client,
        base_url: String,
        api_path: String,
        api_key: Option<String>,
    ) -> Self {
        Self {
            client,
            base_url,
            api_path,
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

    fn ensure_configured(&self) -> anyhow::Result<()> {
        if self.base_url.is_empty() {
            anyhow::bail!(
                "insight integration is not configured (set STUDIO_INSIGHT_BASE_URL / \
                 STUDIO_INSIGHT_API_KEY, or the YAML equivalents)"
            );
        }
        Ok(())
    }

    /// Read the response body as JSON (or `{}` if empty/non-JSON) and turn a
    /// non-2xx into an error carrying the status and body.
    async fn finish(op: &str, resource: &str, res: reqwest::Response) -> anyhow::Result<Value> {
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            anyhow::bail!("insight {op} `{resource}` -> {status}: {body}")
        }
    }
}

#[async_trait]
impl InsightClient for HttpInsightClient {
    async fn pull(&self, resource: &str, params: &[(String, String)]) -> anyhow::Result<Value> {
        self.ensure_configured()?;
        let req = self.auth(self.client.get(self.url(resource)).query(params));
        let res = req
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("insight pull `{resource}`: {e}"))?;
        Self::finish("pull", resource, res).await
    }

    async fn push(&self, resource: &str, payload: Value) -> anyhow::Result<Value> {
        self.ensure_configured()?;
        let req = self.auth(self.client.post(self.url(resource)).json(&payload));
        let res = req
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("insight push `{resource}`: {e}"))?;
        Self::finish("push", resource, res).await
    }

    fn is_configured(&self) -> bool {
        !self.base_url.is_empty() && self.api_key.is_some()
    }

    fn base_url(&self) -> &str {
        &self.base_url
    }
}
