//! Bridge service: resolves a session and performs studio→Theia control calls.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;

use crate::studio_theia::commands::DesktopCommandRelay;
use crate::studio_theia::config::StudioTheiaConfig;
use crate::studio_theia::discovery::{
    ControlTokenResolver, DesktopSessionResolver, TheiaEndpointResolver,
};
use crate::studio_theia::sdk::{SessionTarget, TheiaControlError};
use crate::studio_theia::sink::TheiaEventSink;

/// Owns the HTTP client + endpoint resolver and performs the raw control calls.
pub struct TheiaService {
    config: StudioTheiaConfig,
    http: reqwest::Client,
    resolver: Arc<dyn TheiaEndpointResolver>,
    token_resolver: Arc<dyn ControlTokenResolver>,
    sink: Arc<dyn TheiaEventSink>,
    desktops: Arc<dyn DesktopSessionResolver>,
    commands: Arc<dyn DesktopCommandRelay>,
}

/// How a desktop session is reached (ADR-0027 phases 4 and 5): who holds it,
/// and the channel its commands go out on.
pub struct DesktopBridge {
    pub sessions: Arc<dyn DesktopSessionResolver>,
    pub commands: Arc<dyn DesktopCommandRelay>,
}

impl TheiaService {
    pub fn new(
        config: StudioTheiaConfig,
        resolver: Arc<dyn TheiaEndpointResolver>,
        token_resolver: Arc<dyn ControlTokenResolver>,
        sink: Arc<dyn TheiaEventSink>,
        desktop: DesktopBridge,
    ) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.request_timeout_secs))
            .build()?;
        Ok(Self {
            config,
            http,
            resolver,
            token_resolver,
            sink,
            desktops: desktop.sessions,
            commands: desktop.commands,
        })
    }

    // Retained for the disabled-gear 503 path and future ingress policy.
    #[allow(dead_code)]
    pub fn config(&self) -> &StudioTheiaConfig {
        &self.config
    }

    pub fn sink(&self) -> &Arc<dyn TheiaEventSink> {
        &self.sink
    }

    pub fn token_resolver(&self) -> &Arc<dyn ControlTokenResolver> {
        &self.token_resolver
    }

    pub fn desktops(&self) -> &Arc<dyn DesktopSessionResolver> {
        &self.desktops
    }

    pub fn commands(&self) -> &Arc<dyn DesktopCommandRelay> {
        &self.commands
    }

    /// POST `{base}/internal/theia/v1/{method}` under the resolved session
    /// endpoint, with the S2S token header, and decode the JSON response.
    pub async fn call<Req, Resp>(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        method: &str,
        body: &Req,
    ) -> Result<Resp, TheiaControlError>
    where
        Req: Serialize,
        Resp: DeserializeOwned,
    {
        let endpoint = self.resolver.resolve(ctx, target).await?;
        let url = format!("{}/internal/theia/v1/{method}", endpoint.base_url);
        let response = self
            .http
            .post(&url)
            .header("X-CFS-Theia-Token", &endpoint.token)
            .json(body)
            .send()
            .await
            .map_err(|e| upstream_error(method, e))?;
        if !response.status().is_success() {
            let status = response.status();
            let upstream_detail = response
                .text()
                .await
                .ok()
                .and_then(|body| extract_upstream_detail(&body));
            let detail = upstream_detail.map_or_else(
                || format!("Theia control '{method}' returned HTTP {status}"),
                |message| format!("Theia control '{method}' returned HTTP {status}: {message}"),
            );
            return Err(CanonicalError::service_unavailable()
                .with_detail(detail)
                .create());
        }
        response
            .json::<Resp>()
            .await
            .map_err(|e| upstream_error(method, e))
    }
}

fn extract_upstream_detail(body: &str) -> Option<String> {
    const MAX_DETAIL_CHARS: usize = 2_048;
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    let raw = parsed
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(body)
        .trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.chars().take(MAX_DETAIL_CHARS).collect())
}

fn upstream_error(method: &str, e: reqwest::Error) -> TheiaControlError {
    CanonicalError::service_unavailable()
        .with_detail(format!("Theia control '{method}' failed: {e}"))
        .create()
}

#[cfg(test)]
mod tests {
    use super::extract_upstream_detail;

    #[test]
    fn extracts_structured_theia_error() {
        assert_eq!(
            extract_upstream_detail(r#"{"error":"No registered repository"}"#).as_deref(),
            Some("No registered repository")
        );
    }

    #[test]
    fn truncates_unstructured_upstream_body() {
        let body = "x".repeat(3_000);
        assert_eq!(
            extract_upstream_detail(&body).unwrap().chars().count(),
            2_048
        );
    }
}
