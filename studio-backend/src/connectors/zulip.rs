//! Zulip drivers: a bot's API key, and a Slack-compatible incoming webhook.
//!
//! ## The credential is two things
//!
//! Zulip authenticates the REST API with HTTP Basic, where the username is the
//! bot's email address and the password is its API key. A connection carries
//! one secret field, so this driver takes both in it, separated by a colon:
//!
//! ```text
//! studio-bot@your-org.zulipchat.com:aBcD1234…
//! ```
//!
//! That is the same pair Zulip's own `curl` examples pass to `-u`, and an
//! email address cannot contain a colon, so the split is unambiguous. The
//! alternative — a second field on every connection, in the API, the DTOs and
//! the form — would exist for one provider out of eight, and the value still
//! has to live in credstore as one secret either way.
//!
//! ## Channels are threaded
//!
//! Every Zulip channel message needs a topic; the platform has no un-threaded
//! form. A caller that supplies none gets [`DEFAULT_TOPIC`] rather than a
//! refusal, because the caller's job is to say what happened, not to know
//! which of three platforms it is talking to — and this is exactly the kind of
//! platform difference [`NotifyTarget::topic_required`] exists to let a UI ask
//! about up front.

use async_trait::async_trait;
use serde::Deserialize;
use serde::de::DeserializeOwned;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, NotifyMessage,
    NotifyTarget, SentMessage,
};
use super::notify::{HostRule, check_url, http_error, render, truncate};

/// Where a message goes when the caller names no topic. Zulip requires one,
/// and a channel with a single well-known Studio topic is easier to mute or
/// follow than one where every message opens a thread of its own.
const DEFAULT_TOPIC: &str = "Constructor Studio";

/// Zulip refuses a message body over 10 000 characters.
const CONTENT_LIMIT: usize = 10_000;

/// The placeholder installation. Left in a connection it would be a dead
/// hostname, so [`ZulipDriver::api`] refuses it by name — a DNS failure is a
/// worse explanation than "you did not replace the placeholder".
const PLACEHOLDER_HOST: &str = "your-org.zulipchat.com";

fn probe() -> NotifyMessage {
    NotifyMessage {
        title: Some("Constructor Studio".into()),
        text: "This channel is connected to Constructor Studio.".into(),
        ..Default::default()
    }
}

/// Split the stored credential into the bot's email and its API key.
fn split_credential(token: &str) -> anyhow::Result<(&str, &str)> {
    let (email, key) = token.trim().split_once(':').ok_or_else(|| {
        anyhow::anyhow!(
            "a Zulip credential is the bot's email address and its API key, \
             separated by a colon (bot@your-org.zulipchat.com:apikey)"
        )
    })?;
    let (email, key) = (email.trim(), key.trim());
    if email.is_empty() || key.is_empty() {
        return Err(anyhow::anyhow!(
            "a Zulip credential needs both halves: bot@your-org.zulipchat.com:apikey"
        ));
    }
    Ok((email, key))
}

/// Unwrap Zulip's `{result, …}` envelope.
///
/// Zulip does use HTTP status codes — a rejected message is a 400 — but the
/// body carries the reason (`STREAM_DOES_NOT_EXIST`, and a `msg` written for a
/// human), so both paths read the body rather than only the status.
async fn zulip_envelope<T: DeserializeOwned>(
    res: reqwest::Response,
    what: &str,
) -> anyhow::Result<T> {
    let status = res.status();
    let body: serde_json::Value = match res.json().await {
        Ok(v) => v,
        // A non-JSON body from a 4xx/5xx is a proxy or a login page, not Zulip.
        Err(e) => {
            return Err(anyhow::anyhow!(
                "Zulip {what} {status}: response was not JSON ({e}) — is the \
                 installation URL right?"
            ));
        }
    };
    if body.get("result").and_then(serde_json::Value::as_str) != Some("success") {
        let msg = body
            .get("msg")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown error");
        return Err(anyhow::anyhow!("Zulip {what} {status}: {msg}"));
    }
    serde_json::from_value(body)
        .map_err(|e| anyhow::anyhow!("Zulip {what}: unexpected response shape ({e})"))
}

#[derive(Deserialize)]
struct Me {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    is_bot: bool,
}

#[derive(Deserialize)]
struct Stream {
    stream_id: i64,
    name: String,
    #[serde(default)]
    invite_only: bool,
    #[serde(default)]
    is_archived: bool,
}

#[derive(Deserialize)]
struct StreamList {
    #[serde(default)]
    streams: Vec<Stream>,
}

#[derive(Deserialize)]
struct Posted {
    #[serde(default)]
    id: Option<i64>,
}

/* ── Bot email + API key ── */

pub struct ZulipDriver {
    http: reqwest::Client,
}

