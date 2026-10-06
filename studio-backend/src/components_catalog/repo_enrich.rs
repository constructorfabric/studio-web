//! Repository enrichment — the primary data source for the catalogue.
//!
//! crates.io tells us a gear's published *versions*; the gears' repository tells
//! us what the gear actually *is* — its spec state, ADRs, tests, ownership. This
//! module reads that engineering metadata straight from the gears' GitHub
//! repository (for example `constructorfabric/gears-rust`) and maps it onto the
//! same field model the catalogue UI renders, so each Gear opens a real
//! component page instead of a crates.io stub.
//!
//! Auth reuses an existing Studio **GitHub connection** — the connector already
//! holds the token in credstore, so nothing new is wired here. It is entirely
//! best-effort: no connection, no repo access, or a truncated tree degrades to
//! "crates.io only", never a failed sync.
//!
//! There is no process configuration. Which repositories to read comes with
//! each sync, in the `repositories` of the `POST /studio-components-catalog/v1/sync`
//! body: per source, the tenant that owns the GitHub connection, the connection
//! (else the first GitHub one), `owner/name`, the git ref (default `HEAD`) and
//! the discovery mode.

use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::repo_facts::{self, CommitFacts, SpecStats, Version};
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
    /// The repository this was scanned out of, `owner/name`.
    ///
    /// Written onto the node as `synced_from`, which is what makes pruning
    /// possible: a component that a scan stops producing can only be deleted
    /// safely if the catalogue knows the scan produced it in the first place.
    /// The `repository` field cannot answer that — on this stand fifty-nine of
    /// the hundred and eighteen gear nodes come from crates.io alone and still
    /// name `gears-rust` as their repository, so pruning on it would delete
    /// them.
    pub source_repo: String,
    /// The node payload, when this kind of component has a model of its own.
    ///
    /// A gear's payload is assembled by the service from crates.io and the
    /// repository together, so gears leave this `None`. A kit has neither a
    /// crate nor versions: its model is a repository, a ref and a manifest
    /// path, and it carries that itself rather than being flattened into a
    /// shape built for something else.
    pub payload: Option<Value>,
    /// The directory the component was read from, relative to the repository
    /// root (`gears/bss/ledger`, `packages/ui-kit`). Written onto the node as
    /// `path`, so the activity plan can name the directory instead of guessing
    /// it from the crate name, and so the components reference can join a
    /// component to the Gearbox descriptor that lives under the same tree.
    /// `None` for a component that is not a directory of its own (a kit read
    /// from a manifest at the root).
    pub dir: Option<String>,
    /// Every crate a gear directory declares (`[package] name` of each
    /// `Cargo.toml` in it, not counting nested gears), the gear's own first.
    /// This is how a gear's SDK and helper crates are named without deriving
    /// them from a naming convention. Empty for a component that is not a
    /// Rust gear.
    pub crates: Vec<String>,
}

/// What a repository source contributes: platform gears, FrontX
/// micro-frontends, or kits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepoMode {
    Gears,
    Frontx,
    Kits,
}

impl RepoMode {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "frontx" | "micro-frontend" | "microfrontend" | "mf" => RepoMode::Frontx,
            "kit" | "kits" => RepoMode::Kits,
            _ => RepoMode::Gears,
        }
    }
}

