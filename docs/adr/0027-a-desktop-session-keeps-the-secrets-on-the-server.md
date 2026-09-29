---
type: adr
status: accepted
date: 2026-09-24
---

# ADR-0027: A desktop Studio is a session on the member's machine, and the secrets stay on the server

**ID**: `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server`

Status: accepted · 2026-09-24 · Extends ADR-0003 and ADR-0022 · Relates to ADR-0026

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

Studio has one way to work in the code: "Open Studio" asks `studio-session` for
a Theia container for the workspace (ADR-0003), the browser reaches it through a
gated proxy, and the container clones the sources onto a volume the backend also
reads — `artifact-ingest` finds the same tree at
`{workspaces_root}/{workspace_id}/{repo_dir}`. ADR-0022 then gave the backend a
way into a running session: a control API on an internal port of the container,
and an event ingress the container posts to with a per-session S2S token that
`studio-session` minted at launch.

Everything in that chain assumes the backend started the IDE. Some work does not
fit it: a member without a stable connection, a toolchain or device that does not
run in a container, an agent that should run with the member's own local
resources, or simply a container per workspace that costs money for as long as
somebody leaves a tab open.

A desktop build already exists. `theia/electron-app` is the same Theia 1.75 with
the same `studio` extension, and `theia/product-ext` came here from
`studio-desktop` — the packaged *Constructor Studio.app* — whose layout
`flow-backend.js` still probes for (`src/flow-mcp/REGISTER.md`). The PRD lists
that build as out of scope because nothing connects it to the server
(`docs/prd/constructor-studio.md` § 4.2), and its problem statement is exactly
why that is hard: a local IDE with an agent plugin cannot keep provider keys and
Git credentials out of the place where the work happens.

The question is what a desktop Studio is, such that it works against the same
backend, under the same identity and tenant model, without undoing
`cpt-studio-nfr-credential-isolation`.

## Decision Drivers

* No provider key or Git token on the member's machine. The session container
  already receives repository tokens as environment for its credential helper
  (`theia/docker/git-credentials.mjs`); a laptop is outside anything the
  organization governs, so the desktop must not get even that.