impl ZulipDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// The installation's API root (`…/api/v1`), validated.
    ///
    /// Zulip is commonly self-hosted, so the host cannot be pinned to one
    /// name; what is refused is a target that is not a Zulip installation at
    /// all — plaintext, an internal address, or the untouched placeholder.
    fn api(&self, auth: &ConnectionAuth) -> anyhow::Result<String> {
        let root = auth.root();
        let url = check_url(root, "Zulip installation URL", HostRule::AnyPublic)?;
        if url.host_str() == Some(PLACEHOLDER_HOST) {
            return Err(anyhow::anyhow!(
                "the Zulip installation URL is still the {PLACEHOLDER_HOST} placeholder — \
                 replace it with your own organization's URL"
            ));
        }
        // A base URL that already ends in the API prefix is what somebody
        // copying from Zulip's docs will paste; accept both.
        Ok(match root.strip_suffix("/api/v1") {
            Some(_) => root.to_string(),
            None => format!("{root}/api/v1"),
        })
    }
}

#[async_trait]
impl ConnectorDriver for ZulipDriver {
    fn provider(&self) -> &'static str {
        "zulip"
    }

    fn display_name(&self) -> &'static str {
        "Zulip"
    }

    fn default_base_url(&self) -> &'static str {
        "https://your-org.zulipchat.com"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Notification
    }

    fn credential_label(&self) -> &'static str {
        "Bot email and API key"
    }

    fn credential_hint(&self) -> &'static str {
        "bot@your-org.zulipchat.com:apikey"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let (email, key) = split_credential(&auth.token)?;
        let res = self
            .http
            .get(format!("{}/users/me", self.api(auth)?))
            .basic_auth(email, Some(key))
            .send()
            .await?;
        let me: Me = zulip_envelope(res, "users/me").await?;
        let account = me.email.unwrap_or_else(|| email.to_string());
        Ok(DriverIdentity {
            display_name: Some(match (me.full_name, me.is_bot) {
                (Some(name), true) => format!("{name} (bot)"),
                (Some(name), false) => {
                    format!("{name} — a human account; a bot account is the safer credential here")
                }
                (None, _) => "Zulip account".into(),
            }),
            account,
        })
    }

    async fn list_targets(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<NotifyTarget>> {
        let (email, key) = split_credential(&auth.token)?;
        let res = self
            .http
            // Every channel the credential can see, not only those it is
            // subscribed to: a bot posts into channels it does not follow.
            .get(format!("{}/streams", self.api(auth)?))
            .basic_auth(email, Some(key))
            .query(&[("exclude_archived", "true")])
            .send()
            .await?;
        let list: StreamList = zulip_envelope(res, "streams").await?;
        let needle = search
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        Ok(list
            .streams
            .into_iter()
            .filter(|s| !s.is_archived)
            .filter(|s| match needle.as_deref() {
                Some(n) => s.name.to_lowercase().contains(n),
                None => true,
            })
            .take(limit as usize)
            .map(|s| NotifyTarget {
                // The numeric id, not the name: a channel can be renamed and
                // a stored target must survive it.
                id: s.stream_id.to_string(),
                name: s.name,
                container: None,
                private: s.invite_only,
                topic_required: true,
            })
            .collect())
    }

    async fn send_message(
        &self,
        auth: &ConnectionAuth,
        target: Option<&str>,
        message: &NotifyMessage,
    ) -> anyhow::Result<SentMessage> {
        let (email, key) = split_credential(&auth.token)?;
        let channel = target
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "a Zulip connection reaches every channel — name the one to post to"
                )
            })?;
        let topic = message
            .topic
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or(DEFAULT_TOPIC);
        let content = truncate(&render(message, "**"), CONTENT_LIMIT);

        let res = self
            .http
            .post(format!("{}/messages", self.api(auth)?))
            .basic_auth(email, Some(key))
            // Form-encoded, not JSON: Zulip's message API takes parameters,
            // not a document. `type=stream` rather than the newer `channel`
            // alias, which a self-hosted installation older than Zulip 9 does
            // not know.
            .form(&[
                ("type", "stream"),
                ("to", channel),
                ("topic", topic),
                ("content", content.as_str()),
            ])
            .send()
            .await?;
        let posted: Posted = zulip_envelope(res, "messages").await?;
        Ok(SentMessage {
            target: format!("{channel} > {topic}"),
            id: posted.id.map(|id| id.to_string()),
        })
    }
}

/* ── Slack-compatible incoming webhook ── */

/// Zulip's incoming webhook accepts a Slack-shaped payload, which is why this
/// driver and [`super::slack::SlackWebhookDriver`] send the same body. The
/// channel and the bot's key are query parameters of the URL a human generates
/// in Zulip, so there is nothing here to configure and nothing to enumerate.
pub struct ZulipWebhookDriver {
    http: reqwest::Client,
}

/// Where a Zulip incoming-webhook URL must point. Anything else with an
/// `api_key` in it is a different endpoint being fed a payload it will not
/// understand.
const WEBHOOK_PATH: &str = "/api/v1/external/";

