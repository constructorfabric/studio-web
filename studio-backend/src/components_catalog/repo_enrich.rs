//! Repository enrichment — the primary data source for the catalogue.
//!
//! crates.io tells us a gear's published *versions*; the gears' repository tells
//! us what the gear actually *is* — its spec state, ADRs, tests, ownership. This
//! module reads that engineering metadata straight from the gears' GitHub
//! repository (default `constructorfabric/gears-rust`) and maps it onto the same
//! field model the catalogue UI renders, so each Gear opens a real component
//! page instead of a crates.io stub.
//!
//! Auth reuses an existing Studio **GitHub connection** — the connector already
//! holds the token in credstore, so nothing new is wired here. It is entirely
//! best-effort: no connection, no repo access, or a truncated tree degrades to
//! "crates.io only", never a failed sync.
//!
//! Configuration (all optional; enrichment is off until a tenant is set):
//!   * `STUDIO_GEARS_CATALOG_TENANT`      — tenant UUID that owns the GitHub connection
//!   * `STUDIO_GEARS_CATALOG_CONNECTION`  — a specific connection UUID (else the first github one)
//!   * `STUDIO_GEARS_CATALOG_REPO`        — `owner/name` (default `constructorfabric/gears-rust`)
//!   * `STUDIO_GEARS_CATALOG_REF`         — git ref to read (default `HEAD`)

use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use crate::connectors::driver::ConnectionAuth;
use crate::connectors::service::ConnectorService;

const UA: &str = "constructor-studio-gears-catalog";

/// One gear discovered in the repository: the directory that carries its
/// `gear.toml`, the crate name it maps to, and the field map the UI renders.
pub struct RepoGear {
    /// Primary crate name for this Gear (`cf-gears-<slug>`), the key the
    /// crates.io side also uses, so the two sources merge by name.
    pub crate_name: String,
    pub description: Option<String>,
    /// `fieldKey -> { v, b, n, s, l, u }`, written to the profile's `auto` map.
    pub fields: Value,
    /// UML blocks lifted from `docs/DESIGN.md`, for the profile's `uml` array.
    pub uml: Vec<Value>,
    /// Component kind override (`frontx` for micro-frontends); `None` lets the
    /// service classify a gear crate by name.
    pub kind: Option<String>,
    /// Category / domain, surfaced on the component node for filtering.
    pub category: Option<String>,
}

/// What a repository source contributes: platform gears, or FrontX micro-frontends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepoMode {
    Gears,
    Frontx,
}

impl RepoMode {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "frontx" | "micro-frontend" | "microfrontend" | "mf" => RepoMode::Frontx,
            _ => RepoMode::Gears,
        }
    }
}

/// Reads gear metadata from a repository, using a Studio GitHub connection for
/// auth. Constructed per sync from the source the caller chose on the Gears page.
pub struct RepoEnricher {
    http: Client,
    connectors: Arc<ConnectorService>,
    tenant: Uuid,
    connection_id: Option<Uuid>,
    repo: String,
    git_ref: String,
    mode: RepoMode,
}

impl RepoEnricher {
    /// Build from an explicit source selection (a connection + repo picked in
    /// the UI). `git_ref` empty falls back to `HEAD`.
    pub fn new(
        connectors: Arc<ConnectorService>,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        repo: String,
        git_ref: String,
        mode: RepoMode,
    ) -> Option<Self> {
        let repo = repo.trim().trim_start_matches('/').to_string();
        if repo.is_empty() {
            return None;
        }
        let git_ref = {
            let r = git_ref.trim();
            if r.is_empty() {
                "HEAD".to_string()
            } else {
                r.to_string()
            }
        };
        let http = Client::builder().user_agent(UA).build().ok()?;
        Some(Self {
            http,
            connectors,
            tenant,
            connection_id,
            repo,
            git_ref,
            mode,
        })
    }

