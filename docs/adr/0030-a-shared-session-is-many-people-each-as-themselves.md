---
type: adr
status: proposed
date: 2026-09-25
---

# ADR-0030: A shared IDE session is many people, each acting as themselves

**ID**: `cpt-studio-adr-a-shared-session-is-many-people-each-as-themselves`

Status: proposed · 2026-09-25 · Amends ADR-0003 · Relates to ADR-0022, ADR-0027

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Drivers](#decision-drivers)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [Consequences](#consequences)
  - [Confirmation](#confirmation)
- [Pros and Cons of the Options](#pros-and-cons-of-the-options)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0003 took the Theia PoC as it was, single-user: one process, one fixed
workspace, one person, "one instance per user and workspace". The service did
not stay there. `studio-session` now keeps **one session per workspace**, on
purpose, because keying it any finer let a second member's launch destroy the
first one's container while they typed in it
(`two_callers_reach_one_workspace_session`).

The container still believes it has one user. Its environment is built once,
from whoever launched it: `STUDIO_ACTOR_ID`, the git author
(`git_identity_env`), the repository tokens, and the agent keys read from
credstore under that person's identity, their private secrets first. The git
credential helper and the agent CLIs read that environment. So the second
member — signed in to the portal correctly, holding their own token — commits,
pushes and calls agents as the first, on the first person's keys.
`studio_session::service::tests::the_second_member_of_a_workspace_does_not_work_as_the_first`
reproduces it. It is the leading explanation of a member seen working as
somebody else who never used that person's browser.

The question is how several people share one workspace's IDE without any of
them acting as another.

## Decision Drivers

* Every commit, push, agent call and audit record names the person whose
  keyboard it came from.
* No personal long-lived secret in a container that other people type into:
  processes of one container run as one OS user, and anything in an
  environment or a home directory is readable by every other process there.
* A second member must still not destroy the first one's session. That was the
  reason for sharing, and it stands.
* Two people must not trample one working tree: one index, one checked-out
  branch and one set of uncommitted changes shared by all is a collision even
  when identities are right.
* Cost: a container per person per workspace multiplies the most expensive
  thing Studio runs.

## Considered Options

* One container per person and workspace
* One container per workspace, identity per connection
* One container per workspace, and a second person is refused while it is open

## Decision Outcome

Chosen option: "one container per workspace, identity per connection",
because it keeps sharing, which the product wants and which fixed a real
defect, and it puts identity where it already is: every IDE window is opened
by the portal with that person's own token.

### 1. Nothing personal in the container's environment

`studio-session` stops injecting the launcher's `STUDIO_ACTOR_ID`, git author,
personal PAT and agent keys. Repository access and model access go through
the backend under the caller's token: the Git proxy of ADR-0027 (`studio-git`)
and `studio-llm-proxy`. A container that holds no secrets has no secrets to
leak to the other people in it.

### 2. Identity is per connection

Theia already scopes much of its backend to a frontend connection: a
`ConnectionContainerModule` gives each window its own container of services,
and `HostedPluginProcess`, the host of `vscode.git` and every VS Code
extension, is bound there. There is one plugin host per window, and its
environment is extended through `PluginHostEnvironmentVariable`. The studio
extension:

* receives the person's token from the portal bridge, as it does today, and
  hands it to the backend for that connection;
* gives that connection's plugin host, terminals and agent runs an
  environment of their own: the git author, and a credential broker address
  that answers with that person's token. This is the desktop's broker and
  helper (ADR-0027), keyed by connection;
* records that connection's person, not `STUDIO_ACTOR_ID`, wherever it writes
  who did something: the operation journal, the audit trail, presence.

### 3. A working tree per person

Each person works in their own `git worktree` of each source, inside the same
container. That gives each their own index, branch and uncommitted changes,
and they meet at push, as two people on two machines do. Orca already
creates worktrees per agent task; this is the same mechanism for people.

### 4. The trust boundary is the workspace, and that is written down

The processes of one container run as one OS user. A member can in principle
read another member's processes and files there. With nothing long-lived in
the container, what is exposed is short-lived tokens and the code everybody in
the workspace may read anyway. That is accepted and stated. Per-person OS
users are the step after, if the boundary has to move inside a workspace.

### Consequences

* ADR-0003's "one instance per user and workspace" is replaced by "one
  instance per workspace, one identity per connection".
* A session needs `studio-git` and `studio-llm-proxy` to reach anything
  private. A deployment without them gets an IDE that reads public sources and
  has no model access.
* The studio extension gains connection-scoped state. The agent CLIs (Claude
  Code, Codex) need a `HOME` per person, so their own caches and logins do not
  mix.
* Orca's worktrees and the people's worktrees share one disk. The PVC is sized
  for the people of the workspace, not for one.

### Confirmation

* `the_second_member_of_a_workspace_does_not_work_as_the_first` passes and
  loses its `#[ignore]`.
* A session container's environment carries no personal secret. The
  launch-spec test asserts it for every variable `studio-session` sets.
* In a session opened by two people, a commit from each window carries that
  window's author, and a push from each is refused when that person may not
  push.

## Pros and Cons of the Options

### One container per person and workspace

* Good, because it is what the PoC was built for and needs no change inside
  Theia.
* Bad, because it multiplies the cost of the most expensive thing Studio runs
  by the number of people.
* Bad, because two people on one workspace no longer see each other's work
  until it is pushed, which is what sharing was for.

### One container per workspace, identity per connection (chosen)

* Good, because it keeps sharing and one container's cost.
* Good, because the identity already arrives per window, from the portal.
* Neutral, because the trust boundary is the workspace, stated rather than
  enforced inside it.
* Bad, because the studio extension, the credential path and the agent runs
  all become connection-aware. That is real work inside Theia.

### One container per workspace, and a second person is refused

* Good, because it is a check in `studio-session` and nothing else.
* Bad, because it forbids working together, which the product wants.

## More Information

### Phases

1. **No personal secrets in the environment.** Git through `studio-git`,
   models through `studio-llm-proxy`. On its own this already stops the second
   member from using the first one's keys.
2. **Identity per connection.** The portal token handed to the backend per
   connection; plugin host, terminals and agent runs with that person's
   environment and credential broker.
3. **Who did it.** The journal, audit and presence write the connection's
   person.
4. **A worktree per person**, and a `HOME` per person for the agent CLIs.

### Evidence

* `studio-backend/src/studio_session/service.rs`: `create()` reuses the live
  session for any caller who reaches the workspace; `agent_env` and
  `git_identity_env` are built from the launcher's context.
* `@theia/plugin-ext`: `HostedPluginProcess` is bound in a
  `ConnectionContainerModule` (`plugin-ext-hosted-backend-module.js`), and
  its environment passes through `PluginHostEnvironmentVariable` contributions
  (`hosted-plugin-process.js`).
* `keycloak/tests/account-takeover.test.mjs`: the other routes to a wrong
  identity, an outside IdP account with somebody's e-mail and a browser left
  signed in, and what each one does.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-ide-session` — one session per workspace, one identity per connection
* `cpt-studio-nfr-credential-isolation` — no personal secret in a container that several people type into
* `cpt-studio-fr-ide-llm-proxy` — model access under the caller's token, not keys in env
* `cpt-studio-component-session` — what `studio-session` stops injecting
* `cpt-studio-component-theia-studio` — connection-scoped identity in the studio extension
* `cpt-studio-adr-theia-sessions` — the ADR this amends