/// The file that marks a kit, and the field the registry keys one on.
///
/// The same name the kit registry records as `manifest_path`, so a kit found by
/// scanning a repository and a kit installed into a project are the same thing
/// under the same slug rather than two records that happen to look alike.
const KIT_MANIFEST: &str = ".cf-studio-kit.toml";

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
    /// A local checkout of `repo` at `git_ref`, when the sync has one: every
    /// file is then read from disk, and the source-code fields -- which need
    /// every file -- are filled too.
    checkout: Option<std::path::PathBuf>,
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
        let git_ref = normalize_ref(&git_ref);
        let http = Client::builder().user_agent(UA).build().ok()?;
        Some(Self {
            http,
            connectors,
            tenant,
            connection_id,
            repo,
            git_ref,
            mode,
            checkout: None,
        })
    }

    /// Read files from this checkout instead of the API. The tree listing
    /// comes from it too, so every number is one commit's.
    pub fn with_checkout(mut self, dir: std::path::PathBuf) -> Self {
        self.checkout = Some(dir);
        self
    }

    /// How many files of one kind a gear may cost. Over the API every file is
    /// a request, so a gear with a hundred documents is capped; on disk it is
    /// not.
    fn cap(&self, api: usize) -> usize {
        if self.checkout.is_some() {
            usize::MAX
        } else {
            api
        }
    }

    /// Read the repository and return one [`RepoGear`] per component. What counts
    /// as a component depends on the mode: a gear directory, described by a
    /// `gear.gdl` or a `gear.toml` (Gears), or a `packages/*/package.json`
    /// package (FrontX micro-frontends).
    pub async fn enrich(&self, ctx: &SecurityContext) -> Result<Vec<RepoGear>> {
        let auth = self.resolve_auth(ctx).await?;
        let listing: Vec<String> = match &self.checkout {
            Some(dir) => {
                let dir = dir.clone();
                tokio::task::spawn_blocking(move || local_tree(&dir))
                    .await
                    .context("listing the checkout")?
            }
            None => {
                let tree = self.tree(&auth).await?;
                if tree.truncated {
                    warn!(
                        repo = %self.repo,
                        "studio-gears-catalog: repository tree was truncated — some counts may be low"
                    );
                }
                tree.tree
                    .into_iter()
                    .filter(|e| e.kind == "blob" || e.kind == "tree")
                    .map(|e| e.path)
                    .collect()
            }
        };
        let paths: Vec<&str> = listing.iter().map(String::as_str).collect();
        match self.mode {
            RepoMode::Gears => self.discover_gears(&auth, &paths).await,
            RepoMode::Frontx => self.discover_frontx(&auth, &paths).await,
            RepoMode::Kits => self.discover_kits(&auth, &paths).await,
        }
    }

    /// Kits: one component per `.cf-studio-kit.toml`.
    ///
    /// A repository may hold one kit at its root or several in subdirectories,
    /// and both shapes appear in the wild, so the scan takes every manifest
    /// rather than assuming either. Unlike the FrontX scan there is no
    /// container case to skip: a kit manifest is never a workspace file that
    /// merely lists its members.
    ///
    /// The slug comes from the manifest when it names one and from the
    /// directory otherwise, because that is what a person reading the
    /// repository would call it. A manifest that cannot be read is skipped with
    /// a warning rather than failing the sync — one bad kit must not cost the
    /// catalogue the others.
    async fn discover_kits(&self, auth: &ConnectionAuth, paths: &[&str]) -> Result<Vec<RepoGear>> {
        let manifests: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|p| *p == KIT_MANIFEST || p.ends_with(&format!("/{KIT_MANIFEST}")))
            .collect();

        let mut out: Vec<RepoGear> = Vec::new();
        for path in manifests {
            let Some(body) = self.read_file(auth, path).await else {
                warn!(
                    repo = %self.repo, path,
                    "studio-gears-catalog: kit manifest unreadable, skipped"
                );
                continue;
            };
            let dir = parent_dir(path);
            let fallback = if dir.is_empty() {
                self.repo.rsplit('/').next().unwrap_or(&self.repo)
            } else {
                dir.rsplit('/').next().unwrap_or(dir.as_str())
            };
            for kit in manifest_kits(&body, fallback) {
                let payload = json!({
                    "title": kit.name,
                    "name": kit.slug,
                    "slug": kit.slug,
                    "kind": "kit",
                    "description": kit.description,
                    "publisher": kit.publisher,
                    "version": kit.version,
                    "source": "github",
                    "repository": format!("https://github.com/{}", self.repo),
                    "git_ref": self.git_ref,
                    "manifest_path": path,
                });
                out.push(RepoGear {
                    crate_name: kit.slug,
                    description: kit.description,
                    source_repo: self.repo.clone(),
                    fields: Value::Null,
                    uml: Vec::new(),
                    kind: Some("kit".to_string()),
                    category: Some("kit".to_string()),
                    payload: Some(payload),
                    dir: (!dir.is_empty()).then(|| dir.clone()),
                    crates: Vec::new(),
                });
            }
        }

        info!(
            components = out.len(), repo = %self.repo, git_ref = %self.git_ref,
            "studio-gears-catalog: kits discovered"
        );
        Ok(out)
    }

    /// Gears: one component per gear directory, as [`gear_dirs`] finds them.
    async fn discover_gears(&self, auth: &ConnectionAuth, paths: &[&str]) -> Result<Vec<RepoGear>> {
        let gear_dirs = gear_dirs(paths);
        let codeowners = self.read_codeowners(auth).await;
        let wide = self.repo_wide(auth).await;
        let mut out: Vec<RepoGear> = Vec::with_capacity(gear_dirs.len());
        // Each gear's own crate names, for the reverse walk below.
        let mut own: Vec<std::collections::BTreeSet<String>> = Vec::with_capacity(gear_dirs.len());
        for dir in &gear_dirs {
            let slug = dir.rsplit('/').next().unwrap_or(dir).to_string();
            // The crates this gear directory declares, read from their own
            // manifests. The component is keyed by the gear's REAL crate name,
            // because that is the key crates.io and the Gearbox engine both
            // use; `cf-gears-<directory>` was a guess, and it was wrong for
            // every gear whose crate is named otherwise (`gears/bss/ledger` is
            // `cf-gears-bss-ledger`, `gears/chat-engine` is `cf-chat-engine`),
            // which catalogued each of them twice under two names.
            let mut manifests: Vec<(String, String)> = Vec::new();
            for rel in gear_manifests(dir, &gear_dirs, paths)
                .into_iter()
                .take(self.cap(MAX_GEAR_MANIFESTS))
            {
                if let Some(body) = self.read_file(auth, &format!("{dir}/{rel}")).await {
                    manifests.push((rel, body));
                }
            }
            let named: Vec<(String, String)> = manifests
                .iter()
                .filter_map(|(rel, body)| cargo_package_name(body).map(|n| (rel.clone(), n)))
                .collect();
            let crate_name =
                primary_crate(&slug, &named).unwrap_or_else(|| format!("cf-gears-{slug}"));
            let mut crates: Vec<String> = vec![crate_name.clone()];
            for (_, name) in &named {
                if !crates.contains(name) {
                    crates.push(name.clone());
                }
            }
            let (fields, uml) = self
                .gear_fields(
                    auth,
                    dir,
                    &slug,
                    &crate_name,
                    &manifests,
                    paths,
                    codeowners.as_deref(),
                    &wide,
                )
                .await;
            own.push(
                named
                    .iter()
                    .map(|(_, n)| n.strip_suffix("-sdk").unwrap_or(n).to_string())
                    .chain(std::iter::once(crate_name.clone()))
                    .collect(),
            );
            let description = brief_of(&fields, "description");
            let category = brief_of(&fields, "category");
            // A gear that declares `is_plugin = true` IS a plugin, whatever it
            // is called. The service otherwise reads the crate name for
            // `-plugin`, which agrees with every declaration in `gears-rust`
            // today -- so this decides nothing yet and is here because a name
            // is a convention and a declaration is not. `None` keeps the name
            // fallback for a manifest that says nothing, rather than asserting
            // `gear` on its behalf.
            let kind = match brief_of(&fields, "is_plugin").as_deref() {
                Some("yes") => Some("plugin".to_string()),
                _ => None,
            };
            out.push(RepoGear {
                crate_name,
                description,
                source_repo: self.repo.clone(),
                fields,
                uml,
                kind,
                category,
                payload: None,
                dir: Some(dir.clone()),
                crates: if named.is_empty() { Vec::new() } else { crates },
            });
        }
        attach_consumers(&mut out, &own);
        // A plugin compiled into its host's crate is not a component, but it
        // is still an implementation of the host's point.
        let mut in_crate: Vec<String> = Vec::new();
        for p in in_crate_plugin_gdls(paths) {
            if let Some(spec) = self
                .read_file(auth, p)
                .await
                .and_then(|b| parse_gear_gdl(&b).implements)
            {
                in_crate.push(spec);
            }
        }
        attach_plugins(&mut out, &in_crate);
        info!(gears = out.len(), "studio-gears-catalog: gears discovered");
        Ok(out)
    }

    /// What the repository says once for every gear in it: its release tags
    /// and the version and licence its workspace hands down.
    ///
    /// Tags are listed rather than searched: gears-rust carries over two
    /// thousand of them, which is two dozen pages read once, against a search
    /// per gear that GitHub rate-limits to thirty a minute.
    async fn repo_wide(&self, auth: &ConnectionAuth) -> RepoWide {
        const MAX_PAGES: usize = 40;
        let mut tags: Vec<String> = Vec::new();
        for page in 1..=MAX_PAGES {
            let url = self.api(
                auth,
                &format!("/repos/{}/tags?per_page=100&page={page}", self.repo),
            );
            let Ok(resp) = self
                .http
                .get(&url)
                .bearer_auth(&auth.token)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
            else {
                break;
            };
            if !resp.status().is_success() {
                break;
            }
            let Ok(batch) = resp.json::<Vec<TagEntry>>().await else {
                break;
            };
            let n = batch.len();
            tags.extend(batch.into_iter().map(|t| t.name));
            if n < 100 {
                break;
            }
        }
        let root = self.read_file(auth, "Cargo.toml").await.unwrap_or_default();
        let changelog = self
            .read_file(auth, "CHANGELOG.md")
            .await
            .map(|b| repo_facts::changelog_releases(&b))
            .unwrap_or_default();
        RepoWide {
            tags: repo_facts::tag_index(tags.iter().map(String::as_str)),
            version: repo_facts::workspace_package(&root, "version"),
            license: repo_facts::workspace_package(&root, "license"),
            changelog,
        }
    }

    /// FrontX: one component per package in the monorepo.
    ///
    /// The layout is not `packages/*` alone — on `develop` the repository also
    /// carries its scaffolding templates at the root (`template-shell`,
    /// `template-mfe`, consumed as `github:constructorfabric/gears-frontx//template-shell@develop`),
    /// and grouping directories come and go. So rather than hard-coding a
    /// directory, this walks every `package.json` in the tree and keeps the
    /// OUTERMOST ones:
    ///
    ///   * the repository root manifest is the workspace container, never a
    ///     component;
    ///   * a manifest declaring npm `workspaces` is likewise a container — it
    ///     is skipped and its children stay eligible;
    ///   * anything else is a component, and manifests nested inside it are
    ///     skipped.
    ///
    /// That last rule does not, on its own, exclude a template's generated
    /// body: both root templates declare their `src-app/**` packages as npm
    /// workspaces, which makes those bodies siblings of the container rather
    /// than nested under a component. `src-app` is in [`SKIP_SEGMENTS`] for
    /// exactly that reason — see the note there.
    async fn discover_frontx(
        &self,
        auth: &ConnectionAuth,
        paths: &[&str],
    ) -> Result<Vec<RepoGear>> {
        // Every manifest in the tree, shallowest first, so a container is
        // always seen before the packages it contains.
        let manifests = frontx_manifest_paths(paths);

        // Component directories claimed so far — a manifest under one of these
        // belongs to that component, not to a new one.
        let mut claimed: Vec<String> = Vec::new();
        let mut out: Vec<RepoGear> = Vec::new();
        let mut containers = 0usize;
        let mut templates = 0usize;

        for p in manifests {
            let dir = parent_dir(p);
            // Nested inside a component we already took — part of it, not a
            // component of its own.
            if claimed.iter().any(|c| {
                dir.strip_prefix(c.as_str())
                    .is_some_and(|r| r.starts_with('/'))
            }) {
                continue;
            }
            let body = self.read_file(auth, p).await;
            // An unreadable manifest tells us nothing — treat it as a
            // container so its children still get their chance.
            let Some(body) = body else {
                containers += 1;
                continue;
            };
            if dir.is_empty() || is_workspace_container(&body) {
                containers += 1;
                continue;
            }
            // A template's manifest is not a package: `template-mfe` ships a
            // `package.json` named `@gears-frontx/{{mfeName}}-mfe`, filled in
            // when somebody scaffolds from it. Catalogued as-is it became a
            // component literally called `{{mfeName}}`. Skipped without being
            // claimed, so a real package nested under it still counts.
            if is_template_manifest(&body) {
                templates += 1;
                continue;
            }
            claimed.push(dir.clone());
            out.push(self.frontx_component(auth, &dir, &body, paths).await);
        }

        info!(
            components = out.len(),
            containers, templates, repo = %self.repo, git_ref = %self.git_ref,
            "studio-gears-catalog: frontx components discovered"
        );
        Ok(out)
    }

    /// Build one FrontX component from its directory and its package.json.
    async fn frontx_component(
        &self,
        auth: &ConnectionAuth,
        dir: &str,
        pkg: &str,
        paths: &[&str],
    ) -> RepoGear {
        let prefix = format!("{dir}/");
        let rel: Vec<&str> = paths
            .iter()
            .filter_map(|q| q.strip_prefix(&prefix))
            .filter(|q| !q.is_empty() && !skip_path(q))
            .collect();
        let repo_url = format!(
            "https://github.com/{}/tree/{}/{dir}",
            self.repo, self.git_ref
        );

        let mut f = serde_json::Map::new();
        f.insert("path".into(), text(dir, Some(&repo_url), None));

        let (name, desc, version, category) = parse_package_json(pkg);
        // The package's own name is the catalogue key (`@gears-frontx/ui-kit`);
        // an unnamed package falls back to its directory.
        let comp = name.unwrap_or_else(|| dir.rsplit('/').next().unwrap_or(dir).to_string());

        if let Some(v) = &version {
            f.insert("version".into(), text(v, None, None));
        }
        if let Some(d) = &desc {
            f.insert("description".into(), text(d, None, None));
        }
        if let Some(c) = &category {
            f.insert("category".into(), text(c, None, None));
        }
        let dep_keys = package_json_dep_keys(pkg);
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
            boolean(
                rel.iter().any(|q| {
                    q.contains("e2e") || q.contains("cypress") || q.contains("playwright")
                }),
            ),
        );
        f.insert(
            "openapi".into(),
            boolean(rel.iter().any(|q| q.to_lowercase().contains("openapi"))),
        );
        // Two more schema fields a package.json monorepo can actually answer:
        // the declared licence, and whether the package documents itself.
        if let Some(lic) = package_json_str(pkg, "license") {
            f.insert("licence".into(), text(&lic, None, None));
        }
        // What the package IS, for the kind taxonomy (`taxonomy::classify`):
        // a `bin` makes it a tool, module federation a micro-frontend.
        let facts = package_json_facts(pkg, &rel);
        f.insert("npm_bin".into(), boolean(facts.bin));
        f.insert("npm_mfe".into(), boolean(facts.mfe));
        f.insert("npm_private".into(), boolean(facts.private));
        f.insert(
            "guideline".into(),
            boolean(rel.iter().any(|q| {
                q.starts_with("guidelines/")
                    || q.starts_with("docs/")
                    || q.eq_ignore_ascii_case("README.md")
            })),
        );
        if let Some(date) = self.last_change(auth, dir).await {
            let day = date.get(0..10).unwrap_or(&date).to_string();
            let mut v = text(&day, None, None);
            if let Some(o) = v.as_object_mut() {
                o.insert("u".into(), Value::String(day.clone()));
            }
            f.insert("lastchange".into(), v);
        }

        RepoGear {
            crate_name: comp,
            description: desc,
            source_repo: self.repo.clone(),
            fields: Value::Object(f),
            uml: Vec::new(),
            kind: Some("frontx".to_string()),
            category,
            payload: None,
            dir: Some(dir.to_string()),
            crates: Vec::new(),
        }
    }

    /// Resolve a GitHub connection's `ConnectionAuth` (base_url + token) via the
    /// connectors service — the token stays in credstore, we only borrow it.
    async fn resolve_auth(&self, ctx: &SecurityContext) -> Result<ConnectionAuth> {
        let (_driver, auth, _conn) = self
            .connectors
            .named_or_default(ctx, self.tenant, self.connection_id, "github")
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

    /// The crate names every `Cargo.toml` in the repository depends on at run
    /// time: `[dependencies]`, `[workspace.dependencies]` and target-specific
    /// dependency tables, a `package = "..."` rename resolved to the real name.
    /// Dev- and build-dependencies are left out -- a test harness is not what
    /// the product is made of. Vendored and built trees are skipped.
    pub async fn cargo_dependencies(
        &self,
        ctx: &SecurityContext,
    ) -> Result<std::collections::BTreeSet<String>> {
        const MAX_MANIFESTS: usize = 300;
        let auth = self.resolve_auth(ctx).await?;
        let tree = self.tree(&auth).await?;
        let manifests: Vec<String> = tree
            .tree
            .iter()
            .filter(|e| e.kind == "blob")
            .filter(|e| e.path == "Cargo.toml" || e.path.ends_with("/Cargo.toml"))
            .filter(|e| {
                !e.path.split('/').any(|seg| {
                    matches!(
                        seg,
                        "target" | "node_modules" | "vendor" | ".git" | "fixtures"
                    )
                })
            })
            .take(MAX_MANIFESTS)
            .map(|e| e.path.clone())
            .collect();
        let mut out = std::collections::BTreeSet::new();
        for path in manifests {
            if let Some(body) = self.read_file(&auth, &path).await {
                out.extend(cargo_dependency_names(&body));
            }
        }
        Ok(out)
    }

    /// Fetch one text file's raw content, or `None` when it is absent.
    async fn read_file(&self, auth: &ConnectionAuth, path: &str) -> Option<String> {
        if let Some(dir) = &self.checkout {
            return tokio::fs::read_to_string(dir.join(path)).await.ok();
        }
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

    /// A directory's recent history: the last change, and up to a hundred
    /// commits' authors and messages -- enough to name who works on it and
    /// how much of it is signed off, in the one call the last-change date
    /// already cost.
    async fn history(
        &self,
        auth: &ConnectionAuth,
        dir: &str,
    ) -> (Option<String>, Vec<CommitFacts>) {
        let url = self.api(
            auth,
            &format!(
                "/repos/{}/commits?path={}&per_page=100&sha={}",
                self.repo, dir, self.git_ref
            ),
        );
        let Ok(resp) = self
            .http
            .get(&url)
            .bearer_auth(&auth.token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
        else {
            return (None, Vec::new());
        };
        if !resp.status().is_success() {
            return (None, Vec::new());
        }
        let Ok(entries) = resp.json::<Vec<HistoryEntry>>().await else {
            return (None, Vec::new());
        };
        let last = entries
            .first()
            .and_then(|e| e.commit.committer.as_ref())
            .and_then(|c| c.date.clone());
        let facts = entries
            .into_iter()
            .map(|e| CommitFacts {
                author: e
                    .author
                    .map(|a| a.login)
                    .or_else(|| e.commit.author.and_then(|a| a.name))
                    .unwrap_or_default(),
                message: e.commit.message,
            })
            .collect();
        (last, facts)
    }

    // ── field extraction ─────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    async fn gear_fields(
        &self,
        auth: &ConnectionAuth,
        dir: &str,
        slug: &str,
        self_crate: &str,
        manifests: &[(String, String)],
        paths: &[&str],
        codeowners: Option<&str>,
        wide: &RepoWide,
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

        // The Cargo manifests (already read by the caller): dependencies on
        // other gears, this gear's own crates, its version, features and
        // databases.
        let mut deps: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut features: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut crates: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
        let mut bodies: Vec<&str> = Vec::new();
        for (pth, body) in manifests {
            if let Some((name, version)) = repo_facts::cargo_package(body) {
                crates.push((
                    pth.clone(),
                    name,
                    version,
                    repo_facts::package_license(body),
                ));
            }
            features.extend(repo_facts::feature_names(body));
            deps.extend(cargo_gear_deps(body));
            bodies.push(body);
        }
        let packages: Vec<String> = crates.iter().map(|c| c.1.clone()).collect();
        // Its own crates are not dependencies, under either name.
        for p in &packages {
            deps.remove(p.strip_suffix("-sdk").unwrap_or(p));
        }
        deps.remove(self_crate);
        // The gear's crate: the one the caller keyed the component on.
        let main = crates
            .iter()
            .find(|c| c.1 == self_crate)
            .or_else(|| crates.iter().find(|c| !c.1.ends_with("-sdk")));
        if !features.is_empty() {
            f.insert("flags".into(), metric(features.len(), None));
        }
        let dbs = repo_facts::db_engines(bodies.iter().copied());
        if !dbs.is_empty() {
            f.insert("dbs".into(), text(&dbs.join(", "), None, None));
        }
        if let Some(licence) = main
            .and_then(|c| c.3.clone())
            .or_else(|| wide.license.clone())
        {
            f.insert("licence".into(), text(&licence, None, None));
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

        // Version, release and lifecycle. The version is the crate's own, or
        // the workspace's when the crate inherits it.
        if let Some((_, name, own_version, _)) = main {
            let version = own_version.clone().or_else(|| wide.version.clone());
            if let Some(v) = &version {
                f.insert("version".into(), text(v, None, None));
            }
            let released = repo_facts::latest_release(&wide.tags, name);
            let sdk_released = packages
                .iter()
                .filter(|p| p.ends_with("-sdk"))
                .any(|p| repo_facts::latest_release(&wide.tags, p).is_some());
            match &released {
                Some(r) => {
                    let tag = format!("{name}-v{r}");
                    let link = format!("https://github.com/{}/releases/tag/{tag}", self.repo);
                    let released_on = wide
                        .changelog
                        .iter()
                        .find(|e| {
                            repo_facts::release_names(name).contains(&e.crate_name)
                                && e.version == r.to_string()
                        })
                        .and_then(|e| e.date.clone());
                    f.insert(
                        "lastrelease".into(),
                        text(&format!("v{r}"), Some(&link), released_on.as_deref()),
                    );
                    let mut v = status("yes", "good");
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("v".into(), Value::String(format!("released as {name}")));
                    }
                    f.insert("published".into(), v);
                }
                None if sdk_released => {
                    f.insert("published".into(), status("sdk only", "watch"));
                }
                None => {
                    f.insert("published".into(), status("no", "none"));
                }
            }
            let judged = released
                .clone()
                .or_else(|| version.as_deref().and_then(Version::parse));
            f.insert(
                "lifecycle".into(),
                text(
                    repo_facts::lifecycle(judged.as_ref(), released.is_some(), e2e),
                    None,
                    None,
                ),
            );
        } else if !packages.is_empty() {
            let sdk_released = packages
                .iter()
                .any(|p| repo_facts::latest_release(&wide.tags, p).is_some());
            if sdk_released {
                f.insert("published".into(), status("sdk only", "watch"));
            }
            f.insert("lifecycle".into(), text("in development", None, None));
        }

        // Whether the gear registers GTS types, by the presence of a `gts.rs`
        // module.
        //
        // This was labelled "Extension points (GTS)" and read as a proxy for
        // the question `has_extension_point` now answers outright. They are not
        // the same question and the data says so: across the forty-two gears in
        // `gears-rust` the two disagree eighteen times, in both directions —
        // `bss/ledger` has a `gts.rs` and declares no extension point,
        // `chat-engine` declares one and has no `gts.rs`. Registering types is
        // not offering somebody else a place to put an implementation, and two
        // fields on one page claiming to answer the same thing while
        // disagreeing on nearly half of them is worse than either alone.
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

        // The specification documents, each read once: size, traceability,
        // requirement progress, and -- below -- the per-document state and
        // the diagrams. Capped, so one gear with a hundred documents costs a
        // hundred reads and not the sync.
        let mut docs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut spec = SpecStats::default();
        for p in rel
            .iter()
            .filter(|p| p.starts_with("docs/") && p.ends_with(".md"))
            .take(self.cap(80))
        {
            if let Some(body) = self.read_file(auth, &format!("{dir}/{p}")).await {
                spec.add(&body);
                docs.insert(p.to_string(), body);
            }
        }
        if spec.lines > 0 {
            f.insert("specloc".into(), metric(spec.lines, None));
        }
        if !spec.ids.is_empty() {
            f.insert("cpt".into(), metric(spec.ids.len(), None));
        }
        if let Some(pct) = (spec.ticked * 100).checked_div(spec.markers) {
            let mut v = text(
                &format!("{} / {} ticked", spec.ticked, spec.markers),
                None,
                None,
            );
            if let Some(obj) = v.as_object_mut() {
                obj.insert("n".into(), json!(pct));
            }
            f.insert("progress".into(), v);
        }

        // Source code: size by kind, health probes, GTS types. Every `.rs` of
        // the gear is read, which only a checkout makes affordable.
        if self.checkout.is_some() {
            let mut code = repo_facts::CodeStats::default();
            for p in rel
                .iter()
                .filter(|p| p.ends_with(".rs") && !p.starts_with("plugins/"))
            {
                if let Some(body) = self.read_file(auth, &format!("{dir}/{p}")).await {
                    code.add(p, &body);
                }
            }
            let suite = format!("testing/e2e/suites/{}/", slug.replace('-', "_"));
            let mut e2e_lines = 0usize;
            for p in paths.iter().filter(|p| p.starts_with(&suite)) {
                if let Some(body) = self.read_file(auth, p).await {
                    e2e_lines += body.lines().count();
                }
            }
            if code.code > 0 {
                f.insert("codeloc".into(), metric(code.code, None));
            }
            if code.unit > 0 {
                f.insert("unitloc".into(), metric(code.unit, None));
            }
            if code.integration > 0 {
                f.insert("integloc".into(), metric(code.integration, None));
            }
            if e2e_lines > 0 {
                f.insert("e2eloc".into(), metric(e2e_lines, None));
            }
            if let Some(r) = repo_facts::spec_to_code(spec.lines, code.code) {
                f.insert("ratio".into(), text(&r, None, None));
            }
            if code.code > 0 {
                f.insert("health".into(), boolean(code.health));
            }
            // IMPL of build readiness: the requirements the specs declare that
            // the code says it implements. Only a checkout reads every file.
            if let Some((cited, declared)) =
                repo_facts::requirements_in_code(&spec.ids, &code.cpt_ids)
            {
                let mut v = text(
                    &format!("{cited} of {declared} requirement IDs in code"),
                    None,
                    None,
                );
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("n".into(), json!(cited * 100 / declared));
                }
                f.insert("impl_trace".into(), v);
            }
            if !code.gts_types.is_empty() {
                let names: Vec<String> = code.gts_types.into_iter().collect();
                let mut v = text(&format!("{} types", names.len()), None, None);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("v".into(), Value::String(names.join(", ")));
                    obj.insert("n".into(), json!(names.len()));
                }
                f.insert("gtstypes".into(), v);
            }
        }

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
                let content = docs.get(file).cloned().unwrap_or_default();
                let state = if content.contains("TBD") || content.contains("TODO") {
                    "in progress"
                } else {
                    "done"
                };
                docstate(state, Some(&link))
            };
            f.insert(key.into(), value);
        }

        // No crate yet: the stage is the furthest document written. The rule's
        // enum starts before code, and a gear that is only a design is in
        // design, not "unknown".
        if !f.contains_key("lifecycle") {
            let stage = if rel.contains(&"docs/DESIGN.md") {
                Some("in design")
            } else if rel.contains(&"docs/PRD.md") {
                Some("in requirements")
            } else {
                None
            };
            if let Some(stage) = stage {
                f.insert("lifecycle".into(), text(stage, None, None));
            }
        }

        // diagrams + UML: read DESIGN.md once, count mermaid fences and lift them.
        if rel.contains(&"docs/DESIGN.md") {
            let full = format!("{dir}/docs/DESIGN.md");
            let link = format!(
                "https://github.com/{}/blob/{}/{full}",
                self.repo, self.git_ref
            );
            if let Some(content) = docs.get("docs/DESIGN.md") {
                let n = content.matches("```mermaid").count();
                if n > 0 {
                    f.insert("diagrams".into(), metric(n, Some(&link)));
                }
                uml = extract_uml(content, &link);
            }
        }

        // gear.gdl, then gear.toml: description, category, plugins. Both parsed
        // by hand, the toml to avoid a toml dependency in a --locked build and
        // the gdl because the engine is a separate binary the sync may not have.
        //
        // The gdl is the description now: gears-rust retired its gear.toml
        // files into it (constructorfabric/gears-rust#4793). A gear.toml still
        // fills what the gdl leaves out, because Studio's own skeleton writes
        // both and the engine's scaffolded gdl carries no description.
        let gdl_path = [format!("{dir}/gear.gdl"), format!("{dir}/{slug}/gear.gdl")]
            .into_iter()
            .find(|p| paths.contains(&p.as_str()));
        let gdl = match &gdl_path {
            Some(p) => self.read_file(auth, p).await.map(|b| parse_gear_gdl(&b)),
            None => None,
        };
        let toml = self
            .read_file(auth, &format!("{dir}/gear.toml"))
            .await
            .map(|b| parse_gear_toml(&b));
        let manifest = match (&gdl, &toml) {
            (Some(_), _) => Some("gear.gdl"),
            (None, Some(_)) => Some("gear.toml"),
            (None, None) => None,
        };
        let declared = match (gdl, toml) {
            (Some(gdl), Some(toml)) => Some(gdl.or(toml)),
            (gdl, toml) => gdl.or(toml),
        };
        if let Some(manifest) = manifest {
            // Which file described it, for the reason line the taxonomy
            // writes ("a gear.gdl at ...").
            f.insert("manifest".into(), text(manifest, None, None));
        }
        if let Some(parsed) = declared {
            if let Some(desc) = parsed.description {
                f.insert("description".into(), text(&desc, None, None));
            }
            if let Some(cat) = parsed.category {
                f.insert("category".into(), text(&cat, None, None));
            }
            if let Some(caps) = parsed.capabilities {
                f.insert("capabilities".into(), text(&caps.join(", "), None, None));
            }
            if let Some(declared) = parsed.plugins {
                f.insert("plugins".into(), plugins_status(declared));
            }
            if let Some(declared) = parsed.extension_point {
                f.insert("extpoint".into(), boolean(declared));
            }
            // What the manifest calls this component. Kept as a field of its
            // own rather than only as the node's `kind`, so a page can show
            // that the answer was read and not inferred.
            if let Some(is_plugin) = parsed.is_plugin {
                f.insert("is_plugin".into(), boolean(is_plugin));
            }
            if let Some(maturity) = parsed.maturity {
                f.insert("maturity".into(), text(&maturity, None, None));
            }
            // The specs behind `plugins`, which only the whole repository can
            // answer for a gdl: see `attach_plugins`.
            if !parsed.extension_points.is_empty() {
                f.insert(
                    "extpoint_specs".into(),
                    Value::Array(
                        parsed
                            .extension_points
                            .into_iter()
                            .map(Value::String)
                            .collect(),
                    ),
                );
            }
            if let Some(spec) = parsed.implements {
                f.insert("implements".into(), Value::String(spec));
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

        // History: the last change, who writes this gear, and how much of it
        // carries a sign-off.
        let (last, commits) = self.history(auth, dir).await;
        if let Some(date) = last {
            let day = date.get(0..10).unwrap_or(&date).to_string();
            let mut v = text(&day, None, None);
            if let Some(obj) = v.as_object_mut() {
                obj.insert("u".into(), Value::String(day.clone()));
            }
            f.insert("lastchange".into(), v);
        }
        let experts = repo_facts::experts(&commits, 3);
        if !experts.is_empty() {
            f.insert("experts".into(), text(&experts.join(", "), None, None));
        }
        let (signed, human) = repo_facts::sign_off(&commits);
        if human > 0 {
            let lamp = if signed == human {
                "good"
            } else if signed * 5 >= human * 4 {
                "watch"
            } else {
                "bad"
            };
            let mut v = status(&format!("{signed}/{human}"), lamp);
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "v".into(),
                    Value::String(format!(
                        "{signed} of the last {human} human commits signed off"
                    )),
                );
            }
            f.insert("dco".into(), v);
        }

        // Changelog: this gear's crates' releases in the repository's one
        // changelog, under their current or former names.
        let names: Vec<String> = packages
            .iter()
            .flat_map(|p| repo_facts::release_names(p))
            .collect();
        let entries = wide
            .changelog
            .iter()
            .filter(|e| names.contains(&e.crate_name))
            .count();
        if entries > 0 {
            let link = format!(
                "https://github.com/{}/blob/{}/CHANGELOG.md",
                self.repo, self.git_ref
            );
            f.insert("changelog".into(), metric(entries, Some(&link)));
        }

        (Value::Object(f), uml)
    }
}

