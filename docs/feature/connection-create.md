---
type: feature
status: accepted
owner: studio-team
---

# Feature: Connect a source

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-connection-create`

- [x] `p1` - `cpt-studio-feature-connection-create`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Read the connections](#read-the-connections)
  - [Connect a source](#connect-a-source)
  - [Abandon the form](#abandon-the-form)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Read the connection catalogue](#read-the-connection-catalogue)
  - [Check one connection's health](#check-one-connections-health)
  - [Write the connection](#write-the-connection)
- [4. States (CDSL)](#4-states-cdsl)
  - [Connection Health State Machine](#connection-health-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The form is an overlay extension, not a dialog](#the-form-is-an-overlay-extension-not-a-dialog)
  - [Scope and owner are decided, not asked](#scope-and-owner-are-decided-not-asked)
  - [The credential is verified by the write, once](#the-credential-is-verified-by-the-write-once)
  - [A rejected credential is answered on the credential field](#a-rejected-credential-is-answered-on-the-credential-field)
  - [The credential never comes back and never persists](#the-credential-never-comes-back-and-never-persists)
  - [The write outlives the form](#the-write-outlives-the-form)
  - [One place knows what a provider looks like](#one-place-knows-what-a-provider-looks-like)
  - [Health is per row and never blocks the table](#health-is-per-row-and-never-blocks-the-table)
  - [Columns without a source are empty, not invented](#columns-without-a-source-are-empty-not-invented)
  - [The list learns without polling](#the-list-learns-without-polling)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The Connections screen: a list of the source hosts and model providers the
organization has credentials for, and a single-step overlay that adds one. It is
the connections MFE's whole surface, and it is the second write path in the
portal.

### 1.2 Purpose

Connections already existed and could only be seeded by hand or by a gear
operator. The New project wizard reads them — its repositories step draws one tab
per connection — so until now a member who had no connection could not import
existing work and had no screen on which to fix that. This feature gives them
one.

The gear behind it is `studio-connector`. It is not account-management: a
connection is not a tenant, it is a credential in credstore plus the record that
names it, and the two vocabularies stay apart.

**Assumptions fixed here**, because the mockup is silent on each and the choice
changes the code:

- A connection is created at **organization** scope, attached to the organization
  the shell has in scope. `scope` and `owner_tenant_id` are therefore not fields:
  the form would offer one option and one value. The gear's own default is
  `workspace`, so `scope` is sent explicitly rather than omitted.
- The credential is verified **by the create call itself**. `POST /connections`
  probes the provider and answers with the identity it reported, so a separate
  "Test connection" control driving `POST /probe` would verify the same
  credential twice and disagree with itself on a flapping provider.
- The list checks each connection's health **on open**, one request per row. The
  mockup's Healthy / Needs attention badges have no other source: nothing on a
  stored connection records whether its token still works.

**Requirements**: `cpt-studio-fr-connections`

**Principles**: `cpt-studio-principle-credentials-by-reference`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | A signed-in member of the organization in scope. Opens the screen, connects a source, and reads back whether each connection still works. |
| **Shell** (`cpt-studio-actor-shell`) | The portal shell. Owns the overlay frame — mounts and unmounts the form, draws the scrim, and handles Escape and click-outside without consulting it — and publishes which organization is in scope. |
| **Provider** (`cpt-studio-actor-provider`) | GitHub, GitLab, Bitbucket, Anthropic, OpenAI. Answers the credential probe; its refusal is what the member reads. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md)
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-connection-create`
- **Mockups**: Figma `Constructor Studio mockups`, node `40001018:15055`
- **ADR**: [ADR-0008 — simplified navigation shell](../adr/0008-simplified-navigation-shell.md) (no router; the overlay is state, not a route)
- **Feature**: [Create a project](project-create.md) — reads these connections on its repositories step
- **Dependencies**: studio-connector (`/cf/studio-connector/v1`)

## 2. Actor Flows (CDSL)

The flows stay unchecked for the reason `project-create` records: a checked flow
obliges every CDSL instruction to carry a `@cpt-begin`/`@cpt-end` block, and
these span the header, the overlay plumbing, the form, the write effect and —
for "Abandon the form" — the shell's own dismissal code, which is outside this
system's codebase scope. Their evidence is section 6, exercised against a running
stack; the implementation claims they rest on are the Definitions of Done, which
are traced.

