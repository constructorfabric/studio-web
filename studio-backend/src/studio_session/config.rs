use serde::Deserialize;

/// Configuration for the studio-session gear.
#[derive(Debug, Clone, Deserialize)]
pub struct StudioSessionConfig {
    /// Master switch. `false` (k8s deployments until the Pod driver lands,
    /// hosts without Docker): the gear boots, REST stays mounted, every
    /// session operation answers 503 with a clear message instead of the
    /// whole backend failing on a missing /var/run/docker.sock.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Which runtime launches sessions: `docker` (local daemon, the MVP) or
    /// `kubernetes` (one Pod+Service per session in the backend's namespace,
    /// reached through the backend's authenticated proxy). Default `docker`.
    #[serde(default = "default_driver")]
    pub driver: String,
    /// Kubernetes driver: namespace to create session Pods in. Unset = the
    /// backend's own namespace (from the mounted ServiceAccount token).
    #[serde(default)]
    pub k8s_namespace: Option<String>,
    /// Kubernetes driver: name of a `dockerconfigjson` Secret in the namespace
    /// for pulling the (private) session image. Unset = no pull secret.
    #[serde(default)]
    pub k8s_image_pull_secret: Option<String>,
    /// Docker image for a Theia session. Default: the CI-published one
    /// (.github/workflows/release.yml, job `images`, built from `theia/`).
    /// Pulled automatically when absent; a locally-built
    /// `cf-studio-theia:latest` also works.
    #[serde(default = "default_image")]
    pub image: String,
    /// Refresh the image on every launch attempt — for mutable tags like
    /// `edge`, where pull-on-missing alone would pin a stale image forever.
    /// A failed refresh falls back to the local copy (offline-friendly).
    #[serde(default = "default_always_pull")]
    pub always_pull: bool,
    /// Registry credentials for the pull, read from these env vars. The
    /// Docker API does NOT use `docker login`'s client-side credential
    /// store, so private registries (ghcr) need explicit credentials here:
    ///   export STUDIO_REGISTRY_USER=<github user>
    ///   export STUDIO_REGISTRY_TOKEN=<PAT with read:packages>
    /// Unset = anonymous pull (public images only).
    #[serde(default = "default_registry_user_env")]
    pub registry_user_env: String,
    #[serde(default = "default_registry_token_env")]
    pub registry_token_env: String,
    /// Host directory that stores per-workspace content; a subdirectory named
    /// by workspace id is bind-mounted into the container at /workspace.
    /// NB: when the backend itself runs in a container, this must be a HOST
    /// path that is also mounted into the backend at the same location.
    #[serde(default = "default_workspaces_root")]
    pub workspaces_root: String,
    /// Host interface the session port is published on. Keep loopback: the
    /// Theia PoC has no authentication of its own.
    #[serde(default = "default_bind_host")]
    pub bind_host: String,
    /// Hostname the browser uses to reach sessions (what we put in the URL).
    #[serde(default = "default_public_host")]
    pub public_host: String,
    /// Inclusive host port range for sessions.
    #[serde(default = "default_port_start")]
    pub port_range_start: u16,
    #[serde(default = "default_port_end")]
    pub port_range_end: u16,
    /// Stop sessions older than this (seconds). 0 disables the reaper.
    #[serde(default = "default_max_session_secs")]
    pub max_session_secs: u64,
    /// STUDIO_GIT_MODE passed to the container: disabled | commit | push.
    #[serde(default = "default_git_mode")]
    pub git_mode: String,
    /// Provider credentials handed to a session container. Each entry
    /// binds a credstore secret to an environment variable inside the
    /// IDE, which is how the native Theia agents authenticate:
    /// `@theia/ai-codex` reads OPENAI_API_KEY, `@theia/ai-claude-code`
    /// reads ANTHROPIC_API_KEY. Resolved per launch under the caller's
    /// identity, so a workspace only receives keys its tenant may read.
    /// A missing or unreadable reference is a warning, not an error: the
    /// session still starts, that agent just stays unauthenticated.
    #[serde(default = "default_agent_secrets")]
    pub agent_secrets: Vec<AgentSecret>,
}

impl Default for StudioSessionConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            driver: default_driver(),
            k8s_namespace: None,
            k8s_image_pull_secret: None,
            image: default_image(),
            always_pull: default_always_pull(),
            registry_user_env: default_registry_user_env(),
            registry_token_env: default_registry_token_env(),
            workspaces_root: default_workspaces_root(),
            bind_host: default_bind_host(),
            public_host: default_public_host(),
            port_range_start: default_port_start(),
            port_range_end: default_port_end(),
            max_session_secs: default_max_session_secs(),
            git_mode: default_git_mode(),
            agent_secrets: default_agent_secrets(),
        }
    }
}

fn default_enabled() -> bool {
    true
}
fn default_driver() -> String {
    "docker".into()
}
fn default_image() -> String {
    "ghcr.io/constructorfabric/studio-web/cf-studio-theia:edge".into()
}
fn default_always_pull() -> bool {
    true // the default image tag (edge) is mutable
}
fn default_registry_user_env() -> String {
    "STUDIO_REGISTRY_USER".into()
}
fn default_registry_token_env() -> String {
    "STUDIO_REGISTRY_TOKEN".into()
}

impl StudioSessionConfig {
    /// Registry credentials for the image pull, when both env vars are set.
    pub fn registry_credentials(&self) -> Option<bollard::auth::DockerCredentials> {
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let username = read(&self.registry_user_env)?;
        let password = read(&self.registry_token_env)?;
        Some(bollard::auth::DockerCredentials {
            username: Some(username),
            password: Some(password),
            ..Default::default()
        })
    }
}
fn default_workspaces_root() -> String {
    "~/.cf-studio-workspaces".into()
}
fn default_bind_host() -> String {
    "127.0.0.1".into()
}
fn default_public_host() -> String {
    "localhost".into()
}
fn default_port_start() -> u16 {
    41000
}
fn default_port_end() -> u16 {
    41099
}
fn default_max_session_secs() -> u64 {
    4 * 3600
}
fn default_git_mode() -> String {
    "disabled".into()
}

/// One `environment variable <- credstore reference` binding.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentSecret {
    /// Variable name as seen by the process inside the container.
    pub env: String,
    /// credstore reference holding the value.
    #[serde(rename = "ref")]
    pub secret_ref: String,
}

fn default_agent_secrets() -> Vec<AgentSecret> {
    vec![
        AgentSecret {
            env: "OPENAI_API_KEY".into(),
            secret_ref: "openai-key".into(),
        },
        AgentSecret {
            env: "ANTHROPIC_API_KEY".into(),
            secret_ref: "anthropic-key".into(),
        },
    ]
}

impl StudioSessionConfig {
    /// Expand a leading `~` against $HOME (same convention the toolkit uses
    /// for `server.home_dir`).
    pub fn workspaces_root_expanded(&self) -> String {
        if let Some(rest) = self.workspaces_root.strip_prefix("~/")
            && let Ok(home) = std::env::var("HOME")
        {
            return format!("{home}/{rest}");
        }
        self.workspaces_root.clone()
    }
}
