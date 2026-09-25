use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use account_management_sdk::AccountManagementClient;
use anyhow::{Context, anyhow};
use credstore_sdk::{CredStoreClientV1, SecretRef};
use tokio::sync::RwLock;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::access::{NotReachable, WorkspaceAccess};
use super::config::StudioSessionConfig;
use super::driver::{AdoptedSession, LaunchSpec, LocalBind, SessionAddress, SessionDriver};

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

/// What one reaping pass did. Reported as a `session.reap` run's summary, so
/// "nothing expired" and "three stopped, one refused" are told apart in the
/// history rather than only in a log line.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
pub struct ReapOutcome {
    /// Sessions the runtime showed as past their maximum age.
    #[serde(default)]
    pub expired: usize,
    #[serde(default)]
    pub stopped: usize,
    /// Ones the driver refused to stop. They stay, and the next pass tries
    /// again.
    #[serde(default)]
    pub failed: usize,
}

/// UUIDv5 namespace for a session's deterministic id.
const SESSION_NS: Uuid = Uuid::from_u128(0x4a1e_63b8_0d57_4c92_8f3a_e05d_71c4_9b26);

/// The id of the session for a workspace.
///
/// Derived rather than drawn at random, because the workspace already
/// identifies the session: the service admits one live session per workspace,
/// and the runtime names it after the workspace too
/// (`cf-studio-session-<workspace>`). A random id was a third name for the
/// same thing, and one that only the process which drew it knew — a restart
/// re-drew it on adoption, and a second replica would draw a different one for
/// the same container. Deriving it means every process, before or after a
/// restart, calls that session by the same name.
pub fn session_id_for(workspace_id: Uuid) -> Uuid {
    Uuid::new_v5(&SESSION_NS, workspace_id.as_bytes())
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
    /// Per-session S2S control token for the Theia backend bridge (ADR-0010).
    /// Minted only when `theia_control_enabled`; empty otherwise and for
    /// adopted sessions. Never handed to the browser — distinct from
    /// `session_token`.
    pub control_token: String,
}

/// What the runtime last said its sessions were, and when it said it.
///
/// This is a cache, not a registry. The Docker daemon and the Kubernetes API
/// are what know which sessions exist — they create them, they outlive this
/// process, and they are the same answer for every replica. Keeping a copy
/// here only spares the IDE proxy a driver call per request.
#[derive(Default)]
struct SessionCache {
    /// `None` until the first listing: an empty map and "never asked" are
    /// different answers, and only the second one must go and ask.
    listed_at: Option<Instant>,
    by_id: HashMap<Uuid, Session>,
}

