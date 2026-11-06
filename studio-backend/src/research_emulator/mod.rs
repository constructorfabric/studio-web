//! `studio-backend research-emulator`: a stand-in for Constructor Research,
//! for as long as Studio cannot reach a real one (ADR-0049).
//!
//! It answers exactly what Studio calls (ADR-0049 §6), on one origin as a
//! stand does: the identity provider's sign-in and token (`/idp`), the account
//! API (`/api/platform-account`), a desk's files over WebDAV
//! (`/api/platform-storage`) and an image build's log (`/api/platform-keeper`).
//! Ids are 32 hex characters, refusals are `{"detail": {"msg", "error_code"}}`,
//! and statuses move with time: a desk starts, an image builds, a service
//! comes up.
//!
//! Nothing is really built or run. An image "builds" by reading its
//! Dockerfile from the desk's files: it fails when the file is missing, when
//! it says `research-emulator: fail`, or when the dashboard asks the next
//! build to fail. A service's public link opens a page describing what would
//! run.
//!
//! A request the restricted gateway in front of the real Research would
//! refuse (another method, another path) is answered 404/405 and marked on the
//! dashboard (`/_emulator`), so a change in what Studio calls shows up here
//! first.
//!
//! The process is separate from the server (`studio-backend run`) and needs
//! no profile, database or Keycloak.

mod pages;
mod state;

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State as AxState;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use state::{
    App, Call, Desk, Env, Image, Key, Port, Service, State, Token, new_id, now_ms, rfc3339,
};

/// The command line of `studio-backend research-emulator`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Where to listen.
    #[arg(long, env = "RESEARCH_EMULATOR_LISTEN", default_value = "0.0.0.0:8095")]
    pub listen: String,
    /// Where browsers and Studio reach it, with any path prefix: e.g.
    /// `http://research.localhost:8095`, or
    /// `https://studio-dev.example.org/research-emulator` behind an ingress.
    /// Studio's `issuer` is this plus `/idp`, its `api_url` this plus
    /// `/api/platform-account/v1`.
    #[arg(
        long,
        env = "RESEARCH_EMULATOR_PUBLIC_URL",
        default_value = "http://research.localhost:8095"
    )]
    pub public_url: String,
    /// The client Studio signs in as.
    #[arg(
        long,
        env = "RESEARCH_EMULATOR_CLIENT_ID",
        default_value = "constructor-studio"
    )]
    pub client_id: String,
    #[arg(
        long,
        env = "RESEARCH_EMULATOR_CLIENT_SECRET",
        default_value = "research-emulator"
    )]
    pub client_secret: String,
    /// The callback pages a sign-in may come back to, comma-separated; empty
    /// allows any.
    #[arg(long, env = "RESEARCH_EMULATOR_REDIRECT_URIS", default_value = "")]
    pub redirect_uris: String,
    /// Keep members, keys, projects and what runs across restarts in this
    /// JSON file. The desks' files are kept in memory only.
    #[arg(long, env = "RESEARCH_EMULATOR_STATE_FILE")]
    pub state_file: Option<PathBuf>,
    /// How long a desk takes to start.
    #[arg(long, env = "RESEARCH_EMULATOR_DESK_SECONDS", default_value_t = 5)]
    pub desk_seconds: u64,
    /// How long an image takes to build.
    #[arg(long, env = "RESEARCH_EMULATOR_BUILD_SECONDS", default_value_t = 20)]
    pub build_seconds: u64,
    /// How long a service takes to come up.
    #[arg(long, env = "RESEARCH_EMULATOR_START_SECONDS", default_value_t = 5)]
    pub start_seconds: u64,
}

/// What a running emulator is configured with.
#[derive(Debug, Clone)]
pub struct Config {
    /// The public URL, without a trailing `/`.
    pub public_url: String,
    /// Its path, the prefix every route sits under (`""` or `/x`).
    pub base_path: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uris: Vec<String>,
    pub state_file: Option<PathBuf>,
    pub timings: Timings,
}

impl Config {
    pub fn from_args(a: &Args) -> anyhow::Result<Self> {
        let public_url = a.public_url.trim().trim_end_matches('/').to_owned();
        let parsed = reqwest::Url::parse(&public_url)
            .with_context(|| format!("--public-url {public_url} is not a URL"))?;
        let base_path = parsed.path().trim_end_matches('/').to_owned();
        Ok(Self {
            public_url,
            base_path,
            client_id: a.client_id.trim().to_owned(),
            client_secret: a.client_secret.trim().to_owned(),
            redirect_uris: a
                .redirect_uris
                .split(',')
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_owned)
                .collect(),
            state_file: a.state_file.clone(),
            timings: Timings {
                desk: Duration::from_secs(a.desk_seconds),
                build: Duration::from_secs(a.build_seconds),
                start: Duration::from_secs(a.start_seconds),
            },
        })
    }
}

