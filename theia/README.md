# Constructor Fabric Studio — Theia PoC

Single-user Studio proof of concept built on Eclipse Theia 1.74.0. It provides
a fixed Workspace, file editing, nested Git repository discovery, native source
control views, a Workspace graph, Analyze/Audit panels, and an optional
Markdown Save-to-Git pipeline.

## Prerequisites

- Node.js 22 (`.nvmrc` is included)
- npm 10 or newer
- Git 2.11 or newer
- Python 3 and a native build toolchain for `node-gyp`

Use the project-local Node version rather than replacing the system default:

```bash
nvm use
npm ci
```

## Local browser mode

Build and start Studio with an explicit Workspace path:

```bash
./start-browser-ai.sh /absolute/path/to/workspace
```

Open <http://127.0.0.1:3003>. The launcher resolves the containing Git
repository, locks the Workspace so it cannot be changed in the UI, and supplies
safe defaults for the runtime configuration.

## Native AI providers

The browser and Electron applications include the native
`@theia/ai-codex` and `@theia/ai-claude-code` providers. The launcher script
sets the required executable overrides automatically:

- `THEIA_CODEX_PATH` resolves to `codex` from `PATH` (normally
  `/opt/homebrew/bin/codex` on this machine).
- `THEIA_CLAUDE_CODE_PATH` resolves to the global Claude Agent SDK `sdk.mjs`.

Override either path by exporting its environment variable before running the
script. The providers require backend-only credentials; set
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in the launch environment when using
API-key authentication. Do not store either key in Theia preferences,
workspace files, or source control.

Codex requests must contain text after the `@Codex` agent prefix. A request
containing only `@Codex` is rejected by the Codex CLI as an empty prompt.

The Codex and Claude Code path overrides are maintained as `patch-package`
patches for Theia `1.74.0`; `npm install` applies them automatically. Recheck
the patches whenever Theia is upgraded.

The Workspace must already exist. In `push` mode its repository and any nested
repositories used by Studio must have a current branch, an `origin` remote,
`user.name`, `user.email`, and working host-side Git credentials.

## Cloud or remote-browser mode

Theia uses a browser frontend and a Node.js backend. They communicate through
JSON-RPC over WebSockets and HTTP, so a reverse proxy must forward both normal
HTTP requests and WebSocket upgrades.

This PoC has no tenant authentication. Never expose its backend port directly
to an untrusted network. Bind Studio to loopback and place an authenticated
TLS-terminating reverse proxy in front of it:

```bash
STUDIO_ALLOWED_ORIGINS=https://studio.example.com \
STUDIO_TRUST_PROXY=true \
STUDIO_GIT_MODE=push \
npm run start:browser -- \
  --hostname=127.0.0.1 \
  --port=3003 \
  /srv/studio/workspace
```

The proxy must:

- authenticate the single allowed user before forwarding requests;
- expose HTTPS and forward WebSocket upgrades;
- forward only to `127.0.0.1:3003`;
- set `Host` and forwarded-host headers consistently;
- apply request-size, timeout, and connection limits;
- prevent direct access to the backend port.

Set `STUDIO_TRUST_PROXY=true` only when requests can arrive solely through that
trusted proxy. `STUDIO_ALLOWED_ORIGINS` is a comma-separated list of bare
`http://` or `https://` origins. The PoC validates this Studio configuration
but does not replace Theia's global origin validator, so the proxy must also
enforce the public origin and host policy. These settings do not implement user
authentication. `STUDIO_SESSION_TOKEN` is currently configuration-only and
must not be treated as an authentication mechanism.

## Runtime configuration

The launcher derives most values from the Workspace and its Git configuration.
They can be set explicitly when deploying:

