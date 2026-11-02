//! The MCP endpoint and the metadata an agent signs in with.
//!
//! `POST /studio-mcp/v1/messages`: MCP's Streamable HTTP endpoint.
//! `GET /studio-mcp/v1/oauth-protected-resource`: what that endpoint is and
//! where to sign in for it (RFC 9728), as MCP's authorization asks.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::{OpenApiRegistry, OperationBuilder};

use super::McpState;
use super::protocol;
use super::sdk::Api;

/// One JSON-RPC 2.0 answer, as MCP defines it. A batch is answered with a list
/// of these. `result` and `error` are the method's own shapes (the MCP schema),
/// so they are not restated here.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct JsonRpcResponseDto {
    /// Always `2.0`.
    pub jsonrpc: String,
    /// The id of the request this answers: a string or a number.
    #[schema(value_type = Object)]
    pub id: serde_json::Value,
    /// What the method answered, when it succeeded.
    #[schema(value_type = Option<Object>)]
    pub result: Option<serde_json::Value>,
    /// `{code, message}`, when it did not.
    #[schema(value_type = Option<Object>)]
    pub error: Option<serde_json::Value>,
}

/// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProtectedResourceDto {
    /// The MCP endpoint, as reached from outside.
    pub resource: String,
    /// The issuer to sign in at: Studio's Keycloak realm. Absent when this
    /// deployment names none; a token is then given by hand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_servers: Option<Vec<String>>,
    /// Always `header`: the token goes in `Authorization: Bearer`.
    pub bearer_methods_supported: Vec<String>,
    pub scopes_supported: Vec<String>,
    pub resource_name: String,
}

/// A spec check carries whole documents.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

