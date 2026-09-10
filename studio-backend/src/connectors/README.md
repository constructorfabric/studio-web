# studio-connector

The providers Studio talks to, and the credentials it talks with. One
connection is configured once per tenant; everything else — repositories, model
keys, chat channels — is picked from a list.

## Why it exists

The portal used to ask for a clone URL, a branch and a `token_ref` for every
repository, in every workspace. That put a secret in the browser's hands on
every launch and made "which repositories do we have" a question nobody could
answer. A connection replaces all of it: the API returns the credstore
*reference*, never the token, so launching a session with private repositories
needs no secret handling in the browser at all.

## Three kinds, one contract

The difference between them is only which capabilities of the driver contract a
driver implements:

- **source hosts** — GitLab, GitHub, Bitbucket: bring repositories in.
- **model providers** — Anthropic, OpenAI: the key the IDE agents authenticate
  with.
- **chat platforms** — Slack, Zulip, Discord: where notifications are
  delivered, each with a bot-token and an incoming-webhook variant.

## Three moving parts, deliberately separated

| Part | Knows | Lives in |
|---|---|---|
| **driver** (`ConnectorDriver`) | one provider's API | `plugin.rs` — each driver is its own plugin gear |
| **connection** (`service::Connection`) | a tenant's binding of driver + installation + credential | tenant metadata; the token in credstore |
| **gear** (`StudioConnectorGear`) | resolving drivers, the catalogue, REST | this module |

Adding a provider means adding a plugin, not editing this gear. A driver
registers a `PluginV1` instance under `cf.studio.connector.plugin.v1~` and
publishes itself as a scoped ClientHub client.

Credential visibility is credstore's sharing mode — personal, workspace,
organization — rather than a concept invented here.

## REST

| Method + path | Does |
|---|---|
| `GET /providers` | which drivers this deployment has |
| `GET`/`POST`/`PATCH`/`DELETE /connections[/{id}]` | the tenant's connections |
| `POST /connections/{id}/test` | prove the credential still works |
| `GET /connections/{id}/repositories` | pick a repository instead of typing a URL |
| `GET /connections/{id}/targets` | chat channels this connection can reach |
| `POST /connections/{id}/messages` | send one now (the synchronous path) |
| `POST /connections/{id}/graph-sync` → `GET /graph-sync/tasks/{id}` | mirror the provider into the graph |
| `POST /probe` | check a credential before storing it |

Notifications that must survive a failure go through
[`../notify`](../notify) instead of `POST /messages`.

## In the assembly

- Gear `studio-connector` plus one plugin gear per provider, capabilities
  `[rest]`, deps `types_registry`, `account_management`, `credstore`.
- Config sections `gears.studio-connector` and `gears.<provider>-connector-plugin`.
