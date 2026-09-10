//! studio-theia SDK — the transport-agnostic contract of the bridge gear.
//!
//! Consumers obtain the client from `ClientHub`:
//!
//! ```ignore
//! use crate::studio_theia::sdk::TheiaControlClientV1;
//! let theia = hub.get::<dyn TheiaControlClientV1>()?;
//! ```
//!
//! Shapes mirror the v1 slice in `docs/theia-bridge-contract-v1.md`, itself a
//! subset of `theia/studio/src/common/studio-protocol.ts`.

pub mod client;
pub mod models;

pub use client::TheiaControlClientV1;
pub use models::{
    EnqueueOperation, EnqueueOperationResult, InstallKit, InstallKitResult, NotifyEditor,
    NotifyEditorResult, OpenInEditor, OpenInEditorResult, OperationDeltas, OperationSnapshot,
    RepositoryDescriptor, RuntimeStatus, SessionInfo, SessionTarget,
};

/// Error returned by every fallible bridge operation.
pub type TheiaControlError = toolkit_canonical_errors::CanonicalError;