const MESSAGES: &str = "/studio-mcp/v1/messages";
const METADATA: &str = "/studio-mcp/v1/oauth-protected-resource";

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    state: Arc<McpState>,
) -> Router {
    // `.anonymous().exposed()`: the gateway's 401 carries no challenge, and
    // without one an agent cannot find where to sign in. `send_message`
    // authenticates every request itself, through the same resolver.
    let router = OperationBuilder::post("/studio-mcp/v1/messages")
        .operation_id("studio_mcp.send_message")
        .summary("Send an MCP message: the handshake, the tool list or a tool call")
        .description(
            "MCP's Streamable HTTP endpoint (protocol 2025-06-18, also 2025-03-26 and \
             2024-11-05), for an agent such as Claude Code or Codex rather than for the \
             portal. The body is one JSON-RPC 2.0 message, or a batch of them; the answer is \
             one JSON body, never a stream, and a body of notifications only is answered \
             202 with nothing. Methods: `initialize`, `ping`, `tools/list`, `tools/call`. \
             Takes the caller's Studio bearer token; without a valid one it answers 401 with \
             `WWW-Authenticate: Bearer resource_metadata=...`, which is how an agent finds \
             where to sign in. A tool calls Studio's REST API with that token, so it may do \
             exactly what the caller may do in the portal. Usage: docs/mcp.md.",
        )
        .tag("StudioMcp")
        .anonymous()
        .exposed()
        .handler(send_message)
        .json_response_with_schema::<JsonRpcResponseDto>(
            openapi,
            StatusCode::OK,
            "The JSON-RPC answer",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-mcp/v1/oauth-protected-resource")
        .operation_id("studio_mcp.get_protected_resource")
        .summary("Where an agent signs in for the MCP endpoint (RFC 9728)")
        .description(
            "OAuth 2.0 Protected Resource Metadata for `POST /studio-mcp/v1/messages`: \
             the endpoint as reached from outside and the issuer to sign in at, Studio's \
             Keycloak realm. An MCP client reads it from the `resource_metadata` of the \
             endpoint's 401 challenge, then discovers the issuer and signs its person in. \
             Public: it says nothing a sign-in page does not.",
        )
        .tag("StudioMcp")
        .anonymous()
        .exposed()
        .handler(protected_resource)
        .json_response_with_schema::<ProtectedResourceDto>(openapi, StatusCode::OK, "The metadata")
        .error_500(openapi)
        .register(router, openapi);

    router
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(Extension(state))
}

async fn send_message(
    Extension(state): Extension<Arc<McpState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let base = public_base(&state, &headers);
    let Some(auth) = headers.get(header::AUTHORIZATION).cloned() else {
        return challenge(&base, None);
    };
    let Some(token) = bearer(&auth) else {
        return challenge(
            &base,
            Some("send the token as Authorization: Bearer <token>"),
        );
    };
    let ctx = match state.authn.authenticate(&token).await {
        Ok(result) => result.security_context,
        Err(error) => {
            tracing::debug!(%error, "studio-mcp: token refused");
            return challenge(&base, Some("the token is not valid; sign in again"));
        }
    };
    // The tools carry the same header on, so every request they make is
    // checked again as the caller, by the route it reaches.
    let api = Api::new(state.client.clone(), &state.api_url, Some(auth))
        .acting_for(ctx.subject_id().to_string(), Arc::clone(&state.limits));
    match protocol::handle_body(&body, &state.tools, &api).await {
        Some(answer) => Json(answer).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// The token of an `Authorization: Bearer` header.
fn bearer(auth: &HeaderValue) -> Option<String> {
    let value = auth.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_owned())
}

async fn protected_resource(
    Extension(state): Extension<Arc<McpState>>,
    headers: HeaderMap,
) -> Json<ProtectedResourceDto> {
    Json(metadata(
        &public_base(&state, &headers),
        &state.authorization_server,
    ))
}

fn metadata(base: &str, issuer: &str) -> ProtectedResourceDto {
    ProtectedResourceDto {
        resource: format!("{base}{MESSAGES}"),
        // Absent rather than empty: RFC 9728 makes it optional, and an empty
        // list could read as "no server will do".
        authorization_servers: (!issuer.is_empty()).then(|| vec![issuer.to_owned()]),
        bearer_methods_supported: vec!["header".to_owned()],
        scopes_supported: vec![
            "openid".to_owned(),
            "profile".to_owned(),
            "email".to_owned(),
        ],
        resource_name: "Constructor Studio".to_owned(),
    }
}

/// 401 with the challenge MCP clients follow to the metadata.
fn challenge(base: &str, error: Option<&str>) -> Response {
    let mut value = format!("Bearer resource_metadata=\"{base}{METADATA}\"");
    if let Some(why) = error {
        value.push_str(&format!(
            ", error=\"invalid_token\", error_description=\"{why}\""
        ));
    }
    let mut response = Response::new(Body::from(
        "Sign in to Constructor Studio: this endpoint takes your Studio token. See docs/mcp.md.\n",
    ));
    *response.status_mut() = StatusCode::UNAUTHORIZED;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&value) {
        response.headers_mut().insert(header::WWW_AUTHENTICATE, v);
    }
    response
}

/// `https://host/cf`: the configured public URL, or the one the request came
/// in on (the ingress's forwarded scheme and host, with the gateway's prefix).
fn public_base(state: &McpState, headers: &HeaderMap) -> String {
    if !state.public_url.is_empty() {
        return state.public_url.clone();
    }
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let host = header("x-forwarded-host")
        .or_else(|| header("host"))
        .unwrap_or("localhost");
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    format!("{scheme}://{host}{}", prefix(&state.api_url))
}

/// The gateway's prefix, as the path of `api_url` (`/cf`).
fn prefix(api_url: &str) -> &str {
    let after_scheme = api_url.split_once("://").map_or(api_url, |(_, rest)| rest);
    after_scheme
        .find('/')
        .map_or("", |at| &after_scheme[at..])
        .trim_end_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prefix_is_the_path_of_the_api_url() {
        assert_eq!(prefix("http://127.0.0.1:8090/cf"), "/cf");
        assert_eq!(prefix("http://127.0.0.1:8090/cf/"), "/cf");
        assert_eq!(prefix("http://127.0.0.1:8090"), "");
    }

    #[test]
    fn only_a_bearer_token_is_taken() {
        let h = |v: &str| HeaderValue::from_str(v).unwrap();
        assert_eq!(bearer(&h("Bearer abc")).as_deref(), Some("abc"));
        assert_eq!(bearer(&h("bearer  abc ")).as_deref(), Some("abc"));
        assert_eq!(bearer(&h("Basic abc")), None);
        assert_eq!(bearer(&h("Bearer ")), None);
    }

    #[test]
    fn the_metadata_names_the_endpoint_and_the_issuer_when_there_is_one() {
        let doc = metadata(
            "https://studio-dev.cfabric.org/cf",
            "https://studio-dev.cfabric.org/auth/realms/studio",
        );
        assert_eq!(
            doc.resource,
            "https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages"
        );
        assert_eq!(
            doc.authorization_servers,
            Some(vec![
                "https://studio-dev.cfabric.org/auth/realms/studio".to_owned()
            ])
        );
        assert_eq!(metadata("http://x/cf", "").authorization_servers, None);
    }

    #[test]
    fn the_challenge_points_at_the_metadata() {
        let r = challenge("https://h/cf", None);
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            r.headers()[header::WWW_AUTHENTICATE],
            "Bearer resource_metadata=\"https://h/cf/studio-mcp/v1/oauth-protected-resource\""
        );
        let bad = challenge("https://h/cf", Some("expired"));
        assert!(
            bad.headers()[header::WWW_AUTHENTICATE]
                .to_str()
                .unwrap()
                .contains("error=\"invalid_token\"")
        );
    }
}
