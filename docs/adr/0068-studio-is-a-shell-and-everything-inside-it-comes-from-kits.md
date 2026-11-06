---
type: adr
status: proposed
date: 2026-11-06
---

# ADR-0068: Studio is a shell, and everything inside it comes from kits

**ID**: `cpt-studio-adr-shell-and-kits`

Status: **proposed** · Date: 2026-11-06 · Builds on ADR-0067 (a kit brings model, events, workflows, functions and screens), ADR-0066 (domain objects and Studio's own model), ADR-0050 (FrontX micro-frontends), ADR-0008 (the navigation shell) · Extends the kits of `docs/design/studio-kits.md`

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. What the shell is](#1-what-the-shell-is)
  - [2. What a kit brings](#2-what-a-kit-brings)
  - [3. One manifest: `kit.gdl`](#3-one-manifest-kitgdl)
  - [4. The kit library](#4-the-kit-library)
  - [5. The installer works on a level](#5-the-installer-works-on-a-level)
  - [6. The Inbox takes items from kits](#6-the-inbox-takes-items-from-kits)
  - [7. Today's tabs become built-in kits](#7-todays-tabs-become-built-in-kits)
  - [8. Anatomy of a kit](#8-anatomy-of-a-kit)
  - [9. Kit code runs as WebAssembly inside Studio](#9-kit-code-runs-as-webassembly-inside-studio)
  - [10. A kit is published as an OCI artifact](#10-a-kit-is-published-as-an-oci-artifact)
- [Phases](#phases)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [Open questions](#open-questions)

<!-- /toc -->

## Context and Problem Statement

Studio's portal grew by adding tabs: Specs, Domain model, Product, Releases,
Tests, Issues, Artifacts, Activity, Research. Each one is written into the
portal and the backend, is shown to every project whether it needs it or not,
and changes only with a Studio release. An organization cannot add a screen,
a type or a reaction of its own. A project that does not build software still
gets Product and Releases.

ADR-0067 decided that a kit brings model, events, workflows, functions and
screens, and that the model part of a kit is the organization's. It did not
say what stays in Studio itself, where a kit is installed besides the
organization, how kits are found, or how today's features get there. Today's
kits (`studio-kits`) are still files that `cfs` writes into a checkout, chosen
per project.

The question: **what is Studio without its features, and how does everything
else arrive?**

## Considered Options

1. **Keep features in the portal, and let kits add to them.** Kits bring only
   what Studio lacks. Simple, but every built-in feature stays a special case
   that no kit can replace, hide or version, and two ways to build a feature
   live side by side.
2. **A shell, and everything inside it from kits, Studio's own features
   included.** Studio ships a small shell and a set of built-in kits that use
   the same manifest, installer and contribution points as any other kit.
3. **Separate apps per feature, linked from a launcher.** Strong isolation,
   but the levels, the people and the Inbox would be rebuilt in every app.

**Chosen: 2.** A feature that Studio ships is a kit like any other, so the
contribution points are proven by Studio's own use before anyone else depends
on them.

## Decision Outcome

### 1. What the shell is

The shell is what is the same for every organization and every kind of work:

| The shell holds | Because |
|---|---|
| The levels: organization → workspace → project, and the Components level above them | Every kit hangs off a level |
| People, membership, roles and the PDP | Every kit's objects are authorized the same way (ADR-0035) |
| The person: profile, preferences, pins, and the **Inbox** | Attention crosses every kit |
| Sources (repositories and connections) | Most kits read them; none owns them |
| Settings, the kit library and the installer | How kits arrive |
| The generic mechanisms: tab bars and their per-level settings, filters over object fields, search, the generic list, card, form and history screens (ADR-0067 §7) | A kit contributes data to them, not its own copy |
| The domain model's core and its journal (ADR-0066, ADR-0067) | What kits extend |

Nothing else is the shell's. A screen, a type, a field, a rule or an Inbox
source that only some organizations need is a kit's.

### 2. What a kit brings

ADR-0067 §6 lists what a kit brings into the model. Against the shell, a kit
contributes at named points:

| Contribution point | What a kit gives | Where it shows |
|---|---|---|
| `tab` on a level | a `shows` relation, and a FrontX micro-frontend or nothing (the generic screens) | the level's tab bar |
| `section` in a screen | a micro-frontend and the screen and slot it goes in | inside another kit's or the shell's screen |
| `field` / `type` | a model overlay | cards, forms, filters, the generic list |
| `inbox-source` | a query over its objects that says what waits on whom | the person's Inbox (§6) |
| `rule` / `function` | `automation-rule` and `function` objects | run by `studio-tasks` (ADR-0067 §4–5) |
| `mcp-tool` | tools over its REST routes | `studio-mcp`, for agents |
| working material | files `cfs` writes into a checkout | the project's repository, as today |

Every contribution carries the kit's origin (`meta.origin = "kit"`, the kit
and its version), so uninstalling removes exactly what the kit brought.

### 3. One manifest: `kit.gdl`

A kit is described in GDL, the language a gear (`gear.gdl`), a micro-frontend
package (`frontx.gdl`), an infra service (`service.gdl`) and a product
(`product.gdl`) are already described in. One `kit.gdl` at the kit's root
says everything it brings. Gearbox's engine parses and checks it, so Studio,
the IDE and CI read a kit the same way and a mistake is a diagnostic before
install, not a failure after:

```python
gdl_version = "1.7"

kit(
    slug = "project-lifecycle",
    name = "Project lifecycle",
    version = "1.0.0",
    description = "A project's phases, its status chip, filters and what waits on its owner",
    levels = ["organization", "workspace", "project"],   # where it may be installed

    # Types: GTS schemas registered in types-registry under the kit's namespace,
    # and the overlay that gives them fields, relations, events and a lifecycle.
    types = [
        kit_type(gts = "gts.cf.studio.kit.lifecycle.phase.v1~", schema = path("types/phase.json")),
    ],
    model = path("model/overlay.json"),                  # ADR-0067 §6

    # Screens: FrontX bundles mounted by the shell.
    tabs = [
        kit_tab(level = "project", shows = "project-lifecycle",
                mfe = frontx_mfe(package = path("mfe/lifecycle"))),   # optional
    ],
    sections = [
        kit_section(screen = "project.header", slot = "status",
                    mfe = frontx_mfe(package = path("mfe/status-chip"))),
    ],

    # Handlers, lightest first (§8).
    rules = [path("rules/phase-waiting.json")],
    functions = [
        kit_function(name = "advance_phase", wasm = path("functions/advance_phase.wasm"),
                     limits = {"fuel": 10_000_000, "memory_mb": 32, "timeout_ms": 2000}),
        kit_function(name = "summarize_phase", agent = path("functions/summarize.md")),
    ],
    services = [],                                       # a kit service: use_service(...), ADR-0065

    inbox = [kit_inbox_source(id = "phase-waiting", query = path("inbox/phase-waiting.json"))],
    mcp_tools = ["set_project_phase", "advance_phase"],

    # What the administrator approves at install; the PDP holds the kit to it.
    permissions = permissions(
        reads = ["gts.cf.studio.project.v1~"],
        writes = ["gts.cf.studio.kit.lifecycle.phase.v1~"],
        listens = ["project.updated"],
    ),

    material = [path("skills/"), path("templates/")],    # today's: files cfs writes into a checkout
)
```

The names (`kit`, `kit_type`, `kit_tab`, ...) are what GDL 1.7 adds for this
ADR; the shapes follow what GDL already has (`frontx_mfe`, `use_service`,
`path`). Today's `.cf-studio-kit.toml` is still read for a kit that brings only
working material, and a kit that has both is described by its `kit.gdl`.

A built-in kit has the same `kit.gdl`, compiled into Studio's image instead of
fetched.

### 4. The kit library

The library is the catalogue `studio-kits` keeps, grown into three shelves:

- **Built-in**: shipped in Studio's image, versioned with Studio, installed
  by default where their `levels` say, and removable like any other.
- **Official**: Constructor's kits in their own repositories (today's
  `sdlc`, `compete`), pinned by version.
- **Organization**: kits an organization publishes for itself, from a
  repository it connects. They are visible to that organization only.

The library screen lists every kit a person may install. For each it shows
what the kit brings (§2) before it is installed, and where it is installed
already.

### 5. The installer works on a level

A kit is installed on the level its contribution needs, which is the
narrowest level that holds everything it brings:

| A kit's part | Installed on |
|---|---|
| model overlay, rules, functions | the organization (ADR-0067 §6: the model is the organization's) |
| tabs and sections | the level the tab names, and it is inherited below unless that level hides it |
| inbox sources | the organization; each person sees the items the PDP lets them read |
| working material | the project, as today |

Installing, uninstalling and upgrading are runs in `studio-tasks`, so they
are durable, retried, and shown in Activity. Each is a REST route and an MCP
tool: an agent installs a kit the way a person does. An installation records
the kit, its version, the level and who installed it. Uninstall keeps objects
of a type the kit added until an administrator removes them (ADR-0067 §6).

### 6. The Inbox takes items from kits

The Inbox is the person's: everything that waits on them, across levels. It
holds no items of its own. Each item comes from an `inbox-source`. The shell
ships the sources that read shell objects: membership requests and mentions.
Every other source comes from a kit, for example deploys awaiting approval
from the Releases kit, review requests and pull requests from the Specs and
Sources kits, and a phase waiting on its owner from Project lifecycle. A
source says what an item is, whom it waits on, and which tool answers it. The
Inbox renders them alike and offers the answer, Done and Snooze. The same
list is an MCP tool, so an agent can work a person's Inbox on their behalf.

### 7. Today's tabs become built-in kits

Each of today's features moves into a built-in kit, one at a time, behind the
same contribution points. The portal keeps working throughout, because a
built-in kit is installed by default where the feature showed before.

| Built-in kit | Takes from today's portal |
|---|---|
| Project lifecycle | project status and phases, their filters (first: proves the mechanism) |
| Specs | Specs, spec quality, document types |
| Domain model | the model editor (the model itself stays in the shell) |
| Product & Releases | Product, Builds, Releases, Environments, Infrastructure |
| Tests | Tests |
| Issues | Issues |
| Artifacts | Artifacts |
| Activity | Activity, beyond the shell's own run list |
| Research | Research |
| Assistant | the chat assistant (mini-chat) |

The tabs marked experimental today (Issues, Tests, Kits, Artifacts, Activity)
are the first to leave the default set: installed only where someone asks for
them.

### 8. Anatomy of a kit

A kit is three kinds of thing Studio takes in **without a redeploy**, plus the
working material it already has:

```
kit (its own repository, published as an OCI artifact, §10)
 ├─ kit.gdl              the manifest (§3)
 ├─ types/                GTS schemas → types-registry; the model overlay → domain model
 ├─ mfe/                  FrontX bundles → mounted by the shell where `shows` says
 ├─ rules/                automation-rule objects → studio-tasks
 ├─ functions/            *.wasm modules and agent prompts → the function runtime (§9)
 └─ material/             files cfs writes into a project's checkout (as today)
```

- **Types.** Each type a kit adds is registered in types-registry under the
  kit's own GTS namespace (`gts.cf.studio.kit.<slug>.<type>.v1~`), so its
  meaning is catalogued like every other (ADR-0013). Its fields, relations,
  tabs, events and lifecycle are the kit's model overlay (ADR-0067 §6),
  stored with `meta.origin = "kit"`. Its objects live in graph-storage like any
  domain object; no gear changes and no migration of Studio's own tables.
- **Micro-frontends.** A kit's FrontX bundles are built and published with the
  kit. The shell loads them at run time from the kit's artifact, by the
  manifest, and mounts each where its `shows` relation or `section` says
  (ADR-0050). A kit with no micro-frontend gets the generic screens
  (ADR-0067 §7). The portal is not rebuilt for a kit.
- **Handlers.** What reacts to the kit's types is, from the lightest to the
  heaviest:

  | Tier | What it is | Runs in | Isolation |
  |---|---|---|---|
  | Rules | event → condition → action, in the expression language (ADR-0067 §4) | `studio-tasks` | no code |
  | Agent functions | a prompt and the MCP tools it may call | Studio's agent | the tools and the PDP |
  | WebAssembly functions | the kit's own code (§9) | the function runtime inside Studio | a sandbox |
  | A kit service | a container the kit needs for heavy work | deployed by Studio as an infra service (ADR-0065) | its own pod, called by contract |

  The first three are installed and upgraded with no redeploy. The fourth
  deploys the kit's service, never Studio.

Besides these, a kit declares **permissions**: which types it reads and
writes, which events it listens to, and which MCP tools it calls. The
administrator sees them before installing, and the PDP holds the kit's code
and rules to them. A kit's functions and actions are **MCP tools** on install,
so an agent can use everything a person can.

### 9. Kit code runs as WebAssembly inside Studio

A kit that needs code brings WebAssembly modules (WASI preview 2, component
model), compiled from any language that targets it. Studio runs them in an
embedded runtime (wasmtime) inside the function runtime of ADR-0067 §5.

- **No ambient authority.** A module has no network, no files and no clock
  beyond what its host functions give it.
- **Host functions** are the only way out: read and write domain objects
  (through the PDP, as the installing organization's kit principal), emit
  events, call an MCP tool the kit declared, and log.
- **Limits** per call: fuel (instructions), memory and wall time, set by the
  manifest within the organization's ceilings. A call that exceeds them fails
  as a run failure, retried by `studio-tasks` under the rule's policy.
- **Triggers** are the same as for any function: a rule on an event, a
  lifecycle transition, a screen action, or a direct API or MCP call.

This answers ADR-0067's open question 1: kit code needs no gear.

### 10. A kit is published as an OCI artifact

A kit is built from its own repository and published as one OCI artifact
(`kit.gdl`, types, bundles, modules, material), pinned by digest the way
Studio's images and charts are. The library (§4) lists artifacts; an
installation records the digest it installed, so an upgrade is a new digest
and a rollback is the old one. Built-in kits are the same artifacts, baked
into Studio's image. An organization's kits are published from a repository
it connects, into a registry it names; a kit from outside the organization
installs only when its publisher's signature is one the organization trusts.

## Phases

| Phase | Delivers | Depends on |
|---|---|---|
| 1 | `kit.gdl` in GDL 1.7, parsed and checked by Gearbox's engine; built-in kits declared in the image; installation records per level | ADR-0066 |
| 2 | The installer for tabs and the model overlay (ADR-0067 phase 6), as runs, REST routes and MCP tools; the library screen | 1 |
| 3 | Project lifecycle as the first built-in kit: type fields, tab, filters, inbox source | 2 |
| 4 | Inbox sources as a contribution point; the shell's own sources; today's Inbox items moved into their kits | 2 |
| 5 | Micro-frontends mounted for `shows` relations and sections | 2, ADR-0050 |
| 6 | Today's tabs moved into built-in kits, one per change | 3, 5 |
| 7 | Organization kits: publish from a connected repository | 2 |
| 8 | The WebAssembly function runtime, host functions and limits (§9) | ADR-0067 phase 5 |
| 9 | Kits as signed OCI artifacts; install by digest; upgrade and rollback (§10) | 2 |

## Consequences

- Good, because a project shows what its kits bring and nothing else. A
  project that does not build software has no Product tab.
- Good, because Studio's own features prove every contribution point before
  an outside kit relies on it.
- Good, because everything a person does in a kit's screen an agent can do
  through the kit's MCP tools, and the Inbox is the same list for both.
- Bad, because every feature moves once, behind an interface that is new.
  Each move is its own change, and the portal must look the same before and
  after it.
- Bad, because a contribution point is a contract. Changing one later touches
  every kit, so the first set is kept small.

## Confirmation

- A project whose organization has uninstalled Product & Releases shows no
  Product, Builds or Releases tab, and its Inbox has no deploy approvals.
- Project lifecycle can be installed, used, uninstalled and installed again
  through MCP tools alone.
- The portal has no tab that is not a `shows` relation of some kit or of the
  shell.

## Open questions

1. **Ordering tabs from several kits** on one level: by kit priority, by the
   level's own setting, or both.
2. **A kit that needs another kit's types** (Releases needs Sources'
   repositories): declared dependencies in the manifest, resolved by the
   installer.
3. **Data migrations between kit versions**: a WebAssembly function the
   manifest names for the upgrade, run once per organization, or an
   expression-level mapping for simple field renames.
4. **Which host functions a module gets first**: object read and write, events
   and logging are enough for Project lifecycle; calling MCP tools and
   outbound HTTP through OAGW come when a kit needs them.
