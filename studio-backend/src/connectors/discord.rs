//! Discord drivers: a bot token, and a channel webhook.
//!
//! ## Listing channels costs a request per server
//!
//! Discord has no "every channel this token can post to" endpoint. A bot
//! belongs to guilds, and channels are per guild, so enumerating them is
//! `GET /users/@me/guilds` followed by one `GET /guilds/{id}/channels` each.
//! [`GUILD_LIMIT`] caps how many of those follow-ups one listing will make: a
//! bot in dozens of servers would otherwise turn a channel picker into dozens
//! of sequential calls against an API that rate-limits per route.
//!
//! ## The webhook is the one that can be verified quietly
//!
//! Alone among the three platforms, Discord describes a webhook without
//! posting to it: `GET /webhooks/{id}/{token}` returns the webhook's name and
//! channel. So `discord_webhook` verifies a credential without putting
//! anything in the channel, where the Slack and Zulip webhooks have to deliver
//! a message to prove the URL is live.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, NotifyMessage,
    NotifyTarget, SentMessage,
};
use super::notify::{HostRule, check_url, http_error, render, truncate};

/// Discord's own hosts. `discordapp.com` is the pre-rename domain, still
/// served and still pasted from old runbooks.
const DISCORD_HOSTS: &[&str] = &["discord.com", "discordapp.com"];

/// `content` is refused past 2 000 characters.
const CONTENT_LIMIT: usize = 2000;

/// How many guilds one channel listing will walk. See the module note.
const GUILD_LIMIT: usize = 10;

/// `GUILD_TEXT` and `GUILD_ANNOUNCEMENT` — the two channel types a plain
/// message can be posted into. Voice, categories, forums and threads are not
/// targets for this contract.
const POSTABLE: [i64; 2] = [0, 5];

#[derive(Deserialize)]
struct BotUser {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    global_name: Option<String>,
    #[serde(default)]
    bot: bool,
}

#[derive(Deserialize)]
struct Guild {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct Channel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "type", default)]
    kind: i64,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    channel_id: Option<String>,
}

#[derive(Deserialize)]
struct Webhook {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    channel_id: Option<String>,
}

/* ── Bot token ── */

pub struct DiscordDriver {
    http: reqwest::Client,
}

impl DiscordDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    fn root(&self, auth: &ConnectionAuth) -> anyhow::Result<String> {
        check_url(
            auth.root(),
            "Discord API URL",
            HostRule::OneOf(DISCORD_HOSTS),
        )?;
        Ok(auth.root().to_string())
    }

    /// `Authorization: Bot <token>` — Discord's bearer scheme is named `Bot`,
    /// and a bot token sent as `Bearer` is rejected as unauthorized.
    fn authorization(auth: &ConnectionAuth) -> String {
        format!("Bot {}", auth.token.trim())
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        auth: &ConnectionAuth,
        path: &str,
    ) -> anyhow::Result<T> {
        let res = self
            .http
            .get(format!("{}{path}", self.root(auth)?))
            .header(reqwest::header::AUTHORIZATION, Self::authorization(auth))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(http_error(res, "Discord").await);
        }
        Ok(res.json().await?)
    }
}

#[async_trait]
impl ConnectorDriver for DiscordDriver {
    fn provider(&self) -> &'static str {
        "discord"
    }

    fn display_name(&self) -> &'static str {
        "Discord"
    }

    fn default_base_url(&self) -> &'static str {
        "https://discord.com/api/v10"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Notification
    }

    fn credential_label(&self) -> &'static str {
        "Bot Token"
    }

    fn credential_hint(&self) -> &'static str {
        "the bot token from Developer Portal → Bot"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let me: BotUser = self.get(auth, "/users/@me").await?;
        let name = me
            .global_name
            .or(me.username)
            .unwrap_or_else(|| "unknown application".into());
        Ok(DriverIdentity {
            account: name,
            display_name: Some(if me.bot {
                "bot application".into()
            } else {
                // A user token in this field would work and would also be a
                // terms-of-service violation on Discord's side. Say so rather
                // than silently accepting it.
                "not a bot account — Discord only permits bot tokens for automation".into()
            }),
        })
    }

    async fn list_targets(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<NotifyTarget>> {
        let guilds: Vec<Guild> = self.get(auth, "/users/@me/guilds").await?;
        let needle = search
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let mut out = Vec::new();

        for guild in guilds.into_iter().take(GUILD_LIMIT) {
            let channels: Vec<Channel> = self
                .get(auth, &format!("/guilds/{}/channels", guild.id))
                .await?;
            let server = guild.name.clone();
            for c in channels {
                if !POSTABLE.contains(&c.kind) {
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
                    container: server.clone(),
                    // Discord's per-channel permission overwrites decide who
                    // can post, and reading them means resolving the bot's
                    // roles against every overwrite. Not modelled: a channel
                    // the bot cannot post in refuses the message with a
                    // `Missing Access` the caller sees verbatim.
                    private: false,
                    topic_required: false,
                });
                if out.len() as u32 >= limit {
                    return Ok(out);
                }
            }
        }
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
                    "a Discord bot connection reaches every channel in its servers — \
                     name the one to post to"
                )
            })?;
        let content = truncate(&render(message, "**"), CONTENT_LIMIT);
        let res = self
            .http
            .post(format!("{}/channels/{channel}/messages", self.root(auth)?))
            .header(reqwest::header::AUTHORIZATION, Self::authorization(auth))
            .json(&json!({ "content": content }))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(http_error(res, "Discord").await);
        }
        let posted: Message = res.json().await?;
        Ok(SentMessage {
            target: posted.channel_id.unwrap_or_else(|| channel.to_string()),
            id: posted.id,
        })
    }
}