    /// Read the repository and return one [`RepoGear`] per component. What counts
    /// as a component depends on the mode: a `gear.toml` directory (Gears) or a
    /// `packages/*/package.json` package (FrontX micro-frontends).
    pub async fn enrich(&self, ctx: &SecurityContext) -> Result<Vec<RepoGear>> {
        let auth = self.resolve_auth(ctx).await?;
        let tree = self.tree(&auth).await?;
        if tree.truncated {
            warn!(
                repo = %self.repo,
                "studio-gears-catalog: repository tree was truncated — some counts may be low"
            );
        }
        let paths: Vec<&str> = tree
            .tree
            .iter()
            .filter(|e| e.kind == "blob" || e.kind == "tree")
            .map(|e| e.path.as_str())
            .collect();
        match self.mode {
            RepoMode::Gears => self.discover_gears(&auth, &paths).await,
            RepoMode::Frontx => self.discover_frontx(&auth, &paths).await,
        }
    }

    /// Gears: one component per `gear.toml` directory.
    async fn discover_gears(&self, auth: &ConnectionAuth, paths: &[&str]) -> Result<Vec<RepoGear>> {
        let mut gear_dirs: Vec<String> = Vec::new();
        for &p in paths {
            if p.ends_with("/gear.toml") || p == "gear.toml" {
                gear_dirs.push(parent_dir(p));
            }
        }
        let codeowners = self.read_codeowners(auth).await;
        let mut out: Vec<RepoGear> = Vec::with_capacity(gear_dirs.len());
        for dir in &gear_dirs {
            let slug = dir.rsplit('/').next().unwrap_or(dir).to_string();
            let (fields, uml) = self
                .gear_fields(auth, dir, &slug, paths, codeowners.as_deref())
                .await;
            let description = brief_of(&fields, "description");
            let category = brief_of(&fields, "category");
            out.push(RepoGear {
                crate_name: format!("cf-gears-{slug}"),
                description,
                fields,
                uml,
                kind: None,
                category,
            });
        }
        info!(gears = out.len(), "studio-gears-catalog: gears discovered");
        Ok(out)
    }

    /// FrontX: one component per `packages/*/package.json`.
    async fn discover_frontx(
        &self,
        auth: &ConnectionAuth,
        paths: &[&str],
    ) -> Result<Vec<RepoGear>> {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut out: Vec<RepoGear> = Vec::new();
        for &p in paths {
            if !p.ends_with("/package.json")
                || !p.starts_with("packages/")
                || p.contains("node_modules/")
            {
                continue;
            }
            let dir = parent_dir(p);
            if !seen.insert(dir.clone()) {
                continue;
            }
            let prefix = format!("{dir}/");
            let rel: Vec<&str> = paths
                .iter()
                .filter_map(|q| q.strip_prefix(&prefix))
                .filter(|q| !q.is_empty() && !q.contains("node_modules/"))
                .collect();
            let repo_url = format!(
                "https://github.com/{}/tree/{}/{dir}",
                self.repo, self.git_ref
            );
            let mut f = serde_json::Map::new();
            f.insert("path".into(), text(&dir, Some(&repo_url), None));

            let pkg = self.read_file(auth, p).await;
            let (name, desc, version, category) = pkg
                .as_deref()
                .map(parse_package_json)
                .unwrap_or((None, None, None, None));
            let comp = name
                .clone()
                .unwrap_or_else(|| dir.rsplit('/').next().unwrap_or(&dir).to_string());

            if let Some(v) = &version {
                f.insert("version".into(), text(v, None, None));
            }
            if let Some(d) = &desc {
                f.insert("description".into(), text(d, None, None));
            }
            if let Some(c) = &category {
                f.insert("category".into(), text(c, None, None));
            }
            let dep_keys = pkg
                .as_deref()
                .map(package_json_dep_keys)
                .unwrap_or_default();
            if !dep_keys.is_empty() {
                f.insert("deps".into(), metric(dep_keys.len(), None));
                f.insert(
                    "deps_names".into(),
                    Value::Array(dep_keys.into_iter().map(Value::String).collect()),
                );
            }
            let tests = rel
                .iter()
                .filter(|q| {
                    q.ends_with(".test.ts")
                        || q.ends_with(".test.tsx")
                        || q.ends_with(".spec.ts")
                        || q.ends_with(".spec.tsx")
                })
                .count();
            f.insert("unitmods".into(), metric(tests, None));
            f.insert(
                "e2e".into(),
                boolean(rel.iter().any(|q| {
                    q.contains("e2e") || q.contains("cypress") || q.contains("playwright")
                })),
            );
            f.insert(
                "openapi".into(),
                boolean(rel.iter().any(|q| q.to_lowercase().contains("openapi"))),
            );
            if let Some(date) = self.last_change(auth, &dir).await {
                let day = date.get(0..10).unwrap_or(&date).to_string();
                let mut v = text(&day, None, None);
                if let Some(o) = v.as_object_mut() {
                    o.insert("u".into(), Value::String(day.clone()));
                }
                f.insert("lastchange".into(), v);
            }

            out.push(RepoGear {
                crate_name: comp,
                description: desc,
                fields: Value::Object(f),
                uml: Vec::new(),
                kind: Some("frontx".to_string()),
                category,
            });
        }
        info!(
            components = out.len(),
            "studio-gears-catalog: frontx components discovered"
        );
        Ok(out)
    }

