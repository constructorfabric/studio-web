# Notification connectors — Slack, Zulip, Discord

Studio delivers notifications through the same connector subsystem that brings
repositories in: a *connection* is a credential in credstore plus a
tenant-metadata record naming which driver it belongs to. Nothing about
notifications is a separate gear — `studio-connector` grew two routes and six
driver plugins (`src/connectors/{slack,zulip,discord}.rs`).

The REST surface is documented in full by the OpenAPI document at
`http://localhost:8090/cf/docs`, tag `StudioConnectors`.

## Two credentials per platform, and how to choose

Each platform has two ways to let an application post, and they are different
products rather than two spellings of one:

| Provider key | Credential | Reach | Channel chosen |
| --- | --- | --- | --- |
| `slack` | Bot User OAuth Token (`xoxb-…`) | every channel the bot was invited to | per message |
| `slack_webhook` | Incoming-webhook URL | one channel | fixed in the URL |
| `zulip` | bot email + API key | every channel the bot can see | per message |
| `zulip_webhook` | Slack-compatible incoming-webhook URL | one channel | fixed in the URL |
| `discord` | Bot token | every channel in the bot's servers | per message |
| `discord_webhook` | Channel-webhook URL | one channel | fixed in the URL |

A bot token is what you want when Studio should decide where a notification
goes — one connection per organization, and the channel is part of the send. A
webhook is what you want when the person who owns a channel wants to opt *that
channel* in without an administrator installing anything: they generate a URL
and paste it, and no bot ever joins their workspace.

`GET /studio-connector/v1/providers` reports which of the two a provider is:
`category: "notification"` and `fixed_target: true` for the webhook variants.
A client that sees `fixed_target` offers no channel picker and sends no
`target`.

One rough edge in the portal's create form: a webhook connection has no
installation URL — the credential *is* the URL — but the form still shows the
base-URL field, and leaving it blank stores the provider's default host. It is
inert either way. Hiding it needs a second flag on the provider contract
("the credential is the endpoint"), which is not the same statement as
`fixed_target` and is deliberately not being inferred from it.

## Getting each credential

**Slack bot token.** api.slack.com → *Your Apps* → *Create New App* → *From
scratch*. Under *OAuth & Permissions* add the bot scopes `chat:write` and
`channels:read` (add `groups:read` to also list private channels), install the
app to the workspace, and copy the *Bot User OAuth Token*. Then invite the bot
to each channel it should post in — `/invite @your-app`. Without the invite
`chat.postMessage` answers `not_in_channel`, which the API passes through
verbatim.

**Slack incoming webhook.** Same app, *Incoming Webhooks* → *Activate*, then
*Add New Webhook to Workspace* and pick the channel. The URL it gives you is
the whole credential.

**Zulip bot.** Your organization → *Personal settings* → *Bots* → *Add a new
bot*, type *Generic bot*. Copy its email address and its API key, and enter
them in one field separated by a colon:

```text
studio-bot@your-org.zulipchat.com:aBcD1234…
```

That is the pair Zulip's own `curl` examples pass to `-u`. Set the connection's
installation URL to your organization's own (`https://your-org.zulipchat.com`,
or a self-hosted host); the placeholder is refused by name rather than left to
fail as a DNS error.

**Zulip incoming webhook.** Same *Bots* page, type *Incoming webhook*, then
*Generate URL for an integration* and choose *Slack-compatible webhook* and the
channel. Zulip accepts a Slack-shaped payload on
`/api/v1/external/slack_incoming`, which is why this driver and the Slack one
send the same body. A URL with no `stream` parameter is still valid — Zulip
delivers those as a direct message to the bot's owner, and the connection says
so after a test.

**Discord bot.** Developer Portal → *Applications* → *New Application* → *Bot*,
copy the token, then invite the bot to the server with the `bot` scope and the
*Send Messages* permission. Note that the Authorization scheme is `Bot`, not
`Bearer`; the driver handles that, but it is why a token pasted into a generic
HTTP client fails.