/// The emulator: its configuration and what it keeps.
pub struct Emulator {
    cfg: Config,
    state: Mutex<State>,
}

type Shared = Arc<Emulator>;

impl Emulator {
    pub fn new(cfg: Config) -> anyhow::Result<Shared> {
        let state = match &cfg.state_file {
            Some(p) => State::load(p).with_context(|| format!("reading {}", p.display()))?,
            None => State::default(),
        };
        Ok(Arc::new(Self {
            cfg,
            state: Mutex::new(state),
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A handler that panicked mid-change leaves the state as it was; go on.
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self) {
        if let Some(p) = &self.cfg.state_file
            && let Err(e) = self.lock().save(p)
        {
            eprintln!("research-emulator: could not save {}: {e:#}", p.display());
        }
    }

    /// The requests the restricted gateway would have refused, for tests.
    #[cfg(test)]
    pub fn off_list_calls(&self) -> Vec<String> {
        self.lock()
            .calls
            .iter()
            .filter(|c| c.off_list)
            .map(|c| format!("{} {}", c.method, c.path))
            .collect()
    }

    fn link(&self, service: &str) -> String {
        format!("{}/_apps/{service}/", self.cfg.public_url)
    }
}

/// The emulator's routes, on `cfg.base_path`.
pub fn router(emu: Shared) -> Router {
    Router::new().fallback(handle).with_state(emu)
}

/// `studio-backend research-emulator`: serve until stopped.
pub async fn run(args: &Args) -> anyhow::Result<()> {
    let cfg = Config::from_args(args)?;
    let emu = Emulator::new(cfg.clone())?;
    let listener = tokio::net::TcpListener::bind(&args.listen)
        .await
        .with_context(|| format!("listening on {}", args.listen))?;
    println!(
        "research-emulator: listening on {}; Studio's research issuer is {}/idp and its api_url {}/api/platform-account/v1; the dashboard is {}/_emulator",
        args.listen, cfg.public_url, cfg.public_url, cfg.public_url
    );
    axum::serve(listener, router(emu))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

/// The emulator on a free local port, for tests: its public URL.
#[cfg(test)]
pub async fn spawn_for_tests(timings: Timings) -> (String, Shared) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public_url = format!("http://{}", listener.local_addr().unwrap());
    let emu = Emulator::new(Config {
        public_url: public_url.clone(),
        base_path: String::new(),
        client_id: "constructor-studio".into(),
        client_secret: "s3cret".into(),
        redirect_uris: vec!["https://studio.example/connections/oauth/callback".into()],
        state_file: None,
        timings,
    })
    .unwrap();
    let app = router(emu.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (public_url, emu)
}

pub use state::Timings;

/* ── answers ── */

/// A refusal the way Research words one.
fn refusal(status: StatusCode, msg: &str) -> Response {
    let code = 4000 + u32::from(status.as_u16() % 100);
    (
        status,
        axum::Json(json!({ "detail": { "msg": msg, "error_code": code } })),
    )
        .into_response()
}

fn not_found(what: &str) -> Response {
    refusal(StatusCode::NOT_FOUND, &format!("{what} not found"))
}

fn results(items: Vec<Value>) -> Response {
    axum::Json(json!({ "total": items.len(), "results": items })).into_response()
}

fn oauth_error(error: &str, description: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": error, "error_description": description })),
    )
        .into_response()
}

/// `a=1&b=2`, decoded.
fn form(text: &str) -> std::collections::HashMap<String, String> {
    reqwest::Url::parse(&format!("http://form/?{text}"))
        .map(|u| u.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

/// A path segment or path with `%XX` escapes undone.
fn unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ── the one handler ── */

async fn handle(
    AxState(emu): AxState<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let full = uri.path().to_owned();
    let Some(path) = full
        .strip_prefix(emu.cfg.base_path.as_str())
        .map(|p| {
            if p.is_empty() {
                "/".to_owned()
            } else {
                p.to_owned()
            }
        })
        .filter(|p| p.starts_with('/'))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let query = uri.query().unwrap_or("").to_owned();
    let (res, off_list) = route(&emu, &method, &path, &query, &headers, body);
    let status = res.status().as_u16();
    // The dashboard's own polling would drown everything else.
    if !path.starts_with("/_emulator") && path != "/healthz" {
        emu.lock().record(Call {
            at_ms: now_ms(),
            method: method.to_string(),
            path: path.clone(),
            status,
            off_list,
        });
        println!(
            "research-emulator: {method} {path} -> {status}{}",
            if off_list {
                " (off the gateway allowlist)"
            } else {
                ""
            }
        );
    }
    if method != Method::GET && method != Method::HEAD {
        emu.save();
    }
    res
}

/// The answer, and whether the request is one the restricted gateway would
/// refuse.
fn route(
    emu: &Shared,
    method: &Method,
    path: &str,
    query: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> (Response, bool) {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let m = method.as_str();
    let res = match (m, parts.as_slice()) {
        ("GET", [""]) => Redirect::to(&format!("{}/_emulator", emu.cfg.base_path)).into_response(),
        ("GET", ["healthz"]) => "ok".into_response(),
        ("GET", ["_emulator"]) => {
            let now = now_ms();
            let mut st = emu.lock();
            st.advance(now, emu.cfg.timings);
            Html(pages::dashboard(&emu.cfg, &st, now)).into_response()
        }
        ("POST", ["_emulator", "fail-next-build"]) => {
            let mut st = emu.lock();
            st.fail_next_build = !st.fail_next_build;
            Redirect::to(&format!("{}/_emulator", emu.cfg.base_path)).into_response()
        }
        ("POST", ["_emulator", "reset"]) => {
            *emu.lock() = State::default();
            Redirect::to(&format!("{}/_emulator", emu.cfg.base_path)).into_response()
        }
        ("GET", ["_apps", s, ..]) => {
            let now = now_ms();
            let mut st = emu.lock();
            st.advance(now, emu.cfg.timings);
            match st.services.get(*s) {
                Some(svc) => Html(pages::service(&st, svc)).into_response(),
                None => (StatusCode::NOT_FOUND, Html(pages::no_service(s))).into_response(),
            }
        }

        // The identity provider. The browser opens authorize; Studio's
        // backend calls token, the one /idp path on the gateway.
        ("GET", ["idp", "connect", "authorize"]) => authorize_page(emu, &form(query)),
        ("POST", ["idp", "connect", "authorize"]) => {
            authorize_submit(emu, &form(&String::from_utf8_lossy(&body)))
        }
        ("POST", ["idp", "connect", "token"]) => token(emu, &form(&String::from_utf8_lossy(&body))),

        ("POST", ["api", "platform-account", "access-keys"]) => make_key(emu, headers, &body),
        (_, ["api", "platform-account", "v1", rest @ ..]) => account(emu, m, rest, headers, &body),
        (
            _,
            [
                "api",
                "platform-storage",
                "desks",
                d,
                "dav",
                "project",
                rest @ ..,
            ],
        ) => {
            if !matches!(m, "MKCOL" | "PUT" | "GET" | "DELETE") {
                return (
                    refusal(
                        StatusCode::METHOD_NOT_ALLOWED,
                        &format!("{m} is not on the gateway allowlist"),
                    ),
                    true,
                );
            }
            dav(emu, m, d, &rest.join("/"), headers, body)
        }
        ("GET", ["api", "platform-keeper", "image-builds", i, "logs"]) => build_logs(emu, i),
        _ => {
            return (
                refusal(
                    StatusCode::NOT_FOUND,
                    &format!("{m} {path} is not a route Studio calls"),
                ),
                true,
            );
        }
    };
    let off_list = res.headers().contains_key("x-emulator-off-list");
    (res, off_list)
}

/* ── the identity provider ── */

fn authorize_page(emu: &Shared, q: &std::collections::HashMap<String, String>) -> Response {
    if let Err(e) = check_authorize(emu, q) {
        return (StatusCode::BAD_REQUEST, Html(pages::sign_in_error(&e))).into_response();
    }
    let st = emu.lock();
    Html(pages::sign_in(&emu.cfg, q, &st)).into_response()
}

fn check_authorize(
    emu: &Shared,
    q: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
    if get("response_type") != "code" {
        return Err("response_type must be `code`".into());
    }
    if get("client_id") != emu.cfg.client_id {
        return Err(format!("unknown client `{}`", get("client_id")));
    }
    let redirect = get("redirect_uri");
    if redirect.is_empty()
        || (!emu.cfg.redirect_uris.is_empty()
            && !emu.cfg.redirect_uris.iter().any(|r| r == redirect))
    {
        return Err(format!(
            "redirect_uri `{redirect}` is not registered for the client"
        ));
    }
    if get("code_challenge").is_empty() || get("code_challenge_method") != "S256" {
        return Err("PKCE with code_challenge_method=S256 is required".into());
    }
    Ok(())
}

fn authorize_submit(emu: &Shared, f: &std::collections::HashMap<String, String>) -> Response {
    if let Err(e) = check_authorize(emu, f) {
        return (StatusCode::BAD_REQUEST, Html(pages::sign_in_error(&e))).into_response();
    }
    let get = |k: &str| f.get(k).map(String::as_str).unwrap_or("");
    let email = get("email").trim();
    if !email.contains('@') {
        return (
            StatusCode::BAD_REQUEST,
            Html(pages::sign_in_error("an email is required")),
        )
            .into_response();
    }
    let code = new_id();
    {
        let mut st = emu.lock();
        let user_id = st.sign_in(email, get("first_name"), get("last_name"));
        st.grants.insert(
            code.clone(),
            state::Grant {
                client_id: get("client_id").to_owned(),
                redirect_uri: get("redirect_uri").to_owned(),
                challenge: get("code_challenge").to_owned(),
                user_id,
                expires_ms: now_ms() + 5 * 60 * 1000,
            },
        );
    }
    let mut back = match reqwest::Url::parse(get("redirect_uri")) {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Html(pages::sign_in_error("redirect_uri is not a URL")),
            )
                .into_response();
        }
    };
    back.query_pairs_mut()
        .append_pair("code", &code)
        .append_pair("state", get("state"));
    Redirect::to(back.as_str()).into_response()
}

fn token(emu: &Shared, f: &std::collections::HashMap<String, String>) -> Response {
    let get = |k: &str| f.get(k).map(String::as_str).unwrap_or("");
    if get("client_id") != emu.cfg.client_id || get("client_secret") != emu.cfg.client_secret {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "invalid_client" })),
        )
            .into_response();
    }
    let now = now_ms();
    let mut st = emu.lock();
    let user_id = match get("grant_type") {
        "authorization_code" => {
            let Some(g) = st.grants.remove(get("code")) else {
                return oauth_error("invalid_grant", "the code is unknown or was used");
            };
            if g.expires_ms < now {
                return oauth_error("invalid_grant", "the code expired");
            }
            if g.client_id != get("client_id") || g.redirect_uri != get("redirect_uri") {
                return oauth_error(
                    "invalid_grant",
                    "the code was issued to another client or redirect_uri",
                );
            }
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(get("code_verifier").as_bytes()));
            if challenge != g.challenge {
                return oauth_error(
                    "invalid_grant",
                    "the code_verifier does not match the code_challenge",
                );
            }
            g.user_id
        }
        "refresh_token" => match st.refresh_tokens.remove(get("refresh_token")) {
            Some(u) => u,
            None => return oauth_error("invalid_grant", "the refresh token is unknown"),
        },
        other => return oauth_error("unsupported_grant_type", other),
    };
    let access = new_id();
    let refresh = new_id();
    st.idp_tokens.insert(
        access.clone(),
        Token {
            user_id: user_id.clone(),
            expires_ms: now + 3600 * 1000,
        },
    );
    st.refresh_tokens.insert(refresh.clone(), user_id);
    axum::Json(json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": refresh,
        "scope": "openid profile user platform",
    }))
    .into_response()
}