    /// Resolve a GitHub connection's `ConnectionAuth` (base_url + token) via the
    /// connectors service — the token stays in credstore, we only borrow it.
    async fn resolve_auth(&self, ctx: &SecurityContext) -> Result<ConnectionAuth> {
        let id = match self.connection_id {
            Some(id) => id,
            None => {
                let conns = self.connectors.list(ctx, self.tenant).await?;
                conns
                    .into_iter()
                    .find(|c| c.provider == "github")
                    .context("no GitHub connection in the configured catalogue tenant")?
                    .id
            }
        };
        let (_driver, auth, _conn) = self
            .connectors
            .driver_and_auth(ctx, self.tenant, id)
            .await?;
        Ok(auth)
    }

    // ── GitHub REST ──────────────────────────────────────────────────────────

    fn api(&self, auth: &ConnectionAuth, path: &str) -> String {
        format!("{}{}", auth.base_url.trim_end_matches('/'), path)
    }

    async fn tree(&self, auth: &ConnectionAuth) -> Result<GitTree> {
        let url = self.api(
            auth,
            &format!(
                "/repos/{}/git/trees/{}?recursive=1",
                self.repo, self.git_ref
            ),
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&auth.token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(anyhow!("git tree {}: HTTP {}", self.repo, resp.status()));
        }
        Ok(resp.json::<GitTree>().await?)
    }

    /// Fetch one text file's raw content, or `None` when it is absent.
    async fn read_file(&self, auth: &ConnectionAuth, path: &str) -> Option<String> {
        let url = self.api(
            auth,
            &format!(
                "/repos/{}/contents/{}?ref={}",
                self.repo, path, self.git_ref
            ),
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&auth.token)
            .header("Accept", "application/vnd.github.raw")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.text().await.ok()
    }

    async fn read_codeowners(&self, auth: &ConnectionAuth) -> Option<String> {
        for path in [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] {
            if let Some(text) = self.read_file(auth, path).await {
                return Some(text);
            }
        }
        None
    }