**Use case**: connect a source, and see whether the connections already there
still work.

### Read the connections

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-connection-list`

**Actor**: Member

**Success Scenarios**:
- Every connection the organization can use is listed, each with a provider glyph, the account its credential belongs to, and whether it still works.

**Error Scenarios**:
- The gear is deployed without a driver plugin; it answers 503 and the screen says the catalogue is unavailable.
- One connection's credential was rotated; that row reads Needs attention and the rest are unaffected.

**Steps**:
1. [ ] - `p1` - Member opens Connections - `inst-1`
2. [ ] - `p1` - Run `cpt-studiofrontend-algo-connection-list-read` - `inst-2`
3. [ ] - `p1` - Run `cpt-studiofrontend-algo-connection-list-health` for each row, independently - `inst-3`
4. [ ] - `p1` - Member narrows the list by typing in the search above it - `inst-4`
5. [ ] - `p1` - **RETURN** the matching rows - `inst-5`

### Connect a source

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-connection-create`

**Actor**: Member

**Success Scenarios**:
- The connection appears in the list, captioned with the account the provider reported for the pasted credential.

**Error Scenarios**:
- The provider rejects the credential; the overlay stays open with the draft intact and shows the provider's own words.
- The shell has published no organization; the primary action refuses and says so.

**Steps**:
1. [ ] - `p1` - Member activates "Connect source" in the list's header - `inst-1`
2. [ ] - `p1` - Mount the overlay extension in the shell's overlay domain - `inst-2`
3. [ ] - `p1` - Reset the draft so no earlier attempt is carried in - `inst-3`
4. [ ] - `p1` - `API: GET /cf/studio-connector/v1/providers (the provider choices, and the labels for the credential field)` - `inst-4`
5. [ ] - `p1` - Member picks a provider, names the connection, and pastes a credential - `inst-5`
6. [ ] - `p1` - Run `cpt-studiofrontend-algo-connection-create-write` - `inst-6`
7. [ ] - `p1` - Announce the created connection so the list refetches - `inst-7`
8. [ ] - `p1` - **RETURN** unmount the overlay extension - `inst-8`

### Abandon the form

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-connection-create-abandon`

**Actor**: Member

**Success Scenarios**:
- The overlay closes, nothing is written, and the pasted credential is gone with the React root.

**Error Scenarios**:
- None. Dismissal cannot fail and cannot be refused.

**Steps**:
1. [ ] - `p1` - Member presses Escape, clicks the scrim, or activates Cancel - `inst-1`
2. [ ] - `p1` - **IF** the trigger was Cancel - `inst-2`
   1. [ ] - `p1` - The form unmounts itself through the overlay domain - `inst-3`
3. [ ] - `p1` - **ELSE** - `inst-4`
   1. [ ] - `p1` - The shell unmounts it without consulting the form; there is no confirmation and no veto - `inst-5`
4. [ ] - `p1` - **RETURN** the draft is discarded with the React root - `inst-6`

## 3. Processes / Business Logic (CDSL)

### Read the connection catalogue

Four of the mockup's six columns have no data source. They are recorded here
rather than in the code so the screen is not blamed for them:

- **`@cpt-gap`** — AVAILABLE DATA. Nothing on the wire says which resources a
  connection exposes. `ProviderDto.category` distinguishes only `source_code`
  from `ai`, which is a coarser fact than the column asks for.
- **`@cpt-gap`** — PROJECTS. The only link between a connection and a project is
  `sources[].connection_id` inside each project's `cf.studio.project.config.v1~`
  tenant metadata, and account-management offers no bulk read of any kind: no
  `GET /tenants`, no subtree endpoint, and one metadata GET per project. Counting
  would cost a walk of the whole organization tree plus one request per project,
  on every open, and would still miss projects whose metadata write failed or
  that were seeded outside the wizard. It needs a rollup on the gear
  (`usage_count` on `ConnectionDto`) or a bulk metadata read in AM.
- **`@cpt-gap`** — LAST SYNC. No connection carries a sync timestamp.
  `created_at_epoch_secs` is when the record was written, which is a different
  fact, so it is not shown under this heading.
- **`@cpt-gap`** — ACTIONS. Manage and Reconnect are `PATCH /connections/{id}`
  and `DELETE /connections/{id}`, and both need an edit surface this feature does
  not define.

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-connection-list-read`

**Input**: the organization in scope, and the search text