| Variable | Meaning |
| --- | --- |
| `STUDIO_ACTOR_ID` | Audit identity for the single user |
| `STUDIO_WORKSPACE_ID` | Stable logical Workspace ID |
| `STUDIO_WORKSPACE_ROOT` | Absolute fixed Workspace root |
| `STUDIO_REPOSITORY_ROOT` | Absolute root repository path |
| `STUDIO_DATA_DIR` | Durable operation journal/cache directory |
| `STUDIO_ALLOWED_ORIGINS` | Optional comma-separated browser origin allowlist |
| `STUDIO_TRUST_PROXY` | Trust forwarded host information (`true`/`false`) |
| `STUDIO_GIT_MODE` | `disabled`, `commit`, or `push` |
| `STUDIO_GIT_BRANCH` | Required branch for mutation modes |
| `STUDIO_GIT_REMOTE` | Remote name, normally `origin` |
| `STUDIO_GIT_FETCH_SOURCE_URL` | Repository-owned fetch URL |
| `STUDIO_GIT_PUSH_SOURCE_URL` | Repository-owned push URL |
| `STUDIO_GIT_FETCH_URL` | Resolved fetch URL used by the host |
| `STUDIO_GIT_PUSH_URL` | Resolved push URL used by the host |
| `STUDIO_GIT_AUTHOR_NAME` | Commit author name |
| `STUDIO_GIT_AUTHOR_EMAIL` | Commit author email |
| `THEIA_CODEX_PATH` | Absolute path to the Codex CLI executable |
| `THEIA_CLAUDE_CODE_PATH` | Absolute path to the Claude Agent SDK `sdk.mjs` |
| `OPENAI_API_KEY` | Codex API key, supplied only to the backend process |
| `ANTHROPIC_API_KEY` | Claude Code API key, supplied only to the backend process |

Do not put access tokens in browser-visible URLs or commit them to configuration
files. Git runs only in the backend and should use the host's SSH agent,
credential helper, or another deployment-managed credential mechanism.

## Workspace graph contract and runtime

The canonical graph is the JSON produced for the repository selected in Source
Control by `cfs map --format json --local-only`. The backend runs the command
with that repository as its working directory; it deliberately does not
materialize a federated all-workspace graph. Its
authoritative versioned contract is
`constructorfabric/studio/schemas/map.schema.json`. The Workspace-local
`.cf-studio/.core/schemas/map.schema.json` is a vendored runtime copy of that
upstream schema, not a second source of truth. The runtime copy is byte-matched,
and the adapter test suite checks its schema identity, version, and content
against the project-root authoritative copy so drift fails CI. Studio does not
maintain a second Markdown or source-code graph parser. The Theia
`WorkspaceGraphSnapshotV2` JSON-RPC type is a browser-facing view adapter over
that canonical payload. It preserves cfs nodes, edges, references, sources,
categories, available layout positions, bucket rectangles, category bands, and
dangling CPT uses while adding only the repository locations and freshness
metadata needed by Theia. Missing canonical positions remain absent so the
frontend can apply its own deterministic layout.

The backend resolves the map command in this order:

1. the exact executable set in `STUDIO_CFS_COMMAND`, when provided;
2. `cfs` from the backend process `PATH`;
3. the Workspace-local `.cf-studio/.core/skills/studio/scripts/studio.py`
   through `python3`, when present.

Each candidate must support `map --help`; its `--version` output is recorded
with the cached snapshot. Studio launches the selected executable directly,
with a fixed argument vector and no shell, writes the temporary JSON beneath
`STUDIO_DATA_DIR`, applies a 300-second default timeout and bounded output, and
deletes the temporary output after the run. Deployments may set
`STUDIO_CFS_MAP_TIMEOUT_MS` to an integer from 1,000 through 1,800,000
milliseconds when a selected repository needs a different limit.

Command, timeout, malformed-output, incompatible-schema, and unowned-source
conditions are backend diagnostics. Raw command stderr is not sent to the
browser. A failed refresh remains visible as a failed/stale graph status; when
a last-known-good snapshot exists, Studio keeps that snapshot as a read-only
stale view instead of replacing it with partial or incompatible output.