    /// The last commit ISO date that touched a directory.
    async fn last_change(&self, auth: &ConnectionAuth, dir: &str) -> Option<String> {
        let url = self.api(
            auth,
            &format!(
                "/repos/{}/commits?path={}&per_page=1&sha={}",
                self.repo, dir, self.git_ref
            ),
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&auth.token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let commits = resp.json::<Vec<CommitEntry>>().await.ok()?;
        commits
            .into_iter()
            .next()
            .and_then(|c| c.commit.committer.and_then(|a| a.date))
    }

    // ── field extraction ─────────────────────────────────────────────────────

    async fn gear_fields(
        &self,
        auth: &ConnectionAuth,
        dir: &str,
        slug: &str,
        paths: &[&str],
        codeowners: Option<&str>,
    ) -> (Value, Vec<Value>) {
        let mut uml: Vec<Value> = Vec::new();
        let prefix = format!("{dir}/");
        // paths under this Gear directory, relative to it
        let rel: Vec<&str> = paths
            .iter()
            .filter_map(|p| p.strip_prefix(&prefix))
            .filter(|p| !p.is_empty())
            .collect();

        let repo_url = format!(
            "https://github.com/{}/tree/{}/{dir}",
            self.repo, self.git_ref
        );
        let mut f = serde_json::Map::new();

        f.insert("path".into(), text(dir, Some(&repo_url), None));

        // runtime form: a service has migrations or an integration tests dir
        let has_migrations = rel.iter().any(|p| p.contains("migrations/"));
        let has_tests_dir = rel
            .iter()
            .any(|p| p.starts_with("tests/") || p.contains("/tests/"));
        let runtime = if has_migrations || has_tests_dir {
            "service"
        } else {
            "library"
        };
        f.insert("runtime".into(), text(runtime, None, None));

        // counts from the tree
        let adr = rel
            .iter()
            .filter(|p| {
                p.starts_with("docs/ADR/") && p.ends_with(".md") && !p.ends_with("README.md")
            })
            .count();
        f.insert(
            "adr".into(),
            metric(adr, Some(&format!("{repo_url}/docs/ADR"))),
        );

        let features = rel
            .iter()
            .filter(|p| p.starts_with("docs/features/") && p.ends_with(".md"))
            .count();
        f.insert("features".into(), metric(features, None));

        let migrations = rel
            .iter()
            .filter(|p| p.contains("migrations/") && p.ends_with(".rs"))
            .count();
        f.insert("migrations".into(), metric(migrations, None));

        let unitmods = rel.iter().filter(|p| p.ends_with("_tests.rs")).count();
        f.insert("unitmods".into(), metric(unitmods, None));

        let integfiles = rel
            .iter()
            .filter(|p| (p.starts_with("tests/") || p.contains("/tests/")) && p.ends_with(".rs"))
            .count();
        f.insert("integfiles".into(), metric(integfiles, None));

        let crates = rel.iter().filter(|p| p.ends_with("Cargo.toml")).count();
        f.insert("crates".into(), metric(crates, None));

        // cheap presence proxies from the tree, to fill more of the page
        let has_sdk = rel
            .iter()
            .any(|p| p.starts_with(&format!("{slug}-sdk/")) || p.contains("-sdk/"));
        f.insert(
            "sdk".into(),
            text(
                if has_sdk {
                    "SDK crate present"
                } else {
                    "no SDK crate"
                },
                None,
                None,
            ),
        );
        f.insert(
            "events".into(),
            boolean(
                rel.iter()
                    .any(|p| p.contains("events/") || p.ends_with("events.rs")),
            ),
        );
        f.insert(
            "fuzz".into(),
            boolean(
                rel.iter()
                    .any(|p| p.starts_with("fuzz/") || p.contains("/fuzz/")),
            ),
        );
        f.insert(
            "guideline".into(),
            boolean(rel.contains(&"docs/operations.md")),
        );
        f.insert(
            "metrics".into(),
            boolean(
                rel.iter()
                    .any(|p| p.ends_with("metrics.rs") || p.contains("telemetry")),
            ),
        );
        f.insert(
            "openapi".into(),
            boolean(rel.iter().any(|p| p.to_lowercase().contains("openapi"))),
        );

        // dependencies on other gears, read from the Cargo manifests (capped).
        let mut deps: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let self_crate = format!("cf-gears-{slug}");
        for pth in rel.iter().filter(|p| p.ends_with("Cargo.toml")).take(6) {
            if let Some(body) = self.read_file(auth, &format!("{dir}/{pth}")).await {
                for d in cargo_gear_deps(&body) {
                    if d != self_crate {
                        deps.insert(d);
                    }
                }
            }
        }
        if !deps.is_empty() {
            f.insert("deps".into(), metric(deps.len(), None));
            f.insert(
                "deps_names".into(),
                Value::Array(deps.iter().map(|d| Value::String(d.clone())).collect()),
            );
        }

        // E2E suite: repo-level testing/e2e/suites/<slug>
        let e2e = paths
            .iter()
            .any(|p| p.contains(&format!("testing/e2e/suites/{}", slug.replace('-', "_"))));
        f.insert("e2e".into(), boolean(e2e));

        // extension points (GTS): a toolkit-gts reference in any manifest heuristic
        // is content-heavy; presence of a gts.rs module is a cheap proxy.
        let gts = rel
            .iter()
            .any(|p| p.ends_with("/gts.rs") || p == &"src/gts.rs");
        f.insert("gts".into(), boolean(gts));

        // config / migrations / health as presence proxies
        f.insert(
            "config".into(),
            boolean(rel.iter().any(|p| p.ends_with("config.rs"))),
        );
        f.insert("migrations_present".into(), boolean(has_migrations));

        // spec docstates (presence + TBD/TODO scan)
        for (key, file) in [
            ("prd", "docs/PRD.md"),
            ("design", "docs/DESIGN.md"),
            ("decomp", "docs/DECOMPOSITION.md"),
            ("upstream", "docs/UPSTREAM_REQS.md"),
        ] {
            let present = rel.contains(&file);
            let value = if !present {
                docstate("N/A", None)
            } else {
                let full = format!("{dir}/{file}");
                let link = format!(
                    "https://github.com/{}/blob/{}/{full}",
                    self.repo, self.git_ref
                );
                let content = self.read_file(auth, &full).await.unwrap_or_default();
                let state = if content.contains("TBD") || content.contains("TODO") {
                    "in progress"
                } else {
                    "done"
                };
                docstate(state, Some(&link))
            };
            f.insert(key.into(), value);
        }

        // diagrams + UML: read DESIGN.md once, count mermaid fences and lift them.
        if rel.contains(&"docs/DESIGN.md") {
            let full = format!("{dir}/docs/DESIGN.md");
            let link = format!(
                "https://github.com/{}/blob/{}/{full}",
                self.repo, self.git_ref
            );
            if let Some(content) = self.read_file(auth, &full).await {
                let n = content.matches("```mermaid").count();
                if n > 0 {
                    f.insert("diagrams".into(), metric(n, Some(&link)));
                }
                uml = extract_uml(&content, &link);
            }
        }

        // gear.toml: description, category, plugins. Parsed by hand (a handful
        // of top-level scalars) to avoid a toml dependency in a --locked build.
        let gear_toml = format!("{dir}/gear.toml");
        if let Some(text_body) = self.read_file(auth, &gear_toml).await {
            let parsed = parse_gear_toml(&text_body);
            if let Some(desc) = parsed.description {
                f.insert("description".into(), text(&desc, None, None));
            }
            if let Some(cat) = parsed.category {
                f.insert("category".into(), text(&cat, None, None));
            }
            if let Some(declared) = parsed.plugins {
                let mut v = status(
                    if declared { "yes" } else { "no" },
                    if declared { "good" } else { "grey" },
                );
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "v".into(),
                        Value::String(format!(
                            "plugins: {}",
                            if declared { "declared" } else { "none" }
                        )),
                    );
                }
                f.insert("plugins".into(), v);
            }
        }