/* ── who is calling ── */

enum Caller {
    /// A member, by an access key or an identity provider token.
    Member {
        user: String,
        by_key: bool,
    },
    None(Response),
}

fn caller(st: &State, headers: &HeaderMap) -> Caller {
    let header = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(str::trim);
    let bearer = |v: &str| v.strip_prefix("Bearer ").unwrap_or(v).trim().to_owned();
    let now = now_ms();
    if let Some(v) = header("x-research-accesskey") {
        let key = bearer(v);
        return match st.keys.get(&key) {
            Some(k) if key_live(k, now) => Caller::Member {
                user: k.user_id.clone(),
                by_key: true,
            },
            Some(_) => Caller::None(refusal(StatusCode::UNAUTHORIZED, "The access key expired")),
            None => Caller::None(refusal(StatusCode::UNAUTHORIZED, "Invalid access key")),
        };
    }
    if let Some(v) = header("authorization") {
        let t = bearer(v);
        return match st.idp_tokens.get(&t) {
            Some(tok) if tok.expires_ms > now => Caller::Member {
                user: tok.user_id.clone(),
                by_key: false,
            },
            _ => Caller::None(refusal(StatusCode::UNAUTHORIZED, "Not authenticated")),
        };
    }
    Caller::None(refusal(StatusCode::UNAUTHORIZED, "Not authenticated"))
}

