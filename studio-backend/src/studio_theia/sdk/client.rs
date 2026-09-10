//! Object-safe client trait published in `ClientHub` (version 1).
//!
//! studio-backend gears depend on this trait, not on the HTTP details of the
//! Theia control API. Mirrors the v1 slice in `docs/theia-bridge-contract-v1.md`.

use async_trait::async_trait;
use toolkit_security::SecurityContext;

use super::{
    EnqueueOperation, EnqueueOperationResult, InstallKit, InstallKitResult, NotifyEditor,
    NotifyEditorResult, OpenInEditor, OpenInEditorResult, OperationDeltas, OperationSnapshot,
    RepositoryDescriptor, RuntimeStatus, SessionInfo, SessionTarget, TheiaControlError,
};

/// Object-safe control client for the per-session Theia node backend (v1).
///
/// Every call runs under a `SecurityContext`; the bridge resolves `target` to a
/// concrete endpoint + S2S token and enforces the tenant clamp before the call
/// reaches the (tenant-blind) container.
#[async_trait]
pub trait TheiaControlClientV1: Send + Sync {
    /// IDE readiness + event cursor (new editor command §4).
    async fn get_runtime_status(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<RuntimeStatus, TheiaControlError>;

    /// Session identity + feature flags.
    async fn get_session_info(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<SessionInfo, TheiaControlError>;

    /// Repositories the IDE has mounted.
    async fn get_repositories(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<Vec<RepositoryDescriptor>, TheiaControlError>;

    /// Queue a save/commit/push through the node's operation journal.
    async fn enqueue_operation(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &EnqueueOperation,
    ) -> Result<EnqueueOperationResult, TheiaControlError>;

    /// Cursor backfill of operation events after `after_sequence`.
    async fn get_operation_deltas(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        after_sequence: i64,
    ) -> Result<OperationDeltas, TheiaControlError>;

    /// Retry a failed operation by id.
    async fn retry_operation(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        operation_id: &str,
    ) -> Result<OperationSnapshot, TheiaControlError>;

    /// Reveal/open a file in the running IDE (new editor command §4).
    async fn open_in_editor(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &OpenInEditor,
    ) -> Result<OpenInEditorResult, TheiaControlError>;

    /// Show a Studio message in the running IDE (new editor command §4).
    ///
    /// `shown: false` means the session is up but nobody has its tab open. That
    /// is a fact about the world, not a failure of the call.
    async fn notify_editor(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &NotifyEditor,
    ) -> Result<NotifyEditorResult, TheiaControlError>;

    /// Install an allow-listed Studio kit in the selected repository.
    async fn install_kit(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &InstallKit,
    ) -> Result<InstallKitResult, TheiaControlError>;
}