        // owner from CODEOWNERS: the last matching pattern wins in CODEOWNERS,
        // so scan for the most specific line that prefixes this Gear's path.
        if let Some(text_body) = codeowners
            && let Some(owner) = codeowners_match(text_body, dir)
        {
            let link = owner
                .strip_prefix('@')
                .map(|h| format!("https://github.com/{h}"));
            let mut v = status(&owner, "good");
            if let Some(obj) = v.as_object_mut()
                && let Some(l) = link
            {
                obj.insert("l".into(), Value::String(l));
            }
            f.insert("owner".into(), v);
        }

        // last change date for the directory
        if let Some(date) = self.last_change(auth, dir).await {
            let day = date.get(0..10).unwrap_or(&date).to_string();
            let mut v = text(&day, None, None);
            if let Some(obj) = v.as_object_mut() {
                obj.insert("u".into(), Value::String(day.clone()));
            }
            f.insert("lastchange".into(), v);
        }

        (Value::Object(f), uml)
    }
}

// ── value builders (the { v, b, n, s, l, u } shape the UI renders) ───────────

fn text(v: &str, link: Option<&str>, updated: Option<&str>) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("v".into(), Value::String(v.to_string()));
    m.insert("b".into(), Value::String(v.to_string()));
    if let Some(l) = link {
        m.insert("l".into(), Value::String(l.to_string()));
    }
    if let Some(u) = updated {
        m.insert("u".into(), Value::String(u.to_string()));
    }
    Value::Object(m)
}

