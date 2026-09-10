//! The `notify.deliver` task: post one queued notification.
//!
//! ## The run is the record
//!
//! There is no delivery table. The message is the run's payload, the outcome is
//! the run's `summary` or `last_error`, and "what happened to the notification
//! I sent an hour ago" is `GET /studio-tasks/v1/runs/{id}`. That is not a
//! simplification for its own sake — it is what keeps the accept path a single
//! transaction. A separate deliveries table in this gear's own database would
//! mean writing the record in one database and the queue entry in another, and
//! a crash between those two writes is exactly the lost notification the queue
//! exists to prevent.
//!
//! ## Two kinds of destination
//!
//! A chat connection and an IDE session are both "somewhere to put a message",
//! and almost nothing else about them is the same — see
//! [`super::service::Destination`]. This handler is where that shows: the chat
//! path reads a platform's refusal and decides whether it is worth another
//! attempt; the editor path asks the studio-theia bridge, and a session that is
//! not there right now is always worth another attempt because it may come
//! back.
//!
//! ## Who delivers
//!
//! A queued delivery runs minutes after the request that asked for it, in a
//! process that has no request. It acts as `studio-tasks`' service identity
//! scoped to the run's tenant ([`TaskContext::security`]) — nothing persists a
//! caller's bearer token. Whatever authorization mattered happened at accept
//! time, against the caller's own context: the connection was resolved, its
//! credential read, and an unusable one refused with a 400 while there was
//! still a request to answer.
//!
//! ## Transient or permanent
//!
//! The driver contract answers with `anyhow::Error`, so the verdict is read out
//! of the message text. That is not a pleasing way to decide a retry, and the
//! honest fix is a typed error across all eleven drivers. Until then
//! [`classify`] matches the shapes the drivers actually produce, and its
//! **default is to retry**: an error nobody has classified is tried
//! [`MAX_ATTEMPTS`] times and then dead-lettered. Never dropped, never retried
//! forever.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use toolkit::client_hub::{ClientHub, ClientScope};
use tracing::warn;
use uuid::Uuid;

use crate::connectors::driver::NotifyMessage;
use crate::connectors::{NOTIFY_SENDER_INSTANCE_ID, NotificationSender};
#[cfg(feature = "theia-bridge")]
use crate::studio_theia::sdk::{NotifyEditor, SessionTarget, TheiaControlClientV1};
use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: it is stored on every queued run, so renaming
/// it orphans the notifications already in flight.
pub const TASK_TYPE: &str = "notify.deliver";

/// Attempts before a notification is dead-lettered.
///
/// More than the task default because a chat platform's refusals skew
/// transient — a 429 clears on its own, and giving up after five backoffs
/// would drop a message the platform was only asking us to slow down about.
pub const MAX_ATTEMPTS: i16 = 8;

// Not decoration, and checked at compile time: chat-platform failures skew
// transient, so inheriting the task default would drop messages on a rate
// limit. If the default ever rises past this, the override has stopped meaning
// anything and should be revisited rather than left as a smaller number.
const _: () = assert!(MAX_ATTEMPTS > crate::tasks::DEFAULT_MAX_ATTEMPTS);

/// What the accept path puts on the queue. The message itself, because the run
/// is the only record there is.
///
/// Flat rather than a tagged enum, and the destination is decided by which
/// field is present: a `workspace_id` means the IDE, a `connection_id` means a
/// chat channel. That is not how a public API should be shaped, but this
/// payload is read back out of runs that were queued by *older* builds of this
/// gear — which wrote no tag at all — and a field-presence rule keeps every one
/// of them readable without a migration.
#[derive(Debug, Clone, Deserialize)]
pub struct DeliveryPayload {
    /// Chat destination: the connector connection to deliver through.
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// Channel, for a provider that takes one. Absent for an incoming webhook,
    /// whose channel is fixed in the URL.
    #[serde(default)]
    pub target: Option<String>,
    /// Editor destination: the workspace whose IDE session gets the message.
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
    /// `info` | `warn` | `error`, for the editor destination. Normalized by the
    /// accept path, so anything unexpected here came from an older build.
    #[serde(default)]
    #[cfg_attr(
        not(feature = "theia-bridge"),
        allow(
            dead_code,
            reason = "read by the editor destination, which needs the theia-bridge feature"
        )
    )]
    pub level: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub link: Option<String>,
    /// Zulip topic; ignored by the other platforms.
    #[serde(default)]
    pub topic: Option<String>,
}

