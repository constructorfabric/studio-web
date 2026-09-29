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

What a member does:

1. Starts **Constructor Studio**, picks the Studio in the **Constructor
   Studio** view (Dev, Test, Local, or an address), and clicks **Sign in with
   Constructor ID**.
2. Signs in on the realm's own page, in the system browser. The app waits on a
   loopback port and takes the answer.
3. Sees the projects they can reach — found the way the portal finds them:
   the organizations they are a **member** of (`studio-user`
   `/me/memberships`), and each one's `workspace` tenants, which the portal
   calls projects — and clicks one to open it: its sources are cloned through
   the Studio and the folder opens in the IDE. The organization is named only
   when there is more than one, as the portal hides it.

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
- Desktop-only logic lives in `desktop-*` files (`desktop-studio-widget.tsx`,
  `desktop-projects.ts`, `node/desktop-*.ts`). Shared widgets call Studio
  through `StudioApi.fetch('/<gear>/v1/...')` and must not care which host
  answers it.

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

Nothing is written to disk but the member's choice of Studio
(`~/ConstructorStudio/settings.json`) and the clones
(`~/ConstructorStudio/workspaces/<workspace>`). `settings.json` also keeps
`deviceId`, a random UUID drawn on the first lease, so that a restarted app renews
the leases it had. It names the installation and nothing else. It is not a
credential: every lease call is authorized by the member's token, and a copied
id only makes two machines look like one in the portal's list.

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

