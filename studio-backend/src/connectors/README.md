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