/// An access key until its `expires_at`.
fn key_live(k: &Key, now: u64) -> bool {
    chrono::DateTime::parse_from_rfc3339(&k.expires_at)
        .map(|t| (t.timestamp_millis() as u64) > now)
        .unwrap_or(true)
}

fn make_key(emu: &Shared, headers: &HeaderMap, body: &Bytes) -> Response {
    let mut st = emu.lock();
    let user = match caller(&st, headers) {
        Caller::Member { by_key: true, .. } => {
            return refusal(
                StatusCode::FORBIDDEN,
                "An access key cannot create access keys",
            );
        }
        Caller::Member { user, .. } => user,
        Caller::None(r) => return r,
    };
    let b: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let name = b["name"].as_str().unwrap_or("").trim().to_owned();
    let expires_at = b["expires_at"].as_str().unwrap_or("").to_owned();
    if name.is_empty() || chrono::DateTime::parse_from_rfc3339(&expires_at).is_err() {
        return refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "name and an RFC 3339 expires_at are required",
        );
    }
    let key = format!("rk-{}", new_id());
    let id = new_id();
    st.keys.insert(
        key.clone(),
        Key {
            id: id.clone(),
            name: name.clone(),
            user_id: user,
            expires_at: expires_at.clone(),
            created_ms: now_ms(),
        },
    );
    axum::Json(json!({ "id": id, "name": name, "key": key, "expires_at": expires_at }))
        .into_response()
}