And the assistants: Claude Code and Codex are fetched on first start into
`~/ConstructorStudio/plugins/<id>-<version>/`
([The assistant extensions](#the-assistant-extensions)). That folder holds the
extensions' code as open-vsx publishes it, checked against the digest the build
recorded. It holds no secret; deleting it only means the app fetches them again.

And the gear corpus: "Bring the gears here" (in the Catalogue, or inline in
New Product) clones it once per machine and commit into
`~/ConstructorStudio/corpus/<host__owner__repo>/<commit12>/<source id>`
(`STUDIO_CORPUS_CACHE` moves it), and a product that names a git source at a
commit (`git(url, rev)`) is brought into the same place when it opens,
instead of into the project. A private corpus is cloned through the Studio
relay with the credential helper given for that one command, so the copy's
`.git/config` names no helper and no token. Each copy is a fixed commit and
never fetches again; deleting one only means it is cloned again.

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
| `GEARBOX_ENGINE` | the `gearbox` executable behind the gear catalogue; default the one the build ships (`resources/bin/`), else `gearbox` on `PATH` |
| `STUDIO_DESKTOP_ASSISTANTS` | the assistants' manifest; default the build's `resources/assistants.json`. Unset (a checkout's `theia start`), nothing is fetched |
| `STUDIO_DESKTOP_PLUGINS` | where the assistants are unpacked; default `~/ConstructorStudio/plugins` |
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

- The output is `theia/electron-app/dist/`: an NSIS installer
  (`Constructor-Studio-<version>-win-x64.exe`, a per-user install, no
  administrator rights) and a zip of the same app. The script also names dmg
  and AppImage targets for macOS and Linux; only Windows has been built so far.
- `--environments <file>` ships another list; `--studio-url <address>
  [--issuer <realm>]` ships exactly one Studio.
- `--gearbox <path>` ships that `gearbox` executable as `resources/bin/gearbox.exe`,
  the engine behind the gear catalogue, products and `.gdl`. Without it the
  build still packages, and its catalogue says no engine is installed; a
  developer's `theia start` needs `gearbox` on `PATH` or `GEARBOX_ENGINE`.
- The app is staged without `node_modules`: the Theia bundle in `lib/` is
  self-contained (its only external is `electron`), so the installer carries
  the bundle, `desktop-main.js`, the git credential helper, the built-in
  plugins and the CFS map schema. No asar — the bundle spawns executables
  (`rg.exe`, the `node-pty` agents, the helper) by paths relative to itself.

### In CI

`.github/workflows/desktop-windows.yml` builds and packages on `windows-2022`,
where the native modules compile, and uploads the installer and the zip as the
run's artifact. It builds the `gearbox` engine too, from source, at the
repository, revision and Rust that `theia/Dockerfile`'s `gearbox` stage pins for
the session image — one pin for both — and caches the build per revision. It runs
for PRs changing `theia/electron-app/**` or the workflow, for matching pushes to
`main`, for `desktop-v*` release tags, and on demand (**Actions → Desktop — Windows build → Run workflow**).
New commits cancel older PR/main builds; release tags and manual builds are not
cancelled. Feature-branch pushes in forks do not trigger another installer build.
Manual inputs are:

| Input | Default | Meaning |
|---|---|---|
| `default_environment` | `dev` | the Studio the build starts on |
| `studio_url`, `issuer` | empty | instead, ship exactly one Studio |
| `version` | `0.1.0` | the version the installer carries |

### The assistant extensions

Claude Code and Codex ship as the VS Code extensions product-ext drives. The
installer does not carry them
([#480](https://github.com/constructorfabric/studio-web/issues/480)). It
carries `resources/assistants.json`, the pinned win32 builds, and the app
fetches each one on first start.

**The pin.** The workflow's *Assistant extensions manifest* step runs
`theia/electron-app/scripts/assistants-manifest.mjs`. The script reads the
`fetch_vsix` pins from `theia/Dockerfile`, the same pins the session image
uses. For each pin it asks open-vsx for that version's `win32-x64` build. When
the pinned version has none, it takes the newest win32 build, and the run warns
about it. Codex 26.5803.61601 is pinned, but only 26.5730.61309 has a win32
build, so the desktop and the session can run different Codex versions. The
script downloads each VSIX once and checks it against open-vsx's
`files.sha256`. It then writes `{ id, label, version, target, url, sha256 }`
for each extension. `package.mjs --assistants <file>` ships the manifest. From
then on the app trusts the manifest's digest, not what open-vsx answers at run
time.

**On the member's machine**
(`theia/studio/src/node/desktop-assistants.ts`, `desktop-assistants-store.ts`).
The backend contribution mounts `/studio-desktop/assistants` only on a desktop
connected to a Studio whose build carries a manifest. A browser session has no
such route, and nothing in it runs there. Once the window is up, it asks the
backend to fetch whatever is missing, one extension at a time:

1. It uses a VSIX the member put in place by hand, under the name open-vsx
   gives it (`Anthropic.claude-code-2.1.227@win32-x64.vsix`), in
   `~/ConstructorStudio/plugins` or next to `Constructor Studio.exe`, but only
   when its digest is the pinned one. Otherwise it downloads the VSIX from the
   manifest's URL into a `.partial-*` file.
2. It checks the SHA-256 against the manifest. On a mismatch the file is
   deleted and nothing is installed.
3. It unpacks the VSIX, without Codex's `bin/linux-*` (used only for *run Codex
   in WSL*, off by default), into
   `~/ConstructorStudio/plugins/<id>-<version>/<id>/`. The unpack goes into a
   `.partial-*` folder first, which is then renamed into place in one step.
4. It deploys the extension into the running app with
   `PluginServer.install('local-dir:<folder>')` (`@theia/plugin-ext`). Theia
   deploys it and fires `onDidDeploy`, and each window's `HostedPluginSupport`
   loads and starts the new plugin. The rail's assistant then opens without a
   restart.
5. Once the new version has deployed, it deletes the other versions of the same
   extension. A new app version with a new manifest therefore fetches the new
   pin on start and then removes the old one.

On the next start, `desktop-main.js` adds the folder of each pinned version
that is already there to `THEIA_PLUGINS`, so it loads like a built-in plugin.
Only the pinned version's folder is added, so a leftover older version never
loads.

**What the member sees.** A progress notification while an assistant
downloads ("Downloading Codex 26.5730.61309… 37 %") and a note when it is ready.
Until then the rail answers "Codex is downloading (37 %). It opens here once it
is installed." instead of "… is not available here". The rail gets that
sentence from the command `studio.desktop.assistantMessage`, which a session
answers with nothing. A failure leaves nothing behind, and its message says
what happened and offers **Try again**:

- open-vsx cannot be reached: the message names the host and the cause, and
  says where to put the VSIX by hand (the offline path above);
- a digest mismatch: the download is discarded;
- the archive is not an extension, or the deploy fails.

**Sizes.** The member downloads 92 MB for Claude Code and 347 MB for Codex
(win32 VSIX, which still includes the linux binaries). Unpacked, without
those, Codex takes about 600 MB. The installer now carries neither.

**Behind a proxy.** The download is Node's `fetch` in the IDE backend, which
does not read the system proxy. Where open-vsx is reachable only through a
proxy, the VSIX can be put in place by hand. Mirroring the VSIXs as assets of
the `desktop-v*` release is the way out, should that become common: the
manifest's `url` would point there.

### The Constructor Studio CLI

`cfs` arrives the same way, as one more entry of that manifest: the extension
`constructorfabric.studio-cli` (`theia/studio-cli`). The session image has
`cfs` in `/opt/cfs`; a member's machine may have no Python at all, or one with
its own `cfs` at another version. So the extension brings everything:

- `runtime/python`: a relocatable CPython (python-build-standalone), with
  `constructor-studio` at `theia/cfs.json`'s `ref` in its site-packages;
- `runtime/home/.cf-studio/cache`: the skill engine at `cfs.json`'s `engine`;
- `runtime/bin/cfs.cmd` (`cfs` elsewhere): the command for a shell.

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
  first run.
- The workspace a member opens is cloned, not synchronised: the Studio sees
  what they push, and nothing before it.
- Desktop sessions are not yet visible in the portal, and the portal cannot yet
  send a desktop a command (ADR-0027 phases 3–5).
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
- Codex cannot run in WSL on the desktop: its linux binaries are not unpacked
  ([The assistant extensions](#the-assistant-extensions)).
- The desktop's Codex can be older than the session's. The Dockerfile pin has
  no win32 build, so the manifest pins the newest one that has.
- The first start downloads about 440 MB of assistants. Until then the rail's
  assistants say they are downloading.
- Pairing with Orca is a paste. Orca mints a pairing for this computer only
  from its own window, and has no CLI command for it.
- The macOS and Linux Orca locations come from Orca's installers and its
  *Install CLI* code (1.4.211). No Studio build has run on either OS yet.
