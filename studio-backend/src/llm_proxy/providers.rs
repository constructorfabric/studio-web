//! Provider passthrough: the agents' own APIs and the IDE's chat, each call on
//! a person's key.
//!
//! Claude Code speaks Anthropic's Messages API and Codex speaks OpenAI's. Both
//! can be pointed at another base URL and handed a bearer token
//! (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, `OPENAI_BASE_URL` +
//! `OPENAI_API_KEY`). Pointed here, with the member's Studio token as that
//! bearer, a request arrives authenticated as the member. It leaves with the
//! key [`KeySource`] finds **for that member** (see [`super::keys`]): their
//! own from their profile, else an AI connection they reach -- their personal
//! one, the workspace's, the organization's. Never a key Studio holds.
//!
//! The IDE's built-in chat (Theia AI) is served the same way: it speaks
//! OpenAI's chat completions, and [`Providers::chat`] sends that to the first
//! provider with a chat model the caller has a key for, at the provider's own
//! OpenAI-compatible endpoint.
//!
//! So several people can run agents in one IDE container, each on their own
//! key, and no key ever enters the container (ADR-0030).
//!
//! The same table of providers serves Studio's own calls: [`Providers`]
//! implements [`super::port::ModelProviders`], so a gear that needs to reach a
//! provider (the connector gear testing a key) goes out through here too — the
//! one way out (ADR-0039).

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Request};
use axum::http::{HeaderMap, HeaderName, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::{ModelInfo, ModelProviders};
use crate::studio_session::sdk::WorkspaceAccess;

/// How a provider wants its key.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyHeader {
    /// `Authorization: Bearer <key>` — OpenAI.
    Bearer,
    /// `x-api-key: <key>` — Anthropic.
    XApiKey,
}

/// One upstream a member's agents and chat may reach.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    /// The path segment: `/studio-llm/v1/providers/<name>/…`. Also the
    /// connector provider id an AI connection of this provider carries.
    pub name: String,
    pub base_url: String,
    /// The credstore reference of a member's profile key, read as the caller.
    pub secret_ref: String,
    pub key_header: KeyHeader,
    /// Where the model list is, under `base_url`: what Studio's own key test
    /// reads ([`super::port::ModelProviders::list_models`]).
    #[serde(default = "default_models_path")]
    pub models_path: String,
    /// Headers Studio's own calls carry. An agent brings its own; a key test
    /// has nobody to bring them (Anthropic refuses a call without
    /// `anthropic-version`).
    #[serde(default)]
    pub request_headers: BTreeMap<String, String>,
    /// The model the IDE's chat uses on this provider. `None`: the chat never
    /// picks this provider.
    #[serde(default)]
    pub chat_model: Option<String>,
    /// The provider's OpenAI-compatible chat completions, under `base_url`.
    /// Always called with the key as a bearer: that is the OpenAI protocol,
    /// and what Anthropic's compatibility endpoint takes from the OpenAI SDK.
    #[serde(default = "default_chat_path")]
    pub chat_path: String,
    /// How an OpenAI client should send system prompts to this provider (Theia
    /// ai-openai `developerMessageSettings`): `user | system | developer |
    /// mergeWithFollowingUserMessage | skip`.
    #[serde(default = "default_developer_message_settings")]
    pub developer_message_settings: String,
}

fn default_models_path() -> String {
    "models".into()
}

fn default_chat_path() -> String {
    "chat/completions".into()
}

fn default_developer_message_settings() -> String {
    "system".into()
}

/// The Messages API version Studio's own Anthropic calls declare.
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub fn default_providers() -> Vec<ProviderConfig> {
    vec![
        ProviderConfig {
            name: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            secret_ref: "anthropic-key".into(),
            key_header: KeyHeader::XApiKey,
            models_path: "v1/models".into(),
            request_headers: BTreeMap::from([(
                "anthropic-version".to_owned(),
                ANTHROPIC_VERSION.to_owned(),
            )]),
            chat_model: Some("claude-sonnet-5-5".into()),
            chat_path: "v1/chat/completions".into(),
            developer_message_settings: default_developer_message_settings(),
        },
        ProviderConfig {
            name: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            secret_ref: "openai-key".into(),
            key_header: KeyHeader::Bearer,
            models_path: default_models_path(),
            request_headers: BTreeMap::new(),
            chat_model: Some("gpt-4.1-mini".into()),
            chat_path: default_chat_path(),
            developer_message_settings: default_developer_message_settings(),
        },
    ]
}

