//! Slack drivers: a bot token, and an incoming webhook.
//!
//! Two connection shapes, because Slack has two answers to "let an app post
//! here" and they are not interchangeable:
//!
//! * **Bot token** (`slack`) — one connection for the whole workspace. The
//!   channels are enumerable (`conversations.list`) and each message names the
//!   one it goes to, so a workspace owner configures Slack once and every
//!   caller afterwards picks a channel. Needs an app with `chat:write` and
//!   `channels:read`, and the bot invited to each channel it posts in.
//! * **Incoming webhook** (`slack_webhook`) — a URL that posts to exactly one
//!   channel, created by whoever owns that channel. Nothing to enumerate and
//!   no app to install; the cost is one connection per channel.
//!
//! ## Errors arrive with HTTP 200
//!
//! Slack's Web API answers a rejected call with `200 OK` and `{"ok": false,
//! "error": "channel_not_found"}`. A driver that only checked the status would
//! report every failure as a success, so every response here goes through
//! [`slack_envelope`], and `error` is what the caller is told — those strings
//! (`not_in_channel`, `missing_scope`, `invalid_auth`) are the actual
//! diagnosis and are worth passing through verbatim.

use async_trait::async_trait;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, NotifyMessage,
    NotifyTarget, SentMessage,
};
use super::notify::{HostRule, check_url, http_error, render, truncate};

/// Slack has no self-hosted form, so any other host is a mistake worth naming.
const SLACK_HOSTS: &[&str] = &["slack.com"];

/// `chat.postMessage` accepts 40 000 characters but renders anything past a
/// few thousand as a "click to expand" stub, which is not what a notification
/// is for. Cut it here so the platform does not.
const TEXT_LIMIT: usize = 4000;

/// One page of `conversations.list`. Slack caps `limit` at 1000 and pages with
/// an opaque cursor.
const PAGE: u32 = 200;

/// How many pages one listing will walk before giving up. `PAGE * MAX_PAGES`
/// channels is far past what a channel picker can be used for, and the point
/// is the bound rather than the number.
const MAX_PAGES: usize = 25;

fn probe() -> NotifyMessage {
    NotifyMessage {
        title: Some("Constructor Studio".into()),
        text: "This channel is connected to Constructor Studio.".into(),
        ..Default::default()
    }
}

/// Unwrap Slack's `{ok, …}` envelope, turning `ok: false` into an error that
/// carries the platform's own reason.
async fn slack_envelope<T: DeserializeOwned>(
    res: reqwest::Response,
    method: &str,
) -> anyhow::Result<T> {
    if !res.status().is_success() {
        return Err(http_error(res, "Slack").await);
    }
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("Slack {method}: response was not JSON ({e})"))?;
    if body.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let reason = body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown error");
        // `needed` names the scope the app is missing, which is the one thing
        // that turns "missing_scope" into an action.
        let needed = body
            .get("needed")
            .and_then(serde_json::Value::as_str)
            .map(|n| format!(" (needs scope {n})"))
            .unwrap_or_default();
        return Err(anyhow::anyhow!("Slack {method}: {reason}{needed}"));
    }
    serde_json::from_value(body)
        .map_err(|e| anyhow::anyhow!("Slack {method}: unexpected response shape ({e})"))
}

#[derive(Deserialize)]
struct AuthTest {
    #[serde(default)]
    team: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize)]
struct Conversation {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    is_private: bool,
    #[serde(default)]
    is_archived: bool,
}

#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct ConversationList {
    #[serde(default)]
    channels: Vec<Conversation>,
    #[serde(default)]
    response_metadata: Option<Cursor>,
}

#[derive(Deserialize)]
struct PostedMessage {
    #[serde(default)]
    channel: Option<String>,
    /// Slack's message id, and the thread key: a timestamp string.
    #[serde(default)]
    ts: Option<String>,
}

/* ── Bot token ── */

pub struct SlackDriver {
    http: reqwest::Client,
}

impl SlackDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// The API root, validated. `base_url` is a free-form field on the
    /// connection, so it is checked on every use rather than trusted from
    /// whenever it was typed.
    fn root(&self, auth: &ConnectionAuth) -> anyhow::Result<String> {
        check_url(
            auth.base_url.trim_end_matches('/'),
            "Slack API URL",
            HostRule::OneOf(SLACK_HOSTS),
        )?;
        Ok(auth.root().to_string())
    }
}