**Output**: the rows to show

**Steps**:
1. [x] - `p1` - `API: GET /cf/studio-connector/v1/connections?tenant= (the organization's own connections and those inherited from its ancestors)` - `inst-1`
2. [x] - `p1` - `API: GET /cf/studio-connector/v1/providers (display name and glyph key per driver)` - `inst-2`
3. [x] - `p1` - Caption a row with the provider's `display_name`, never the wire key, because the key is `github` and the design says GitHub - `inst-3`
4. [x] - `p1` - Filter on the loaded rows rather than on the endpoint: `GET /connections` takes no search parameter and returns the catalogue whole - `inst-4`
5. [x] - `p1` - Render Available data, Projects, Last sync and Actions empty rather than fabricating them - `inst-5`
6. [x] - `p1` - **RETURN** the rows - `inst-6`

### Check one connection's health

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-connection-list-health`

**Input**: one connection id and the organization in scope

**Output**: healthy, unusable with the gear's reason, unreadable, or still checking

**Steps**:
1. [x] - `p1` - `API: POST /cf/studio-connector/v1/connections/{id}/test?tenant=` - `inst-1`
2. [x] - `p1` - Issue it per row and independently, so a provider that is slow or down delays only its own row - `inst-2`
3. [x] - `p1` - **IF** the check has not answered yet - `inst-3`
   1. [x] - `p1` - **RETURN** still checking; the cell shows a placeholder, not a status - `inst-4`
4. [x] - `p1` - **IF** the check failed without the gear naming `CONNECTOR_CREDENTIAL_UNUSABLE` — no answer at all, or a fault of the gear's own rather than a verdict on the credential - `inst-5`
   1. [x] - `p1` - **RETURN** unreadable; the cell says the health could not be read and **MUST NOT** say the connection is unusable - `inst-6`
5. [x] - `p1` - **IF** the gear refuses - `inst-7`
   1. [x] - `p1` - **RETURN** unusable, carrying the gear's `CONNECTOR_CREDENTIAL_UNUSABLE` reason for the title - `inst-8`
6. [x] - `p1` - **RETURN** healthy - `inst-9`

### Write the connection

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-connection-create-write`

**Input**: a complete draft and the organization tenant in scope

**Output**: the created connection, or the reason it was refused

**Steps**:
1. [x] - `p1` - Trim the label; reject an empty one, an unset provider or an empty credential before any request - `inst-1`
2. [x] - `p1` - Send `scope` as organization and `owner_tenant_id` as the organization in scope, neither of them asked for - `inst-2`
3. [x] - `p1` - Omit `base_url` when the member left it empty, so the gear applies the provider's own default rather than a value this screen copied - `inst-3`
4. [x] - `p1` - `API: POST /cf/studio-connector/v1/connections (provider, label, base_url, token, scope, owner_tenant_id)` - `inst-4`
5. [x] - `p1` - **IF** the gear refuses - `inst-5`
   1. [x] - `p1` - **RETURN** the refusal in the provider's own words; the draft survives so the member can correct it - `inst-6`
6. [x] - `p1` - **RETURN** the created connection; the response carries the account the provider reported, and never the token - `inst-7`

## 4. States (CDSL)

### Connection Health State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-connection-health`

**States**: Checking, Healthy, NeedsAttention, Unreadable

**Initial State**: Checking

**Transitions**:
1. [ ] - `p1` - **FROM** Checking **TO** Healthy **WHEN** the test answers with an identity - `inst-1`
2. [ ] - `p1` - **FROM** Checking **TO** NeedsAttention **WHEN** the test is refused - `inst-2`
3. [ ] - `p1` - **FROM** Healthy **TO** Checking **WHEN** the check is retried after its cached answer goes stale - `inst-3`
4. [ ] - `p1` - **FROM** NeedsAttention **TO** Checking **WHEN** the check is retried after its cached answer goes stale - `inst-4`
5. [ ] - `p1` - **FROM** Checking **TO** Unreadable **WHEN** the test fails without the gear naming its refusal - `inst-5`
6. [ ] - `p1` - **FROM** Unreadable **TO** Checking **WHEN** the check is retried after its cached answer goes stale - `inst-6`

## 5. Definitions of Done

