# studio-connector

The providers Studio talks to, and the credentials it talks with. One
connection is configured once per tenant; everything else — repositories, model
keys, chat channels — is picked from a list.

The design — why a connection replaces per-repository URLs and tokens, the
driver / connection / gear split, why a provider is a plugin, how scope maps
onto credstore, the guards on editing and moving a connection, the repository
import and the routes — is
[`docs/design/studio-connector.md`](../../../docs/design/studio-connector.md).
This README is what you need to work in the directory.

## REST

| Method + path | Does |
|---|---|
| `GET /providers` | which drivers this deployment has |
| `GET`/`POST /connections` | the tenant's connections; add one |
| `PATCH`/`DELETE /connections/{id}` | relabel, move, rotate; remove |
| `POST /connections/{id}/test` | prove the credential still works |
| `GET /connections/{id}/repositories` | pick a repository instead of typing a URL |
| `GET /connections/{id}/targets` | chat channels this connection can reach |
| `POST /connections/{id}/messages` | send one now (the synchronous path) |
| `POST /connections/{id}/files` | publish one file, optionally as a pull request |
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

- Gear `studio-connector`, capabilities `[rest]`, deps `types_registry`,
  `account_management`, `credstore`; no database (the catalogue is tenant
  metadata, the tokens are in credstore).
- One plugin gear per provider (`<provider>-connector-plugin`, eleven of them
  in `plugin.rs`), deps `types_registry`.
- Config sections `gears.studio-connector` and
  `gears.<provider>-connector-plugin` (`vendor`, `priority`).
- Registers the task type `connector.graph_sync` with
  [`../tasks`](../tasks) when built with the `graph` feature.

## Adding a provider

A driver module implementing `driver::ConnectorDriver` (only the capabilities
the provider has; the rest refuse by default), a plugin gear in its own child
module of `plugin.rs`, an instance id in `gts.rs`, and that id in
`KNOWN_DRIVERS` in `mod.rs`. Its base URL rule (`url_guard::HostRule`) is
`OneOf` its own hosts unless the provider can be self-hosted.