/* ── the account API ── */

const HARDWARE: [(&str, &str, f64, u32, bool, bool); 3] = [
    (
        "5f2c1a7e9b3d4e6f8a0b1c2d3e4f5a60",
        "CPU S",
        2.0,
        4,
        true,
        false,
    ),
    (
        "6a3d2b8f0c4e4f7a9b1c2d3e4f5a6b71",
        "CPU M",
        4.0,
        16,
        false,
        false,
    ),
    (
        "7b4e3c9a1d5f4a8b8c2d3e4f5a6b7c82",
        "GPU A10",
        8.0,
        32,
        false,
        true,
    ),
];

fn desk_json(d: &Desk) -> Value {
    json!({ "id": d.id, "name": d.name, "project_id": d.project_id, "filesystem": { "status": d.status } })
}

fn image_json(i: &Image, now: u64, t: Timings) -> Value {
    json!({ "id": i.id, "name": i.name, "desk_id": i.desk_id, "dockerfile": i.dockerfile,
            "build_status": i.status(now, t) })
}

fn service_json(emu: &Shared, s: &Service) -> Value {
    let link = s
        .ports
        .iter()
        .any(|p| p.expose_to_internet)
        .then(|| emu.link(&s.id));
    json!({ "id": s.id, "name": s.name, "image_id": s.image_id,
            "hardware_configuration_id": s.hardware_configuration_id, "volumes": s.volumes,
            "ports": s.ports.iter().map(|p| json!({ "number": p.number, "expose_to_internet": p.expose_to_internet })).collect::<Vec<_>>(),
            "environment_variables": s.environment_variables.iter().map(|e| json!({ "name": e.name, "value": e.value })).collect::<Vec<_>>(),
            "status": s.status, "link": link })
}

fn app_json(emu: &Shared, st: &State, a: &App) -> Value {
    let services: Vec<Value> = st
        .services
        .values()
        .filter(|s| s.app_id == a.id)
        .map(|s| service_json(emu, s))
        .collect();
    json!({ "id": a.id, "project_id": a.project_id, "name": a.name, "created_at": a.created_at, "services": services })
}