### The form is an overlay extension, not a dialog

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-create-overlay`

The system **MUST** render the Connect source form as a second extension of the
connections MFE in the shell's overlay domain, mounted and unmounted through the
extension lifecycle actions, with its own entry and lifecycle instance.

Not the kit's `Dialog`: it does not forward `keepMounted` to its Portal, so an
MFE slot inside it is unmounted on every close and cannot host a second root.
This is the same arrangement the New project wizard uses, for the same reason.

**Implements**:
- `cpt-studiofrontend-flow-connection-create`
- `cpt-studiofrontend-flow-connection-create-abandon`

**Touches**:
- Entities: `mfe.json`, `overlayLifecycle`, `connectActions`

### Scope and owner are decided, not asked

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-create-scope`

The system **MUST** create every connection at organization scope, owned by the
organization the shell has in scope, and **MUST NOT** show either as a field.
The form **MUST** refuse to submit when the shell has published no organization.

A connection at organization scope is inherited by every workspace under it,
which is what makes it usable from the New project wizard. Workspace scope would
narrow it to one workspace and personal scope to one member; neither is a choice
this screen is in a position to offer, because it does not know which workspace
the member means. The gear's own default is `workspace`, so the field is sent
explicitly rather than left out.

**Implements**:
- `cpt-studiofrontend-algo-connection-create-write`

**Touches**:
- Property: `constructor_studio.context.organization.selected.v1~` (published by the shell)
- Entities: `shared/organization`, `connectEffects`, `connectionDraft`

### The credential is verified by the write, once

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-create-verify`

The system **MUST** rely on `POST /connections` to verify the credential and
**MUST NOT** offer a separate test control on the form.

The create call probes the provider before it stores anything and answers with
the identity the provider reported, so a rejected token never becomes a
connection. A second control driving `POST /probe` would verify the same
credential a second time and could disagree with the write that follows it.

**Implements**:
- `cpt-studiofrontend-algo-connection-create-write`

**Touches**:
- API: `POST /cf/studio-connector/v1/connections`
- Entities: `ConnectSourceDialog`, `connectEffects`

### A rejected credential is answered on the credential field

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-create-refusal`

The system **MUST** render a refusal the gear puts in its own words under the
credential field and mark that field invalid, and **MUST** keep its own generic
message at form level.

The form does not submit until a provider, a name and a credential are filled
in, so a refusal of the request itself is a refusal of the credential — the one
value the form cannot check before sending it. What the gear said is therefore
shown where the member can act on it, not under the buttons.

The system **MUST NOT** reword, parse or shorten what the gear said. A refusal
readable enough to put in front of a member is the gear's to write; a screen
that unpicks the wording instead would be guessing at a format the gear never
promised, and would go on guessing wrong after the gear reworded it.

**Implements**:
- `cpt-studiofrontend-algo-connection-create-write`

**Touches**:
- Entities: `ConnectSourceDialog`, `problemDetails`

### The credential never comes back and never persists

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-create-secret`

The system **MUST** keep the pasted credential in the draft only, **MUST** clear
the draft when the overlay mounts, and **MUST NOT** log it, echo it into an error
message, or render it as anything but a masked field.

The store outlives the overlay root — it belongs to the MFE app, which `init.ts`
builds once per entry — so without the reset a credential typed in an abandoned
attempt would still be in memory, and would reappear in the field, when the form
is opened again.

**Implements**:
- `cpt-studiofrontend-flow-connection-create-abandon`

**Touches**:
- Entities: `connectSlice`, `ConnectSourceDialog`

### The write outlives the form

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-create-write`

The system **MUST** perform the create in an effect registered with the slice,
not in the overlay component.

The shell owns Escape and the scrim and applies them without a veto. A creation
started from a component would be abandoned mid-flight by a React root going
away, and the member would be left not knowing whether the credential was
stored.

**Implements**:
- `cpt-studiofrontend-algo-connection-create-write`

**Touches**:
- Entities: `connectEffects`, `connectEvents`

### One place knows what a provider looks like

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-list-glyph`

The system **MUST** resolve a provider's glyph through a single map keyed by the
provider code, and **MUST** fall back to a generic glyph for a code it does not
know rather than failing to draw the row.

The gear's driver set is deployment-dependent and can be newer than this screen.
A row for an unrecognised provider is still a row the member configured, and the
list is where they would go to find out that it is there.

**Implements**:
- `cpt-studiofrontend-algo-connection-list-read`

**Touches**:
- Entities: `model/connection`, `ProviderGlyph`

### Health is per row and never blocks the table

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-list-health`

