//! v1 wire DTOs for the Theia control bridge.
//!
//! Shapes mirror `theia/studio/src/common/studio-protocol.ts`, which is
//! camelCase — so every wire DTO is `rename_all = "camelCase"`. Each derives
//! both `Serialize` and `Deserialize`: requests are serialized on the way to
//! the Theia node, responses deserialized on the way back. These same types are
//! also the studio-theia portal REST bodies (hence camelCase there too).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Addresses the caller's IDE session for a workspace. Not sent on the wire
/// as-is; the resolver turns it into a concrete endpoint + token, scoped to the
/// caller's tenant via the `SecurityContext`.
#[derive(Debug, Clone)]
pub struct SessionTarget {
    pub workspace_id: Uuid,
}

/// One repository the IDE has mounted (subset of `StudioRepositoryDescriptor`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDescriptor {
    pub repository_id: String,
    pub fingerprint: String,
    pub root_uri: String,
    pub label: String,
    #[serde(default)]
    pub git_mode: Option<String>,
    /// `"project"` for the project's own repository -- the configured
    /// repository root, which is where `.cf-studio-kit.toml` lives and what the
    /// node installs a kit into when the caller names no target -- and
    /// `"source"` for a checkout mounted below it.
    ///
    /// Defaults to `"source"` rather than being required: an older Theia image
    /// whose `getRepositories` predates the field must still deserialize. The
    /// cost of that is a repository list with no project entry to preselect,
    /// which is a degraded picker rather than a failed call.
    #[serde(default = "default_repository_kind")]
    pub kind: String,
}

fn default_repository_kind() -> String {
    "source".to_owned()
}

/// Session identity + feature summary (subset of `StudioRuntimeSession`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub actor_id: String,
    pub workspace_id: String,
    pub workspace_root_name: String,
    pub git_mode: String,
}

/// Enqueue a workspace operation (mirrors `EnqueueStudioOperationRequest`,
/// dropping the redundant `workspaceId`/`languageId` the node infers).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueOperation {
    pub repository_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub idempotency_key: String,
    pub saved_at: String,
}

/// Result of an enqueue (mirrors `EnqueueStudioOperationResponse`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueOperationResult {
    pub operation: OperationSnapshot,
    pub reused_existing: bool,
}

/// Point-in-time state of one operation (subset of `StudioOperationSnapshot`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSnapshot {
    pub operation_id: String,
    pub state: String,
    pub last_sequence: i64,
    #[serde(default)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
}

/// Cursor-paged operation events (mirrors `StudioOperationDeltaResponse`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationDeltas {
    pub last_sequence: i64,
    pub events: Vec<OperationEvent>,
}

/// One operation lifecycle event (subset of `StudioOperationEvent`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvent {
    pub sequence: i64,
    pub operation_id: String,
    pub state: String,
    pub relative_path: String,
    pub timestamp: String,
    #[serde(default)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
}

/// Richer readiness than studio-session's TCP probe (new editor command §4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub ready: bool,
    pub workspace_mode: String,
    pub active_clients: u32,
    pub last_event_sequence: i64,
    pub version: String,
}

/// Reveal/open a file in the running IDE (new editor command §4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInEditor {
    pub relative_path: String,
    #[serde(default)]
    pub preview: bool,
}

/// Result of [`OpenInEditor`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInEditorResult {
    pub opened: bool,
    #[serde(default)]
    pub resolved_relative_path: Option<String>,
}

/// Show a Studio message in the running IDE (new editor command §4).
///
/// Display-only: it touches no workspace state, which is why it needs none of
/// the path guards the other editor commands carry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyEditor {
    /// `info` | `warn` | `error`. A word the container does not know is shown
    /// as information rather than refused — this crosses a version boundary.
    pub level: String,
    /// One line. The IDE shows it as a notification.
    pub message: String,
    /// A second line: what happened, in a sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// An http(s) URL the message is about, offered as an action on the
    /// notification. The IDE ignores any other scheme.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Who sent it, for the notification's own label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Result of [`NotifyEditor`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyEditorResult {
    /// False when no browser client was attached to show it — a session whose
    /// tab nobody has open. Deliberately not an error: whether an unseen
    /// notification matters is the caller's judgement.
    pub shown: bool,
}

/// Materialize one registry-approved kit inside a repository mounted by Theia.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallKit {
    pub kit_slug: String,
    pub version: String,
    #[serde(default)]
    pub repository_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallKitResult {
    pub kit_slug: String,
    pub version: String,
    pub repository_id: String,
    pub repository_label: String,
    pub output: String,
}
