//! What a tool is, and the one way it reaches Studio: the REST API, as the
//! person calling it.
//!
//! A tool never calls a service in process. It sends the request the portal
//! would send, to this backend's own gateway, with the caller's own
//! `Authorization` header, so the authentication, the tenant clamp, the PDP
//! and every check a route makes apply to a tool call exactly as they apply
//! to the portal. An agent cannot do more through MCP than its person can do
//! in the browser, and a route that changes its rules changes them for both.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    /// What a call does to Studio, told to the agent as MCP's annotations so
    /// it can ask its person before a change.
    pub effect: Effect,
    /// May still change shape or go away; said first in the description.
    pub experimental: bool,
    pub run: Run,
}

/// What a tool call does to what Studio holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// Reads or checks; changes nothing a person sees.
    Read,
    /// Adds to what is there, and can be undone.
    Write,
    /// Changes or removes what is there. Still undoable where the owner
    /// records a version, but the agent should say what it will do first.
    Destructive,
}

impl Effect {
    /// MCP's tool annotations (`readOnlyHint` and the rest).
    pub fn annotations(self) -> Value {
        json!({
            "readOnlyHint": self == Effect::Read,
            "destructiveHint": self == Effect::Destructive,
            "idempotentHint": self == Effect::Read,
            "openWorldHint": false,
        })
    }
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
    /// `PUT path`, the arguments as the JSON body, except those named in
    /// `query`, which go in the query string.
    Put {
        path: &'static str,
        query: &'static [&'static str],
    },
    /// `PATCH path`, `{name}`s from the arguments, the rest as the JSON body.
    Patch(&'static str),
    /// `DELETE path`, `{name}`s from the arguments, every other argument a
    /// query parameter; no body is sent.
    Delete(&'static str),
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
    /// Who is calling, for the limits; and the limits.
    who: String,
    limits: Option<Arc<Limits>>,
}

/// How much of a failed answer is passed to the agent.
const MAX_ERROR_CHARS: usize = 4000;

impl Api {
    pub fn new(client: reqwest::Client, base: &str, auth: Option<HeaderValue>) -> Self {
        Self {
            client,
            base: base.trim_end_matches('/').to_owned(),
            auth,
            who: String::new(),
            limits: None,
        }
    }

    /// The same API, counting `who`'s calls against `limits`.
    pub fn acting_for(mut self, who: String, limits: Arc<Limits>) -> Self {
        self.who = who;
        self.limits = Some(limits);
        self
    }

    /// Who is calling: the subject id, for the record of each call.
    pub fn who(&self) -> &str {
        &self.who
    }

    /// Count one `what` for the caller, or say when it may be tried again.
    pub fn take(&self, what: &'static str) -> Result<(), ToolError> {
        let Some(limits) = &self.limits else {
            return Ok(());
        };
        limits.take(&self.who, what, Instant::now()).map_err(|wait| {
            ToolError::new(format!(
                "you have reached the limit of {} `{what}` calls an hour; try again in {} minutes",
                limits.per_hour(what),
                wait.as_secs().div_ceil(60).max(1)
            ))
        })
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

    pub async fn put(
        &self,
        path: &str,
        query: &[(String, String)],
        body: &Value,
    ) -> Result<Value, ToolError> {
        self.send(self.client.put(self.url(path)).query(query).json(body))
            .await
    }

    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value, ToolError> {
        self.send(self.client.patch(self.url(path)).json(body))
            .await
    }

    pub async fn delete(&self, path: &str, query: &[(String, String)]) -> Result<Value, ToolError> {
        self.send(self.client.delete(self.url(path)).query(query))
            .await
    }

    /// `GET`, answering the status with the body whatever the status: for a
    /// tool to which a refusal is an answer (404: nothing there yet).
    pub async fn get_answer(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<Answer, ToolError> {
        self.exchange(self.client.get(self.url(path)).query(query))
            .await
    }

    /// `POST`, answering the status with the body whatever the status: for a
    /// tool to which a refusal is an answer (409: saved against a stale base).
    pub async fn post_answer(
        &self,
        path: &str,
        query: &[(String, String)],
        body: &Value,
    ) -> Result<Answer, ToolError> {
        self.exchange(self.client.post(self.url(path)).query(query).json(body))
            .await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, ToolError> {
        let answer = self.exchange(req).await?;
        if !answer.ok() {
            return Err(answer.refusal());
        }
        Ok(answer.body)
    }

    async fn exchange(&self, req: reqwest::RequestBuilder) -> Result<Answer, ToolError> {
        let req = match &self.auth {
            Some(auth) => req.header(axum::http::header::AUTHORIZATION, auth.clone()),
            None => req,
        };
        let res = req
            .send()
            .await
            .map_err(|e| ToolError::new(format!("Studio did not answer: {e}")))?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        Ok(Answer::new(status, text))
    }
}

/// A route's answer, refusal or not.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    /// The body as JSON; a body that is not JSON as a string; none as null.
    pub body: Value,
    text: String,
}

impl Answer {
    pub fn new(status: u16, text: String) -> Self {
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()))
        };
        Self { status, body, text }
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The refusal, in the words the route used, as any tool reports it.
    pub fn refusal(&self) -> ToolError {
        ToolError::new(refusal(self.status, &self.text))
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
    if let Run::Custom(run) = &tool.run {
        return run(api, args).await;
    }
    let req = request(&tool.run, args)?;
    match req.method {
        Method::Get => api.get(&req.path, &req.query).await,
        Method::Post => api.post(&req.path, &req.query, &req.body).await,
        Method::Put => api.put(&req.path, &req.query, &req.body).await,
        Method::Patch => api.patch(&req.path, &req.body).await,
        Method::Delete => api.delete(&req.path, &req.query).await,
    }
}

/// The method of the request a [`Run`] sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

/// The one request a [`Run`] other than `Custom` makes of the arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: Method,
    pub path: String,
    pub query: Vec<(String, String)>,
    /// `null` for a request without a body.
    pub body: Value,
}

/// What `run` sends for `args`, without sending it. `Custom` makes no one
/// request and is refused.
pub fn request(run: &Run, args: Map<String, Value>) -> Result<Request, ToolError> {
    let (method, template, in_query): (Method, &str, Option<&[&str]>) = match run {
        Run::Get(path) => (Method::Get, path, None),
        Run::Delete(path) => (Method::Delete, path, None),
        Run::Post { path, query } => (Method::Post, path, Some(query)),
        Run::Put { path, query } => (Method::Put, path, Some(query)),
        Run::Patch(path) => (Method::Patch, path, Some(&[])),
        Run::Custom(_) => {
            return Err(ToolError::new("this tool makes more than one request"));
        }
    };
    let (path, mut rest) = fill_path(template, args)?;
    // Without a body every other argument is a query parameter; with one,
    // only those named.
    let Some(names) = in_query else {
        return Ok(Request {
            method,
            path,
            query: query_pairs(&rest),
            body: Value::Null,
        });
    };
    let mut q = Map::new();
    for name in names {
        if let Some(v) = rest.remove(*name) {
            q.insert((*name).to_owned(), v);
        }
    }
    Ok(Request {
        method,
        path,
        query: query_pairs(&q),
        body: Value::Object(rest),
    })
}

/// How many of a kind of call one person may make in an hour, counted per
/// replica: a guard against an agent calling in a loop, not a quota.
pub struct Limits {
    per_hour: HashMap<&'static str, u32>,
    seen: Mutex<HashMap<(String, &'static str), VecDeque<Instant>>>,
}

const HOUR: Duration = Duration::from_secs(3600);

impl Limits {
    /// `0` means no limit for that kind.
    pub fn new(per_hour: impl IntoIterator<Item = (&'static str, u32)>) -> Self {
        Self {
            per_hour: per_hour.into_iter().filter(|(_, n)| *n > 0).collect(),
            seen: Mutex::new(HashMap::new()),
        }
    }

    pub fn per_hour(&self, what: &str) -> u32 {
        self.per_hour.get(what).copied().unwrap_or(0)
    }

    /// Count one call at `now`, or answer how long until one is allowed.
    pub fn take(&self, who: &str, what: &'static str, now: Instant) -> Result<(), Duration> {
        let Some(&limit) = self.per_hour.get(what) else {
            return Ok(());
        };
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let calls = seen.entry((who.to_owned(), what)).or_default();
        while calls
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= HOUR)
        {
            calls.pop_front();
        }
        if calls.len() >= limit as usize {
            let oldest = calls.front().copied().unwrap_or(now);
            return Err(HOUR.saturating_sub(now.saturating_duration_since(oldest)));
        }
        calls.push_back(now);
        Ok(())
    }
}

/// `/types/{id}` with `id` taken out of the arguments and put in the path.
pub fn fill_path(
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
pub fn query_pairs(args: &Map<String, Value>) -> Vec<(String, String)> {
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

/// A text argument that must be there and not blank.
pub fn required_text(args: &Map<String, Value>, name: &str) -> Result<String, ToolError> {
    optional_text(args, name).ok_or_else(|| ToolError::new(format!("`{name}` is required")))
}

/// A text argument, when it is given and not blank.
pub fn optional_text(args: &Map<String, Value>, name: &str) -> Option<String> {
    match args.get(name)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The `project_id` argument, as every project tool describes it.
pub fn project_id() -> Value {
    json!({ "type": "string",
        "description": "The project: the id in the portal's address of that project (its tenant id)." })
}

/// For a gear's tests: the request the tool called `name` in `tools` sends
/// for `args`.
#[cfg(test)]
pub fn request_of(tools: &[Tool], name: &str, args: Value) -> Request {
    let tool = tools
        .iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("no tool {name}"));
    let args = args.as_object().cloned().unwrap_or_default();
    request(&tool.run, args).unwrap_or_else(|e| panic!("{name}: {}", e.0))
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
    fn a_put_sends_the_named_arguments_in_the_query_and_the_rest_as_the_body() {
        let req = request(
            &Run::Put {
                path: "/s/{key}",
                query: &["project_id"],
            },
            map(json!({"key": "K", "project_id": "p", "value": "v"})),
        )
        .unwrap();
        assert_eq!(req.method, Method::Put);
        assert_eq!(req.path, "/s/K");
        assert_eq!(req.query, vec![("project_id".to_owned(), "p".to_owned())]);
        assert_eq!(req.body, json!({"value": "v"}));
    }

    #[test]
    fn a_delete_sends_what_is_not_in_the_path_as_the_query() {
        let req = request(
            &Run::Delete("/s/{key}"),
            map(json!({"key": "K", "project_id": "p"})),
        )
        .unwrap();
        assert_eq!(req.method, Method::Delete);
        assert_eq!(req.query, vec![("project_id".to_owned(), "p".to_owned())]);
        assert_eq!(req.body, Value::Null);
    }

    #[test]
    fn an_answer_reads_its_body_and_says_its_refusal() {
        let a = Answer::new(409, r#"{"message":"stale"}"#.to_owned());
        assert!(!a.ok());
        assert_eq!(a.body["message"], "stale");
        assert_eq!(a.refusal(), ToolError::new("Studio answered 409: stale"));
        assert_eq!(Answer::new(204, String::new()).body, Value::Null);
    }

    #[test]
    fn a_text_argument_is_trimmed_and_blank_is_absent() {
        let args = map(json!({"a": " x ", "b": "  ", "n": 3}));
        assert_eq!(optional_text(&args, "a").as_deref(), Some("x"));
        assert_eq!(optional_text(&args, "b"), None);
        assert_eq!(optional_text(&args, "n").as_deref(), Some("3"));
        assert_eq!(
            required_text(&args, "b").unwrap_err(),
            ToolError::new("`b` is required")
        );
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
    fn a_limit_counts_per_person_and_frees_up_after_an_hour() {
        let limits = Limits::new([("spec_check", 2), ("free", 0)]);
        let t0 = Instant::now();
        assert!(limits.take("ann", "spec_check", t0).is_ok());
        assert!(limits.take("ann", "spec_check", t0).is_ok());
        let wait = limits.take("ann", "spec_check", t0 + Duration::from_secs(600));
        assert_eq!(wait, Err(Duration::from_secs(3000)));
        assert!(limits.take("bob", "spec_check", t0).is_ok());
        assert!(limits.take("ann", "spec_check", t0 + HOUR).is_ok());
        for _ in 0..10 {
            assert!(limits.take("ann", "free", t0).is_ok());
        }
    }

    #[test]
    fn only_a_read_is_read_only_and_only_a_change_is_destructive() {
        assert_eq!(Effect::Read.annotations()["readOnlyHint"], true);
        assert_eq!(Effect::Write.annotations()["readOnlyHint"], false);
        assert_eq!(Effect::Write.annotations()["destructiveHint"], false);
        assert_eq!(Effect::Destructive.annotations()["destructiveHint"], true);
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
