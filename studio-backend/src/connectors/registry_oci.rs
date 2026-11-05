//! What a registry holds and how to move an image between registries without
//! Docker (ADR-0062 §4, §5): the OCI distribution API spoken directly, with
//! the token negotiation a registry asks for, and the registries' own APIs
//! where the distribution API does not list what they hold -- GHCR has no
//! `_catalog`, and Harbor lists its projects through `/api/v2.0`.
//!
//! Every URL a credential goes to is checked by the URL guard first, the
//! registry's token service included: it is the registry's answer, still a
//! place the server is about to send a secret.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use reqwest::{Method, Response, StatusCode};
use serde::Deserialize;

use super::{RegistryAccess, bearer_challenge};
use crate::connectors::url_guard::{HostRule, check_url};

/// The manifest types a copy asks for: an index (multi-platform) or a single
/// manifest, OCI or Docker.
const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, \
application/vnd.docker.distribution.manifest.list.v2+json, \
application/vnd.oci.image.manifest.v1+json, \
application/vnd.docker.distribution.manifest.v2+json";

/// How deep an index may nest. One level is what exists; this is the limit
/// of a mistake.
const MAX_DEPTH: u8 = 3;

/// The API host of a registry: Docker Hub's names say `docker.io`, its API
/// answers at `registry-1.docker.io`.
pub fn api_host(host: &str) -> &str {
    match host {
        "docker.io" | "index.docker.io" => "registry-1.docker.io",
        other => other,
    }
}

/// One version a registry holds in a repository.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CatalogVersion {
    pub digest: Option<String>,
    pub tags: Vec<String>,
    pub size_bytes: Option<i64>,
    pub pushed_at: Option<String>,
}

/// What an organization's registry holds, read the way that registry lets it
/// be read.
#[async_trait]
pub trait RegistryCatalog: Send + Sync {
    /// The repositories under `path` (`acme`, relative to the host), each as
    /// its full path without the host (`acme/shop/api`).
    async fn repositories(&self, path: &str) -> anyhow::Result<Vec<String>>;
    /// The versions one repository holds.
    async fn versions(&self, repository: &str) -> anyhow::Result<Vec<CatalogVersion>>;
    /// Delete one digest of a repository.
    async fn delete(&self, repository: &str, digest: &str) -> anyhow::Result<()>;
}

/* ── the distribution API ── */

/// A client of one registry's distribution API, logged in as `auth` (or
/// anonymous), holding the bearer token of each scope it was given.
pub struct Oci {
    http: reqwest::Client,
    host: String,
    auth: Option<(String, String)>,
    tokens: Mutex<HashMap<String, String>>,
}