/// Where one queued message is going.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    Chat(Uuid),
    Editor(Uuid),
}

impl DeliveryPayload {
    /// Which destination this payload names.
    ///
    /// A payload naming both is refused rather than guessed: the accept path
    /// cannot produce one, so it means a caller wrote a run row by hand or a
    /// future build changed the shape — either way, picking one silently would
    /// send the message somewhere nobody asked for.
    pub fn bound(&self) -> anyhow::Result<Bound> {
        match (self.connection_id, self.workspace_id) {
            (Some(connection), None) => Ok(Bound::Chat(connection)),
            (None, Some(workspace)) => Ok(Bound::Editor(workspace)),
            (Some(_), Some(_)) => Err(anyhow::anyhow!(
                "this run names both a connection and a workspace, so there is no way \
                 to tell where the message was meant to go"
            )),
            (None, None) => Err(anyhow::anyhow!(
                "this run names neither a connection nor a workspace to deliver to"
            )),
        }
    }
}

/// Whether an error is worth another attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The platform, the network or the deployment might behave differently in
    /// a minute.
    Transient,
    /// Nothing will change without a human: a revoked credential, a channel the
    /// bot was never invited to, a connection that has been deleted.
    Permanent,
}

/// Read a verdict out of a driver's error message.
///
/// Ordered permanent-first: `invalid_auth` is decisive even when it arrives
/// inside a response whose status might otherwise read as transient.
pub fn classify(error: &str) -> Verdict {
    let e = error.to_lowercase();

    // Credentials, permissions and addressing. A human has to fix these.
    const PERMANENT: [&str; 18] = [
        "invalid_auth",
        "not_authed",
        "account_inactive",
        "token_revoked",
        "missing_scope",
        "no_permission",
        "channel_not_found",
        "not_in_channel",
        "is_archived",
        "missing access",
        "unknown channel",
        "unknown webhook",
        "no_service",
        "invalid_payload",
        "does not exist",
        // The URL guard and the credential-shape checks in this crate.
        "must be an https:// url",
        // The connection is gone from the catalogue, or its provider is not in
        // this deployment. Neither reappears by waiting, and a queued delivery
        // outliving its connection is the ordinary way this happens.
        "not found",
        "no driver for provider",
    ];
    if PERMANENT.iter().any(|p| e.contains(p)) {
        return Verdict::Permanent;
    }

    // A credential this worker cannot read will never become readable by
    // waiting. The accept path refuses personal-scoped connections for exactly
    // this reason; anything that still lands here is a misconfiguration.
    if e.contains("not readable") {
        return Verdict::Permanent;
    }

    // Rate limits and the platform being unwell.
    const TRANSIENT: [&str; 8] = [
        "ratelimited",
        "rate limit",
        "429",
        " 500",
        " 502",
        " 503",
        " 504",
        "timed out",
    ];
    if TRANSIENT.iter().any(|t| e.contains(t)) {
        return Verdict::Transient;
    }

    // Unknown. Retry, bounded by MAX_ATTEMPTS — see the module note.
    Verdict::Transient
}

/// Delivers queued notifications.
pub struct DeliveryTask {
    hub: Arc<ClientHub>,
}

impl DeliveryTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

#[async_trait]
impl TaskHandler for DeliveryTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        MAX_ATTEMPTS
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: DeliveryPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(payload) => payload,
            // A payload this code cannot read will not become readable on a
            // retry — it was written by a different version of this gear.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-notify: this run's payload is not a delivery ({e})"
                ));
            }
        };

        let bound = match payload.bound() {
            Ok(bound) => bound,
            // Same reasoning as an unreadable payload: no retry can fix it.
            Err(e) => return TaskOutcome::Failed(format!("studio-notify: {e}")),
        };

        match bound {
            Bound::Chat(connection_id) => self.to_chat(ctx, connection_id, payload).await,
            Bound::Editor(workspace_id) => self.to_editor(ctx, workspace_id, payload).await,
        }
    }
}