#[async_trait]
impl ConnectorDriver for SlackDriver {
    fn provider(&self) -> &'static str {
        "slack"
    }

    fn display_name(&self) -> &'static str {
        "Slack"
    }

    fn default_base_url(&self) -> &'static str {
        "https://slack.com/api"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Notification
    }

    fn credential_label(&self) -> &'static str {
        "Bot User OAuth Token"
    }

    fn credential_hint(&self) -> &'static str {
        "xoxb-… (scopes: chat:write, channels:read)"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let res = self
            .http
            .post(format!("{}/auth.test", self.root(auth)?))
            .bearer_auth(&auth.token)
            .send()
            .await?;
        let who: AuthTest = slack_envelope(res, "auth.test").await?;
        let team = who.team.unwrap_or_else(|| "unknown workspace".into());
        Ok(DriverIdentity {
            account: match who.user {
                Some(user) => format!("{user} in {team}"),
                None => team,
            },
            display_name: who.url,
        })
    }

    async fn list_targets(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<NotifyTarget>> {
        let root = self.root(auth)?;
        let needle = search
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        let page_size = PAGE.to_string();

        // Paged rather than one big request: `limit` filters *after* Slack
        // has taken its page, so a workspace with many channels can answer a
        // filtered query with an empty page and a cursor. Stop on a page that
        // brings no cursor, once the caller has what it asked for, or at
        // MAX_PAGES — which is what keeps this bounded. A cursor that never
        // empties would otherwise turn one API request into an unbounded walk,
        // and the caller is an HTTP handler waiting on it.
        for _ in 0..MAX_PAGES {
            let mut req = self
                .http
                .get(format!("{root}/conversations.list"))
                .bearer_auth(&auth.token)
                .query(&[
                    ("types", "public_channel,private_channel"),
                    ("exclude_archived", "true"),
                    ("limit", page_size.as_str()),
                ]);
            if let Some(c) = cursor.as_deref() {
                req = req.query(&[("cursor", c)]);
            }
            let page: ConversationList =
                slack_envelope(req.send().await?, "conversations.list").await?;

            for c in page.channels {
                if c.is_archived {
                    continue;
                }
                let name = c.name.unwrap_or_else(|| c.id.clone());
                if let Some(needle) = needle.as_deref()
                    && !name.to_lowercase().contains(needle)
                {
                    continue;
                }
                out.push(NotifyTarget {
                    id: c.id,
                    name,
                    container: None,
                    private: c.is_private,
                    topic_required: false,
                });
                if out.len() as u32 >= limit {
                    return Ok(out);
                }
            }

            cursor = page
                .response_metadata
                .and_then(|m| m.next_cursor)
                .filter(|c| !c.is_empty());
            if cursor.is_none() {
                return Ok(out);
            }
        }
        // Ran out of pages with a cursor still in hand. Not an error: what is
        // returned is a truthful prefix of a very long channel list, and the
        // caller asked for at most `limit` of them anyway.
        tracing::warn!(
            provider = self.provider(),
            pages = MAX_PAGES,
            "slack: channel listing stopped at the page cap — narrow it with a search"
        );
        Ok(out)
    }

    async fn send_message(
        &self,
        auth: &ConnectionAuth,
        target: Option<&str>,
        message: &NotifyMessage,
    ) -> anyhow::Result<SentMessage> {
        let channel = target
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "a Slack bot connection reaches every channel it was invited to, \
                     so the message must name one"
                )
            })?;
        let text = truncate(&render(message, "*"), TEXT_LIMIT);
        let res = self
            .http
            .post(format!("{}/chat.postMessage", self.root(auth)?))
            .bearer_auth(&auth.token)
            .json(&json!({ "channel": channel, "text": text }))
            .send()
            .await?;
        let posted: PostedMessage = slack_envelope(res, "chat.postMessage").await?;
        Ok(SentMessage {
            target: posted.channel.unwrap_or_else(|| channel.to_string()),
            id: posted.ts,
        })
    }
}

/* ── Incoming webhook ── */

/// A Slack incoming webhook. The credential is the URL itself.
pub struct SlackWebhookDriver {
    http: reqwest::Client,
}

impl SlackWebhookDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    async fn post(&self, auth: &ConnectionAuth, text: &str) -> anyhow::Result<()> {
        let url = check_url(&auth.token, "Webhook URL", HostRule::OneOf(SLACK_HOSTS))?;
        let res = self
            .http
            .post(url)
            .json(&json!({ "text": text }))
            .send()
            .await?;
        if !res.status().is_success() {
            // Slack answers a webhook with a plain-text reason: `no_service`
            // for a URL that has been revoked, `channel_not_found` for a
            // channel that is gone, `invalid_payload` for a malformed body.
            return Err(http_error(res, "Slack webhook").await);
        }
        Ok(())
    }
}

#[async_trait]
impl ConnectorDriver for SlackWebhookDriver {
    fn provider(&self) -> &'static str {
        "slack_webhook"
    }

    fn display_name(&self) -> &'static str {
        "Slack (incoming webhook)"
    }

    /// Informational only: this driver reads the URL from the credential, not
    /// from the connection's installation root. Offered as the placeholder so
    /// the form shows where the URL comes from.
    fn default_base_url(&self) -> &'static str {
        "https://hooks.slack.com"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Notification
    }

    fn credential_label(&self) -> &'static str {
        "Webhook URL"
    }

    fn credential_hint(&self) -> &'static str {
        "https://hooks.slack.com/services/T…/B…/…"
    }

    fn fixed_target(&self) -> bool {
        true
    }

    /// Verifying a Slack webhook **posts a message**.
    ///
    /// Slack exposes no way to ask whether a webhook URL is live: there is no
    /// metadata endpoint, and the only documented interaction is a POST that
    /// delivers. So the test delivers — one line saying the channel is now
    /// connected, which is a reasonable thing for the channel to receive at
    /// the moment somebody connects it, and the honest alternative to
    /// reporting a credential as good without having tried it.
    ///
    /// This runs on create and on every explicit re-test, both of which are
    /// deliberate acts by a human. Nothing else calls it.
    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        self.post(auth, &render(&probe(), "*")).await?;
        Ok(DriverIdentity {
            account: "Slack incoming webhook".into(),
            display_name: Some(
                "verified by delivering a message — Slack does not describe a webhook \
                 without posting to it"
                    .into(),
            ),
        })
    }

    async fn send_message(
        &self,
        auth: &ConnectionAuth,
        _target: Option<&str>,
        message: &NotifyMessage,
    ) -> anyhow::Result<SentMessage> {
        let text = truncate(&render(message, "*"), TEXT_LIMIT);
        self.post(auth, &text).await?;
        Ok(SentMessage {
            // A webhook response carries no channel and no message id — the
            // body is the string `ok`. Naming the connection's own shape is
            // the most this can honestly report.
            target: "the channel this webhook posts to".into(),
            id: None,
        })
    }
}
