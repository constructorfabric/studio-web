//! Accepting a notification: validate it, then hand it to the task queue.
//!
//! Everything durable belongs to `studio-tasks` now — the run *is* the record.
//! What is left here is the part that has to happen while there is still a
//! request to answer: resolving the connection with the caller's own context,
//! and refusing the three things that would otherwise become a dead letter
//! nobody is watching.

use std::sync::Arc;

use anyhow::anyhow;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::connectors::{NOTIFY_SENDER_INSTANCE_ID, NotificationSender};
#[cfg(feature = "theia-bridge")]
use crate::studio_theia::sdk::{SessionTarget, TheiaControlClientV1};
use crate::tasks::service::NewRun;
use crate::tasks::{TASK_QUEUE_INSTANCE_ID, TaskQueue};

use super::handler::TASK_TYPE;

/// Where a notification is going.
///
/// Two kinds, because they are genuinely different things and pretending
/// otherwise would cost more than it saves. A chat connection is a credential
/// to somebody else's system and its channel waits for the message. An IDE
/// session is ours, needs no credential, and is only worth notifying while
/// somebody is sitting in front of it.
#[derive(Debug, Clone, Copy)]
pub enum Destination<'a> {
    /// A Slack/Zulip/Discord connection from `studio-connector`.
    Chat {
        connection_id: Uuid,
        /// Channel, for a provider that takes one.
        target: Option<&'a str>,
    },
    /// The Theia IDE of whoever has this workspace open, through the
    /// studio-theia control bridge.
    Editor {
        workspace_id: Uuid,
        /// `info` | `warn` | `error` — how the IDE styles the notification.
        level: &'a str,
    },
}

/// One request to deliver a notification.
#[derive(Debug, Clone)]
pub struct NewDelivery<'a> {
    /// Tenant that owns the connection, or the session.
    pub tenant: Uuid,
    pub to: Destination<'a>,
    pub title: Option<&'a str>,
    pub text: &'a str,
    pub link: Option<&'a str>,
    pub topic: Option<&'a str>,
    /// Repeat-safe key. A second accept with the same key in the same tenant
    /// returns the first run rather than queuing another.
    pub idempotency_key: Option<&'a str>,
}

pub struct NotifyService {
    hub: Arc<ClientHub>,
}

impl NotifyService {
    pub fn new(hub: Arc<ClientHub>) -> Arc<Self> {
        Arc::new(Self { hub })
    }

    /// Both clients are resolved per request rather than at init, which is what
    /// makes this gear independent of the order the others initialize in.
    fn sender(&self) -> anyhow::Result<Arc<dyn NotificationSender>> {
        self.hub
            .get_scoped::<dyn NotificationSender>(&ClientScope::gts_id(NOTIFY_SENDER_INSTANCE_ID))
            .map_err(|_| {
                anyhow!(
                    "notification delivery is not available in this deployment \
                     (studio-connector registered no driver plugin)"
                )
            })
    }

    /// The IDE bridge. Absent where `studio-theia` stood down — the gear is
    /// dormant unless `studio-session.theia_control_enabled` is on.
    #[cfg(feature = "theia-bridge")]
    fn editor(&self) -> anyhow::Result<Arc<dyn TheiaControlClientV1>> {
        self.hub.get::<dyn TheiaControlClientV1>().map_err(|_| {
            anyhow!(
                "notifying an IDE is not available in this deployment \
                 (studio-theia is not wired — see `theia_control_enabled`)"
            )
        })
    }

    fn queue(&self) -> anyhow::Result<Arc<dyn TaskQueue>> {
        self.hub
            .get_scoped::<dyn TaskQueue>(&ClientScope::gts_id(TASK_QUEUE_INSTANCE_ID))
            .map_err(|_| {
                anyhow!(
                    "the task queue is not available in this deployment \
                     (studio-tasks has no database configured), so nothing can be queued"
                )
            })
    }