* One set of IDE extensions. `studio`, `product-ext`, `drawio-editor` and the
  Gearbox integration are built, tested and shipped from this repository (#282);
  a second copy is a sync debt with no owner, which is the one `TASKS.md`
  already closed for `product-ext`.
* The backend reaches nothing on the member's machine. A laptop is behind NAT, a
  VPN or a firewall; nothing may depend on an inbound port there.
* The same identity and the same clamp. A desktop call is the member's call, under
  a real `SecurityContext`, inside the member's tenant subtree (ADR-0009, ADR-0019).
* The hosted session stays the default. Nothing in this record changes how "Open
  Studio" works for somebody who never installs anything.

## Considered Options

* A thin shell around the hosted IDE
* A local frontend attached to a server-side Theia backend
* A desktop session: the IDE runs locally, Git is the data path, the backend is
  the control path and holds every secret
* Develop the desktop in the `studio-desktop` repository and sync the extensions

## Decision Outcome

Chosen option: "a desktop session", because it is the only option that makes the
desktop useful without a server container and still keeps every secret on the
server, and it grows out of `theia/electron-app` rather than out of a second
repository.

### 1. The desktop is `theia/electron-app`, built from the same extensions

The desktop assembly is `theia/electron-app` with exactly the extensions of
`theia/browser-app`. What `studio-desktop` knew and this repository does not —
the packaged layout (`Constructor Studio.app/Contents/Resources/app/…`, the asar
copies `REGISTER.md` describes), installers, signing and update — is brought in
**here**, as packaging of `electron-app`. The IDE's source is not forked back
out. An extension that behaves differently on the desktop does so through a
runtime check, not a second copy.

### 2. Sign-in is the member's own, through the system browser

The desktop signs in against the Studio Keycloak realm with the authorization
code flow and PKCE, redirecting to a loopback address (RFC 8252). The realm gets a
new public client, `studio-desktop`, next to `studio-portal`. The access token is
the member's Studio token, the same one the portal uses, so every desktop call
passes the ordinary authentication and the tenant clamp. The refresh token is
kept by Electron's `safeStorage` in the OS keychain and nowhere else.

### 3. Code moves through Git, and Git goes through the backend

A desktop session clones the workspace's sources to a folder the member chooses.
The remote it clones from is **not** the source host. It is a Git smart-HTTP
proxy in the backend, `/studio-git/v1/…`, that authenticates the member's Studio
token, resolves the repository to the workspace's source and its credstore
token exactly as `studio-session` does, and attaches the token on the way
upstream. This is `studio-llm-proxy`'s pattern applied to Git: the member holds
an identity, the server holds the key. The desktop's local credential helper
answers the proxy host with the Studio token and nothing else, so no source
host token is ever written to the machine.

In-IDE AI already works this way: `studio-llm-proxy` accepts the member's
Studio token, and the desktop configures Theia AI from its `client-config`
exactly as a container session does.

The backend learns about the code when it is pushed, not before. A push
through the proxy queues an `artifact-ingest` refresh of the server's checkout,
so the tree the graph is built from is the pushed tree. Work that was never
pushed is invisible to the server. That is a property of this design, not a gap
in it.

### 4. A desktop session is a lease, not a container

`studio-session` gains a second kind of session, a desktop session. The desktop
registers one when it opens a workspace and renews it with a heartbeat. The
runtime cannot be the registry here — no daemon knows about the member's laptop
— so a desktop session is a lease with an expiry, and it is gone when the
heartbeats stop. A desktop session has no container, no gate token, no control
port and no S2S token; it is keyed by `(workspace, member, device)`, and it does
not count against the one live container session per workspace.

**Nothing is limited.** A member may have a workspace open on any number of
devices, any number of members may have it open at once, and a container session
may run beside them all. A lease records where a workspace is open; it reserves
nothing. Git already reconciles the copies, so a policy that forbade any of this
would only refuse work that can proceed.

*As built (phase 3):* the lease is its own resource,
`/studio-session/v1/desktop-sessions`, not a `runtime` field on `/sessions`.
`POST` opens or renews it (201, then 200), `GET ?project_id=` lists a workspace's
live leases, and `DELETE /{id}` ends the caller's own. A desktop session has none
of what a `SessionDto` describes (a URL, a gate token, the `starting`/`running`
states), and `create_session` exists to launch a container, so sharing the route
would have meant a request half of whose fields mean nothing for one runtime. The
id is a UUIDv5 over the key. A lease lives three heartbeats (30 s each, 90 s in
all), and the window renews it, since only the window knows whether it is still
showing the workspace. State is per process, as in `studio-presence`: after a
restart, each desktop's next heartbeat writes its own lease back under the same
id. That is one interval of a desktop missing from the portal, instead of a
stored row that outlives the laptop it describes.

### 5. The bridge runs outward only

ADR-0022's two directions are kept and both start on the desktop:

* **Events** go to the same ingress, `POST /studio-theia/v1/events`, with the same
  `StudioRuntimeClient` payloads. The ingress authenticates a desktop by the
  member's token plus the desktop session id and resolves that to
  `(tenant, workspace)` from the lease, instead of resolving an S2S token.
* **Commands** from the portal reach a desktop session over the push channel
  (ADR-0026): the desktop subscribes to `studio-events` for its own session, and
  runs what it receives through the same `StudioRuntimeService` operation queue,
  so it keeps the journal, idempotency and audit it has in a container. The
  portal's `studio-theia` routes answer the same for either runtime; a command
  for a desktop session is queued, not called.

### 6. The portal opens the desktop by link

The workspace screen offers "Open in desktop" beside "Open Studio". It is a
`cfstudio://open?workspace={id}` link that the installed application registers
for. It carries no token; the desktop signs in itself.

### Consequences

* This record amends the PRD: § 4.2 no longer lists the `theia/electron-app`
  build as out of scope, § 4.1 lists the desktop session, and the goal "without
  a local checkout" is the default rather than the only way.
* `/studio-git/v1` is a new hot path. Every clone and fetch of a desktop session
  crosses the backend, so the proxy streams and never buffers a pack, and its
  bandwidth appears in the observability stack like any other gear's.
* `studio-session` stores state for the first time — the desktop leases. The
  "runtime is the registry" rule in its README still holds for containers and is
  stated as not applying to desktops.
* The `studio-theia` ingress gets a second authentication path, and it must not
  weaken the first: a desktop credential never resolves to a container session,
  and an S2S token never authenticates a desktop.
* `studio-desktop` stops being a separate source. Its packaging moves into this
  repository, and until it does the desktop is a development build only.
* A new client platform to support: Windows, macOS and Linux installers, code
  signing and automatic update. The Windows `EPERM` on a directory fsync that the
  `theia` test suite already hits (`theia/README.md` § Validation) becomes a
  defect of the product, not of a developer's checkout.
* New routes follow `docs/api-conventions.md` from the start, so the API
  contract ratchet (ADR-0020) covers them without a baseline entry.
  `studio-git` is added to `api_contract::DOMAINS`; its smart-HTTP routes speak
  Git's wire protocol rather than JSON, so the response-shape rules do not apply
  to them and the ratchet has to say so, not skip the domain.

### Confirmation

* The desktop build carries no secret. A test over the packaged application and
  over a signed-in profile finds no source host token, no provider key and no
  `credential.helper` naming one, and `.git/config` of every clone names only the
  proxy.
* On the Compose stack, a desktop session clones, commits and pushes through
  `/studio-git/v1`; the push is visible upstream, the server's checkout moves to
  it and `artifact-ingest` reports the new commit.
* A command issued from the portal to a desktop session arrives over
  `studio-events`, runs through the operation queue and its events come back
  through the ingress with the desktop session id.
* `api_contract` passes with no new baseline line.

## Pros and Cons of the Options

### A thin shell around the hosted IDE

An Electron window that opens the portal's IDE URL.

* Good, because it is a day of work and changes no contract.
* Good, because it keeps every property of the hosted session.
* Bad, because it offers nothing a browser tab does not: no offline work, no
  local toolchain, and the container still runs and still costs.

### A local frontend attached to a server-side Theia backend

The desktop renders the IDE and talks to a Theia backend in a server container,
in the manner of a remote development extension.

* Good, because the checkout and the credentials stay where they are today.
* Bad, because it still needs a container per session, so it removes none of the
  reasons to have a desktop.
* Bad, because Theia's frontend–backend protocol becomes a network contract over
  the internet, which ADR-0022 deliberately never exposed.

### A desktop session (chosen)

* Good, because the IDE, its agents and its toolchain run locally, and no
  container runs while a member works on the desktop.
* Good, because the secrets stay on the server: Git and the LLM are both proxied
  under the member's token.
* Good, because the portal, the bridge and the push channel keep one contract
  for both runtimes.
* Neutral, because the server sees work only once it is pushed.
* Bad, because it adds a Git proxy, a lease registry and a second ingress
  authentication path, and a desktop platform to ship.

### Develop the desktop in the `studio-desktop` repository and sync the extensions

* Good, because the packaging, signing and update work there already exist.
* Bad, because it recreates the vendoring debt `TASKS.md` closed: every change to
  the IDE would again carry a sync deadline nobody keeps.
* Bad, because that repository is not reachable from the accounts that build this
  one, so no sync could be automated.

## More Information

### Phases

1. **Sign-in and a local workspace.** The `studio-desktop` Keycloak client, PKCE
   sign-in in `electron-app`, the list of the member's workspaces and a clone
   through `/studio-git/v1`. Push goes through the proxy; the LLM through
   `studio-llm-proxy`.
2. **The server's checkout follows pushes.** The proxy queues an
   `artifact-ingest` refresh on each push.
3. **Desktop leases.** Desktop sessions in `studio-session`, heartbeat and
   expiry, and the portal showing that a workspace is open on a desktop.
4. **Events.** The desktop's forwarding `StudioRuntimeClient` and the ingress's
   desktop authentication path.
5. **Link and commands.** `cfstudio://` from the portal, and portal commands over
   `studio-events`.
6. **Packaging.** Installers, signing and update, moved in from `studio-desktop`.

### Open questions

* Access to `studio-desktop`. Its packaging is the one part of this record that
  depends on a repository this account cannot read (`gh` answers 404); phase 6
  needs it or needs to be written again.
* ~~Whether a desktop and a container session may be open on the same workspace
  at once.~~ Settled on 2026-09-28: yes, and nothing else is limited either (§4).
* How long a desktop may stay signed in offline before its refresh token expires,
  and whether the realm's offline token is the right tool for that.
* Git LFS and very large repositories through the proxy.
* SSH cloning stays out of scope, as for container sessions.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-ide-session` — a second runtime for a session, a lease instead of a container
* `cpt-studio-fr-theia-bridge` — events and commands for a session the backend did not launch
* `cpt-studio-fr-ide-llm-proxy` — the desktop's AI uses the existing proxy under the member's token
* `cpt-studio-fr-sign-in` — a public desktop client in the Studio realm, PKCE through the system browser
* `cpt-studio-fr-artifact-ingest` — the server's checkout follows pushes from a desktop
* `cpt-studio-fr-push-channel` — portal commands reach a desktop session over `studio-events`
* `cpt-studio-nfr-credential-isolation` — no source host token or provider key on the member's machine
* `cpt-studio-nfr-tenant-isolation` — every desktop call is the member's, under the tenant clamp
* `cpt-studio-component-session` — desktop leases beside container sessions
* `cpt-studio-component-theia-bridge` — a desktop authentication path on the ingress
* `cpt-studio-component-theia-studio` — one extension set for the browser and desktop assemblies
* `cpt-studio-component-theia-product-ext` — the packaged layout it already supports becomes a shipped one
* `cpt-studio-interface-portal-ide-bridge` — the same portal routes for either runtime
* `cpt-studio-usecase-open-ide-session` — "Open in desktop" beside "Open Studio"
