# 2026-09-24 — the desktop Studio (ADR-0027)

Phase 1 is #391 and the installer is its follow-up (`docs/desktop-studio.md`).
What was left out on purpose, or worked around to get a binary on one machine:

- [ ] Code-sign the Windows installer @andrejk666

  The installer is unsigned, so SmartScreen stops the first run ("More info" →
  "Run anyway"). Signing needs a code-signing certificate and a secret for
  `desktop-windows.yml`; electron-builder signs when `CSC_LINK` /
  `CSC_KEY_PASSWORD` are set. macOS additionally needs notarization.

- [ ] Hand out installers from CI only @andrejk666

  The first binary was built on a developer machine without MSVC:
  `node-pty` and `keytar` from their N-API prebuilds, `native-keymap` and
  `windows-ca-certs` copied from a VS Code install, and `drivelist` — which has
  no win32 prebuild anywhere — replaced by a stub, so file dialogs list no
  drives. None of that is in the repository; the `windows-2022` job compiles all
  of them. Publish its artifact (a GitHub Release per tag) and stop passing
  local builds around.

- [ ] Keep the sign-in across restarts @andrejk666

  The token lives in the IDE backend's memory, so every start signs in again.
  ADR-0027 §2 keeps the refresh token in the OS keychain through Electron's
  `safeStorage`; that part is not built.

- [ ] Automatic updates @andrejk666

  An installed build never learns there is a newer one. electron-updater
  against the releases above; decide the channel (one per stand, or one
  build that offers every stand, which is what `environments.json` already
  does).