/// Every file and directory under a checkout, relative and with `/`, the way
/// the Git tree API lists them. `.git` and symlinks are not followed.
fn local_tree(root: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() || entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if kind.is_dir() {
                stack.push(path);
            }
            out.push(rel);
        }
    }
    out.sort();
    out
}

/// Repository-wide facts read once per scan.
#[derive(Default)]
struct RepoWide {
    tags: std::collections::BTreeMap<String, Vec<Version>>,
    version: Option<String>,
    license: Option<String>,
    /// The repository's one changelog, every crate's releases in it.
    changelog: Vec<repo_facts::ChangelogEntry>,
}

#[derive(Debug, Deserialize)]
struct TagEntry {
    name: String,
}

#[derive(Debug, Deserialize)]
struct HistoryEntry {
    commit: HistoryCommit,
    /// The GitHub account, when the commit's e-mail maps to one.
    #[serde(default)]
    author: Option<HistoryLogin>,
}

#[derive(Debug, Deserialize)]
struct HistoryCommit {
    #[serde(default)]
    message: String,
    #[serde(default)]
    author: Option<HistoryName>,
    #[serde(default)]
    committer: Option<CommitActor>,
}

#[derive(Debug, Deserialize)]
struct HistoryName {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HistoryLogin {
    login: String,
}

/// Every gear's dependents, read backwards off every gear's dependencies.
///
/// `own[i]` is gear `i`'s crate names with any `-sdk` dropped, the same way
/// `deps_names` records them, so a gear consumed through its SDK counts.
fn attach_consumers(gears: &mut [RepoGear], own: &[std::collections::BTreeSet<String>]) {
    let deps: Vec<Vec<String>> = gears
        .iter()
        .map(|g| {
            g.fields
                .get("deps_names")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    let names: Vec<String> = gears.iter().map(|g| g.crate_name.clone()).collect();
    for (i, gear) in gears.iter_mut().enumerate() {
        let users: Vec<String> = deps
            .iter()
            .enumerate()
            .filter(|(j, d)| *j != i && d.iter().any(|x| own[i].contains(x)))
            .map(|(j, _)| names[j].clone())
            .collect();
        if let Some(obj) = gear.fields.as_object_mut() {
            obj.insert("consumers".into(), metric(users.len(), None));
            obj.insert(
                "consumers_names".into(),
                Value::Array(users.into_iter().map(Value::String).collect()),
            );
        }
    }
}

/// `plugins` for every gear whose description declares an extension point:
/// yes when another gear in the repository implements one of its specs.
///
/// A gear.toml said so itself (`has_plugins`); a gear.gdl does not, because
/// whether a point has implementations is a fact about the other gears, so it
/// is read off them here, and off `in_crate`, the specs implemented by
/// plugins compiled into a host's crate. A value the gear.toml already set is
/// left alone.
fn attach_plugins(gears: &mut [RepoGear], in_crate: &[String]) {
    let implemented: std::collections::BTreeSet<String> = gears
        .iter()
        .filter_map(|g| g.fields.get("implements").and_then(Value::as_str))
        .map(str::to_string)
        .chain(in_crate.iter().cloned())
        .collect();
    for gear in gears.iter_mut() {
        let Some(obj) = gear.fields.as_object_mut() else {
            continue;
        };
        if obj.contains_key("plugins") {
            continue;
        }
        let Some(specs) = obj.get("extpoint_specs").and_then(Value::as_array) else {
            continue;
        };
        let declared = specs
            .iter()
            .filter_map(Value::as_str)
            .any(|s| implemented.contains(s));
        obj.insert("plugins".into(), plugins_status(declared));
    }
}

/// The `plugins` cell: whether the gear has plugins.
fn plugins_status(declared: bool) -> Value {
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
    v
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

/// Directory names that never hold a component of their own — build output,
/// vendored dependencies, and the fixture trees that exist to be compiled
/// against rather than shipped. A `package.json` under one of these is noise.
///
/// `src-app` is the FrontX convention for the application skeleton a template
/// *generates*. It earns its place here because the outermost-manifest rule
/// alone does not exclude it: `template-mfe` and `template-shell` declare their
/// `src-app/mfe_packages/*` and `src-app/verify_packages/*` as npm workspaces,
/// which makes those bodies siblings of the container rather than nested under
/// a component — so they were catalogued as components in their own right. A
/// template's real packages live in its `packages/`, and those still are.
const SKIP_SEGMENTS: [&str; 10] = [
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".yalc",
    "fixtures",
    "__fixtures__",
    "__mocks__",
    "src-app",
];

/// True when a repository path lies inside a directory we never catalogue.
fn skip_path(path: &str) -> bool {
    path.split('/').any(|seg| SKIP_SEGMENTS.contains(&seg))
}

/// True when a `package.json` is an npm/pnpm/yarn **workspace container** — it
/// groups packages rather than being one. Its children are the components.
fn is_workspace_container(body: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    // `workspaces` is either an array of globs or `{ packages: [...] }`.
    v.get("workspaces").is_some_and(|w| !w.is_null())
}

/// Every `package.json` worth considering, shallowest first — the order the
/// container-before-child rule in [`RepoEnricher::discover_frontx`] depends on.
fn frontx_manifest_paths<'a>(paths: &[&'a str]) -> Vec<&'a str> {
    let mut out: Vec<&'a str> = paths
        .iter()
        .copied()
        .filter(|p| (p.ends_with("/package.json") || *p == "package.json") && !skip_path(p))
        .collect();
    out.sort_by_key(|p| (p.matches('/').count(), *p));
    out
}

/// Normalise a git ref the way a person types it into the ref the GitHub API
/// understands: `origin/develop` and `refs/heads/develop` are how git names a
/// branch locally, but `/repos/…/git/trees/origin%2Fdevelop` is a 404. Empty
/// means "whatever the repository's default branch is".
fn normalize_ref(git_ref: &str) -> String {
    let r = git_ref.trim().trim_matches('/');
    if r.is_empty() {
        return "HEAD".to_string();
    }
    for prefix in [
        "refs/heads/",
        "refs/remotes/origin/",
        "origin/",
        "remotes/origin/",
    ] {
        if let Some(rest) = r.strip_prefix(prefix)
            && !rest.is_empty()
        {
            return rest.to_string();
        }
    }
    r.to_string()
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

/// At most this many `Cargo.toml` files are read per gear directory. A gear is
/// its crate, its SDK and a helper or two; more than this is a tree the scan
/// should not be walking file by file.
const MAX_GEAR_MANIFESTS: usize = 8;

/// The `Cargo.toml` files that belong to the gear in `dir`, relative to it,
/// shallowest first: every manifest under the directory except those inside a
/// NESTED gear directory (a plugin with its own `gear.toml` is a component of
/// its own and names its own crate) or a tree that never holds a published
/// crate (build output, fixtures, examples, fuzz targets).
fn gear_manifests(dir: &str, gear_dirs: &[String], paths: &[&str]) -> Vec<String> {
    let prefix = format!("{dir}/");
    let nested: Vec<String> = gear_dirs
        .iter()
        .filter(|g| g.as_str() != dir && g.starts_with(&prefix))
        .map(|g| format!("{g}/"))
        .collect();
    let mut out: Vec<String> = paths
        .iter()
        .filter(|p| p.ends_with("/Cargo.toml"))
        .filter(|p| p.starts_with(&prefix))
        .filter(|p| !nested.iter().any(|n| p.starts_with(n.as_str())))
        .filter_map(|p| p.strip_prefix(&prefix))
        .filter(|rel| {
            !rel.split('/').any(|seg| {
                SKIP_SEGMENTS.contains(&seg)
                    || matches!(seg, "target" | "examples" | "fuzz" | "benches" | "tests")
            })
        })
        .map(str::to_string)
        .collect();
    out.sort_by_key(|p| (p.matches('/').count(), p.clone()));
    out
}

/// `[package] name` of one `Cargo.toml`, or `None` for a virtual workspace
/// manifest (which names no package).
pub(crate) fn cargo_package_name(body: &str) -> Option<String> {
    let mut in_package = false;
    for raw in body.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            in_package = line.trim_matches(|c| c == '[' || c == ']').trim() == "package";
            continue;
        }
        if !in_package {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "name" {
            return unquote(value);
        }
    }
    None
}

/// Which of a gear directory's crates IS the gear, out of `(relative manifest
/// path, package name)` pairs. In order: a package at the directory itself
/// (`gears/system/api-gateway/Cargo.toml`); a package in the subdirectory named
/// like the gear (`gears/bss/ledger/ledger/`), which is how `gears-rust` lays
/// out a gear beside its SDK; the only direct child that is not an SDK.
/// `None` when none of those decides, and the caller falls back to the name
/// the directory suggests.
fn primary_crate(slug: &str, named: &[(String, String)]) -> Option<String> {
    if let Some((_, name)) = named.iter().find(|(rel, _)| rel == "Cargo.toml") {
        return Some(name.clone());
    }
    let own = format!("{slug}/Cargo.toml");
    if let Some((_, name)) = named.iter().find(|(rel, _)| *rel == own) {
        return Some(name.clone());
    }
    let children: Vec<&String> = named
        .iter()
        .filter(|(rel, name)| rel.matches('/').count() == 1 && !name.ends_with("-sdk"))
        .map(|(_, name)| name)
        .collect();
    match children.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

/// Whether a `package.json` is a scaffolding template rather than a package:
/// its name still carries an unfilled `{{placeholder}}`.
fn is_template_manifest(body: &str) -> bool {
    parse_package_json(body)
        .0
        .is_some_and(|name| name.contains("{{") || name.contains("}}"))
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

/// The directories that are gears.
///
/// One for every `gear.toml`, its own directory, and one for every
/// `gear.gdl`, which is not always its own directory. gears-rust lays a gear
/// out beside its SDK (`gears/bss/ledger/{ledger,ledger-sdk,docs}`), and the
/// gear.toml sat at `gears/bss/ledger` while the gear.gdl sits in the crate,
/// `gears/bss/ledger/ledger`. The gear is still the outer directory: that is
/// where its documents and its SDK are. So a gdl in a directory named like
/// its parent makes the parent the gear.
///
/// A gear.gdl under `src/` describes a plugin compiled into its host's crate
/// (mini-chat's `src/infra/plugins/static_audit`). It has no crate or
/// directory of its own, so it would be catalogued under the host's crate
/// name, twice. A gear.gdl under `examples/` describes a toolkit example, and
/// the catalogue never listed those. Both are skipped.
fn gear_dirs(paths: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for &p in paths {
        let dir = if p == "gear.toml" || p.ends_with("/gear.toml") {
            parent_dir(p)
        } else if p == "gear.gdl" || p.ends_with("/gear.gdl") {
            let dir = parent_dir(p);
            if dir
                .split('/')
                .any(|seg| matches!(seg, "src" | "examples") || SKIP_SEGMENTS.contains(&seg))
            {
                continue;
            }
            let parent = parent_dir(&dir);
            let own = dir.rsplit('/').next().unwrap_or(&dir);
            if !parent.is_empty() && parent.rsplit('/').next() == Some(own) {
                parent
            } else {
                dir
            }
        } else {
            continue;
        };
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// The gear.gdl files [`gear_dirs`] skips for being under `src/`: plugins
/// compiled into their host's crate.
fn in_crate_plugin_gdls<'p>(paths: &[&'p str]) -> Vec<&'p str> {
    paths
        .iter()
        .copied()
        .filter(|p| p.ends_with("/gear.gdl"))
        .filter(|p| {
            let dir = parent_dir(p);
            dir.split('/').any(|s| s == "src")
                && !dir
                    .split('/')
                    .any(|s| s == "examples" || SKIP_SEGMENTS.contains(&s))
        })
        .collect()
}

/// What a gear's description says, read from its gear.gdl or gear.toml.
struct DeclaredGear {
    description: Option<String>,
    category: Option<String>,
    /// `capabilities = ["auth", "authz"]`: the capability keys the gear says
    /// it provides, in the workspace's vocabulary. What the Composer matches
    /// on before it falls back to words in the name and description.
    capabilities: Option<Vec<String>>,
    plugins: Option<bool>,
    /// The gear says it IS a plugin.
    ///
    /// `classify_kind` decides this from the crate name instead, and on
    /// today's `gears-rust` the two agree for all forty-two gears — so reading
    /// the declaration changes nothing yet and is insurance, not a fix: a
    /// plugin named without the word, or a gear named with it, is a rename
    /// away.
    is_plugin: Option<bool>,
    /// The gear says it offers a place for somebody else's implementation.
    ///
    /// This is the one that pays now. Twenty-five of the forty-two gears
    /// declare an extension point and eighteen declare plugins, and the
    /// catalogue recorded none of it — zero of forty-two profiles carried
    /// either answer, because until the `[gear]` table could be read the
    /// manifest was unreadable. An extension point is where a company's
    /// specifics attach without the gear knowing about that company, so a
    /// catalogue that cannot say which gears have one cannot answer the
    /// question a brownfield assembly starts from.
    extension_point: Option<bool>,
    /// `maturity = "preview"`: gear.gdl only, where it is required.
    maturity: Option<String>,
    /// The specs of the extension points it declares (gear.gdl only).
    extension_points: Vec<String>,
    /// The spec of the extension point it implements (gear.gdl only).
    implements: Option<String>,
}

impl DeclaredGear {
    /// This description, with its gaps filled from `other`.
    fn or(self, other: DeclaredGear) -> DeclaredGear {
        DeclaredGear {
            description: self.description.or(other.description),
            category: self.category.or(other.category),
            capabilities: self.capabilities.or(other.capabilities),
            plugins: self.plugins.or(other.plugins),
            is_plugin: self.is_plugin.or(other.is_plugin),
            extension_point: self.extension_point.or(other.extension_point),
            maturity: self.maturity.or(other.maturity),
            extension_points: if self.extension_points.is_empty() {
                other.extension_points
            } else {
                self.extension_points
            },
            implements: self.implements.or(other.implements),
        }
    }

    fn empty() -> DeclaredGear {
        DeclaredGear {
            description: None,
            category: None,
            capabilities: None,
            plugins: None,
            is_plugin: None,
            extension_point: None,
            maturity: None,
            extension_points: Vec::new(),
            implements: None,
        }
    }
}

/// The catalogue's fields out of a `gear.gdl`, without the engine.
///
/// Reads the arguments of the top-level `gear(...)` call that are plain
/// strings (`description`, `category`, `maturity`, `implements`), and the
/// spec of every `extension_point(...)`. GDL is declarative, with no
/// expressions to evaluate, so this sees what the engine sees; what it
/// cannot read (a value that is not a string literal) is left unread.
///
/// `fills` is the name `implements` had before gearbox#2, and a description
/// written for an older engine still says it.
fn parse_gear_gdl(body: &str) -> DeclaredGear {
    let mut out = DeclaredGear::empty();
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    let mut depth = 0usize;
    // The key a string at depth 1 is the value of.
    let mut key: Option<String> = None;
    // Inside `extension_point(`: the depth of its arguments, and whether
    // the spec has been read yet.
    let mut point: Option<usize> = None;
    let mut point_key: Option<String> = None;
    while i < chars.len() {
        let c = chars[i];
        if c == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '"' {
            let (s, next) = gdl_string(&chars, i);
            i = next;
            if depth == 1
                && let Some(k) = key.take()
            {
                match k.as_str() {
                    "description" => out.description = Some(s),
                    "category" => out.category = Some(s),
                    "maturity" => out.maturity = Some(s),
                    "implements" | "fills" => out.implements = Some(s),
                    _ => {}
                }
            } else if point == Some(depth) && point_key.as_deref().is_none_or(|k| k == "spec") {
                out.extension_points.push(s);
                point = None;
            }
            point_key = None;
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let ident: String = chars[start..i].iter().collect();
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let next = chars.get(j).copied();
            if next == Some('=') && chars.get(j + 1) != Some(&'=') {
                if depth == 1 {
                    key = Some(ident);
                } else if point == Some(depth) {
                    point_key = Some(ident);
                }
                i = j + 1;
            } else if next == Some('(') && ident == "extension_point" {
                point = Some(depth + 1);
                point_key = None;
                depth += 1;
                i = j + 1;
            }
            continue;
        }
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                if point == Some(depth) {
                    point = None;
                }
                depth = depth.saturating_sub(1);
            }
            ',' => {
                key = None;
                point_key = None;
            }
            _ => {}
        }
        i += 1;
    }
    // A gear that offers its own extension point is a host first, even when
    // it also implements another's: rate-provider implements the ledger's
    // point and is where its source plugins attach, and its gear.toml said
    // `is_plugin = false`.
    out.is_plugin = Some(out.implements.is_some() && out.extension_points.is_empty());
    out.extension_point = Some(!out.extension_points.is_empty());
    out
}

