//! What a tool is, and the one way it reaches Studio: the REST API, as the
//! person calling it.
//!
//! A tool never calls a service in process. It sends the request the portal
//! would send, to this backend's own gateway, with the caller's own
//! `Authorization` header, so the authentication, the tenant clamp, the PDP
//! and every check a route makes apply to a tool call exactly as they apply
//! to the portal. An agent cannot do more through MCP than its person can do
//! in the browser, and a route that changes its rules changes them for both.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use axum::http::HeaderValue;
use serde_json::{Map, Value, json};

/// One tool an agent can call. The gear that owns the routes it uses declares
/// it, next to them (`<gear>/mcp.rs`); `studio-mcp` only collects them.
pub struct Tool {
    /// The name the agent calls it by: `<area>_<what>`, snake case.
    pub name: &'static str,
    /// Written for the agent: what it answers, when to call it, what it does
    /// not do. This text is the whole of what the agent knows about the tool.
    pub description: &'static str,
    /// The JSON Schema of the arguments.
    pub input_schema: fn() -> Value,
    pub run: Run,
}

/// How a call becomes REST requests.
pub enum Run {
    /// `GET path`. Each `{name}` in the path is filled from the argument of
    /// that name; every other argument is a query parameter.
    Get(&'static str),
    /// `POST path`, the arguments as the JSON body, except those named in
    /// `query`, which go in the query string.
    Post {
        path: &'static str,
        query: &'static [&'static str],
    },
    /// Anything that is more than one request (a submit and its wait).
    Custom(fn(Api, Map<String, Value>) -> ToolFuture),
}

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send>>;

/// A call that did not answer: said to the agent as the tool's result, with
/// `isError`, so it can read why and correct the call (MCP's tool errors).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError(pub String);

impl ToolError {
    pub fn new(why: impl Into<String>) -> Self {
        Self(why.into())
    }
}

/// The backend's REST API, as one caller.
#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    /// `http://127.0.0.1:8090/cf`: the gateway, with its prefix, no slash.
    base: String,
    /// The caller's own `Authorization` header, sent on unchanged.
    auth: Option<HeaderValue>,
}

/// How much of a failed answer is passed to the agent.
const MAX_ERROR_CHARS: usize = 4000;

impl Api {
    pub fn new(client: reqwest::Client, base: &str, auth: Option<HeaderValue>) -> Self {
        Self {
            client,
            base: base.trim_end_matches('/').to_owned(),
            auth,
        }
    }

    pub async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value, ToolError> {
        self.send(self.client.get(self.url(path)).query(query))
            .await
    }

    pub async fn post(
        &self,
        path: &str,
        query: &[(String, String)],
        body: &Value,
    ) -> Result<Value, ToolError> {
        self.send(self.client.post(self.url(path)).query(query).json(body))
            .await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, ToolError> {
        let req = match &self.auth {
            Some(auth) => req.header(axum::http::header::AUTHORIZATION, auth.clone()),
            None => req,
        };
        let res = req
            .send()
            .await
            .map_err(|e| ToolError::new(format!("Studio did not answer: {e}")))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ToolError::new(refusal(status.as_u16(), &text)));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }
}

/// A route's refusal, in the words the route used: the problem's `detail`
/// and its field violations when it has them, the body as it came otherwise.
fn refusal(status: u16, body: &str) -> String {
    let said = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            let detail = v
                .get("detail")
                .or_else(|| v.get("message"))
                .or_else(|| v.get("title"))
                .and_then(Value::as_str)?
                .to_owned();
            Some(
                match v.get("errors").or_else(|| v.get("field_violations")) {
                    Some(more) if !more.is_null() => format!("{detail} {more}"),
                    _ => detail,
                },
            )
        })
        .unwrap_or_else(|| body.trim().to_owned());
    let mut said: String = said.chars().take(MAX_ERROR_CHARS).collect();
    if said.is_empty() {
        said = "no detail".to_owned();
    }
    format!("Studio answered {status}: {said}")
}

/// Run one tool with the arguments the agent sent.
pub async fn call(tool: &Tool, api: Api, args: Map<String, Value>) -> Result<Value, ToolError> {
    match &tool.run {
        Run::Get(path) => {
            let (path, rest) = fill_path(path, args)?;
            api.get(&path, &query_pairs(&rest)).await
        }
        Run::Post { path, query } => {
            let (path, mut rest) = fill_path(path, args)?;
            let mut q = Map::new();
            for name in *query {
                if let Some(v) = rest.remove(*name) {
                    q.insert((*name).to_owned(), v);
                }
            }
            api.post(&path, &query_pairs(&q), &Value::Object(rest))
                .await
        }
        Run::Custom(run) => run(api, args).await,
    }
}

/// `/types/{id}` with `id` taken out of the arguments and put in the path.
fn fill_path(
    template: &str,
    mut args: Map<String, Value>,
) -> Result<(String, Map<String, Value>), ToolError> {
    let mut path = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let close = rest[open..]
            .find('}')
            .map(|c| open + c)
            .ok_or_else(|| ToolError::new(format!("bad path template {template}")))?;
        let name = &rest[open + 1..close];
        let value = args
            .remove(name)
            .and_then(|v| match v {
                Value::String(s) => Some(s),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| ToolError::new(format!("`{name}` is required")))?;
        path.push_str(&rest[..open]);
        path.push_str(&encode_segment(&value));
        rest = &rest[close + 1..];
    }
    path.push_str(rest);
    Ok((path, args))
}

/// Arguments as query parameters: a list repeats its key, an object is sent
/// as JSON, null is left out.
fn query_pairs(args: &Map<String, Value>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (key, value) in args {
        match value {
            Value::Null => {}
            Value::Array(items) => {
                out.extend(items.iter().map(|v| (key.clone(), scalar(v))));
            }
            v => out.push((key.clone(), scalar(v))),
        }
    }
    out
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// One path segment, percent-encoded: everything but RFC 3986's unreserved
/// characters, so an id cannot add a segment or a query.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A poll interval and a deadline, for a tool that waits.
pub async fn pause(d: Duration) {
    tokio::time::sleep(d).await;
}

/// `{"type":"object","properties":…,"required":[…]}` without the noise.
pub fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn a_path_argument_is_taken_out_and_encoded() {
        let (path, rest) = fill_path(
            "/studio-domain-model/v1/types/{id}",
            map(json!({"id": "a/b c", "x": 1})),
        )
        .unwrap();
        assert_eq!(path, "/studio-domain-model/v1/types/a%2Fb%20c");
        assert_eq!(rest, map(json!({"x": 1})));
    }

    #[test]
    fn a_missing_path_argument_is_named() {
        let err = fill_path("/t/{id}", Map::new()).unwrap_err();
        assert_eq!(err, ToolError::new("`id` is required"));
    }

    #[test]
    fn a_list_repeats_its_key_and_null_is_left_out() {
        let pairs = query_pairs(&map(json!({"path": ["a", "b"], "n": 2, "z": null})));
        assert_eq!(
            pairs,
            vec![
                ("n".to_owned(), "2".to_owned()),
                ("path".to_owned(), "a".to_owned()),
                ("path".to_owned(), "b".to_owned()),
            ]
        );
    }

    #[test]
    fn a_refusal_says_what_the_route_said() {
        assert_eq!(
            refusal(400, r#"{"title":"Bad","detail":"type `x` is unknown"}"#),
            "Studio answered 400: type `x` is unknown"
        );
        assert_eq!(
            refusal(502, "gateway down"),
            "Studio answered 502: gateway down"
        );
        assert_eq!(refusal(500, ""), "Studio answered 500: no detail");
    }
}