fn account(emu: &Shared, m: &str, rest: &[&str], headers: &HeaderMap, body: &Bytes) -> Response {
    let now = now_ms();
    let t = emu.cfg.timings;
    let mut st = emu.lock();
    st.advance(now, t);
    let user = match caller(&st, headers) {
        Caller::Member { user, .. } => user,
        Caller::None(r) => return r,
    };
    let b: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let owns =
        |st: &State, project: &str| st.projects.get(project).is_some_and(|p| p.owner == user);
    let rest: Vec<String> = rest.iter().map(|s| unescape(s)).collect();
    let rest: Vec<&str> = rest.iter().map(String::as_str).collect();

    match (m, rest.as_slice()) {
        ("GET", ["auth", "session"]) => {
            let Some(u) = st.users.get(&user) else {
                return refusal(StatusCode::UNAUTHORIZED, "Not authenticated");
            };
            axum::Json(json!({
                "user": { "id": u.id, "email": u.email, "first_name": u.first_name, "last_name": u.last_name, "status": "active" },
                "refresh_interval": 300, "config": {}, "state": "active"
            }))
            .into_response()
        }
        ("GET", ["projects"]) => results(
            st.projects
                .values()
                .filter(|p| p.owner == user)
                .map(|p| json!({ "id": p.id, "name": p.name, "archived": false, "multi_desk": true }))
                .collect(),
        ),
        // Studio reads a project before changing its applications, to turn its
        // deployments on (`enable_deployment`); the emulator's are always on.
        ("GET" | "PATCH", ["projects", p]) => match st.projects.get(*p).filter(|_| owns(&st, p)) {
            Some(p) => axum::Json(json!({
                "id": p.id, "name": p.name, "archived": false, "multi_desk": true,
                "deployment_enabled": true
            }))
            .into_response(),
            None => not_found("Project"),
        },
        ("GET", ["projects", p, "hardware-configurations"]) => {
            if !owns(&st, p) {
                return not_found("Project");
            }
            results(
                HARDWARE
                    .iter()
                    .map(|(id, name, cpu, ram, trial, gpu)| {
                        json!({ "id": id, "name": name, "cpu_count": cpu, "ram_gb": ram,
                                "available_for_trial": trial,
                                "gpu": if *gpu { json!({ "name": "A10", "vram_gb": 24, "amount": 1 }) } else { Value::Null } })
                    })
                    .collect(),
            )
        }

        ("GET", ["projects", p, "desks"]) => {
            if !owns(&st, p) {
                return not_found("Project");
            }
            results(st.desks.values().filter(|d| d.project_id == *p).map(desk_json).collect())
        }
        ("POST", ["projects", p, "desks"]) => {
            if !owns(&st, p) {
                return not_found("Project");
            }
            let name = b["name"].as_str().unwrap_or("").trim().to_owned();
            if name.is_empty() {
                return refusal(StatusCode::UNPROCESSABLE_ENTITY, "A desk needs a name");
            }
            if st.desks.values().any(|d| d.project_id == *p && d.name == name) {
                return refusal(StatusCode::CONFLICT, "A desk with this name already exists");
            }
            let d = Desk {
                id: new_id(),
                project_id: (*p).to_owned(),
                name,
                status: "not_started".into(),
                since_ms: now,
            };
            let out = desk_json(&d);
            st.desks.insert(d.id.clone(), d);
            axum::Json(out).into_response()
        }
        (_, ["desks", d, ..]) if !st.desks.get(*d).is_some_and(|x| owns(&st, &x.project_id)) => not_found("Desk"),
        ("GET", ["desks", d]) => axum::Json(desk_json(&st.desks[*d])).into_response(),
        ("POST", ["desks", d, "filesystem"]) => {
            let desk = st.desks.get_mut(*d).unwrap();
            if matches!(desk.status.as_str(), "not_started" | "stopping") {
                desk.status = "starting".into();
                desk.since_ms = now;
            }
            let out = desk_json(desk);
            axum::Json(out).into_response()
        }
        ("DELETE", ["desks", d, "filesystem"]) => {
            let desk = st.desks.get_mut(*d).unwrap();
            if desk.status != "not_started" {
                desk.status = "stopping".into();
                desk.since_ms = now;
            }
            let out = desk_json(desk);
            axum::Json(out).into_response()
        }
        ("POST", ["desks", d, "images"]) => {
            let desk = st.desks[*d].clone();
            if desk.status != "running" {
                return refusal(StatusCode::CONFLICT, "The desk is not running");
            }
            let name = b["name"].as_str().unwrap_or("").to_owned();
            let dockerfile = b["dockerfile"].as_str().unwrap_or("").trim_start_matches('/').to_owned();
            if name.is_empty() || name.len() > 30 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return refusal(StatusCode::UNPROCESSABLE_ENTITY, "An image name is ASCII letters, digits and hyphens, at most 30");
            }
            let text = st
                .files
                .get(&desk.id)
                .and_then(|f| f.files.get(&dockerfile))
                .map(|b| String::from_utf8_lossy(b).into_owned());
            let forced = std::mem::take(&mut st.fail_next_build);
            let (log, fails) = state::build_log(text.as_deref(), &dockerfile, &name, forced);
            let img = Image {
                id: new_id(),
                desk_id: desk.id.clone(),
                project_id: desk.project_id.clone(),
                name,
                dockerfile,
                started_ms: now,
                fails,
                log,
            };
            let mut out = image_json(&img, now, t);
            out["build_status"] = json!("not_started");
            st.images.insert(img.id.clone(), img);
            axum::Json(out).into_response()
        }
        ("GET", ["images", i]) => match st.images.get(*i) {
            Some(img) if owns(&st, &img.project_id) => axum::Json(image_json(img, now, t)).into_response(),
            _ => not_found("Image"),
        },

        ("GET", ["projects", p, "applications"]) => {
            if !owns(&st, p) {
                return not_found("Project");
            }
            results(st.apps.values().filter(|a| a.project_id == *p).map(|a| app_json(emu, &st, a)).collect())
        }
        ("POST", ["projects", p, "applications"]) => {
            if !owns(&st, p) {
                return not_found("Project");
            }
            let name = b["name"].as_str().unwrap_or("").trim().to_owned();
            if name.is_empty() {
                return refusal(StatusCode::UNPROCESSABLE_ENTITY, "An application needs a name");
            }
            if st.apps.values().any(|a| a.project_id == *p && a.name == name) {
                return refusal(StatusCode::CONFLICT, "An application with this name already exists");
            }
            let a = App {
                id: new_id(),
                project_id: (*p).to_owned(),
                name,
                created_at: rfc3339(now),
            };
            let out = app_json(emu, &st, &a);
            st.apps.insert(a.id.clone(), a);
            axum::Json(out).into_response()
        }
        (_, ["applications", a, ..]) if !st.apps.get(*a).is_some_and(|x| owns(&st, &x.project_id)) => not_found("Application"),
        ("GET", ["applications", a]) => axum::Json(app_json(emu, &st, &st.apps[*a])).into_response(),
        ("DELETE", ["applications", a]) => {
            st.apps.remove(*a);
            st.services.retain(|_, s| s.app_id != *a);
            StatusCode::NO_CONTENT.into_response()
        }
        ("POST", ["applications", a, "services"]) => {
            let project = st.apps[*a].project_id.clone();
            let s = match service_from(&st, &b, &project, None) {
                Ok(s) => s,
                Err(why) => return refusal(StatusCode::UNPROCESSABLE_ENTITY, why),
            };
            let s = Service {
                id: new_id(),
                app_id: (*a).to_owned(),
                status: "stopped".into(),
                since_ms: now,
                ..s
            };
            if st.services.values().any(|x| x.app_id == *a && x.name == s.name) {
                return refusal(StatusCode::CONFLICT, "A service with this name already exists");
            }
            let out = service_json(emu, &s);
            st.services.insert(s.id.clone(), s);
            axum::Json(out).into_response()
        }
        ("PATCH", ["applications", a, "services", sid]) => {
            let Some(old) = st.services.get(*sid).filter(|s| s.app_id == *a).cloned() else {
                return not_found("Service");
            };
            let project = st.apps[*a].project_id.clone();
            let s = match service_from(&st, &b, &project, Some(&old)) {
                Ok(s) => s,
                Err(why) => return refusal(StatusCode::UNPROCESSABLE_ENTITY, why),
            };
            let s = Service {
                id: old.id.clone(),
                app_id: old.app_id.clone(),
                status: old.status.clone(),
                since_ms: old.since_ms,
                ..s
            };
            let out = service_json(emu, &s);
            st.services.insert(s.id.clone(), s);
            axum::Json(out).into_response()
        }
        (_, ["services", s, ..])
            if !st
                .services
                .get(*s)
                .and_then(|x| st.apps.get(&x.app_id))
                .is_some_and(|a| owns(&st, &a.project_id)) =>
        {
            not_found("Service")
        }
        ("GET", ["services", s]) => axum::Json(service_json(emu, &st.services[*s])).into_response(),
        ("DELETE", ["services", s]) => {
            st.services.remove(*s);
            StatusCode::NO_CONTENT.into_response()
        }
        ("POST", ["services", s, verb]) if *verb == "start" || *verb == "restart" => {
            let svc = st.services.get_mut(*s).unwrap();
            if !matches!(svc.status.as_str(), "stopped" | "running" | "failed") {
                return refusal(StatusCode::CONFLICT, &format!("The service is {}", svc.status));
            }
            svc.status = "starting".into();
            svc.since_ms = now;
            let out = service_json(emu, svc);
            axum::Json(out).into_response()
        }
        // A changed service is stopped before it starts again on its new
        // image or settings.
        ("POST", ["services", s, "stop"]) => {
            let svc = st.services.get_mut(*s).unwrap();
            svc.status = "stopped".into();
            svc.since_ms = now;
            let out = service_json(emu, svc);
            axum::Json(out).into_response()
        }
        _ => refusal(
            StatusCode::NOT_FOUND,
            &format!("{m} /api/platform-account/v1/{} is not a route Studio calls", rest.join("/")),
        )
        .into_response_marked(),
    }
}

