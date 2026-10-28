---
type: adr
status: accepted
date: 2026-09-29
---

# ADR-0032: The desktop gets its tools as extensions, from the Extensions view, and Theia is extended rather than patched

**ID**: `cpt-studio-adr-the-desktop-gets-its-tools-as-extensions`

Status: accepted · 2026-09-29 · Builds on ADR-0027 · Amends the pinned assistants of #480 · Built in #505, #513, #517, #519, #522

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Drivers](#decision-drivers)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The standard Extensions view, open to all of open-vsx](#1-the-standard-extensions-view-open-to-all-of-open-vsx)
  - [2. Nothing a member installs is pinned](#2-nothing-a-member-installs-is-pinned)
  - [3. Studio's own tools are extensions the app fetches](#3-studios-own-tools-are-extensions-the-app-fetches)
  - [4. Kits are entries of the same view](#4-kits-are-entries-of-the-same-view)
  - [5. Theia is extended, not patched](#5-theia-is-extended-not-patched)
  - [Consequences](#consequences)
  - [Confirmation](#confirmation)
- [Pros and Cons of the Options](#pros-and-cons-of-the-options)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

By 2026-09-28 the desktop Studio (ADR-0027) ran, but on a member's machine it
lacked most of the tools a session has:

- **No `cfs`.** The session image carries the Constructor Studio CLI in
  `/opt/cfs`. A laptop may have no Python, or its own `cfs` at another
  version. So the traceability map, the kit installer and the coding agents'
  Studio skills all failed, or ran whatever engine that machine's
  `~/.cf-studio/cache` held.
- **Claude Code and Codex were pinned.** #480 fetched them on first start from
  a manifest of pinned versions and digests, installed them as system plugins,
  and gave the member no way to see, update or remove them.
- **Kits lived only in the portal.** The portal's `materialize` reaches an IDE
  through a session's bridge. A desktop has none (ADR-0027 §4), so a desktop
  could not install a kit at all.
- **The installer carried the gearbox engine.** Every desktop build compiled
  Rust on the Windows runner.
- **Uninstalling hung.** Removing Claude Code on Windows stayed at
  *Uninstalling*, and the extension came back after a restart.

The member wanted the VS Code experience: one Extensions pane where tools and
kits are found, installed, updated and removed.

## Decision Drivers

* A member manages their tools in one place, the way VS Code does.
* A desktop runs the same `cfs` and the same gearbox engine as a session,
  whatever the machine has installed.
* The installer carries the app, not the tools, and a build does not recompile
  a tool that has not changed.
* A kit installed from the desktop shows in the portal exactly as one
  installed from a session.
* The browser session does not change (`docs/desktop-contributing.md`).
* Theia's code is extended through its extension points and DI, never edited.

## Considered Options

* A curated "Studio Library" view of our own, over the #480 store.
* The standard Extensions view behind an allow-list router, with the pins kept.
* **The standard Extensions view, open to all of open-vsx, with no pins.**
* The standard view against a private Open VSX that serves only pinned versions.

## Decision Outcome

Chosen option: "The standard Extensions view, open to all of open-vsx, with no
pins". It is what the member asked for, it needs no registry of our own, and a
spike showed that keeping pins and the view together cannot work (§2).

### 1. The standard Extensions view, open to all of open-vsx

`@theia/vsx-registry` is a dependency of `electron-app` only, so a browser
session never gets the view. There is no router allow-list: a member installs
anything from open-vsx, as in VS Code. Its tab is on the rail in every mode
(`RAIL`, since the rail became one toolset for all modes; it was the code modes'
only, `MODE_TABS`, when this was decided).

### 2. Nothing a member installs is pinned

Claude Code and Codex are named in the installer's manifest as
`{ id, label, source: 'open-vsx' }`. On the first start the app installs the
newest version as a *user* extension, exactly as the view's **Install** does
(`PluginServer.install('vscode-extension://<id>', PluginType.User)`,
`desktop-open-vsx.ts`). From then on the member updates or removes them in the
view.

- An id installed once is remembered, so one the member removed is not
  installed again.
- Copies that an older, pinning build unpacked are deleted once the member's own
  copy is in.

Pins and the view cannot coexist. In the spike, the view's Claude Code 2.1.284
silently ran instead of the store's pinned 2.1.227: with two copies of one id,
Theia runs one and says nothing.

### 3. Studio's own tools are extensions the app fetches

`cfs` and the gearbox engine are platform VSIXs: `constructorfabric.studio-cli`
(#505) and `constructorfabric.gearbox-engine` (#519). Their versions follow the
pins the session image already uses:

- **The CLI:** `theia/cfs.json`, which the Dockerfile also reads. The version is
  `<engine>-<ref>.<build>`.
- **The engine:** the Dockerfile's `STUDIO_GEARBOX_REF`. The version is
  `<packaging>-<ref>`. (Since 2026-10-27 the engine is a constructorfabric/gearbox
  release, `STUDIO_GEARBOX_RELEASE`, which `gearbox-engine.yml` repacks
  instead of building.)

`studio-cli.yml` and `gearbox-engine.yml` publish each version once, into its
own release, and never replace it. The installer's manifest pins that asset's
SHA-256, and the app fetches it on the first start. The view lists these two as
built-in.

- **The CLI runs with a home of its own** (`runtime/home`). Both `cfs` and the
  engine's `init` read `~/.cf-studio/cache` whatever `CFS_CACHE_DIR` says, so a
  shared home would lose the pin and change the member's own setup.
- **The CLI runs with `PYTHONUTF8=1`,** because a Windows code page stops Python
  at the first `⚠` in its output.
- **`desktop-main.js` names both tools' folders before the first fetch.** It
  puts `cfs` on the terminals' `PATH`. It also points `GEARBOX_ENGINE` at the
  engine's folder; the window reloads the gear catalogue when the engine
  arrives.

These two stay pinned deliberately, unlike §2. They are not the member's
choice: they are the same validators and the same engine as the session, and
the view does not update them.

### 4. Kits are entries of the same view

`theia/studio-kits-view` is a Theia extension that `electron-app` alone depends
on. It contributes kits to the view through Theia 1.75's
`ExtensionsSourceContribution`, the point the view's MCP servers use, and renders
them with the view's own `ExtensionCard`.

- **Where kits show:** under Installed (the open project's kits), under
  Recommended (the rest of the catalogue), and in a search, or with `@kit`
  alone.
- **Install** goes to the desktop backend (`/studio-desktop/kits/install`). For
  the folder open in the window, the backend:
  1. records the request, as the portal does;
  2. runs `cfs` through `KitInstallerImpl.installInto`;
  3. reports the outcome to `kit_registry`'s new
     `POST …/installations/{kit_slug}/materializations`.
- **The report updates the portal's row** through the same `record_outcome` a
  session's `materialize` uses. The checkout is named with the id a session's
  repository registry would give it, so both write one row.

### 5. Theia is extended, not patched

Every change to Theia's behaviour goes through a Theia mechanism:

- the Extensions view and kits come from an extension point (§1, §4);
- the store installs the way the view does (§2);
- uninstalling on Windows is a DI replacement (#522).

**The uninstall replacement.** `DesktopPluginDeployerHandler` extends
`PluginDeployerHandlerImpl` and is bound in its place
(`rebind(PluginDeployerHandlerImpl)`). On a Windows desktop, before Theia's own
uninstall runs, it:

1. stops the processes whose executable lives under the extension's folder
   (Claude Code's `claude.exe`);
2. removes the folder, giving up after 15 s;
3. leaves what is still held out of Theia's delete and records it. That is a
   native module loaded into the plugin host: Claude Code's `audio-capture`.

Theia then marks the extension uninstalled and offers **Reload Window**.
`desktop-main.js` removes the recorded folders on the next start, before any
plugin loads. Anywhere else the handler is Theia's, unchanged.

### Consequences

* Good, because a member sees, installs, updates and removes everything in one
  VS Code-like view, and the installer carries neither the assistants nor the
  engine. The zip went from 175 MB to 162 MB, and the desktop build no longer
  compiles Rust.
* Good, because a desktop runs the session's `cfs` and gearbox engine, whatever
  the machine has, and never touches the member's own `cfs` or its cache.
* Good, because a kit installed on a desktop and one installed in a session
  land on the same portal row.
* Bad, because Claude Code and Codex versions now drift: from the session image,
  and from one member to the next. That was accepted when the pin was dropped.
* Bad, because the first start needs open-vsx and GitHub releases. A machine
  that reaches neither has no assistants, no `cfs` and no engine until it does.
* Bad, because a push that changes `cfs.json` or the engine pin starts its
  desktop build together with the release workflow. That push's installer may
  miss the new release: it warns and ships without the tool. The next
  `desktop-v*` tag has it.
* Bad, because the CLI and the engine update only with a new app build, until
  they are published to open-vsx, where the view could update them.

### Confirmation

* Unit tests: `cfs-command`, `kit-installer`, `desktop-open-vsx`,
  `desktop-kits`, `studio-kits-client`, `desktop-assistants-contribution`,
  `desktop-plugin-uninstall`, `assistants-manifest`, and `kit_registry`'s
  `record_outcome`. `api_contract` holds the new route.
* Packaged Windows builds from fork CI, driven over CDP:
  - the view lists all of open-vsx;
  - Claude Code installs as a user extension and has Uninstall;
  - the CLI shows as built-in, and `where cfs` in a terminal finds it first;
  - the engine is fetched, and a `gearbox.exe rpc --stdio` runs from its folder;
  - uninstalling Claude Code reaches Reload Window in 18 s, and its folder is
    gone after the restart.
* **Not yet exercised end to end:** a signed-in desktop installing a kit and the
  portal showing the reported row. It needs a Studio running #517's backend.

## Pros and Cons of the Options

### A curated "Studio Library" view of our own

* Good, because kits and tools share one custom list, and pins stay.
* Bad, because it is a second extensions UI to build and keep. It would not be
  the view the member asked for, and it would still not reach the rest of
  open-vsx.

### The standard view behind an allow-list, pins kept

* Good, because the view's code is Theia's and only approved ids show.
* Bad, because the router filters by id, not by version: **Update** installs the
  newest version and breaks the pin.
* Bad, because the view's copy of an id silently shadows the store's pinned copy.

### The standard view, open to all of open-vsx, no pins (chosen)

* Good, because it is VS Code's model: one owner per extension, the member.
* Bad, because versions drift, and anything on open-vsx can be installed.

### A private Open VSX serving only pinned versions

* Good, because the standard view could not drift.
* Bad, because it is a registry to run and fill, for pins the member does not want.

## More Information

* What each part is, and how it works on a member's machine:
  [`docs/desktop-studio.md`](../desktop-studio.md). See *The Extensions view*,
  *The assistant extensions* and *The Constructor Studio CLI*. See also *The
  gearbox engine*, *Studio kits in the Extensions view* and *Uninstalling on
  Windows*.
* The same day, the everything mode was renamed from "FULL SUPER POWER" to "Full
  functionality" (#518). Its perspective id `studio.full` is unchanged.
* What is still open is listed in [`TASKS.md`](../../TASKS.md), under
  2026-09-29.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-kits` — kits are listed and installed from the desktop's Extensions view, and the result is recorded for the portal
* `cpt-studio-fr-ide-session` — a desktop session gets `cfs`, the gearbox engine and the assistants without the session image
* `cpt-studio-nfr-credential-isolation` — the tools are fetched from public releases and open-vsx; no token is added to the machine
* `cpt-studio-component-theia-studio` — desktop-only behaviour lives in `electron-app`'s own dependencies and in runtime checks, so the browser assembly is unchanged