impl Oci {
    pub fn new(http: reqwest::Client, access: &RegistryAccess) -> Self {
        Self {
            http,
            host: access.host.clone(),
            auth: Some((access.username.clone(), access.password.clone())),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// A public registry, read anonymously (an import's source).
    pub fn anonymous(http: reqwest::Client, host: &str) -> Self {
        Self {
            http,
            host: host.to_owned(),
            auth: None,
            tokens: Mutex::new(HashMap::new()),
        }
    }

    fn url(&self, path: &str) -> anyhow::Result<reqwest::Url> {
        let base = check_url(
            &format!("https://{}", api_host(&self.host)),
            "the registry address",
            HostRule::AnyPublic,
        )?;
        Ok(base.join(path)?)
    }

    /// Send `method path` for `scope` (`repository:acme/x:pull`): with the
    /// scope's token when there is one, else with the login; on a token
    /// challenge, ask the token service for the scope and send once more.
    async fn send(
        &self,
        method: Method,
        path: &str,
        scope: &str,
        build: &(dyn Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder + Sync),
    ) -> anyhow::Result<Response> {
        let url = self.url(path)?;
        let token = self.tokens.lock().ok().and_then(|t| t.get(scope).cloned());
        let first = {
            let req = self.http.request(method.clone(), url.clone());
            let req = match (&token, &self.auth) {
                (Some(t), _) => req.bearer_auth(t),
                (None, Some((u, p))) => req.basic_auth(u, Some(p)),
                (None, None) => req,
            };
            build(req)
                .send()
                .await
                .map_err(|e| anyhow!("{} did not answer: {e}", self.host))?
        };
        if first.status() != StatusCode::UNAUTHORIZED {
            return Ok(first);
        }
        let Some(challenge) = first
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .and_then(bearer_challenge)
        else {
            return Ok(first);
        };
        let mut realm = check_url(
            &challenge.realm,
            "the registry's token service",
            HostRule::AnyPublic,
        )?;
        {
            let mut q = realm.query_pairs_mut();
            if let Some(service) = &challenge.service {
                q.append_pair("service", service);
            }
            for one in scope.split(' ').filter(|s| !s.is_empty()) {
                q.append_pair("scope", one);
            }
        }
        let req = self.http.get(realm);
        let req = match &self.auth {
            Some((u, p)) => req.basic_auth(u, Some(p)),
            None => req,
        };
        let res = req
            .send()
            .await
            .map_err(|e| anyhow!("the token service of {} did not answer: {e}", self.host))?;
        if !res.status().is_success() {
            bail!(
                "{} refused a token for {scope} ({})",
                self.host,
                res.status()
            );
        }
        let body: serde_json::Value = res.json().await?;
        let token = body
            .get("token")
            .or_else(|| body.get("access_token"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| anyhow!("the token service of {} gave no token", self.host))?
            .to_owned();
        if let Ok(mut t) = self.tokens.lock() {
            t.insert(scope.to_owned(), token.clone());
        }
        let req = build(self.http.request(method, url).bearer_auth(&token));
        req.send()
            .await
            .map_err(|e| anyhow!("{} did not answer: {e}", self.host))
    }

    /// A manifest's digest, media type and size, without its body.
    pub async fn head_manifest(
        &self,
        repo: &str,
        reference: &str,
    ) -> anyhow::Result<Option<(String, String, Option<i64>)>> {
        let res = self
            .send(
                Method::HEAD,
                &format!("/v2/{repo}/manifests/{reference}"),
                &format!("repository:{repo}:pull"),
                &|r| r.header(reqwest::header::ACCEPT, MANIFEST_TYPES),
            )
            .await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            bail!(
                "{} answered {} for {repo}:{reference}",
                self.host,
                res.status()
            );
        }
        let header = |k: &str| {
            res.headers()
                .get(k)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let digest = header("docker-content-digest").unwrap_or_else(|| reference.to_owned());
        let media = header("content-type").unwrap_or_default();
        let size = header("content-length").and_then(|n| n.parse().ok());
        Ok(Some((digest, media, size)))
    }

    async fn get_manifest(
        &self,
        repo: &str,
        reference: &str,
    ) -> anyhow::Result<(Vec<u8>, String, String)> {
        let res = self
            .send(
                Method::GET,
                &format!("/v2/{repo}/manifests/{reference}"),
                &format!("repository:{repo}:pull"),
                &|r| r.header(reqwest::header::ACCEPT, MANIFEST_TYPES),
            )
            .await?;
        if !res.status().is_success() {
            bail!(
                "{} answered {} for {repo}:{reference}",
                self.host,
                res.status()
            );
        }
        let media = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let bytes = res.bytes().await?.to_vec();
        let digest = format!(
            "sha256:{}",
            hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes))
        );
        Ok((bytes, media, digest))
    }

    async fn put_manifest(
        &self,
        repo: &str,
        reference: &str,
        body: &[u8],
        media: &str,
    ) -> anyhow::Result<()> {
        let body = body.to_vec();
        let res = self
            .send(
                Method::PUT,
                &format!("/v2/{repo}/manifests/{reference}"),
                &format!("repository:{repo}:pull,push"),
                &|r| {
                    r.header(reqwest::header::CONTENT_TYPE, media)
                        .body(body.clone())
                },
            )
            .await?;
        if !res.status().is_success() {
            bail!(
                "{} refused the manifest {repo}:{reference} ({})",
                self.host,
                res.status()
            );
        }
        Ok(())
    }

    async fn has_blob(&self, repo: &str, digest: &str) -> anyhow::Result<bool> {
        let res = self
            .send(
                Method::HEAD,
                &format!("/v2/{repo}/blobs/{digest}"),
                &format!("repository:{repo}:pull,push"),
                &|r| r,
            )
            .await?;
        Ok(res.status().is_success())
    }

    /// Copy one blob from `src` into `repo` here: mounted when both are this
    /// registry, else streamed through, never written to disk.
    async fn copy_blob(
        &self,
        src: &Oci,
        src_repo: &str,
        repo: &str,
        digest: &str,
    ) -> anyhow::Result<()> {
        if self.has_blob(repo, digest).await? {
            return Ok(());
        }
        if src.host == self.host {
            let res = self
                .send(
                    Method::POST,
                    &format!("/v2/{repo}/blobs/uploads/?mount={digest}&from={src_repo}"),
                    &format!("repository:{repo}:pull,push repository:{src_repo}:pull"),
                    &|r| r.header(reqwest::header::CONTENT_LENGTH, "0"),
                )
                .await?;
            if res.status() == StatusCode::CREATED {
                return Ok(());
            }
        }
        let blob = src
            .send(
                Method::GET,
                &format!("/v2/{src_repo}/blobs/{digest}"),
                &format!("repository:{src_repo}:pull"),
                &|r| r,
            )
            .await?;
        if !blob.status().is_success() {
            bail!("{} answered {} for blob {digest}", src.host, blob.status());
        }
        let len = blob.content_length();
        let start = self
            .send(
                Method::POST,
                &format!("/v2/{repo}/blobs/uploads/"),
                &format!("repository:{repo}:pull,push"),
                &|r| r.header(reqwest::header::CONTENT_LENGTH, "0"),
            )
            .await?;
        if !start.status().is_success() {
            bail!(
                "{} refused an upload to {repo} ({})",
                self.host,
                start.status()
            );
        }
        let location = start
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| anyhow!("{} started an upload without a location", self.host))?
            .to_owned();
        let mut put = if location.starts_with("https://") || location.starts_with("http://") {
            check_url(
                &location,
                "the registry's upload address",
                HostRule::AnyPublic,
            )?
        } else {
            self.url(&location)?
        };
        put.query_pairs_mut().append_pair("digest", digest);
        // The upload's own URL carries its session; the token of the push
        // scope is sent with it.
        let token = self
            .tokens
            .lock()
            .ok()
            .and_then(|t| t.get(&format!("repository:{repo}:pull,push")).cloned());
        let mut req = self
            .http
            .put(put)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream");
        req = match (&token, &self.auth) {
            (Some(t), _) => req.bearer_auth(t),
            (None, Some((u, p))) => req.basic_auth(u, Some(p)),
            (None, None) => req,
        };
        if let Some(n) = len {
            req = req.header(reqwest::header::CONTENT_LENGTH, n);
        }
        let res = req
            .body(reqwest::Body::wrap_stream(blob.bytes_stream()))
            .send()
            .await
            .map_err(|e| anyhow!("{} did not take blob {digest}: {e}", self.host))?;
        if !res.status().is_success() {
            bail!("{} refused blob {digest} ({})", self.host, res.status());
        }
        Ok(())
    }

