use serde::Deserialize;

/// Configuration for the studio-session gear.
#[derive(Debug, Clone, Deserialize)]
pub struct StudioSessionConfig {
    /// Master switch. `false` (environments that do not allow session Pods or
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
    /// Keep a session's `/workspace` on a PersistentVolumeClaim instead of
    /// an ephemeral `emptyDir`. Kubernetes only — the Docker driver already
    /// mounts a host directory and is persistent by construction.
    ///
    /// Off by default, and deliberately: it turns a session's scratch space
    /// into cluster storage that outlives the session, which is a decision
    /// for whoever owns the cluster's quota, not a default. With it on, a
    /// second launch of the same workspace finds its clones already there
    /// (the entrypoint skips materialized sources), so agent worktrees and
    /// uncommitted work survive both a relaunch and the reaper.
    #[serde(default)]
    pub k8s_workspace_persistent: bool,
    /// Size requested for that claim. Ignored unless
    /// [`Self::k8s_workspace_persistent`] is set.
    #[serde(default = "default_workspace_volume_size")]
    pub k8s_workspace_volume_size: String,
    /*
     * What one session Pod asks for, and what it may burst to.
     *
     * Configurable rather than fixed because these four numbers are the unit
     * a namespace quota is sized in — `limits.cpu` per session times the
     * people expected at once — and tuning them used to mean a code change and
     * a release. An operator who has to raise a quota should be able to lower
     * a limit instead, and compare.
     *
     * REQUESTS are what the scheduler reserves, so they are what has to fit
     * the hardware; LIMITS are the burst ceiling and what a ResourceQuota
     * counts. The defaults are what the driver used before they could be set:
     * a quarter CPU reserved, two CPUs available for the seconds when an IDE
     * is actually compiling something.
     */
    #[serde(default = "default_session_cpu_request")]
    pub k8s_session_cpu_request: String,
    #[serde(default = "default_session_cpu_limit")]
    pub k8s_session_cpu_limit: String,
    #[serde(default = "default_session_memory_request")]
    pub k8s_session_memory_request: String,
    #[serde(default = "default_session_memory_limit")]
    pub k8s_session_memory_limit: String,
    /// StorageClass for that claim; `None` leaves it to the cluster default.
    /// A class with `ReadWriteOnce` is enough — one session at a time holds
    /// a workspace.
    #[serde(default)]
    pub k8s_workspace_storage_class: Option<String>,
    /// A claim the BACKEND also mounts, shared by every workspace through a
    /// `subPath` of the workspace id. Set, it wins over the per-workspace claim
    /// above.
    ///
    /// This is what makes one checkout serve both sides: the IDE clones into
    /// `/workspace`, and artifact-ingest reads the same tree at
    /// `{workspaces_root}/{workspace_id}/{repo_dir}` — the layout that gear
    /// already looks for. Per-workspace claims cannot do that, because they are
    /// created per launch and a long-running backend Pod cannot mount a volume
    /// that did not exist when it started.
    ///
    /// The cost is [`Self::k8s_node_name`]: a `ReadWriteOnce` volume attaches to
    /// one node, so every session has to run on the backend's node. With an
    /// ReadWriteMany class that constraint disappears and this claim is all
    /// that is needed.
    #[serde(default)]
    pub k8s_workspace_shared_claim: Option<String>,
    /// The node the backend itself runs on (`spec.nodeName`, injected by the
    /// chart). Sessions are pinned here while [`Self::k8s_workspace_shared_claim`]
    /// is in use, because that is where its volume can be attached.
    ///
    /// Unset with a shared claim configured, the launch refuses rather than
    /// scheduling a Pod that would sit `Pending` on a multi-attach error — a
    /// clear error beats a session that never starts.
    #[serde(default)]
    pub k8s_node_name: Option<String>,
    /// Docker image for a Theia session. Default: the legacy CI-published one;
    /// Kubernetes deployments inject this repository's matching immutable image.
    /// when absent; a locally-built `cf-studio-theia:latest` also works.
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
    /// Studio API gateway as reached from inside a session container. Docker
    /// uses the host gateway; Kubernetes injects the backend Service DNS.
    #[serde(default = "default_gateway_url")]
    pub gateway_url: String,
    /// Portal origins a session lets frame it and talk to it (#324), handed
    /// to the container as `STUDIO_ALLOWED_ORIGINS`: comma-separated bare
    /// origins, which Theia validates at start. Empty = the session's own
    /// origin only, which is right wherever the portal reaches the IDE through
    /// its own domain (Kubernetes, the Vite stand proxy). The Docker driver
    /// publishes the IDE on a loopback port of its own, so a local portal has
    /// to be listed.
    #[serde(default)]
    pub allowed_origins: String,
    /// What a shared session acts as (`STUDIO_ACTOR_ID`): Studio's service
    /// identity, not the person who happened to launch it (ADR-0030). The same
    /// subject `studio-user` seeds as "Constructor Studio (service)".
    #[serde(
        default = "default_service_actor",
        deserialize_with = "crate::user_profile::service_subject_or_default"
    )]
    pub service_actor: String,
    /// Inclusive host port range for sessions.
    #[serde(default = "default_port_start")]
    pub port_range_start: u16,
    #[serde(default = "default_port_end")]
    pub port_range_end: u16,
    /// Stop sessions older than this (seconds). 0 disables the reaper.
    #[serde(default = "default_max_session_secs")]
    pub max_session_secs: u64,
    /// Stop a session no browser has had open for this long (seconds). 0
    /// disables it.
    ///
    /// The portal starts a project's session before anyone asks for the IDE —
    /// when the project or its Specs tab is opened — so the IDE is up by the
    /// time someone clicks a document. Most of those are never opened, and
    /// without this each would hold its Pod for `max_session_secs`. The
    /// session reports how long it has gone without a browser itself (the
    /// control API's `getRuntimeStatus`): this backend may run several
    /// replicas, and the IDE's traffic is the one thing none of them sees
    /// all of. A session that cannot say — no control API, an image from
    /// before it reported this — is left to `max_session_secs`.
    #[serde(default = "default_idle_session_secs")]
    pub idle_session_secs: u64,
    /// How long a listing of the runtime's sessions is reused before the next
    /// read asks the driver again.
    ///
    /// The runtime — the Docker daemon or the Kubernetes API — is what knows
    /// which sessions exist; this process only caches the answer. Longer means
    /// fewer calls and a staler view; 0 asks on every read, which the IDE proxy
    /// makes expensive. Sessions change on the order of minutes, so seconds of
    /// staleness cost nothing a reload does not fix.
    #[serde(default = "default_registry_ttl_secs")]
    pub registry_ttl_secs: u64,
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
    /// Run an Orca runtime (github.com/stablyai/orca) inside each session, so
    /// the IDE's Agents panel has something to drive.
    ///
    /// Off by default, and deliberately: the runtime is only present in images
    /// built with the Orca layer, and a session without it degrades to "not
    /// reachable" in the panel rather than failing to start. The keys the
    /// agents need are the ones [`Self::agent_secrets`] already provisions —
    /// Orca runs the same `codex` / `claude` CLIs.
    #[serde(default)]
    pub orca_enabled: bool,
    /// Port the in-container Orca runtime binds. Container-local and never
    /// published: the only client is the IDE's own backend in the same
    /// container.
    #[serde(default = "default_orca_port")]
    pub orca_port: u16,

    /// Enable the Theia backend-control bridge (ADR-0022): mint a per-session
    /// S2S control token, inject it into the container as
    /// `STUDIO_THEIA_S2S_TOKEN`, and let the studio-theia gear discover the
    /// session's internal control endpoint. Default off; the Theia node must
    /// also serve the control API for calls to succeed.
    #[serde(default)]
    pub theia_control_enabled: bool,

    /// Host studio-backend uses to DIAL a Loopback session — both the
    /// readiness probe that moves it from `starting` to `running` and the
    /// control API (Docker MVP), which share the session's port.
    ///
    /// Default `127.0.0.1` (backend on the host); set to
    /// `host.docker.internal` when the backend itself runs in a container,
    /// where its own loopback is not the host that published the port.
    #[serde(default = "default_control_reach_host")]
    pub control_reach_host: String,
}

