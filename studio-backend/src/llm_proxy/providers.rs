//! Provider passthrough: the agents' own APIs, with the caller's own key.
//!
//! Claude Code speaks Anthropic's Messages API and Codex speaks OpenAI's. Both
//! can be pointed at another base URL and handed a bearer token
//! (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, `OPENAI_BASE_URL` +
//! `OPENAI_API_KEY`). Pointed here, with the member's Studio token as that
//! bearer, a request arrives authenticated as the member. It leaves with the
//! provider key credstore answers **for that member**: their own key from
//! their profile when they keep one, otherwise the key shared with the
//! workspace (credstore resolves private before shared).
//!
//! So several people can run agents in one IDE container, each on their own
//! key, and no key ever enters the container (ADR-0030).
//!
//! The same table of providers serves Studio's own calls: [`Providers`]
//! implements [`super::port::ModelProviders`], so a gear that needs to reach a
//! provider (the connector gear testing a key) goes out through here too — the
//! one way out (ADR-0037).

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::{Path, Request};
use axum::http::{HeaderMap, HeaderName, StatusCode, header};
use axum::response::{IntoResponse, Response};
use credstore_sdk::{CredStoreClientV1, SecretRef};
use serde::Deserialize;
use toolkit_security::SecurityContext;

use super::port::{ModelInfo, ModelProviders};

/// How a provider wants its key.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyHeader {
    /// `Authorization: Bearer <key>` — OpenAI.
    Bearer,
    /// `x-api-key: <key>` — Anthropic.
    XApiKey,
}

/// One upstream a member's agents may reach.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    /// The path segment: `/studio-llm/v1/providers/<name>/…`.
    pub name: String,
    pub base_url: String,
    /// The credstore reference holding the key, resolved under the caller.
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
}

fn default_models_path() -> String {
    "models".into()
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
        },
        ProviderConfig {
            name: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            secret_ref: "openai-key".into(),
            key_header: KeyHeader::Bearer,
            models_path: default_models_path(),
            request_headers: BTreeMap::new(),
        },
    ]
}

/// Where a key comes from. Credstore in production; a table in tests.
#[async_trait]
pub trait KeySource: Send + Sync {
    /// The key this caller may use under `secret_ref`, or `None`.
    async fn key_for(
        &self,
        ctx: &SecurityContext,
        secret_ref: &str,
    ) -> anyhow::Result<Option<String>>;
}

/// Credstore, asked as the caller: their private secret first, then the one
/// shared with their tenant.
pub struct CredstoreKeys(pub Arc<dyn CredStoreClientV1>);

#[async_trait]
impl KeySource for CredstoreKeys {
    async fn key_for(
        &self,
        ctx: &SecurityContext,
        secret_ref: &str,
    ) -> anyhow::Result<Option<String>> {
        let key =
            SecretRef::new(secret_ref).map_err(|e| anyhow::anyhow!("bad secret reference: {e}"))?;
        let Some(secret) = self
            .0
            .get(ctx, &key)
            .await
            .map_err(|e| anyhow::anyhow!("credstore: {e}"))?
        else {
            return Ok(None);
        };
        let value = String::from_utf8(secret.value.as_bytes().to_vec())
            .map_err(|_| anyhow::anyhow!("the secret {secret_ref} is not UTF-8"))?;
        Ok(Some(value.trim().to_owned()).filter(|v| !v.is_empty()))
    }
}

pub struct Providers {
    pub client: reqwest::Client,
    pub list: Vec<ProviderConfig>,
    pub keys: Arc<dyn KeySource>,
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

fn refuse(status: StatusCode, message: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "error": { "message": message } }).to_string(),
    )
        .into_response()
}

impl Providers {
    pub async fn forward(
        &self,
        ctx: &SecurityContext,
        provider: &str,
        rest: &str,
        request: Request,
    ) -> Response {
        let Some(config) = self.list.iter().find(|p| p.name == provider) else {
            return refuse(
                StatusCode::NOT_FOUND,
                format!("Studio has no model provider named {provider:?}."),
            );
        };
        let key = match self.keys.key_for(ctx, &config.secret_ref).await {
            Ok(Some(key)) => key,
            Ok(None) => {
                return refuse(
                    StatusCode::FORBIDDEN,
                    format!(
                        "No {provider} key for you: add one to your Studio profile, or ask an owner to share one with the workspace."
                    ),
                );
            }
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
        let answer = match upstream.send().await {
            Ok(answer) => answer,
            Err(error) => {
                tracing::warn!(provider, error = %error.without_url(), "studio-llm-proxy: the provider is unreachable");
                return refuse(
                    StatusCode::BAD_GATEWAY,
                    format!("{provider} could not be reached."),
                );
            }
        };
        let mut response = Response::builder().status(answer.status().as_u16());
        for (name, value) in answer.headers() {
            if forwards_response(name.as_str()) {
                response = response.header(name.as_str(), value.as_bytes());
            }
        }
        // Streamed, not buffered: an agent's answer is a server-sent event stream.
        response
            .body(Body::from_stream(answer.bytes_stream()))
            .unwrap_or_else(|_| {
                refuse(
                    StatusCode::BAD_GATEWAY,
                    format!("{provider} sent an unreadable answer."),
                )
            })
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
    providers.forward(&ctx, &provider, &rest, request).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use axum::http::HeaderValue;
    use uuid::Uuid;

    use super::*;

    fn person(id: u128) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(id))
            .subject_type("user")
            .subject_tenant_id(Uuid::from_u128(1))
            .build()
            .expect("security context")
    }

