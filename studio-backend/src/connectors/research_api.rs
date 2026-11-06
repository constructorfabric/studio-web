//! The Research connector's calls to Constructor Research's own public API
//! (ADR-0049 §6), with the access token of the member whose connection it
//! is. Studio calls the routes Research's web client calls -- the ones an
//! `rk-` access key may call too -- and nothing else.
//!
//! The connection's address is the account API, `https://<stand>/api/
//! platform-account/v1`. Two more services sit beside it on the same origin
//! and take the same token: the desk's files over WebDAV
//! (`/api/platform-storage`) and the log streams (`/api/platform-keeper`).
//!
//! Research answers JSON. An error is `{"detail": {"msg", "error_code"}}`
//! (status 421 for most refusals), or FastAPI's `{"detail": [{"msg", "loc"}]}`
//! for a body it does not accept; the message is what the person sees.
//! Research has no upload, no single "put the application" call and no event
//! stream: a build is a desk's files and an image per Dockerfile, a deploy is
//! one call per service, and both are polled.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use futures_util::StreamExt as _;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

/// A fresh access token, when the one in hand is no longer accepted. The
/// connection's refresh token is traded for it (ADR-0049 §1): a build can
/// outlast an access token's hour.
pub type Renew = Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<String>> + Send + Sync>;

/// Where a long call says what it is doing.
pub type Progress<'a> = &'a (dyn Fn(String) -> BoxFuture<'a, ()> + Send + Sync);

/// Whether the person stopped the run.
pub type Cancelled<'a> = &'a (dyn Fn() -> bool + Send + Sync);

/// What a member's Research access key starts with, and the header it is
/// sent in (`X-Research-AccessKey: Bearer rk-…`).
pub const ACCESS_KEY_PREFIX: &str = "rk-";
const ACCESS_KEY_HEADER: &str = "X-Research-AccessKey";

pub const SIGN_IN_AGAIN: &str =
    "Constructor Research did not accept the sign-in: sign in to it again";

/// The desk Studio builds in when the project may have one of its own.
pub const STUDIO_DESK: &str = "studio";

/// Where in a desk's project folder Studio puts what it builds. It is kept
/// out of the project's git (`.git/info/exclude`) and removed after a build.
pub const BUILD_FOLDER: &str = "studio-build";

/// Research's own public API, as one member reaches it.
pub struct ResearchApi {
    http: reqwest::Client,
    /// `…/api/platform-account/v1`.
    account: String,
    /// The origin (and any prefix) the three services sit under.
    base: String,
    token: Mutex<String>,
    renew: Option<Renew>,
}

/// A Research project the member owns or collaborates on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// A hardware configuration a project's services may run on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hardware {
    pub id: String,
    pub name: String,
    /// Offered to a trial user: Research ends what runs on it by its own rules.
    pub trial: bool,
    pub cpu_count: f64,
    pub ram_gb: u32,
    pub gpu: bool,
}

#[derive(Deserialize)]
struct RawHardware {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    available_for_trial: bool,
    #[serde(default)]
    cpu_count: f64,
    #[serde(default)]
    ram_gb: u32,
    #[serde(default)]
    gpu: Option<serde_json::Value>,
    #[serde(default)]
    removed: bool,
}

/// The smallest configuration without a GPU (or, with none, the smallest):
/// what a service runs on when the environment names no hardware.
pub fn smallest(hardware: &[Hardware]) -> Option<&Hardware> {
    hardware.iter().min_by(|a, b| {
        (a.gpu, a.ram_gb)
            .cmp(&(b.gpu, b.ram_gb))
            .then(a.cpu_count.total_cmp(&b.cpu_count))
    })
}

/// `POST /access-keys`: a member's key and its id.
#[derive(Clone, Deserialize)]
pub struct AccessKey {
    pub id: String,
    pub key: String,
}

impl std::fmt::Debug for AccessKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessKey")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// `GET /auth/session`: the member the token is.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Me {
    pub id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
}

impl Me {
    pub fn display_name(&self) -> Option<String> {
        let name = [&self.first_name, &self.last_name]
            .into_iter()
            .flatten()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if name.is_empty() {
            self.email.clone()
        } else {
            Some(name)
        }
    }
}

/// A desk: a work disk and pod for the project's files.
#[derive(Debug, Clone, Deserialize)]
pub struct Desk {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub filesystem: Filesystem,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Filesystem {
    /// `not_started` | `starting` | `running` | `stopping`.
    #[serde(default)]
    pub status: String,
}

/// An image built from a Dockerfile in a desk.
#[derive(Debug, Clone, Deserialize)]
pub struct Image {
    pub id: String,
    /// `not_started` | `snapshot_creation` | `in_progress` | `done` | `error`.
    #[serde(default)]
    pub build_status: String,
}

/// An application: a group of services, a namespace of its own.
#[derive(Debug, Clone, Deserialize)]
pub struct Application {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub services: Vec<Service>,
}

impl Application {
    /// Where the product opens: each service's public link.
    pub fn links(&self) -> Vec<String> {
        self.services
            .iter()
            .filter_map(|s| s.link.clone())
            .collect()
    }
}

/// One service: one container.
#[derive(Debug, Clone, Deserialize)]
pub struct Service {
    pub id: String,
    pub name: String,
    /// `starting` | `running` | `stopping` | `stopped` | `failed`.
    #[serde(default)]
    pub status: String,
    /// The public address of its first port exposed to the internet.
    #[serde(default)]
    pub link: Option<String>,
}

/// The body of `POST /applications/{a}/services` and of its `PATCH`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceBody {
    pub name: String,
    pub image_id: String,
    pub hardware_configuration_id: String,
    pub volumes: Vec<VolumeBody>,
    pub ports: Vec<PortBody>,
    pub environment_variables: Vec<EnvBody>,
}

