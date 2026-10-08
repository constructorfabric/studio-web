# The desktop Studio

The desktop Studio is the IDE running on a member's own machine, as an
installed application, and connected to a Studio deployment — dev, test, a
local stack, or any other. It is the same Theia application a session runs in
a container (`theia/electron-app` has the extensions of `theia/browser-app`),
with one difference that decides everything else: the backend did not start
it, so nothing on the member's machine may hold a secret of the
organization's. [ADR-0027](adr/0027-a-desktop-session-keeps-the-secrets-on-the-server.md)
is the decision; this page is how to build, configure and run it.
Changing it? [desktop-contributing.md](desktop-contributing.md) has the rules.
What each release changed is in [desktop-release-notes.md](desktop-release-notes.md).

What a member does:

1. Starts **Constructor Studio**, picks the Studio on the landing page or in
   the **Constructor Studio** view (Dev, Test, Local, or an address), and
   clicks **Sign in with Constructor ID**.
2. Signs in on the realm's own page, in the system browser. The app waits on a
   loopback port and takes the answer.
3. Sees the projects they can reach — found the way the portal finds them:
   the organizations they are a **member** of (`studio-user`
   `/me/memberships`), and each one's `workspace` tenants, which the portal
   calls projects — and clicks one to open it: its sources are cloned through
   the Studio and the folder opens in the IDE. The organization is named only
   when there is more than one, as the portal hides it.

Or the member clicks **Desktop IDE** on a project in the portal. The portal
opens `cfstudio://open?studio=…&issuer=…&project=…&name=…`, a link the
installer registers and that carries no token
(`theia/studio/src/common/desktop-link.ts`). The app, started or already
running, does what the three steps above do: it connects to the Studio the
link names (asking first when this build does not offer it), signs in if it
has to, and clones and opens the project
(`browser/desktop-link-handler.ts`, ADR-0027 §6).

### The landing page

The app starts in a placeholder folder (`~/ConstructorStudio/workspace`, the
backend's `STUDIO_WORKSPACE_ROOT`, reported as `startFolder` by
`/studio-desktop/status`). While that folder, or no folder, is open, the main
area shows a **Welcome** page instead of the product's start page, which would
read the placeholder as a project
(`theia/studio/src/browser/desktop-landing-widget.tsx`; what it decides is in
`desktop-landing-state.ts`, with its tests). Top to bottom:

- **Connect**: signed out, what signing in gives, the Studio picker and **Sign
  in with Constructor ID** (the same `/studio-desktop/*` routes as the view);
  while signing in, a wait for the browser; a Studio that cannot be reached is
  said so, and **Open folder…** becomes the primary action. Signed in,
  **Choose a project**: the member's organizations, workspaces and projects
  with a filter, the no-repositories state per row, and the same clone with
  progress as the view. No organization yet, or projects that could not load,
  each say what to do.
- **Modes**: one card per mode of the mode picker (`MODES` in
  `studio-mode-bar.tsx`: its label, icon and title), each switching to that
  mode. **Got it** hides them on this machine (the IDE's local storage,
  `studio.desktop.landing.onboarding-dismissed`, a boolean); **Help → Welcome**
  opens the page and shows them again, in any window.
- **Work offline**: Theia's **Open folder…** and the recently opened folders.

**A project opens in place, without reloading the window**
(`desktop-open-project.ts`). `WorkspaceService.open(folder, { preserveWindow })`
changes the workspace by reloading the whole frontend -- panels, assistants and
the plugin host start again -- which is what a member saw after signing in and
picking a project. Theia changes a *workspace file's* folders in place (how
**Add Folder to Workspace** works), so the Studio view, this page's projects
and recent folders, and `cfstudio://` links open a project as one: `save` to
`<project>.theia-workspace` beside its folder (in place, and named after the
project, so the title bar and the Explorer say its name), then `spliceRoots`
to the project's folder, which fires `onWorkspaceChanged` for everything that
shows a folder. The next start reopens that file, the most recently used
workspace, so the member lands in the project. A recent *workspace file* is
still opened by Theia's `open`, which loads it.