fn metric(n: usize, link: Option<&str>) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("v".into(), Value::String(n.to_string()));
    m.insert("b".into(), Value::String(n.to_string()));
    m.insert("n".into(), json!(n));
    if let Some(l) = link {
        m.insert("l".into(), Value::String(l.to_string()));
    }
    Value::Object(m)
}

fn boolean(yes: bool) -> Value {
    json!({ "v": if yes { "yes" } else { "no" }, "b": if yes { "yes" } else { "no" }, "s": if yes { "good" } else { "none" } })
}

fn status(brief: &str, lamp: &str) -> Value {
    json!({ "v": brief, "b": brief, "s": lamp })
}

fn docstate(state: &str, link: Option<&str>) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("v".into(), Value::String(state.to_string()));
    m.insert("b".into(), Value::String(state.to_string()));
    if let Some(l) = link {
        m.insert("l".into(), Value::String(l.to_string()));
    }
    Value::Object(m)
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

/// The owner of the most specific CODEOWNERS rule matching `dir`.
fn codeowners_match(codeowners: &str, dir: &str) -> Option<String> {
    let target = format!("/{dir}");
    let mut best: Option<(usize, String)> = None;
    for line in codeowners.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let pattern = parts.next()?;
        let owner = parts.next().unwrap_or("").to_string();
        if owner.is_empty() {
            continue;
        }
        let pat = pattern.trim_end_matches('/');
        // a prefix match (CODEOWNERS is path-prefix oriented for directories)
        if target.starts_with(pat) || format!("{target}/").starts_with(&format!("{pat}/")) {
            let score = pat.len();
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, owner));
            }
        }
    }
    best.map(|(_, o)| o)
}

/// The few top-level `gear.toml` scalars the catalogue reads.
struct GearToml {
    description: Option<String>,
    category: Option<String>,
    plugins: Option<bool>,
}

/// Minimal top-level TOML reader — enough for `description`, `category`/`domain`
/// and a `plugins` declaration, without pulling in a TOML crate.
fn parse_gear_toml(body: &str) -> GearToml {
    let mut out = GearToml {
        description: None,
        category: None,
        plugins: None,
    };
    let mut in_top = true;
    for raw in body.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            if line.starts_with("[plugins") || line.starts_with("[[plugins") {
                out.plugins = Some(true);
            }
            in_top = false;
            continue;
        }
        if !in_top || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k.trim() {
            "description" if out.description.is_none() => out.description = unquote(v),
            "category" | "domain" if out.category.is_none() => out.category = unquote(v),
            "plugins" | "has_plugins" => {
                let val = v.trim();
                let declared =
                    val.starts_with("true") || (val.starts_with('[') && val.contains('"'));
                out.plugins = Some(declared);
            }
            _ => {}
        }
    }
    out
}