    /// Copy `src_repo@reference` from `src` into `repo` here, by digest, with
    /// `tags`; the digest copied. An index is copied with every manifest it
    /// lists, so a multi-platform image arrives whole.
    pub async fn copy_from(
        &self,
        src: &Oci,
        src_repo: &str,
        reference: &str,
        repo: &str,
        tags: &[String],
    ) -> anyhow::Result<String> {
        let digest = self
            .copy_manifest(src, src_repo, reference, repo, 0)
            .await?;
        let (body, media, _) = src.get_manifest(src_repo, &digest).await?;
        for tag in tags {
            self.put_manifest(repo, tag, &body, &media).await?;
        }
        Ok(digest)
    }

    fn copy_manifest<'a>(
        &'a self,
        src: &'a Oci,
        src_repo: &'a str,
        reference: &'a str,
        repo: &'a str,
        depth: u8,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send + 'a>>
    {
        Box::pin(async move {
            if depth > MAX_DEPTH {
                bail!("{src_repo}:{reference} nests indexes deeper than {MAX_DEPTH}");
            }
            let (body, media, digest) = src.get_manifest(src_repo, reference).await?;
            let doc: Manifest = serde_json::from_slice(&body)
                .with_context(|| format!("{src_repo}:{reference} is not a manifest"))?;
            for child in &doc.manifests {
                self.copy_manifest(src, src_repo, &child.digest, repo, depth + 1)
                    .await?;
            }
            for blob in doc.config.iter().chain(doc.layers.iter()) {
                self.copy_blob(src, src_repo, repo, &blob.digest).await?;
            }
            self.put_manifest(repo, &digest, &body, &media).await?;
            Ok(digest)
        })
    }