    /// Keys by (subject, reference), as credstore answers per caller.
    struct Keys {
        keys: HashMap<(Uuid, String), String>,
        asked: Mutex<Vec<Uuid>>,
    }

    #[async_trait]
    impl KeySource for Keys {
        async fn key_for(
            &self,
            ctx: &SecurityContext,
            secret_ref: &str,
        ) -> anyhow::Result<Option<String>> {
            self.asked.lock().unwrap().push(ctx.subject_id());
            Ok(self
                .keys
                .get(&(ctx.subject_id(), secret_ref.to_owned()))
                .cloned())
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
    /// colleague.
    #[tokio::test]
    async fn each_caller_is_asked_for_their_own_key() {
        let vasil = Uuid::from_u128(0x7A5);
        let colleague = Uuid::from_u128(0xC011);
        let keys = Arc::new(Keys {
            keys: HashMap::from([((vasil, "anthropic-key".to_owned()), "sk-vasil".to_owned())]),
            asked: Mutex::new(vec![]),
        });
        let providers = Providers {
            client: reqwest::Client::new(),
            list: default_providers(),
            keys: keys.clone(),
        };
        // The colleague keeps no key and none is shared: refused, not served
        // with Vasil's.
        let answer = providers
            .forward(
                &person(0xC011),
                "anthropic",
                "v1/messages",
                Request::new(Body::empty()),
            )
            .await;
        assert_eq!(answer.status(), StatusCode::FORBIDDEN);
        assert_eq!(keys.asked.lock().unwrap().as_slice(), [colleague]);
    }

    /// What the stand-in provider saw of one call: `x-api-key`,
    /// `authorization`, and the body.
    type Seen = Arc<Mutex<Vec<(Option<String>, Option<String>, String)>>>;

    /// End to end against a stand-in provider: the colleague's call arrives
    /// upstream with the colleague's key, Vasil's call with Vasil's, and the
    /// answer streams back unchanged.
    #[tokio::test]
    async fn the_provider_sees_the_callers_key_and_nothing_of_studio() {
        let seen: Seen = Arc::new(Mutex::new(vec![]));
        let record = seen.clone();
        let upstream = axum::Router::new().route(
            "/v1/messages",
            axum::routing::post(move |headers: HeaderMap, body: String| {
                let record = record.clone();
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
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "event: message_stop\ndata: {}\n\n",
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let vasil = Uuid::from_u128(0x7A5);
        let colleague = Uuid::from_u128(0xC011);
        let providers = Providers {
            client: reqwest::Client::new(),
            list: vec![ProviderConfig {
                name: "anthropic".into(),
                base_url: format!("http://{address}"),
                secret_ref: "anthropic-key".into(),
                key_header: KeyHeader::XApiKey,
                models_path: "v1/models".into(),
                request_headers: BTreeMap::new(),
            }],
            keys: Arc::new(Keys {
                keys: HashMap::from([
                    ((vasil, "anthropic-key".to_owned()), "sk-vasil".to_owned()),
                    (
                        (colleague, "anthropic-key".to_owned()),
                        "sk-colleague".to_owned(),
                    ),
                ]),
                asked: Mutex::new(vec![]),
            }),
        };
        for who in [0xC011, 0x7A5] {
            let request = Request::builder()
                .method("POST")
                .uri("/studio-llm/v1/providers/anthropic/v1/messages")
                .header(header::AUTHORIZATION, "Bearer the-members-studio-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"model":"claude"}"#))
                .unwrap();
            let answer = providers
                .forward(&person(who), "anthropic", "v1/messages", request)
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
        let providers = Providers {
            client: reqwest::Client::new(),
            list: default_providers(),
            keys: Arc::new(Keys {
                keys: HashMap::new(),
                asked: Mutex::new(vec![]),
            }),
        };
        let answer = providers
            .forward(&person(1), "gemini", "v1/x", Request::new(Body::empty()))
            .await;
        assert_eq!(answer.status(), StatusCode::NOT_FOUND);
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        format!("http://{address}")
    }

    fn no_keys() -> Arc<Keys> {
        Arc::new(Keys {
            keys: HashMap::new(),
            asked: Mutex::new(vec![]),
        })
    }

    /// The connector gear's "test connection" goes out here: the key it is
    /// testing, sent the way the provider wants it, with the headers Studio's
    /// own calls carry — and the answer read as a model list.
    #[tokio::test]
    async fn a_key_test_reaches_the_provider_through_the_one_way_out() {
        let seen: SeenProbe = Arc::new(Mutex::new(vec![]));
        let base = models_stub(seen.clone()).await;
        let providers = Providers {
            client: reqwest::Client::new(),
            list: default_providers(),
            keys: no_keys(),
        };

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
        let providers = Providers {
            client: reqwest::Client::new(),
            list: default_providers(),
            keys: no_keys(),
        };
        let error = providers
            .list_models("gemini", Some("http://127.0.0.1:9"), "sk")
            .await
            .expect_err("no such provider");
        assert!(error.to_string().contains("gemini"), "{error}");
    }
}
