use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Shared proxy state: one upstream, one server-held key.
pub struct ProxyState {
    pub client: reqwest::Client,
    pub base_url: String,
    /// None = key not configured; requests fail with a clear message instead
    /// of failing the whole backend boot.
    pub api_key: Option<String>,
    /// Model name advertised to IDE clients (they don't pick — the server
    /// decides which model the proxy serves).
    pub model: String,
    /// Theia ai-openai `developerMessageSettings` value for this provider.
    pub developer_message_settings: String,
}

/// What an IDE needs to self-configure its OpenAI-compatible client against
/// this proxy. Deliberately excludes anything secret — the caller brings its
/// own (user) token; the provider key never leaves the backend.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct LlmClientConfigDto {
    /// Model name to request (proxied upstream model).
    pub model: String,
    /// System-prompt role handling for this provider: user | system |
    /// developer | mergeWithFollowingUserMessage | skip.
    pub developer_message_settings: String,
}

impl ProxyState {
    /// Forward a request to `{base_url}{path}` verbatim and stream the
    /// upstream response back (JSON body or SSE — the proxy doesn't care:
    /// bytes in, bytes out, upstream status and content-type preserved).
    async fn forward(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Bytes>,
    ) -> ApiResult<axum::response::Response> {
        if self.base_url.is_empty() {
            return Err(CanonicalError::internal(
                "no LLM upstream configured (set STUDIO_LLM_BASE_URL / STUDIO_LLM_MODEL / STUDIO_LLM_API_KEY and restart)",
            )
            .create());
        }
        let Some(key) = self.api_key.as_deref() else {
            return Err(CanonicalError::internal(
                "LLM upstream key is not configured (set STUDIO_LLM_API_KEY and restart)",
            )
            .create());
        };

        let mut req = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"));
        if let Some(bytes) = body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes);
        }
        let upstream = req.send().await.map_err(|e| {
            CanonicalError::internal(format!("LLM upstream request failed: {e}")).create()
        })?;

        let mut builder = axum::response::Response::builder().status(upstream.status().as_u16());
        if let Some(ct) = upstream.headers().get(reqwest::header::CONTENT_TYPE) {
            builder = builder.header(axum::http::header::CONTENT_TYPE, ct.as_bytes());
        }
        builder
            .body(Body::from_stream(upstream.bytes_stream()))
            .map_err(|e| {
                CanonicalError::internal(format!("proxy response build failed: {e}")).create()
            })
    }
}

/* ── Handlers ── */

/// POST /studio-llm/v1/chat/completions — the OpenAI chat-completions
/// endpoint Theia AI's `ai-openai` provider targets. Supports `stream: true`
/// (SSE passthrough). Authenticated with the caller's normal Studio token;
/// the upstream key is attached server-side.
async fn chat_completions(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(reqwest::Method::POST, "/chat/completions", Some(body))
        .await
}

/// GET /studio-llm/v1/models — models listing passthrough (some OpenAI
/// clients probe it; harmless to expose).
async fn list_models(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
) -> ApiResult<impl IntoResponse> {
    state.forward(reqwest::Method::GET, "/models", None).await
}

/// GET /studio-llm/v1/client-config — server-decided client settings
/// (model name, prompt-role handling). Keeps provider choice out of the
/// IDE image: the Theia portal bridge reads this and configures ai-openai.
async fn client_config(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
) -> ApiResult<JsonBody<LlmClientConfigDto>> {
    Ok(Json(LlmClientConfigDto {
        model: state.model.clone(),
        developer_message_settings: state.developer_message_settings.clone(),
    }))
}

/* ── Routes ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    state: Arc<ProxyState>,
    providers: Option<Arc<super::providers::Providers>>,
) -> Router {
    if let Some(providers) = providers {
        router = OperationBuilder::post("/studio-llm/v1/providers/{provider}/{*rest}")
            .operation_id("studio_llm.stream_provider_post")
            .summary("An agent's call to its model provider, on the caller's own key")
            .description(
                "Claude Code (Anthropic Messages API) and Codex (OpenAI) are pointed here \
                 with the member's Studio token as their bearer. The call is forwarded to \
                 the provider with the key credstore holds for that member: their own key \
                 from their profile first, else the one shared with the workspace. The \
                 caller's Studio token never reaches the provider; the response streams.",
            )
            .tag("StudioLlm")
            .authenticated()
            .require_license_features::<License>([])
            .handler(super::providers::stream_provider)
            .json_response(
                StatusCode::OK,
                "The provider's answer, passed through (JSON or SSE)",
            )
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);
        router = OperationBuilder::get("/studio-llm/v1/providers/{provider}/{*rest}")
            .operation_id("studio_llm.stream_provider_get")
            .summary("A read from the caller's model provider, on the caller's own key")
            .description(
                "The GET half of the provider passthrough (a model list, a batch's state), \
                 authenticated and keyed exactly as the POST half.",
            )
            .tag("StudioLlm")
            .authenticated()
            .require_license_features::<License>([])
            .handler(super::providers::stream_provider)
            .json_response(StatusCode::OK, "The provider's answer, passed through")
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);
        router = router.layer(Extension(providers));
    }

    router = OperationBuilder::post("/studio-llm/v1/chat/completions")
        .operation_id("studio_llm.chat_completions")
        .summary("OpenAI-compatible chat completions (proxied to the configured LLM upstream)")
        .description(
            "Verbatim passthrough of an OpenAI chat-completions request to the \
             configured upstream. The upstream API key is attached server-side; \
             callers authenticate with their Studio token. `stream: true` \
             responses are piped through as SSE.",
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(chat_completions)
        .json_response(
            StatusCode::OK,
            "Upstream response, passed through verbatim (JSON or SSE stream)",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-llm/v1/models")
        .operation_id("studio_llm.list_models")
        .summary("OpenAI-compatible model list (proxied)")
        .description(
            "Forwards to the configured OpenAI-compatible upstream and returns \
             its model list verbatim, so an IDE session can populate its model \
             picker without a provider key of its own.",
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_models)
        .json_response(
            StatusCode::OK,
            "Upstream model list, passed through verbatim",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-llm/v1/client-config")
        .operation_id("studio_llm.client_config")
        .summary("Client settings for the proxied LLM (model, prompt-role handling)")
        .description(
            "Lets IDE sessions self-configure their OpenAI-compatible client \
             without baking a provider choice into the image. Contains no secrets.",
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(client_config)
        .json_response_with_schema::<LlmClientConfigDto>(openapi, StatusCode::OK, "Client settings")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(state))
}