impl ZulipWebhookDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// The channel the URL posts to, when it names one.
    ///
    /// Read for display only. A URL without `stream` is still valid: Zulip
    /// delivers it as a direct message to the bot's owner.
    fn channel_of(url: &reqwest::Url) -> Option<String> {
        url.query_pairs()
            .find(|(k, _)| k == "stream")
            .map(|(_, v)| v.into_owned())
    }

    fn url(&self, auth: &ConnectionAuth) -> anyhow::Result<reqwest::Url> {
        let url = check_url(&auth.token, "Webhook URL", HostRule::AnyPublic)?;
        if !url.path().starts_with(WEBHOOK_PATH) {
            return Err(anyhow::anyhow!(
                "a Zulip incoming-webhook URL has a path under {WEBHOOK_PATH} — \
                 generate one in Zulip under Bots, with type \"Incoming webhook\""
            ));
        }
        Ok(url)
    }

    async fn post(&self, auth: &ConnectionAuth, text: &str) -> anyhow::Result<reqwest::Url> {
        let url = self.url(auth)?;
        let res = self
            .http
            .post(url.clone())
            .json(&serde_json::json!({ "text": text }))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(http_error(res, "Zulip webhook").await);
        }
        Ok(url)
    }
}

#[async_trait]
impl ConnectorDriver for ZulipWebhookDriver {
    fn provider(&self) -> &'static str {
        "zulip_webhook"
    }

    fn display_name(&self) -> &'static str {
        "Zulip (incoming webhook)"
    }

    /// Informational: this driver reads the URL from the credential.
    fn default_base_url(&self) -> &'static str {
        "https://your-org.zulipchat.com"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Notification
    }

    fn credential_label(&self) -> &'static str {
        "Webhook URL"
    }

    fn credential_hint(&self) -> &'static str {
        "https://your-org.zulipchat.com/api/v1/external/slack_incoming?api_key=…&stream=…"
    }

    fn fixed_target(&self) -> bool {
        true
    }

    /// Verifying a Zulip webhook **posts a message** — same reason as Slack's:
    /// the endpoint's only interaction is a delivering POST. See
    /// [`super::slack::SlackWebhookDriver::test`].
    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let url = self.post(auth, &render(&probe(), "**")).await?;
        Ok(DriverIdentity {
            account: "Zulip incoming webhook".into(),
            display_name: Some(match Self::channel_of(&url) {
                Some(channel) => format!("posts to #{channel}"),
                None => "posts to the bot owner as a direct message (no stream in the URL)".into(),
            }),
        })
    }

    async fn send_message(
        &self,
        auth: &ConnectionAuth,
        _target: Option<&str>,
        message: &NotifyMessage,
    ) -> anyhow::Result<SentMessage> {
        let text = truncate(&render(message, "**"), CONTENT_LIMIT);
        let url = self.post(auth, &text).await?;
        Ok(SentMessage {
            target: Self::channel_of(&url)
                .unwrap_or_else(|| "the bot owner (direct message)".into()),
            // The Slack-compatible endpoint answers `{"result": "success"}`
            // with no message id.
            id: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_splits_at_the_colon() {
        let (email, key) = split_credential(" bot@org.zulipchat.com:AbC123 ").unwrap();
        assert_eq!(email, "bot@org.zulipchat.com");
        assert_eq!(key, "AbC123");
    }

    #[test]
    fn credential_without_both_halves_is_refused_with_the_shape_in_the_message() {
        for bad in ["justanapikey", "bot@org.zulipchat.com:", ":AbC123", ""] {
            let e = split_credential(bad).unwrap_err().to_string();
            assert!(
                e.contains("bot@your-org.zulipchat.com:apikey"),
                "{bad}: {e}"
            );
        }
    }

    #[test]
    fn webhook_url_must_be_an_external_endpoint() {
        let driver = ZulipWebhookDriver::new(reqwest::Client::new());
        let auth = |token: &str| ConnectionAuth {
            base_url: "https://org.zulipchat.com".into(),
            token: token.into(),
        };
        assert!(
            driver
                .url(&auth(
                    "https://org.zulipchat.com/api/v1/external/slack_incoming?api_key=k&stream=eng"
                ))
                .is_ok()
        );
        // The right host, but the REST API rather than the webhook endpoint.
        assert!(
            driver
                .url(&auth("https://org.zulipchat.com/api/v1/messages"))
                .is_err()
        );
    }

    #[test]
    fn webhook_reports_the_channel_from_the_url() {
        let url = reqwest::Url::parse(
            "https://org.zulipchat.com/api/v1/external/slack_incoming?api_key=k&stream=releases",
        )
        .unwrap();
        assert_eq!(
            ZulipWebhookDriver::channel_of(&url).as_deref(),
            Some("releases")
        );
        let no_stream = reqwest::Url::parse(
            "https://org.zulipchat.com/api/v1/external/slack_incoming?api_key=k",
        )
        .unwrap();
        assert!(ZulipWebhookDriver::channel_of(&no_stream).is_none());
    }
}