pub struct SessionService {
    cfg: StudioSessionConfig,
    driver: Arc<dyn SessionDriver>,
    sessions: RwLock<SessionCache>,
    /// Resolves repo access tokens (PATs) stored as credstore secrets.
    credstore: RwLock<Option<Arc<dyn CredStoreClientV1>>>,
    /// Reads the caller's IdP record, for a session's commit authorship.
    /// Wired the same way and just as optionally as `credstore`: a backend
    /// without it still launches sessions, their commits just keep the
    /// product's name.
    account_management: RwLock<Option<Arc<dyn AccountManagementClient>>>,
    /// Answers whether a caller reaches a workspace at all. Wired from the same
    /// account-management client beside it, behind a trait so the rule can be
    /// tested without one (see `access.rs`). `None` means unwired, and an
    /// authorization question nobody can answer is refused rather than waved
    /// through.
    access: RwLock<Option<Arc<dyn WorkspaceAccess>>>,
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
            sessions: RwLock::new(SessionCache::default()),
            credstore: RwLock::new(None),
            account_management: RwLock::new(None),
            access: RwLock::new(None),
            pull_notify: tokio::sync::Notify::new(),
        })
    }

    /// Every session the runtime has, keyed by id.
    ///
    /// Asks the driver when the cached listing is older than
    /// `registry_ttl_secs`, and otherwise hands back what it already had.
    /// A driver that cannot be listed leaves the previous answer standing:
    /// a momentary API hiccup should not make live sessions disappear from
    /// the portal, and the next read tries again.
    async fn snapshot(&self) -> HashMap<Uuid, Session> {
        let ttl = Duration::from_secs(self.cfg.registry_ttl_secs);
        {
            let cache = self.sessions.read().await;
            if let Some(listed_at) = cache.listed_at
                && listed_at.elapsed() < ttl
            {
                return cache.by_id.clone();
            }
        }
        match self.refresh().await {
            Ok(sessions) => sessions,
            Err(e) => {
                tracing::warn!(
                    "studio-session: cannot list the runtime's sessions ({e:#}) — \
                     serving the last listing"
                );
                self.sessions.read().await.by_id.clone()
            }
        }
    }

    /// Re-read the sessions from the runtime, replacing the cache.
    ///
    /// The runtime decides what exists: anything it does not list is gone from
    /// the cache, whoever put it there. Only `Running` is carried over, and
    /// only for a session the runtime still has — that state is not the
    /// runtime's to report (a Pod is `Running` well before Theia accepts a
    /// connection), so it is established once by the reachability probe in
    /// [`Self::get`] and would otherwise flap back to `Starting` on every
    /// refresh.
    async fn refresh(&self) -> anyhow::Result<HashMap<Uuid, Session>> {
        let listed = self.driver.list_adoptable().await?;
        let mut cache = self.sessions.write().await;
        let previous = std::mem::take(&mut cache.by_id);

        cache.by_id = listed
            .into_iter()
            .map(|a| {
                let id = session_id_for(a.workspace_id);
                let was_running = previous
                    .get(&id)
                    .is_some_and(|p| p.state == SessionState::Running);
                let session = Session {
                    id,
                    workspace_id: a.workspace_id,
                    tenant_id: a.tenant_id,
                    handle: a.handle,
                    address: a.address,
                    state: match (a.running, was_running) {
                        (false, _) => SessionState::Stopped,
                        (true, true) => SessionState::Running,
                        (true, false) => SessionState::Starting,
                    },
                    created_at_epoch_secs: if a.created_at_epoch_secs == 0 {
                        now_secs()
                    } else {
                        a.created_at_epoch_secs
                    },
                    sources: a.sources,
                    session_token: a.session_token,
                    control_token: a.control_token,
                };
                (id, session)
            })
            .collect();
        cache.listed_at = Some(Instant::now());
        Ok(cache.by_id.clone())
    }

    /// Put a session into the cache without waiting for the next listing.
    ///
    /// Used right after a launch: the caller is told the session exists, so
    /// the very next read must agree, and `Starting` is a state the runtime
    /// cannot report anyway.
    async fn cache_put(&self, session: Session) {
        self.sessions
            .write()
            .await
            .by_id
            .insert(session.id, session);
    }

    /// Drop a session from the cache after its runtime is destroyed, so a
    /// listing that is still inside its TTL does not resurrect it.
    async fn cache_forget(&self, id: Uuid) {
        self.sessions.write().await.by_id.remove(&id);
    }

    pub async fn set_credstore(&self, client: Arc<dyn CredStoreClientV1>) {
        *self.credstore.write().await = Some(client);
    }

    pub async fn set_workspace_access(&self, access: Arc<dyn WorkspaceAccess>) {
        *self.access.write().await = Some(access);
    }

    /// May this caller reach this workspace?
    ///
    /// The one question every surface here asks, and the reason `access.rs`
    /// exists — read its header for what this replaced and what that cost.
    ///
    /// FAILS CLOSED. The account-management client this is wired from is
    /// optional in `gear.rs` because commit attribution can do without it; an
    /// authorization guard cannot. An assembly that did not wire it refuses
    /// sessions rather than hands them out unchecked, and says which of the two
    /// it is rather than failing silently.
    pub async fn may_reach(&self, ctx: &SecurityContext, workspace_id: Uuid) -> bool {
        // Cloned out of the lock: the answer is a call into another gear and
        // must not hold this one's read guard while it waits.
        let access = {
            let guard = self.access.read().await;
            guard.as_ref().map(Arc::clone)
        };
        match access {
            Some(access) => access.may_reach(ctx, workspace_id).await,
            None => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    "studio-session: no workspace-access client wired — refusing, because an unanswerable authorization question is not a yes"
                );
                false
            }
        }
    }

    pub async fn set_account_management(&self, client: Arc<dyn AccountManagementClient>) {
        *self.account_management.write().await = Some(client);
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

    /// Where a session's agents reach their models: Studio's provider proxy,
    /// under the gateway as the container sees it (ADR-0030). No key: each
    /// window hands its agents its own person's token, and the proxy answers
    /// with that person's key. `STUDIO_LLM_AUTH=bearer` is what the patched
    /// Claude Code and Codex services read to send that token as a bearer.
    fn agent_proxy_env(&self) -> Vec<String> {
        let gateway = self.cfg.gateway_url.trim_end_matches('/');
        vec![
            "STUDIO_LLM_AUTH=bearer".to_owned(),
            format!("ANTHROPIC_BASE_URL={gateway}/studio-llm/v1/providers/anthropic"),
            format!("OPENAI_BASE_URL={gateway}/studio-llm/v1/providers/openai"),
        ]
    }

    /// Provider keys for the session container, read from credstore under
    /// the caller's identity. Best-effort by design: a reference that is
    /// absent or unreadable is logged and skipped, because a workspace
    /// without an Anthropic key should still get an IDE (and a working
    /// Codex agent), just without that one provider.
    ///
    /// No longer called at launch (ADR-0030): a shared container must not
    /// carry one person's keys. Kept for the one-person desktop and for the
    /// connection-scoped path that replaces it.
    #[allow(dead_code)]
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

    /// Commit authorship for a session, read from the caller's IdP record.
    ///
    /// Without it the entrypoint falls back to `Constructor Studio
    /// <studio@constructor.tech>`, so every commit from every session is
    /// authored by the product rather than by the person who made it — and a
    /// repository that insists on a real author (a DCO check, say) rejects the
    /// result. Pushes are already attributed, because the token is the
    /// caller's; the commit was the half still missing.
    ///
    /// Best-effort, like [`Self::agent_env`]: a service account, a lookup that
    /// fails, or a user with no email address leaves that fallback in place
    /// rather than failing the launch — a session must still start, and the
    /// person can always set both in its own git config.
    ///
    /// No longer called at launch (ADR-0030): in a shared container it made
    /// every member's commits the launcher's. The author has to come from the
    /// connection that commits; this is what that lookup will reuse.
    #[allow(dead_code)]
    async fn git_identity_env(&self, ctx: &SecurityContext) -> Vec<String> {
        // A service account has no IdP user record to read.
        if let Some(kind) = ctx.subject_type()
            && kind != "user"
        {
            return Vec::new();
        }
        // Cloned out of the lock: the lookup below is a call into another
        // gear and must not hold this one's read guard while it waits.
        let client = {
            let guard = self.account_management.read().await;
            match guard.as_ref() {
                Some(client) => Arc::clone(client),
                None => {
                    tracing::warn!(
                        "studio-session: account-management client unwired — \
                         session commits stay unattributed"
                    );
                    return Vec::new();
                }
            }
        };
        let user = match client
            .get_user(ctx, ctx.subject_tenant_id(), ctx.subject_id())
            .await
        {
            Ok(user) => user,
            Err(e) => {
                tracing::warn!(
                    "studio-session: cannot read the caller's user record ({e}) — \
                     session commits stay unattributed"
                );
                return Vec::new();
            }
        };
        let email = user
            .email
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty());
        let Some(email) = email else {
            tracing::warn!(
                "studio-session: the caller has no email address — \
                 session commits stay unattributed"
            );
            return Vec::new();
        };
        let name = git_author_name(
            user.display_name.as_deref(),
            user.first_name.as_deref(),
            user.last_name.as_deref(),
            &user.username,
        );
        if name.is_empty() {
            tracing::warn!(
                "studio-session: the caller has no usable name — \
                 session commits stay unattributed"
            );
            return Vec::new();
        }
        vec![
            format!("STUDIO_GIT_AUTHOR_NAME={name}"),
            format!("STUDIO_GIT_AUTHOR_EMAIL={email}"),
        ]
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
        // Before anything is read or launched: this is the whole access
        // decision, and it is about the WORKSPACE (see `access.rs`).
        if !self.may_reach(ctx, workspace_id).await {
            return Err(NotReachable { workspace_id }.into());
        }
        {
            // Keyed by the workspace ALONE, because that is what a session is
            // keyed by everywhere else that decides: `session_id_for` derives
            // its id from the workspace, the runtime names the Pod
            // `cf-studio-session-<workspace>`, and this endpoint's own contract
            // says "idempotent per workspace". Adding the caller's tenant here
            // never isolated two sessions — one name admits one Pod — it only
            // ever missed a live one and sent the driver off to destroy it.
            let existing = self
                .snapshot()
                .await
                .into_values()
                .find(|s| s.workspace_id == workspace_id && s.state != SessionState::Stopped);
            if let Some(existing) = existing {
                // Reuse only when the runtime is actually alive. The listing
                // can be up to `registry_ttl_secs` old, and a container removed
                // out of band (docker rm -f, host cleanup) is still in it —
                // reusing then hands the portal a dead address.
                if self.driver.is_running(&existing.handle).await {
                    return Ok((existing, true));
                }
                tracing::warn!(
                    session_id = %existing.id,
                    handle = %existing.handle,
                    "studio-session: listed session has no live runtime — discarding it and launching fresh"
                );
                self.cache_forget(existing.id).await;
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
        let session_id = session_id_for(workspace_id);
        let name = format!("cf-studio-session-{workspace_id}");

        // Session gate token: random 256-bit, hex. The container's entry
        // proxy refuses requests without it, so a guessed/leaked address on
        // the loopback no longer means a free IDE.
        let session_token = {
            let a = Uuid::new_v4().simple().to_string();
            let b = Uuid::new_v4().simple().to_string();
            format!("{a}{b}")
        };
        // Distinct per-session token for the Theia backend-control bridge
        // (ADR-0010). Only minted when the bridge is enabled; empty otherwise.
        let control_token = if self.cfg.theia_control_enabled {
            let a = Uuid::new_v4().simple().to_string();
            let b = Uuid::new_v4().simple().to_string();
            format!("{a}{b}")
        } else {
            String::new()
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
            format!("STUDIO_GATEWAY_URL={}", self.cfg.gateway_url),
        ];
        if managed && root_repo.is_none() {
            // Kubernetes gives the IDE Pod a fresh /workspace emptyDir. Tell
            // the entrypoint to materialize the canonical, token-free source
            // manifest from STUDIO_SOURCES inside that runtime filesystem.
            env.push("STUDIO_MANAGED_WORKSPACE=1".to_string());
        }
        // Hand the container its S2S control token so the Theia node can
        // authenticate studio-backend's control calls (ADR-0010).
        if self.cfg.theia_control_enabled {
            env.push(format!("STUDIO_THEIA_S2S_TOKEN={control_token}"));
        }
        // Nothing personal (ADR-0030). Several people type into this container,
        // and it used to carry the launcher's provider keys (private ones
        // first) and git author, so everybody's agents and commits were the
        // launcher's. The agents now reach their models through Studio's
        // provider proxy, each window with its own person's token, and the
        // proxy uses that person's key. What goes here is only where the proxy
        // is. Commits carry the entrypoint's neutral author until the author
        // comes from the connection.
        env.extend(self.agent_proxy_env());
        // Orca runtime for the IDE's Agents panel. Container-local: the
        // entrypoint starts `orca serve` beside Theia and the panel's backend
        // shells out to `orca` in the same container, so nothing is published
        // and no pairing secret ever reaches a browser.
        if self.cfg.orca_enabled {
            env.push("STUDIO_ORCA_ENABLED=1".to_string());
            env.push(format!("STUDIO_ORCA_PORT={}", self.cfg.orca_port));
        }
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
        let launched = match self.driver.launch(&spec).await {
            Ok(launched) => launched,
            Err(e) => {
                // The runtime names a session after its workspace, so two
                // launches racing for one workspace are two attempts at one
                // name and the loser is refused (a Kubernetes 409). Whoever
                // won has a session running with its own tokens, and that is
                // the session to hand back — the ones minted here reach
                // nothing. Ask the runtime rather than trust the reason.
                if let Some(existing) = self
                    .refresh()
                    .await
                    .unwrap_or_default()
                    .into_values()
                    .find(|s| s.workspace_id == workspace_id && s.state != SessionState::Stopped)
                {
                    tracing::info!(
                        session_id = %existing.id,
                        "studio-session: launch lost a race for this workspace — \
                         reusing the session that won ({e:#})"
                    );
                    return Ok((existing, true));
                }
                return Err(e);
            }
        };

        let session = Session {
            id: session_id,
            workspace_id,
            tenant_id,
            handle: launched.handle,
            address: launched.address,
            state: SessionState::Starting,
            created_at_epoch_secs: now_secs(),
            session_token,
            control_token,
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
        self.cache_put(session.clone()).await;
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
    pub async fn get(&self, ctx: &SecurityContext, id: Uuid) -> Option<Session> {
        let workspace_id = self.snapshot().await.get(&id)?.workspace_id;
        if !self.may_reach(ctx, workspace_id).await {
            return None; // not yours == not there; saying which would say it exists
        }
        self.probe(id).await
    }

    /// A session by id with NO access decision.
    ///
    /// For the caller that cannot make one: the scheduled `await_ready` run
    /// holds a `TaskContext`, not a `SecurityContext`, and it exists only
    /// because [`Self::create`] already authorized this very launch. Everything
    /// a person reaches goes through [`Self::get`].
    pub async fn probe(&self, id: Uuid) -> Option<Session> {
        let mut session = self.snapshot().await.remove(&id)?;
        if session.state != SessionState::Starting {
            return Some(session);
        }
        // Whether the IDE is answering yet is the one thing the runtime cannot
        // tell us — a Pod is `Running` well before Theia binds — so it is
        // probed here, outside the cache lock, and remembered so the next
        // refresh keeps it (see [`Self::refresh`]).
        if !self.driver.is_reachable(&session.address).await {
            return Some(session);
        }
        session.state = SessionState::Running;
        let mut cache = self.sessions.write().await;
        match cache.by_id.get_mut(&id) {
            Some(cached) => {
                cached.state = SessionState::Running;
                Some(cached.clone())
            }
            // Destroyed while we probed. It is gone, and saying so is better
            // than re-inserting it.
            None => None,
        }
    }

    /// Proxy lookup by session id ALONE. The browser opens the IDE in an
    /// iframe and cannot carry the caller's platform token, so the tenant
    /// check the REST API does is impossible here — the per-session gate token
    /// (256-bit, handed only to the owner by the create call, enforced by the
    /// session container's own entry gate) is the capability instead. This
    /// returns just the driver address to proxy to.
    pub async fn proxy_target(&self, id: Uuid) -> Option<SessionAddress> {
        self.snapshot().await.get(&id).map(|s| s.address.clone())
    }

    /// Resolve the internal Theia control endpoint for the caller's live
    /// session on `workspace_id` (ADR-0010). `None` unless the bridge is
    /// enabled, a live session exists for this tenant+workspace, and it carries
    /// a control token. The control API is served by the Theia node on the
    /// session's own port under an internal, S2S-token-gated path (Docker MVP);
    /// a dedicated internal port / Service is the production hardening.
    #[allow(dead_code)]
    pub async fn control_endpoint(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> Option<crate::studio_session::sdk::TheiaControlEndpoint> {
        if !self.cfg.theia_control_enabled {
            return None;
        }
        if !self.may_reach(ctx, workspace_id).await {
            return None;
        }
        let session = self
            .snapshot()
            .await
            .into_values()
            .find(|s| s.workspace_id == workspace_id && s.state != SessionState::Stopped)?;
        if session.control_token.is_empty() {
            return None;
        }
        let base_url = match &session.address {
            SessionAddress::Loopback { port } => {
                format!("http://{}:{port}", self.cfg.control_reach_host)
            }
            SessionAddress::Service { host, port } => format!("http://{host}:{port}"),
        };
        Some(crate::studio_session::sdk::TheiaControlEndpoint {
            session_id: session.id,
            base_url,
            token: session.control_token.clone(),
        })
    }

    /// Reverse-resolve a per-session S2S control token to its session's
    /// trusted `(tenant, workspace)` coordinates. The token is minted per
    /// session (256 random bits, carried on `X-CFS-Theia-Token`), so this is
    /// the studio-theia ingress's authentication primitive: it bypasses
    /// `SecurityContext` because it is what mints one. `None` for an empty,
    /// unknown, stopped, or forged token, or when the bridge is disabled.
    /// (Plain `==` matches repo style; a constant-time compare is a cheap
    /// future hardening.)
    pub async fn resolve_control_token(
        &self,
        token: &str,
    ) -> Option<crate::studio_session::sdk::SessionIdentity> {
        if !self.cfg.theia_control_enabled || token.is_empty() {
            return None;
        }
        self.snapshot()
            .await
            .into_values()
            .find(|s| s.state != SessionState::Stopped && s.control_token == token)
            .map(|s| crate::studio_session::sdk::SessionIdentity {
                session_id: s.id,
                tenant_id: s.tenant_id,
                workspace_id: s.workspace_id,
            })
    }

    /// The sessions this caller reaches.
    ///
    /// One access question per session, in sequence rather than concurrently:
    /// the runtime admits one session per workspace and a namespace holds a
    /// handful, so this is a short loop, and fanning it out would trade
    /// readability for a saving nobody can measure.
    pub async fn list(&self, ctx: &SecurityContext) -> Vec<Session> {
        let mut reachable = Vec::new();
        for session in self.snapshot().await.into_values() {
            if self.may_reach(ctx, session.workspace_id).await {
                reachable.push(session);
            }
        }
        reachable
    }

    pub async fn stop(&self, ctx: &SecurityContext, id: Uuid) -> anyhow::Result<bool> {
        let Some(session) = self.snapshot().await.remove(&id) else {
            return Ok(false);
        };
        if !self.may_reach(ctx, session.workspace_id).await {
            return Ok(false); // not yours == not there, as in `get`
        }
        self.driver.destroy(&session.handle).await?;
        self.cache_forget(id).await;
        Ok(true)
    }

    /// Next free port in the configured range (not used by known sessions).
    /// Only the Docker driver publishes it; the Kubernetes driver targets the
    /// fixed in-container port and ignores the value.
    async fn allocate_port(&self) -> anyhow::Result<u16> {
        let used: Vec<u16> = self
            .snapshot()
            .await
            .into_values()
            .filter_map(|s| match s.address {
                SessionAddress::Loopback { port } => Some(port),
                SessionAddress::Service { .. } => None,
            })
            .collect();
        (self.cfg.port_range_start..=self.cfg.port_range_end)
            .find(|p| !used.contains(p))
            .ok_or_else(|| anyhow!("no free session ports in the configured range"))
    }

    /// Take stock of the sessions left over from a previous backend run, so a
    /// restart does not orphan running IDE sessions.
    ///
    /// Nothing is adopted any more in the sense of being taken into a registry
    /// this process owns — the runtime keeps its sessions whether or not the
    /// backend asks. This is the first listing, done at boot so the count can
    /// be logged rather than discovered on the first request.
    pub async fn adopt_existing(&self) -> anyhow::Result<usize> {
        Ok(self.refresh().await?.len())
    }

    /// One reaping pass: stop every session past `max_session_secs`.
    ///
    /// The list comes from the **driver**, not from this process's session map.
    /// That map only holds what this replica launched, plus what it adopted when
    /// it booted — a session launched by another replica afterwards is not in
    /// it. Asking the runtime instead makes one pass enough for everything the
    /// driver can see, which is what lets a schedule fire this in one replica
    /// (see [`super::reap_task`]) rather than every replica running its own
    /// timer over its own partial view.
    ///
    /// # Errors
    ///
    /// Only when the runtime cannot be listed at all. A single session the
    /// driver refuses to stop is counted in [`ReapOutcome::failed`] and left
    /// for the next pass.
    pub async fn reap_expired(&self) -> anyhow::Result<ReapOutcome> {
        if self.cfg.max_session_secs == 0 {
            return Ok(ReapOutcome::default());
        }
        let cutoff = now_secs().saturating_sub(self.cfg.max_session_secs);
        let expired: Vec<AdoptedSession> = self
            .driver
            .list_adoptable()
            .await?
            .into_iter()
            // A session whose creation time the runtime did not report reads
            // as epoch 0 — "created in 1970" — and every cutoff is after that,
            // so the worst possible reading of "I do not know how old this is"
            // used to be "destroy it". A Pod that has just been created is
            // exactly the one most likely to be listed without a timestamp,
            // and it is the one a person is waiting on.
            //
            // The cache already refuses to believe a zero (see `refresh`);
            // this is the same refusal on the path that acts on it.
            .filter(|s| s.created_at_epoch_secs != 0 && s.created_at_epoch_secs < cutoff)
            .collect();

        let mut outcome = ReapOutcome {
            expired: expired.len(),
            ..ReapOutcome::default()
        };
        for session in expired {
            match self.driver.destroy(&session.handle).await {
                Ok(()) => {
                    outcome.stopped += 1;
                    // Drop it from the cache too, so a listing still inside
                    // its TTL does not keep offering a session that is gone.
                    self.cache_forget(session_id_for(session.workspace_id))
                        .await;
                }
                Err(e) => {
                    outcome.failed += 1;
                    tracing::warn!(
                        handle = %session.handle,
                        workspace_id = %session.workspace_id,
                        "studio-session: could not stop an expired session: {e:#}"
                    );
                }
            }
        }
        Ok(outcome)
    }
}

/// The name a person recognizes as their own: the display name, then the two
/// name parts, then the username. Never a blank string — git accepts one and
/// the commit then reads as authored by nobody at all, which is worse than
/// the `Constructor Studio` fallback because it looks deliberate.
fn git_author_name(
    display_name: Option<&str>,
    first_name: Option<&str>,
    last_name: Option<&str>,
    username: &str,
) -> String {
    // A named function, not a closure: as a closure the nested `filter` makes
    // the borrow checker tie the argument's lifetime to the closure itself.
    fn present(value: Option<&str>) -> Option<&str> {
        value.map(str::trim).filter(|v| !v.is_empty())
    }
    if let Some(display) = present(display_name) {
        return display.to_string();
    }
    match (present(first_name), present(last_name)) {
        (Some(first), Some(last)) => format!("{first} {last}"),
        (Some(one), None) | (None, Some(one)) => one.to_string(),
        (None, None) => username.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{git_author_name, session_id_for};

    /// The property the whole change rests on: two processes — a restart, or a
    /// second replica — reach the same id for the same workspace without ever
    /// talking to each other.
    #[test]
    fn the_same_workspace_always_gets_the_same_session_id() {
        let ws = Uuid::parse_str("6f9619ff-8b86-d011-b42d-00cf4fc964ff").unwrap();
        assert_eq!(session_id_for(ws), session_id_for(ws));
        // Pinned, not just self-consistent: a change here renames every live
        // session, so it has to be a deliberate edit rather than a refactor.
        assert_eq!(
            session_id_for(ws).to_string(),
            "a7dc39c6-a484-5da8-b975-d085ad65f208"
        );
    }

    #[test]
    fn different_workspaces_get_different_session_ids() {
        assert_ne!(
            session_id_for(Uuid::from_u128(1)),
            session_id_for(Uuid::from_u128(2))
        );
    }

    #[test]
    fn prefers_the_display_name() {
        assert_eq!(
            git_author_name(Some("Ada Lovelace"), Some("Augusta"), Some("King"), "ada"),
            "Ada Lovelace"
        );
    }

    #[test]
    fn falls_back_to_the_name_parts() {
        assert_eq!(
            git_author_name(None, Some("Ada"), Some("Lovelace"), "ada"),
            "Ada Lovelace"
        );
        assert_eq!(git_author_name(None, Some("Ada"), None, "ada"), "Ada");
        assert_eq!(
            git_author_name(None, None, Some("Lovelace"), "ada"),
            "Lovelace"
        );
    }

    #[test]
    fn falls_back_to_the_username_last() {
        assert_eq!(git_author_name(None, None, None, "ada"), "ada");
    }

    /// An IdP that stores an empty string is the common case this has to
    /// survive: it is not `None`, and used as-is it authors the commit to an
    /// empty name.
    #[test]
    fn treats_blank_fields_as_absent() {
        assert_eq!(
            git_author_name(Some("  "), Some(""), Some(" "), "ada"),
            "ada"
        );
        assert_eq!(git_author_name(Some(" Ada "), None, None, "ada"), "Ada");
        assert!(git_author_name(None, None, None, "   ").is_empty());
    }

    // ── The runtime is the registry ───────────────────────────────────────
    //
    // A fake runtime stands in for the Docker daemon / Kubernetes API. What
    // these tests are about is that the service asks it rather than
    // remembering — which is what lets two replicas agree.

    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use anyhow::anyhow;
    use async_trait::async_trait;

    use super::super::access::WorkspaceAccess;
    use super::super::driver::{
        AdoptedSession, LaunchSpec, LaunchedSession, SessionAddress, SessionDriver,
    };
    use super::{Arc, SecurityContext, SessionService, SessionState, StudioSessionConfig};

    #[derive(Default)]
    struct FakeRuntime {
        listed: Mutex<Vec<AdoptedSession>>,
        listings: AtomicUsize,
        fails: Mutex<bool>,
        reachable: Mutex<bool>,
    }

    impl FakeRuntime {
        fn with(sessions: Vec<AdoptedSession>) -> Arc<Self> {
            Arc::new(Self {
                listed: Mutex::new(sessions),
                reachable: Mutex::new(true),
                ..Self::default()
            })
        }
        fn set(&self, sessions: Vec<AdoptedSession>) {
            *self.listed.lock().unwrap() = sessions;
        }
        fn start_failing(&self) {
            *self.fails.lock().unwrap() = true;
        }
        fn listings(&self) -> usize {
            self.listings.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl SessionDriver for FakeRuntime {
        async fn image_present(&self) -> bool {
            true
        }
        async fn refresh_image(&self) -> anyhow::Result<()> {
            Ok(())
        }
        async fn launch(&self, _spec: &LaunchSpec) -> anyhow::Result<LaunchedSession> {
            unimplemented!("these tests never launch")
        }
        async fn is_running(&self, handle: &str) -> bool {
            self.listed
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.handle == handle && s.running)
        }
        async fn is_reachable(&self, _address: &SessionAddress) -> bool {
            *self.reachable.lock().unwrap()
        }
        async fn destroy(&self, handle: &str) -> anyhow::Result<()> {
            self.listed.lock().unwrap().retain(|s| s.handle != handle);
            Ok(())
        }
        async fn list_adoptable(&self) -> anyhow::Result<Vec<AdoptedSession>> {
            self.listings.fetch_add(1, Ordering::SeqCst);
            if *self.fails.lock().unwrap() {
                return Err(anyhow!("the runtime is unreachable"));
            }
            Ok(self.listed.lock().unwrap().clone())
        }
    }

    const TENANT: Uuid = Uuid::from_u128(0x11);

    /// Reachability, faked at the seam `access.rs` exists to provide. The real
    /// answer is account-management resolving the workspace tenant under the
    /// caller's own context; what these tests are about is what this gear does
    /// with a yes and with a no.
    struct Reachable(bool);

    #[async_trait]
    impl WorkspaceAccess for Reachable {
        async fn may_reach(&self, _ctx: &SecurityContext, _workspace_id: Uuid) -> bool {
            self.0
        }
    }

    /// A caller in a given home tenant. The home tenant is exactly what these
    /// lookups used to key on and now must not: two of these differing is the
    /// state that used to destroy a live session.
    fn caller(tenant: Uuid) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xC0))
            .subject_type("user")
            .subject_tenant_id(tenant)
            .build()
            .expect("security context")
    }

    fn ctx() -> SecurityContext {
        caller(TENANT)
    }

    fn running_session(workspace: Uuid, port: u16) -> AdoptedSession {
        AdoptedSession {
            workspace_id: workspace,
            tenant_id: TENANT,
            handle: format!("pod-{workspace}"),
            address: SessionAddress::Loopback { port },
            running: true,
            created_at_epoch_secs: 1_700_000_000,
            session_token: "gate".into(),
            control_token: "s2s".into(),
            sources: vec!["docs (git)".into()],
        }
    }

    /// `registry_ttl_secs: 0` — every read asks the runtime, which is what
    /// most of these tests want to observe.
    fn config() -> StudioSessionConfig {
        StudioSessionConfig {
            registry_ttl_secs: 0,
            theia_control_enabled: true,
            ..StudioSessionConfig::default()
        }
    }

    /// A service every caller reaches, which is the uninteresting half of the
    /// access question and the right default for tests about everything else.
    async fn service(runtime: Arc<FakeRuntime>) -> Arc<SessionService> {
        let service = SessionService::new(config(), runtime);
        service
            .set_workspace_access(Arc::new(Reachable(true)))
            .await;
        service
    }

    /// The property the whole change is for: two services sharing a runtime
    /// and sharing nothing else answer identically. That is two replicas.
    #[tokio::test]
    async fn two_services_over_one_runtime_agree() {
        let ws = Uuid::from_u128(0xA1);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let (one, two) = (
            service(runtime.clone()).await,
            service(runtime.clone()).await,
        );

        let from_one = one.list(&ctx()).await;
        let from_two = two.list(&ctx()).await;
        assert_eq!(from_one.len(), 1);
        assert_eq!(from_one[0].id, from_two[0].id);
        assert_eq!(from_one[0].handle, from_two[0].handle);

        // Including by id — the one lookup a process-local registry could not
        // answer for a session another replica had launched.
        let id = from_one[0].id;
        assert!(two.get(&ctx(), id).await.is_some());
        assert!(two.proxy_target(id).await.is_some());
    }

    /// THE REGRESSION THIS GUARD EXISTS FOR: two people, one project.
    ///
    /// These two differ in exactly the way the dev stand's two accounts did — a
    /// member of the workspace's tenant and a platform administrator, whose
    /// home tenant is the platform root. Keyed on the home tenant, neither
    /// found the other's session; `create` answered that miss by destroying the
    /// live container to launch a replacement, and the person typing in it was
    /// thrown out. Keyed on the workspace, there is one session and both reach
    /// it.
    #[tokio::test]
    async fn two_callers_reach_one_workspace_session() {
        let ws = Uuid::from_u128(0xB3);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = service(runtime.clone()).await;

        let member = caller(TENANT);
        let administrator = caller(Uuid::from_u128(1));
        let id = service.list(&member).await[0].id;

        assert!(service.get(&member, id).await.is_some());
        assert!(
            service.get(&administrator, id).await.is_some(),
            "a session is reached through its workspace, not through whose home \
             tenant happened to launch it"
        );
    }

    /// A runtime that launches: it keeps the environment each container was
    /// started with, and lists the container afterwards the way Docker does.
    #[derive(Default)]
    struct LaunchingRuntime {
        launched: Mutex<Vec<(Uuid, Vec<String>)>>,
    }

    #[async_trait]
    impl SessionDriver for LaunchingRuntime {
        async fn image_present(&self) -> bool {
            true
        }
        async fn refresh_image(&self) -> anyhow::Result<()> {
            Ok(())
        }
        async fn launch(&self, spec: &LaunchSpec) -> anyhow::Result<LaunchedSession> {
            let workspace = spec.labels[super::WS_LABEL].parse()?;
            self.launched
                .lock()
                .unwrap()
                .push((workspace, spec.env.clone()));
            Ok(LaunchedSession {
                handle: spec.name.clone(),
                address: SessionAddress::Loopback { port: spec.port },
            })
        }
        async fn is_running(&self, handle: &str) -> bool {
            self.launched
                .lock()
                .unwrap()
                .iter()
                .any(|(ws, _)| handle == format!("cf-studio-session-{ws}"))
        }
        async fn is_reachable(&self, _address: &SessionAddress) -> bool {
            true
        }
        async fn destroy(&self, _handle: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn list_adoptable(&self) -> anyhow::Result<Vec<AdoptedSession>> {
            Ok(self
                .launched
                .lock()
                .unwrap()
                .iter()
                .map(|(ws, _)| AdoptedSession {
                    handle: format!("cf-studio-session-{ws}"),
                    ..running_session(*ws, 41000)
                })
                .collect())
        }
    }

    fn person(subject: u128) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(subject))
            .subject_type("user")
            .subject_tenant_id(TENANT)
            .build()
            .expect("security context")
    }

    /// A credstore that holds a private key of the launcher's for every
    /// reference: exactly what used to end up in a shared container.
    struct LaunchersKeys;

    #[async_trait]
    impl credstore_sdk::CredStoreClientV1 for LaunchersKeys {
        async fn get(
            &self,
            _ctx: &SecurityContext,
            key: &credstore_sdk::SecretRef,
        ) -> Result<Option<credstore_sdk::GetSecretResponse>, credstore_sdk::CredStoreError>
        {
            Ok(Some(credstore_sdk::GetSecretResponse {
                value: credstore_sdk::SecretValue::new(
                    format!("private-{}", key.as_ref()).into_bytes(),
                ),
                id: Uuid::nil(),
                owner_tenant_id: credstore_sdk::TenantId(TENANT),
                sharing: credstore_sdk::SharingMode::Private,
                is_inherited: false,
                version: 1,
                secret_type: String::new(),
                expires_at: None,
            }))
        }
    }

    /// NOTHING PERSONAL IN A SHARED CONTAINER (ADR-0030). The launcher keeps
    /// private provider keys; none of them may reach a container other
    /// people type into. What the container gets instead is only where
    /// Studio's provider proxy is, and the switch that makes the agents send
    /// each window's own token there.
    #[tokio::test]
    async fn a_session_carries_no_key_of_its_launcher() {
        let root = std::env::temp_dir().join(format!("studio-session-keys-{}", Uuid::new_v4()));
        let runtime = Arc::new(LaunchingRuntime::default());
        let service = SessionService::new(
            StudioSessionConfig {
                workspaces_root: root.to_string_lossy().into_owned(),
                gateway_url: "http://gateway.test/cf/".into(),
                ..config()
            },
            runtime.clone(),
        );
        service
            .set_workspace_access(Arc::new(Reachable(true)))
            .await;
        service.set_credstore(Arc::new(LaunchersKeys)).await;

        service
            .create(&person(0x7A5), Uuid::from_u128(0xD2), None, None, vec![])
            .await
            .expect("Vasil opens the workspace");
        let env = runtime.launched.lock().unwrap()[0].1.clone();
        let _ = std::fs::remove_dir_all(&root);

        let leaked: Vec<&String> = env.iter().filter(|v| v.contains("private-")).collect();
        assert!(
            leaked.is_empty(),
            "the launcher's keys reached the container: {leaked:?}"
        );
        for personal in [
            "ANTHROPIC_API_KEY=",
            "OPENAI_API_KEY=",
            "STUDIO_GIT_AUTHOR_NAME=",
            "STUDIO_GIT_AUTHOR_EMAIL=",
        ] {
            assert!(
                !env.iter().any(|v| v.starts_with(personal)),
                "{personal} is set in a shared container"
            );
        }
        for wanted in [
            "STUDIO_LLM_AUTH=bearer",
            "ANTHROPIC_BASE_URL=http://gateway.test/cf/studio-llm/v1/providers/anthropic",
            "OPENAI_BASE_URL=http://gateway.test/cf/studio-llm/v1/providers/openai",
        ] {
            assert!(env.iter().any(|v| v == wanted), "missing {wanted}");
        }
    }

    /// WHO A SHARED SESSION IS. One session per workspace is deliberate (the
    /// test above), and a session is launched once — its environment is built
    /// from whoever launched it: `STUDIO_ACTOR_ID`, the git author, and the
    /// agent keys read from credstore under that person's identity, their
    /// private secrets first. So the second member to open the workspace types
    /// into a container that commits, pushes and calls agents as the first.
    ///
    /// This is "signed in as Vasil, and it was not Vasil" without any login
    /// going wrong: both tokens were right, and the IDE still was not.
    ///
    /// Ignored, not deleted: it states where a shared session has to get to —
    /// several people in one container, each acting as themselves (TASKS.md,
    /// 2026-09-25). It fails today; drop the `ignore` when it passes.
    #[tokio::test]
    #[ignore = "known: a shared session runs as its launcher (TASKS.md 2026-09-25)"]
    async fn the_second_member_of_a_workspace_does_not_work_as_the_first() {
        let root = std::env::temp_dir().join(format!("studio-session-actor-{}", Uuid::new_v4()));
        let runtime = Arc::new(LaunchingRuntime::default());
        let service = SessionService::new(
            StudioSessionConfig {
                workspaces_root: root.to_string_lossy().into_owned(),
                ..config()
            },
            runtime.clone(),
        );
        service
            .set_workspace_access(Arc::new(Reachable(true)))
            .await;

        let vasil = Uuid::from_u128(0x7A5);
        let colleague = Uuid::from_u128(0xC011);
        let ws = Uuid::from_u128(0xD1);

        let (_, existed) = service
            .create(&person(0x7A5), ws, None, None, vec![])
            .await
            .expect("Vasil opens the workspace");
        assert!(!existed);
        let (_, reused) = service
            .create(&person(0xC011), ws, None, None, vec![])
            .await
            .expect("a colleague opens the same workspace");

        let launched = runtime.launched.lock().unwrap().clone();
        let actor = |env: &[String]| {
            env.iter()
                .find_map(|v| v.strip_prefix("STUDIO_ACTOR_ID=").map(str::to_owned))
                .unwrap_or_default()
        };
        let actor_of_the_colleagues_ide = actor(&launched.last().expect("a launch").1);
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            !reused || actor_of_the_colleagues_ide == colleague.to_string(),
            "the colleague ({colleague}) was handed the session Vasil ({vasil}) launched, \
             and it runs as {actor_of_the_colleagues_ide}: commits, pushes and agent calls \
             from their keyboard are Vasil's"
        );
    }

    /// The other half: reachability is a question, not a formality.
    #[tokio::test]
    async fn a_workspace_the_caller_does_not_reach_has_no_session() {
        let ws = Uuid::from_u128(0xAA);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = SessionService::new(config(), runtime);
        service
            .set_workspace_access(Arc::new(Reachable(false)))
            .await;

        assert!(service.list(&ctx()).await.is_empty());
        assert!(service.get(&ctx(), session_id_for(ws)).await.is_none());
        assert!(!service.stop(&ctx(), session_id_for(ws)).await.unwrap());
    }

    /// And an assembly that wired no client at all refuses, rather than
    /// treating a question nobody can answer as a yes.
    #[tokio::test]
    async fn an_unwired_access_client_reaches_nothing() {
        let ws = Uuid::from_u128(0xAB);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = SessionService::new(config(), runtime);

        assert!(service.list(&ctx()).await.is_empty());
        assert!(service.get(&ctx(), session_id_for(ws)).await.is_none());
    }

    #[tokio::test]
    async fn a_session_the_runtime_dropped_is_gone() {
        let ws = Uuid::from_u128(0xA2);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = service(runtime.clone()).await;
        let id = service.list(&ctx()).await[0].id;

        runtime.set(Vec::new());
        assert!(service.list(&ctx()).await.is_empty());
        assert!(service.get(&ctx(), id).await.is_none());
    }

    /// A container that stopped on its own reads as stopped, without anyone
    /// having told this process about it.
    #[tokio::test]
    async fn a_stopped_runtime_reads_as_stopped() {
        let ws = Uuid::from_u128(0xA3);
        let mut stopped = running_session(ws, 41000);
        stopped.running = false;
        let service = service(FakeRuntime::with(vec![stopped])).await;
        assert_eq!(service.list(&ctx()).await[0].state, SessionState::Stopped);
    }

    /// A session the runtime listed without a creation time is NOT an expired
    /// session. Epoch 0 is before every cutoff, so the reaper used to read "I
    /// do not know how old this is" as "it is ancient, destroy it" — and the
    /// Pod most likely to be listed without a timestamp is the one that was
    /// just created, which is the one somebody is waiting on.
    #[tokio::test]
    async fn a_session_of_unknown_age_is_not_reaped() {
        let ws = Uuid::from_u128(0xB1);
        let mut ageless = running_session(ws, 41000);
        ageless.created_at_epoch_secs = 0;
        let runtime = FakeRuntime::with(vec![ageless]);
        let service = service(runtime.clone()).await;

        let outcome = service.reap_expired().await.expect("the pass runs");

        assert_eq!(outcome.expired, 0, "an unknown age is not an expiry");
        assert_eq!(outcome.stopped, 0);
        assert!(
            runtime
                .is_running("pod-00000000-0000-0000-0000-0000000000b1")
                .await
        );
    }

    /// And the guard does not save a session that really is too old.
    #[tokio::test]
    async fn a_session_past_its_maximum_age_is_still_reaped() {
        let ws = Uuid::from_u128(0xB2);
        let mut old = running_session(ws, 41000);
        old.created_at_epoch_secs = 1; // 1970, but stated rather than missing
        let runtime = FakeRuntime::with(vec![old]);
        let service = service(runtime.clone()).await;

        let outcome = service.reap_expired().await.expect("the pass runs");

        assert_eq!(outcome.expired, 1);
        assert_eq!(outcome.stopped, 1);
    }

    /// Whether the IDE answers is the one thing the runtime cannot report, so
    /// it is probed once and must then survive every later listing.
    #[tokio::test]
    async fn running_survives_the_next_listing() {
        let ws = Uuid::from_u128(0xA4);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = service(runtime.clone()).await;
        let id = service.list(&ctx()).await[0].id;

        assert_eq!(
            service.list(&ctx()).await[0].state,
            SessionState::Starting,
            "a listed session starts out only started"
        );
        assert_eq!(
            service.get(&ctx(), id).await.unwrap().state,
            SessionState::Running,
            "the reachability probe promotes it"
        );
        assert_eq!(
            service.list(&ctx()).await[0].state,
            SessionState::Running,
            "and a fresh listing does not undo that"
        );
    }

    #[tokio::test]
    async fn a_listing_is_reused_until_its_ttl_runs_out() {
        let ws = Uuid::from_u128(0xA5);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = SessionService::new(
            StudioSessionConfig {
                registry_ttl_secs: 300,
                ..StudioSessionConfig::default()
            },
            runtime.clone(),
        );
        service
            .set_workspace_access(Arc::new(Reachable(true)))
            .await;

        for _ in 0..5 {
            assert_eq!(service.list(&ctx()).await.len(), 1);
        }
        assert_eq!(
            runtime.listings(),
            1,
            "five reads inside the TTL are one call to the runtime"
        );
    }

    /// A momentary API failure must not empty the portal.
    #[tokio::test]
    async fn a_runtime_that_cannot_be_listed_leaves_the_last_answer_standing() {
        let ws = Uuid::from_u128(0xA6);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = service(runtime.clone()).await;
        assert_eq!(service.list(&ctx()).await.len(), 1);

        runtime.start_failing();
        assert_eq!(service.list(&ctx()).await.len(), 1);
    }

    /// Stopping must take effect at once, not when the listing next expires.
    #[tokio::test]
    async fn stopping_takes_effect_before_the_next_listing() {
        let ws = Uuid::from_u128(0xA7);
        let runtime = FakeRuntime::with(vec![running_session(ws, 41000)]);
        let service = SessionService::new(
            StudioSessionConfig {
                registry_ttl_secs: 300,
                ..StudioSessionConfig::default()
            },
            runtime.clone(),
        );
        service
            .set_workspace_access(Arc::new(Reachable(true)))
            .await;
        let id = service.list(&ctx()).await[0].id;

        assert!(service.stop(&ctx(), id).await.unwrap());
        assert!(service.list(&ctx()).await.is_empty());
    }

    /// The bridge's authentication primitive, resolved on a service that never
    /// minted the token — the studio-theia ingress can land on any replica.
    #[tokio::test]
    async fn a_control_token_resolves_on_a_service_that_never_minted_it() {
        let ws = Uuid::from_u128(0xA9);
        let elsewhere = service(FakeRuntime::with(vec![running_session(ws, 41000)])).await;

        let identity = elsewhere.resolve_control_token("s2s").await.unwrap();
        assert_eq!(identity.workspace_id, ws);
        assert_eq!(identity.tenant_id, TENANT);
        assert!(elsewhere.resolve_control_token("forged").await.is_none());
    }
}