    pub async fn tags(&self, repo: &str) -> anyhow::Result<Vec<String>> {
        let res = self
            .send(
                Method::GET,
                &format!("/v2/{repo}/tags/list"),
                &format!("repository:{repo}:pull"),
                &|r| r,
            )
            .await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !res.status().is_success() {
            bail!("{} answered {} listing {repo}", self.host, res.status());
        }
        #[derive(Deserialize)]
        struct Tags {
            #[serde(default)]
            tags: Option<Vec<String>>,
        }
        Ok(res.json::<Tags>().await?.tags.unwrap_or_default())
    }

    pub async fn delete_manifest(&self, repo: &str, digest: &str) -> anyhow::Result<()> {
        let res = self
            .send(
                Method::DELETE,
                &format!("/v2/{repo}/manifests/{digest}"),
                &format!("repository:{repo}:delete"),
                &|r| r,
            )
            .await?;
        match res.status() {
            s if s.is_success() || s == StatusCode::NOT_FOUND => Ok(()),
            s => bail!("{} refused to delete {repo}@{digest} ({s})", self.host),
        }
    }
}

#[derive(Debug, Deserialize)]
struct Descriptor {
    digest: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    manifests: Vec<Descriptor>,
    #[serde(default)]
    config: Option<Descriptor>,
    #[serde(default)]
    layers: Vec<Descriptor>,
}

/* ── the generic catalogue: `_catalog` and `tags/list` ── */

pub struct GenericCatalog {
    oci: Oci,
}

#[async_trait]
impl RegistryCatalog for GenericCatalog {
    async fn repositories(&self, path: &str) -> anyhow::Result<Vec<String>> {
        let res = self
            .oci
            .send(
                Method::GET,
                "/v2/_catalog?n=1000",
                "registry:catalog:*",
                &|r| r,
            )
            .await?;
        if !res.status().is_success() {
            bail!(
                "{} does not list its repositories ({}): it answers for named ones only",
                self.oci.host,
                res.status()
            );
        }
        #[derive(Deserialize)]
        struct Catalog {
            #[serde(default)]
            repositories: Vec<String>,
        }
        let prefix = format!("{}/", path.trim_matches('/'));
        Ok(res
            .json::<Catalog>()
            .await?
            .repositories
            .into_iter()
            .filter(|r| path.is_empty() || r.starts_with(&prefix))
            .collect())
    }

    async fn versions(&self, repository: &str) -> anyhow::Result<Vec<CatalogVersion>> {
        let mut by_digest: Vec<CatalogVersion> = Vec::new();
        for tag in self.oci.tags(repository).await? {
            let Some((digest, _, size)) = self.oci.head_manifest(repository, &tag).await? else {
                continue;
            };
            match by_digest
                .iter_mut()
                .find(|v| v.digest.as_deref() == Some(&digest))
            {
                Some(v) => v.tags.push(tag),
                None => by_digest.push(CatalogVersion {
                    digest: Some(digest),
                    tags: vec![tag],
                    size_bytes: size,
                    pushed_at: None,
                }),
            }
        }
        Ok(by_digest)
    }

    async fn delete(&self, repository: &str, digest: &str) -> anyhow::Result<()> {
        self.oci.delete_manifest(repository, digest).await
    }
}

/* ── GHCR, through the GitHub Packages API ── */

/// `acme/shop/api` → `shop%2Fapi` under owner `acme`: GitHub names a nested
/// container package by its path after the owner, URL-encoded.
pub fn ghcr_package(repository: &str) -> Option<(&str, String)> {
    let (owner, name) = repository.split_once('/')?;
    Some((owner, name.replace('/', "%2F")))
}

pub struct GhcrCatalog {
    http: reqwest::Client,
    token: String,
    /// `orgs` or `users`, found on first use.
    owner_kind: Mutex<HashMap<String, &'static str>>,
}

