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

### The two extensions, and their opposite layouts

`studio/` and `drawio-editor/` are TypeScript: source in `src/`, `tsc` output in
`lib/`, which is generated and git-ignored. Its entry points are:

- frontend: `studio/lib/browser/studio-frontend-module`;
- backend: `studio/lib/node/studio-backend-module`.

`product-ext/` is the opposite: hand-written JavaScript with **no build step**,
so its `src/` is the code that runs and is edited directly. It has its own
`README.md`; read that before changing anything in it, because the package is
vendored from `studio-desktop` and an unported change here is lost on the next
sync.

The frontend contains browser UI only. Filesystem, process, Git, and other
host integrations remain in the Node backend and are exposed through typed
JSON-RPC services declared in `studio/src/common`.