/// The string literal opening at `chars[at]`, unescaped, and the index past
/// its closing quote.
fn gdl_string(chars: &[char], at: usize) -> (String, usize) {
    let mut s = String::new();
    let mut i = at + 1;
    while i < chars.len() {
        match chars[i] {
            '"' => return (s, i + 1),
            '\\' if i + 1 < chars.len() => {
                s.push(match chars[i + 1] {
                    'n' => '\n',
                    't' => '\t',
                    other => other,
                });
                i += 2;
            }
            ch => {
                s.push(ch);
                i += 1;
            }
        }
    }
    (s, i)
}

/// Minimal top-level TOML reader — enough for `description`, `category`/`domain`
/// and a `plugins` declaration, without pulling in a TOML crate.
fn parse_gear_toml(body: &str) -> DeclaredGear {
    let mut out = DeclaredGear::empty();
    // `[gear]` counts as the top level.
    //
    // This used to stop reading at the first `[` of any kind, and every gear in
    // `gears-rust` puts its whole manifest under a `[gear]` table -- so the
    // catalogue read NOTHING out of any of them. Nineteen of the forty-two
    // gears scanned from that repository had no description at all, and the
    // twenty-three that did had it from crates.io rather than from the file
    // that states it: `gears/bss/ledger/gear.toml` says "Append-only
    // double-entry subledger for financially material movements and balances"
    // and the catalogue showed an empty cell.
    //
    // It matters beyond the cell. Matching a product's capabilities against the
    // catalogue scores a component on its name, description, keywords and
    // categories (`compose.ts`), so a gear with none of them could only ever be
    // found by its own name.
    let mut readable = true;
    for raw in body.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            if line.starts_with("[plugins") || line.starts_with("[[plugins") {
                out.plugins = Some(true);
            }
            // Any other table is somebody else's keys -- `[dependencies]` has a
            // `description` about as often as not.
            readable = line.starts_with("[gear]");
            continue;
        }
        if !readable || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k.trim() {
            "description" if out.description.is_none() => out.description = unquote(v),
            "category" | "domain" if out.category.is_none() => out.category = unquote(v),
            "capabilities" if out.capabilities.is_none() => out.capabilities = string_list(v),
            "plugins" | "has_plugins" => {
                let val = v.trim();
                let declared =
                    val.starts_with("true") || (val.starts_with('[') && val.contains('"'));
                out.plugins = Some(declared);
            }
            "is_plugin" => out.is_plugin = Some(v.trim().starts_with("true")),
            "has_extension_point" => out.extension_point = Some(v.trim().starts_with("true")),
            _ => {}
        }
    }
    out
}