impl GhcrCatalog {
    async fn get(&self, path: &str) -> anyhow::Result<Response> {
        self.http
            .get(format!("https://api.github.com{path}"))
            .bearer_auth(&self.token)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|e| anyhow!("api.github.com did not answer: {e}"))
    }

    /// `orgs` or `users` for `owner`: an organization's packages, else a
    /// person's.
    async fn kind_of(&self, owner: &str) -> anyhow::Result<&'static str> {
        if let Some(k) = self
            .owner_kind
            .lock()
            .ok()
            .and_then(|m| m.get(owner).copied())
        {
            return Ok(k);
        }
        let res = self
            .get(&format!(
                "/orgs/{owner}/packages?package_type=container&per_page=1"
            ))
            .await?;
        let kind = if res.status().is_success() {
            "orgs"
        } else {
            "users"
        };
        if let Ok(mut m) = self.owner_kind.lock() {
            m.insert(owner.to_owned(), kind);
        }
        Ok(kind)
    }
}

#[async_trait]
impl RegistryCatalog for GhcrCatalog {
    async fn repositories(&self, path: &str) -> anyhow::Result<Vec<String>> {
        let path = path.trim_matches('/');
        let (owner, under) = path.split_once('/').unwrap_or((path, ""));
        if owner.is_empty() {
            bail!("a GHCR prefix names its owner: ghcr.io/<owner>");
        }
        let kind = self.kind_of(owner).await?;
        #[derive(Deserialize)]
        struct Package {
            name: String,
        }
        let mut out = Vec::new();
        for page in 1..=10 {
            let res = self
                .get(&format!(
                    "/{kind}/{owner}/packages?package_type=container&per_page=100&page={page}"
                ))
                .await?;
            if !res.status().is_success() {
                bail!(
                    "GitHub did not list the container packages of {owner} ({}): the token needs \
                     read:packages",
                    res.status()
                );
            }
            let list: Vec<Package> = res.json().await?;
            let n = list.len();
            out.extend(
                list.into_iter()
                    .map(|p| format!("{owner}/{}", p.name))
                    .filter(|r| under.is_empty() || r.starts_with(&format!("{owner}/{under}/"))),
            );
            if n < 100 {
                break;
            }
        }
        Ok(out)
    }

    async fn versions(&self, repository: &str) -> anyhow::Result<Vec<CatalogVersion>> {
        let (owner, package) =
            ghcr_package(repository).ok_or_else(|| anyhow!("'{repository}' names no owner"))?;
        let kind = self.kind_of(owner).await?;
        #[derive(Deserialize)]
        struct Version {
            name: String,
            #[serde(default)]
            created_at: Option<String>,
            #[serde(default)]
            metadata: Option<serde_json::Value>,
        }
        let res = self
            .get(&format!(
                "/{kind}/{owner}/packages/container/{package}/versions?per_page=100"
            ))
            .await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !res.status().is_success() {
            bail!(
                "GitHub did not list the versions of {repository} ({})",
                res.status()
            );
        }
        Ok(res
            .json::<Vec<Version>>()
            .await?
            .into_iter()
            .map(|v| CatalogVersion {
                tags: v
                    .metadata
                    .as_ref()
                    .and_then(|m| m.pointer("/container/tags"))
                    .and_then(|t| t.as_array())
                    .map(|t| {
                        t.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                digest: Some(v.name),
                size_bytes: None,
                pushed_at: v.created_at,
            })
            .collect())
    }

    async fn delete(&self, repository: &str, digest: &str) -> anyhow::Result<()> {
        let (owner, package) =
            ghcr_package(repository).ok_or_else(|| anyhow!("'{repository}' names no owner"))?;
        let kind = self.kind_of(owner).await?;
        #[derive(Deserialize)]
        struct Version {
            id: u64,
            name: String,
        }
        let res = self
            .get(&format!(
                "/{kind}/{owner}/packages/container/{package}/versions?per_page=100"
            ))
            .await?;
        if !res.status().is_success() {
            bail!(
                "GitHub did not list the versions of {repository} ({})",
                res.status()
            );
        }
        let Some(v) = res
            .json::<Vec<Version>>()
            .await?
            .into_iter()
            .find(|v| v.name == digest)
        else {
            return Ok(());
        };
        let res = self
            .http
            .delete(format!(
                "https://api.github.com/{kind}/{owner}/packages/container/{package}/versions/{}",
                v.id
            ))
            .bearer_auth(&self.token)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| anyhow!("api.github.com did not answer: {e}"))?;
        match res.status() {
            s if s.is_success() || s == StatusCode::NOT_FOUND => Ok(()),
            s => bail!(
                "GitHub refused to delete {repository}@{digest} ({s}): the token needs \
                 delete:packages for that"
            ),
        }
    }
}

/* ── Harbor, through /api/v2.0 ── */

/// Harbor's repository path segment: `shop/api` under project `acme`, the
/// slash encoded twice, as its API asks.
pub fn harbor_repository(repository: &str) -> Option<(&str, String)> {
    let (project, name) = repository.split_once('/')?;
    Some((project, name.replace('/', "%252F")))
}

pub struct HarborCatalog {
    http: reqwest::Client,
    base: reqwest::Url,
    username: String,
    password: String,
}

impl HarborCatalog {
    async fn call(&self, method: Method, path: &str) -> anyhow::Result<Response> {
        self.http
            .request(method, self.base.join(path)?)
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await
            .map_err(|e| anyhow!("Harbor did not answer: {e}"))
    }
}

#[async_trait]
impl RegistryCatalog for HarborCatalog {
    async fn repositories(&self, path: &str) -> anyhow::Result<Vec<String>> {
        let path = path.trim_matches('/');
        let project = path.split('/').next().unwrap_or_default();
        if project.is_empty() {
            bail!("a Harbor prefix names its project: <host>/<project>");
        }
        #[derive(Deserialize)]
        struct Repo {
            name: String,
        }
        let res = self
            .call(
                Method::GET,
                &format!("/api/v2.0/projects/{project}/repositories?page_size=100"),
            )
            .await?;
        if !res.status().is_success() {
            bail!("Harbor did not list project {project} ({})", res.status());
        }
        let prefix = format!("{path}/");
        Ok(res
            .json::<Vec<Repo>>()
            .await?
            .into_iter()
            .map(|r| r.name)
            .filter(|r| r.starts_with(&prefix))
            .collect())
    }