    /// Refuse now if this workspace has no IDE that could show a notification.
    ///
    /// The bridge resolves the workspace to a live session under the caller's
    /// own context, so an unknown workspace, a session nobody started, and a
    /// deployment with the bridge switched off are all answered here rather
    /// than becoming a dead letter nobody is watching. A toast is only worth
    /// queuing if somebody could see it.
    #[cfg(feature = "theia-bridge")]
    async fn editor_preflight(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> anyhow::Result<()> {
        let status = self
            .editor()?
            .get_runtime_status(ctx, &SessionTarget { workspace_id })
            .await
            .map_err(|e| {
                anyhow!(
                    "no IDE session to notify for workspace {workspace_id}: {e}. Start a \
                     session, or send this to a chat connection instead"
                )
            })?;
        if !status.ready {
            return Err(anyhow!(
                "the IDE session for workspace {workspace_id} is still starting up (mode \
                 '{}'), so it has nothing to show a notification in yet",
                status.workspace_mode
            ));
        }
        Ok(())
    }

    /// The same preflight where the bridge is not linked: ADR-0010's gear is
    /// behind the opt-in `theia-bridge` feature, and a build without it cannot
    /// reach any IDE. Said plainly, rather than queuing a run that could only
    /// dead-letter.
    #[cfg(not(feature = "theia-bridge"))]
    async fn editor_preflight(
        &self,
        _ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> anyhow::Result<()> {
        Err(anyhow!(
            "this build cannot notify the IDE for workspace {workspace_id}: studio-backend \
             was compiled without the `theia-bridge` feature. Send this to a chat \
             connection instead"
        ))
    }

    /// Verify and queue one notification. Returns the run id.
    pub async fn accept(
        &self,
        ctx: &SecurityContext,
        req: NewDelivery<'_>,
    ) -> anyhow::Result<Uuid> {
        let text = req.text.trim();
        let title = req.title.map(str::trim).filter(|t| !t.is_empty());
        if text.is_empty() && title.is_none() {
            return Err(anyhow!("a notification needs a text or a title"));
        }

        let link = req.link.map(str::trim).filter(|l| !l.is_empty());

        // Everything below happens with the caller's own context, before
        // anything is queued: a destination that cannot be delivered to is a
        // 400 now rather than a dead letter later, when nobody is watching.
        //
        // The message itself travels in the run's payload, because the run is
        // the only record — a copy in a table of our own would be a second
        // write in a second database, and the crash between those two writes is
        // the lost notification this queue exists to prevent.
        let (payload, partition_key) = match req.to {
            Destination::Chat {
                connection_id,
                target,
            } => {
                let preflight = self
                    .sender()?
                    .preflight(ctx, req.tenant, connection_id)
                    .await?;

                // A personal credential is readable only by its owner, and a
                // queued delivery is performed by a service identity — which is
                // not its owner. Refusing here is the difference between an
                // error the caller can act on and a dead letter that says "not
                // readable".
                if preflight.scope == "personal" {
                    return Err(anyhow!(
                        "connection '{}' is personal to the person who created it, so a \
                         background worker cannot read its credential. Queue through a \
                         workspace- or organization-scoped connection, or post it \
                         synchronously with POST \
                         /studio-connector/v1/connections/{}/messages",
                        preflight.label,
                        connection_id
                    ));
                }

                let target = target.map(str::trim).filter(|t| !t.is_empty());
                match (preflight.fixed_target, target) {
                    (true, Some(_)) => {
                        return Err(anyhow!(
                            "connection '{}' is an incoming webhook: its channel is fixed in \
                             the URL it was created from, so a target cannot be chosen per \
                             message. Send no target, or use a bot-token connection",
                            preflight.label
                        ));
                    }
                    (false, None) => {
                        return Err(anyhow!(
                            "connection '{}' reaches every channel it was invited to, so the \
                             delivery must name one — see GET \
                             /studio-connector/v1/connections/{}/targets",
                            preflight.label,
                            connection_id
                        ));
                    }
                    _ => {}
                }

                (
                    serde_json::json!({
                        "connection_id": connection_id,
                        "target": target,
                        "title": title,
                        "text": text,
                        "link": link,
                        "topic": req.topic.map(str::trim).filter(|t| !t.is_empty()),
                    }),
                    // One connection's notifications never overtake each other:
                    // a "build finished" arriving before its "build started"
                    // reads as a bug in Studio.
                    connection_id.to_string(),
                )
            }
            Destination::Editor {
                workspace_id,
                level,
            } => {
                let level = normalize_level(level)?;
                let payload = serde_json::json!({
                    "workspace_id": workspace_id,
                    "level": level,
                    "title": title,
                    "text": text,
                    "link": link,
                });
                // The preflight is where the two builds differ (see below), so
                // it is a function rather than a `cfg` block in the middle of
                // this one: an early `return` inside a match arm that still has
                // to produce a value is how unreachable code gets written.
                self.editor_preflight(ctx, workspace_id).await?;
                (
                    payload,
                    // One session's notifications keep their order for the same
                    // reason a channel's do.
                    workspace_id.to_string(),
                )
            }
        };

        self.queue()?
            .enqueue(
                ctx,
                NewRun {
                    tenant: req.tenant,
                    task_type: TASK_TYPE,
                    payload,
                    partition_key: Some(&partition_key),
                    idempotency_key: req.idempotency_key,
                },
            )
            .await
    }
}

/// The three levels the IDE knows, from what a caller wrote.
///
/// Refused rather than defaulted: a caller who asked for `critical` and got a
/// grey information toast has been quietly misunderstood, and this is the one
/// place where saying so is still cheap.
fn normalize_level(raw: &str) -> anyhow::Result<&'static str> {
    match raw.trim().to_lowercase().as_str() {
        "" | "info" | "information" => Ok("info"),
        "warn" | "warning" => Ok("warn"),
        "error" => Ok("error"),
        other => Err(anyhow!(
            "unknown notification level '{other}' (expected info | warn | error)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_levels_the_ide_knows_are_accepted_by_the_names_people_use() {
        for (raw, expected) in [
            ("", "info"),
            ("info", "info"),
            ("Information", "info"),
            ("warn", "warn"),
            ("WARNING", "warn"),
            ("error", "error"),
        ] {
            assert_eq!(normalize_level(raw).unwrap(), expected, "{raw}");
        }
    }

    #[test]
    fn an_invented_level_is_refused_rather_than_shown_as_information() {
        let err = normalize_level("critical").unwrap_err().to_string();
        assert!(err.contains("expected info | warn | error"), "{err}");
    }
}