## Git modes and Markdown Save flow

- `disabled`: editing works, but Studio performs no Git mutation.
- `commit`: an explicit Markdown Save creates a local per-file commit.
- `push`: an explicit Markdown Save runs `pull --rebase`, stages only the saved
  Markdown file, creates a generated commit, and pushes the configured branch.

The pipeline applies only when Theia detects the file language as Markdown.
Each operation is tied to one repository and one file. Other dirty or staged
paths block the operation instead of being included. A push failure remains
visible as `push-pending` and can be retried from Git Operations.

## Agents panel (Orca) — prototype

The project is already open in the IDE; this panel is where a person starts and
steers coding agents on it without leaving Theia. It talks to an
[Orca](https://github.com/stablyai/orca) runtime (MIT) — Orca owns the agent
runs and the isolated worktrees, Theia owns editing.

**Why through the CLI and not by importing Orca.** Orca is one Electron
project, not a set of packages: its `pnpm-workspace.yaml` declares
`packages: []`, and the engine ships as a single ~7 MB bundle bound to Electron
plus patched `node-pty`/`xterm`. There is nothing to `npm install`. What it does
expose is a client/server split: `orca serve` runs a headless runtime, every
command takes `--json` (and `--environment` to target a remote one), and
`orca agent-context --json` publishes the whole surface — 234 commands under
`schemaVersion: 1`. So Studio speaks to the runtime the same way Orca's own CLI
does, no vendored code, upgrades from upstream.

| piece | file |
| --- | --- |
| RPC contract | `studio/src/common/orca-protocol.ts` |
| CLI runner (binary resolution, envelope, timeouts) | `studio/src/node/orca-cli.ts` |
| service (payload mapping) | `studio/src/node/orca-service.ts` |
| panel | `studio/src/browser/orca-widget.tsx`, `orca-contribution.ts` |

The panel opens from **View → Agents (Orca)** (command `studio.orca.toggle`) and
does four things: shows whether a runtime is reachable; creates a task
(`worktree create --agent --prompt`), which gives the agent its own checkout so
the one you are editing is untouched; starts an agent in the selected worktree
(`terminal create`, then `terminal send` once `terminal wait --for tui-idle`
reports the TUI settled); and steers a running one (send / wait / interrupt).

Requirements: an `orca` binary and a reachable runtime. The binary is looked up
as `$ORCA_CLI`, then the desktop install for the platform, then `orca` on PATH.
A session container should set `ORCA_CLI` and run `orca serve --no-pairing
--project-root <workspace>` beside the IDE; on a developer machine the desktop
app already provides one.

### Running the Orca runtime in a container (cluster notes)

The runtime is an Electron process, and that is the whole difficulty. Probed
against Orca 1.4.197's `orca-ide_1.4.197_amd64.deb` in a Debian container:

| container posture | result |
| --- | --- |
| default seccomp, Chromium sandbox on | **fails** — `Failed to move to new namespace … Operation not permitted`, as root *and* as uid 1000 |
| default seccomp, `ELECTRON_DISABLE_SANDBOX=1` | **works** — `runtime.state: ready` in ~2 s, no display |
| `--security-opt seccomp=unconfined`, sandbox on | works; `repo add` + `worktree list` verified end to end |
| `ELECTRON_DISABLE_SANDBOX=1` alone, repeated starts | **flaky** — some boots reach for X11 anyway and die: `Missing X server or $DISPLAY … The platform failed to initialize` → SIGSEGV |
| `ELECTRON_DISABLE_SANDBOX=1` + `xvfb-run` | **stable** — three cold starts, `state: ready` in 2 s each |

So the session image takes the first route and adds a virtual display: the
entrypoint exports `ELECTRON_DISABLE_SANDBOX=1` (unless
`STUDIO_ORCA_SANDBOX=1` says otherwise) and launches the runtime under
`xvfb-run` when the image has one. That combination needs no Pod privileges,
so it survives an admission policy that forbids `seccompProfile: Unconfined`.
Neither `ELECTRON_EXTRA_LAUNCH_ARGS` nor a `--no-sandbox` argument does
anything — the CLI rejects unknown flags.

The entrypoint also wipes `~/.config/orca` on every boot (opt out with
`STUDIO_ORCA_KEEP_STATE=1`). A second boot over a populated userData directory
was the reliable way to reproduce the X11 crash, and nothing of ours lives
there: the workspace is on the volume and the panel re-registers the repo.

Three more findings from the same probes, all baked into the Dockerfile:

* the Linux CLI is **`orca-ide`**, not `orca` (`/opt/Orca/resources/bin/orca-ide`,
  linked as `/usr/bin/orca-ide`);
* the package's `Depends` are incomplete — without the Electron runtime
  libraries the binary does not load at all (`libasound.so.2`);
* with those present, `orca-ide status --json` answers with **no display**.

Also expect two harmless log lines: no D-Bus, and "the OS keyring is
unavailable, so secrets are stored unencrypted" — Orca's own local state, in an
ephemeral container whose agent keys come from credstore per session.

Build and enable:

```bash
docker build -t cf-studio-theia:orca   --build-arg STUDIO_ORCA_DEB_URL=https://github.com/stablyai/orca/releases/download/v1.4.197/orca-ide_1.4.197_amd64.deb   --build-arg STUDIO_ORCA_DEB_SHA256=600a476981b839ba84da438d9b9a040b6877cfc65d015a23900c75d1410f7c19 .
```

Verified on that image: three `docker restart` cycles each reached
`state: ready` in 2 s, and the panel's own backend then registered the
workspace, created a process in the worktree, sent it a command and read the
answer back out of `terminal read`'s `result.terminal.tail`.

Then `gears.studio-session.config.orca_enabled: true` (k8s.yaml reads
`${STUDIO_ORCA_ENABLED:-false}`), which makes studio-session pass
`STUDIO_ORCA_ENABLED=1` and `STUDIO_ORCA_PORT` into the Pod. The agent keys are
the ones `agent_secrets` already provisions from credstore
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) — Orca runs the same CLIs. The image
costs ~270 MB more, which is why it is opt-in.