/* ── Channel webhook ── */

pub struct DiscordWebhookDriver {
    http: reqwest::Client,
}

/// Where a Discord webhook URL points. The API version may or may not be in
/// the path (`/api/webhooks/…` and `/api/v10/webhooks/…` are both issued), so
/// the check is on the `webhooks` segment rather than a whole prefix.
const WEBHOOK_SEGMENT: &str = "/webhooks/";

impl DiscordWebhookDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    fn url(&self, auth: &ConnectionAuth) -> anyhow::Result<reqwest::Url> {
        let url = check_url(&auth.token, "Webhook URL", HostRule::OneOf(DISCORD_HOSTS))?;
        if !url.path().contains(WEBHOOK_SEGMENT) {
            return Err(anyhow::anyhow!(
                "a Discord webhook URL looks like \
                 https://discord.com/api/webhooks/<id>/<token> — copy it from the \
                 channel's Integrations settings"
            ));
        }
        Ok(url)
    }
}

#[async_trait]
impl ConnectorDriver for DiscordWebhookDriver {
    fn provider(&self) -> &'static str {
        "discord_webhook"
    }

    fn display_name(&self) -> &'static str {
        "Discord (channel webhook)"
    }

    /// Informational: this driver reads the URL from the credential.
    fn default_base_url(&self) -> &'static str {
        "https://discord.com/api"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Notification
    }

    fn credential_label(&self) -> &'static str {
        "Webhook URL"
    }

    fn credential_hint(&self) -> &'static str {
        "https://discord.com/api/webhooks/…/…"
    }

    fn fixed_target(&self) -> bool {
        true
    }

    /// Verified without posting: the webhook object is readable at its own URL,
    /// and it names the channel it delivers to.
    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let res = self.http.get(self.url(auth)?).send().await?;
        if !res.status().is_success() {
            return Err(http_error(res, "Discord webhook").await);
        }
        let hook: Webhook = res.json().await?;
        Ok(DriverIdentity {
            account: hook.name.unwrap_or_else(|| "Discord webhook".into()),
            display_name: hook.channel_id.map(|id| format!("posts to channel {id}")),
        })
    }

    async fn send_message(
        &self,
        auth: &ConnectionAuth,
        _target: Option<&str>,
        message: &NotifyMessage,
    ) -> anyhow::Result<SentMessage> {
        let content = truncate(&render(message, "**"), CONTENT_LIMIT);
        let res = self
            .http
            .post(self.url(auth)?)
            // `wait=true` trades a little latency for the created message:
            // without it Discord answers 204 and the caller learns neither the
            // message id nor which channel took it.
            .query(&[("wait", "true")])
            .json(&json!({ "content": content }))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(http_error(res, "Discord webhook").await);
        }
        let posted: Message = res.json().await?;
        Ok(SentMessage {
            target: posted
                .channel_id
                .unwrap_or_else(|| "the channel this webhook posts to".into()),
            id: posted.id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(token: &str) -> ConnectionAuth {
        ConnectionAuth {
            base_url: "https://discord.com/api/v10".into(),
            token: token.into(),
        }
    }

    #[test]
    fn bot_tokens_use_discords_own_authorization_scheme() {
        assert_eq!(
            DiscordDriver::authorization(&auth("  abc.def  ")),
            "Bot abc.def"
        );
    }

    #[test]
    fn webhook_url_must_be_a_discord_webhook() {
        let driver = DiscordWebhookDriver::new(reqwest::Client::new());
        assert!(
            driver
                .url(&auth("https://discord.com/api/webhooks/123/tok"))
                .is_ok()
        );
        assert!(
            driver
                .url(&auth("https://discord.com/api/v10/webhooks/123/tok"))
                .is_ok()
        );
        // Right host, wrong endpoint.
        assert!(
            driver
                .url(&auth("https://discord.com/api/v10/channels/1/messages"))
                .is_err()
        );
        // A webhook-shaped URL somewhere else entirely.
        assert!(
            driver
                .url(&auth("https://evil.example/api/webhooks/123/tok"))
                .is_err()
        );
    }

    #[test]
    fn only_text_and_announcement_channels_are_offered() {
        // Voice (2), category (4), forum (15) are not message targets.
        assert!(POSTABLE.contains(&0));
        assert!(POSTABLE.contains(&5));
        for not_postable in [2, 4, 13, 15] {
            assert!(!POSTABLE.contains(&not_postable));
        }
    }
}
