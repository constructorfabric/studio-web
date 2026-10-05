# `studio` — the Constructor Studio Theia extension

Everything the IDE session does beyond being an editor: the bridge to the
portal, the workspace's repositories, the document surfaces, and the panels
that report what the backend is doing.

The extension deliberately stays an extension. Theia will be upgraded, and a
patched Theia cannot be; every capability here is hung on a published
contribution point.

## What it contributes

| Surface | Widget id | Where |
|---|---|---|
| Agents (Orca) | `studio.orca` | right, open on a fresh session |
| Git Operations | `studio:git-operations` | bottom |
| Analyze | `studio:analyze` | bottom |
| Audit | `studio:audit` | bottom |
| Workspace Graph | `studio:workspace-graph` | on request — View menu or command |
| Object Details | `studio:object-details` | with the graph; it reads the graph's selection |
| Artifact Graph | `studio:artifact-graph` | on request |
| Workspace Sources | `studio:workspace-sources` | on request |
| Rendered markdown diff | `studio.markdownDiff:<uri>` | main area, one tab per comparison — [docs/rendered-markdown-diff.md](../../docs/rendered-markdown-diff.md) |

`DEFAULT_LAYOUT` in `src/browser/studio-contribution.ts` is the one place that
says what a fresh session opens on, and the Workbench perspective reads the same
list.

## Layout

- `src/common` — RPC contracts shared by both sides.
- `src/browser` — widgets, contributions, the portal bridge.
- `src/node` — the filesystem, git and backend integration, plus the S2S
  control API the backend calls (ADR-0022).

## Tests

    npm test

Jest, beside the sources. The node-side suites use real temporary
repositories rather than mocks, so a few of them need a POSIX filesystem to
pass — on Windows the symlink cases fail on permissions.
