//! `POST /studio-mcp/v1/messages`: MCP's Streamable HTTP endpoint.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;

use super::McpState;
use super::protocol;
use super::sdk::Api;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

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

/// A spec check carries whole documents.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    state: Arc<McpState>,
) -> Router {
    let router = OperationBuilder::post("/studio-mcp/v1/messages")
        .operation_id("studio_mcp.send_message")
        .summary("Send an MCP message: the handshake, the tool list or a tool call")
        .description(
            "MCP's Streamable HTTP endpoint (protocol 2025-06-18, also 2025-03-26 and \
             2024-11-05), for an agent such as Claude Code or Codex rather than for the \
             portal. The body is one JSON-RPC 2.0 message, or a batch of them; the answer is \
             one JSON body, never a stream, and a body of notifications only is answered \
             202 with nothing. Methods: `initialize`, `ping`, `tools/list`, `tools/call`. \
             A tool calls Studio's REST API with the caller's own token, so it may do \
             exactly what the caller may do in the portal; what each tool does is in its \
             description in `tools/list`. Usage: docs/mcp.md.",
        )
        .tag("StudioMcp")
        .authenticated()
        .require_license_features::<License>([])
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
    router
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(Extension(state))
}

async fn send_message(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<McpState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // The gateway has already authenticated this header; the tools carry it
    // on unchanged, so every request they make is checked again as the caller.
    let api = Api::new(
        state.client.clone(),
        &state.api_url,
        headers.get(header::AUTHORIZATION).cloned(),
    );
    match protocol::handle_body(&body, &state.tools, &api).await {
        Some(answer) => Json(answer).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}