/// A one-line TOML array of strings, `["a", "b"]`, as its items. `None` for
/// anything else (a multi-line array is written on one line by convention in
/// gear.toml, and a value this cannot read is left unread, not guessed).
fn string_list(v: &str) -> Option<Vec<String>> {
    let v = v.split('#').next().unwrap_or("").trim();
    let inner = v.strip_prefix('[')?.strip_suffix(']')?;
    let items: Vec<String> = inner
        .split(',')
        .map(|i| {
            i.trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .trim()
                .to_string()
        })
        .filter(|i| !i.is_empty())
        .collect();
    (!items.is_empty()).then_some(items)
}

/// The run-time dependency names one `Cargo.toml` declares. A hand parser, as
/// for gear.toml: table headers decide which lines count, and an entry's name
/// is its key -- or its `package = "..."` when the key is a rename.
pub(crate) fn cargo_dependency_names(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut counting = false;
    for raw in body.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            let table = line.trim_matches(|c| c == '[' || c == ']').trim();
            counting = table == "dependencies"
                || table == "workspace.dependencies"
                || (table.starts_with("target.") && table.ends_with(".dependencies"));
            // `[dependencies.foo]` names one dependency in its header.
            if let Some(name) = table.strip_prefix("dependencies.") {
                out.push(name.trim_matches('"').to_string());
            }
            continue;
        }
        if !counting {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_matches('"');
        // `foo.workspace = true` is the dependency `foo`.
        let key = key.split('.').next().unwrap_or(key);
        let renamed = value.split("package").nth(1).and_then(|rest| {
            let rest = rest.trim_start().strip_prefix('=')?.trim_start();
            let rest = rest.strip_prefix('"')?;
            rest.split('"').next().map(str::to_string)
        });
        let name = renamed.unwrap_or_else(|| key.to_string());
        if !name.is_empty() {
            out.push(name);
        }
    }
    out.sort();
    out.dedup();
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

/// What a `package.json` (and the files beside it) say about the package's
/// kind: whether it ships a command (`bin`), builds a module-federation remote
/// (a federation plugin among its dependencies, or a federation config file
/// at its root), and whether it is `private`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PackageFacts {
    pub bin: bool,
    pub mfe: bool,
    pub private: bool,
}