/// Where a key comes from: a person's profile and connections in production
/// ([`super::keys::PeopleKeys`]); a table in tests.
#[async_trait]
pub trait KeySource: Send + Sync {
    /// The key this caller may use for `provider`, or `None`. `workspace` is
    /// the workspace the request names, already shown to be the caller's.
    async fn key_for(
        &self,
        ctx: &SecurityContext,
        provider: &ProviderConfig,
        workspace: Option<Uuid>,
    ) -> anyhow::Result<Option<String>>;
}

pub struct Providers {
    pub client: reqwest::Client,
    pub list: Vec<ProviderConfig>,
    pub keys: Arc<dyn KeySource>,
    /// Whether a caller reaches the workspace a request names.
    pub access: Arc<dyn WorkspaceAccess>,
}

/// The chat model a caller gets, and the key it goes out on.
pub struct ChatChoice<'a> {
    pub provider: &'a ProviderConfig,
    pub model: String,
    pub key: String,
}

/// What [`Providers::client_config`] tells an IDE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSettings {
    /// `None` when the caller has no key for any provider with a chat model.
    pub provider: Option<String>,
    pub model: Option<String>,
    pub developer_message_settings: String,
    /// Why there is no model, in words to show the person.
    pub reason: Option<String>,
}

/// Request headers an agent's call needs upstream. The caller's own
/// credentials (`authorization`, `x-api-key`) are Studio's, not the provider's,
/// and are never forwarded.
const FORWARD_REQUEST: [&str; 8] = [
    "content-type",
    "accept",
    "accept-encoding",
    "user-agent",
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
    "x-stainless-helper-method",
];

/// Response headers passed back: the body's shape, and the provider's request
/// id and rate-limit state, which the CLIs read.
fn forwards_response(name: &str) -> bool {
    matches!(
        name,
        "content-type"
            | "content-encoding"
            | "cache-control"
            | "request-id"
            | "x-request-id"
            | "retry-after"
    ) || name.starts_with("anthropic-ratelimit-")
        || name.starts_with("x-ratelimit-")
        || name.starts_with("openai-")
}

/// `base` + `/` + `rest`, keeping the query the client sent.
pub fn upstream_url(base: &str, rest: &str, query: Option<&str>) -> String {
    let mut url = format!(
        "{}/{}",
        base.trim_end_matches('/'),
        rest.trim_start_matches('/')
    );
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        url.push('?');
        url.push_str(q);
    }
    url
}

/// The request headers to send upstream, the key among them.
pub fn upstream_headers(
    incoming: &HeaderMap,
    key_header: &KeyHeader,
    key: &str,
) -> Vec<(HeaderName, String)> {
    let mut out: Vec<(HeaderName, String)> = FORWARD_REQUEST
        .iter()
        .filter_map(|name| {
            let value = incoming.get(*name)?.to_str().ok()?;
            Some((HeaderName::from_static(name), value.to_owned()))
        })
        .collect();
    match key_header {
        KeyHeader::Bearer => out.push((header::AUTHORIZATION, format!("Bearer {key}"))),
        KeyHeader::XApiKey => out.push((HeaderName::from_static("x-api-key"), key.to_owned())),
    }
    out
}

/// What a caller without a key is told: where to put one.
pub fn no_key_message(provider: &str) -> String {
    format!(
        "No {provider} key for you: add one to your Studio profile, or connect one \
         (for yourself or this workspace) under Connections."
    )
}

/// An OpenAI-shaped error, which every client of these routes reads.
fn refuse(status: StatusCode, message: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "error": { "message": message } }).to_string(),
    )
        .into_response()
}

/// `body` with its `model` set to `model`: the chat goes to the provider the
/// caller's keys decide, so the model is that provider's, whatever the IDE was
/// configured with before the caller's keys changed. `None` when the body is
/// not a JSON object.
pub fn with_model(body: &[u8], model: &str) -> Option<Vec<u8>> {
    let mut value: serde_json::Value = serde_json::from_slice(body).ok()?;
    value
        .as_object_mut()?
        .insert("model".into(), serde_json::Value::String(model.into()));
    serde_json::to_vec(&value).ok()
}

