use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use credstore_sdk::{CredStoreClientV1, SecretRef};
use tokio::sync::RwLock;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::config::StudioSessionConfig;
use super::driver::{LaunchSpec, LocalBind, SessionAddress, SessionDriver};

const SESSION_LABEL: &str = "cf.studio.session";
const WS_LABEL: &str = "cf.studio.workspace_id";
const TENANT_LABEL: &str = "cf.studio.tenant_id";
const PORT_LABEL: &str = "cf.studio.port";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    Starting,
    Running,
    Stopped,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopped => "stopped",
        }
    }
}

/// One workspace source: a git repository cloned on first launch, or a
/// backend-host folder bind-mounted into the workspace.
#[derive(Debug, Clone)]
pub struct RepoSpec {
    /// Directory name under /workspace — `[a-z0-9_-]+`.
    pub name: String,
    pub kind: RepoKind,
    /// Clone URL (kind = Git).
    pub url: Option<String>,
    /// Host directory (kind = Local).
    pub path: Option<String>,
    /// Mount/clone target relative to the workspace root (defaults to
    /// `name`). Lets a live working copy shadow a materialized source,
    /// e.g. `.workspace-sources/hypotheses/csh_hypotheses_back`.
    pub target: Option<String>,
    pub branch: Option<String>,
    /// Resolved PAT (kind = Git, private repos). Never persisted.
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoKind {
    Git,
    Local,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub tenant_id: Uuid,
    /// Driver handle: container id (Docker) or Pod name (Kubernetes).
    pub handle: String,
    /// Where the driver exposes this session.
    pub address: SessionAddress,
    pub state: SessionState,
    pub created_at_epoch_secs: u64,
    /// Human-readable source summaries, e.g. "docs (git)".
    pub sources: Vec<String>,
    /// Per-session access token: the in-container gate only serves requests
    /// carrying it (first visit `?token=…` → HttpOnly cookie). Scoped to
    /// this one session; NOT the caller's platform token. Empty for
    /// sessions adopted from an older image (gate disabled there anyway).
    pub session_token: String,
}

pub struct SessionService {
    cfg: StudioSessionConfig,
    driver: Arc<dyn SessionDriver>,
    sessions: RwLock<HashMap<Uuid, Session>>,
    /// Resolves repo access tokens (PATs) stored as credstore secrets.
    credstore: RwLock<Option<Arc<dyn CredStoreClientV1>>>,
    /// Wakes the background image keeper (see [`Self::image_keeper`]) for a
    /// refresh pull. Launch requests never pull inline: a registry pull of a
    /// ~1.5 GB image takes minutes and the gateway deadline is 30 s.
    pull_notify: tokio::sync::Notify,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl SessionService {
    pub fn new(cfg: StudioSessionConfig, driver: Arc<dyn SessionDriver>) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            driver,
            sessions: RwLock::new(HashMap::new()),
            credstore: RwLock::new(None),
            pull_notify: tokio::sync::Notify::new(),
        })
    }

    pub async fn set_credstore(&self, client: Arc<dyn CredStoreClientV1>) {
        *self.credstore.write().await = Some(client);
    }

    /// Resolve a UTF-8 secret from credstore (tenant-scoped by ctx). Used
    /// for repo access tokens and for the agent provider keys below.
    /// Missing/inaccessible secret is an error: a private clone would fail
    /// later with a far less helpful message.
    pub async fn resolve_git_token(
        &self,
        ctx: &SecurityContext,
        token_ref: &str,
    ) -> anyhow::Result<String> {
        let guard = self.credstore.read().await;
        let client = guard
            .as_ref()
            .ok_or_else(|| anyhow!("credstore client not wired"))?;
        let key = SecretRef::new(token_ref).map_err(|e| anyhow!("bad token_ref: {e}"))?;
        let secret = client
            .get(ctx, &key)
            .await
            .map_err(|e| anyhow!("credstore error: {e}"))?
            .ok_or_else(|| anyhow!("secret '{token_ref}' not found or not accessible"))?;
        String::from_utf8(secret.value.as_bytes().to_vec())
            .map_err(|_| anyhow!("secret '{token_ref}' is not valid UTF-8"))
    }

    /// Provider keys for the session container, read from credstore under
    /// the caller's identity. Best-effort by design: a reference that is
    /// absent or unreadable is logged and skipped, because a workspace
    /// without an Anthropic key should still get an IDE (and a working
    /// Codex agent), just without that one provider.
    async fn agent_env(&self, ctx: &SecurityContext) -> Vec<String> {
        let mut out = Vec::new();
        for spec in &self.cfg.agent_secrets {
            match self.resolve_git_token(ctx, &spec.secret_ref).await {
                Ok(value) if !value.trim().is_empty() => {
                    tracing::info!(
                        env = %spec.env,
                        reference = %spec.secret_ref,
                        "studio-session: agent key provisioned into the session"
                    );
                    out.push(format!("{}={}", spec.env, value.trim()));
                }
                Ok(_) => tracing::warn!(
                    env = %spec.env,
                    reference = %spec.secret_ref,
                    "studio-session: agent key is empty — agent stays unauthenticated"
                ),
                Err(e) => tracing::warn!(
                    env = %spec.env,
                    reference = %spec.secret_ref,
                    "studio-session: agent key unavailable ({e}) — agent stays unauthenticated"
                ),
            }
        }
        out
    }

    /// The URL the portal opens for a session, from its driver address.
    /// Loopback (Docker): the published host port directly. Service
    /// (Kubernetes): the backend's authenticated proxy path — the browser
    /// never reaches the Pod except through a token check.
    pub fn session_url(&self, session: &Session) -> String {
        match &session.address {
            SessionAddress::Loopback { port } => {
                format!("http://{}:{port}/", self.cfg.public_host)
            }
            SessionAddress::Service { .. } => {
                format!("/studio/{}/", session.id)
            }
        }
    }

    /// Background image keeper: refreshes the session image at boot and on
    /// demand (`pull_notify`, fired after each launch when `always_pull` — the
    /// CURRENT launch uses the local copy, the NEXT one gets the refreshed
    /// mutable tag). Retries every 30 s while the image is absent. Launch
    /// requests never wait on this: a multi-minute pull inside a request would
    /// trip the 30 s gateway deadline (HTTP 504). A no-op for drivers whose
    /// runtime pulls images itself (Kubernetes).
    pub async fn image_keeper(svc: Arc<Self>) {
        loop {
            let present = svc.driver.image_present().await;
            tracing::info!(image = %svc.cfg.image, refresh = present, "studio-session: refreshing session image");
            match svc.driver.refresh_image().await {
                Ok(()) => {
                    tracing::info!(image = %svc.cfg.image, "studio-session: image up to date");
                }
                Err(e) if present => {
                    tracing::warn!(
                        image = %svc.cfg.image,
                        "studio-session: refresh failed ({e}) — the local copy stays in use"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        image = %svc.cfg.image,
                        "studio-session: image not available yet ({e}) — retrying in 30s. For the \
                         private ghcr image set STUDIO_REGISTRY_USER + STUDIO_REGISTRY_TOKEN \
                         (PAT with read:packages), or pull once manually (docker pull), or \
                         build locally (theia/)"
                    );
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
            }
            // Image usable — sleep until a launch asks for a refresh.
            svc.pull_notify.notified().await;
        }
    }

    /// Launch-path image check: instant, never pulls inline. A missing image
    /// means the keeper is still downloading — tell the user to retry.
    pub async fn ensure_image(&self) -> anyhow::Result<()> {
        if self.driver.image_present().await {
            if self.cfg.always_pull {
                // Freshness for the NEXT launch; this one starts immediately.
                self.pull_notify.notify_one();
            }
            return Ok(());
        }
        self.pull_notify.notify_one();
        Err(anyhow!(
            "the IDE image '{}' is still being downloaded in the background \
             (first run after boot) — retry the launch in a minute; progress \
             is logged by studio-session",
            self.cfg.image
        ))
    }

    /// Create (or return the existing) session for a workspace.
    /// Idempotency key: (tenant, workspace).
    ///
    /// The workspace root is always the managed per-workspace directory;
    /// `repos` are its *sources*: local ones are bind-mounted as
    /// `/workspace/<name>`, git ones are cloned there by the entrypoint on
    /// first launch. The gear materializes the canonical
    /// `.cf-workspace.toml` (`[sources.<id>]`, the format the Theia Studio
    /// extension owns) unless the file already exists.
    /// `root_path`: an existing Studio workspace folder on the backend host
    /// (e.g. created by the Studio CLI, with its own `.cf-workspace.toml`)
    /// mounted as /workspace INSTEAD of the managed directory. The gear
    /// never writes into such a root unless the manifest is missing.
    /// `root_repo`: clone URL of the workspace repository itself (a Studio
    /// workspace created by the CLI is a git repo: manifest, docs, and
    /// `.workspace-sources/` for its sources). Cloned into the managed
    /// directory on first launch; `root_path` takes precedence when both are
    /// given.
    pub async fn create(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        root_path: Option<String>,
        root_repo: Option<RepoSpec>,
        repos: Vec<RepoSpec>,
    ) -> anyhow::Result<(Session, bool /* already_existed */)> {
        // Both come from the caller's context — passing them separately
        // only invites a mismatch between the identity we authorize with
        // and the one we record.
        let tenant_id = ctx.subject_tenant_id();
        let actor_id = ctx.subject_id();
        {
            let existing = {
                let sessions = self.sessions.read().await;
                sessions
                    .values()
                    .find(|s| {
                        s.workspace_id == workspace_id
                            && s.tenant_id == tenant_id
                            && s.state != SessionState::Stopped
                    })
                    .cloned()
            };
            if let Some(existing) = existing {
                // Reuse only when the runtime is actually alive. It may have
                // been removed out-of-band (docker rm -f, host cleanup) while
                // the in-memory registry still lists the session — reusing then
                // hands the portal a dead address.
                if self.driver.is_running(&existing.handle).await {
                    return Ok((existing, true));
                }
                tracing::warn!(
                    session_id = %existing.id,
                    handle = %existing.handle,
                    "studio-session: registered session has no live runtime — discarding it and launching fresh"
                );
                self.sessions.write().await.remove(&existing.id);
            }
        }

        self.ensure_image().await?;

        // Validate sources: sane unique names; local paths must exist.
        let mut seen = std::collections::HashSet::new();
        for r in &repos {
            if r.name.is_empty()
                || !r
                    .name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
            {
                return Err(anyhow!("source name '{}' must match [a-z0-9_-]+", r.name));
            }
            if !seen.insert(r.name.clone()) {
                return Err(anyhow!("duplicate source name '{}'", r.name));
            }
            if let Some(t) = r.target.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                let ok = !t.starts_with('/')
                    && t.split('/').all(|seg| {
                        !seg.is_empty()
                            && seg != ".."
                            && seg
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                    });
                if !ok {
                    return Err(anyhow!(
                        "source '{}': target '{t}' must be a relative path without '..'",
                        r.name
                    ));
                }
            }
            match r.kind {
                RepoKind::Local => {
                    let p = r.path.as_deref().unwrap_or("").trim();
                    if !std::path::Path::new(p).is_dir() {
                        return Err(anyhow!(
                            "source '{}': path '{p}' is not a directory on the backend host \
                             (for WSL use /mnt/c/... style paths)",
                            r.name
                        ));
                    }
                }
                RepoKind::Git => {
                    if r.url.as_deref().unwrap_or("").trim().is_empty() {
                        return Err(anyhow!("source '{}': git source needs a url", r.name));
                    }
                }
            }
        }

        // Workspace root: an existing Studio workspace folder (CLI-created,
        // bring-your-own) or the managed per-workspace directory.
        let ws_dir = match root_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            Some(p) => {
                if !std::path::Path::new(p).is_dir() {
                    return Err(anyhow!(
                        "root_path '{p}' is not a directory on the backend host \
                         (for WSL use /mnt/c/... style paths)"
                    ));
                }
                p.to_string()
            }
            None => {
                let root = self.cfg.workspaces_root_expanded();
                let dir = format!("{root}/{workspace_id}");
                std::fs::create_dir_all(&dir)
                    .with_context(|| format!("cannot create workspace dir {dir}"))?;
                dir
            }
        };
        // A workspace backed by its own repository owns its manifest — never
        // write a stub next to it (a generated stub is exactly what used to
        // make the directory non-empty and block the clone; the entrypoint
        // now adopts the repo either way, but the stub would still shadow the
        // real file until the first checkout).
        // A managed workspace (no bring-your-own folder, no root repo) is ours
        // to keep tidy: rewrite the manifest to exactly the current sources and
        // delete any stale source clones left behind by previously-detached
        // sources, so the IDE's Source Control only shows what the project
        // selects. A bring-your-own folder is never rewritten or pruned.
        let managed = root_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .is_none();
        if root_repo.is_none() {
            if managed {
                self.rewrite_workspace_toml(&ws_dir, &repos)?;
                self.prune_stale_sources(&ws_dir, &repos);
            } else {
                // No-op when .cf-workspace.toml already exists (CLI workspaces).
                self.materialize_workspace_toml(&ws_dir, &repos)?;
            }
        }

        let port = self.allocate_port().await?;
        let session_id = Uuid::new_v4();
        let name = format!("cf-studio-session-{workspace_id}");

        // Session gate token: random 256-bit, hex. The container's entry
        // proxy refuses requests without it, so a guessed/leaked address on
        // the loopback no longer means a free IDE.
        let session_token = {
            let a = Uuid::new_v4().simple().to_string();
            let b = Uuid::new_v4().simple().to_string();
            format!("{a}{b}")
        };

        let mut env = vec![
            format!("STUDIO_WORKSPACE_ID={workspace_id}"),
            format!("STUDIO_ACTOR_ID={actor_id}"),
            format!("STUDIO_GIT_MODE={}", self.cfg.git_mode),
            format!("STUDIO_SESSION_TOKEN={session_token}"),
            // Gateway URL as seen FROM the container — the session gate
            // proxies /studio-api/* here so the IDE frontend can call the
            // gears same-origin (no CORS, no token storage server-side).
            // The /cf path is the api-gateway prefix_path: the gate prepends
            // it when forwarding, so in-IDE clients use gateway-rooted paths.
            "STUDIO_GATEWAY_URL=http://host.docker.internal:8090/cf".to_string(),
        ];
        // Provider keys for the native Theia agents (Codex, Claude Code).
        env.extend(self.agent_env(ctx).await);
        // Workspace root repository (cloned by the entrypoint into an empty
        // /workspace on first launch).
        if let Some(root) = &root_repo {
            env.push(format!(
                "STUDIO_ROOT_URL={}",
                root.url.as_deref().unwrap_or("").trim()
            ));
            if let Some(b) = root
                .branch
                .as_deref()
                .map(str::trim)
                .filter(|b| !b.is_empty())
            {
                env.push(format!("STUDIO_ROOT_BRANCH={b}"));
            }
            if let Some(t) = &root.token {
                env.push(format!("STUDIO_ROOT_TOKEN={t}"));
            }
        }
        // Git sources for the entrypoint to clone (JSON; tokens included —
        // env-only, never persisted in the registry or the toml).
        let git_sources: Vec<serde_json::Value> = repos
            .iter()
            .filter(|r| r.kind == RepoKind::Git)
            .map(|r| {
                serde_json::json!({
                    "name": r.name,
                    "dir": r.target.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(&r.name),
                    "url": r.url.as_deref().unwrap_or("").trim(),
                    "branch": r.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()),
                    "token": r.token,
                })
            })
            .collect();
        if !git_sources.is_empty() {
            env.push(format!(
                "STUDIO_SOURCES={}",
                serde_json::Value::Array(git_sources)
            ));
        }

        let labels: HashMap<String, String> = HashMap::from([
            (SESSION_LABEL.into(), "1".into()),
            (WS_LABEL.into(), workspace_id.to_string()),
            (TENANT_LABEL.into(), tenant_id.to_string()),
            (PORT_LABEL.into(), port.to_string()),
        ]);

        let local_binds: Vec<LocalBind> = repos
            .iter()
            .filter(|r| r.kind == RepoKind::Local)
            .map(|r| {
                let target = r
                    .target
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .unwrap_or(&r.name);
                LocalBind {
                    host_path: r.path.as_deref().unwrap_or("").trim().to_string(),
                    target: target.to_string(),
                }
            })
            .collect();

        let spec = LaunchSpec {
            image: self.cfg.image.clone(),
            env,
            workspace_host_dir: ws_dir,
            local_binds,
            labels,
            name,
            port,
        };
        let launched = self.driver.launch(&spec).await?;

        let session = Session {
            id: session_id,
            workspace_id,
            tenant_id,
            handle: launched.handle,
            address: launched.address,
            state: SessionState::Starting,
            created_at_epoch_secs: now_secs(),
            session_token,
            sources: root_repo
                .iter()
                .map(|_| "workspace root (git)".to_string())
                .chain(repos.iter().map(|r| {
                    format!(
                        "{} ({})",
                        r.name,
                        match r.kind {
                            RepoKind::Git => "git",
                            RepoKind::Local => "local",
                        }
                    )
                }))
                .collect(),
        };
        self.sessions
            .write()
            .await
            .insert(session_id, session.clone());
        Ok((session, false))
    }

    /// Materialize the canonical `.cf-workspace.toml` (`[sources.<id>]`
    /// sections — the format owned by the Theia Studio extension's Workspace
    /// Sources). A missing file is created from scratch; an existing file
    /// (e.g. a CLI-created workspace) is APPENDED with sources it does not
    /// list yet — existing content is never modified or reordered.
    fn materialize_workspace_toml(&self, ws_dir: &str, repos: &[RepoSpec]) -> anyhow::Result<()> {
        let path = format!("{ws_dir}/.cf-workspace.toml");
        let existing = std::fs::read_to_string(&path).ok();
        let missing: Vec<&RepoSpec> = match &existing {
            Some(content) => repos
                .iter()
                .filter(|r| {
                    !content.contains(&format!("[sources.{}]", r.name))
                        && !content.contains(&format!("[sources.\"{}\"]", r.name))
                })
                .collect(),
            None => repos.iter().collect(),
        };
        if existing.is_some() && missing.is_empty() {
            return Ok(());
        }
        let mut toml = match existing {
            Some(content) => {
                let mut c = content;
                if !c.ends_with('\n') {
                    c.push('\n');
                }
                c
            }
            None => String::from("version = \"1.0\"\n"),
        };
        for r in missing {
            let target = r
                .target
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or(&r.name);
            toml.push_str(&format!("\n[sources.{}]\nrole = \"codebase\"\n", r.name));
            if r.kind == RepoKind::Git {
                toml.push_str(&format!(
                    "url = \"{}\"\n",
                    r.url.as_deref().unwrap_or("").trim()
                ));
                if let Some(b) = r.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
                    toml.push_str(&format!("branch = \"{b}\"\n"));
                }
            }
            // Cloned by the entrypoint / bind-mounted by the session manager.
            toml.push_str(&format!("path = \"{target}\"\n"));
        }
        std::fs::write(&path, toml).with_context(|| format!("cannot write {path}"))?;
        Ok(())
    }

    /// Rewrite `.cf-workspace.toml` to exactly the current sources (managed
    /// workspaces only). Authoritative: a source detached in the portal is
    /// dropped here, so the Theia Workspace Sources panel stops listing it.
    fn rewrite_workspace_toml(&self, ws_dir: &str, repos: &[RepoSpec]) -> anyhow::Result<()> {
        let path = format!("{ws_dir}/.cf-workspace.toml");
        let mut toml = String::from("version = \"1.0\"\n");
        for r in repos {
            let target = r
                .target
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or(&r.name);
            toml.push_str(&format!("\n[sources.{}]\nrole = \"codebase\"\n", r.name));
            if r.kind == RepoKind::Git {
                toml.push_str(&format!(
                    "url = \"{}\"\n",
                    r.url.as_deref().unwrap_or("").trim()
                ));
                if let Some(b) = r.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
                    toml.push_str(&format!("branch = \"{b}\"\n"));
                }
            }
            toml.push_str(&format!("path = \"{target}\"\n"));
        }
        std::fs::write(&path, toml).with_context(|| format!("cannot write {path}"))?;
        Ok(())
    }

    /// Delete source clones in a managed workspace that no longer belong to any
    /// current source — the "junk" the IDE's Source Control was showing. Only
    /// top-level directories that are actual git clones (`.git` present) and are
    /// not a current source are removed; dotfiles and non-repo content are left
    /// untouched. Best-effort: a failure to remove one is logged, not fatal.
    fn prune_stale_sources(&self, ws_dir: &str, repos: &[RepoSpec]) {
        let mut expected: std::collections::HashSet<String> = std::collections::HashSet::new();
        for r in repos {
            let dir = r
                .target
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or(&r.name);
            // The first path segment is the top-level dir under the workspace.
            if let Some(top) = dir.split('/').next().filter(|s| !s.is_empty()) {
                expected.insert(top.to_string());
            }
        }
        let base = std::path::Path::new(ws_dir);
        let read = match std::fs::read_dir(base) {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut removed: Vec<String> = Vec::new();
        for entry in read.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with('.') {
                continue; // .git of a root repo, .cf-workspace.toml, dotdirs
            }
            if !path.is_dir() || expected.contains(&name) {
                continue;
            }
            // Only prune actual clones — never arbitrary content the user made.
            if !path.join(".git").exists() {
                continue;
            }
            match std::fs::remove_dir_all(&path) {
                Ok(()) => removed.push(name),
                Err(e) => tracing::warn!(
                    dir = %path.display(),
                    error = %e,
                    "studio-session: could not remove stale source clone"
                ),
            }
        }
        if !removed.is_empty() {
            tracing::info!(
                removed = ?removed,
                workspace_dir = %ws_dir,
                "studio-session: removed stale source clones from the workspace"
            );
        }
    }

    /// Refresh state: Starting → Running once the session port accepts a
    /// connection (driver probe).
    pub async fn get(&self, tenant_id: Uuid, id: Uuid) -> Option<Session> {
        // Read the address under a short read lock, probe without the lock,
        // then commit the transition under a write lock. Holding the write
        // lock across the network probe would serialize every GET.
        let (state, address) = {
            let sessions = self.sessions.read().await;
            let session = sessions.get(&id)?;
            if session.tenant_id != tenant_id {
                return None; // tenant isolation: not yours == not found
            }
            (session.state.clone(), session.address.clone())
        };
        if state == SessionState::Starting && self.driver.is_reachable(&address).await {
            let mut sessions = self.sessions.write().await;
            if let Some(s) = sessions.get_mut(&id) {
                if s.state == SessionState::Starting {
                    s.state = SessionState::Running;
                }
                return Some(s.clone());
            }
            return None;
        }
        let sessions = self.sessions.read().await;
        sessions
            .get(&id)
            .filter(|s| s.tenant_id == tenant_id)
            .cloned()
    }

    /// Proxy lookup by session id ALONE. The browser opens the IDE in an
    /// iframe and cannot carry the caller's platform token, so the tenant
    /// check the REST API does is impossible here — the per-session gate token
    /// (256-bit, handed only to the owner by the create call, enforced by the
    /// session container's own entry gate) is the capability instead. This
    /// returns just the driver address to proxy to.
    pub async fn proxy_target(&self, id: Uuid) -> Option<SessionAddress> {
        self.sessions
            .read()
            .await
            .get(&id)
            .map(|s| s.address.clone())
    }

    pub async fn list(&self, tenant_id: Uuid) -> Vec<Session> {
        self.sessions
            .read()
            .await
            .values()
            .filter(|s| s.tenant_id == tenant_id)
            .cloned()
            .collect()
    }

    pub async fn stop(&self, tenant_id: Uuid, id: Uuid) -> anyhow::Result<bool> {
        let session = {
            let sessions = self.sessions.read().await;
            match sessions.get(&id) {
                Some(s) if s.tenant_id == tenant_id => s.clone(),
                _ => return Ok(false),
            }
        };
        self.driver.destroy(&session.handle).await?;
        self.sessions.write().await.remove(&id);
        Ok(true)
    }

    /// Next free port in the configured range (not used by known sessions).
    /// Only the Docker driver publishes it; the Kubernetes driver targets the
    /// fixed in-container port and ignores the value.
    async fn allocate_port(&self) -> anyhow::Result<u16> {
        let sessions = self.sessions.read().await;
        let used: Vec<u16> = sessions
            .values()
            .filter_map(|s| match &s.address {
                SessionAddress::Loopback { port } => Some(*port),
                SessionAddress::Service { .. } => None,
            })
            .collect();
        (self.cfg.port_range_start..=self.cfg.port_range_end)
            .find(|p| !used.contains(p))
            .ok_or_else(|| anyhow!("no free session ports in the configured range"))
    }

    /// Adopt sessions left over from a previous backend run, so a restart
    /// does not orphan running IDE sessions.
    pub async fn adopt_existing(&self) -> anyhow::Result<usize> {
        let adopted = self.driver.list_adoptable().await?;
        let mut sessions = self.sessions.write().await;
        let mut count = 0;
        for a in adopted {
            let id = Uuid::new_v4();
            sessions.insert(
                id,
                Session {
                    id,
                    workspace_id: a.workspace_id,
                    tenant_id: a.tenant_id,
                    handle: a.handle,
                    address: a.address,
                    state: if a.running {
                        SessionState::Running
                    } else {
                        SessionState::Stopped
                    },
                    created_at_epoch_secs: if a.created_at_epoch_secs == 0 {
                        now_secs()
                    } else {
                        a.created_at_epoch_secs
                    },
                    sources: Vec::new(),
                    session_token: a.session_token,
                },
            );
            count += 1;
        }
        Ok(count)
    }

    /// Reaper pass: stop sessions past max_session_secs. Returns reaped count.
    pub async fn reap_expired(&self) -> usize {
        if self.cfg.max_session_secs == 0 {
            return 0;
        }
        let cutoff = now_secs().saturating_sub(self.cfg.max_session_secs);
        let expired: Vec<Session> = self
            .sessions
            .read()
            .await
            .values()
            .filter(|s| s.created_at_epoch_secs < cutoff && s.state != SessionState::Stopped)
            .cloned()
            .collect();
        let mut reaped = 0;
        for s in expired {
            if self.driver.destroy(&s.handle).await.is_ok() {
                self.sessions.write().await.remove(&s.id);
                reaped += 1;
            }
        }
        reaped
    }
}