pub(crate) fn package_json_facts(body: &str, rel: &[&str]) -> PackageFacts {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return PackageFacts::default();
    };
    let bin = match v.get("bin") {
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        _ => false,
    };
    let federation_dep = ["dependencies", "devDependencies"].iter().any(|section| {
        v.get(section)
            .and_then(Value::as_object)
            .is_some_and(|deps| {
                deps.keys().any(|k| {
                    k.starts_with("@module-federation/") || k.contains("vite-plugin-federation")
                })
            })
    });
    let federation_file = rel.iter().any(|p| {
        !p.contains('/') && (*p == "mfe.json" || p.starts_with("module-federation.config"))
    });
    PackageFacts {
        bin,
        mfe: federation_dep || federation_file,
        private: v.get("private").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// One top-level string field out of a package.json body.
fn package_json_str(body: &str, key: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
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

/// One top-level `key = "value"` out of a TOML document.
///
/// One kit as the catalogue records it.
#[derive(Debug, PartialEq, Eq)]
struct ManifestKit {
    slug: String,
    name: String,
    description: Option<String>,
    publisher: Option<String>,
    version: Option<String>,
}

/// The kits one `.cf-studio-kit.toml` declares.
///
/// A manifest holds `[[kits]]` blocks, one per installable kit, and both kit
/// repositories that exist are shaped that way — `cfs` reads them to offer the
/// `--kit` selector on install. Reading only the top level found none of it:
/// every entry came back named after its REPOSITORY, with no description and no
/// version, which is what `studio-kit-sdlc` was doing sitting in the catalogue
/// beside the `sdlc` it is. Three kits in one repository would have come back
/// as one.
///
/// A manifest with no `[[kits]]` block is read the old way — top-level keys,
/// directory name as the slug — because that shape is legal and this is a
/// catalogue, not a validator.
fn manifest_kits(body: &str, fallback_slug: &str) -> Vec<ManifestKit> {
    let mut out: Vec<ManifestKit> = Vec::new();
    let mut current: Option<ManifestKit> = None;
    let mut in_kit = false;
    for raw in body.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            if let Some(kit) = current.take() {
                out.push(kit);
            }
            // `[[kits.resources]]` and friends are a kit's contents, not a kit:
            // they carry an `id`, a `description` and a `kind` of their own,
            // and reading one would describe the kit as its first template.
            in_kit = line.starts_with("[[kits]]");
            if in_kit {
                current = Some(ManifestKit {
                    slug: String::new(),
                    name: String::new(),
                    description: None,
                    publisher: None,
                    version: None,
                });
            }
            continue;
        }
        let Some(kit) = current.as_mut() else {
            continue;
        };
        if !in_kit || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "slug" => kit.slug = value.to_string(),
            "name" => kit.name = value.to_string(),
            "description" => kit.description = Some(value.to_string()),
            "publisher" => kit.publisher = Some(value.to_string()),
            "version" => kit.version = Some(value.to_string()),
            _ => {}
        }
    }
    if let Some(kit) = current.take() {
        out.push(kit);
    }

    if out.is_empty() {
        let slug = toml_string(body, "slug").unwrap_or_else(|| fallback_slug.to_string());
        let name = toml_string(body, "name").unwrap_or_else(|| slug.clone());
        return vec![ManifestKit {
            slug,
            name,
            description: toml_string(body, "description"),
            publisher: toml_string(body, "publisher"),
            version: toml_string(body, "version"),
        }];
    }

    for kit in &mut out {
        if kit.slug.is_empty() {
            kit.slug = fallback_slug.to_string();
        }
        if kit.name.is_empty() {
            kit.name = kit.slug.clone();
        }
    }
    // A repository that declares the same slug twice would otherwise write the
    // same catalogue node twice, and the second write would win silently.
    let mut seen: Vec<String> = Vec::new();
    out.retain(|k| {
        if seen.iter().any(|s| s == &k.slug) {
            return false;
        }
        seen.push(k.slug.clone());
        true
    });
    out
}

