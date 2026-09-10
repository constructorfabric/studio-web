//! HTTP-backed implementation of [`TheiaControlClientV1`], published in ClientHub.
//!
//! Each method is a thin mapping onto [`TheiaService::call`] with the wire
//! method name from `docs/theia-bridge-contract-v1.md`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use toolkit_security::SecurityContext;

use crate::studio_theia::sdk::{
    EnqueueOperation, EnqueueOperationResult, InstallKit, InstallKitResult, NotifyEditor,
    NotifyEditorResult, OpenInEditor, OpenInEditorResult, OperationDeltas, OperationSnapshot,
    RepositoryDescriptor, RuntimeStatus, SessionInfo, SessionTarget, TheiaControlClientV1,
    TheiaControlError,
};
use crate::studio_theia::service::TheiaService;

pub struct TheiaControlLocalClient {
    service: Arc<TheiaService>,
}

impl TheiaControlLocalClient {
    pub fn new(service: Arc<TheiaService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl TheiaControlClientV1 for TheiaControlLocalClient {
    async fn get_runtime_status(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<RuntimeStatus, TheiaControlError> {
        self.service
            .call(ctx, target, "getRuntimeStatus", &json!({}))
            .await
    }

    async fn get_session_info(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<SessionInfo, TheiaControlError> {
        self.service
            .call(ctx, target, "getSession", &json!({}))
            .await
    }

    async fn get_repositories(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<Vec<RepositoryDescriptor>, TheiaControlError> {
        self.service
            .call(ctx, target, "getRepositories", &json!({}))
            .await
    }

    async fn enqueue_operation(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &EnqueueOperation,
    ) -> Result<EnqueueOperationResult, TheiaControlError> {
        self.service
            .call(ctx, target, "enqueueOperation", request)
            .await
    }

    async fn get_operation_deltas(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        after_sequence: i64,
    ) -> Result<OperationDeltas, TheiaControlError> {
        self.service
            .call(
                ctx,
                target,
                "getOperationDeltas",
                &json!({ "afterSequence": after_sequence }),
            )
            .await
    }

    async fn retry_operation(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        operation_id: &str,
    ) -> Result<OperationSnapshot, TheiaControlError> {
        self.service
            .call(
                ctx,
                target,
                "retryOperation",
                &json!({ "operationId": operation_id }),
            )
            .await
    }

    async fn open_in_editor(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &OpenInEditor,
    ) -> Result<OpenInEditorResult, TheiaControlError> {
        self.service
            .call(ctx, target, "openInEditor", request)
            .await
    }

    async fn notify_editor(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &NotifyEditor,
    ) -> Result<NotifyEditorResult, TheiaControlError> {
        self.service
            .call(ctx, target, "notifyEditor", request)
            .await
    }

    async fn install_kit(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
        request: &InstallKit,
    ) -> Result<InstallKitResult, TheiaControlError> {
        self.service.call(ctx, target, "installKit", request).await
    }
}
