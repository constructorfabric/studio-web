# Feature: The organization overview

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Read the organization at a glance](#read-the-organization-at-a-glance)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Assemble the tiles](#assemble-the-tiles)
- [4. States (CDSL)](#4-states-cdsl)
  - [Tile State Machine](#tile-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The item exists from the first day](#the-item-exists-from-the-first-day)
  - [A tile answers or says who owes the answer](#a-tile-answers-or-says-who-owes-the-answer)
  - [A tile leads to the screen that holds the detail](#a-tile-leads-to-the-screen-that-holds-the-detail)
  - [No fan-out across gears](#no-fan-out-across-gears)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-organization-overview`

## 1. Feature Context

### 1.1 Overview

The first screen of the organization level: a few tiles saying what the
organization holds and where to go next. Every tile either carries a real
number or says plainly which answer does not exist yet.

### 1.2 Purpose

`shell-levels` made the level's first item the screen a session opens with, and
the design puts Overview there. Today that place is taken by whichever item
happens to sort first, which is an accident rather than a decision.

The design's Overview is an aggregate — gear health, workspace load, pending
invitations, connection health — and **no endpoint answers that**. Read in the
browser it would be four gears' worth of requests stitched together on the
client, which is the thing
`cpt-studiofrontend-dod-organization-overview-no-fanout` forbids.

So the choice fixed here: **the item ships with the screen, not after it.** The
tiles that can be answered from a read the screen already makes are answered;
the rest name what is missing. An empty state that says "no endpoint serves this
yet" is information; an absent item is a hole in the level.

**Assumptions fixed here**, because each changes the code:

- The screen is a **section of organization-mfe's entry**, like the workspaces
  list beside it, so the level's items cost one mount between them.
- The tiles are assembled from **one read** — the organization's workspaces,
  which the level already reads for its list. A tile whose data needs another
  gear stays an empty state until an aggregate exists.
- A tile is **a way in, not a report**: activating one goes to the level's item
  that holds the detail, through the section channel the rail already uses.

### 1.3 Actors

Named, not identified — a FEATURE may only define `algo`, `dod`, `featstatus`,
`flow` and `state` ids. See the same note in `project-create.md`.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** | A signed-in member of the organization in scope. Reads the tiles and follows one. |
| **MFE** | organization-mfe. Reads the workspaces, assembles the tiles, and announces the section a tile leads to. |
| **Shell** | Relays that section back, which is what moves the rail's highlight and the screen together. |

### 1.4 References

- **Feature**: [Levels in the shell](shell-levels.md) — the level, its rail and the section channel
- **Feature**: [The organization's workspaces](workspaces-screen.md) — the read these tiles reuse, and the screen they lead to
- **Dependencies**: account-management (`/cf/account-management/v1`)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`.

**Use case**: see what the organization holds.

### Read the organization at a glance

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-organization-overview-read`

**Actor**: Member

**Success Scenarios**:
- The tiles are on screen: those with an answer carry it, those without say what is missing.

**Error Scenarios**:
- The read fails; the tiles that depend on it say so and offer to try again, and the others are unaffected.
- No organization is in scope; the screen says that instead of reading for one it does not have.

**Steps**:
1. [ ] - `p1` - Mount the overview as the level's first item - `inst-1`
2. [ ] - `p1` - Run `cpt-studiofrontend-algo-organization-overview-tiles` - `inst-2`
3. [ ] - `p1` - Member activates a tile that leads somewhere - `inst-3`
4. [ ] - `p1` - Announce that tile's section, so the rail and the screen move together - `inst-4`
5. [ ] - `p1` - **RETURN** the screen the tile leads to - `inst-5`

## 3. Processes / Business Logic (CDSL)

### Assemble the tiles

- [ ] `p2` - **ID**: `cpt-studiofrontend-algo-organization-overview-tiles`

**Input**: the organization in scope, and its workspaces as already read for the level

**Output**: the tiles to draw, each answered or marked as owed

**Steps**:
1. [ ] - `p1` - Count the workspaces, and sum their `child_count` for the projects across them - `inst-1`
2. [ ] - `p1` - **IF** the read failed - `inst-2`
   1. [ ] - `p1` - Mark the tiles that depend on it as unread, keeping any numbers already shown - `inst-3`
3. [ ] - `p1` - Mark every tile whose data no endpoint serves as owed, naming what is missing - `inst-4`
4. [ ] - `p1` - **RETURN** the tiles in the design's order, answered ones first - `inst-5`

## 4. States (CDSL)

### Tile State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-organization-overview-tile`

**States**: Loading, Answered, Owed, Unread

**Initial State**: Loading

**Transitions**:
1. [ ] - `p1` - **FROM** Loading **TO** Answered **WHEN** the read the tile depends on succeeds - `inst-1`
2. [ ] - `p1` - **FROM** Loading **TO** Owed **WHEN** no endpoint serves the tile - `inst-2`
3. [ ] - `p1` - **FROM** Loading **TO** Unread **WHEN** the read fails and there is nothing shown yet - `inst-3`
4. [ ] - `p1` - **FROM** Answered **TO** Unread **WHEN** a later read fails; the number already shown stays, marked stale - `inst-4`
5. [ ] - `p1` - **FROM** Unread **TO** Answered **WHEN** the read is retried and succeeds - `inst-5`

## 5. Definitions of Done

### The item exists from the first day

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-organization-overview-item`

The system **MUST** register the overview as the first item of the organization
level, as a section of organization-mfe's entry, and **MUST** be what a session
opens with at that level.

The item is not held back until the aggregate exists. The level's first item is
the session's landing place, and letting that fall to whatever sorts first is
how a product ends up opening on People.

**Implements**:
- `cpt-studiofrontend-flow-organization-overview-read`

**Touches**:
- Entities: `mfe.json` (organization-mfe), `OrganizationRoot`, `OverviewScreen`

### A tile answers or says who owes the answer

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-overview-owed`

**Not done yet.** The screen is one empty state saying no aggregate serves it;
there are no tiles, so nothing here is answered. This and the two DoDs below
land together with the tiles, once the workspaces read is shared with the list
beside it.

The system **MUST** show a real number on a tile it can answer, and **MUST**
state what is missing on one it cannot — never a zero, a dash or an invented
figure standing in for an answer nobody has.

A zero is a claim. "No endpoint serves this yet" is the truth, and it is also
the backlog: the tiles that say it are the aggregate this screen is waiting for.

**Implements**:
- `cpt-studiofrontend-algo-organization-overview-tiles`

**Touches**:
- Entities: `OverviewScreen`

### A tile leads to the screen that holds the detail

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-overview-leads`

**Not done yet.** The crossing exists (`sectionActions.announceSection`) and
nothing calls it, because there is no tile to activate.

The system **MUST** move to the level's own item when a tile is activated, by
announcing that item's section, and **MUST NOT** mount a screen itself.

Same rule as the workspaces list: one way into a screen of a level, and it is
the shell's. Announcing the section is also what keeps the rail's highlight and
the content in step.

**Implements**:
- `cpt-studiofrontend-flow-organization-overview-read`

**Touches**:
- Action: `constructor_studio.context.projects.publish.v1~` (`kind: section`)
- Entities: `OverviewScreen`, `sectionActions`

### No fan-out across gears

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-overview-no-fanout`

**Not done yet.** Trivially true today — the screen reads nothing — and
checked only when the tiles exist and still make one read.

The system **MUST** assemble the tiles from reads this level already makes, and
**MUST NOT** call several gears from the browser to stitch an aggregate
together.

One screen reading gears, people, connections and projects would make the
organization's first paint depend on four services being up, and would put the
aggregation in the client where nothing can cache it. The aggregate belongs to
the backend; until it exists the tiles that need it stay owed.

**Implements**:
- `cpt-studiofrontend-algo-organization-overview-tiles`

**Touches**:
- API: `GET /cf/account-management/v1/tenants/{id}/children`
- Entities: `OverviewScreen`

## 6. Acceptance Criteria

- [ ] Overview is the first item of the organization's rail, and a fresh session opens on it.
- [ ] The workspaces tile shows how many workspaces the organization has and how many projects across them, from one request.
- [ ] The tiles nobody serves yet — gear health and what needs attention — say so in words, and show no number.
- [ ] Activating the workspaces tile opens the Workspaces screen, and the rail's highlight moves with it.
- [ ] Switching the organization re-reads the tiles, and never shows the previous organization's numbers.
- [ ] A failed read leaves any number already shown in place, marked stale, with a way to try again.
- [ ] With no organization in scope the screen says that, and makes no request.
- [ ] Moving between Overview and Workspaces does not remount the screen: both are sections of one entry.
