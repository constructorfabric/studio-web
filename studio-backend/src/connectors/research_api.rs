//! The Research connector's calls to Constructor Research's integration
//! service (ADR-0049 §6), with the access token of the member whose
//! connection it is. The service is Research's, written and run there; this
//! is Studio's side of its contract and nothing more.
//!
//! Every answer is JSON; an error carries a stable `code` and a `message`,
//! which is what the person sees. A long operation (a build) answers at once
//! with an id and is read back.

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};

/// One integration service, as one member reaches it.
pub struct ResearchApi {
    http: reqwest::Client,
    root: String,
    token: String,
}

/// A Research project the member owns or collaborates on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// A hardware configuration the member may run services on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Hardware {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// A trial configuration: Research ends what runs on it by its own rules.
    #[serde(default)]
    pub trial: bool,
}

/// One image a build makes: its Dockerfile and context inside the archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuildImage {
    pub app: String,
    pub name: String,
    pub dockerfile: String,
    pub context: String,
}

/// `GET /builds/{b}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BuildState {
    /// `queued` | `running` | `succeeded` | `failed`.
    pub state: String,
    #[serde(default)]
    pub images: Vec<BuiltImage>,
    /// The step that failed and its last lines.
    #[serde(default)]
    pub step: Option<String>,
    #[serde(default)]
    pub log_tail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BuiltImage {
    pub app: String,
    /// Research's reference to it, as a service names its image.
    pub reference: String,
    #[serde(default)]
    pub digest: Option<String>,
}

/// `GET /projects/{p}/applications/{name}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ApplicationState {
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub services: Vec<ServiceState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServiceState {
    pub name: String,
    /// `starting` | `running` | `failed` | `stopped`.
    pub state: String,
    #[serde(default)]
    pub public_urls: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
}

impl ApplicationState {
    /// Every service runs.
    pub fn running(&self) -> bool {
        !self.services.is_empty() && self.services.iter().all(|s| s.state == "running")
    }

    /// A service that failed, with what Research says of it.
    pub fn failed(&self) -> Option<&ServiceState> {
        self.services.iter().find(|s| s.state == "failed")
    }

    /// Where the product opens.
    pub fn public_urls(&self) -> Vec<String> {
        self.services
            .iter()
            .flat_map(|s| s.public_urls.clone())
            .collect()
    }
}

#[derive(Deserialize)]
struct Problem {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct Items<T> {
    items: Vec<T>,
}

#[derive(Deserialize)]
struct Created {
    id: String,
}

#[derive(Deserialize)]
struct Revision {
    #[serde(default)]
    revision: Option<String>,
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

impl ResearchApi {
    pub fn new(http: reqwest::Client, root: &str, token: String) -> Self {
        Self {
            http,
            root: root.trim_end_matches('/').to_owned(),
            token,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.root)
    }

    /// The answer's body, or the service's own words for why not.
    async fn read<T: serde::de::DeserializeOwned>(
        res: Result<reqwest::Response, reqwest::Error>,
        what: &str,
    ) -> anyhow::Result<T> {
        let res = res.map_err(|e| anyhow!("Constructor Research did not answer {what}: {e}"))?;
        let status = res.status();
        if status.is_success() {
            return res.json().await.map_err(|e| {
                anyhow!("Constructor Research's answer to {what} is not what Studio expects: {e}")
            });
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            bail!("Constructor Research did not accept the sign-in: sign in to it again");
        }
        let problem: Option<Problem> = res.json().await.ok();
        let message = problem
            .as_ref()
            .and_then(|p| p.message.clone())
            .unwrap_or_else(|| status.to_string());
        match problem.and_then(|p| p.code) {
            Some(code) => bail!("Constructor Research refused {what}: {message} ({code})"),
            None => bail!("Constructor Research refused {what}: {message}"),
        }
    }

    pub async fn projects(&self) -> anyhow::Result<Vec<Project>> {
        let res = self
            .http
            .get(self.url("/projects"))
            .bearer_auth(&self.token)
            .send()
            .await;
        Ok(Self::read::<Items<Project>>(res, "the projects")
            .await?
            .items)
    }

    pub async fn hardware(&self, project: &str) -> anyhow::Result<Vec<Hardware>> {
        let res = self
            .http
            .get(self.url(&format!("/projects/{}/hardware", seg(project))))
            .bearer_auth(&self.token)
            .send()
            .await;
        Ok(Self::read::<Items<Hardware>>(res, "the hardware")
            .await?
            .items)
    }

    /// Start a build of `images` from `context` (a `.tar.gz`); its id.
    pub async fn start_build(
        &self,
        project: &str,
        images: &[BuildImage],
        context: Vec<u8>,
    ) -> anyhow::Result<String> {
        let manifest = serde_json::to_string(&serde_json::json!({ "images": images }))?;
        let form = reqwest::multipart::Form::new()
            .part(
                "manifest",
                reqwest::multipart::Part::text(manifest).mime_str("application/json")?,
            )
            .part(
                "context",
                reqwest::multipart::Part::bytes(context)
                    .file_name("context.tar.gz")
                    .mime_str("application/gzip")?,
            );
        let res = self
            .http
            .post(self.url(&format!("/projects/{}/builds", seg(project))))
            .bearer_auth(&self.token)
            .multipart(form)
            .send()
            .await;
        Ok(Self::read::<Created>(res, "the build").await?.id)
    }

    pub async fn build(&self, build: &str) -> anyhow::Result<BuildState> {
        let res = self
            .http
            .get(self.url(&format!("/builds/{}", seg(build))))
            .bearer_auth(&self.token)
            .send()
            .await;
        Self::read(res, "the build's state").await
    }

    /// Create or replace an application; the revision it runs.
    pub async fn put_application(
        &self,
        project: &str,
        name: &str,
        app: &impl Serialize,
    ) -> anyhow::Result<Option<String>> {
        let res = self
            .http
            .put(self.url(&format!(
                "/projects/{}/applications/{}",
                seg(project),
                seg(name)
            )))
            .bearer_auth(&self.token)
            .json(app)
            .send()
            .await;
        Ok(Self::read::<Revision>(res, "the application")
            .await?
            .revision)
    }

    pub async fn application(&self, project: &str, name: &str) -> anyhow::Result<ApplicationState> {
        let res = self
            .http
            .get(self.url(&format!(
                "/projects/{}/applications/{}",
                seg(project),
                seg(name)
            )))
            .bearer_auth(&self.token)
            .send()
            .await;
        Self::read(res, "the application's state").await
    }

    /// Remove an application; its volumes stay unless `volumes`.
    pub async fn delete_application(
        &self,
        project: &str,
        name: &str,
        volumes: bool,
    ) -> anyhow::Result<()> {
        let res = self
            .http
            .delete(self.url(&format!(
                "/projects/{}/applications/{}?volumes={volumes}",
                seg(project),
                seg(name)
            )))
            .bearer_auth(&self.token)
            .send()
            .await;
        let _: serde_json::Value = Self::read(res, "removing the application").await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "research_api_tests.rs"]
mod tests;
