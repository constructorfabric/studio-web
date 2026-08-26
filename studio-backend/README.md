# Constructor Studio Backend

The Constructor Studio backend service, assembled from [CF/Gears](https://github.com/constructorfabric/gears-rust). First milestone: the users + multi-tenancy layer, demonstrated end-to-end on the **account-management** gear (capability review: `../../REVIEW-account-management-for-studio.md`).

**What it is.** A single HTTP API service — the CF/Gears analogue of an ASP.NET Core WebAPI host. It contains almost no code of its own (~150 lines): gears are linked in as library crates and discovered at link time (`src/registered_gears.rs`); `main.rs` only loads layered configuration and hands control to the toolkit bootstrap. All functionality comes from the gears. The frontend consumes it via REST + OpenAPI (`/cf/docs`, ready for TS client codegen) and SSE for streaming.

## Assembly (20 gears, fixed set — no feature flags)

| Layer | Gears |
|---|---|
| Entry | api-gateway (port 8090, prefix `/cf`, per-request auth, OpenAPI UI at `/cf/docs`) |
| Auth (dev stubs) | authn-resolver + **static-authn** (bearer tokens + mini-chat S2S), authz-resolver + **static-authz** (permissive PDP) |
| Platform | grpc-hub, gear-orchestrator, nodes-registry, types-registry (GTS), tenant-resolver |
| Domain | **account-management** (tenants, users, conversions, metadata) + its co-located TR plugin + IdP plugins (**keycloak-idp** for real Keycloak provisioning in docker/oidc/k8s; **static-idp** echo for the Keycloak-less dev/postgres profiles), resource-group (group hierarchies, memberships) |
| Features | **mini-chat** (workspace AI chat, SSE) + static model-policy plugin, **oagw** (LLM egress) + **credstore** + static secrets plugin, **simple-user-settings** (per-user theme/language), **file-storage** |

Ask AI needs a real provider key: put your OpenAI API key into
`static-credstore-plugin.config.secrets[key=openai-key]` (both profiles ship
`sk-REPLACE_ME`). Without it, chats are created but streamed replies fail at the
provider with 401.

Production swaps are config + imports: static-authn → OIDC plugin, static-authz → a Studio PDP plugin (workspace-level roles), SQLite → Postgres. The IdP swap is already done — the official `cf-gears-keycloak-idp-plugin` is the active IdP in the docker/oidc/k8s profiles (static-idp echo remains only for the Keycloak-less dev/postgres profiles).

## API surface (47 operations; live contract at `/cf/docs`)

- `/cf/account-management/v1/*` — tenant CRUD + suspend/unsuspend + children; tenant-scoped users (provision/list/delete via the pluggable IdP contract); dual-consent mode conversions (`/conversions`, `/child-conversions`); extensible tenant metadata; `/me` identity reflection.
- `/cf/resource-group/v1/*` — groups (CRUD, descendants/ancestors), memberships (`group × resource_type × resource_id`), RG types.
- `/cf/types-registry/v1/*` — GTS entity registration and lookup.
- Auth: `Authorization: Bearer studio-admin-token` (dev static token; see `config/dev.yaml`).

## Data

SQLite, one database per gear, under `~/.cf-studio-backend/<gear>/`: `account_management.db` (tenants, `tenant_closure`, conversion requests, metadata), `resource_group.db` (groups, memberships, closure), `types_registry.db`, `nodes_registry.db`. Migrations run automatically at startup. Logs: `~/.cf-studio-backend/logs/`. Postgres is a config-only switch (sea-orm/sqlx underneath).

## Running (Windows + WSL2, no repo copies)

Files live only in `C:\Repos\CFS` (git/IDE on Windows); WSL builds straight from `/mnt/c` with heavy I/O redirected to ext4. Once, in `~/.bashrc`:

```bash
export CARGO_TARGET_DIR=$HOME/.cargo-target   # build artifacts on ext4, not NTFS
export PROTOC=/usr/bin/protoc                 # don't pick up a Windows protoc from PATH
```

System packages: `sudo apt install -y build-essential pkg-config cmake protobuf-compiler curl jq`.

```bash
cd /mnt/c/Repos/CFS/studio-web/studio-backend
cargo run -- --config config/dev.yaml --list-gears   # verify the assembly (20 gears)
cargo run -- --config config/dev.yaml run            # migrations apply on start
./demo/demo.sh                                       # in a second terminal
./demo/demo-groups.sh <user-id>                      # user-groups scenario
```

Config profiles: `dev.yaml` (SQLite, zero deps), `postgres.yaml` (host run against the
compose Postgres), `docker.yaml` (in-container: DB host `postgres`, binds 0.0.0.0).
Docker orchestration lives at the repo root — see `../docker-compose.yml`
(`docker compose up --build -d` for the full stack, `up -d postgres` for DB only).

Measured: full build from /mnt/c ~1m20s (deps cached), incremental — seconds. Requires Rust ≥ 1.96 (edition 2024) and a `gears-rust` checkout as a sibling of `studio-web` (path dependencies `../../gears-rust`).

## Verified end-to-end (2026-07-28, WSL2 Ubuntu, Rust 1.97.1)

Everything below was exercised over HTTP against the live server — the same way the frontend will:

1. **Identity**: `/me` through the full gateway → authn → AM chain (subject id, type, home tenant from the validated token).
2. **Bootstrap**: root tenant auto-created on first start (`classification="fresh"`); restart is a no-op (`"skipped"`) — idempotency contract holds.
3. **Data-driven tenant topology**: Studio tenant types `organization` and `workspace` (with `allowed_parent_types` constraints) seeded declaratively via `types-registry.config.entities` — no domain code written.
4. **Hierarchy + type barrier**: root → organization → workspace created; creating a workspace directly under root is rejected with a structured violation (`TYPE_NOT_ALLOWED`, machine-readable context).
5. **Users via the IdP contract**: provision into a workspace (echo IdP plugin), tenant-scoped listing with keyset pagination, deterministic user UUID.
6. **User groups via Resource Group**: container group + nested group (self-parent rule AM registers at init), membership using the member-handle type, `descendants` traversal (tenant_id from SecurityContext, depth), cycle attempt rejected (`Failed Precondition`).
7. **Dual-consent mode conversion**: child requests self-managed (`pending`, 72h window) → parent approves via `child-conversions` → tenant becomes `self_managed: true`, with per-side audit (`requested_by`/`approved_by`, per-transition comments).

## Debugging findings (already reflected in config/scripts)

- The build needs `protobuf-compiler`; set `PROTOC=/usr/bin/protoc` so a Windows protoc on the WSL PATH isn't picked up.
- A GTS id segment is strictly 5 parts `vendor.package.namespace.type.version` (`cf.studio.tenant.workspace.v1`, not `cf.studio.workspace.v1`).
- Gear routes have no `/api` prefix: `/cf/account-management/v1/...`. The OpenAPI artifact in the gear's docs says `/api/...` — the code is right, the artifact isn't.
- types-registry logs a failed static-entity registration as a generic `Request validation failed`, hiding the actual cause in field violations → issue candidate for gears-rust.
- RG membership takes the member-handle type `gts.cf.core.rg.type.v1~cf.core.am.user.v1~`; AM PRD §5.6 mentions bare `gts.cf.core.am.user.v1~` — another docs/code divergence (code wins).

## Next steps

1. ~~ADR: identity mapping~~ — done: `docs/adr/0001-identity-mapping.md` (decision: dedicated `studio-identity` gear).
2. Studio PDP plugin (member/reviewer/owner workspace roles) replacing static-authz.
3. ~~Postgres config profile + docker-compose~~ — done: `config/postgres.yaml` + `docker-compose.yml` (untested against a live Postgres yet).
4. ~~gears-rust issue drafts~~ — done: `docs/gears-rust-issues.md` (3 issues, ready to file).
5. `studio-identity` gear: PRD/DESIGN via the gears SDLC kit, then implementation.