/// The upstream's answer, streamed back with the headers a client reads.
fn stream_back(provider: &str, answer: reqwest::Response) -> Response {
    let mut response = Response::builder().status(answer.status().as_u16());
    for (name, value) in answer.headers() {
        if forwards_response(name.as_str()) {
            response = response.header(name.as_str(), value.as_bytes());
        }
    }
    // Streamed, not buffered: an answer is often a server-sent event stream.
    response
        .body(Body::from_stream(answer.bytes_stream()))
        .unwrap_or_else(|_| {
            refuse(
                StatusCode::BAD_GATEWAY,
                format!("{provider} sent an unreadable answer."),
            )
        })
}

impl Providers {
    /// A refusal when the request names a workspace the caller does not
    /// reach. "Not yours" and "not there" are one answer (404), and no key is
    /// looked for at all.
    async fn refuse_unreachable(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
    ) -> Option<Response> {
        let workspace = workspace?;
        if self.access.may_reach(ctx, workspace).await {
            return None;
        }
        Some(refuse(
            StatusCode::NOT_FOUND,
            format!("No workspace {workspace} here for you."),
        ))
    }

    pub async fn forward(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
        provider: &str,
        rest: &str,
        request: Request,
    ) -> Response {
        if let Some(refusal) = self.refuse_unreachable(ctx, workspace).await {
            return refusal;
        }
        let Some(config) = self.list.iter().find(|p| p.name == provider) else {
            return refuse(
                StatusCode::NOT_FOUND,
                format!("Studio has no model provider named {provider:?}."),
            );
        };
        let key = match self.keys.key_for(ctx, config, workspace).await {
            Ok(Some(key)) => key,
            Ok(None) => return refuse(StatusCode::FORBIDDEN, no_key_message(provider)),
            Err(error) => {
                tracing::warn!(provider, %error, "studio-llm-proxy: the caller's key could not be read");
                return refuse(
                    StatusCode::BAD_GATEWAY,
                    format!("Your {provider} key could not be read."),
                );
            }
        };

        let (parts, body) = request.into_parts();
        let url = upstream_url(&config.base_url, rest, parts.uri.query());
        let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
            .unwrap_or(reqwest::Method::POST);
        let mut upstream = self.client.request(method, url);
        for (name, value) in upstream_headers(&parts.headers, &config.key_header, &key) {
            upstream = upstream.header(name.as_str(), value);
        }
        if parts.method != axum::http::Method::GET && parts.method != axum::http::Method::HEAD {
            upstream = upstream.body(reqwest::Body::wrap_stream(body.into_data_stream()));
        }
        match upstream.send().await {
            Ok(answer) => stream_back(provider, answer),
            Err(error) => {
                tracing::warn!(provider, error = %error.without_url(), "studio-llm-proxy: the provider is unreachable");
                refuse(
                    StatusCode::BAD_GATEWAY,
                    format!("{provider} could not be reached."),
                )
            }
        }
    }

    /// The providers the chat may pick, in words: `anthropic or openai`.
    fn chat_provider_names(&self) -> String {
        let names: Vec<&str> = self
            .list
            .iter()
            .filter(|p| p.chat_model.is_some())
            .map(|p| p.name.as_str())
            .collect();
        match names.as_slice() {
            [] => "model provider".to_owned(),
            [one] => (*one).to_owned(),
            [init @ .., last] => format!("{} or {last}", init.join(", ")),
        }
    }

    /// The first provider, in configuration order, that has a chat model and
    /// for which the caller has a key.
    pub async fn chat_choice(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
    ) -> Option<ChatChoice<'_>> {
        for provider in &self.list {
            let Some(model) = provider.chat_model.as_deref().filter(|m| !m.is_empty()) else {
                continue;
            };
            match self.keys.key_for(ctx, provider, workspace).await {
                Ok(Some(key)) => {
                    return Some(ChatChoice {
                        provider,
                        model: model.to_owned(),
                        key,
                    });
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(
                    provider = %provider.name,
                    %error,
                    "studio-llm-proxy: the caller's key could not be read; trying the next provider"
                ),
            }
        }
        None
    }