The system **MUST** issue one health check per connection, independently, and
**MUST** render the table before any of them has answered. A refused check
**MUST** affect only its own row and **MUST** surface the gear's reason.

A check that could not be made at all **MUST NOT** be reported as a refusal —
the cell says the health could not be read. What decides is the gear naming its
refusal `CONNECTOR_CREDENTIAL_UNUSABLE`, and **MUST NOT** be the HTTP status:
the gear answers the same `failed_precondition` for every cause, and a
deployment with no connector driver plugin answers 503 for every row, which
under a status test would libel every credential at once.

The check reaches the provider over the network. Gathering the answers before
drawing would make the slowest provider the speed of the screen, and one
unreachable provider the availability of the screen.

Known residue, the gear's to settle: `test_connection` folds a provider that is
down and a secret the caller may not read into `CONNECTOR_CREDENTIAL_UNUSABLE`
as well, so those two still read as unusable. Separating them needs a second
violation code there, the way `list_repositories` already has
`CONNECTOR_LISTING_UNAVAILABLE`.

**Implements**:
- `cpt-studiofrontend-algo-connection-list-health`
- `cpt-studiofrontend-state-connection-health`

**Touches**:
- API: `POST /cf/studio-connector/v1/connections/{id}/test`
- Entities: `useConnectionHealth`, `HealthInline`, `LoadFailed`

### Columns without a source are empty, not invented

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-list-gaps`

The system **MUST** render Available data, Projects, Last sync and Actions as an
explicit placeholder carrying the reason, and **MUST NOT** substitute a value
from a different fact.

Specifically, `created_at_epoch_secs` **MUST NOT** be shown under Last sync: when
the record was written is not when it last synchronised, and a member reading
"8 min ago" would conclude the connection had just been exercised.

**Implements**:
- `cpt-studiofrontend-algo-connection-list-read`

**Touches**:
- Entities: `ConnectionsTable`

### The list learns without polling

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-connection-create-announce`

The system **MUST** make a created connection appear in the list without a manual
refresh, by invalidating the organization's connection listing on the shared
QueryClient.

Not by an event the list listens to: `MfeHandlerMF` loads each expose into its
own blob-URL module graph, so the screen entry and the overlay entry have
separate stores and separate event buses. The QueryClient is the one thing they
do share, because `queryCacheShared` retains the host's off `globalThis`.

**Implements**:
- `cpt-studiofrontend-flow-connection-create`

**Touches**:
- Entities: `connectEffects`, `ConnectSourceDialog`

## 6. Acceptance Criteria

- [ ] Connections lists every connection the organization can use, one row each, with the provider's proper display name and the account its credential belongs to.
- [ ] A connection inherited from an ancestor tenant is listed alongside the organization's own.
- [ ] Each row's status resolves on its own: the table is drawn before any check has answered, and a provider that never answers leaves only its own row unresolved.
- [ ] A connection whose credential was rotated at the provider reads Needs attention, and its reason is readable on the cell.
- [ ] Typing in the search above the list narrows the rows by name, account and provider, without a request.
- [ ] A search that matches nothing says so, rather than claiming the organization has no connections, offers to clear the search, and the row count never contradicts the rows on screen.
- [ ] Available data, Projects, Last sync and Actions render a placeholder in every row; no cell shows the record's creation time.
- [ ] Activating "Connect source" opens the overlay; the list stays visible behind the scrim.
- [ ] Escape, a click on the scrim, and Cancel all close the overlay and write nothing.
- [ ] Reopening the form after abandoning a filled-in attempt shows empty fields, including the credential.
- [ ] The provider choices come from the gear, and choosing one relabels the credential field and offers that provider's default installation root as the placeholder.
- [ ] The primary action is disabled until a provider is chosen and the label and credential are non-empty.
- [ ] The form has no scope field, no owner field and no test button.
- [ ] Creating with a valid credential adds the connection at organization scope, owned by the organization in scope, captioned with the account the provider reported.
- [ ] Leaving the base URL empty stores the provider's default installation root, not an empty string.
- [ ] A rejected credential leaves the overlay open with the draft intact and says what the gear said under the credential field, with the field marked invalid.
- [ ] With no organization in scope the primary action refuses and says why.
- [ ] The created connection appears in the list without a manual refresh, and is offered as a tab by the New project wizard's repositories step.