/// A volume; a `PATCH` keeps the data of the one with the same name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VolumeBody {
    pub name: String,
    pub mount_point: String,
    pub size_gb: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortBody {
    pub number: u16,
    pub expose_to_internet: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnvBody {
    pub name: String,
    pub value: String,
}

/// One image a build asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageBuild {
    /// What the build's record names it by (the application).
    pub key: String,
    /// Research's name for it: ASCII letters, digits and hyphens, at most 30.
    pub name: String,
    /// The Dockerfile, relative to the uploaded folder. Research builds with
    /// the Dockerfile's own folder as the context.
    pub dockerfile: String,
}

/// An image a build made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    pub key: String,
    pub name: String,
    pub id: String,
}

/// How often Research is asked, and for how long.
#[derive(Debug, Clone, Copy)]
pub struct Pace {
    pub poll: Duration,
    /// A desk's start: about half a minute.
    pub desk_for: Duration,
    /// An image build: minutes for a small one, 20-40 for a large one.
    pub build_for: Duration,
    /// Every service running.
    pub start_for: Duration,
    /// Between an upload and the builds: a build started at once does not
    /// see the files yet.
    pub settle: Duration,
    /// Every public link answering, after the services run; zero skips it.
    pub ready_for: Duration,
}

impl Pace {
    pub const RESEARCH: Pace = Pace {
        poll: Duration::from_secs(10),
        desk_for: Duration::from_secs(10 * 60),
        build_for: Duration::from_secs(90 * 60),
        start_for: Duration::from_secs(15 * 60),
        settle: Duration::from_secs(30),
        ready_for: Duration::from_secs(60),
    };
}

#[derive(Deserialize)]
struct Results<T> {
    results: Vec<T>,
}