Tests: `cd studio && npx jest --config configs/jest.config.ts src/node/orca`.
`orca-service.test.ts` is offline (fixtures are trimmed real payloads);
`orca-live.acceptance.test.ts` drives a real runtime when one is available and
stands down otherwise.

## Validation

Run the gates separately:

```bash
npm test
npm run validate:browser-e2e
npm run validate:electron-build
```

The browser E2E creates a temporary repository and local bare remote. It does
not use external credentials or contact an external Git remote.

A manual real-remote smoke test is optional and is not part of automation.
Before running it, explicitly provide:

- exact `STUDIO_WORKSPACE_ROOT`;
- exact `STUDIO_GIT_BRANCH`;
- credential mechanism;
- authenticated proxy URL.

## Security boundary and non-goals

This is a single-user PoC, not a multi-user or multi-tenant service. Anyone who
can reach the authenticated Studio session can read and edit the mounted
Workspace and cause configured Git operations. Workspace Trust and the fixed
Workspace UI reduce accidental actions; they are not authentication or tenant
isolation.

The PoC does not provide user provisioning, tenant isolation, per-user
authorization, secret storage, sandboxed builds, remote Workspace cloning,
high availability, or production credential management. Production deployment
requires those controls outside this application.

## Development

```bash
npm run watch:browser
```

Electron:

```bash
npm run build:electron
npm run start:electron
```

The extension entry points are:

- frontend: `studio/lib/browser/studio-frontend-module`;
- backend: `studio/lib/node/studio-backend-module`.

The frontend contains browser UI only. Filesystem, process, Git, and other
host integrations remain in the Node backend and are exposed through typed
JSON-RPC services declared in `studio/src/common`.
