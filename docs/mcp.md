# Studio over MCP

Studio's domain model, the requirements its specifications state and the
spec-quality detectors, as tools in the agent you already work in: Claude
Code, Codex, Cursor or any other MCP client. It is one more way into Studio,
not a replacement for the portal; what you see and decide in the portal stays
there.

Every call acts as you. The server sends each tool's requests to Studio's own
REST API with your token, so a tool can do exactly what you can do in the
portal and nothing more.

| | |
| --- | --- |
| Endpoint (dev) | `https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages` |
| Transport | Streamable HTTP, JSON answers only (no stream) |
| Protocol | 2025-06-18, also 2025-03-26 and 2024-11-05 |
| Sign-in | `Authorization: Bearer <your Studio access token>` |
| Server | `studio-backend/src/mcp/` (gear `studio-mcp`) |

## 1. Get a token

The server takes the same access token the portal uses. Tokens of the `studio`
realm last one hour.

**From the portal.** Sign in at `https://studio-dev.cfabric.org`, open the
browser's developer tools, *Network*, pick any request to `/cf/…`, and copy the
value after `Bearer ` in its `Authorization` header.

**With a password**, if your account signs in with one (not GitHub, Google or
Microsoft):

```sh
export STUDIO_TOKEN=$(curl -s https://studio-dev.cfabric.org/auth/realms/studio/protocol/openid-connect/token \
  -d grant_type=password -d client_id=studio-portal \
  --data-urlencode username=you@example.com --data-urlencode password='…' | jq -r .access_token)
```

Keep it in an environment variable, `STUDIO_TOKEN` below, never in a file you
commit. When it expires, tool calls answer `401`: take a new one and restart
the agent's MCP connection.

Signing in from the agent itself (OAuth, no token to copy) is the next step;
see *Not yet* below.

## 2. Register the server

### Claude Code

```sh
claude mcp add --transport http studio \
  https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages \
  --header "Authorization: Bearer $STUDIO_TOKEN"
```

That writes the token into your user settings. To keep it out of every file,
use a project `.mcp.json`, which expands variables when the server starts:

```json
{
  "mcpServers": {
    "studio": {
      "type": "http",
      "url": "https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages",
      "headers": { "Authorization": "Bearer ${STUDIO_TOKEN}" }
    }
  }
}
```

Check it with `/mcp` inside Claude Code: `studio` is *connected* and lists its
tools.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.studio]
url = "https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages"
bearer_token_env_var = "STUDIO_TOKEN"
```

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "studio": {
      "url": "https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages",
      "headers": { "Authorization": "Bearer ${env:STUDIO_TOKEN}" }
    }
  }
}
```

### Anything else

POST one JSON-RPC message to the endpoint with the header; the answer is one
JSON body:

```sh
curl -s https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages \
  -H "Authorization: Bearer $STUDIO_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 3. The tools

A project is named by `project_id`: the id in the portal's address of that
project.

| Tool | What it answers |
| --- | --- |
| `domain_model_types` | every type of the domain model, as stored |
| `domain_type` | one type with everything it inherits |
| `domain_type_conformance` | how stored objects measure up against a type |
| `domain_model_query` | a type's objects: filtered, ordered, with relations |
| `domain_model_graph` | the model as a graph of types |
| `project_capabilities` | the capabilities a project's documents need |
| `project_requirements` | the non-functional statements its documents make |
| `project_plan` | the gears that could provide each capability |
| `project_findings` | where the documents and the code disagree |
| `spec_check` | a detector's verdict on the text you send |
| `spec_check_result` | the verdict of a check that took longer than the wait |

The agent reads each tool's own description from `tools/list`; that text is
the reference, and this table only orients you.

**Where text comes from.** `spec_check` checks the text the agent sends, saved
or not, so a draft is checked before you commit it. The `project_*` tools read
the documents Studio holds for the project, its repositories as last synced,
not your working copy.

**A check takes time.** A detector runs from seconds to minutes. `spec_check`
waits up to `wait_seconds` (60 by default, 600 at most); if the detector is not
done by then it answers `running` with the ids to pass to `spec_check_result`.

Things to ask:

- "Check docs/PRD.md with the purpose detector before I commit it."
- "Which fields does the `project` type have, including inherited ones?"
- "What does project `<id>` need that its code does not provide?"

## 4. When something is wrong

| What you see | Why |
| --- | --- |
| `401` when connecting | the token expired or is not sent; check the variable the config reads |
| a tool answers `Studio answered 403: …` | you may not do that in the portal either |
| `Studio answered 503: … is not part of this deployment` | the gear the tool needs is not running here |
| `spec_check` fails with `upstream not configured` | the spec-quality service has no key on this deployment |

## Not yet

- **Sign-in from the agent (OAuth).** MCP clients can sign in by themselves
  through the authorization server; Studio's Keycloak is not set up for it
  yet, so a token is copied by hand.
- **Writes.** Every tool reads or checks. Changing the domain model or
  recording requirements comes once a change made by an agent is a proposal a
  person accepts.

## Adding a tool

A tool lives with the gear whose routes it calls, in that gear's `mcp.rs`
(`src/domain_model/mcp.rs` is the pattern), and is listed in
`crate::mcp::tools()`. It is a route and a description: `Run::Get` and
`Run::Post` send the arguments to one route; `Run::Custom` is for more than one
request, as `spec_check` submits and then waits. Write the description for the
agent: what the tool answers, when to call it, what it does not do. That text
is all the agent knows about it.