/// A 404 that the handler marks as off the gateway allowlist.
trait Marked {
    fn into_response_marked(self) -> Response;
}

impl Marked for Response {
    fn into_response_marked(mut self) -> Response {
        self.headers_mut()
            .insert("x-emulator-off-list", header::HeaderValue::from_static("1"));
        self
    }
}

/// A service body as Studio sends it, checked: its image built in the same
/// project, its hardware known.
fn service_from(
    st: &State,
    b: &Value,
    project: &str,
    old: Option<&Service>,
) -> Result<Service, &'static str> {
    let name = b["name"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| old.map(|o| o.name.clone()))
        .unwrap_or_default();
    if name.is_empty() {
        return Err("A service needs a name");
    }
    let image_id = b["image_id"].as_str().unwrap_or("").to_owned();
    match st.images.get(&image_id) {
        Some(i) if i.project_id == project => {}
        _ => return Err("image_id is not an image of this project"),
    }
    let hw = b["hardware_configuration_id"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if !HARDWARE.iter().any(|h| h.0 == hw) {
        return Err("hardware_configuration_id is not a configuration of this project");
    }
    let ports: Vec<Port> = serde_json::from_value(b["ports"].clone()).unwrap_or_default();
    let environment_variables: Vec<Env> =
        serde_json::from_value(b["environment_variables"].clone()).unwrap_or_default();
    Ok(Service {
        id: String::new(),
        app_id: String::new(),
        name,
        image_id,
        hardware_configuration_id: hw,
        volumes: if b["volumes"].is_array() {
            b["volumes"].clone()
        } else {
            json!([])
        },
        ports,
        environment_variables,
        status: String::new(),
        since_ms: 0,
    })
}