/// Strip surrounding quotes and any trailing inline comment from a TOML scalar.
fn unquote(v: &str) -> Option<String> {
    let mut s = v.trim();
    if let Some(rest) = s.strip_prefix('"') {
        s = rest.split('"').next().unwrap_or("");
    } else if let Some(rest) = s.strip_prefix('\'') {
        s = rest.split('\'').next().unwrap_or("");
    } else if let Some(i) = s.find('#') {
        s = s[..i].trim();
    }
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// The brief (`b`) string of a built field value.
fn brief_of(fields: &Value, key: &str) -> Option<String> {
    fields
        .get(key)
        .and_then(|v| v.get("b"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Other-gear crate names referenced in a Cargo manifest, normalised to the
/// component crate name (`cf-gears-<name>`, with any `-sdk` suffix dropped).
fn cargo_gear_deps(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in body.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')) {
        if token.starts_with("cf-gears-") && token.len() > "cf-gears-".len() {
            out.push(token.strip_suffix("-sdk").unwrap_or(token).to_string());
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Scoped (`@scope/pkg`) dependency names in a package.json — the likely
/// internal FrontX packages. The graph keeps only edges to known components.
fn package_json_dep_keys(body: &str) -> Vec<String> {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for section in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(obj) = v.get(section).and_then(|x| x.as_object()) {
            for k in obj.keys() {
                if k.starts_with('@') {
                    out.push(k.clone());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Pull name / description / version / category out of a package.json body.
fn parse_package_json(
    body: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (None, None, None, None),
    };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    let category = s("category").or_else(|| {
        v.get("keywords")
            .and_then(|k| k.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.as_str())
            .map(|x| x.to_string())
    });
    (s("name"), s("description"), s("version"), category)
}

/// Lift ```mermaid fenced blocks out of a markdown document into UML entries the
/// catalogue renders, each titled by the nearest preceding heading.
fn extract_uml(content: &str, link: &str) -> Vec<Value> {
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<Value> = Vec::new();
    let mut heading = String::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        if let Some(h) = line.strip_prefix('#') {
            heading = h.trim_start_matches('#').trim().to_string();
            i += 1;
            continue;
        }
        if line.starts_with("```mermaid") {
            let mut code = String::new();
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                code.push_str(lines[i]);
                code.push('\n');
                i += 1;
            }
            let title = if heading.is_empty() {
                format!("Diagram {}", out.len() + 1)
            } else {
                heading.clone()
            };
            out.push(json!({
                "title": title,
                "kind": uml_kind(&code),
                "src": "docs/DESIGN.md",
                "l": link,
                "code": code.trim_end(),
            }));
        }
        i += 1;
    }
    out
}

/// Guess a mermaid diagram's kind from its first keyword.
fn uml_kind(code: &str) -> &'static str {
    let head = code.trim_start();
    if head.starts_with("sequenceDiagram") {
        "sequence"
    } else if head.starts_with("stateDiagram") {
        "state"
    } else if head.starts_with("erDiagram") {
        "er"
    } else {
        "graph"
    }
}

// ── GitHub API DTOs ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GitTree {
    #[serde(default)]
    tree: Vec<TreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct CommitEntry {
    commit: CommitBody,
}

#[derive(Debug, Deserialize)]
struct CommitBody {
    #[serde(default)]
    committer: Option<CommitActor>,
}

#[derive(Debug, Deserialize)]
struct CommitActor {
    #[serde(default)]
    date: Option<String>,
}
