//! studio-mcp: Studio's functions as MCP tools, for the agent a developer
//! already works in (Claude Code, Codex, Cursor).
//!
//! One route, `POST /studio-mcp/v1/messages`, speaks MCP's Streamable HTTP
//! transport in its simplest form: every request is answered with one JSON
//! body, and there is no stream to open (`GET` answers 405, which the
//! transport allows). The caller signs in with their ordinary Studio token.
//!
//! The tools are not written here. The gear that owns the routes a tool uses
//! declares it beside them, in its own `mcp.rs`, so a feature and its tool land
//! in one PR, and an owner changing a route sees the tool that calls it.
//! [`tools`] only collects them.
//!
//! A tool reaches Studio through the REST API, as its caller ([`sdk::Api`]):
//! MCP adds a way in and no rights. Why that, and not in-process calls, is in
//! `sdk`'s docs; how to use the server is `docs/mcp.md`.

mod protocol;
mod rest;
pub mod sdk;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use serde::Deserialize;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};

/// Every tool the server offers, in the order `tools/list` gives them.
pub fn tools() -> Vec<sdk::Tool> {
    let mut all = Vec::new();
    all.extend(crate::domain_model::mcp_tools());
    all.extend(crate::spec_mapping::mcp_tools());
    all.extend(crate::spec_quality::mcp_tools());
    all
}

/// `gears.studio-mcp.config`.
#[derive(Debug, Clone, Deserialize)]
pub struct McpConfig {
    /// Where the tools send their requests: this backend's own gateway, with
    /// its prefix. The variable named by `api_url_env` wins.
    #[serde(default = "default_api_url")]
    pub api_url: String,
    #[serde(default = "default_api_url_env")]
    pub api_url_env: String,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            api_url: default_api_url(),
            api_url_env: default_api_url_env(),
        }
    }
}

/// The gateway as every profile binds it (`bind_addr` port 8090, prefix
/// `/cf`), reached over loopback.
fn default_api_url() -> String {
    "http://127.0.0.1:8090/cf".to_owned()
}

fn default_api_url_env() -> String {
    "STUDIO_MCP_API_URL".to_owned()
}

impl McpConfig {
    fn resolve_api_url(&self) -> String {
        std::env::var(&self.api_url_env)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| self.api_url.clone())
            .trim_end_matches('/')
            .to_owned()
    }
}

/// What the route needs: the tools and a client to call Studio with.
pub(crate) struct McpState {
    pub tools: Vec<sdk::Tool>,
    pub client: reqwest::Client,
    pub api_url: String,
}

#[toolkit::gear(name = "studio-mcp", capabilities = [rest])]
#[derive(Default)]
pub struct McpGear {
    state: OnceLock<Arc<McpState>>,
}

#[async_trait]
impl Gear for McpGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: McpConfig = ctx.config_or_default()?;
        // A tool waits on a spec check for minutes, but each request it makes
        // is a short read or a submit.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .build()?;
        let state = Arc::new(McpState {
            tools: tools(),
            client,
            api_url: cfg.resolve_api_url(),
        });
        tracing::info!(api_url = %state.api_url, tools = state.tools.len(), "studio-mcp: serving");
        self.state
            .set(state)
            .map_err(|_| anyhow::anyhow!("studio-mcp gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for McpGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-mcp not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, state))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn every_tool_has_a_unique_name_a_description_and_an_object_schema() {
        let all = tools();
        assert!(!all.is_empty());
        let mut names = BTreeSet::new();
        for t in &all {
            assert!(names.insert(t.name), "two tools are called {}", t.name);
            assert!(
                t.name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{} is not snake case",
                t.name
            );
            assert!(t.description.len() > 40, "{} says too little", t.name);
            assert_eq!((t.input_schema)()["type"], "object", "{}", t.name);
        }
    }

    #[test]
    fn the_api_url_comes_from_the_variable_when_it_is_set() {
        let cfg = McpConfig {
            api_url_env: "STUDIO_MCP_API_URL_TEST".to_owned(),
            ..McpConfig::default()
        };
        assert_eq!(cfg.resolve_api_url(), "http://127.0.0.1:8090/cf");
        let from_env =
            crate::test_env::with_var("STUDIO_MCP_API_URL_TEST", "http://backend:9000/cf/", || {
                cfg.resolve_api_url()
            });
        assert_eq!(from_env, "http://backend:9000/cf");
    }
}