/// A path segment, percent-escaped but for RFC 3986's unreserved characters.
fn seg(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A relative path, each segment escaped.
fn rel_path(path: &str) -> String {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(seg)
        .collect::<Vec<_>>()
        .join("/")
}

/// The account API's root and the base the other two services sit under.
/// `…/api/platform-account` gains its `/v1`; an address of another shape
/// (a test's) keeps its origin as the base.
fn roots(api_url: &str) -> (String, String) {
    let t = api_url.trim().trim_end_matches('/');
    let account = if t.ends_with("/api/platform-account") {
        format!("{t}/v1")
    } else {
        t.to_owned()
    };
    let base = match account.strip_suffix("/api/platform-account/v1") {
        Some(base) => base.to_owned(),
        None => {
            let after = account.find("://").map(|i| i + 3).unwrap_or(0);
            let end = account[after..]
                .find('/')
                .map(|i| after + i)
                .unwrap_or(account.len());
            account[..end].to_owned()
        }
    };
    (account, base)
}

/// What Research said, in words.
fn problem(status: reqwest::StatusCode, body: &str) -> String {
    let json: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let said = json.as_ref().and_then(|v| {
        let detail = v.get("detail");
        let text = |v: &serde_json::Value| v.as_str().map(str::to_owned);
        detail
            .and_then(|d| d.get("msg"))
            .and_then(text)
            .map(|msg| {
                match detail
                    .and_then(|d| d.get("info"))
                    .and_then(|i| i.get("details"))
                    .and_then(text)
                {
                    Some(details) => format!("{msg}: {details}"),
                    None => msg,
                }
            })
            .or_else(|| detail.and_then(text))
            .or_else(|| {
                let items = detail?.as_array()?;
                let msgs: Vec<String> = items
                    .iter()
                    .filter_map(|i| {
                        let msg = i.get("msg")?.as_str()?;
                        let at = i
                            .get("loc")
                            .and_then(|l| l.as_array())
                            .map(|l| {
                                l.iter()
                                    .filter_map(|p| match p {
                                        serde_json::Value::String(s) => Some(s.clone()),
                                        serde_json::Value::Number(n) => Some(n.to_string()),
                                        _ => None,
                                    })
                                    .collect::<Vec<_>>()
                                    .join(".")
                            })
                            .unwrap_or_default();
                        Some(if at.is_empty() {
                            msg.to_owned()
                        } else {
                            format!("{at}: {msg}")
                        })
                    })
                    .collect();
                (!msgs.is_empty()).then(|| msgs.join("; "))
            })
            .or_else(|| v.get("message").and_then(text))
            .or_else(|| v.get("msg").and_then(text))
    });
    said.unwrap_or_else(|| status.to_string())
}

enum Body<'b> {
    Empty,
    Json(&'b serde_json::Value),
    Bytes(&'b [u8]),
}

impl ResearchApi {
    pub fn new(http: reqwest::Client, api_url: &str, token: String) -> Self {
        let (account, base) = roots(api_url);
        Self {
            http,
            account,
            base,
            token: Mutex::new(token),
            renew: None,
        }
    }

    /// Renew the access token with `renew` when Research no longer accepts it.
    pub fn renewing(mut self, renew: Renew) -> Self {
        self.renew = Some(renew);
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.account)
    }

    fn dav(&self, desk: &str, path: &str) -> String {
        format!(
            "{}/api/platform-storage/desks/{}/dav/project/{}",
            self.base,
            seg(desk),
            rel_path(path)
        )
    }

    fn token(&self) -> String {
        self.token.lock().map(|t| t.clone()).unwrap_or_default()
    }

    /// `req` made as the member: an `rk-` access key goes in Research's own
    /// header, any other token (a connection signed in before the keys, or
    /// the sign-in's own IDP token) as a bearer.
    fn authorized(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let token = self.token();
        if token.starts_with(ACCESS_KEY_PREFIX) {
            req.header(ACCESS_KEY_HEADER, format!("Bearer {token}"))
        } else {
            req.bearer_auth(token)
        }
    }

    /// The answer, once more with a renewed token if the first was refused.
    async fn send(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
        what: &str,
    ) -> anyhow::Result<reqwest::Response> {
        let mut renewed = false;
        loop {
            let mut req = self.authorized(self.http.request(method.clone(), url));
            req = match &body {
                Body::Empty => req,
                Body::Json(v) => req.json(v),
                Body::Bytes(b) => req.body(b.to_vec()),
            };
            let res = req.send().await.map_err(|e| {
                super::oauth::not_reached(&format!("Constructor Research ({what})"), url, &e)
            })?;
            if res.status() != reqwest::StatusCode::UNAUTHORIZED {
                return Ok(res);
            }
            match (&self.renew, renewed) {
                (Some(renew), false) => {
                    let fresh = renew()
                        .await
                        .map_err(|e| anyhow!("{SIGN_IN_AGAIN} ({e:#})"))?;
                    if let Ok(mut t) = self.token.lock() {
                        *t = fresh;
                    }
                    renewed = true;
                }
                _ => bail!(SIGN_IN_AGAIN),
            }
        }
    }

    /// Research's own words for a refusal.
    async fn refused(res: reqwest::Response, what: &str) -> anyhow::Error {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow!(
            "Constructor Research refused {what}: {}",
            problem(status, &body)
        )
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Body<'_>,
        what: &str,
    ) -> anyhow::Result<T> {
        let res = self.send(method, &self.url(path), body, what).await?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        res.json().await.map_err(|e| {
            anyhow!("Constructor Research's answer to {what} is not what Studio expects: {e}")
        })
    }

    /// A call whose answer is not read (`204`, or a body Studio needs not).
    async fn act(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Body<'_>,
        what: &str,
    ) -> anyhow::Result<()> {
        let res = self.send(method, &self.url(path), body, what).await?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        Ok(())
    }

    fn json<T: Serialize>(v: &T) -> anyhow::Result<serde_json::Value> {
        serde_json::to_value(v).context("a request body Studio could not write")
    }

    /* ── who, where, on what ── */

    pub async fn me(&self) -> anyhow::Result<Me> {
        /// The session carries the member under `user`; the bare shape is
        /// accepted too.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Session {
            Of { user: Me },
            Bare(Me),
        }
        let session: Session = self
            .call(
                reqwest::Method::GET,
                "/auth/session",
                Body::Empty,
                "who is signed in",
            )
            .await?;
        Ok(match session {
            Session::Of { user } | Session::Bare(user) => user,
        })
    }

    /// A new access key of the member's, made with the IDP token of a
    /// sign-in (a key cannot make keys). Research shows the key only in this
    /// answer.
    pub async fn create_access_key(
        &self,
        name: &str,
        expires_at: &str,
    ) -> anyhow::Result<AccessKey> {
        let url = format!("{}/access-keys", self.keys_root());
        let body = serde_json::json!({ "name": name, "expires_at": expires_at });
        let what = "making an access key";
        let res = self
            .send(reqwest::Method::POST, &url, Body::Json(&body), what)
            .await?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        let key: AccessKey = res.json().await.map_err(|e| {
            anyhow!("Constructor Research's answer to {what} is not what Studio expects: {e}")
        })?;
        if !key.key.starts_with(ACCESS_KEY_PREFIX) {
            bail!("Constructor Research made no access key");
        }
        Ok(key)
    }

    /// `/access-keys` sits on the account API's root, not under `/v1`.
    fn keys_root(&self) -> &str {
        self.account.strip_suffix("/v1").unwrap_or(&self.account)
    }

    /// Turn on the project's deployments, off in a new project, before its
    /// applications are changed: Research's UI shows a project's applications
    /// only with them on.
    pub async fn enable_deployment(&self, project: &str) -> anyhow::Result<()> {
        #[derive(Deserialize)]
        struct Flag {
            #[serde(default)]
            deployment_enabled: Option<bool>,
        }
        let path = format!("/projects/{}", seg(project));
        let flag: Flag = self
            .call(reqwest::Method::GET, &path, Body::Empty, "the project")
            .await?;
        if flag.deployment_enabled != Some(false) {
            return Ok(());
        }
        self.act(
            reqwest::Method::PATCH,
            &path,
            Body::Json(&serde_json::json!({ "deployment_enabled": true })),
            "turning on the project's deployments",
        )
        .await
    }

    pub async fn projects(&self) -> anyhow::Result<Vec<Project>> {
        Ok(self
            .call::<Results<Project>>(
                reqwest::Method::GET,
                "/projects",
                Body::Empty,
                "the projects",
            )
            .await?
            .results)
    }

    /// The project's hardware configurations, but those Research removed.
    pub async fn hardware(&self, project: &str) -> anyhow::Result<Vec<Hardware>> {
        let raw = self
            .call::<Results<RawHardware>>(
                reqwest::Method::GET,
                &format!("/projects/{}/hardware-configurations", seg(project)),
                Body::Empty,
                "the hardware",
            )
            .await?
            .results;
        Ok(raw
            .into_iter()
            .filter(|h| !h.removed)
            .map(|h| Hardware {
                id: h.id,
                name: h.name,
                trial: h.available_for_trial,
                cpu_count: h.cpu_count,
                ram_gb: h.ram_gb,
                gpu: h.gpu.is_some_and(|g| !g.is_null()),
            })
            .collect())
    }

    /* ── desks and their files ── */

    pub async fn desks(&self, project: &str) -> anyhow::Result<Vec<Desk>> {
        Ok(self
            .call::<Results<Desk>>(
                reqwest::Method::GET,
                &format!("/projects/{}/desks", seg(project)),
                Body::Empty,
                "the project's desks",
            )
            .await?
            .results)
    }

    pub async fn create_desk(&self, project: &str, name: &str) -> anyhow::Result<Desk> {
        self.call(
            reqwest::Method::POST,
            &format!("/projects/{}/desks", seg(project)),
            Body::Json(&serde_json::json!({ "name": name })),
            "a desk for Studio's build",
        )
        .await
    }

    pub async fn desk(&self, desk: &str) -> anyhow::Result<Desk> {
        self.call(
            reqwest::Method::GET,
            &format!("/desks/{}", seg(desk)),
            Body::Empty,
            "the desk's state",
        )
        .await
    }

    pub async fn start_desk(&self, desk: &str) -> anyhow::Result<Desk> {
        self.call(
            reqwest::Method::POST,
            &format!("/desks/{}/filesystem", seg(desk)),
            Body::Empty,
            "starting the desk",
        )
        .await
    }

    pub async fn stop_desk(&self, desk: &str) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::DELETE,
            &format!("/desks/{}/filesystem", seg(desk)),
            Body::Empty,
            "stopping the desk",
        )
        .await
    }

    /// Make a folder in the desk's project folder; one already there is fine.
    pub async fn make_folder(&self, desk: &str, path: &str) -> anyhow::Result<()> {
        let what = format!("making folder {path} in the desk");
        let mkcol = reqwest::Method::from_bytes(b"MKCOL").expect("a method name");
        let res = self
            .send(mkcol, &self.dav(desk, path), Body::Empty, &what)
            .await?;
        if res.status().is_success() || res.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
        Err(Self::refused(res, &what).await)
    }

    pub async fn put_file(&self, desk: &str, path: &str, content: &[u8]) -> anyhow::Result<()> {
        let what = format!("writing {path} to the desk");
        let res = self
            .send(
                reqwest::Method::PUT,
                &self.dav(desk, path),
                Body::Bytes(content),
                &what,
            )
            .await?;
        if res.status().is_success() {
            return Ok(());
        }
        Err(Self::refused(res, &what).await)
    }

    /// A file of the desk's project folder; `None` when there is none.
    pub async fn get_file(&self, desk: &str, path: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let what = format!("reading {path} in the desk");
        let res = self
            .send(
                reqwest::Method::GET,
                &self.dav(desk, path),
                Body::Empty,
                &what,
            )
            .await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(Self::refused(res, &what).await);
        }
        Ok(Some(res.bytes().await?.to_vec()))
    }

    /// Remove a file or a folder and all in it; one not there is fine.
    pub async fn remove_path(&self, desk: &str, path: &str) -> anyhow::Result<()> {
        let what = format!("removing {path} from the desk");
        let res = self
            .send(
                reqwest::Method::DELETE,
                &self.dav(desk, path),
                Body::Empty,
                &what,
            )
            .await?;
        if res.status().is_success() || res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(Self::refused(res, &what).await)
    }

    /* ── images ── */

    /// Build an image from `dockerfile`, a path in the project folder.
    pub async fn build_image(
        &self,
        desk: &str,
        name: &str,
        dockerfile: &str,
    ) -> anyhow::Result<Image> {
        self.call(
            reqwest::Method::POST,
            &format!("/desks/{}/images", seg(desk)),
            Body::Json(&serde_json::json!({ "name": name, "dockerfile": dockerfile })),
            &format!("building image {name}"),
        )
        .await
    }

    pub async fn image(&self, image: &str) -> anyhow::Result<Image> {
        self.call(
            reqwest::Method::GET,
            &format!("/images/{}", seg(image)),
            Body::Empty,
            "the image's state",
        )
        .await
    }

    /// The last lines of an image's build log, while Research still has it
    /// (the build's Job; Research keeps no log after it). `Ok(None)` when
    /// the log says nothing; an error when Research could not be asked.
    pub async fn build_log_tail(
        &self,
        image: &str,
        lines: usize,
    ) -> anyhow::Result<Option<String>> {
        let url = format!(
            "{}/api/platform-keeper/image-builds/{}/logs",
            self.base,
            seg(image)
        );
        self.stream_tail(url, lines).await
    }

    /// The last lines of a running service's log: what its newest pod has
    /// written. Research serves it only as a live stream with no tail of its
    /// own, so the stream is read for a few seconds and its end kept.
    /// `Ok(None)` when the log says nothing; an error when Research could
    /// not be asked, so a refused sign-in does not read as an empty log.
    pub async fn service_log_tail(
        &self,
        service: &str,
        lines: usize,
    ) -> anyhow::Result<Option<String>> {
        let url = format!(
            "{}/api/platform-keeper/services/{}/logs",
            self.base,
            seg(service)
        );
        self.stream_tail(url, lines).await
    }

    /// An event stream read for up to ten seconds, its last `lines` data
    /// lines kept. `Ok(None)` when it opens but says nothing; an error when
    /// it cannot be opened (unreachable, refused, no answer in time).
    async fn stream_tail(&self, url: String, lines: usize) -> anyhow::Result<Option<String>> {
        let what = "reading a log";
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let res = tokio::time::timeout_at(
            deadline,
            self.authorized(self.http.get(url))
                .header("accept", "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| anyhow!("Constructor Research did not answer {what} in time"))?
        .map_err(|e| anyhow!("Constructor Research could not be reached for {what}: {e}"))?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        let mut stream = res.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Ok(Some(Ok(chunk))) = tokio::time::timeout_at(deadline, stream.next()).await {
            buf.extend_from_slice(&chunk);
            if buf.len() > 1 << 20 {
                buf.drain(..buf.len() - (1 << 19));
            }
        }
        let text = String::from_utf8_lossy(&buf);
        let kept: Vec<&str> = text.lines().filter_map(log_line).collect();
        let tail = kept[kept.len().saturating_sub(lines)..].join("\n");
        Ok((!tail.is_empty()).then_some(tail))
    }

    /// Follow a service's log until `until`, reopening the stream (after
    /// `retry`) whenever it closes, and tell its containers apart. Research
    /// keeps no log of a container once it is gone, and each connection
    /// replays the current one from its start: a connection that begins
    /// with the line the current container began with is a replay; one that
    /// begins otherwise, or a "Container is waiting to start" after the
    /// container's own lines, is a new container.
    pub async fn watch_log(
        &self,
        service: &str,
        until: tokio::time::Instant,
        retry: Duration,
    ) -> Watched {
        let url = format!(
            "{}/api/platform-keeper/services/{}/logs",
            self.base,
            seg(service)
        );
        let mut w = Watched::default();
        // The current container's first line, and how many of its lines were seen.
        let mut first: Option<String> = None;
        let mut seen = 0usize;
        while tokio::time::Instant::now() < until {
            let opened = tokio::time::timeout_at(
                until,
                self.authorized(self.http.get(&url))
                    .header("accept", "text/event-stream")
                    .send(),
            )
            .await;
            if let Ok(Ok(res)) = opened
                && res.status().is_success()
            {
                let mut stream = res.bytes_stream();
                let mut partial = String::new();
                // Lines of this connection, and replayed ones left to skip.
                let mut here = 0usize;
                let mut skip = 0usize;
                while let Ok(Some(Ok(chunk))) = tokio::time::timeout_at(until, stream.next()).await
                {
                    partial.push_str(&String::from_utf8_lossy(&chunk));
                    let Some(end) = partial.rfind('\n') else {
                        continue;
                    };
                    let complete: String = partial.drain(..=end).collect();
                    for line in complete.lines().filter_map(log_line) {
                        if line.starts_with(WAITING) {
                            if here > 0 && !w.lines.is_empty() {
                                w.restarted();
                                (first, seen) = (None, 0);
                            }
                            continue;
                        }
                        if here == 0 {
                            match &first {
                                Some(f) if f == line => skip = seen,
                                Some(_) => {
                                    w.restarted();
                                    (first, seen) = (None, 0);
                                }
                                None => {}
                            }
                        }
                        here += 1;
                        if first.is_none() {
                            first = Some(line.to_owned());
                        }
                        if skip > 0 {
                            skip -= 1;
                            continue;
                        }
                        seen += 1;
                        w.lines.push(line.to_owned());
                        if w.lines.len() > WATCHED_LINES {
                            w.lines.remove(0);
                        }
                    }
                }
            }
            let next = tokio::time::Instant::now() + retry;
            tokio::time::sleep_until(next.min(until)).await;
        }
        w
    }

    /* ── applications and services ── */

    pub async fn applications(&self, project: &str) -> anyhow::Result<Vec<Application>> {
        Ok(self
            .call::<Results<Application>>(
                reqwest::Method::GET,
                &format!("/projects/{}/applications", seg(project)),
                Body::Empty,
                "the project's applications",
            )
            .await?
            .results)
    }

    /// The project's application of that name, if there is one.
    pub async fn application_named(
        &self,
        project: &str,
        name: &str,
    ) -> anyhow::Result<Option<Application>> {
        Ok(self
            .applications(project)
            .await?
            .into_iter()
            .find(|a| a.name == name))
    }

    pub async fn create_application(
        &self,
        project: &str,
        name: &str,
    ) -> anyhow::Result<Application> {
        self.call(
            reqwest::Method::POST,
            &format!("/projects/{}/applications", seg(project)),
            Body::Json(&serde_json::json!({ "name": name })),
            &format!("creating application {name}"),
        )
        .await
    }

    pub async fn application(&self, application: &str) -> anyhow::Result<Application> {
        self.call(
            reqwest::Method::GET,
            &format!("/applications/{}", seg(application)),
            Body::Empty,
            "the application's state",
        )
        .await
    }

    /// Remove an application and its services.
    pub async fn delete_application(&self, application: &str) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::DELETE,
            &format!("/applications/{}", seg(application)),
            Body::Empty,
            "removing the application",
        )
        .await
    }

    pub async fn create_service(
        &self,
        application: &str,
        body: &ServiceBody,
    ) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::POST,
            &format!("/applications/{}/services", seg(application)),
            Body::Json(&Self::json(body)?),
            &format!("creating service {}", body.name),
        )
        .await
    }

    /// Change a service to `body`: ports by number, volumes and variables by
    /// name, so a volume of the same name keeps its data.
    pub async fn patch_service(
        &self,
        application: &str,
        service: &str,
        body: &ServiceBody,
    ) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::PATCH,
            &format!(
                "/applications/{}/services/{}",
                seg(application),
                seg(service)
            ),
            Body::Json(&Self::json(body)?),
            &format!("changing service {}", body.name),
        )
        .await
    }

    pub async fn service(&self, service: &str) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::GET,
            &format!("/services/{}", seg(service)),
            Body::Empty,
            "the service's state",
        )
        .await
    }

    pub async fn start_service(&self, service: &str) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::POST,
            &format!("/services/{}/start", seg(service)),
            Body::Empty,
            "starting the service",
        )
        .await
    }

    /// Research stops only a running service, and starts only a stopped or
    /// failed one.
    pub async fn stop_service(&self, service: &str) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::POST,
            &format!("/services/{}/stop", seg(service)),
            Body::Empty,
            "stopping the service",
        )
        .await
    }

    pub async fn delete_service(&self, service: &str) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::DELETE,
            &format!("/services/{}", seg(service)),
            Body::Empty,
            "removing the service",
        )
        .await
    }

    /* ── a build: the files into a desk, an image per Dockerfile ── */

    /// The desk Studio builds in: its own (`studio`) where the project may
    /// have more than one, or else the project's one desk.
    async fn build_desk(&self, project: &str) -> anyhow::Result<Desk> {
        let desks = self.desks(project).await?;
        if let Some(d) = desks.iter().find(|d| d.name == STUDIO_DESK) {
            return Ok(d.clone());
        }
        match self.create_desk(project, STUDIO_DESK).await {
            Ok(d) => Ok(d),
            // One desk per project (Research's `multi_desk` off): build in it.
            Err(e) => desks.into_iter().next().ok_or(e),
        }
    }

    /// Wait for the desk's files to be reachable; whether Studio started it.
    async fn desk_running(
        &self,
        desk: &str,
        pace: Pace,
        cancelled: Cancelled<'_>,
    ) -> anyhow::Result<bool> {
        let until = tokio::time::Instant::now() + pace.desk_for;
        let mut started = false;
        loop {
            let state = self.desk(desk).await?;
            match state.filesystem.status.as_str() {
                "running" => return Ok(started),
                "not_started" | "" => {
                    self.start_desk(desk).await?;
                    started = true;
                }
                _ => {}
            }
            if cancelled() {
                bail!("the build was cancelled");
            }
            if tokio::time::Instant::now() >= until {
                bail!(
                    "the desk did not start within {} minutes",
                    pace.desk_for.as_secs() / 60
                );
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /// Keep `folder` out of the project's git: the desk's repository may
    /// commit what is in its files.
    async fn exclude_from_git(&self, desk: &str, folder: &str) {
        let path = ".git/info/exclude";
        let line = format!("/{folder}/");
        if let Ok(Some(existing)) = self.get_file(desk, path).await {
            let text = String::from_utf8_lossy(&existing);
            if !text.lines().any(|l| l.trim() == line) {
                let mut text = text.into_owned();
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&line);
                text.push('\n');
                if let Err(e) = self.put_file(desk, path, text.as_bytes()).await {
                    tracing::warn!(error = %e, "research: the build folder could not be kept out of git");
                }
            }
        }
    }

    /// Write the tree at `local` into the desk at `remote`, but for `.git`
    /// and `target` folders; how many files.
    async fn upload(&self, desk: &str, local: &Path, remote: &str) -> anyhow::Result<usize> {
        let root = local.to_path_buf();
        let (dirs, files) = tokio::task::spawn_blocking(move || walk(&root))
            .await
            .context("the prepared tree could not be read")??;
        let mut at = String::new();
        for part in remote.split('/').filter(|p| !p.is_empty()) {
            if !at.is_empty() {
                at.push('/');
            }
            at.push_str(part);
            self.make_folder(desk, &at).await?;
        }
        for dir in &dirs {
            self.make_folder(desk, &format!("{remote}/{dir}")).await?;
        }
        let count = files.len();
        let mut writes = futures_util::stream::iter(files.into_iter().map(|rel| {
            let path = local.join(&rel);
            async move {
                let content = tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("{} could not be read", path.display()))?;
                self.put_file(desk, &format!("{remote}/{rel}"), &content)
                    .await
            }
        }))
        .buffer_unordered(8);
        while let Some(done) = writes.next().await {
            done?;
        }
        Ok(count)
    }

    /// Put the tree at `local` into a desk of `project` (under
    /// [`BUILD_FOLDER`]`/{name}`), build each of `images` there and wait for
    /// all of them. The desk is stopped afterwards if Studio started it, and
    /// the folder removed.
    #[allow(clippy::too_many_arguments)]
    pub async fn build_in_desk(
        &self,
        project: &str,
        local: &Path,
        name: &str,
        images: &[ImageBuild],
        pace: Pace,
        progress: Progress<'_>,
        cancelled: Cancelled<'_>,
    ) -> anyhow::Result<Vec<Built>> {
        let desk = self.build_desk(project).await?;
        progress(format!("starting desk {}", desk.name)).await;
        let started = self.desk_running(&desk.id, pace, cancelled).await?;
        let folder = format!("{BUILD_FOLDER}/{name}");
        let built = self
            .build_in(&desk.id, local, &folder, images, pace, progress, cancelled)
            .await;
        if let Err(e) = self.remove_path(&desk.id, &folder).await {
            tracing::warn!(error = %e, "research: the build folder could not be removed");
        }
        if started && let Err(e) = self.stop_desk(&desk.id).await {
            tracing::warn!(error = %e, "research: the desk Studio started could not be stopped");
        }
        built
    }

    #[allow(clippy::too_many_arguments)]
    async fn build_in(
        &self,
        desk: &str,
        local: &Path,
        folder: &str,
        images: &[ImageBuild],
        pace: Pace,
        progress: Progress<'_>,
        cancelled: Cancelled<'_>,
    ) -> anyhow::Result<Vec<Built>> {
        self.exclude_from_git(desk, BUILD_FOLDER).await;
        self.remove_path(desk, folder).await?;
        progress("uploading the prepared tree to the desk".into()).await;
        let files = self.upload(desk, local, folder).await?;
        progress(format!(
            "uploaded {files} files; building {} image(s)",
            images.len()
        ))
        .await;
        if !pace.settle.is_zero() {
            progress(format!(
                "waiting {} s for the files to reach the builder",
                pace.settle.as_secs()
            ))
            .await;
            tokio::time::sleep(pace.settle).await;
        }

        // Each image's build, its current name and id.
        let mut pending = Vec::new();
        for i in images {
            let image = self
                .build_image(desk, &i.name, &format!("{folder}/{}", i.dockerfile))
                .await?;
            pending.push((i, i.name.clone(), image.id));
        }
        let until = tokio::time::Instant::now() + pace.build_for;
        let mut done: BTreeMap<String, Built> = BTreeMap::new();
        // Research reports `error` for a moment while it retries a build
        // itself, so an error counts once seen twice for the same image. A
        // confirmed one is built once more, under a new name, before the build
        // gives up: the first name each image failed under.
        let mut erred: BTreeSet<String> = BTreeSet::new();
        let mut retried: BTreeMap<String, String> = BTreeMap::new();
        loop {
            for n in 0..pending.len() {
                let (i, name, id) = pending[n].clone();
                if done.contains_key(&i.key) {
                    continue;
                }
                let state = self.image(&id).await?;
                match state.build_status.as_str() {
                    "done" => {
                        done.insert(
                            i.key.clone(),
                            Built {
                                key: i.key.clone(),
                                name,
                                id,
                            },
                        );
                        progress(format!(
                            "built {} ({}/{})",
                            i.name,
                            done.len(),
                            pending.len()
                        ))
                        .await;
                    }
                    "error" if erred.insert(id.clone()) => {}
                    "error" if !retried.contains_key(&i.key) => {
                        let again = retry_name(&i.name);
                        progress(format!("{name} failed; building it once more as {again}")).await;
                        let image = self
                            .build_image(desk, &again, &format!("{folder}/{}", i.dockerfile))
                            .await?;
                        retried.insert(i.key.clone(), name);
                        pending[n] = (i, again, image.id);
                    }
                    "error" => {
                        let tail = self.build_log_tail(&id, 30).await.ok().flatten();
                        bail!(
                            "Constructor Research could not build image {} ({}), nor again as {name}{}",
                            retried[&i.key],
                            i.dockerfile,
                            tail.map(|t| format!(":\n{t}")).unwrap_or_default()
                        );
                    }
                    _ => {}
                }
            }
            if done.len() == pending.len() {
                return Ok(pending
                    .iter()
                    .filter_map(|(i, _, _)| done.remove(&i.key))
                    .collect());
            }
            if cancelled() {
                bail!("the build was cancelled");
            }
            if tokio::time::Instant::now() >= until {
                bail!(
                    "Constructor Research did not build every image within {} minutes",
                    pace.build_for.as_secs() / 60
                );
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /* ── a deploy: an application whose services are exactly these ── */

    /// Make application `name` of `project` run exactly `services`: create
    /// it if need be, create or change each service and (re)start it, remove
    /// the services it no longer has, and wait for all to run.
    pub async fn put_application(
        &self,
        project: &str,
        name: &str,
        services: &[ServiceBody],
        pace: Pace,
        progress: Progress<'_>,
    ) -> anyhow::Result<Application> {
        self.enable_deployment(project).await?;
        let app = match self.application_named(project, name).await? {
            Some(app) => app,
            None => {
                progress(format!("creating application {name}")).await;
                self.create_application(project, name).await?
            }
        };
        let mut existing: BTreeMap<String, Service> = app
            .services
            .iter()
            .map(|s| (s.name.clone(), s.clone()))
            .collect();
        let mut ids = Vec::new();
        for body in services {
            match existing.remove(&body.name) {
                // Changed while stopped, as Research's own deployment MCP
                // does: a running service would take the change half-way.
                Some(s) => {
                    progress(format!("changing service {}", body.name)).await;
                    self.settled(&s.id, pace).await?;
                    if self.service(&s.id).await?.status == "running" {
                        self.stop_service(&s.id).await?;
                        self.settled(&s.id, pace).await?;
                    }
                    self.patch_service(&app.id, &s.id, body).await?;
                    self.start_service(&s.id).await?;
                    ids.push((body.name.clone(), s.id));
                }
                None => {
                    progress(format!("creating service {}", body.name)).await;
                    let s = self.create_service(&app.id, body).await?;
                    self.start_service(&s.id).await?;
                    ids.push((body.name.clone(), s.id));
                }
            }
        }
        for (gone, s) in existing {
            progress(format!(
                "removing service {gone}, which the product no longer has"
            ))
            .await;
            self.delete_service(&s.id).await?;
        }

        progress(format!("waiting for {} service(s) to run", ids.len())).await;
        let until = tokio::time::Instant::now() + pace.start_for;
        let mut running = std::collections::BTreeSet::new();
        loop {
            for (svc, id) in &ids {
                if running.contains(id) {
                    continue;
                }
                let s = self.service(id).await?;
                match s.status.as_str() {
                    "running" => {
                        running.insert(id.clone());
                    }
                    "failed" => {
                        let tail = self.service_log_tail(id, 20).await.ok().flatten();
                        bail!(
                            "service {svc} did not start in Constructor Research{}",
                            tail.map(|t| format!("; its last log lines:\n{t}"))
                                .unwrap_or_default()
                        )
                    }
                    _ => {}
                }
            }
            if running.len() == ids.len() {
                return self.application(&app.id).await;
            }
            if tokio::time::Instant::now() >= until {
                let waiting: Vec<&str> = ids
                    .iter()
                    .filter(|(_, id)| !running.contains(id))
                    .map(|(n, _)| n.as_str())
                    .collect();
                bail!(
                    "{} did not start in Constructor Research within {} minutes",
                    waiting.join(", "),
                    pace.start_for.as_secs() / 60
                );
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /// The services of `app` whose public link has not answered within
    /// `pace.ready_for`: running is not ready. Any answer below 500 counts,
    /// as Research's own deployment MCP counts it.
    pub async fn unanswered(&self, app: &Application, pace: Pace) -> Vec<Service> {
        let mut waiting: Vec<Service> = app
            .services
            .iter()
            .filter(|s| s.link.is_some())
            .cloned()
            .collect();
        if pace.ready_for.is_zero() {
            return Vec::new();
        }
        let until = tokio::time::Instant::now() + pace.ready_for;
        loop {
            let mut still = Vec::new();
            for s in waiting {
                let url = s.link.clone().unwrap_or_default();
                let answer =
                    tokio::time::timeout(Duration::from_secs(10), self.http.get(&url).send()).await;
                if !matches!(answer, Ok(Ok(r)) if r.status().as_u16() < 500) {
                    still.push(s);
                }
            }
            waiting = still;
            if waiting.is_empty() || tokio::time::Instant::now() >= until {
                return waiting;
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /// Wait while a service is starting or stopping: Research stops only a
    /// running service, and starts only a stopped or failed one.
    async fn settled(&self, service: &str, pace: Pace) -> anyhow::Result<()> {
        let until = tokio::time::Instant::now() + pace.start_for;
        loop {
            let s = self.service(service).await?;
            if !matches!(s.status.as_str(), "starting" | "stopping") {
                return Ok(());
            }
            if tokio::time::Instant::now() >= until {
                bail!("service {} stayed {} too long", s.name, s.status);
            }
            tokio::time::sleep(pace.poll).await;
        }
    }
}

/// The platform's line before a service's container starts.
const WAITING: &str = "Container is waiting to start";

/// Lines kept of a watched container.
const WATCHED_LINES: usize = 50;

/// What following a service's log for a while saw.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Watched {
    /// The current container's last lines.
    pub lines: Vec<String>,
    /// New containers started while it was watched.
    pub restarts: u32,
    /// The last lines of the container before the newest one: why it stopped.
    pub before: Vec<String>,
}

impl Watched {
    fn restarted(&mut self) {
        self.restarts += 1;
        self.before = std::mem::take(&mut self.lines);
    }
}

/// A log line of an event stream: its `data`, or a plain line; `None` for the
/// stream's own fields and blank lines.
fn log_line(l: &str) -> Option<&str> {
    let l = if let Some(d) = l.strip_prefix("data:") {
        d.strip_prefix(' ').unwrap_or(d)
    } else if l.starts_with(':')
        || l.starts_with("event:")
        || l.starts_with("id:")
        || l.starts_with("retry:")
    {
        return None;
    } else {
        l
    };
    (!l.trim().is_empty()).then_some(l)
}

/// The name an image is built again under: Research's 30 characters at most.
fn retry_name(name: &str) -> String {
    let base: String = name.chars().take(27).collect();
    format!("{}-r2", base.trim_end_matches('-'))
}

/// The folders and files under `root`, relative and `/`-separated, parents
/// first; `.git` and `target` folders and symbolic links to folders left out.
fn walk(root: &Path) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut todo: Vec<PathBuf> = vec![PathBuf::new()];
    while let Some(rel) = todo.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(root.join(&rel))
            .with_context(|| format!("{} could not be listed", root.join(&rel).display()))?
            .collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name();
            let child = rel.join(&name);
            let shown = child.to_string_lossy().replace('\\', "/");
            let kind = e.file_type()?;
            let is_dir = if kind.is_symlink() {
                std::fs::metadata(e.path())
                    .map(|m| m.is_dir())
                    .unwrap_or(true)
            } else {
                kind.is_dir()
            };
            if is_dir {
                if kind.is_symlink() || name == ".git" || name == "target" {
                    continue;
                }
                dirs.push(shown);
                todo.push(child);
            } else {
                files.push(shown);
            }
        }
    }
    dirs.sort();
    files.sort();
    Ok((dirs, files))
}

#[cfg(test)]
#[path = "research_api_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "research_emulator_tests.rs"]
mod emulator_tests;
