//! Reading the plan file from its repository, through the organization's
//! GitHub connection -- the same one the board is read through.

use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use base64::Engine as _;
use serde_json::Value;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::source::PlanFile;
use crate::connectors::service::ConnectorService;

/// A file's text and the blob it was.
#[derive(Clone, Debug, PartialEq)]
pub struct FileText {
    pub text: String,
    pub sha: Option<String>,
}

#[async_trait]
pub trait PlanReader: Send + Sync {
    async fn read(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        file: &PlanFile,
    ) -> Result<FileText>;

    /// Whether the connection the board is read through resolves in
    /// `tenant` and its token is readable -- asked before the board sync is
    /// queued, because that sync reads the board on its own time and treats
    /// a board it cannot read as one source of many, so it cannot refuse.
    async fn connection(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
    ) -> Result<()>;
}

pub struct GitHubPlanReader {
    connectors: Arc<ConnectorService>,
}

impl GitHubPlanReader {
    pub fn new(connectors: Arc<ConnectorService>) -> Self {
        Self { connectors }
    }
}

/// `GET /repos/{owner}/{repo}/contents/{path}?ref=` on a connection's API root.
pub fn contents_url(root: &str, file: &PlanFile) -> String {
    let path: Vec<String> = file.path.split('/').map(urlencode).collect();
    let mut url = format!(
        "{}/repos/{}/{}/contents/{}",
        root.trim_end_matches('/'),
        urlencode(&file.owner),
        urlencode(&file.repo),
        path.join("/")
    );
    if let Some(r) = &file.git_ref {
        url.push_str("?ref=");
        url.push_str(&urlencode(r));
    }
    url
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The text of a contents-API answer for one file.
pub fn decode_contents(body: &Value) -> Result<FileText> {
    if body.is_array() {
        bail!("that path is a directory, not a file");
    }
    if body
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|t| t != "file")
    {
        bail!("that path is not a file");
    }
    let encoded = body
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("GitHub answered no content for the file (larger than 1 MB?)"))?;
    if body
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("base64")
        != "base64"
    {
        bail!("GitHub answered the file in an encoding this cannot read");
    }
    // GitHub wraps base64 at 60 columns.
    let compact: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|e| anyhow!("the file's content is not base64: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| anyhow!("the file is not UTF-8 text"))?;
    Ok(FileText {
        text,
        sha: body.get("sha").and_then(Value::as_str).map(str::to_string),
    })
}

#[async_trait]
impl PlanReader for GitHubPlanReader {
    async fn connection(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
    ) -> Result<()> {
        self.connectors
            .named_or_default(ctx, tenant, connection_id, "github")
            .await
            .map(|_| ())
            .map_err(|e| anyhow!("the board cannot be read: {e:#}"))
    }

    async fn read(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        file: &PlanFile,
    ) -> Result<FileText> {
        let (_driver, auth, _conn) = self
            .connectors
            .named_or_default(ctx, tenant, connection_id, "github")
            .await?;
        let http = reqwest::Client::builder()
            .user_agent("constructor-studio-reports")
            .build()?;
        let res = http
            .get(contents_url(auth.root(), file))
            .bearer_auth(&auth.token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        let status = res.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            bail!(
                "{} is not visible to this connection (no such file, or the token may not read that repository)",
                file.display()
            );
        }
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            bail!(
                "GitHub {status}: {}",
                text.chars().take(200).collect::<String>()
            );
        }
        decode_contents(&res.json().await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(path: &str, git_ref: Option<&str>) -> PlanFile {
        PlanFile {
            owner: "constructorfabric".into(),
            repo: "cf-internal".into(),
            path: path.into(),
            git_ref: git_ref.map(str::to_string),
        }
    }

    #[test]
    fn the_url_names_the_file_and_its_ref() {
        assert_eq!(
            contents_url(
                "https://api.github.com/",
                &file("gears/gears.yaml", Some("main"))
            ),
            "https://api.github.com/repos/constructorfabric/cf-internal/contents/gears/gears.yaml?ref=main"
        );
        assert_eq!(
            contents_url("https://ghe.example/api/v3", &file("a b/plan.yaml", None)),
            "https://ghe.example/api/v3/repos/constructorfabric/cf-internal/contents/a%20b/plan.yaml"
        );
        assert!(
            contents_url("https://api.github.com", &file("p.yaml", Some("feature/x")))
                .ends_with("?ref=feature%2Fx")
        );
    }

    #[test]
    fn a_file_is_its_decoded_content() {
        let encoded = base64::engine::general_purpose::STANDARD.encode("board: o/48\n");
        // As GitHub sends it: wrapped.
        let wrapped = format!("{}\n{}", &encoded[..8], &encoded[8..]);
        let body =
            json!({ "type": "file", "encoding": "base64", "content": wrapped, "sha": "abc" });
        assert_eq!(
            decode_contents(&body).expect("decoded"),
            FileText {
                text: "board: o/48\n".into(),
                sha: Some("abc".into())
            }
        );
    }

    #[test]
    fn a_directory_or_a_file_without_content_is_refused() {
        assert!(
            decode_contents(&json!([{ "name": "a" }]))
                .unwrap_err()
                .to_string()
                .contains("directory")
        );
        assert!(
            decode_contents(&json!({ "type": "dir" }))
                .unwrap_err()
                .to_string()
                .contains("not a file")
        );
        assert!(
            decode_contents(&json!({ "type": "file" }))
                .unwrap_err()
                .to_string()
                .contains("no content")
        );
        assert!(decode_contents(&json!({ "type": "file", "content": "!!!" })).is_err());
        let latin = base64::engine::general_purpose::STANDARD.encode([0xff, 0xfe]);
        assert!(
            decode_contents(&json!({ "type": "file", "content": latin }))
                .unwrap_err()
                .to_string()
                .contains("UTF-8")
        );
        assert!(
            decode_contents(&json!({ "type": "file", "encoding": "none", "content": "" })).is_err()
        );
    }
}