- [ ] Add the `studio-desktop` client to every running realm @andrejk666

  A realm file is imported only when the realm is created, so an existing stand
  needs the client imported by hand (`docs/desktop-studio.md` → "What a Studio
  deployment needs"). Done on dev; **test still answers "Client not found"**.
  Better: make the realm bootstrap reconcile clients instead of importing once.

- [ ] Deploy `studio-git`, so a workspace opens from the desktop @andrejk666

  Until #391 is deployed, dev and test sign in and list workspaces but answer
  "cannot clone for a desktop yet". A merge to `main` does not build by itself —
  dispatch "Studio Delivery" afterwards.

- [ ] Build and try macOS and Linux @andrejk666

  `package.mjs` names dmg and AppImage targets; neither has been built. Needs a
  macOS runner (and notarization) and a Linux job.

- [ ] Unpin `windows-2022` @andrejk666

  `windows-latest` moved to Visual Studio 2026, which the node-gyp 10.x in
  theia's tree cannot find. Move the job back when the tree's node-gyp knows it.

- [ ] Make the desktop look like a desktop @andrejk666

  The window still carries session furniture: `product-ext`'s welcome page and
  an Orca panel that reports a runtime this machine may not have, and the
  Studio view is narrow enough to wrap every line.

- [ ] Open a project from the portal in the local desktop Studio @andrejk666

  A separate track. Today a member starts the desktop app, signs in and picks
  a workspace in its own Studio view. The portal should offer "Open in desktop"
  beside "Open Studio" and land them in that project in the app they already
  have installed (ADR-0027 §6):

  - the installer registers a `cfstudio://` protocol handler (electron-builder
    `protocols`), and the app handles the link on start and when already
    running (Electron `open-url` / second-instance);
  - the link names the Studio and the project,
    `cfstudio://open?studio=<url>&project=<id>`, and carries no token. The app
    switches to that Studio if it is one it offers (or asks first when it is
    not), signs in if it has to, and clones and opens the project through
    `studio-git` exactly as a click in its Studio view does;
  - the portal shows the button only when it can tell the app is installed.
    If it cannot, it shows "Get the desktop app" linking to the installer.

  Needs `studio-git` deployed (#391) for the clone, and the desktop installer
  (#395).

- [ ] ADR-0027 phases 3–5: leases, events, commands @andrejk666

  The portal does not know a workspace is open on a desktop, the desktop's
  events do not reach the ingress, and the portal cannot send it a command.
  `runtime: desktop` leases in `studio-session`, the ingress's desktop
  authentication path, and commands over `studio-events`.

# 2026-09-25 — "signed in as Vasil, and it was not Vasil"

Somebody was seen working as Vasil without being Vasil, and without ever
having used Vasil's browser. What the tests found, and what is still a
hypothesis:

- [ ] A shared IDE session acts as whoever launched it @andrejk666

  **Hypothesis for the incident, reproduced in a test.** `studio-session`
  keeps one session per workspace on purpose, so a second member does not
  destroy the first one's container (`two_callers_reach_one_workspace_session`).
  But a container is launched once, and its environment is built from the
  person who launched it: `STUDIO_ACTOR_ID`, the git author
  (`git_identity_env`), and the agent keys read from credstore under that
  person's identity, their private secrets first. The second member signs in
  to the portal correctly and holds their own token, and still commits, pushes
  and calls agents as the first, with the first person's keys.
  `studio_session::service::tests::the_second_member_of_a_workspace_does_not_work_as_the_first`
  reproduces it. It is `#[ignore]`d until this task is done: drop the ignore
  when it passes.

  **Still to confirm:** whether the incident was seen inside the IDE (commit
  author, agents, names in the IDE), which is this cause, or in the portal's
  user menu, which is not.

  **Direction:** several people in one container, each acting as themselves.
  Not one container per person. Roughly:
  - nothing personal in the container's environment;
  - the git author and the push credential per connection, from that
    connection's portal token (the credential helper asks the session gate
    who is typing);
  - agent and LLM calls through `studio-llm-proxy` under the caller's own
    token, instead of keys in env;
  - terminals and agent runs owned by the connection that started them;
  - `STUDIO_ACTOR_ID` replaced by the connection's identity wherever the
    Studio extension records who did something (journal, audit, presence).

  The Theia PoC was built single-user (ADR-0003 asked for one instance per
  user and workspace). **ADR-0030** (proposed) amends it: one container per
  workspace, identity per connection. What actually stands in the way:

  1. **Identity is baked into the environment at launch.** The git credential
     helper and the agent CLIs read it. Theia already has one plugin host per
     window (`HostedPluginProcess` in a `ConnectionContainerModule`), and its
     environment is extensible (`PluginHostEnvironmentVariable`), so identity
     can come from the connection. The portal already hands each window its
     own person's token.
  2. **One working tree for everybody:** one index, one branch, one set of
     uncommitted changes. A `git worktree` per person, as Orca already does
     per agent task.
  3. **One OS user for every process,** so members can read each other's
     `/proc/*/environ`, `~/.claude` and shell history. Keep nothing
     long-lived there and state the workspace as the trust boundary;
     per-person uids are a later step if that boundary must move.

  Phases in ADR-0030: no personal secrets in env (git through `studio-git`,
  models through `studio-llm-proxy`), then identity per connection, then
  "who did it" in the journal, audit and presence, then a worktree and a
  `HOME` per person.

  **Done (branch `AndrejK666/session-no-personal-env`):**
  - the session environment no longer carries the launcher's provider keys
    or git author (`a_session_carries_no_key_of_its_launcher`);
  - agents reach their models through `/studio-llm/v1/providers/*` on the
    caller's own key from their profile;
  - each window's Claude Code and Codex requests carry that window's person.

  **Still open:**
  - `STUDIO_ACTOR_ID` is still the launcher's, which is why the ignored test
    still fails;
  - commits carry the neutral author until the author comes from the
    connection;
  - a terminal `claude` or `codex`, and Orca's agents, have no token yet;
  - repository tokens still come in `STUDIO_SOURCES` (workspace
    connections, not personal).

- [ ] Decide what "Continue with Constructor ID" does with a live browser session @andrejk666

  `keycloak/tests/account-takeover.test.mjs` shows it. A browser still signed
  in to Keycloak as somebody else, because they closed the tab without
  signing out, signs the next person in as them with no form shown, since
  neither portal sends `prompt`. Sign-out itself is right in both portals
  (RP-initiated logout). The same test clears the other suspects: an outside
  IdP account carrying the victim's e-mail, verified or not (nOAuth), gets
  asked for the victim's password. That holds for the realm as
  `keycloak/realm-studio.json` configures it; the dev and test realms were not
  read. The desktop already sends `prompt=login` (#395).

  Options: a "Continue as <name>? / Not you" step before the silent sign-in,
  plus a shorter SSO idle timeout on the realm (recommended); or `prompt=login`
  on every sign-in.

# 2026-09-17

- [ ] Decide how a notification leaves Studio, then build it @andrejk666

  The collaboration work landed everything that keeps a conversation inside the
  product: threads that travel with the branch, who is waiting on whom, tasks in
  the documents, and all of it visible in the IDE and the portal. Requirement
  §10 of `studio-internal/requirements/studio-collaboration-comments-requirements.md`
  asks for the other half — *"you shouldn't have to go into the product to learn
  about comments"* — and that one is blocked on a decision rather than on work.

  Three ways, each of which adds a subsystem rather than a function:

  - **a project channel.** `studio-notify` already delivers to a chat connection
    with a queue, retries and a dead-letter table. What does not exist is any
    notion of *which* channel belongs to a project, so this starts with new
    configuration. Cheapest, and it is not a personal notification: the message
    says "three threads in X are waiting on Ana" to a room.
  - **personal e-mail.** `identity_directory::verified_email` is already "the
    only address in this system that may be decided from", and `studio-notify`
    already owns the queue. What is missing is a driver — there is no SMTP or
    e-mail provider anywhere in the backend. The only option that closes §10 as
    written, and the recommendation.
  - **a stored inbox.** Both gears refused this deliberately and said so:
    `studio-presence` is "a message is an event, not a mailbox", `studio-notify`
    delivers to a destination rather than to a person. It is the only one that
    answers "I was away yesterday".

  The trigger needs no new storage whichever is chosen: the previous
  `waiting_on` is on the repository node until the sync upserts over it, so
  reading it first and comparing is one extra read, and only an increase
  notifies.

- [x] Decide where `theia/product-ext` lives, rather than port it @andrejk666

  This was written as a port: the package was vendored from `studio-desktop`'s
  `app/product-ext`, its README said a change made only here was lost on the
  next sync, and most of what landed that day lived in it. What made it a debt
  rather than a task is that there was no sync — no `SOURCE.json`, no script,
  and the repository is not reachable from this account — so it was not a
  deadline anybody was keeping, it was one waiting for the next manual copy.

  Settled the other way instead: **the source lives here.** The three places
  that said otherwise now say that, and the package's README explains the one
  thing that looks like vendoring and is not — `flow-backend.js` probing for the
  MCP server under `lib/`, which is a packaged application's layout and must
  survive any later tidying.

# 2026-07-29

- [ ] Define the list of required Gears for Studio Cloud/Web v1 @artifizer
- [ ] Create domain-model folder and domain model definitions and playground @artifizer [#2](https://github.com/constructorfabric/studio-web/issues/2)

# 2026-07-28

- [x] Need to define repo structure to have both backend and frontend @artifizer
- [ ] To create initial v1 scope PRD @nrggit
- [x] Review gears-rust/ account-management gear and check if it has enough capabilities @andrejk666
- [ ] Theia review, ensure multi-user/multi-tenant source code management would work