/// Deliberately not a TOML parse: the manifest's full schema belongs to the kit
/// registry, and the catalogue needs four strings out of it. A dependency, and a
/// second definition of the manifest's shape to go with it, would each be larger
/// than this and would go stale the moment the registry's schema moved.
fn toml_string(body: &str, key: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // A table header: everything past it is nested, and only the
            // top-level keys are the kit's own.
            break;
        }
        let Some((found, value)) = line.split_once('=') else {
            continue;
        };
        if found.trim() != key {
            continue;
        }
        let value = value.trim().trim_matches('"').trim();
        if value.is_empty() {
            return None;
        }
        return Some(value.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `gears/bss/ledger/gear.toml`, verbatim. Every gear in `gears-rust` is
    /// shaped like this -- a `[gear]` table and nothing above it -- which is
    /// the case the parser used to read nothing out of.
    const LEDGER_GEAR_TOML: &str = r#"[gear]
name = "Billing Ledger"
description = "Append-only double-entry subledger for financially material movements and balances."
category = "bss"
is_plugin = false
has_plugins = false
has_extension_point = false
"#;

    /// `constructorfabric/studio-kit-sdlc/.cf-studio-kit.toml`, trimmed to the
    /// shape that matters: one `[[kits]]` block and resources under it.
    const SDLC_KIT_MANIFEST: &str = r#"# Generated by cfs kit normalize.

manifest_version = "1.0"

[[kits]]
slug = "sdlc"
name = "sdlc"
version = "1.0"

[[kits.resources]]
id = "adr_template"
kind = "template"
source = "artifacts/ADR/template.md"
description = "ADR artifact template"
"#;

    #[test]
    fn a_kit_is_named_after_itself_and_not_after_its_repository() {
        // This is what `studio-kit-sdlc` was doing in the catalogue: an entry
        // named after the repository, with no description and no version,
        // sitting beside the `sdlc` it is.
        let kits = manifest_kits(SDLC_KIT_MANIFEST, "studio-kit-sdlc");
        assert_eq!(kits.len(), 1);
        assert_eq!(kits[0].slug, "sdlc");
        assert_eq!(kits[0].name, "sdlc");
        assert_eq!(kits[0].version.as_deref(), Some("1.0"));
    }

    #[test]
    fn a_kits_resources_do_not_describe_the_kit() {
        // `[[kits.resources]]` blocks carry an `id`, a `kind` and a
        // `description` of their own; reading one would describe the kit as its
        // first template.
        let kits = manifest_kits(SDLC_KIT_MANIFEST, "fallback");
        assert_eq!(kits[0].description, None);
    }

    #[test]
    fn every_kit_in_a_repository_is_its_own_component() {
        let body = "manifest_version = \"1.0\"\n\n\
                    [[kits]]\nslug = \"compete\"\nname = \"Competitive Analysis\"\n\n\
                    [[kits.resources]]\nid = \"x\"\n\n\
                    [[kits]]\nslug = \"discovery\"\nname = \"Discovery\"\n";
        let kits = manifest_kits(body, "studio-kits-pm");
        assert_eq!(
            kits.iter().map(|k| k.slug.as_str()).collect::<Vec<_>>(),
            vec!["compete", "discovery"]
        );
        assert_eq!(kits[0].name, "Competitive Analysis");
    }

    #[test]
    fn a_manifest_with_no_kits_block_is_still_read_the_old_way() {
        // That shape is legal, and this is a catalogue rather than a validator.
        let kits = manifest_kits(
            "name = \"Legacy\"\ndescription = \"A flat one.\"\n\n[install]\nslug = \"not-the-kit\"\n",
            "legacy-dir",
        );
        assert_eq!(kits.len(), 1);
        // `[install] slug` is a different key; reading it would name the kit
        // after one of its sections.
        assert_eq!(kits[0].slug, "legacy-dir");
        assert_eq!(kits[0].name, "Legacy");
        assert_eq!(kits[0].description.as_deref(), Some("A flat one."));
    }

    #[test]
    fn a_kit_block_with_no_slug_falls_back_to_where_it_was_found() {
        let kits = manifest_kits("[[kits]]\nname = \"Unnamed\"\n", "from-the-directory");
        assert_eq!(kits[0].slug, "from-the-directory");
    }

    #[test]
    fn a_slug_declared_twice_is_one_component() {
        // Two nodes under one key means the second write wins silently.
        let kits = manifest_kits(
            "[[kits]]\nslug = \"dup\"\nname = \"First\"\n\n[[kits]]\nslug = \"dup\"\nname = \"Second\"\n",
            "repo",
        );
        assert_eq!(kits.len(), 1);
        assert_eq!(kits[0].name, "First");
    }

    #[test]
    fn a_manifest_under_a_gear_table_is_read() {
        let parsed = parse_gear_toml(LEDGER_GEAR_TOML);
        assert_eq!(
            parsed.description.as_deref(),
            Some(
                "Append-only double-entry subledger for financially material movements and balances."
            )
        );
        assert_eq!(parsed.category.as_deref(), Some("bss"));
        assert_eq!(parsed.plugins, Some(false));
    }

    #[test]
    fn a_manifest_with_bare_top_level_keys_is_still_read() {
        // The shape the parser was written for, and the one the prototype's own
        // scaffold writes. Both have to work.
        let parsed = parse_gear_toml(
            "description = \"A flat one.\"
category = \"platform\"

[plugins]
declared = false
",
        );
        assert_eq!(parsed.description.as_deref(), Some("A flat one."));
        assert_eq!(parsed.category.as_deref(), Some("platform"));
        assert_eq!(parsed.plugins, Some(true));
    }

    #[test]
    fn another_tables_description_is_not_the_gears() {
        // `[package]` and `[dependencies]` carry a `description` about as often
        // as not, and reading one would put a crate's blurb on the gear.
        let parsed = parse_gear_toml(
            "[gear]
description = \"The gear.\"

[package]
description = \"The crate.\"
category = \"wrong\"
",
        );
        assert_eq!(parsed.description.as_deref(), Some("The gear."));
        assert_eq!(parsed.category, None);
    }

    #[test]
    fn a_gear_says_whether_it_is_a_plugin_and_whether_it_offers_a_seam() {
        // `credstore` declares both, and until the `[gear]` table could be read
        // the catalogue recorded neither: zero of the forty-two scanned gears
        // carried a plugins or extension-point answer at all.
        let parsed = parse_gear_toml(
            "[gear]\nname = \"Credentials Store\"\nis_plugin = false\n\
             has_plugins = true\nhas_extension_point = true\n",
        );
        assert_eq!(parsed.is_plugin, Some(false));
        assert_eq!(parsed.extension_point, Some(true));
        assert_eq!(parsed.plugins, Some(true));
    }

    #[test]
    fn a_plugin_says_so_rather_than_being_guessed_from_its_name() {
        let parsed = parse_gear_toml("[gear]\nname = \"ECB rates\"\nis_plugin = true\n");
        assert_eq!(parsed.is_plugin, Some(true));
    }

    #[test]
    fn a_manifest_that_says_nothing_leaves_the_guess_in_place() {
        // `None`, not `Some(false)`: the service falls back to reading the
        // crate name, and an invented `false` would take that fallback away
        // from every gear whose manifest predates the key.
        let parsed = parse_gear_toml("[gear]\nname = \"Ledger\"\ncategory = \"bss\"\n");
        assert_eq!(parsed.is_plugin, None);
        assert_eq!(parsed.extension_point, None);
    }

    #[test]
    fn a_gear_that_declares_plugins_says_so_from_inside_its_table() {
        let parsed = parse_gear_toml(
            "[gear]
name = \"Credentials Store\"
has_plugins = true
has_extension_point = true
",
        );
        assert_eq!(parsed.plugins, Some(true));
    }

    /// Every `package.json` in `constructorfabric/gears-frontx` at `develop`,
    /// as the git trees API returns it (verbatim, minus `node_modules`), plus a
    /// couple of build-output and vendored paths to prove they are dropped.
    ///
    /// Worth spelling out, because the shape is not the obvious one: the two
    /// scaffolding templates sit at the repository ROOT, `template-shell` keeps
    /// six real `@gears-frontx/*` packages under its own `packages/`, and both
    /// templates declare their `src-app/**` bodies as npm workspaces — which is
    /// what made those bodies look like components.
    fn frontx_tree() -> Vec<&'static str> {
        vec![
            "package.json",
            "internal/depcruise-config/package.json",
            "internal/eslint-config/package.json",
            "internal/test-support/package.json",
            "packages/api/package.json",
            "packages/cli/package.json",
            "packages/cyber-pilot-kit-frontx/package.json",
            "packages/gts-plugin/package.json",
            "packages/mfes/package.json",
            "packages/telemetry/package.json",
            "packages/ui-kit/package.json",
            "packages/ui-kit/src/index.ts",
            "packages/ui-kit/src/button.test.tsx",
            "template-shell/package.json",
            "template-shell/packages/auth/package.json",
            "template-shell/packages/framework/package.json",
            "template-shell/packages/i18n/package.json",
            "template-shell/packages/react/package.json",
            "template-shell/packages/state/package.json",
            "template-shell/packages/studio/package.json",
            "template-mfe/package.json",
            // Generated-skeleton bodies and verification fixtures: what the
            // templates PRODUCE, not components of the repository.
            "template-mfe/src-app/mfe_packages/_blank-mfe/package.json",
            "template-mfe/src-app/mfe_packages/demo-mfe/package.json",
            "template-mfe/src-app/mfe_packages/widgets-fixture-a/package.json",
            "template-mfe/src-app/mfe_packages/widgets-fixture-b/package.json",
            "template-design-guardrails/src-app/verify_packages/design-verify/package.json",
            // Never components.
            "packages/ui-kit/node_modules/react/package.json",
            "packages/ui-kit/dist/package.json",
        ]
    }

    #[test]
    fn manifest_paths_skip_vendored_and_built_output() {
        let tree = frontx_tree();
        let got = frontx_manifest_paths(&tree);
        assert!(!got.iter().any(|p| p.contains("node_modules")));
        assert!(!got.iter().any(|p| p.contains("/dist/")));
        // Shallowest first, so the workspace root is seen before its packages.
        assert_eq!(got.first(), Some(&"package.json"));
    }

    /// The whole point of the `src-app` rule: a template's generated skeleton
    /// is not a set of components, while the packages beside it are.
    #[test]
    fn generated_app_skeletons_are_not_components() {
        let tree = frontx_tree();
        let got = frontx_manifest_paths(&tree);
        for phantom in [
            "template-mfe/src-app/mfe_packages/_blank-mfe/package.json",
            "template-mfe/src-app/mfe_packages/demo-mfe/package.json",
            "template-mfe/src-app/mfe_packages/widgets-fixture-a/package.json",
            "template-mfe/src-app/mfe_packages/widgets-fixture-b/package.json",
            "template-design-guardrails/src-app/verify_packages/design-verify/package.json",
        ] {
            assert!(!got.contains(&phantom), "not skipped: {phantom}");
        }
        // The six real packages the shell template carries are kept.
        for kept in [
            "template-shell/packages/auth/package.json",
            "template-shell/packages/framework/package.json",
            "template-shell/packages/i18n/package.json",
            "template-shell/packages/react/package.json",
            "template-shell/packages/state/package.json",
            "template-shell/packages/studio/package.json",
        ] {
            assert!(got.contains(&kept), "not kept: {kept}");
        }
    }

    #[test]
    fn manifest_paths_include_root_level_templates() {
        let tree = frontx_tree();
        let got = frontx_manifest_paths(&tree);
        assert!(got.contains(&"template-shell/package.json"));
        assert!(got.contains(&"template-mfe/package.json"));
        assert!(got.contains(&"packages/ui-kit/package.json"));
    }

    #[test]
    fn workspace_root_is_a_container_and_a_package_is_not() {
        assert!(is_workspace_container(
            r#"{"name":"gears-frontx","workspaces":["packages/*"]}"#
        ));
        assert!(is_workspace_container(
            r#"{"name":"root","workspaces":{"packages":["packages/*"]}}"#
        ));
        assert!(!is_workspace_container(
            r#"{"name":"@gears-frontx/ui-kit","version":"0.4.0-alpha.1"}"#
        ));
        // Malformed JSON is not a container — the caller decides what to do
        // with a package it could not parse.
        assert!(!is_workspace_container("not json"));
    }

    #[test]
    fn refs_are_normalised_to_what_the_github_api_accepts() {
        // What a person types after looking at `git branch -a`.
        assert_eq!(normalize_ref("origin/develop"), "develop");
        assert_eq!(normalize_ref("refs/heads/main"), "main");
        assert_eq!(normalize_ref("refs/remotes/origin/develop"), "develop");
        // Plain names and empties.
        assert_eq!(normalize_ref("develop"), "develop");
        assert_eq!(normalize_ref("  main  "), "main");
        assert_eq!(normalize_ref(""), "HEAD");
        // A branch that merely starts with the word is left alone.
        assert_eq!(normalize_ref("originals"), "originals");
    }

    #[test]
    fn skipped_segments_match_whole_directories_only() {
        assert!(skip_path("packages/x/node_modules/y/package.json"));
        assert!(skip_path("dist/package.json"));
        // A package whose NAME contains a skipped word is still a package.
        assert!(!skip_path("packages/dist-utils/package.json"));
        assert!(!skip_path("packages/ui-kit/package.json"));
    }

    #[test]
    fn a_repository_source_says_what_it_contributes() {
        assert_eq!(RepoMode::parse("kits"), RepoMode::Kits);
        assert_eq!(RepoMode::parse("kit"), RepoMode::Kits);
        assert_eq!(RepoMode::parse("frontx"), RepoMode::Frontx);
        // Anything unrecognised is a gear repository, which is also what a
        // caller that sends no mode at all means.
        assert_eq!(RepoMode::parse(""), RepoMode::Gears);
        assert_eq!(RepoMode::parse("something-else"), RepoMode::Gears);
    }

    #[test]
    fn a_manifest_field_is_read_off_the_top_level() {
        let body = "slug = \"sdlc\"\nname = \"Software Delivery Lifecycle\"\n";
        assert_eq!(toml_string(body, "slug").as_deref(), Some("sdlc"));
        assert_eq!(
            toml_string(body, "name").as_deref(),
            Some("Software Delivery Lifecycle")
        );
        assert_eq!(toml_string(body, "publisher"), None);
    }

    #[test]
    fn a_field_inside_a_table_is_not_a_top_level_field() {
        // `[install] slug = ...` is a different key. Reading it as the kit's
        // own slug would name the kit after one of its sections.
        let body = "name = \"Kit\"\n\n[install]\nslug = \"not-the-kit\"\n";
        assert_eq!(toml_string(body, "name").as_deref(), Some("Kit"));
        assert_eq!(toml_string(body, "slug"), None);
    }

    #[test]
    fn an_empty_value_reads_as_absent() {
        // `publisher = ""` is a field somebody left blank, not a publisher
        // whose name happens to be the empty string.
        assert_eq!(toml_string("publisher = \"\"\n", "publisher"), None);
    }

    #[test]
    fn a_gear_toml_declares_its_capabilities() {
        let parsed = parse_gear_toml(
            "[gear]\nname = \"AuthN\"\ncapabilities = [\"auth\", 'authz'] # what it provides\n",
        );
        assert_eq!(
            parsed.capabilities,
            Some(vec!["auth".to_string(), "authz".to_string()])
        );
        assert_eq!(parse_gear_toml("[gear]\nname = \"x\"\n").capabilities, None);
        // Only the [gear] table speaks for the gear.
        assert_eq!(
            parse_gear_toml("[gear]\nname = \"x\"\n[metadata]\ncapabilities = [\"billing\"]\n")
                .capabilities,
            None
        );
    }

    /// What a product is made of is what it depends on at run time: renames
    /// resolved, workspace inheritance read, dev and build tables left out.
    #[test]
    fn a_manifest_names_its_runtime_dependencies() {
        let body = r#"
[package]
name = "studio-backend"

[dependencies]
cf-gears-api-gateway = { workspace = true }
authn = { package = "cf-gears-authn-resolver", version = "0.1" }
serde.workspace = true
"cf-gears-credstore" = "0.2"   # quoted key

[dependencies.cf-gears-file-storage]
version = "0.1"

[target.'cfg(unix)'.dependencies]
cf-gears-nodes-registry = "0.1"

[dev-dependencies]
cf-gears-test-support = "0.1"

[build-dependencies]
cc = "1"

[workspace.dependencies]
cf-gears-types-registry = { git = "https://github.com/x/y" }
"#;
        assert_eq!(
            cargo_dependency_names(body),
            [
                "cf-gears-api-gateway",
                "cf-gears-authn-resolver",
                "cf-gears-credstore",
                "cf-gears-file-storage",
                "cf-gears-nodes-registry",
                "cf-gears-types-registry",
                "serde",
            ]
        );
    }

    // ---- which crate a gear directory is -----------------------------------

    /// The shape of `gears-rust` for the gears the old `cf-gears-<dir>` guess
    /// got wrong, checked against the Gearbox engine's catalogue of the same
    /// corpus (`package.crate_name` / `package.path`).
    fn rust_tree() -> Vec<&'static str> {
        vec![
            "gears/bss/ledger/gear.toml",
            "gears/bss/ledger/ledger/Cargo.toml",
            "gears/bss/ledger/ledger-sdk/Cargo.toml",
            "gears/bss/rate-provider/gear.toml",
            "gears/bss/rate-provider/rate-provider/Cargo.toml",
            "gears/bss/rate-provider/plugins/ecb-plugin/gear.toml",
            "gears/bss/rate-provider/plugins/ecb-plugin/Cargo.toml",
            "gears/chat-engine/gear.toml",
            "gears/chat-engine/chat-engine/Cargo.toml",
            "gears/chat-engine/chat-engine-sdk/Cargo.toml",
            "gears/chat-engine/chat-engine/tests/fixtures/Cargo.toml",
            "gears/system/api-gateway/gear.toml",
            "gears/system/api-gateway/Cargo.toml",
            "gears/approval-service/gear.toml",
            "gears/approval-service/docs/PRD.md",
        ]
    }

    /// The same corpus after gears-rust#4793 retired gear.toml: each gear.gdl
    /// beside the crate it describes, a plugin compiled into mini-chat's
    /// crate, and a toolkit example.
    fn gdl_tree() -> Vec<&'static str> {
        vec![
            "gears/bss/ledger/ledger/gear.gdl",
            "gears/bss/ledger/ledger/Cargo.toml",
            "gears/bss/ledger/ledger-sdk/Cargo.toml",
            "gears/bss/ledger/docs/PRD.md",
            "gears/bss/rate-provider/rate-provider/gear.gdl",
            "gears/bss/rate-provider/rate-provider/Cargo.toml",
            "gears/bss/rate-provider/plugins/ecb-plugin/gear.gdl",
            "gears/bss/rate-provider/plugins/ecb-plugin/Cargo.toml",
            "gears/chat-engine/chat-engine/gear.gdl",
            "gears/chat-engine/chat-engine/Cargo.toml",
            "gears/chat-engine/chat-engine-sdk/Cargo.toml",
            "gears/system/api-gateway/gear.gdl",
            "gears/system/api-gateway/Cargo.toml",
            "gears/system/event-broker/gear.gdl",
            "gears/system/event-broker/event-broker/Cargo.toml",
            "gears/approval-service/gear.gdl",
            "gears/approval-service/docs/PRD.md",
            "gears/mini-chat/mini-chat/gear.gdl",
            "gears/mini-chat/mini-chat/Cargo.toml",
            "gears/mini-chat/mini-chat/src/infra/plugins/static_audit/gear.gdl",
            "examples/toolkit/api-contracts/api-contracts/gear.gdl",
        ]
    }

    #[test]
    fn a_gear_gdl_makes_the_same_gear_directories_the_gear_toml_did() {
        assert_eq!(
            gear_dirs(&gdl_tree()),
            vec![
                "gears/bss/ledger",
                "gears/bss/rate-provider",
                "gears/bss/rate-provider/plugins/ecb-plugin",
                "gears/chat-engine",
                "gears/system/api-gateway",
                "gears/system/event-broker",
                "gears/approval-service",
                "gears/mini-chat",
            ],
            "a gdl in its crate names the outer directory; src/ and examples/ are not gears"
        );
        // The directories the gear.toml files gave, for the same gears.
        assert_eq!(
            gear_dirs(&rust_tree()),
            vec![
                "gears/bss/ledger",
                "gears/bss/rate-provider",
                "gears/bss/rate-provider/plugins/ecb-plugin",
                "gears/chat-engine",
                "gears/system/api-gateway",
                "gears/approval-service",
            ]
        );
    }

    #[test]
    fn a_gear_described_twice_is_one_gear() {
        let tree = [
            "gears/bss/ledger/gear.toml",
            "gears/bss/ledger/ledger/gear.gdl",
            "gears/audit-log/gear.toml",
            "gears/audit-log/gear.gdl",
        ];
        assert_eq!(
            gear_dirs(&tree),
            vec!["gears/bss/ledger", "gears/audit-log"]
        );
    }

    #[test]
    fn the_crate_is_still_found_from_a_gdl_directory() {
        let tree = gdl_tree();
        let dirs = gear_dirs(&tree);
        assert_eq!(
            gear_manifests("gears/bss/ledger", &dirs, &tree),
            vec![
                "ledger-sdk/Cargo.toml".to_string(),
                "ledger/Cargo.toml".to_string()
            ]
        );
        let named: Vec<(String, String)> = vec![
            (
                "ledger-sdk/Cargo.toml".into(),
                "cf-gears-bss-ledger-sdk".into(),
            ),
            ("ledger/Cargo.toml".into(), "cf-gears-bss-ledger".into()),
        ];
        assert_eq!(
            primary_crate("ledger", &named).as_deref(),
            Some("cf-gears-bss-ledger")
        );
        assert_eq!(
            gear_manifests("gears/bss/rate-provider", &dirs, &tree),
            vec!["rate-provider/Cargo.toml".to_string()],
            "the ECB plugin is its own gear here too"
        );
    }

    #[test]
    fn a_gear_owns_its_manifests_but_not_a_nested_gear_s() {
        let tree = rust_tree();
        let dirs = gear_dirs(&tree);
        assert_eq!(
            gear_manifests("gears/bss/rate-provider", &dirs, &tree),
            vec!["rate-provider/Cargo.toml".to_string()],
            "the ECB plugin has its own gear.toml and names its own crate"
        );
        assert_eq!(
            gear_manifests("gears/chat-engine", &dirs, &tree),
            vec![
                "chat-engine-sdk/Cargo.toml".to_string(),
                "chat-engine/Cargo.toml".to_string()
            ],
            "a fixture crate is not the gear's"
        );
        assert!(gear_manifests("gears/approval-service", &dirs, &tree).is_empty());
    }

    #[test]
    fn the_package_name_is_read_from_the_package_table_only() {
        let body = "[workspace]\nmembers = []\n\n[package]\nname = \"cf-gears-bss-ledger\" # the gear\nversion = \"0.1.0\"\n\n[dependencies]\nname = \"not-this\"\n";
        assert_eq!(
            cargo_package_name(body).as_deref(),
            Some("cf-gears-bss-ledger")
        );
        assert_eq!(cargo_package_name("[workspace]\nmembers = [\"a\"]\n"), None);
    }

    fn named(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(r, n)| (r.to_string(), n.to_string()))
            .collect()
    }

    #[test]
    fn the_gear_is_the_crate_at_its_directory_or_named_like_it() {
        assert_eq!(
            primary_crate(
                "api-gateway",
                &named(&[("Cargo.toml", "cf-gears-api-gateway")])
            )
            .as_deref(),
            Some("cf-gears-api-gateway")
        );
        assert_eq!(
            primary_crate(
                "ledger",
                &named(&[
                    ("ledger-sdk/Cargo.toml", "cf-gears-bss-ledger-sdk"),
                    ("ledger/Cargo.toml", "cf-gears-bss-ledger"),
                ])
            )
            .as_deref(),
            Some("cf-gears-bss-ledger")
        );
        assert_eq!(
            primary_crate(
                "chat-engine",
                &named(&[
                    ("chat-engine-sdk/Cargo.toml", "cf-chat-engine-sdk"),
                    ("chat-engine/Cargo.toml", "cf-chat-engine"),
                ])
            )
            .as_deref(),
            Some("cf-chat-engine"),
            "the crate is not always cf-gears-<dir>"
        );
    }

    #[test]
    fn otherwise_the_only_child_that_is_not_an_sdk_or_nothing() {
        assert_eq!(
            primary_crate(
                "x",
                &named(&[
                    ("core/Cargo.toml", "cf-x-core"),
                    ("x-sdk/Cargo.toml", "cf-x-sdk")
                ])
            )
            .as_deref(),
            Some("cf-x-core")
        );
        assert_eq!(
            primary_crate(
                "x",
                &named(&[("a/Cargo.toml", "cf-a"), ("b/Cargo.toml", "cf-b")])
            ),
            None,
            "two candidates: undecided, not a coin toss"
        );
        assert_eq!(primary_crate("approval-service", &[]), None);
    }

    #[test]
    fn package_json_says_tool_federation_and_private() {
        let cli = package_json_facts(
            r#"{"name":"@gears-frontx/cli","bin":{"frontx":"dist/cli.js"}}"#,
            &[],
        );
        assert!(cli.bin && !cli.mfe);
        let mfe = package_json_facts(
            r#"{"name":"@acme/orders","devDependencies":{"@originjs/vite-plugin-federation":"1"}}"#,
            &[],
        );
        assert!(mfe.mfe);
        let by_file = package_json_facts(
            r#"{"name":"@acme/x","private":true}"#,
            &["mfe.json", "src/a.ts"],
        );
        assert!(by_file.mfe && by_file.private);
        assert_eq!(package_json_facts("nope", &[]), PackageFacts::default());
    }

    #[test]
    fn a_template_manifest_is_not_a_package() {
        assert!(is_template_manifest(
            r#"{"name":"@gears-frontx/{{mfeName}}-mfe","version":"0.0.0"}"#
        ));
        assert!(!is_template_manifest(
            r#"{"name":"@gears-frontx/ui-kit","version":"0.4.0"}"#
        ));
        assert!(!is_template_manifest("not json"));
    }

    // ---- gear.gdl -----------------------------------------------------------

    /// `gears/system/authn-resolver/authn-resolver/gear.gdl` from
    /// gears-rust#4793, with a comment that must not be read.
    const AUTHN_RESOLVER_GDL: &str = r#"# Gearbox product metadata for the authn-resolver gear.