impl Default for StudioSessionConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            driver: default_driver(),
            k8s_namespace: None,
            k8s_image_pull_secret: None,
            k8s_workspace_persistent: false,
            k8s_workspace_volume_size: default_workspace_volume_size(),
            k8s_session_cpu_request: default_session_cpu_request(),
            k8s_session_cpu_limit: default_session_cpu_limit(),
            k8s_session_memory_request: default_session_memory_request(),
            k8s_session_memory_limit: default_session_memory_limit(),
            k8s_workspace_storage_class: None,
            k8s_workspace_shared_claim: None,
            k8s_node_name: None,
            image: default_image(),
            always_pull: default_always_pull(),
            registry_user_env: default_registry_user_env(),
            registry_token_env: default_registry_token_env(),
            workspaces_root: default_workspaces_root(),
            bind_host: default_bind_host(),
            public_host: default_public_host(),
            gateway_url: default_gateway_url(),
            allowed_origins: String::new(),
            service_actor: default_service_actor(),
            port_range_start: default_port_start(),
            port_range_end: default_port_end(),
            max_session_secs: default_max_session_secs(),
            idle_session_secs: default_idle_session_secs(),
            registry_ttl_secs: default_registry_ttl_secs(),
            git_mode: default_git_mode(),
            agent_secrets: default_agent_secrets(),
            orca_enabled: false,
            orca_port: default_orca_port(),
            theia_control_enabled: false,
            control_reach_host: default_control_reach_host(),
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
fn default_service_actor() -> String {
    crate::user_profile::STUDIO_SERVICE_SUBJECT.to_owned()
}
fn default_gateway_url() -> String {
    "http://host.docker.internal:8090/cf".into()
}
fn default_port_start() -> u16 {
    41000
}
fn default_port_end() -> u16 {
    41099
}
fn default_orca_port() -> u16 {
    6768
}
fn default_session_cpu_request() -> String {
    "250m".to_string()
}
fn default_session_cpu_limit() -> String {
    "2".to_string()
}
fn default_session_memory_request() -> String {
    "512Mi".to_string()
}
fn default_session_memory_limit() -> String {
    "2Gi".to_string()
}
fn default_max_session_secs() -> u64 {
    4 * 3600
}
fn default_idle_session_secs() -> u64 {
    15 * 60
}
fn default_registry_ttl_secs() -> u64 {
    3
}
fn default_workspace_volume_size() -> String {
    "10Gi".into()
}
fn default_git_mode() -> String {
    "disabled".into()
}
fn default_control_reach_host() -> String {
    "127.0.0.1".into()
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

#[cfg(test)]
mod tests {
    use super::StudioSessionConfig;

    /// The chart sizes a namespace quota from these four numbers, and shows the
    /// arithmetic in `deploy/helm/studio-web/values.yaml`:
    ///
    ///     platform baseline + (concurrent sessions + 1) x session limits
    ///
    /// A default changed here without that file changing leaves the quota
    /// describing a session size that no longer exists — and the symptom is not
    /// a wrong number in a comment, it is sessions refused with `exceeded
    /// quota` on a stand nobody has touched. So the two are pinned together.
    #[test]
    fn the_session_footprint_the_quota_was_sized_against() {
        let cfg = StudioSessionConfig::default();
        assert_eq!(cfg.k8s_session_cpu_request, "250m");
        assert_eq!(cfg.k8s_session_cpu_limit, "2");
        assert_eq!(cfg.k8s_session_memory_request, "512Mi");
        assert_eq!(cfg.k8s_session_memory_limit, "2Gi");
    }

    /// The chart sets `STUDIO_SERVICE_SUBJECT` empty by default, and expansion
    /// keeps an empty value, so an empty actor must mean the fixed subject.
    /// Passed through, it gave every shared session `STUDIO_ACTOR_ID=` and an
    /// IDE that would not start.
    #[test]
    fn a_blank_service_actor_is_the_fixed_subject() {
        let fixed = crate::user_profile::STUDIO_SERVICE_SUBJECT;
        for blank in ["", "  "] {
            let cfg: StudioSessionConfig =
                serde_json::from_value(serde_json::json!({ "service_actor": blank })).unwrap();
            assert_eq!(cfg.service_actor, fixed);
        }
        let cfg: StudioSessionConfig =
            serde_json::from_value(serde_json::json!({ "service_actor": " sa-42 " })).unwrap();
        assert_eq!(cfg.service_actor, "sa-42");
        let cfg: StudioSessionConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(cfg.service_actor, fixed);

        let account: crate::user_profile::ServiceAccount =
            serde_json::from_value(serde_json::json!({ "subject": "" })).unwrap();
        assert_eq!(account.subject, fixed);
    }
}
