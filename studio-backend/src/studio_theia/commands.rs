//! Portal commands for a desktop session (ADR-0027 §5, phase 5).
//!
//! A container session is called: the backend dials its control port. Nothing
//! may dial a member's laptop, so a desktop session is **sent** a command
//! instead: it is published on `studio-events` as
//! `desktop_session.command_sent` about the
//! `desktop_session`, the desktop — subscribed to the channel under the
//! member's own token — picks the ones addressed to its lease, and runs them
//! through the same `StudioRuntimeService` it runs a container's calls with.
//! What came of one comes back as the desktop's ordinary events (phase 4).
//!
//! The channel is the tenant's, so a command carries nothing but what to do:
//! a path to open, an operation to queue. It never carries a secret.

use serde_json::Value;
use uuid::Uuid;

use crate::studio_session::sdk::SessionIdentity;
use crate::studio_theia::sdk::{EnqueueOperation, OpenInEditor};

/// What a desktop can be asked to do, as the `command` of a
/// `desktop_session.command_sent`.
/// Each is one of the container's control calls, with the same parameters.
pub const DESKTOP_COMMANDS: &[&str] = &["open_in_editor", "enqueue_operation", "retry_operation"];

/// Why a command was not sent.
#[derive(Debug, PartialEq, Eq)]
pub enum CommandRefusal {
    Unknown(String),
    BadParams(String),
}

impl std::fmt::Display for CommandRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown(command) => write!(
                f,
                "a desktop cannot be asked to `{command}`; it can be asked to {}",
                DESKTOP_COMMANDS.join(", ")
            ),
            Self::BadParams(why) => write!(f, "{why}"),
        }
    }
}

/// The command's parameters, checked against the control call it stands for,
/// so a desktop is never sent what a container would have refused.
pub fn checked_params(command: &str, params: Value) -> Result<Value, CommandRefusal> {
    let bad = |e: serde_json::Error| CommandRefusal::BadParams(format!("`{command}` params: {e}"));
    match command {
        "open_in_editor" => {
            let open: OpenInEditor = serde_json::from_value(params).map_err(bad)?;
            if open.relative_path.trim().is_empty() {
                return Err(CommandRefusal::BadParams(
                    "`open_in_editor` params: relativePath is empty".into(),
                ));
            }
            serde_json::to_value(open).map_err(bad)
        }
        "enqueue_operation" => {
            let op: EnqueueOperation = serde_json::from_value(params).map_err(bad)?;
            serde_json::to_value(op).map_err(bad)
        }
        "retry_operation" => {
            let id = params
                .get("operationId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    CommandRefusal::BadParams(
                        "`retry_operation` params: operationId is missing".into(),
                    )
                })?;
            Ok(serde_json::json!({ "operationId": id }))
        }
        other => Err(CommandRefusal::Unknown(other.to_owned())),
    }
}

/// The kind a command goes out as.
pub const COMMAND_SENT: &str = "desktop_session.command_sent";

/// The event that carries one command to `desktop`.
pub fn command_event(
    desktop: &SessionIdentity,
    command_id: Uuid,
    command: &str,
    params: Value,
) -> crate::studio_events::StudioEvent {
    crate::studio_events::StudioEvent::new(
        desktop.tenant_id,
        COMMAND_SENT,
        "desktop_session",
        desktop.session_id.to_string(),
        "studio-theia",
    )
    .with_payload(serde_json::json!({
        "workspace_id": desktop.workspace_id,
        "command_id": command_id,
        "command": command,
        "params": params,
    }))
}

/// Where a command goes. `false` when there is no channel to send it on.
pub trait DesktopCommandRelay: Send + Sync {
    fn send(&self, event: crate::studio_events::StudioEvent) -> bool;
}

/// Sends over `studio-events`, resolved lazily as [`super::sink`] does.
pub struct StudioEventsCommandRelay {
    hub: std::sync::Arc<toolkit::client_hub::ClientHub>,
}

impl StudioEventsCommandRelay {
    pub fn new(hub: std::sync::Arc<toolkit::client_hub::ClientHub>) -> Self {
        Self { hub }
    }
}

impl DesktopCommandRelay for StudioEventsCommandRelay {
    fn send(&self, event: crate::studio_events::StudioEvent) -> bool {
        match self
            .hub
            .get::<dyn crate::studio_events::StudioEventPublisher>()
        {
            Ok(events) => {
                events.publish(event);
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_command_is_checked_against_the_control_call_it_stands_for() {
        assert_eq!(
            checked_params("open_in_editor", json!({ "relativePath": "docs/a.md" })),
            Ok(json!({ "relativePath": "docs/a.md", "preview": false }))
        );
        assert!(matches!(
            checked_params("open_in_editor", json!({ "relativePath": "  " })),
            Err(CommandRefusal::BadParams(_))
        ));
        assert!(matches!(
            checked_params("open_in_editor", json!({})),
            Err(CommandRefusal::BadParams(_))
        ));
        assert!(matches!(
            checked_params("enqueue_operation", json!({ "repositoryId": "r" })),
            Err(CommandRefusal::BadParams(_))
        ));
        assert_eq!(
            checked_params(
                "retry_operation",
                json!({ "operationId": " op-1 ", "x": 1 })
            ),
            Ok(json!({ "operationId": "op-1" }))
        );
        let unknown = checked_params("run_shell", json!({})).unwrap_err();
        assert_eq!(unknown, CommandRefusal::Unknown("run_shell".into()));
        assert!(unknown.to_string().contains("open_in_editor"));
    }

    #[test]
    fn a_command_is_addressed_to_the_desktop_session_in_its_tenant() {
        let desktop = SessionIdentity {
            session_id: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
        };
        let id = Uuid::new_v4();
        let event = command_event(
            &desktop,
            id,
            "open_in_editor",
            json!({ "relativePath": "a" }),
        );
        assert_eq!(event.tenant_id, desktop.tenant_id);
        assert_eq!(event.kind, COMMAND_SENT);
        assert_eq!(event.subject_type, "desktop_session");
        assert_eq!(event.subject_id, desktop.session_id.to_string());
        assert_eq!(event.payload["command_id"], json!(id));
        assert_eq!(event.payload["workspace_id"], json!(desktop.workspace_id));
        assert_eq!(event.payload["command"], "open_in_editor");
    }

    #[test]
    fn the_command_kind_is_the_one_the_catalogue_lists() {
        assert_eq!(
            crate::api_contract::events::documented_kinds("desktop_session."),
            std::collections::BTreeSet::from([COMMAND_SENT.to_owned()]),
        );
    }
}