impl DeliveryTask {
    /// Post to Slack/Zulip/Discord through the connector drivers.
    async fn to_chat(
        &self,
        ctx: &TaskContext,
        connection_id: Uuid,
        payload: DeliveryPayload,
    ) -> TaskOutcome {
        let sender = match self
            .hub
            .get_scoped::<dyn NotificationSender>(&ClientScope::gts_id(NOTIFY_SENDER_INSTANCE_ID))
        {
            Ok(sender) => sender,
            // studio-connector stood down (no driver plugin linked). A
            // deployment state, not a property of the message.
            Err(e) => {
                warn!("studio-notify: no notification sender registered — waiting: {e}");
                return TaskOutcome::Retry(format!("no notification sender available: {e}"));
            }
        };

        let message = NotifyMessage {
            text: payload.text,
            title: payload.title,
            link: payload.link,
            topic: payload.topic,
        };

        match sender
            .deliver(
                &ctx.security,
                ctx.tenant,
                connection_id,
                payload.target.as_deref(),
                &message,
            )
            .await
        {
            Ok(sent) => TaskOutcome::done_with(
                match &sent.id {
                    Some(id) => format!("delivered to {} ({id})", sent.target),
                    None => format!("delivered to {}", sent.target),
                },
                // Where it landed and the platform's own message id, for
                // anything that wants to link to the post rather than read a
                // sentence about it.
                serde_json::json!({
                    "target": sent.target,
                    "platform_message_id": sent.id,
                }),
            ),
            Err(e) => {
                let error = format!("{e:#}");
                match classify(&error) {
                    Verdict::Permanent => TaskOutcome::Failed(error),
                    Verdict::Transient => TaskOutcome::Retry(error),
                }
            }
        }
    }

    /// Show the message in a workspace's running IDE, through the studio-theia
    /// control bridge.
    #[cfg(not(feature = "theia-bridge"))]
    async fn to_editor(
        &self,
        _ctx: &TaskContext,
        workspace_id: Uuid,
        _payload: DeliveryPayload,
    ) -> TaskOutcome {
        // The accept path refuses this build's IDE destinations, so a run that
        // gets here was queued by a binary that had the bridge and delivered by
        // one that does not. Permanent: this process will never grow it.
        TaskOutcome::Failed(format!(
            "studio-notify: this build cannot notify the IDE for workspace {workspace_id} \
             — it was compiled without the `theia-bridge` feature"
        ))
    }

