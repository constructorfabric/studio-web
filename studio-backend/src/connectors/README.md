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
| `POST /connections/{id}/graph-sync` → `GET /studio-tasks/v1/runs/{id}` | mirror the provider into the graph |
| `POST /probe` | check a credential before storing it |
| `GET /sources/{source}/sharing?project_id=&head=` | how a project's repository shares edits |
| `POST /sources/{source}/pull-requests?project_id=` | open or reuse a pull request for it |

## Sharing from the IDE

"Share with the team" in the IDE commits a person's edited documents. Each
repository of a project says how, in its `project.config` `sources[]` entry:
`"share_mode": "branch"` commits and pushes to the working branch, and
`"share_mode": "pull_request"` pushes to the person's own branch and opens a
pull request into the working branch. An entry without the field is `branch`.
The portal sets it when the repository is picked.

The IDE knows a repository by its checkout directory, not by a connection, and
it has no provider token. So the two `sources/{source}` routes take that
directory and `?project_id=`, find the source in the project's config (read as
the caller, so a project they may not read is a 404), and act with the
source's own connection:

- `GET …/sharing` answers `source`, `share_mode`, `base` (the source's branch,
  else the repository default), `pull_requests` (whether a request can be
  opened through the connection by this caller) and, given `?head=` in
  `pull_request` mode, `open_pull_request` (`number`, `url`).
- `POST …/pull-requests` with `{ head, base?, title, body? }` opens a request
  from `head`, which the IDE has pushed, into `base`, or returns the one
  already open between them (`created: false`). It answers 400 with the reason
  when the source has no usable connection or its provider cannot open pull
  requests. Only the GitHub driver opens them today.

Notifications that must survive a failure go through
[`../notify`](../notify) instead of `POST /messages`.

## In the assembly

- Gear `studio-connector` plus one plugin gear per provider, capabilities
  `[rest]`, deps `types_registry`, `account_management`, `credstore`.
- Config sections `gears.studio-connector` and `gears.<provider>-connector-plugin`.
