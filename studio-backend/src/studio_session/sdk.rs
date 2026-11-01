//! studio-session SDK — the in-process discovery contract for the Theia
//! backend bridge (ADR-0022).
//!
//! The studio-theia gear consumes [`StudioSessionDiscoveryClientV1`] from
//! `ClientHub` to turn a workspace into a dial-able Theia control endpoint +
//! per-session S2S token. Registered unconditionally by the studio-session
//! gear; dormant (resolves to `None`) unless `theia_control_enabled`.

// Consumed only by the opt-in studio-theia gear; until a live caller (the
// portal REST slice) drives it, this reads as dead code under `-D warnings`.
#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::SessionService;

/// Error returned by discovery lookups.
pub type StudioSessionError = toolkit_canonical_errors::CanonicalError;

/// The internal Theia control endpoint for one live session (ADR-0022).
#[derive(Debug, Clone)]
pub struct TheiaControlEndpoint {
    /// The studio-session id backing this endpoint.
    pub session_id: Uuid,
    /// Base URL studio-backend dials, e.g. `http://127.0.0.1:41007`.
    pub base_url: String,
    /// Per-session S2S token to present on the `X-CFS-Theia-Token` header.
    pub token: String,
}

/// Trusted session coordinates recovered from a per-session S2S control
/// token. The token is the credential (256 random bits, minted per session),
/// so this is the primitive the studio-theia ingress uses to MINT a
/// tenant-scoped identity instead of trusting the forwarded request body.
#[derive(Debug, Clone, Copy)]
pub struct SessionIdentity {
    pub session_id: Uuid,
    pub tenant_id: Uuid,
    pub workspace_id: Uuid,
}

/// Object-safe discovery client (version 1): resolve a workspace to its live
/// session's Theia control endpoint under the caller's identity.
#[async_trait]
pub trait StudioSessionDiscoveryClientV1: Send + Sync {
    /// Resolve the Theia control endpoint for the caller's live session on
    /// `workspace_id`. `Ok(None)` when the bridge is disabled or there is no
    /// live session for that `(tenant, workspace)`.
    async fn resolve_theia_control(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> Result<Option<TheiaControlEndpoint>, StudioSessionError>;

    /// Reverse-resolve a per-session S2S control token to its owning session's
    /// trusted coordinates. Unauthenticated by design — the token IS the
    /// credential. `Ok(None)` when no live session carries that token
    /// (rotated, stopped, forged, or the bridge is disabled).
    async fn resolve_control_token(
        &self,
        token: &str,
    ) -> Result<Option<SessionIdentity>, StudioSessionError>;
}

/// In-process implementation backed by the live [`SessionService`] registry.
pub struct StudioSessionDiscoveryLocalClient {
    service: Arc<SessionService>,
}

impl StudioSessionDiscoveryLocalClient {
    pub fn new(service: Arc<SessionService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl StudioSessionDiscoveryClientV1 for StudioSessionDiscoveryLocalClient {
    async fn resolve_theia_control(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> Result<Option<TheiaControlEndpoint>, StudioSessionError> {
        Ok(self.service.control_endpoint(ctx, workspace_id).await)
    }

    async fn resolve_control_token(
        &self,
        token: &str,
    ) -> Result<Option<SessionIdentity>, StudioSessionError> {
        Ok(self.service.resolve_control_token(token).await)
    }
}

/// The desktop sessions (ADR-0027 §4–5), for the bridge: a desktop posts its
/// events, and the portal sends it commands, under the member's own token and
/// the lease's id — no S2S token exists for a session the backend never
/// launched. Registered whether or not container sessions are enabled, since a
/// lease needs no driver.
#[async_trait]
pub trait DesktopSessionsClientV1: Send + Sync {
    /// The trusted coordinates of the live desktop session `id`, when the
    /// caller holds it. `None` for an ended lease and for somebody else's.
    async fn resolve_own_desktop_session(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
    ) -> Option<SessionIdentity>;
}

/// In-process implementation over the gear's lease registry.
pub struct DesktopSessionsLocalClient {
    leases: Arc<super::desktop::DesktopLeases>,
}

impl DesktopSessionsLocalClient {
    pub fn new(leases: Arc<super::desktop::DesktopLeases>) -> Self {
        Self { leases }
    }
}

#[async_trait]
impl DesktopSessionsClientV1 for DesktopSessionsLocalClient {
    async fn resolve_own_desktop_session(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
    ) -> Option<SessionIdentity> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.leases
            .held_by(
                now,
                id,
                &ctx.subject_id().to_string(),
                ctx.subject_tenant_id(),
            )
            .map(|lease| SessionIdentity {
                session_id: lease.id,
                tenant_id: lease.tenant_id,
                workspace_id: lease.workspace_id,
            })
    }
}

pub(crate) use super::access::{TenantMembership, WorkspaceAccess};
pub(crate) use super::config::StudioSessionConfig;