The page is a widget in the main dock, so the start page — a layer of the
*empty* dock — yields to it by its own rule and comes back once a real project
or folder is open. The landing is the page for *no project*; the start pages
are per mode, for the project that is open (Doc editing's is product-ext's
own, the others are registered by `theia/studio` and `theia/gearbox-studio`
into product-ext's page registry, `product-ext/src/browser/start-pages.js`). It cannot be
closed in the placeholder. The **Workspace source suggestion** notification is
not raised for the placeholder folder (a `WorkspaceSuggestionGate` the desktop
binds; a session binds none). Both are bound only by the electron frontend
module, so a session never loads them.

### The Constructor Studio view

Top to bottom (`theia/studio/src/browser/desktop-studio-widget.tsx`; what it
decides is in `desktop-studio-tree.ts`, with its tests):

- **Account**: which Studio (the environment's name and host), who is signed
  in, **Switch Studio** and **Sign out**.
- **The project this window has open**, as a card: its name, its organization
  and workspace, how many repositories it has, and **Open in portal**, which
  opens `<studio>/?screen=projects;org=…;workspace=…[;project=…]` in the
  browser. While a project opens, the card shows the clone progress instead.
- **Projects**: organizations → workspaces → nested projects as a tree, with a
  filter by name. Rows fold with the chevron or the arrow keys (Up/Down,
  Left/Right, Home/End, Enter/Space opens); which rows are folded is kept per
  Studio in the IDE's local storage (`studio.desktop.tree.collapsed:<studio>`,
  a list of tenant ids, no secret). Organizations that share a name show the
  start of their tenant id, and the member's role in each where the roles
  differ.
- Once the tree is loaded, the view asks `studio-git` `GET /sources` for each
  workspace and project, four at a time — the same listing an open starts
  with. A project with none is muted and says **No repositories yet**, with a
  link to it in the portal; clicking it asks again, and opens it if a
  repository has been added since. When the listing cannot say (a Studio
  without `studio-git`, a 5xx), the row stays clickable, and a failed open is
  shown under that row.

The app's own settings are not in the view: which updates it takes is in
**Settings** ([Updates](#updates)), and *Help → Check for Updates…* checks now.

The landing page and the view are two faces of one client: both call the
desktop backend's routes through `desktop-studio-client.ts` and draw the same
Studio picker (`desktop-studio-picker.tsx`). A sign-in, sign-out, Studio switch
or open done in one is announced (`announceDesktopChange`, `onDesktopChange`),
and the other refreshes without announcing again, so the two never disagree
about who is signed in where.

## One IDE, two hosts

`theia/studio` and `theia/product-ext` are the **same code** in the portal's
session (`browser-app`, in a container, the portal hands it a token) and on the
desktop (`electron-app`, the member signs in here). Every desktop change has to
leave the web session exactly as it was. What keeps them apart today:

- The backend's `DesktopStudioContribution` mounts `/studio-desktop/*` and its
  `/studio-api` proxy **only** when a Studio is configured
  (`STUDIO_DESKTOP_URL` / `_ENVIRONMENTS`). A session image sets neither, so
  there the routes do not exist and the session gate keeps serving `studio-api`.
- The frontend opens the Constructor Studio view only when
  `studio-desktop/status` answers `enabled`; in a session that request 404s and
  the view never shows.
- Desktop-only logic lives in `desktop-*` files (`desktop-studio-client.ts`,
  `desktop-studio-widget.tsx`, `desktop-landing-*.ts(x)`, `desktop-projects.ts`,
  `node/desktop-*.ts`). Shared widgets call Studio through
  `StudioApi.fetch('/<gear>/v1/...')` and must not care which host answers it.
- What a session must not even load is bound only by the electron frontend
  module (`electron-browser/studio-electron-frontend-module.ts`: the landing
  page, the update channel), or is a dependency of `electron-app` alone
  (`@theia/vsx-registry`, `theia/studio-kits-view`). `browser-app` never loads
  either.

So, when improving the desktop:

1. Branch on the host by the status (`enabled`), never by `process.versions.electron`
   or a build flag — the same bundle is tested in both.
2. Do not change what a shared widget asks for to suit the desktop; add to the
   desktop proxy instead.
3. Before merging, open a portal session as well as the desktop app: the
   Documents, Sources and Analyze views must behave as before.

The full rules, and the checks before a PR, are in
[desktop-contributing.md](desktop-contributing.md).

## How it connects, and what it never holds

| Need | How | On the member's machine |
|---|---|---|
| Who the member is | OIDC authorization code with PKCE, public client `studio-desktop`, loopback redirect (RFC 8252) | the member's Studio token, in the IDE backend's memory |
| Studio's APIs | the IDE backend proxies `studio-api/*` to `<studio>/cf/*` and attaches the token | nothing: the frontend never sees the token |
| Source code | `git` against `<studio>/cf/studio-git/v1/workspaces/{id}/sources/{name}`, a proxy that attaches the source host's token from credstore | a credential helper path in `.git/config`, no token |
| `git` credentials | `theia/studio/scripts/desktop-git-credentials.mjs` asks the IDE backend's token broker, over loopback, for a fresh Studio token | a per-run secret in the environment, worthless once the app exits |
| Where a project is open | each window beats every 30 s; the IDE backend renews a lease at `<studio>/cf/studio-session/v1/desktop-sessions` as this device, and ends it when the window closes (ADR-0027 §4) | a random device id in `settings.json` |

What the desktop writes to disk is the member's choice of Studio
(`~/ConstructorStudio/settings.json`), the clones
(`~/ConstructorStudio/workspaces/<workspace>`), and the files the paragraphs
below name, each with what it holds; none is a secret. `settings.json` also keeps
`deviceId`, a random UUID drawn on the first lease, so that a restarted app renews
the leases it had. It names the installation and nothing else. It is not a
credential: every lease call is authorized by the member's token, and a copied
id only makes two machines look like one in the portal's list.

Gearbox's Generate, Build and Run write inside the product's generated tree,
`.gearbox/<product>/<profile>/` in the clone: the tree the engine generates,
cargo's build output, and `config/<application>.local.yaml`, the run
configuration with a Postgres section whose password is `${GEARS_PG_PASSWORD}`
(a reference, not a value). **Start a local Postgres** creates a docker
container `gbx-pg-<product>` on `127.0.0.1:5432` with the local development
password `gears`, the value the Run terminal gets when `GEARS_PG_PASSWORD` is
unset; it holds the product's development data and nothing of Studio's.

One more, when the member opens an Orca agent's terminal: the IDE streams it
over the Orca runtime's WebSocket, which takes a paired device. A session is
paired when Orca starts in it; on the desktop the Orca app is already running,
and only its window can issue a pairing. So the first **Open** on an agent (or
**Orca: Pair with Orca on This Computer**) asks for the link Orca generates —
*Settings → Pair another Orca client → This computer → generate an access
link* — and keeps it in `~/ConstructorStudio/orca-pairing`, readable by the
member only. It is Orca's token for this machine's own runtime on
`127.0.0.1`, not a Studio secret; revoking it in Orca, or deleting the file,
undoes it. How Studio finds Orca at all is
[Agent development](#agent-development-orca). Beside it,
`~/ConstructorStudio/orca-projects.json` lists the repositories Studio itself
added to that Orca, so that it removes only those
([Projects in the member's Orca](#projects-in-the-members-orca)). It holds ids
and paths, no secret.

And the extensions the app brings ([The assistant extensions](#the-assistant-extensions)).
Claude Code and Codex are installed from open-vsx on first start as the
member's own extensions, where Theia keeps any extension the view installs;
`~/ConstructorStudio/plugins/.open-vsx-installed.json` remembers which ids the
app installed, so that one the member removed stays removed. The CLI and the
Gearbox engine are unpacked into `~/ConstructorStudio/plugins/<id>-<version>/`,
checked against the digest the build recorded. An uninstall that could not
finish on Windows is recorded in `<data>/pending-plugin-removals.json` and
finished on the next start. All of it is extension code and ids, no secret;
deleting it only means the app fetches the extensions again.

And the gear corpus: "Bring the gears here" (in the Catalogue, or inline in
New Product) clones it once per machine and commit into
`~/ConstructorStudio/corpus/<host__owner__repo>/<commit12>/<source id>`
(`STUDIO_CORPUS_CACHE` moves it), and a product that names a git source at a
commit (`git(url, rev)`) is brought into the same place when it opens,
instead of into the project. A private corpus is cloned through the Studio
relay with the credential helper given for that one command, so the copy's
`.git/config` names no helper and no token. Each copy is a fixed commit and
never fetches again; deleting one only means it is cloned again.

Beside each copy, `<commit12>/.catalogue/<digest>.json` holds the gear catalogue
the engine projected from it: the gears' names, contracts, capabilities and
diagnostics, keyed by the commit and the engine binary that read it. It shows
the Catalogue at once on the next launch while the engine loads again (the
engine cannot be handed a projection, so an open still waits for it). It holds
nothing that is not in the copy's own files, and no secret; deleting it only
means the next load is not shown early.

### Opening a product fast

The engine answers one request at a time, and an open needs its catalogue, so
an open waits for the catalogue load: the engine parses every gear crate of the
corpus (44 gears, ~4,200 files; 7–8 s of one core). On Windows the first load
after a launch was much slower — 64–82 s — because the engine opens the files
one after another and Microsoft Defender scans each on its first open
([MikeFalcon77/gearbox#5](https://github.com/MikeFalcon77/gearbox/issues/5)).
Three things now keep that out of the way:

- **Read ahead** (Windows only): while the engine loads, the IDE backend reads
  the same files from up to 32 worker threads, so Defender scans them in
  parallel and the engine finds them scanned. A cold open is 10–20 s.
- **Keep the engine**: an open (and closing a product) whose sources are exactly
  the corpus copies the running engine already read keeps that engine and its
  catalogue instead of respawning it and reading them again. The boot load
  becomes the open's load: opened after it finished, a product is ready in
  well under a second; opened during it, the checklist counts the rest of that
  load ("12 of 44 gears") on its first step. `Reload Catalogue` and a new gear
  still read the disk again.
- **The cached catalogue** above, for the tree.

When the first read took longer than 5 s, the first product opened afterwards
says so once, with the folder an antivirus exclusion would cover
(`~/ConstructorStudio/corpus`). Studio changes no system setting.

## What a Studio deployment needs

**1. The `studio-desktop` Keycloak client.** The client is in both realm files
(`keycloak/realm-studio.json` for deployments,
`docker/keycloak/realm-studio.json` for Docker Compose). **A realm file is
imported only when the realm is created**, so an existing realm — any stand
that already runs — needs it added once:

- Keycloak admin console → realm **studio** → **Clients** → **Import client** →
  paste the `studio-desktop` entry from `keycloak/realm-studio.json` → **Save**.
- It is a public client with PKCE (S256) and one redirect,
  `http://127.0.0.1/*`. Keycloak ignores the port of a loopback redirect, so
  the app may listen on any free one.

Check a stand with:

```bash
curl -s "https://<studio>/auth/realms/studio/protocol/openid-connect/auth?client_id=studio-desktop&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback&scope=openid&code_challenge=x&code_challenge_method=S256" \
  | grep -o "kc-form-login\|Client not found"
```

`kc-form-login` means the client is there.

**2. `studio-desktop` as a first-party client** of the backend's
`oidc-authn-plugin` (`first_party_clients` in `studio-backend/config/*.yaml`),
so its tokens carry the portal's scopes. Already set in every profile.

**3. The `studio-git` gear** for opening a workspace. Without it, signing in and
listing workspaces work, and opening one says the Studio "cannot clone for a
desktop yet".

## Which Studios a build offers

A packaged build carries a list of Studios and starts on one of them. The list
is `theia/electron-app/environments.json`:

```json
[
  { "id": "dev",   "label": "Dev",   "studioUrl": "https://studio-dev.cfabric.org",  "issuer": "https://studio-dev.cfabric.org/auth/realms/studio" },
  { "id": "test",  "label": "Test",  "studioUrl": "https://studio-test.cfabric.org", "issuer": "https://studio-test.cfabric.org/auth/realms/studio" },
  { "id": "local", "label": "Local", "studioUrl": "http://127.0.0.1:8090",          "issuer": "http://127.0.0.1:8088/realms/studio" }
]
```

- `studioUrl` is the Studio's public address; the gateway is under `/cf`.
- `issuer` is the realm whose endpoints the app signs in against. It may be
  left out: the default is `<studioUrl>/auth/realms/studio`, which is where the
  Helm chart puts Keycloak.
- **Local** reaches the Compose Keycloak over plain HTTP on 8088. Its tokens
  still carry `iss=https://localhost:8443/realms/studio`, which is what the
  local backend trusts, so the app needs no trust in the dev certificate.

The member switches in the Studio view; **Other…** takes any address. Switching
signs out of the current Studio. The choice is kept in
`~/ConstructorStudio/settings.json` and wins over the build's default.

### Settings the app reads

A packaged app's entry point (`theia/electron-app/desktop-main.js`) sets these
from the build; a value already in the environment wins, which is how one
installed build is pointed somewhere else for a test.

| Variable | Meaning |
|---|---|
| `STUDIO_DESKTOP_ENVIRONMENTS` | the offered Studios, as the JSON above |
| `STUDIO_DESKTOP_DEFAULT` | the `id` to start on |
| `STUDIO_DESKTOP_URL` | **pins** one Studio and hides the choice; for a developer's `theia start` |
| `STUDIO_DESKTOP_ISSUER` | the pinned Studio's realm; default `<url>/realms/studio` |
| `STUDIO_DESKTOP_SETTINGS` | where the choice is kept; default `~/ConstructorStudio/settings.json` |
| `STUDIO_DESKTOP_WORKSPACES` | where opened workspaces are cloned; default `~/ConstructorStudio/workspaces` |
| `STUDIO_DESKTOP_BROWSER` | a command to open the sign-in page with, instead of the system browser |
| `STUDIO_DESKTOP_AUTO_SIGN_IN` | `1` starts the sign-in at launch |
| `GEARBOX_ENGINE` | the `gearbox` executable behind the gear catalogue; default the one the build ships (`resources/bin/`), else the one the manifest has the app fetch (the gearbox engine extension), else `gearbox` on `PATH` |
| `STUDIO_DESKTOP_ASSISTANTS` | the manifest of the extensions the app brings (the assistants by open-vsx id, the CLI and the engine pinned); default the build's `resources/assistants.json`. Unset (a checkout's `theia start`), nothing is fetched |
| `STUDIO_DESKTOP_PLUGINS` | where the pinned extensions (the CLI, the engine) are unpacked, and the open-vsx marker kept; default `~/ConstructorStudio/plugins` |
| `STUDIO_CFS_RUNTIME` | the CLI extension's runtime folder, set before the first fetch; its `bin` goes first on the terminals' `PATH` |
| `STUDIO_CORPUS_CACHE` | where the per-machine gear corpus copies are kept; default `~/ConstructorStudio/corpus` |
| `STUDIO_DESKTOP_VSIX_DIRS` | more folders to look in for a VSIX put there by hand (`;` on Windows, `:` elsewhere); default the app's own folder |
| `ORCA_CLI` | the `orca` executable the Agents panel runs, when Orca is installed somewhere [Agent development](#agent-development-orca) does not look |

With none of the first three set, the IDE is an ordinary editor and the Studio
view does not open.

## Run it from a checkout

For working on the desktop code itself, against the local Compose stack:

```bash
cd theia
npm ci
npm --prefix drawio-editor run build
cd electron-app
npx theia download:plugins
npx theia rebuild:electron --cacheRoot ..
npx theia build --mode development
STUDIO_DESKTOP_URL=http://127.0.0.1:8090 \
STUDIO_DESKTOP_ISSUER=http://127.0.0.1:8088/realms/studio \
STUDIO_ACTOR_ID=desktop STUDIO_WORKSPACE_ID=desktop \
STUDIO_WORKSPACE_ROOT=$HOME/ConstructorStudio/workspace \
STUDIO_REPOSITORY_ROOT=$HOME/ConstructorStudio/workspace \
STUDIO_DATA_DIR=$HOME/ConstructorStudio/data \
npx theia start --plugins=local-dir:../plugins
```

The `STUDIO_ACTOR_ID` … `STUDIO_DATA_DIR` values are what the studio extension's
runtime config requires; a packaged app sets them itself.

`theia rebuild:electron` compiles the native modules (`node-pty`, `keytar`,
`drivelist`, `native-keymap`) for Electron, which on Windows needs the C++
build tools of Visual Studio.

## Debugging

Run it the way **Run it from a checkout** does, with Chromium's debugging port
open and development bundles, so stack traces point at the TypeScript:

```bash
npx theia build --mode development
STUDIO_DESKTOP_URL=... npx theia start --plugins=local-dir:../plugins --remote-debugging-port=9224
```

- **Frontend.** *Help → Toggle Developer Tools* in the app, or attach from
  Chrome: `chrome://inspect` → *Configure* → `localhost:9224`. A script can
  drive the same page over CDP: `GET http://127.0.0.1:9224/json/list`, take the
  `page` target, `Runtime.evaluate`.
- **Backend.** The Node backend logs to the terminal `theia start` runs in;
  every line of the desktop's own is prefixed `[studio-desktop]` (sign-in
  address, who signed in, each clone). Add `--log-level=debug` for Theia's own.
  To step through it, `--inspect=9229` on `theia start` and attach VS Code or
  `chrome://inspect`.
- **What the Studio view sees.** From the DevTools console, the same calls the
  view makes — the token is attached by the backend, never visible here:

  ```js
  await (await fetch('/studio-desktop/status')).json()               // state, user, current Studio
  await (await fetch('/studio-api/account-management/v1/me')).json() // subject_tenant_id
  await (await fetch('/studio-api/studio-user/v1/me/memberships')).json() // the organizations offered
  ```

  An empty `memberships` list is the "not a member of an organization yet"
  message, not a desktop bug: accept an invitation in the portal.
- **Sign-in.** `STUDIO_DESKTOP_BROWSER=<command>` opens the sign-in page with
  another browser (a clean profile, say); `STUDIO_DESKTOP_AUTO_SIGN_IN=1` starts
  it at launch. A local Keycloak on `https://localhost:8443` needs
  `NODE_EXTRA_CA_CERTS=docker/keycloak/certs/dev-ca.pem`.
- **Another Studio, same install.** Environment variables win over the build's
  preset, so an installed app can be started from a terminal against a local
  stack without rebuilding it.

## Build an installer

After `theia build` in `theia/electron-app`:

```bash
npm --prefix theia/electron-app run package -- --default dev --version 0.1.0
```

- The output is `theia/electron-app/dist/`, for the platform it runs on (the
  native modules are the ones `theia rebuild:electron` built there). On
  Windows: an NSIS installer (`Constructor-Studio-<version>-win-x64.exe`, a
  per-user install, no administrator rights) and a zip of the same app. On a
  Mac: `Constructor-Studio-<version>-mac-arm64.dmg` and a zip of the same app,
  which is what an update downloads. The script also names AppImage targets
  for Linux; Linux has not been built.
- On macOS the app is signed with a Developer ID when electron-builder finds
  one (`CSC_LINK`, `CSC_KEY_PASSWORD`; notarized when `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` are set too). Without one it is
  signed ad hoc -- Apple Silicon runs nothing unsigned -- and
  `studio-desktop.json` says `"updates": "manual"` (*Updates* below).
- `--environments <file>` ships another list; `--studio-url <address>
  [--issuer <realm>]` ships exactly one Studio.
- `--gearbox <path>` ships that `gearbox` executable as `resources/bin/gearbox.exe`,
  the engine behind the gear catalogue, products and `.gdl`. The workflow does
  not pass it any more: the app fetches the engine instead (*The gearbox
  engine* below). A developer's `theia start` needs `gearbox` on `PATH` or
  `GEARBOX_ENGINE`.
- The app is staged without `node_modules`: the Theia bundle in `lib/` is
  self-contained (its only external is `electron`), so the installer carries
  the bundle, `desktop-main.js`, the git credential helper, the built-in
  plugins and the CFS map schema. No asar — the bundle spawns executables
  (`rg`, the `node-pty` agents, the helper) by paths relative to itself.

### In CI

`.github/workflows/desktop.yml` builds and packages on two runners, where the
native modules compile: `windows-2022` for the Windows installer and zip,
`macos-15` (Apple Silicon) for the dmg and zip. Each uploads its files as an
artifact of the run (`constructor-studio-windows-<version>`,
`constructor-studio-macos-<version>`); a `desktop-v*` tag publishes both into
one release. Intel Macs are not built: that would be a second Mac build and a
`darwin-x64` CLI and engine. The workflow no longer builds the `gearbox`
engine; `gearbox-engine.yml` does, once per revision and platform (*The gearbox
engine* below). It runs
for PRs changing `theia/electron-app/**` or the workflow, for matching pushes to
`main`, for `desktop-v*` release tags, and on demand (**Actions → Desktop build → Run workflow**).
New commits cancel older PR/main builds; release tags and manual builds are not
cancelled. Feature-branch pushes in forks do not trigger another installer build.
Manual inputs are:

| Input | Default | Meaning |
|---|---|---|
| `default_environment` | `dev` | the Studio the build starts on |
| `studio_url`, `issuer` | empty | instead, ship exactly one Studio |
| `version` | `0.1.0` | the version the installer carries |
| `platforms` | `both` | `windows` or `macos` builds one installer only |

### Installing on a Mac

The dmg holds the app; drag it into **Applications**. Until the build is
signed with a Developer ID, macOS refuses its first start ("Apple could not
verify…"). Allow it once: **System Settings → Privacy & Security → Open
Anyway** (macOS 15), or right-click the app → **Open** (macOS 14 and older), or
in a terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Constructor Studio.app"
```

Started from the Finder or the Dock, a Mac app gets launchd's `PATH`, without
Homebrew or what `~/.zprofile` adds. `desktop-main.js` asks the member's login
shell for its `PATH` once at start (`$SHELL -ilc`, five seconds at most; the
shell sees `STUDIO_RESOLVING_SHELL_ENV=1`), so terminals, git and the
extensions find the same tools a terminal does. Started from a terminal, the
app keeps that terminal's `PATH`.

A `cfstudio://` link reaches a Mac app as an `open-url` event rather than an
argument. One that starts the app can come before Theia listens for it, so
`desktop-main.js` keeps it where Theia's start reads a Windows link.

### The Extensions view

A desktop has Theia's Extensions view (`@theia/vsx-registry`, in
`electron-app` only; a browser session does not get it). It is open to all of
open-vsx, as VS Code's is: the member searches, installs, updates and removes
extensions there. Its tab is on the rail in every mode (`RAIL`,
`studio-mode-layout.ts`; see
[The rail, the same in every mode](#the-rail-the-same-in-every-mode)). Extensions the app ships or brings
itself show under **Built-in**, without Uninstall or Update; those the member,
or the first start below, installed show under **Installed**.

### The rail, the same in every mode

The left rail is one toolset, as VS Code's activity bar is: switching modes
never adds, removes or reorders a rail item. What a mode changes is its ribbon
and its start page. One list, `RAIL` in
`theia/studio/src/browser/studio-mode-layout.ts`, says what it holds, in the
desktop and in a session alike. Top to bottom:

| Rail item | Drawn by |
|---|---|
| Explorer, Search, Source Control, Run and Debug, Extensions (desktop only), Testing | Theia's view containers, at Theia's own ranks (`RAIL`) |
| Collaboration (who is here, open threads, proposals) | product-ext, `mountCollabRail` |
| Quality, only in a project whose `.studio/settings.json` turns `qualitySignals` on | product-ext, `mountQualityRail` |
| Assistants: one entry that offers Claude Code and Codex | product-ext, `RAIL_ASSISTANTS` in `slot-strip.js` |
| The Studio view (account and connection), at the foot, where VS Code keeps Accounts | `STUDIO_VIEW`; the foot is `railTabsCss` in `studio-chrome-mode.ts` |

The Search on the rail, and Ctrl+Shift+F in every mode, is Theia's search across
the files. The product's own Search, which also reads comments, proposed
changes and history, is the ribbon's **Find → Search** in Doc editing and Full
functionality, and **Studio: Search…** in the palette.

A mode's own views sit beside the rail, not on it:

| Mode | Its own views | Reached from |
|---|---|---|
| Development, Full functionality, Agent development | Agents (Orca), on the right | the ribbon's **Agents** (Doc editing has it too) |
| Building | the Gearbox Catalogue, on the left with no rail tab (`OFF_RAIL`); the Inspector on the right | the ribbon's **Corpus → Catalogue**, **View → Catalogue** |
| Doc editing | Analyze, in the bottom panel | the ribbon's **Specs → Analyze** |

Claude Code and Codex are reached the same way in every mode: the rail's
Assistants entry, Ctrl+Alt+K and Ctrl+Alt+X (⌥⌘K, ⌥⌘X), and **Studio: Assistants**
in the palette. Agent development shows the agents beside what they changed:
Source Control on the left, Agents on the right.

On startup and after every mode switch, `StudioModeLayout` places each rail
view and each of the mode's own side views that is missing, without opening it,
and sets aside (detaches, it does not close) side views that another mode names
and this one does not, so a view opened once in one mode no longer stays in
another for good. The rail is every mode's, so it is never set aside. Views no
mode names -- the assistants, AI chat, Object Details, a plugin's own view --
stay where the member put them. The rail tabs (`RAIL_TABS`) are read from the
same list. A view opened from the View menu stays for as long as the member
works in the mode. The Studio view is put back in any mode whose layout was
saved before the view existed.

The right panel has no tab bar in the product. Whatever opens there gets a
readable width: a panel narrower than 300px when a new view comes to the
front is widened to the assistants' 360px (`settleRightPanelWidth`,
`theia/product-ext/src/browser/ai-context.js`).

### The Explorer and the status bar per mode

Both are shared with the portal session, which has the same modes.

- **Explorer.** Doc editing lists documents (Project settings → Files shown)
  titled by their first heading; every other mode lists every file under its
  name (`defaultExplorerMode`, `explorer-presentation-service.ts`). The
  Explorer's toggle is kept per mode, in the IDE's local storage under
  `studio.explorer.mode.<perspective id>`; the old single
  `studio.explorer.mode` is read only by a build with no modes. Files shown
  is applied by that Explorer's filter alone (`StudioExplorerFilter`);
  product-ext's `patchNavigatorFilter` steps aside for it, so "every file"
  includes sources.
- **Status bar.** The product hides every entry of Theia's it does not own.
  In the code modes a named list comes back — source control (`scm.*`),
  Problems, notifications, progress, connection status, the bottom-panel
  toggle and the cursor position (`CODE_MODE_STATUS_ENTRIES`,
  `product-ext/src/browser/status-line-modes.js`), keyed by
  `body[data-studio-perspective]`. A new entry is shown only once it is named
  there.

### The gearbox engine

The `gearbox` executable behind the gear catalogue, products and `.gdl` is not
in the installer either. It is the extension `constructorfabric.gearbox-engine`
(`theia/gearbox-engine`): the executable at `extension/bin/gearbox.exe`, built
from source at the repository, revision and Rust that `theia/Dockerfile`'s
`gearbox` stage pins for the session image -- one pin for both.

- `.github/workflows/gearbox-engine.yml` builds it on `windows-2022`
  (`win32-x64`) and `macos-15` (`darwin-arm64`), and publishes each version
  once, into a release `gearbox-engine-v<version>` holding a VSIX per
  platform; a platform added later goes into the release that exists. The
  version is `theia/gearbox-engine/package.json`'s (raised when the packaging
  changes) and the revision: `0.1.0-55f7015` since #514. A new revision in the Dockerfile
  is a new release. Nothing is built for a platform the release already holds.
- The VSIX records `gearbox` as executable, and the app keeps that mode when
  it unpacks it (`unpackVsix`), as it does for the CLI's Python and `cfs`;
  without it nothing in them runs on a Mac.
- `assistants-manifest.mjs --gearbox-engine` pins that asset's SHA-256 into the
  installer's manifest, and the app fetches it like the CLI (a pinned entry,
  unpacked into `~/ConstructorStudio/plugins/<id>-<version>/`, listed as
  built-in in the Extensions view).
- `desktop-main.js` points `GEARBOX_ENGINE` at the executable in that folder
  even before the first fetch; gearbox-studio reads the path each time it starts
  an engine. When the engine arrives, the window reloads the gear catalogue
  (`gearbox.catalogue.reload`), which until then said no engine is installed.
- A build that passes `--gearbox` still carries its own, and that one wins.

The installer shrinks by the engine's size, and the desktop workflow no longer
compiles Rust.

### Studio kits in the Extensions view

Kits are listed in the same view, as one more kind of entry beside the
extensions (`theia/studio-kits-view`, an `ExtensionsSourceContribution` of
`@theia/vsx-registry`; the package is a dependency of `electron-app` only).
For the project open in the window:

- **Installed**: the kits the project asked for, with their version and state
  (installed, failed with its reason, or requested but not in this checkout).
- **Recommended**: the rest of the catalogue (`GET /studio-kits/v1/catalog`).
- **Search** finds kits with the extensions; `@kit` shows kits only.

A kit belongs to the project, not to the app. **Install** calls the desktop
backend (`POST /studio-desktop/kits/install`, `studio/src/node/desktop-kits.ts`),
which does, for the folder open in the window:

1. records the request, as the portal does (`POST …/installations`);
2. installs the kit into that checkout with the CLI (`cfs init`, `cfs kit
   install`, `cfs generate-agents`, through `KitInstallerImpl.installInto`);
3. reports the outcome (`POST …/installations/{kit}/materializations`), which
   updates the installation and the repository's row exactly as a session's
   `materialize` would. The backend cannot call a desktop (ADR-0027), so this is
   the desktop telling it. The repository id is the one a session's registry
   gives the same checkout, so both update one row.

**Remove** stops the project wanting the kit (`DELETE …/installations/{kit}`);
the files already in the checkout stay, to be removed and committed by hand.
New kit files are uncommitted after an install; the message says to commit
them. A folder not opened from the Constructor Studio view has no project:
its kits show, but Install is disabled.

### The assistant extensions

Claude Code and Codex ship as the VS Code extensions product-ext drives. The
installer does not carry them
([#480](https://github.com/constructorfabric/studio-web/issues/480)), and
their versions are not pinned: on its first start the app installs the newest
version open-vsx has, and from then on they are the member's, updated or
removed in the Extensions view like any other.

**The manifest.** The workflow's *Assistant extensions manifest* step runs
`theia/electron-app/scripts/assistants-manifest.mjs`. Which extensions: the
`fetch_vsix` lines of `theia/Dockerfile`, the ones the session image carries.
Each becomes `{ id, label, source: 'open-vsx' }` (the label is open-vsx's
name). `package.mjs --assistants <file>` ships it as `resources/assistants.json`.

**On the member's machine**
(`theia/studio/src/node/desktop-assistants.ts`, `desktop-open-vsx.ts`). The
backend contribution mounts `/studio-desktop/assistants` only on a desktop
connected to a Studio whose build carries a manifest. A browser session has no
such route. Once the window is up, it asks the backend to install what is
missing, one at a time: `PluginServer.install('vscode-extension://<id>',
PluginType.User)`, which is what the view's **Install** does. It resolves the
newest version, downloads it from open-vsx, and deploys it into the running
app; the rail's assistant then opens without a restart.

- Each id installed once is remembered in
  `~/ConstructorStudio/plugins/.open-vsx-installed.json`. One the member later
  removed is not installed again, and drops out of the progress list.
- One the member already has, at any version, is left alone.
- An older build unpacked pinned copies into `~/ConstructorStudio/plugins/<id>-<version>/`
  as system plugins. They are removed once the member's own copy is in: with
  two copies of one id, Theia runs one of them without saying which (the view's
  2.1.284 ran, the pinned 2.1.227 did not).

**What the member sees.** A progress notification while an assistant installs
("Installing Claude Code…") and a note when it is ready. Until then the rail
answers "Claude Code is being installed. It opens here in a moment." instead of
"… is not available here" (the command `studio.desktop.assistantMessage`,
which a session answers with nothing). A failure says what happened and offers
**Try again**, and names the Extensions view as the other way.

**Uninstalling on Windows** (`studio/src/node/desktop-plugin-uninstall.ts`).
Theia deletes an extension's folder and only then marks it uninstalled. On
Windows a folder cannot go while something runs from it: Claude Code starts its
`claude.exe` from its folder and loads a native module
(`resources/audio-capture`) into the plugin host, so the delete never finished,
the view stayed at *Uninstalling*, and the extension was back on the next
start. The desktop binds an extension of Theia's handler in its place
(`rebind(PluginDeployerHandlerImpl)`, no patch):

1. it stops the processes whose executable lives under the folder;
2. it removes the folder within 15 s;
3. what still cannot go (a module loaded into the running plugin host) is left
   out of Theia's delete and recorded in `<data>/pending-plugin-removals.json`;
   Theia then marks the extension uninstalled and the view offers **Reload
   Window**;
4. `desktop-main.js` removes the recorded folders on the next start, before any
   plugin loads.

Anywhere but a Windows desktop the handler is Theia's, unchanged.

**Behind a proxy.** The downloads are the IDE backend's, which does not read
the system proxy. For the pinned entries (the CLI, the engine) a VSIX with the
manifest's digest can be put by hand into `~/ConstructorStudio/plugins` or
beside `Constructor Studio.exe`, and is taken instead of the download.

### The Constructor Studio CLI

`cfs` arrives through the same manifest, as its one pinned entry: the extension
`constructorfabric.studio-cli` (`theia/studio-cli`). The session image has
`cfs` in `/opt/cfs`; a member's machine may have no Python at all, or one with
its own `cfs` at another version. So the extension brings everything:

- `runtime/python`: a relocatable CPython (python-build-standalone), with
  `constructor-studio` at `theia/cfs.json`'s `ref` in its site-packages;
- `runtime/home/.cf-studio/cache`: the skill engine at `cfs.json`'s `engine`;
- `runtime/bin/cfs.cmd` (`cfs` elsewhere): the command for a shell.

Its entry is `{ id, label, version, target, url, sha256 }`, and the app treats
it as #480 treated every assistant (`desktop-assistants-store.ts`): it
downloads the VSIX from `url` (or takes one with that digest put in
`~/ConstructorStudio/plugins` or beside `Constructor Studio.exe` by hand),
checks the SHA-256, unpacks it into `~/ConstructorStudio/plugins/<id>-<version>/`,
deploys it into the running app as a system plugin (so the view lists it as
built-in), and deletes other versions once the new one is in. On later starts
`desktop-main.js` loads that folder like a built-in plugin. Once the CLI is on
open-vsx it can become an `open-vsx` entry like the assistants.

**The same versions as the session.** `theia/cfs.json` is the one pin:
`theia/Dockerfile` installs those versions into the image, and
`theia/studio-cli/build_vsix.py` into the extension. The extension's version
follows the pins (`<engine>-<ref>.<build>`, e.g. `1.6.2-ca55c66.2`), so a new
pin is a new version; `extension.build` is raised for a change to the extension
alone. `.github/workflows/studio-cli.yml` publishes each version once, into a
release `studio-cli-v<version>`, and `assistants-manifest.mjs --studio-cli`
pins that asset's SHA-256 into the installer's manifest. A desktop build whose
release does not exist yet warns and ships without the CLI. The two workflows
start together on a push that changes `cfs.json`, so that push's desktop build
can miss the new release; a `desktop-v*` tag, cut afterwards, has it.

**Its own home.** Both `cfs` and the engine's `init` look for the engine in
`~/.cf-studio/cache`, whatever `CFS_CACHE_DIR` says. On a machine where the
member runs their own `cfs`, that cache holds their engine, and the pin would
be lost. So every `cfs` the desktop runs gets `HOME` and `USERPROFILE` set to
`runtime/home`, which also leaves the member's `~/.cf-studio` untouched. It also
runs with `PYTHONUTF8=1`, because Python writes a pipe or a console in the
Windows code page and stops at the first character of `cfs`'s output that the
code page lacks, and with `CFS_NO_VERSION_CHECK=1`, because the engine is
pinned. The kit installer passes that engine to `cfs init --version`: without
it, `init` first updates the cache to the latest engine on GitHub.

**Who runs it.** `desktop-main.js` names the pinned version's folder in
`STUDIO_CFS_RUNTIME`, even before the first fetch. The studio extension
(`theia/studio/src/node/cfs-command.ts`) runs `python -m studio_proxy` from
there once it exists, for the traceability map and the kit installer, and
falls back to `cfs` on `PATH` until then. `desktop-main.js` also puts
`runtime/bin` first on the `PATH` the terminals start with, where the member
and the coding agents type `cfs`. An extension's
`environmentVariableCollection` would be the usual way, but it does not reach
the terminals of an extension deployed while the app runs, which is how this
one arrives. The extension adds *Constructor Studio CLI: Show Version*.

**Size.** 22 MB to download, about 65 MB unpacked (43 MB Python, 22 MB
engine).

## Updates

An installed app updates itself from the rolling `desktop-updates` release,
which every `desktop-v*` release refreshes
(`theia/electron-app/desktop-updater.js`). It checks on start and every six
hours, downloads what it finds, and asks once it has: restart now, later (it
installs on quit), or read what changed. Nothing is forced.

A Mac app without a Developer ID is the exception: macOS installs an update
only when its signature matches the running app's, and an ad-hoc signature
matches nothing else. Such a build (`"updates": "manual"` in
`studio-desktop.json`) checks the same feed (`latest-mac.yml`, `beta-mac.yml`)
but downloads nothing: it says a new version is out and offers its release
page, once per version, and Check for Updates says the same.

**Help → Check for Updates…** checks now and says what it found — the latest
already, an update downloading, one downloaded (and asks again), or why the
check failed. A checkout's `theia start` and an unpacked zip are not updated in
place, and say so.

Stable or beta is a preference: **Settings → Extensions → Studio → Desktop:
Update Channel** (`studio.desktop.updateChannel`, user scope only; searching
Settings for "update channel" or "beta" finds it):

| Value | Follows |
|---|---|
| `auto` (default) | the installed version: betas for a pre-release (`0.3.0-beta.2`), releases for a release |
| `stable` | releases only |
| `beta` | pre-releases too |

Its description links to *Check for Updates*. The preference lives in Theia's
user settings and nowhere else: the frontend reports it to the updater in the
main process at start and on every change
(`theia/studio/src/electron-browser/desktop-update-channel.ts` →
`DesktopUpdates.setChannel` → `desktop-update-channel.js`), so a change takes
effect on the next check without a restart. The first check on start waits for
that report (up to a minute, then `auto`). A move from beta back to stable
keeps the installed beta until a release passes it.

Up to this change the Studio view kept the choice as `updates` in
`~/ConstructorStudio/settings.json`. On the first start after it, the frontend
copies that value into the preference — unless the member has already set the
preference — and removes it from the file (`GET`/`DELETE
/studio-desktop/updates`, desktop only), so the choice is kept and there is one
place it lives.

The menu item and the preference exist only in the desktop app: they are a
`frontendElectron` module talking to an `electronMain` one over Theia's
Electron IPC (`theia/studio/src/electron-browser`, `src/electron-main`), and a
session's `browser-app` loads neither — a session's Settings has no Update
Channel.

## Git on the desktop: Sources, Sync and Push

A desktop project is a folder of clones, one per repository the project's
settings in Studio list (`workspace.settings` repos[], which studio-git serves
as `/sources?project_id=`). It has no canonical workspace config
(`.cf-studio/*.toml`) and no operations queue, which is what a session's
Sources, Sync and pushes are built on. So on the desktop
(`browser/desktop-git-contribution.ts`, `browser/desktop-sources-widget.tsx`,
`node/desktop-git.ts`, bound only by the electron frontend module, and acting
only when `studio-desktop/status` answers `enabled`):

- **Sources** lists the clones in the open folders as git sees them: branch,
  upstream, commits to push and to pull (as of the last fetch), files not
  committed, and the remote without credentials. There is no TOML to create or
  edit. A repository added to the project in the portal is cloned the next
  time the project is opened from the Constructor Studio view.
- **Sync** runs `git fetch --prune` in every clone and then only a
  fast-forward (`git merge --ff-only @{upstream}`). A branch with commits of
  its own that is also behind is left as it is and reported; merging or
  rebasing it is the member's call, in Source Control. One notification says
  what happened in each clone.
- **Push** (the ribbon, Development, Agent development and Full) pushes the
  current branch of the clone Source Control has selected, or the only one, or
  the one the member picks; a branch pushed for the first time gets its
  upstream on `origin`. When the host prints a pull-request link (GitHub,
  GitLab, Bitbucket, Gitea do), the notification offers **Open pull request**.

The routes are `GET /studio-desktop/git/repositories?root=`,
`POST /studio-desktop/git/sync` and `POST /studio-desktop/git/push`; like the
rest of `/studio-desktop/*` they exist only when a Studio is configured.
Credentials are git's: a clone's config names the token broker's helper, and
pushing to a Studio remote works only while signed in. A session keeps its
own Sources, Sync and Operations panel (View → Operations); it has no ribbon
Push.

## Building (Gearbox) on the desktop

Building mode is the Gearbox port (`theia/gearbox-studio`, whose README says
what is ported and how). What is particular to a member's machine:

- **The engine** is the extension above; until it arrives the catalogue says
  there is none, and it reloads by itself once it does.
- **The gears.** A project opened from the Studio view is often one repository
  with no gears of its own. The Catalogue then lists the backend's corpus
  (`GET /studio-product/v1/gearbox/catalogue`, falling back to the deprecated
  `/studio-components-catalog/v1/gearbox/catalogue` on 404; it answers only
  where the backend runs Gearbox, as dev does), and **Bring the gears here**
  clones it once per machine into the corpus cache described
  [above](#how-it-connects-and-what-it-never-holds). New Product offers that
  copy as a source, preselected when the workspace has no gears, and says
  that a product declared on it resolves only on this machine.
- **Products** are found under `<repository>/products/<name>/product.gdl`,
  where New Product suggests one, as well as in each checkout. **Add gear**
  with no product open opens New Product.
- **Editing.** Gear settings, features, plugin options and profile fields go
  into a draft; the strip at the head of the Product view writes it
  (**Apply changes**) or drops it (**Discard**), beside **Resolve** and
  **Close**. The **Gearbox** menu and the ribbon's Check group (Resolve,
  Conflicts, Lock, Generate) act on the open product.
- **Opening** a product waits for the engine to read the gears it declares,
  and says how far it has got ("12 of 44 gears"). A cold open on Windows took
  about 90 seconds in the measurements of #520; a warm one about 7. An open
  whose gears make no progress for 120 s stops with the reason and restores
  the product that was open before.
- **Build and Run** after Generate need cargo and, on Windows, the MSVC linker
  of the Visual Studio Build Tools; the panel checks both and links to what is
  missing. **Start a local Postgres** needs docker. What they write is listed
  [above](#how-it-connects-and-what-it-never-holds).

## Agent development (Orca)

The **Agents** panel and the **Agent development** mode drive
[Orca](https://github.com/stablyai/orca), the runtime that gives each agent
task its own git worktree and runs `claude`, `codex` or `opencode` in it. Studio
bundles none of Orca. It runs Orca's CLI with `--json` (`orca-cli.ts`,
`orca-service.ts`) and streams an agent's terminal over Orca's WebSocket with
the client Orca ships next to its CLI (`orca-terminal-bridge.ts`). In a session
the image carries Orca and the container starts it. On the desktop, Orca is the
member's own install.

### How Studio finds Orca

The backend looks for the `orca` executable in this order
(`findOrcaBinary`). The first one found wins. Only a found one is remembered,
so installing Orca while Studio runs needs a **Refresh**, not a restart.

| | Where |
|---|---|
| any OS | `ORCA_CLI`, when set. It is authoritative: pointing it at nothing reads as "not installed" |
| Windows | `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` (the default per-user install), then `%ProgramFiles%\Orca\resources\bin\orca.exe` |
| macOS | `/Applications/Orca.app/Contents/Resources/bin/orca`, `~/Applications/Orca.app/…`, then the shell command Orca's *Install CLI* links: `/usr/local/bin/orca`, `/opt/homebrew/bin/orca`, `~/.local/bin/orca` |
| Linux | `/opt/Orca/resources/bin/orca-ide` and `/usr/bin/orca-ide` (the .deb/.rpm), `/usr/local/bin/orca`, then `~/.local/bin/orca-ide` and `~/.local/bin/orca` (where an AppImage's *Install CLI* links it) |
| last | `orca`, then `orca-ide`, on `PATH` |

The explicit locations matter. An app started from the Start menu, the Dock or
a desktop launcher does not get a login shell's `PATH`, so `~/.local/bin` and
Homebrew's prefix are often not on it. On Windows only `.exe`/`.com` can be
spawned without a shell, so an `orca.cmd` found on `PATH` is followed to the
`orca.exe` beside it. Every name found on `PATH` is resolved to an absolute
path, because the terminal bridge loads Orca's client from next to it.

### How it connects, and what "ready" means

- **The panel** needs only the CLI. `orca status --json` finds the running Orca
  through the metadata file Orca writes into its own user-data folder
  (`%APPDATA%\orca`, `~/Library/Application Support/orca`,
  `$XDG_CONFIG_HOME/orca`, or `ORCA_USER_DATA_PATH`). It then asks over a named
  pipe or a unix socket. No TCP port is involved, so a firewall cannot get in
  the way. **Ready** means that call answered `runtime.reachable: true`.
- **An agent's terminal tab** needs the runtime's WebSocket
  (`ws://127.0.0.1:6768`) and a paired device: see the pairing paragraph under
  [How it connects](#how-it-connects-and-what-it-never-holds). Without a
  pairing the panel works, and only **Open** on an agent asks for one.
- **Studio can start Orca.** **Start Orca** runs `orca open`, which launches
  the app and waits for its runtime. Only off a session: there the container
  starts Orca.
- **Viewer credentials do not hide Orca.** `viewer-credentials-env.js` moves
  `HOME`/`CODEX_HOME` for the *plugin host* (and `HOME` only on Linux). The CLI
  runs in the IDE backend, which keeps the member's own home.

| | Session (`browser-app`) | Desktop (`electron-app`) |
|---|---|---|
| Orca | in the image (`STUDIO_ORCA_VERSION`), `ORCA_CLI=/usr/bin/orca-ide` | the member's install, found as above |
| Started by | the entrypoint, `orca serve --json` (headless) | the member, or **Start Orca** |
| Pairing | the entrypoint writes it (`STUDIO_ORCA_PAIRING_FILE`) | pasted once, kept in `~/ConstructorStudio/orca-pairing` |
| Repositories | the session's sources, registered on the first open | whatever the member added to Orca, grouped below |
| Which host | the backend says `host: session` (it has `STUDIO_SESSION_TOKEN`) | `host: local` |

### What the member sees

`orcaAvailability()` (`common/orca-availability.ts`) decides the words and the
buttons from the status. Every state has a way forward:

| State | Desktop says | Buttons | In a session |
|---|---|---|---|
| no executable found | "Orca is not installed on this computer, or not where Studio looks…", with the `ORCA_CLI` hint | **Get Orca** (the releases page), **Refresh** | "This session image was built without the Orca runtime…" |
| installed, not running (`not_running`, `stale_bootstrap`) | "Orca is installed but not running…" | **Start Orca**, **Refresh** | restart the session; the log is `orca-serve.log` |
| starting (`starting`, `graph_not_ready`) | "Orca is starting…" | **Refresh** | same |
| the CLI failed (timeout, refusal) | the reason, and "Open the Orca app, or start it here" | **Start Orca**, **Refresh** | the reason, and `orca serve` |
| ready | "ready · 1.4.211 · desktop" | **Refresh** | "ready · … · headless" |
| ready, not paired | a note that terminals open once paired | **Pair with Orca** | never: a session pairs itself |
| Orca older than 1.4.197 | a note to update Orca if something fails | — | same |

A terminal tab that cannot attach says why: no pairing, or a pairing Orca no
longer accepts (revoked, or Orca reinstalled with a new key). For both it
offers to pair again. If Orca is closed, it says to open Orca.

### Worktrees

A member's Orca knows every repository they ever added to it, and every
repository has a worktree on `main`. So the panel groups worktrees by
repository (`orca repo list`, `common/orca-worktree-groups.ts`). The open
project's repositories come first, and the rest are behind **Other
repositories in Orca (N)**. With no project open, the panel says so and lists
them all. When Orca does not know the open project's repositories, the panel
offers **Add this project's repositories to Orca**. Whether Studio adds them by
itself is the member's choice (see [Projects in the member's Orca](#projects-in-the-members-orca)).
A session registers them on the first open, since its runtime starts empty. A new task is created in the
selected worktree's repository (`--repo id:…`). Before this, Orca guessed it
from the backend's working directory, which on a desktop is no checkout. The
agents Studio did not find on its own `PATH` are "not in this image" only in a
session. On a desktop they are a hint, and every agent stays on offer: Orca
starts an agent with its own environment.

### Projects in the member's Orca

Orca's repository list is the member's own, shared with work that has nothing
to do with Studio. So Studio asks before it adds anything, and it takes out
only what it added itself (#497). The decisions are in
`common/desktop-orca-projects.ts`. The bookkeeping is in
`node/desktop-orca-projects.ts`. The window side is
`browser/desktop-orca-project-sync.ts`.

**Adding.** The first time a project is open whose repositories Orca does not
know, a notification asks: *Orca does not know the project open here yet. Add
its repository … to Orca, so agents can work on it?* It offers **Always add**,
**Not now** and **Never**.

- **Always add** adds them now and, from then on, adds every project opened
  here without asking.
- **Not now** adds nothing and does not ask again for that project until the
  window reloads. Closing the notification counts as **Not now**.
- **Never** stops the question.

The answer is the preference `studio.orca.addOpenedProjects` (`ask`, `always`
or `never`; user scope). It can be changed in Settings, or from the line at the
bottom of the Agents panel's worktrees ("Studio asks before adding… Change").
The **Add this project's repositories to Orca** button stays for **Not now**
and **Never**. Studio checks when the window starts, when the open folder
changes, and after **Start Orca**.

**Removing.** Each window tells the backend which project it has open: when it
starts, when the folder changes, and when it closes. Studio then unregisters
from Orca every repository it added that no open window's project holds. That
happens when the desktop opens another project, when the folder is closed, or
at the next start for a project that was open when the app quit.

- Only repositories Studio added are removed. Studio records each one it
  registered with `orca repo add` that Orca did not know before, in
  `~/ConstructorStudio/orca-projects.json`: the repository id, its path, the
  project folder and the time. A repository the member added to Orca
  themselves never gets an entry. An entry Orca has since forgotten, or now has
  under another id (the member removed it and added it again), is dropped
  without touching Orca.
- Removing means unregistering. The CLI has no `repo rm`. Studio runs
  `orca project setup-delete --setup <id>`, which for a repository is Orca's
  own "remove project": Orca forgets the repository, and every file, branch and
  worktree stays on disk.
- A repository stays in Orca while an agent or any terminal runs in one of its
  worktrees, while a worktree has uncommitted changes, or when they cannot be
  read. The panel says which, in the member's words ("Studio added web to Orca
  for a project that is closed now, and left it there: claude is still running
  in fix/x…"). Studio tries again at the next start, folder change or window
  close.
- A window that closes without saying so (a crash) leaves its project's
  repositories registered until the app starts again. That errs on the safe
  side.

In a portal session none of this runs. The backend answers `enabled: false`,
nothing is asked, and nothing is recorded.

`orca-projects.json` holds repository ids and paths on this machine, not a
secret. Deleting it only means Studio stops removing what it had added.

## Known limits

- The installer is not code-signed, so Windows SmartScreen asks before the
  first run. The macOS app is signed ad hoc: Gatekeeper asks to allow it once
  (*Installing on a Mac*), and it does not update itself.
- The macOS build is for Apple Silicon only, and has not been run on a Mac
  by its author: it was built and packaged in CI.
- The workspace a member opens is cloned, not synchronised: the Studio sees
  what they push, and nothing before it.
- The desktop's events do not reach the portal, and the portal cannot send a
  desktop a command (ADR-0027 phases 4–5). The portal does show where a
  project is open on a desktop (phase 3, #450).
- Up to 0.3.0-beta.3, opening Codex on the desktop showed "Codex couldn't load
  its resources." Its webview's resources did load. The Codex CLI behind it
  exited at start because its `CODEX_HOME` did not exist. Two things caused
  that. The credential home named the directory without creating it. On
  Windows, linking the anonymous home to the member's home also failed: a
  symlink needs a privilege, so the home was emptied and then removed. The
  first cause also hit browser sessions whose home had no `.codex` yet. The
  Codex output channel shows the CLI's error. Fixed by
  `ensureAssistantHomes` and a junction on Windows
  (`theia/product-ext/src/node/viewer-credentials-env.js`). An installed
  beta.3 has no workaround: every start draws a new anonymous home and removes
  it again. In a browser session, signing in to Codex from the product's
  assistant sign-in creates the directory, and reloading the page then works.
- Up to 0.3.0-beta.4, the pinned Codex was unpacked without its linux
  binaries, so it could not run in WSL. Since the assistants come whole from
  open-vsx (#513) that no longer applies to a new install; whether Codex then
  runs in WSL has not been checked.
- The desktop's Claude Code and Codex are the member's, at whatever version
  open-vsx had when they were installed or last updated, so they can differ
  from the session image's pins (ADR-0032).
- The first start downloads the assistants from open-vsx (about 440 MB at the
  September 2026 versions), the CLI (22 MB) and the engine (about 6 MB). Until
  then the rail's assistants say they are installing.
- Build and Run under Generate have been checked on a Windows machine without
  MSVC, where the panel says the linker is missing, and not end to end on one
  that has it (#514).
- The first open of a product after a start is slow on Windows, about a
  minute and a half cold, while the engine reads the corpus (#520).
- A kit has not been installed end to end from a signed-in desktop (#517).
- Pairing with Orca is a paste. Orca mints a pairing for this computer only
  from its own window, and has no CLI command for it.
- The macOS and Linux Orca locations come from Orca's installers and its
  *Install CLI* code (1.4.211). No Studio build has run on either OS yet.
