use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::providers::{self, ChatSettings, Providers};

/// A workspace the caller named and does not reach.
#[resource_error(gts_id!("cf.studio._.llm.v1~"))]
pub struct StudioLlmError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// What an IDE needs to configure its OpenAI-compatible client against this
/// proxy, for the caller asking. Nothing secret: the caller brings its own
/// (Studio) token, and the provider key it is served with never leaves the
/// backend.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct LlmClientConfigDto {
    /// The model to request — the chat model of the first provider the caller
    /// has a key for. Absent when they have none: see `reason`.
    pub model: Option<String>,
    /// That provider's name (`anthropic`, `openai`). Absent with `model`.
    pub provider: Option<String>,
    /// System-prompt role handling for that provider: user | system |
    /// developer | mergeWithFollowingUserMessage | skip.
    pub developer_message_settings: String,
    /// Why there is no model, in words to show the person: where to add a key.
    pub reason: Option<String>,
}

impl From<ChatSettings> for LlmClientConfigDto {
    fn from(s: ChatSettings) -> Self {
        Self {
            model: s.model,
            provider: s.provider,
            developer_message_settings: s.developer_message_settings,
            reason: s.reason,
        }
    }
}

/* ── Handlers ── */

/// POST /studio-llm/v1/chat/completions — the OpenAI chat-completions
/// endpoint Theia AI's `ai-openai` provider targets, on the caller's key.
async fn chat_completions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(providers): Extension<Arc<Providers>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    providers.chat(&ctx, None, &headers, body).await
}

/// POST /studio-llm/v1/workspaces/{workspace_id}/chat/completions — the same,
/// with the workspace's AI connections among the keys.
async fn stream_workspace_chat_completions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(providers): Extension<Arc<Providers>>,
    Path(workspace_id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    providers
        .chat(&ctx, Some(workspace_id), &headers, body)
        .await
}

async fn list_models(
    Extension(ctx): Extension<SecurityContext>,
    Extension(providers): Extension<Arc<Providers>>,
) -> Response {
    providers.models(&ctx, None).await
}

async fn list_workspace_models(
    Extension(ctx): Extension<SecurityContext>,
    Extension(providers): Extension<Arc<Providers>>,
    Path(workspace_id): Path<Uuid>,
) -> Response {
    providers.models(&ctx, Some(workspace_id)).await
}

async fn client_config(
    Extension(ctx): Extension<SecurityContext>,
    Extension(providers): Extension<Arc<Providers>>,
) -> ApiResult<JsonBody<LlmClientConfigDto>> {
    Ok(Json(providers.client_config(&ctx, None).await.into()))
}