    async fn versions(&self, repository: &str) -> anyhow::Result<Vec<CatalogVersion>> {
        let (project, repo) = harbor_repository(repository)
            .ok_or_else(|| anyhow!("'{repository}' names no Harbor project"))?;
        #[derive(Deserialize)]
        struct Tag {
            name: String,
        }
        #[derive(Deserialize)]
        struct Artifact {
            digest: String,
            #[serde(default)]
            size: Option<i64>,
            #[serde(default)]
            push_time: Option<String>,
            #[serde(default)]
            tags: Option<Vec<Tag>>,
        }
        let res = self
            .call(
                Method::GET,
                &format!(
                    "/api/v2.0/projects/{project}/repositories/{repo}/artifacts?with_tag=true&page_size=100"
                ),
            )
            .await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !res.status().is_success() {
            bail!("Harbor did not list {repository} ({})", res.status());
        }
        Ok(res
            .json::<Vec<Artifact>>()
            .await?
            .into_iter()
            .map(|a| CatalogVersion {
                digest: Some(a.digest),
                tags: a
                    .tags
                    .unwrap_or_default()
                    .into_iter()
                    .map(|t| t.name)
                    .collect(),
                size_bytes: a.size,
                pushed_at: a.push_time,
            })
            .collect())
    }

    async fn delete(&self, repository: &str, digest: &str) -> anyhow::Result<()> {
        let (project, repo) = harbor_repository(repository)
            .ok_or_else(|| anyhow!("'{repository}' names no Harbor project"))?;
        let res = self
            .call(
                Method::DELETE,
                &format!("/api/v2.0/projects/{project}/repositories/{repo}/artifacts/{digest}"),
            )
            .await?;
        match res.status() {
            s if s.is_success() || s == StatusCode::NOT_FOUND => Ok(()),
            s => bail!("Harbor refused to delete {repository}@{digest} ({s})"),
        }
    }
}

/// The catalogue of the registry `access` logs in to: GHCR by its host,
/// Harbor when it answers `/api/v2.0/systeminfo`, else the distribution API.
pub async fn catalog_for(
    http: &reqwest::Client,
    access: &RegistryAccess,
) -> anyhow::Result<Box<dyn RegistryCatalog>> {
    if access.host == "ghcr.io" {
        return Ok(Box::new(GhcrCatalog {
            http: http.clone(),
            token: access.password.clone(),
            owner_kind: Mutex::new(HashMap::new()),
        }));
    }
    let base = check_url(
        &format!("https://{}", access.host),
        "the registry address",
        HostRule::AnyPublic,
    )?;
    let harbor = http
        .get(base.join("/api/v2.0/systeminfo")?)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    if harbor {
        return Ok(Box::new(HarborCatalog {
            http: http.clone(),
            base,
            username: access.username.clone(),
            password: access.password.clone(),
        }));
    }
    Ok(Box::new(GenericCatalog {
        oci: Oci::new(http.clone(), access),
    }))
}

/* ── what a token may do ── */

/// What a registry token may do, as far as its registry says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenScopes {
    /// The scopes the registry names (GHCR: GitHub's `X-OAuth-Scopes`).
    Known(Vec<String>),
    /// The registry does not say (a robot account, a fine-grained token).
    Unknown,
}

