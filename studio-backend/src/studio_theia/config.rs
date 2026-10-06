//! Configuration for the studio-theia bridge gear (ADR-0022).

use serde::Deserialize;

/// Configuration for the `studio-theia` gear.
///
/// Dormant by default (`enabled = false`): the bridge is opt-in until the
/// studio→Theia control path and studio-session endpoint discovery are wired
/// (ADR-0022 phase 2). When disabled the gear still boots and mounts its REST,
/// but the event ingress answers 503 and no `TheiaControlClientV1` is published.
#[derive(Debug, Clone, Deserialize)]
pub struct StudioTheiaConfig {
    /// Master switch. `false` keeps the bridge dormant.
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// Path the Theia node backend POSTs forwarded `StudioRuntimeClient` events
    /// to. Mounted by this gear's REST capability.
    #[serde(default = "default_event_ingress_path")]
    pub event_ingress_path: String,

    /// Env var holding the shared server-to-server token the event ingress
    /// requires on the `X-CFS-Theia-Token` header. Per-session tokens (phase 2)
    /// supersede this single shared secret.
    #[serde(default = "default_s2s_token_env")]
    pub s2s_token_env: String,

    /// Internal control port inside a Theia container that the bridge dials for
    /// studio→Theia calls (never proxied to the browser).
    #[serde(default = "default_control_port")]
    pub control_port: u16,

    /// Request timeout (seconds) for a single control call.
    #[serde(default = "default_request_timeout_secs")]
    pub request_timeout_secs: u64,
}

impl Default for StudioTheiaConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            event_ingress_path: default_event_ingress_path(),
            s2s_token_env: default_s2s_token_env(),
            control_port: default_control_port(),
            request_timeout_secs: default_request_timeout_secs(),
        }
    }
}

impl StudioTheiaConfig {
    /// The shared ingress token, read from `s2s_token_env`. `None` when unset or
    /// empty — the ingress then rejects every request.
    // Phase-2 single-token gate; superseded by per-session reverse-resolve.
    // Kept for config back-compat and a possible coarse pre-filter.
    #[allow(dead_code)]
    pub fn ingress_token(&self) -> Option<String> {
        std::env::var(&self.s2s_token_env)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
}

fn default_enabled() -> bool {
    false
}
fn default_event_ingress_path() -> String {
    "/studio-theia/v1/events".into()
}
fn default_s2s_token_env() -> String {
    "STUDIO_THEIA_S2S_TOKEN".into()
}
fn default_control_port() -> u16 {
    3031
}
fn default_request_timeout_secs() -> u64 {
    15
}