/* ── a desk's files ── */

fn dav(emu: &Shared, m: &str, desk: &str, rel: &str, headers: &HeaderMap, body: Bytes) -> Response {
    let now = now_ms();
    let mut st = emu.lock();
    st.advance(now, emu.cfg.timings);
    let user = match caller(&st, headers) {
        Caller::Member { user, .. } => user,
        Caller::None(r) => return r,
    };
    let Some(d) = st.desks.get(desk).cloned() else {
        return not_found("Desk");
    };
    if !st
        .projects
        .get(&d.project_id)
        .is_some_and(|p| p.owner == user)
    {
        return not_found("Desk");
    }
    if d.status != "running" {
        return refusal(StatusCode::CONFLICT, "The desk's filesystem is not running");
    }
    let rel = unescape(rel).trim_matches('/').to_owned();
    let files = st.files.entry(d.id).or_default();
    let parent_ok = |files: &state::DeskFiles, p: &str| match p.rsplit_once('/') {
        None => true,
        Some((parent, _)) => files.folders.contains(parent),
    };
    match m {
        "MKCOL" => {
            if rel.is_empty() || files.folders.contains(&rel) || files.files.contains_key(&rel) {
                return StatusCode::METHOD_NOT_ALLOWED.into_response();
            }
            if !parent_ok(files, &rel) {
                return StatusCode::CONFLICT.into_response();
            }
            files.folders.insert(rel);
            StatusCode::CREATED.into_response()
        }
        "PUT" => {
            if rel.is_empty() || files.folders.contains(&rel) {
                return StatusCode::METHOD_NOT_ALLOWED.into_response();
            }
            if !parent_ok(files, &rel) {
                return StatusCode::CONFLICT.into_response();
            }
            let existed = files.files.insert(rel, body.to_vec()).is_some();
            if existed { StatusCode::NO_CONTENT } else { StatusCode::CREATED }.into_response()
        }
        "GET" => match files.files.get(&rel) {
            Some(b) => b.clone().into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        _ /* DELETE */ => {
            let prefix = format!("{rel}/");
            let had = files.files.remove(&rel).is_some() | files.folders.remove(&rel);
            files.files.retain(|k, _| !k.starts_with(&prefix));
            files.folders.retain(|k| !k.starts_with(&prefix));
            if had { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }.into_response()
        }
    }
}

/* ── an image build's log ── */

/// The build Job's log as Research streams it: `text/event-stream`, the raw
/// timestamped lines, open until the build ends. Like Research's, the route
/// asks for no key.
fn build_logs(emu: &Shared, image: &str) -> Response {
    if !emu.lock().images.contains_key(image) {
        return refusal(StatusCode::NOT_FOUND, "Desk image job not found");
    }
    let stream = futures_util::stream::unfold(
        (emu.clone(), image.to_owned(), 0usize, false),
        |(emu, id, sent, done)| async move {
            if done {
                return None;
            }
            loop {
                let (lines, ended) = {
                    let st = emu.lock();
                    match st.images.get(&id) {
                        Some(img) => img.log_so_far(now_ms(), emu.cfg.timings),
                        None => (Vec::new(), true),
                    }
                };
                if lines.len() > sent {
                    let chunk: String = lines[sent..].iter().map(|l| format!("{l}\n")).collect();
                    let n = lines.len();
                    return Some((Ok::<_, Infallible>(Bytes::from(chunk)), (emu, id, n, ended)));
                }
                if ended {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        },
    );
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