    /// What the IDE configures its chat with, for this caller.
    pub async fn client_config(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
    ) -> ChatSettings {
        match self.chat_choice(ctx, workspace).await {
            Some(choice) => ChatSettings {
                provider: Some(choice.provider.name.clone()),
                model: Some(choice.model),
                developer_message_settings: choice.provider.developer_message_settings.clone(),
                reason: None,
            },
            None => ChatSettings {
                provider: None,
                model: None,
                developer_message_settings: default_developer_message_settings(),
                reason: Some(no_key_message(&self.chat_provider_names())),
            },
        }
    }

    /// `client_config`, refused when the named workspace is not the caller's.
    pub async fn client_config_in(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
    ) -> Result<ChatSettings, Response> {
        if let Some(refusal) = self.refuse_unreachable(ctx, workspace).await {
            return Err(refusal);
        }
        Ok(self.client_config(ctx, workspace).await)
    }

    /// The model list an OpenAI client probes: the one chat model this caller
    /// gets, or none.
    pub async fn models(&self, ctx: &SecurityContext, workspace: Option<Uuid>) -> Response {
        if let Some(refusal) = self.refuse_unreachable(ctx, workspace).await {
            return refusal;
        }
        let data: Vec<serde_json::Value> = self
            .chat_choice(ctx, workspace)
            .await
            .map(|c| serde_json::json!({ "id": c.model, "object": "model", "owned_by": c.provider.name }))
            .into_iter()
            .collect();
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({ "object": "list", "data": data }).to_string(),
        )
            .into_response()
    }

    /// An OpenAI chat-completions request from the IDE, sent to the provider
    /// [`Self::chat_choice`] picks, on the caller's key, and streamed back.
    pub async fn chat(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
        incoming: &HeaderMap,
        body: Bytes,
    ) -> Response {
        if let Some(refusal) = self.refuse_unreachable(ctx, workspace).await {
            return refusal;
        }
        let Some(choice) = self.chat_choice(ctx, workspace).await else {
            return refuse(
                StatusCode::FORBIDDEN,
                no_key_message(&self.chat_provider_names()),
            );
        };
        let Some(body) = with_model(&body, &choice.model) else {
            return refuse(
                StatusCode::BAD_REQUEST,
                "A chat completion is a JSON object.".to_owned(),
            );
        };
        let provider = choice.provider.name.as_str();
        let url = upstream_url(&choice.provider.base_url, &choice.provider.chat_path, None);
        let mut upstream = self.client.post(url);
        for (name, value) in upstream_headers(incoming, &KeyHeader::Bearer, &choice.key) {
            // The body is ours now (its model rewritten), so its type is too.
            if name != header::CONTENT_TYPE {
                upstream = upstream.header(name.as_str(), value);
            }
        }
        let upstream = upstream
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(body);
        match upstream.send().await {
            Ok(answer) => stream_back(provider, answer),
            Err(error) => {
                tracing::warn!(provider, error = %error.without_url(), "studio-llm-proxy: the provider is unreachable");
                refuse(
                    StatusCode::BAD_GATEWAY,
                    format!("{provider} could not be reached."),
                )
            }
        }
    }
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// Both providers answer `{ "data": [ { "id", … } ] }`.
#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[async_trait]
impl ModelProviders for Providers {
    async fn list_models(
        &self,
        provider: &str,
        base_url: Option<&str>,
        key: &str,
    ) -> anyhow::Result<Vec<ModelInfo>> {
        let config = self
            .list
            .iter()
            .find(|p| p.name == provider)
            .ok_or_else(|| anyhow::anyhow!("Studio has no model provider named {provider:?}"))?;
        let url = upstream_url(
            base_url.unwrap_or(&config.base_url),
            &config.models_path,
            None,
        );
        let mut request = self.client.get(url);
        for (name, value) in &config.request_headers {
            request = request.header(name.as_str(), value.as_str());
        }
        for (name, value) in upstream_headers(&HeaderMap::new(), &config.key_header, key) {
            request = request.header(name.as_str(), value);
        }
        let answer = request
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("{provider} could not be reached: {}", e.without_url()))?;
        let status = answer.status();
        if !status.is_success() {
            let body = answer.text().await.unwrap_or_default();
            anyhow::bail!(
                "{provider} {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let list: ModelList = answer.json().await?;
        Ok(list
            .data
            .into_iter()
            .map(|m| ModelInfo {
                id: m.id,
                display_name: m.display_name,
            })
            .collect())
    }
}

/// `GET|POST /studio-llm/v1/providers/{provider}/{*rest}`.
pub async fn stream_provider(
    axum::Extension(ctx): axum::Extension<SecurityContext>,
    axum::Extension(providers): axum::Extension<Arc<Providers>>,
    Path((provider, rest)): Path<(String, String)>,
    request: Request,
) -> Response {
    providers
        .forward(&ctx, None, &provider, &rest, request)
        .await
}

/// `GET|POST /studio-llm/v1/workspaces/{workspace_id}/providers/{provider}/{*rest}`.
pub async fn stream_workspace_provider(
    axum::Extension(ctx): axum::Extension<SecurityContext>,
    axum::Extension(providers): axum::Extension<Arc<Providers>>,
    Path((workspace_id, provider, rest)): Path<(Uuid, String, String)>,
    request: Request,
) -> Response {
    providers
        .forward(&ctx, Some(workspace_id), &provider, &rest, request)
        .await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use axum::http::HeaderValue;

    use super::*;

    fn person(id: u128) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(id))
            .subject_type("user")
            .subject_tenant_id(Uuid::from_u128(1))
            .build()
            .expect("security context")
    }

    /// Keys by (subject, provider, workspace named), as the resolution answers
    /// per caller.
    struct Keys {
        keys: HashMap<(Uuid, String, Option<Uuid>), String>,
        asked: Mutex<Vec<Uuid>>,
    }

    impl Keys {
        fn of(keys: &[(u128, &str, Option<Uuid>, &str)]) -> Arc<Self> {
            Arc::new(Self {
                keys: keys
                    .iter()
                    .map(|(who, provider, ws, key)| {
                        (
                            (Uuid::from_u128(*who), (*provider).to_owned(), *ws),
                            (*key).to_owned(),
                        )
                    })
                    .collect(),
                asked: Mutex::new(vec![]),
            })
        }
    }

    #[async_trait]
    impl KeySource for Keys {
        async fn key_for(
            &self,
            ctx: &SecurityContext,
            provider: &ProviderConfig,
            workspace: Option<Uuid>,
        ) -> anyhow::Result<Option<String>> {
            self.asked.lock().unwrap().push(ctx.subject_id());
            Ok(self
                .keys
                .get(&(ctx.subject_id(), provider.name.clone(), workspace))
                .cloned())
        }
    }

    /// Who reaches the workspace a request names.
    struct Reach(bool);

    #[async_trait]
    impl WorkspaceAccess for Reach {
        async fn may_reach(&self, _: &SecurityContext, _: Uuid) -> bool {
            self.0
        }
    }

    fn providers_with(list: Vec<ProviderConfig>, keys: Arc<Keys>, reach: bool) -> Providers {
        Providers {
            client: reqwest::Client::new(),
            list,
            keys,
            access: Arc::new(Reach(reach)),
        }
    }

    #[test]
    fn the_rest_of_the_path_and_the_query_reach_the_provider() {
        assert_eq!(
            upstream_url(
                "https://api.anthropic.com/",
                "v1/messages",
                Some("beta=true")
            ),
            "https://api.anthropic.com/v1/messages?beta=true"
        );
        assert_eq!(
            upstream_url("https://api.openai.com/v1", "/responses", None),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn the_callers_studio_token_never_reaches_the_provider() {
        let mut incoming = HeaderMap::new();
        incoming.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer studio-token-of-the-member"),
        );
        incoming.insert(
            "x-api-key",
            HeaderValue::from_static("whatever-the-cli-had"),
        );
        incoming.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        incoming.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let sent = upstream_headers(&incoming, &KeyHeader::XApiKey, "sk-ant-member");
        let get = |n: &str| {
            sent.iter()
                .filter(|(k, _)| k.as_str() == n)
                .map(|(_, v)| v.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(get("x-api-key"), ["sk-ant-member"]);
        assert!(
            get("authorization").is_empty(),
            "the Studio token went upstream"
        );
        assert_eq!(get("anthropic-version"), ["2023-06-01"]);
        assert_eq!(get("content-type"), ["application/json"]);
    }

    #[test]
    fn openai_takes_its_key_as_a_bearer() {
        let sent = upstream_headers(&HeaderMap::new(), &KeyHeader::Bearer, "sk-member");
        assert_eq!(
            sent,
            vec![(header::AUTHORIZATION, "Bearer sk-member".to_owned())]
        );
    }

    /// THE POINT OF THIS MODULE: two people, one container, each on their own
    /// key. The key is looked up as the caller, so Vasil's never answers for a
    /// colleague — and with no key of their own the colleague is told where
    /// to put one.
    #[tokio::test]
    async fn each_caller_is_asked_for_their_own_key() {
        let colleague = Uuid::from_u128(0xC011);
        let keys = Keys::of(&[(0x7A5, "anthropic", None, "sk-vasil")]);
        let providers = providers_with(default_providers(), keys.clone(), true);
        let answer = providers
            .forward(
                &person(0xC011),
                None,
                "anthropic",
                "v1/messages",
                Request::new(Body::empty()),
            )
            .await;
        assert_eq!(answer.status(), StatusCode::FORBIDDEN);
        assert_eq!(keys.asked.lock().unwrap().as_slice(), [colleague]);
        let body = axum::body::to_bytes(answer.into_body(), 1 << 16)
            .await
            .unwrap();
        assert!(
            String::from_utf8_lossy(&body).contains(&no_key_message("anthropic")),
            "{body:?}"
        );
    }

    /// A caller naming a workspace they do not reach gets 404 and no key is
    /// even looked for — a workspace's key never answers a stranger.
    #[tokio::test]
    async fn a_non_member_naming_a_workspace_gets_no_key() {
        let ws = Uuid::from_u128(0xD2);
        let keys = Keys::of(&[(0xC011, "anthropic", Some(ws), "sk-workspace")]);
        let providers = providers_with(default_providers(), keys.clone(), false);
        let answer = providers
            .forward(
                &person(0xC011),
                Some(ws),
                "anthropic",
                "v1/messages",
                Request::new(Body::empty()),
            )
            .await;
        assert_eq!(answer.status(), StatusCode::NOT_FOUND);
        let chat = providers
            .chat(
                &person(0xC011),
                Some(ws),
                &HeaderMap::new(),
                Bytes::from_static(b"{}"),
            )
            .await;
        assert_eq!(chat.status(), StatusCode::NOT_FOUND);
        assert!(
            providers
                .client_config_in(&person(0xC011), Some(ws))
                .await
                .is_err()
        );
        assert!(
            keys.asked.lock().unwrap().is_empty(),
            "a key was looked for"
        );
    }

    /// What the stand-in provider saw of one call: `x-api-key`,
    /// `authorization`, and the body.
    type Seen = Arc<Mutex<Vec<(Option<String>, Option<String>, String)>>>;

    fn stand_in(seen: Seen, path: &'static str, answer: &'static str) -> axum::Router {
        axum::Router::new().route(
            path,
            axum::routing::post(move |headers: HeaderMap, body: String| {
                let record = seen.clone();
                async move {
                    let h = |n: &str| {
                        headers
                            .get(n)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned)
                    };
                    record
                        .lock()
                        .unwrap()
                        .push((h("x-api-key"), h("authorization"), body));
                    ([(header::CONTENT_TYPE, "text/event-stream")], answer)
                }
            }),
        )
    }

    async fn serve(router: axum::Router) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        address
    }

    fn stand_in_provider(name: &str, address: std::net::SocketAddr) -> ProviderConfig {
        let mut config = default_providers()
            .into_iter()
            .find(|p| p.name == name)
            .expect("a default provider");
        config.base_url = format!("http://{address}");
        config.request_headers = BTreeMap::new();
        config
    }

    /// End to end against a stand-in provider: the colleague's call arrives
    /// upstream with the colleague's key, Vasil's call with Vasil's, and the
    /// answer streams back unchanged.
    #[tokio::test]
    async fn the_provider_sees_the_callers_key_and_nothing_of_studio() {
        let seen: Seen = Arc::new(Mutex::new(vec![]));
        let address = serve(stand_in(
            seen.clone(),
            "/v1/messages",
            "event: message_stop\ndata: {}\n\n",
        ))
        .await;
        let ws = Uuid::from_u128(0xD2);
        let providers = providers_with(
            vec![stand_in_provider("anthropic", address)],
            Keys::of(&[
                (0x7A5, "anthropic", Some(ws), "sk-vasil"),
                (0xC011, "anthropic", Some(ws), "sk-colleague"),
            ]),
            true,
        );
        for who in [0xC011, 0x7A5] {
            let request = Request::builder()
                .method("POST")
                .uri("/studio-llm/v1/workspaces/x/providers/anthropic/v1/messages")
                .header(header::AUTHORIZATION, "Bearer the-members-studio-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"model":"claude"}"#))
                .unwrap();
            let answer = providers
                .forward(&person(who), Some(ws), "anthropic", "v1/messages", request)
                .await;
            assert_eq!(answer.status(), StatusCode::OK);
            assert_eq!(answer.headers()[header::CONTENT_TYPE], "text/event-stream");
            let body = axum::body::to_bytes(answer.into_body(), 1 << 20)
                .await
                .unwrap();
            assert!(String::from_utf8_lossy(&body).contains("message_stop"));
        }
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen[0].0.as_deref(), Some("sk-colleague"));
        assert_eq!(seen[1].0.as_deref(), Some("sk-vasil"));
        assert!(
            seen.iter()
                .all(|(_, authorization, _)| authorization.is_none()),
            "a Studio token reached the provider"
        );
        assert!(
            seen.iter()
                .all(|(_, _, body)| body == r#"{"model":"claude"}"#)
        );
    }

    #[tokio::test]
    async fn an_unknown_provider_is_not_found() {
        let providers = providers_with(default_providers(), Keys::of(&[]), true);
        let answer = providers
            .forward(
                &person(1),
                None,
                "gemini",
                "v1/x",
                Request::new(Body::empty()),
            )
            .await;
        assert_eq!(answer.status(), StatusCode::NOT_FOUND);
    }

    /// The chat goes to the first provider, in configuration order, that has a
    /// chat model and a key for this caller; client-config says which.
    #[tokio::test]
    async fn the_chat_picks_the_first_provider_the_caller_has_a_key_for() {
        let ws = Uuid::from_u128(0xD2);
        let no_chat = |name: &str| ProviderConfig {
            name: name.into(),
            chat_model: None,
            ..default_providers()[1].clone()
        };
        let mut list = vec![no_chat("silent")];
        list.extend(default_providers());
        for (keys, expected) in [
            (
                vec![
                    (0x7A5, "silent", Some(ws), "sk-silent"),
                    (0x7A5, "openai", Some(ws), "sk-openai"),
                ],
                Some(("openai", "gpt-4.1-mini")),
            ),
            (
                vec![
                    (0x7A5, "openai", Some(ws), "sk-openai"),
                    (0x7A5, "anthropic", Some(ws), "sk-ant"),
                ],
                Some(("anthropic", "claude-sonnet-5-5")),
            ),
            (vec![(0x7A5, "silent", Some(ws), "sk-silent")], None),
        ] {
            let providers = providers_with(list.clone(), Keys::of(&keys), true);
            let Ok(settings) = providers.client_config_in(&person(0x7A5), Some(ws)).await else {
                panic!("a member reaches the workspace");
            };
            assert_eq!(
                settings.provider.as_deref().zip(settings.model.as_deref()),
                expected,
                "{keys:?}"
            );
        }
    }

    /// No key for any chat provider: no model, and a reason that says where
    /// to put a key.
    #[tokio::test]
    async fn client_config_without_a_key_has_no_model() {
        let providers = providers_with(default_providers(), Keys::of(&[]), true);
        let settings = providers.client_config(&person(0x7A5), None).await;
        assert_eq!(settings.model, None);
        assert_eq!(settings.provider, None);
        assert_eq!(
            settings.reason.as_deref(),
            Some(no_key_message("anthropic or openai").as_str())
        );
        let chat = providers
            .chat(
                &person(0x7A5),
                None,
                &HeaderMap::new(),
                Bytes::from_static(b"{}"),
            )
            .await;
        assert_eq!(chat.status(), StatusCode::FORBIDDEN);
    }

    /// End to end: the IDE's chat reaches the chosen provider's
    /// OpenAI-compatible endpoint with the caller's key as a bearer, the
    /// provider's chat model in the body, and nothing of Studio's token.
    #[tokio::test]
    async fn the_chat_reaches_the_provider_on_the_callers_key() {
        let seen: Seen = Arc::new(Mutex::new(vec![]));
        let address = serve(stand_in(
            seen.clone(),
            "/v1/chat/completions",
            "data: [DONE]\n\n",
        ))
        .await;
        let providers = providers_with(
            vec![stand_in_provider("anthropic", address)],
            Keys::of(&[(0x7A5, "anthropic", None, "sk-ant-vasil")]),
            true,
        );
        let mut incoming = HeaderMap::new();
        incoming.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer studio-token"),
        );
        let answer = providers
            .chat(
                &person(0x7A5),
                None,
                &incoming,
                Bytes::from_static(br#"{"model":"studio-llm","stream":true}"#),
            )
            .await;
        assert_eq!(answer.status(), StatusCode::OK);
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].1.as_deref(), Some("Bearer sk-ant-vasil"));
        let body: serde_json::Value = serde_json::from_str(&seen[0].2).unwrap();
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn a_chat_body_that_is_not_an_object_is_refused() {
        assert_eq!(with_model(b"[1]", "m"), None);
        assert_eq!(with_model(b"nope", "m"), None);
        assert!(with_model(br#"{"model":"x"}"#, "m").is_some());
    }

    /// What the stand-in provider saw of a key test: `x-api-key`,
    /// `anthropic-version`, `authorization`.
    type SeenProbe = Arc<Mutex<Vec<(Option<String>, Option<String>, Option<String>)>>>;

    /// A stand-in provider whose `/v1/models` accepts only `sk-good`.
    async fn models_stub(seen: SeenProbe) -> String {
        let upstream = axum::Router::new().route(
            "/v1/models",
            axum::routing::get(move |headers: HeaderMap| {
                let seen = seen.clone();
                async move {
                    let h = |n: &str| {
                        headers
                            .get(n)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned)
                    };
                    let key = h("x-api-key");
                    seen.lock().unwrap().push((
                        key.clone(),
                        h("anthropic-version"),
                        h("authorization"),
                    ));
                    if key.as_deref() == Some("sk-good") {
                        (
                            StatusCode::OK,
                            r#"{"data":[{"id":"claude-x","display_name":"Claude X"},{"id":"claude-y"}]}"#,
                        )
                    } else {
                        (StatusCode::UNAUTHORIZED, r#"{"error":"invalid x-api-key"}"#)
                    }
                }
            }),
        );
        format!("http://{}", serve(upstream).await)
    }

    /// The connector gear's "test connection" goes out here: the key it is
    /// testing, sent the way the provider wants it, with the headers Studio's
    /// own calls carry — and the answer read as a model list.
    #[tokio::test]
    async fn a_key_test_reaches_the_provider_through_the_one_way_out() {
        let seen: SeenProbe = Arc::new(Mutex::new(vec![]));
        let base = models_stub(seen.clone()).await;
        let providers = providers_with(default_providers(), Keys::of(&[]), true);

        let models = providers
            .list_models("anthropic", Some(&base), "sk-good")
            .await
            .expect("an accepted key lists models");
        assert_eq!(
            models,
            [
                ModelInfo {
                    id: "claude-x".into(),
                    display_name: Some("Claude X".into())
                },
                ModelInfo {
                    id: "claude-y".into(),
                    display_name: None
                },
            ]
        );

        let refused = providers
            .list_models("anthropic", Some(&base), "sk-bad")
            .await
            .expect_err("a refused key is an error");
        assert!(refused.to_string().contains("401"), "{refused}");

        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            seen[0],
            (Some("sk-good".into()), Some(ANTHROPIC_VERSION.into()), None)
        );
        assert_eq!(seen[1].0.as_deref(), Some("sk-bad"));
    }

    #[tokio::test]
    async fn a_key_test_for_an_unknown_provider_goes_nowhere() {
        let providers = providers_with(default_providers(), Keys::of(&[]), true);
        let error = providers
            .list_models("gemini", Some("http://127.0.0.1:9"), "sk")
            .await
            .expect_err("no such provider");
        assert!(error.to_string().contains("gemini"), "{error}");
    }
}