    #[cfg(feature = "theia-bridge")]
    async fn to_editor(
        &self,
        ctx: &TaskContext,
        workspace_id: Uuid,
        payload: DeliveryPayload,
    ) -> TaskOutcome {
        let editor = match self.hub.get::<dyn TheiaControlClientV1>() {
            Ok(editor) => editor,
            // studio-theia stood down (the bridge is off in this deployment).
            // A deployment state, not a property of the message — and the
            // accept path already refuses this, so a run that reaches here was
            // queued while the bridge was still wired.
            Err(e) => {
                warn!("studio-notify: no IDE bridge registered — waiting: {e}");
                return TaskOutcome::Retry(format!("no IDE bridge available: {e}"));
            }
        };

        // The body the IDE shows. `title` is the headline it leads with, so the
        // text becomes the detail line beneath it; with no title, the text *is*
        // the headline.
        let (message, detail) = match payload.title {
            Some(title) => (title, Some(payload.text)),
            None => (payload.text, None),
        };
        let request = NotifyEditor {
            level: payload.level.unwrap_or_else(|| "info".to_owned()),
            message,
            detail: detail.filter(|d| !d.trim().is_empty()),
            link: payload.link,
            source: Some("Studio".to_owned()),
        };

        match editor
            .notify_editor(&ctx.security, &SessionTarget { workspace_id }, &request)
            .await
        {
            Ok(result) if result.shown => TaskOutcome::done_with(
                format!("shown in the IDE for workspace {workspace_id}"),
                serde_json::json!({ "shown": true, "workspace_id": workspace_id }),
            ),
            // The session answered, and said no editor was open to show it. The
            // delivery happened; nobody saw it. Recorded as what it is rather
            // than dressed up as either success or failure — a person reading
            // the run's history is exactly who needs to know the difference.
            Ok(_) => TaskOutcome::done_with(
                format!(
                    "the IDE session for workspace {workspace_id} took the message, but no \
                     editor was open to show it"
                ),
                serde_json::json!({ "shown": false, "workspace_id": workspace_id }),
            ),
            // Everything the bridge fails with is worth another attempt: a
            // session restarting, a control port not yet listening, the
            // discovery client mid-boot. There is no permanent case — a
            // workspace that no longer has a session may have one again in a
            // minute, and the attempt cap is what ends it.
            Err(e) => TaskOutcome::Retry(format!(
                "cannot reach the IDE for workspace {workspace_id}: {e}"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_and_addressing_failures_are_permanent() {
        for error in [
            "Slack auth.test: invalid_auth",
            "Slack chat.postMessage: not_in_channel",
            "Slack chat.postMessage: missing_scope (needs scope chat:write)",
            "Slack webhook 404: no_service",
            "Discord 403: Missing Access",
            "Zulip messages 400: Channel 'releases' does not exist",
            "Webhook URL must be an https:// URL — a token or webhook secret must not travel over http",
            "the token for connection 'Releases' is not readable",
            "connection 3f7c1d84-9b2e-4a55-8c17-6e0b2f9d41aa not found",
            "no driver for provider 'slack' in this deployment",
        ] {
            assert_eq!(classify(error), Verdict::Permanent, "{error}");
        }
    }

    #[test]
    fn rate_limits_and_outages_are_transient() {
        for error in [
            "Slack chat.postMessage: ratelimited",
            "Discord 429: {\"retry_after\": 2.5}",
            "Zulip messages 502: bad gateway",
            "Discord 503",
            "error sending request: operation timed out",
        ] {
            assert_eq!(classify(error), Verdict::Transient, "{error}");
        }
    }

    #[test]
    fn an_unrecognised_error_is_retried_rather_than_dropped() {
        // The default matters more than the list: a message must never be
        // discarded because nobody taught `classify` about its error. The cap
        // on attempts is what stops it retrying forever.
        assert_eq!(
            classify("something nobody has seen before"),
            Verdict::Transient
        );
    }

    #[test]
    fn a_chat_payload_round_trips_through_the_queue() {
        let json = serde_json::json!({
            "connection_id": "11111111-2222-3333-4444-555555555555",
            "target": "C0ABC",
            "title": "Build failed",
            "text": "3 tests red",
            "link": "https://ci/1",
        });
        let payload: DeliveryPayload = serde_json::from_value(json).unwrap();
        assert_eq!(payload.target.as_deref(), Some("C0ABC"));
        assert_eq!(payload.text, "3 tests red");
        assert!(payload.topic.is_none());
        assert_eq!(
            payload.bound().unwrap(),
            Bound::Chat(Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap())
        );
    }

    #[test]
    fn an_editor_payload_round_trips_through_the_queue() {
        let json = serde_json::json!({
            "workspace_id": "22222222-3333-4444-5555-666666666666",
            "level": "warn",
            "text": "the import failed",
        });
        let payload: DeliveryPayload = serde_json::from_value(json).unwrap();
        assert_eq!(payload.level.as_deref(), Some("warn"));
        assert_eq!(
            payload.bound().unwrap(),
            Bound::Editor(Uuid::parse_str("22222222-3333-4444-5555-666666666666").unwrap())
        );
    }

    #[test]
    fn a_payload_naming_no_destination_is_refused_where_it_is_read() {
        // A run that named nowhere to deliver could only dead-letter, so it is
        // better refused with a sentence than attempted.
        let payload: DeliveryPayload =
            serde_json::from_value(serde_json::json!({ "text": "hello" })).unwrap();
        let err = payload.bound().unwrap_err().to_string();
        assert!(
            err.contains("neither a connection nor a workspace"),
            "{err}"
        );
    }

    #[test]
    fn a_payload_naming_both_destinations_is_refused_rather_than_guessed() {
        let payload: DeliveryPayload = serde_json::from_value(serde_json::json!({
            "connection_id": "11111111-2222-3333-4444-555555555555",
            "workspace_id": "22222222-3333-4444-5555-666666666666",
            "text": "hello",
        }))
        .unwrap();
        assert!(payload.bound().is_err());
    }
}