#
# description = "not this one: a comment"

gear(
    maturity = "preview",
    name = "Authentication Resolver",
    description = "Authentication primitives with pluggable token validation backends.",
    category = "core-platform-integration",
    visibility = "internal",

    package = cargo(
        crate_name = "cf-gears-authn-resolver",
        lib = "authn_resolver",
        path = ".",
    ),

    sdk = cargo(
        crate_name = "cf-gears-authn-resolver-sdk",
        lib = "authn_resolver_sdk",
        path = "../authn-resolver-sdk",
    ),

    extension_points = [
        extension_point("cf.core.authn_resolver.plugin.v1~", trait = "AuthNResolverPluginClient"),
    ],

    config_schema = config(exposes = ["vendor"]),
)
"#;

    #[test]
    fn a_gear_gdl_gives_the_fields_a_gear_toml_did() {
        let parsed = parse_gear_gdl(AUTHN_RESOLVER_GDL);
        assert_eq!(
            parsed.description.as_deref(),
            Some("Authentication primitives with pluggable token validation backends.")
        );
        assert_eq!(
            parsed.category.as_deref(),
            Some("core-platform-integration")
        );
        assert_eq!(parsed.maturity.as_deref(), Some("preview"));
        assert_eq!(
            parsed.extension_points,
            ["cf.core.authn_resolver.plugin.v1~"]
        );
        assert_eq!(parsed.extension_point, Some(true));
        assert_eq!(parsed.is_plugin, Some(false));
        assert_eq!(parsed.implements, None);
    }

    #[test]
    fn a_plugin_gdl_says_what_it_implements_under_either_name() {
        let parsed = parse_gear_gdl(
            r#"gear(
    maturity = "preview",
    package = cargo(crate_name = "cf-gears-oidc-authn-plugin", lib = "oidc_authn_plugin", path = "."),
    implements = "cf.core.authn_resolver.plugin.v1~",
    config_schema = config(exposes = ["vendor", "priority"]),
)"#,
        );
        assert_eq!(
            parsed.implements.as_deref(),
            Some("cf.core.authn_resolver.plugin.v1~")
        );
        assert_eq!(parsed.is_plugin, Some(true));
        assert_eq!(parsed.extension_point, Some(false));
        // The keyword before gearbox#2.
        let older = parse_gear_gdl(r#"gear(fills = "cf.core.x.plugin.v1~")"#);
        assert_eq!(older.implements.as_deref(), Some("cf.core.x.plugin.v1~"));
        // The engine's scaffold writes it as a comment when no host is chosen.
        let commented = parse_gear_gdl(
            "gear(\n    maturity = \"experimental\",\n    # implements = \"cf.core.x.plugin.v1~\",\n)\n",
        );
        assert_eq!(commented.implements, None);
    }

    #[test]
    fn only_the_gears_own_arguments_are_read() {
        // A nested `description` belongs to the call it sits in, and a spec
        // can be named as well as positional.
        let parsed = parse_gear_gdl(
            r#"gear(maturity = "design", id = "bss-rating",
    serves = [endpoint(name = "rest", description = "not the gear's")],
    extension_points = [extension_point(trait = "T", spec = "cf.bss.x.plugin.v1~")],
    description = "Escaped \"quotes\" stay.")"#,
        );
        assert_eq!(parsed.maturity.as_deref(), Some("design"));
        assert_eq!(
            parsed.description.as_deref(),
            Some("Escaped \"quotes\" stay.")
        );
        assert_eq!(parsed.extension_points, ["cf.bss.x.plugin.v1~"]);
    }

    #[test]
    fn the_gdl_wins_and_the_toml_fills_its_gaps() {
        let gdl = parse_gear_gdl(r#"gear(maturity = "experimental", name = "Audit Log")"#);
        let toml = parse_gear_toml(
            "[gear]\nname = \"Audit Log\"\ndescription = \"Audit trail.\"\n\
             category = \"bss\"\nis_plugin = true\n",
        );
        let merged = gdl.or(toml);
        assert_eq!(merged.description.as_deref(), Some("Audit trail."));
        assert_eq!(merged.category.as_deref(), Some("bss"));
        assert_eq!(merged.maturity.as_deref(), Some("experimental"));
        // The gdl implements nothing, and the gdl is the description.
        assert_eq!(merged.is_plugin, Some(false));
    }

    #[test]
    fn a_host_has_plugins_when_another_gear_implements_its_point() {
        let gear = |name: &str, fields: Value| RepoGear {
            crate_name: name.to_string(),
            description: None,
            source_repo: "constructorfabric/gears-rust".to_string(),
            fields,
            uml: Vec::new(),
            kind: None,
            category: None,
            payload: None,
            dir: None,
            crates: Vec::new(),
        };
        let mut gears = vec![
            gear(
                "cf-gears-authn-resolver",
                json!({"extpoint_specs": ["cf.core.authn_resolver.plugin.v1~"]}),
            ),
            gear(
                "cf-gears-oidc-authn-plugin",
                json!({"implements": "cf.core.authn_resolver.plugin.v1~"}),
            ),
            gear(
                "cf-gears-bss-ledger",
                json!({"extpoint_specs": ["cf.bss.rate_provider.plugin.v1~"]}),
            ),
            gear(
                "cf-gears-credstore",
                json!({"extpoint_specs": ["cf.core.credstore.plugin.v1~"], "plugins": {"b": "yes"}}),
            ),
            gear("cf-gears-api-gateway", json!({})),
            gear(
                "cf-gears-mini-chat",
                json!({"extpoint_specs": ["cf.core.mini_chat_audit.plugin.v1~"]}),
            ),
        ];
        attach_plugins(
            &mut gears,
            &["cf.core.mini_chat_audit.plugin.v1~".to_string()],
        );
        let plugins = |i: usize| {
            gears[i]
                .fields
                .get("plugins")
                .and_then(|v| v.get("b"))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        assert_eq!(plugins(0).as_deref(), Some("yes"));
        assert_eq!(plugins(2).as_deref(), Some("no"));
        assert_eq!(
            plugins(3).as_deref(),
            Some("yes"),
            "a gear.toml's own answer is kept"
        );
        assert_eq!(plugins(4), None, "no extension point, nothing to say");
        assert_eq!(
            plugins(5).as_deref(),
            Some("yes"),
            "a plugin compiled into the host's crate counts"
        );
    }

    #[test]
    fn a_plugin_inside_its_hosts_crate_is_found_but_is_not_a_gear() {
        let tree = gdl_tree();
        assert_eq!(
            in_crate_plugin_gdls(&tree),
            ["gears/mini-chat/mini-chat/src/infra/plugins/static_audit/gear.gdl"]
        );
    }

    #[test]
    fn a_gear_with_its_own_extension_point_is_a_host_even_when_it_implements_one() {
        // gears/bss/rate-provider/rate-provider/gear.gdl, trimmed.
        let parsed = parse_gear_gdl(
            r#"gear(maturity = "preview",
    implements = "cf.bss.rate_provider.plugin.v1~",
    extension_points = [extension_point("cf.bss.rate_provider_source.plugin.v1~", trait = "RateSource")])"#,
        );
        assert_eq!(parsed.is_plugin, Some(false));
        assert_eq!(
            parsed.implements.as_deref(),
            Some("cf.bss.rate_provider.plugin.v1~")
        );
        assert_eq!(parsed.extension_point, Some(true));
    }
}
