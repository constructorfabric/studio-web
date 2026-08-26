# Registering studio-flow

**Starting a flow in Studio writes the Claude registration for you** — a
`.mcp.json` in the project, with the path this server actually has on this
machine. That is not the permission grant: your assistant still asks before it
starts a project MCP server, and that prompt is the grant. This document is what
you should read before answering it, and it carries the snippets for every case
Studio does not write: Codex, a second agent, a checkout on another machine.

Read what it grants before approving it.

---

## What registering this server grants

The agent gains, and only gains:

- **Read** of `<STUDIO_PROJECT_ROOT>/.studio/flow/` — the flow's own record:
  the destination, the questions, the answers, coverage, assumptions, gates,
  capabilities, gaps and their exits. All of it is already committed and already
  visible through the filesystem; the server makes it *structured* rather than
  newly visible, and it folds every author's log into one state the way the rail
  does.
- **Read** of `<STUDIO_PROJECT_ROOT>/.studio/quality/reports/` — detector
  findings that are already on disk.
- **Append** to exactly one file: `.studio/flow/agent-<name>.jsonl`.
  `agent-claude.jsonl` for the Claude registration, `agent-codex.jsonl` for the
  Codex one.

It does not gain, and the server has no code path to:

- write or delete **another author's log**, so it cannot forge, alter or erase
  what a person answered;
- write **any document except the intent one, and that only through
  `write_answer`** — one heading, one line, marked `stated` or `assumed`, keeping
  the `cpt-` id the rail reads. It exists because an agent composing that line by
  hand gets it subtly wrong in a way that reads perfectly. Everything else — the
  PRD, a design, a prototype — goes through the agent's own file tools, which you
  granted separately and can see, and lands in Studio's review pipeline as
  proposals you accept hunk by hunk;
- read or write **anything at all** outside `.studio/flow/` and
  `.studio/quality/reports/`;
- reach the network. `record_fetch` records that the *agent* downloaded
  something; the server does not fetch;
- **waive a gate**, or stamp a gate whose condition the fold does not satisfy;
- **compose a block that exists only on paper**, or place a proposed block in any
  bucket without its evidence chain — a design line and a registry line.

Everything it writes lands in a committed, append-only file and shows up in the
next `git diff`. There is no silent write.

---

## Paths

| | |
| --- | --- |
| server, in a checkout | `app/product-ext/lib/flow-mcp/server.mjs` |
| server, in an installed application | `Constructor Studio.app/Contents/Resources/app/flow-mcp/server.mjs` |
| project root (holds `.studio/`) | the green-field project you are working in |

The second path is a copy, made at packaging time, and it is not tidiness: in a
packaged application `flow-spec.js` and `flow-log.js` — the two modules this
server loads rather than mirroring — exist only inside the frontend bundle, and
nothing can spawn a script out of an asar archive. The copy puts all three side
by side; the server tries `../browser` first and its own directory second.

`STUDIO_PROJECT_ROOT` is optional. Without it the server walks up from its
working directory looking for `.studio/flow/flow.json`, which is why the
registration Studio writes does not name a project and therefore survives being
committed. If there is no flow at or above where it started, **it refuses to
start** rather than reporting an empty flow. That failure mode is deliberate: an
agent that silently sees no questions will confidently do nothing, and nobody
will know why for an hour.

---

## Claude — project-scoped `.mcp.json`

This is the one Studio writes. It looks like this, and the shape is deliberate:

```json
{
  "mcpServers": {
    "studio-flow": {
      "command": "${STUDIO_FLOW_NODE:-/path/to/Constructor Studio.app/Contents/MacOS/...}",
      "args": ["${STUDIO_FLOW_MCP:-/path/to/.../flow-mcp/server.mjs}"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "STUDIO_AGENT": "${STUDIO_AGENT:-assistant}" }
    }
  }
}
```

Three things about it:

- **`${VAR:-default}`, both times.** The default is this machine's absolute path,
  which is what makes it work with no setup. The variable is what makes the file
  worth committing: a colleague who checks the repository out somewhere else sets
  `STUDIO_FLOW_MCP` rather than editing a tracked file. A path baked in with no
  way past it is a file every team ends up gitignoring, and then nobody has the
  tools.
- **The command is the application binary, not `node`.** Run with
  `ELECTRON_RUN_AS_NODE=1` it *is* node, and it is always present — where a `node`
  on `PATH` is the commonest reason a registration that reads correctly never
  starts.
- **No `STUDIO_PROJECT_ROOT`.** The server finds the project by walking up from
  its working directory, so the entry says nothing machine-specific about *which*
  project it is.

If you already have a `.mcp.json`, Studio merges this key in and leaves the rest
alone; if the file is there and unparseable it refuses and says so, rather than
rewriting what you wrote.

## Codex — `~/.codex/config.toml`

Studio does not write this one: it is a file in your home directory, shared by
every project, and that is not a file a project should edit.

```toml
[mcp_servers.studio-flow]
command = "node"
args = ["/absolute/path/to/studio-desktop/app/product-ext/lib/flow-mcp/server.mjs"]
env = { STUDIO_PROJECT_ROOT = "/absolute/path/to/the/project", STUDIO_AGENT = "codex" }
```

`STUDIO_PROJECT_ROOT` **is** worth setting here, because the config is global and
Codex may not be started from the project.

`STUDIO_AGENT` decides which file the agent appends to and which name appears
beside its ops. Two agents registered with the same token would share a log file,
which is the one thing this format exists to prevent — give them different ones.

---

## Checking it

```sh
STUDIO_PROJECT_ROOT=/path/to/project STUDIO_AGENT=claude \
  node app/product-ext/lib/flow-mcp/server.mjs <<'EOF'
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"flow_state","arguments":{}}}
EOF
```

Two JSON lines come back: the handshake, and the state. The end-to-end suite is
`tests/flow-mcp-test.mjs` (`node tests/flow-mcp-test.mjs`), which drives the real
process over the real protocol, including every refusal above.

`tests/flow-smoke.mjs` checks the other half, and it is the one that catches a
registration that reads correctly and does not work: it takes the `.mcp.json`
Studio wrote, expands the variables the way an assistant does, spawns exactly
that command, and asks the server for the flow.

---

## Why this is a second server rather than more tools on `studio-comments`

They are different permission grants. `studio-comments` grants a write channel
into a review conversation; this grants one into the project's own state machine.
Somebody may reasonably want the first without the second — a reviewer agent that
answers comments and touches nothing else — and merging them removes that choice.