async fn get_workspace_client_config(
    Extension(ctx): Extension<SecurityContext>,
    Extension(providers): Extension<Arc<Providers>>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<JsonBody<LlmClientConfigDto>> {
    match providers.client_config_in(&ctx, Some(workspace_id)).await {
        Ok(settings) => Ok(Json(settings.into())),
        Err(_) => Err(StudioLlmError::not_found(format!(
            "there is no workspace {workspace_id} for this caller"
        ))
        .with_resource(workspace_id.to_string())
        .create()),
    }
}

/* ── Routes ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    providers: Arc<Providers>,
) -> Router {
    router = OperationBuilder::post("/studio-llm/v1/providers/{provider}/{*rest}")
        .operation_id("studio_llm.stream_provider_post")
        .summary("An agent's call to its model provider, on the caller's own key")
        .description(
            "Claude Code (Anthropic Messages API) and Codex (OpenAI) are pointed here \
             with the member's Studio token as their bearer, outside a workspace. The \
             call is forwarded to the provider; the caller's Studio token never reaches \
             it, and the response streams. The key is the caller's own: their profile key (a private one only), \
     else their personal AI connection of that provider, else the workspace's (on the \
     workspace routes), else the organization's. Studio holds no key of its own. With none, \
     403 says where to add one."
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(providers::stream_provider)
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
        .handler(providers::stream_provider)
        .json_response(StatusCode::OK, "The provider's answer, passed through")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-llm/v1/workspaces/{workspace_id}/providers/{provider}/{*rest}",
    )
    .operation_id("studio_llm.stream_workspace_provider_post")
    .summary("An agent's call to its model provider from a workspace, on the caller's key")
    .description(
        "What an IDE session points its agents at (ANTHROPIC_BASE_URL, OPENAI_BASE_URL): \
         the agent CLI appends the provider's own path, so the workspace is a path \
         segment. The caller must reach the workspace (404 otherwise, and no key is \
         looked for). The key is the caller's own: their profile key (a private one only), \
     else their personal AI connection of that provider, else the workspace's (on the \
     workspace routes), else the organization's. Studio holds no key of its own. With none, \
     403 says where to add one.",
    )
    .tag("StudioLlm")
    .authenticated()
    .require_license_features::<License>([])
    .handler(providers::stream_workspace_provider)
    .json_response(
        StatusCode::OK,
        "The provider's answer, passed through (JSON or SSE)",
    )
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);
    router = OperationBuilder::get(
        "/studio-llm/v1/workspaces/{workspace_id}/providers/{provider}/{*rest}",
    )
    .operation_id("studio_llm.stream_workspace_provider_get")
    .summary("A read from the caller's model provider from a workspace")
    .description(
        "The GET half of the workspace provider passthrough, authorized and keyed exactly \
         as the POST half.",
    )
    .tag("StudioLlm")
    .authenticated()
    .require_license_features::<License>([])
    .handler(providers::stream_workspace_provider)
    .json_response(StatusCode::OK, "The provider's answer, passed through")
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post("/studio-llm/v1/chat/completions")
        .operation_id("studio_llm.chat_completions")
        .summary("OpenAI-compatible chat completions, on the caller's key")
        .description(
            "The IDE's chat (Theia AI) outside a workspace. Sent to the first provider, in \
             configuration order, with a chat model the caller has a key for, at that \
             provider's OpenAI-compatible endpoint, with the request's `model` set to that \
             provider's chat model. `stream: true` answers stream. The key is the caller's own: their profile key (a private one only), \
     else their personal AI connection of that provider, else the workspace's (on the \
     workspace routes), else the organization's. Studio holds no key of its own. With none, \
     403 says where to add one."
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(chat_completions)
        .json_response(
            StatusCode::OK,
            "The provider's answer, passed through (JSON or SSE stream)",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);
    router = OperationBuilder::post("/studio-llm/v1/workspaces/{workspace_id}/chat/completions")
        .operation_id("studio_llm.stream_workspace_chat_completions")
        .summary("OpenAI-compatible chat completions from a workspace, on the caller's key")
        .description(
            "What an IDE session's chat is configured with: the OpenAI client appends \
             `/chat/completions` to its base URL, so the workspace is a path segment. The \
             caller must reach the workspace (404 otherwise). Provider and model are \
             picked as on the tenant-less route. The key is the caller's own: their profile key (a private one only), \
     else their personal AI connection of that provider, else the workspace's (on the \
     workspace routes), else the organization's. Studio holds no key of its own. With none, \
     403 says where to add one."
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(stream_workspace_chat_completions)
        .json_response(
            StatusCode::OK,
            "The provider's answer, passed through (JSON or SSE stream)",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-llm/v1/models")
        .operation_id("studio_llm.list_models")
        .summary("OpenAI-compatible model list: the chat model this caller gets")
        .description(
            "An OpenAI client probes it to fill its model picker. Lists the one chat model \
             the caller would be served (see client-config), or none when they have no key.",
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_models)
        .json_response(StatusCode::OK, "An OpenAI model list")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);
    router = OperationBuilder::get("/studio-llm/v1/workspaces/{workspace_id}/models")
        .operation_id("studio_llm.list_workspace_models")
        .summary("OpenAI-compatible model list from a workspace")
        .description(
            "The model list an IDE session's OpenAI client probes under its workspace base \
             URL: the one chat model the caller would be served there, or none.",
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_workspace_models)
        .json_response(StatusCode::OK, "An OpenAI model list")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-llm/v1/client-config")
        .operation_id("studio_llm.client_config")
        .summary("Client settings for the IDE's chat, for this caller")
        .description(
            "Lets an IDE configure its OpenAI-compatible client without baking a provider \
             into the image: the model the caller would be served, and how that provider \
             wants system prompts. No model, with a reason, when the caller has no key. \
             Contains no secrets.",
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(client_config)
        .json_response_with_schema::<LlmClientConfigDto>(openapi, StatusCode::OK, "Client settings")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);
    router = OperationBuilder::get("/studio-llm/v1/workspaces/{workspace_id}/client-config")
        .operation_id("studio_llm.get_workspace_client_config")
        .summary("Client settings for the IDE's chat in a workspace, for this caller")
        .description(
            "What an IDE session reads before configuring its chat against the workspace \
             chat route: the model the caller would be served there (the workspace's AI \
             connections count), or no model with a reason. 404 when the caller does not \
             reach the workspace.",
        )
        .tag("StudioLlm")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_workspace_client_config)
        .json_response_with_schema::<LlmClientConfigDto>(openapi, StatusCode::OK, "Client settings")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(providers))
}