/// The scopes among `scopes` that reach past pushing and pulling images:
/// administration, deletion, the repositories themselves.
pub fn too_broad(scopes: &[String]) -> Vec<String> {
    scopes
        .iter()
        .filter(|s| {
            let s = s.trim();
            s.starts_with("admin:")
                || s.starts_with("delete:")
                || matches!(
                    s,
                    "repo" | "workflow" | "write:org" | "user" | "site_admin" | "delete_repo"
                )
        })
        .cloned()
        .collect()
}

/// Ask the registry what `access`'s token may do. GHCR's tokens are GitHub
/// tokens, whose scopes GitHub's API names on any authenticated answer.
pub async fn token_scopes(
    http: &reqwest::Client,
    access: &RegistryAccess,
) -> anyhow::Result<TokenScopes> {
    if access.host != "ghcr.io" {
        return Ok(TokenScopes::Unknown);
    }
    let res = http
        .get("https://api.github.com/")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("token {}", access.password),
        )
        .send()
        .await
        .map_err(|e| anyhow!("api.github.com did not answer: {e}"))?;
    if res.status() == StatusCode::UNAUTHORIZED {
        bail!("GitHub refused the registry token");
    }
    Ok(
        match res
            .headers()
            .get("x-oauth-scopes")
            .and_then(|v| v.to_str().ok())
        {
            Some(list) => TokenScopes::Known(
                list.split(',')
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect(),
            ),
            None => TokenScopes::Unknown,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_hub_answers_at_its_api_host() {
        assert_eq!(api_host("docker.io"), "registry-1.docker.io");
        assert_eq!(api_host("ghcr.io"), "ghcr.io");
    }

    #[test]
    fn a_nested_package_is_named_after_its_owner_url_encoded() {
        assert_eq!(
            ghcr_package("acme/shop/api"),
            Some(("acme", "shop%2Fapi".to_owned()))
        );
        assert_eq!(ghcr_package("acme"), None);
        assert_eq!(
            harbor_repository("acme/shop/api"),
            Some(("acme", "shop%252Fapi".to_owned()))
        );
    }

    #[test]
    fn a_token_that_administers_or_deletes_is_too_broad() {
        let scopes: Vec<String> = [
            "write:packages",
            "read:packages",
            "admin:org",
            "delete:packages",
            "repo",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert_eq!(
            too_broad(&scopes),
            vec!["admin:org", "delete:packages", "repo"]
        );
        assert!(too_broad(&["write:packages".to_owned(), "read:packages".to_owned()]).is_empty());
    }

    #[test]
    fn an_index_lists_its_manifests_and_a_manifest_its_blobs() {
        let index: Manifest = serde_json::from_str(
            r#"{"schemaVersion":2,"manifests":[{"digest":"sha256:a","mediaType":"x","size":1}]}"#,
        )
        .unwrap();
        assert_eq!(index.manifests.len(), 1);
        let m: Manifest = serde_json::from_str(
            r#"{"config":{"digest":"sha256:c"},"layers":[{"digest":"sha256:l1"},{"digest":"sha256:l2"}]}"#,
        )
        .unwrap();
        assert_eq!(m.config.unwrap().digest, "sha256:c");
        assert_eq!(m.layers.len(), 2);
    }
}
