//! A small, read-only crates.io API client.
//!
//! crates.io serves a public JSON API (no auth) but requires a descriptive
//! `User-Agent` and asks callers to be gentle (~1 request/second). We list the
//! crates under a keyword, then fetch each crate's detail (with its version
//! history). Only the fields we persist are deserialized; everything else is
//! ignored.

use std::time::Duration;

use anyhow::{Context, anyhow};
use serde::Deserialize;

/// Default API root. Overridable via `STUDIO_CRATES_IO_BASE` (tests / mirrors).
const DEFAULT_BASE: &str = "https://crates.io/api/v1";
/// Descriptive UA — crates.io rejects requests without one.
const USER_AGENT: &str =
    "constructor-studio-components-catalog (https://github.com/constructorfabric)";
/// Page size for the keyword listing (crates.io caps this at 100).
const PER_PAGE: u32 = 100;
/// Backstop on listing pages, so a bad loop can't hammer the API.
const MAX_PAGES: u32 = 20;

/// One crate as it appears in a listing or a detail's `crate` field. Optional
/// everywhere the API can omit a value.
#[derive(Debug, Clone, Deserialize)]
pub struct CrateSummary {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub max_version: Option<String>,
    #[serde(default)]
    pub newest_version: Option<String>,
    #[serde(default)]
    pub max_stable_version: Option<String>,
    #[serde(default)]
    pub downloads: Option<u64>,
    #[serde(default)]
    pub recent_downloads: Option<u64>,
    #[serde(default)]
    pub num_versions: Option<u32>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub documentation: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
}

/// One published version of a crate.
#[derive(Debug, Clone, Deserialize)]
pub struct VersionInfo {
    pub num: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub yanked: Option<bool>,
    #[serde(default)]
    pub yank_message: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub crate_size: Option<u64>,
    #[serde(default)]
    pub downloads: Option<u64>,
    #[serde(default)]
    pub rust_version: Option<String>,
    #[serde(default)]
    pub edition: Option<String>,
    #[serde(default)]
    pub has_lib: Option<bool>,
    #[serde(default)]
    pub published_by: Option<PublishedBy>,
}

/// Who pushed a version (crates.io user), when present.
#[derive(Debug, Clone, Deserialize)]
pub struct PublishedBy {
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// A crate's full detail: the crate plus its version history and taxonomy.
#[derive(Debug, Clone)]
pub struct CrateDetail {
    pub krate: CrateSummary,
    pub versions: Vec<VersionInfo>,
    pub keywords: Vec<String>,
    pub categories: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ListResponse {
    #[serde(default)]
    crates: Vec<CrateSummary>,
    #[serde(default)]
    meta: Meta,
}

#[derive(Debug, Default, Deserialize)]
struct Meta {
    #[serde(default)]
    total: u32,
}

#[derive(Debug, Deserialize)]
struct DetailResponse {
    #[serde(rename = "crate")]
    krate: CrateSummary,
    #[serde(default)]
    versions: Vec<VersionInfo>,
    #[serde(default)]
    keywords: Vec<KeywordRef>,
    #[serde(default)]
    categories: Vec<CategoryRef>,
}

#[derive(Debug, Deserialize)]
struct KeywordRef {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    keyword: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CategoryRef {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    category: Option<String>,
}

/// Read-only crates.io client.
pub struct CratesIoClient {
    http: reqwest::Client,
    base: String,
}

impl CratesIoClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let base = std::env::var("STUDIO_CRATES_IO_BASE")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE.to_string());
        Self { http, base }
    }

    /// Every crate carrying `keyword`, following pagination to the end.
    pub async fn list_by_keyword(&self, keyword: &str) -> anyhow::Result<Vec<CrateSummary>> {
        let mut out: Vec<CrateSummary> = Vec::new();
        for page in 1..=MAX_PAGES {
            let url = format!(
                "{}/crates?keyword={}&per_page={}&page={}",
                self.base,
                urlencode(keyword),
                PER_PAGE,
                page
            );
            let res = self
                .http
                .get(&url)
                .send()
                .await
                .with_context(|| format!("GET {url}"))?;
            if !res.status().is_success() {
                return Err(anyhow!("crates.io list returned HTTP {}", res.status()));
            }
            let body: ListResponse = res.json().await.context("decode crates.io list")?;
            let got = body.crates.len();
            out.extend(body.crates);
            // Stop when the page came back short or we've collected the reported
            // total — whichever comes first.
            if got < PER_PAGE as usize
                || (body.meta.total > 0 && out.len() >= body.meta.total as usize)
            {
                break;
            }
        }
        Ok(out)
    }

    /// One crate's detail: the crate plus every published version.
    pub async fn crate_detail(&self, name: &str) -> anyhow::Result<CrateDetail> {
        let url = format!("{}/crates/{}", self.base, urlencode(name));
        let res = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !res.status().is_success() {
            return Err(anyhow!(
                "crates.io detail for '{name}' returned HTTP {}",
                res.status()
            ));
        }
        let body: DetailResponse = res
            .json()
            .await
            .with_context(|| format!("decode crates.io detail for '{name}'"))?;
        let keywords = body
            .keywords
            .into_iter()
            .filter_map(|k| k.keyword.or(k.id))
            .collect();
        let categories = body
            .categories
            .into_iter()
            .filter_map(|c| c.category.or(c.slug))
            .collect();
        Ok(CrateDetail {
            krate: body.krate,
            versions: body.versions,
            keywords,
            categories,
        })
    }
}

impl Default for CratesIoClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Minimal percent-encoding for a query/path segment (keyword and crate names
/// here are ASCII `[a-z0-9_-]`, but encode defensively anyway).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
