//! studio-mcp: Studio's functions as MCP tools, for the agent a developer
//! already works in (Claude Code, Codex, Cursor).
//!
//! One route, `POST /studio-mcp/v1/messages`, speaks MCP's Streamable HTTP
//! transport in its simplest form: every request is answered with one JSON
//! body, and there is no stream to open (`GET` answers 405, which the
//! transport allows).
//!
//! **Sign-in** is MCP's authorization: the route checks the bearer token
//! itself, through the same resolver as the gateway, so that a request without
//! one is answered 401 with a `WWW-Authenticate` challenge naming this
//! resource's metadata (RFC 9728, `GET /studio-mcp/v1/oauth-protected-resource`).
//! The metadata names Studio's Keycloak realm, where the agent signs its person
//! in. The gateway's own 401 carries no such challenge, which is why the route
//! is not left to it.
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
use authn_resolver_sdk::AuthNResolverClient;
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
    // The pipeline, in the order a project goes through it: its sources and
    // the connections they are read through, the product's description,
    // then where it runs, its builds, and the runs they start.
    all.extend(crate::project_sources::mcp_tools());
    all.extend(crate::connectors::mcp_tools());
    all.extend(crate::product::mcp_tools());
    all.extend(crate::environments::mcp_tools());
    all.extend(crate::artifact_ingest::mcp_tools());
    all.extend(crate::tasks::mcp_tools());
    // The person's inbox: what waits for them across the organization, the
    // marks they keep on it, and the review verdict that answers one kind of
    // item (the others are answered by the pipeline's tools above).
    all.extend(crate::user_profile::mcp_tools());
    all.extend(crate::documents::mcp_tools());
    all
}

/// `gears.studio-mcp.config`. Every setting has a default that works in every
/// profile, and the ones a deployment differs on also read a variable.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct McpConfig {
    /// Where the tools send their requests: this backend's own gateway, with
    /// its prefix. The variable named by `api_url_env` wins.
    pub api_url: String,
    pub api_url_env: String,
    /// The issuer agents sign in at, named in the resource metadata. The
    /// variable named by `authorization_server_env` wins; the default variable
    /// is the one the OIDC plugin already trusts.
    pub authorization_server: String,
    pub authorization_server_env: String,
    /// How the endpoint is reached from outside (`https://host/cf`), for the
    /// metadata and the challenge. Empty: read from the request's forwarded
    /// host and scheme.
    pub public_url: String,
    pub public_url_env: String,
    /// `spec_check` calls one person may make in an hour; 0 for no limit.
    pub spec_checks_per_hour: u32,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            // The gateway as every profile binds it (port 8090, prefix `/cf`).
            api_url: "http://127.0.0.1:8090/cf".to_owned(),
            api_url_env: "STUDIO_MCP_API_URL".to_owned(),
            authorization_server: String::new(),
            authorization_server_env: "STUDIO_OIDC_ISSUER".to_owned(),
            public_url: String::new(),
            public_url_env: "STUDIO_MCP_PUBLIC_URL".to_owned(),
            spec_checks_per_hour: 60,
        }
    }
}

/// The variable when it is set and not blank, the configured value otherwise,
/// without a trailing slash.
fn resolve(value: &str, env: &str) -> String {
    std::env::var(env)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| value.to_owned())
        .trim_end_matches('/')
        .to_owned()
}

impl McpConfig {
    fn resolve_api_url(&self) -> String {
        resolve(&self.api_url, &self.api_url_env)
    }
}

/// What the routes need.
pub(crate) struct McpState {
    pub tools: Vec<sdk::Tool>,
    pub client: reqwest::Client,
    pub api_url: String,
    /// The issuer, or empty when none is known: the metadata then names none
    /// and an agent can only be given a token by hand.
    pub authorization_server: String,
    /// Empty: taken from each request.
    pub public_url: String,
    pub authn: Arc<dyn AuthNResolverClient>,
    pub limits: Arc<sdk::Limits>,
}

#[toolkit::gear(
    name = "studio-mcp",
    deps = [authn_resolver],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct McpGear {
    state: OnceLock<Arc<McpState>>,
}

#[async_trait]
impl Gear for McpGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: McpConfig = ctx.config_or_default()?;
        // Without the resolver nobody can be signed in, so the gear fails the
        // boot rather than answering 500s.
        let authn = ctx.client_hub().get::<dyn AuthNResolverClient>()?;
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
            authorization_server: resolve(&cfg.authorization_server, &cfg.authorization_server_env),
            public_url: resolve(&cfg.public_url, &cfg.public_url_env),
            authn,
            limits: Arc::new(sdk::Limits::new([("spec_check", cfg.spec_checks_per_hour)])),
        });
        tracing::info!(
            api_url = %state.api_url,
            authorization_server = %state.authorization_server,
            tools = state.tools.len(),
            "studio-mcp: serving"
        );
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
            // A change to what Studio holds is new enough to be allowed to move.
            if t.effect != sdk::Effect::Read {
                assert!(
                    t.experimental,
                    "{} writes and is not marked experimental",
                    t.name
                );
            }
        }
    }

    #[test]
    fn every_required_argument_is_a_declared_property() {
        for t in tools() {
            let schema = (t.input_schema)();
            let properties = schema["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("{} has no properties", t.name));
            for name in schema["required"].as_array().into_iter().flatten() {
                let name = name.as_str().unwrap_or_default();
                assert!(
                    properties.contains_key(name),
                    "{} requires `{name}`, which it does not declare",
                    t.name
                );
            }
            for (name, p) in properties {
                assert!(p.is_object(), "{}: `{name}` is not a schema", t.name);
            }
        }
    }

    #[test]
    fn every_pipeline_step_has_its_tools() {
        let names: BTreeSet<&str> = tools().iter().map(|t| t.name).collect();
        for step in [
            "project_sources",
            "project_sources_set",
            "project_connections",
            "product_description",
            "product_description_save",
            "product_description_check",
            "infra_services_set",
            "infra_plan",
            "infra_service_public_url_set",
            "config_secret_keys",
            "config_secret_set",
            "config_secret_delete",
            "image_import",
            "build_plan",
            "build_start",
            "build_get",
            "build_wait",
            "deploy_request",
            "deployment_get",
            "deployment_wait",
            "deployment_decide",
            "deployment_status",
        ] {
            assert!(names.contains(step), "no tool {step}");
        }
    }

    #[test]
    fn the_inbox_can_be_read_and_acted_on() {
        let names: BTreeSet<&str> = tools().iter().map(|t| t.name).collect();
        for tool in [
            "inbox",
            "inbox_mark",
            "deployment_decide",
            "review_verdict",
            "task_run",
        ] {
            assert!(names.contains(tool), "no tool {tool}");
        }
    }

    #[test]
    fn the_api_url_comes_from_the_variable_when_it_is_set() {
        let cfg = McpConfig {
            api_url_env: "STUDIO_MCP_API_URL_TEST".to_owned(),
            ..McpConfig::default()
        };
        assert_eq!(cfg.spec_checks_per_hour, 60);
        assert_eq!(cfg.authorization_server_env, "STUDIO_OIDC_ISSUER");
        assert_eq!(cfg.resolve_api_url(), "http://127.0.0.1:8090/cf");
        let from_env =
            crate::test_env::with_var("STUDIO_MCP_API_URL_TEST", "http://backend:9000/cf/", || {
                cfg.resolve_api_url()
            });
        assert_eq!(from_env, "http://backend:9000/cf");
    }
}