**Discord channel webhook.** Channel → *Edit Channel* → *Integrations* →
*Webhooks* → *New Webhook*, then *Copy Webhook URL*.

## Verifying a connection posts a message — for two of the three

`POST /connections` verifies the credential before storing anything, and so
does `POST /connections/{id}/test`. For a bot token that is a metadata call
(`auth.test`, `users/me`, `users/@me`) and nothing appears in any channel.

For **Slack and Zulip incoming webhooks it delivers a message**: neither
platform exposes any way to ask whether a webhook URL is live. The only
documented interaction is a POST that posts. So the test posts one line —
"This channel is connected to Constructor Studio." — which is a reasonable
thing for a channel to receive at the moment somebody connects it, and the
honest alternative to reporting a credential as good without having tried it.
It runs on create and on an explicit re-test, both deliberate acts by a person.

A **Discord webhook is verified silently**: `GET /webhooks/{id}/{token}`
returns the webhook's name and channel without posting, so that driver uses it.

## Sending

```bash
TOKEN=...   # a Studio access token
CONN=...    # connection id
ORG=...     # the organization tenant that owns the connection

# Which channels can this connection reach? (bot-token connections only)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8090/cf/studio-connector/v1/connections/$CONN/targets?tenant=$ORG"

# Post
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "http://localhost:8090/cf/studio-connector/v1/connections/$CONN/messages?tenant=$ORG" \
  -d '{
        "target": "C01ABCDEF",
        "title": "Spec quality gate failed",
        "text": "2 of 7 checks are red on *PRD-14*.",
        "link": "http://localhost:8080/projects/14/artifacts"
      }'
```

The caller says what happened; each driver renders it into its own platform's
idiom, so nothing above the connector has to know which platform is behind the
connection. There is deliberately no way to pass Slack blocks or Discord
embeds — that would put the platform back into every caller.

`target` is a `NotifyTarget.id` from the listing. Its shape is the platform's:
a Slack channel id (`C…`), a Zulip numeric channel id, a Discord snowflake.
Omit it for a `fixed_target` provider. `topic` is required by Zulip, which
threads every channel message; a send that omits one lands under the topic
"Constructor Studio", and `topic_required` on the target tells a UI to ask.

## What this does not do

- **This route does not retry.** `POST /connections/{id}/messages` delivers
  once, while the caller waits, and reports what the platform said: a refusal
  comes back as a failed-precondition problem (HTTP 400, violation type
  `CONNECTOR_DELIVERY_FAILED`) whose `description` carries the reason verbatim.
  That is the right shape for "send a test message" and the wrong one for a
  notification that must not be lost — use the queue for those, see
  [queued-notifications.md](./queued-notifications.md).
- **No event routing.** Nothing subscribes to anything: a notification happens
  because a caller asked for one. Rules of the shape "when a spec-quality gate
  fails, post to #eng" are a separate gear's job, and the send route is the
  contract it would use.
- **No direct messages to a person.** Reaching a human needs a mapping from a
  Studio subject to a platform account, which is `studio-identity`'s job
  (ADR-0012) and not something to guess from a display name.

## The guard on URLs

A webhook connection stores a URL a person typed, and the backend then POSTs to
it — a request-forgery primitive. Every URL that arrives as configuration
passes `notify::check_url` before use: HTTPS only, no loopback or private-range
literal, no obviously internal name, and the provider's own host wherever the
provider has no self-hosted form (Slack, Discord). Zulip is exempt from the
host pin and not from the rest, because a self-hosted installation is its
normal case.

That is a host check, not a network policy: a public name that resolves to a
private address still gets through, since the resolution happens later in the
HTTP client. Closing that is an egress policy on the deployment. What the check
does close is the whole class of directly-addressed internal targets, which is
what a hand-typed field actually carries.
