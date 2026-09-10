//! REST surface for queued notifications: one route.
//!
//! A caller hands over a notification and gets a run id. `202 Accepted` is the
//! honest status — the message is durably queued, and whether Slack takes it is
//! not yet known.
//!
//! There is deliberately nothing else here. What happened to a notification is
//! `GET /studio-tasks/v1/runs/{id}`, what needs attention is
//! `GET /studio-tasks/v1/runs?task_type=notify.deliver&state=failed`, and
//! putting a failed one back on the queue is `POST …/runs/{id}/retry`. Runs are
//! the record, so a second set of read routes over the same rows would only be
//! a second thing to keep in step.
//!
//! The synchronous route next door,
//! `POST /studio-connector/v1/connections/{id}/messages`, still exists and
//! still answers with what the platform said. That one is for a human pressing
//! "send a test message"; this one is for everything that must not be lost.

use std::sync::Arc;

use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{Destination, NewDelivery, NotifyService};

/// Errors attributable to a delivery as a resource.
#[resource_error(gts_id!("cf.studio.notify.delivery.v1~"))]
pub struct StudioNotifyError;

/// Service handle. Always present — this gear has no database to stand down
/// over; a deployment without the task queue is reported per request instead,
/// because that is a property of the queue and not of this gear.
#[derive(Clone)]
pub struct Notify(pub Arc<NotifyService>);

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SendRequest {
    /// Chat destination: the connection to deliver through, from
    /// `GET /studio-connector/v1/connections`. Give this or `workspace_id`,
    /// never both.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// Channel, from `GET /studio-connector/v1/connections/{id}/targets`.
    /// Omitted for a provider whose credential fixes the channel.
    #[serde(default)]
    pub target: Option<String>,
    /// Editor destination: the workspace whose running IDE shows the message,
    /// through the studio-theia control bridge. Give this or `connection_id`.
    ///
    /// Refused unless that workspace has a live session right now — a
    /// notification nobody can see is not worth queuing.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
    /// How the IDE styles it: `info` (default) | `warn` | `error`. Only for
    /// `workspace_id`; a chat platform has no notion of severity.
    #[serde(default)]
    pub level: Option<String>,
    /// A short headline, rendered bold above the body.
    #[serde(default)]
    pub title: Option<String>,
    /// The message body. Markdown-ish; each driver renders it into its own
    /// platform's idiom.
    pub text: String,
    /// A link to the thing this is about, appended as its own line.
    #[serde(default)]
    pub link: Option<String>,
    /// Thread/topic within the channel. Required by Zulip, which supplies a
    /// default when it is absent; ignored by Slack and Discord.
    #[serde(default)]
    pub topic: Option<String>,
    /// Repeat-safe key. A second request with the same key in the same tenant
    /// returns the first run rather than queuing another — which is what makes
    /// a caller's own retry safe.
    #[serde(default)]
    pub idempotency_key: Option<String>,
    /// Tenant that owns the connection. Omitted = the caller's own.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub tenant_id: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct QueuedDto {
    /// The run that will deliver this. Poll it at
    /// `GET /studio-tasks/v1/runs/{run_id}`.
    #[schema(value_type = String)]
    pub run_id: Uuid,
    /// Where to look, spelled out so a caller does not have to know how the
    /// two gears divide the work.
    pub poll: String,
}

/* ── Handler ── */

async fn send(
    Extension(ctx): Extension<SecurityContext>,
    Extension(notify): Extension<Notify>,
    Json(req): Json<SendRequest>,
) -> ApiResult<(StatusCode, JsonBody<QueuedDto>)> {
    // Exactly one destination. Refused rather than defaulted: a caller who
    // names both has two different ideas about where this message goes, and
    // picking one is how a notification ends up somewhere nobody expected.
    let to = match (req.connection_id, req.workspace_id) {
        (Some(connection_id), None) => Destination::Chat {
            connection_id,
            target: req.target.as_deref(),
        },
        (None, Some(workspace_id)) => Destination::Editor {
            workspace_id,
            level: req.level.as_deref().unwrap_or("info"),
        },
        _ => {
            return Err(StudioNotifyError::invalid_argument()
                .with_constraint(
                    "name exactly one destination: `connection_id` for a chat channel, or \
                     `workspace_id` for the IDE of whoever has that workspace open",
                )
                .create());
        }
    };

    let run_id = notify
        .0
        .accept(
            &ctx,
            NewDelivery {
                tenant: req.tenant_id.unwrap_or_else(|| ctx.subject_tenant_id()),
                to,
                title: req.title.as_deref(),
                text: &req.text,
                link: req.link.as_deref(),
                topic: req.topic.as_deref(),
                idempotency_key: req.idempotency_key.as_deref(),
            },
        )
        .await
        // Everything `accept` refuses is the caller's to fix: an unusable
        // connection, a missing or a forbidden target, an empty message. The
        // message is queued only after all of it passes.
        .map_err(|e| {
            StudioNotifyError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok((
        StatusCode::ACCEPTED,
        Json(QueuedDto {
            run_id,
            poll: format!("/studio-tasks/v1/runs/{run_id}"),
        }),
    ))
}

/* ── Registration ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<NotifyService>,
) -> Router {
    router = OperationBuilder::post("/studio-notify/v1/messages")
        .operation_id("studio_notify.send")
        .summary("Queue a notification for delivery")
        .description(
            "Queues the message as a `notify.deliver` run and answers 202 with its \
             id. Two kinds of destination: `connection_id` posts to a Slack, Zulip \
             or Discord channel, and `workspace_id` shows the message in the Theia \
             IDE of whoever has that workspace open. Whichever it is, it is \
             verified while there is still a request to answer — an unusable \
             connection, a missing channel, a channel sent to a webhook \
             connection, or a workspace with no live IDE session are all 400 here \
             rather than a failed delivery later. Delivery is retried with \
             exponential backoff and dead-lettered after several attempts; the run \
             carries the outcome, so poll `GET /studio-tasks/v1/runs/{id}`. Pass \
             `idempotency_key` to make your own retry of this request safe.",
        )
        .tag("StudioNotify")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SendRequest>(openapi, "The notification to deliver")
        .handler(send)
        .json_response_with_schema::<QueuedDto>(openapi, StatusCode::ACCEPTED, "Queued")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Notify(service)))
}
