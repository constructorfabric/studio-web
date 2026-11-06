//! What the emulator keeps: the members who signed in, their tokens and
//! keys, their projects, desks and the desks' files, images, applications and
//! services. Statuses move with time, as Research's do: a desk starts, an
//! image builds, a service comes up, each after the configured while.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How long the emulated work takes.
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    pub desk: Duration,
    pub build: Duration,
    pub start: Duration,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// An id the way Research makes its `external_id`s: a UUID v4 as 32 hex
/// characters.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn rfc3339(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
}

/// A sign-in's code, waiting for the token call.
#[derive(Debug, Clone)]
pub struct Grant {
    pub client_id: String,
    pub redirect_uri: String,
    pub challenge: String,
    pub user_id: String,
    pub expires_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub user_id: String,
    pub expires_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Key {
    pub id: String,
    pub name: String,
    pub user_id: String,
    pub expires_at: String,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub owner: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Desk {
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// `not_started` | `starting` | `running` | `stopping`.
    pub status: String,
    pub since_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct DeskFiles {
    pub folders: BTreeSet<String>,
    pub files: BTreeMap<String, Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Image {
    pub id: String,
    pub desk_id: String,
    pub project_id: String,
    pub name: String,
    pub dockerfile: String,
    pub started_ms: u64,
    /// Why the build fails, decided when it starts.
    pub fails: Option<String>,
    /// The build's log, line by line, without timestamps.
    pub log: Vec<String>,
}

impl Image {
    pub fn status(&self, now: u64, t: Timings) -> &'static str {
        if now < self.started_ms + t.build.as_millis() as u64 {
            "in_progress"
        } else if self.fails.is_some() {
            "error"
        } else {
            "done"
        }
    }

    /// The log lines written by now, with the build Job's timestamps, and
    /// whether the build has ended.
    pub fn log_so_far(&self, now: u64, t: Timings) -> (Vec<String>, bool) {
        let total = self.log.len().max(1) as u64;
        let build = t.build.as_millis() as u64;
        let elapsed = now.saturating_sub(self.started_ms);
        let ended = elapsed >= build;
        let shown = if ended || build == 0 {
            self.log.len()
        } else {
            ((elapsed * total) / build) as usize
        };
        let step = build / total;
        let lines = self.log[..shown.min(self.log.len())]
            .iter()
            .enumerate()
            .map(|(i, l)| format!("{} {l}", rfc3339(self.started_ms + step * i as u64)))
            .collect();
        (lines, ended)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Port {
    pub number: u16,
    pub expose_to_internet: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Env {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct App {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Service {
    pub id: String,
    pub app_id: String,
    pub name: String,
    pub image_id: String,
    pub hardware_configuration_id: String,
    pub volumes: serde_json::Value,
    pub ports: Vec<Port>,
    pub environment_variables: Vec<Env>,
    /// `stopped` | `starting` | `running` | `failed`.
    pub status: String,
    pub since_ms: u64,
}

/// One request, for the dashboard.
#[derive(Debug, Clone)]
pub struct Call {
    pub at_ms: u64,
    pub method: String,
    pub path: String,
    pub status: u16,
    /// Set when the request is one the restricted gateway would refuse.
    pub off_list: bool,
}

const CALLS_KEPT: usize = 300;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    pub users: BTreeMap<String, User>,
    #[serde(skip)]
    pub grants: BTreeMap<String, Grant>,
    pub idp_tokens: BTreeMap<String, Token>,
    pub refresh_tokens: BTreeMap<String, String>,
    pub keys: BTreeMap<String, Key>,
    pub projects: BTreeMap<String, Project>,
    pub desks: BTreeMap<String, Desk>,
    /// The desks' files live in memory only: a restart empties them, as a
    /// build uploads its tree again anyway.
    #[serde(skip)]
    pub files: BTreeMap<String, DeskFiles>,
    pub images: BTreeMap<String, Image>,
    pub apps: BTreeMap<String, App>,
    pub services: BTreeMap<String, Service>,
    #[serde(skip)]
    pub calls: VecDeque<Call>,
    /// The next image build fails, whatever its Dockerfile says.
    pub fail_next_build: bool,
}

impl State {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn record(&mut self, call: Call) {
        if self.calls.len() == CALLS_KEPT {
            self.calls.pop_front();
        }
        self.calls.push_back(call);
    }

    /// Move every status on to where time has taken it.
    pub fn advance(&mut self, now: u64, t: Timings) {
        let desk = t.desk.as_millis() as u64;
        for d in self.desks.values_mut() {
            match d.status.as_str() {
                "starting" if now >= d.since_ms + desk => {
                    d.status = "running".into();
                    d.since_ms = now;
                }
                "stopping" if now >= d.since_ms + desk / 2 => {
                    d.status = "not_started".into();
                    d.since_ms = now;
                }
                _ => {}
            }
        }
        let start = t.start.as_millis() as u64;
        let images = &self.images;
        for s in self.services.values_mut() {
            if s.status == "starting" && now >= s.since_ms + start {
                let built = images
                    .get(&s.image_id)
                    .is_some_and(|i| i.status(now, t) == "done");
                s.status = if built { "running" } else { "failed" }.into();
                s.since_ms = now;
            }
        }
    }

    /// The member a sign-in names, made on the first sign-in with a project
    /// of their own.
    pub fn sign_in(&mut self, email: &str, first_name: &str, last_name: &str) -> String {
        let email = email.trim().to_lowercase();
        let id = uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_URL,
            format!("mailto:{email}").as_bytes(),
        )
        .simple()
        .to_string();
        let user = User {
            id: id.clone(),
            email: email.clone(),
            first_name: first_name.trim().to_owned(),
            last_name: last_name.trim().to_owned(),
        };
        self.users.insert(id.clone(), user);
        if !self.projects.values().any(|p| p.owner == id) {
            let pid = new_id();
            let who = if first_name.trim().is_empty() {
                email.split('@').next().unwrap_or("member").to_owned()
            } else {
                first_name.trim().to_owned()
            };
            self.projects.insert(
                pid.clone(),
                Project {
                    id: pid,
                    name: format!("{who}'s project"),
                    owner: id.clone(),
                },
            );
        }
        id
    }
}

/// The build log Research's builder would write for `dockerfile`, and why it
/// fails, if it does.
pub fn build_log(
    dockerfile: Option<&str>,
    path: &str,
    name: &str,
    forced: bool,
) -> (Vec<String>, Option<String>) {
    let mut log = vec!["Pod is not found. Waiting for pod creation...".to_owned()];
    let Some(text) = dockerfile else {
        let why = format!("Dockerfile {path} is not in the desk's project folder");
        log.push(format!("Error: {why}"));
        return (log, Some(why));
    };
    // Instructions, with `\` continuations joined and comments left out.
    let mut steps: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let l = line.trim();
        if current.is_empty() && (l.is_empty() || l.starts_with('#')) {
            continue;
        }
        if let Some(head) = l.strip_suffix('\\') {
            current.push_str(head.trim_end());
            current.push(' ');
            continue;
        }
        current.push_str(l);
        steps.push(std::mem::take(&mut current));
    }
    if !current.is_empty() {
        steps.push(current);
    }
    let asked = text.contains("research-emulator: fail");
    let fails = if forced {
        Some("the emulator was told to fail the next build".to_owned())
    } else if asked {
        Some("the Dockerfile asks the emulator to fail (`research-emulator: fail`)".to_owned())
    } else if steps.is_empty() {
        Some("the Dockerfile has no instructions".to_owned())
    } else {
        None
    };
    let n = steps.len();
    let upto = if fails.is_some() { n.div_ceil(2) } else { n };
    for (i, s) in steps.iter().take(upto).enumerate() {
        log.push(format!("STEP {}/{}: {s}", i + 1, n));
    }
    match &fails {
        Some(why) => {
            log.push(format!("error building at STEP {upto}/{n}: {why}"));
            log.push("Error: building image: exit status 1".to_owned());
        }
        None => {
            log.push(format!("COMMIT {name}"));
            log.push(format!("Successfully tagged localhost/{name}:latest"));
        }
    }
    (log, fails)
}
