---
type: feature
status: draft
owner: studio-team
---

# Feature: The organization's people

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-organization-people`

- [ ] `p1` - `cpt-studio-feature-organization-people`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
  - [1.5 The API it stands on](#15-the-api-it-stands-on)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [See who is in the organization](#see-who-is-in-the-organization)
  - [Open a member's identities](#open-a-members-identities)
  - [Change a member's role](#change-a-members-role)
  - [Suspend or resume a member](#suspend-or-resume-a-member)
  - [Remove a member](#remove-a-member)
  - [Invite someone by e-mail](#invite-someone-by-e-mail)
  - [Withdraw an invitation](#withdraw-an-invitation)
  - [Add a person from the directory](#add-a-person-from-the-directory)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Read the room](#read-the-room)
  - [Guard the last owner](#guard-the-last-owner)
  - [Add a person who may not have signed in yet](#add-a-person-who-may-not-have-signed-in-yet)
- [4. States (CDSL)](#4-states-cdsl)
  - [People Screen State Machine](#people-screen-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
- [6. Acceptance Criteria](#6-acceptance-criteria)
- [7. Pitfalls met on the way](#7-pitfalls-met-on-the-way)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The organization level's **People** screen: who belongs to the organization, in
what role and standing, and the controls an owner uses to change that — change a
role, suspend, resume, remove, invite by e-mail, withdraw an invitation. A
platform administrator can also add anyone who has an identity.

Today `people-mfe` holds the reserved placeholder ("This area is under
construction", `cpt-studio-component-reserved-mfes`). The backend this screen
needs is in place, and the prototype has a working implementation to read
before building this one: `studio-frontend-prototype/src/org-admin.tsx`
(`OrgMembersView`, `OrganizationsTable`), PR #456.

### 1.2 Purpose

`cpt-studio-fr-org-administration` says an owner **MUST** be able to manage the
organization's memberships and invitations. Nothing in the official portal lets
them. On Dev that gap was not academic: the shared organization had no members
at all, everybody reached it only through their home tenant (which ADR-0011
says is no authority), and granting memberships by hand went to the wrong one of
two organizations with the same name.

**Assumptions fixed here**, because each changes the code:

- The screen is **`people-mfe`'s own entry**, at the organization level, at
  `/people` — the manifest already registers it (`mfe.json`). No new MFE.
- **Membership is the authority** (ADR-0011 §2): the rows come from
  `studio-user`, never from account-management's tenant users.
- **The backend enforces every rule.** The screen mirrors the ones a person
  would otherwise only learn from a refusal (the last owner), and never
  replaces them.

**Requirements**: `cpt-studio-fr-org-administration`, `cpt-studio-fr-invitations-membership`, `cpt-studio-fr-identity-directory`

**Principles**: `cpt-studio-principle-reserved-not-empty`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Organization owner** (`cpt-studio-actor-org-owner`) | Reads the members, changes roles and standing, removes, invites and withdraws. |
| **Platform administrator** (`cpt-studio-actor-platform-admin`) | Everything an owner does, in any organization, plus adding a person from the identity directory. |
| **Member** (`cpt-studio-actor-member`) | The person invited: sees the invitation at sign-in (`OrganizationAccessGate`, already built) and accepts it. Not an owner, so the screen is not theirs to use. |
| **MFE** (`cpt-studio-actor-mfe`) | `people-mfe`. Reads the room, draws it, writes one change at a time and re-reads. |
| **studio-user** (`cpt-studio-component-user`) | Holds memberships and invitations; decides who may change them; keeps the owner grant in step. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md)
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-organization-people`
- **Feature**: [Levels in the shell](shell-levels.md) — the level this screen belongs to
- **ADR**: [ADR-0011 — authentication does not grant organization membership](../adr/0011-authentication-does-not-grant-organization-membership.md)
- **ADR**: [ADR-0019 — a role narrows what a member may do](../adr/0019-a-role-narrows-what-a-member-may-do.md) — why "owner" is answered in the gear
- **Reference implementation**: `studio-frontend-prototype/src/org-admin.tsx` (#456); backend #455
- **Dependencies**: studio-user (`/cf/studio-user/v1`), studio-identity (`/cf/studio-identity/v1`, platform administrator only)

### 1.5 The API it stands on

Every route is under the gateway prefix `/cf`. `{org}` is the organization tenant
id, `{user}` the **canonical Studio person id** (`user_id` in every membership) —
not the Keycloak subject.

| Route | Gate | Answer |
|---|---|---|
| `GET /studio-user/v1/organizations/{org}/members?offset=&limit=` | `people.view` | `{ items: [{ user_id, display_name?, email?, role, status, source, created_at_epoch_ms, updated_at_epoch_ms }], total }` |
| `GET /studio-user/v1/organizations/{org}/members/{user}/identities` | `people.view` | `{ user_id, logins: [{ provider, subject, verified, linked_at_epoch_ms }], aliases: [{ kind, external_id, confidence, attributes, added_at_epoch_ms }] }`; `404` for somebody not in `{org}` |
| `PUT /studio-user/v1/users/{user}/memberships/{org}` | `people.manage` | body `{ role: "owner"\|"admin"\|"member", status?: "active"\|"suspended", source?: "assignment"\|"manual" }` → the membership |
| `DELETE /studio-user/v1/users/{user}/memberships/{org}` | `people.manage` | `{ connections_removed }` |
| `GET /studio-user/v1/organizations/{org}/invitations` | `people.view` | `{ items: [{ id, org_id, email, role, expires_at_epoch_ms, accepted_at_epoch_ms? }] }` |
| `POST /studio-user/v1/organizations/{org}/invitations` | `people.invite` | body `{ email, role: "member"\|"admin" }` → `{ invitation, token }` |
| `DELETE /studio-user/v1/organizations/{org}/invitations/{id}` | `people.invite` | 204 |
| `GET /studio-identity/v1/users` | platform admin | `{ items: [{ id (Keycloak subject), username, email?, display_name?, … }], truncated }` |
| `POST /studio-user/v1/resolve` | platform admin | body `{ provider: "keycloak", subject, display_name?, email? }` → `{ user_id }`, creating the person if new |

What the answers mean, and what a screen must not assume:

- **Gates.** `people.*` is an **owner of that organization, or a platform
  administrator** (organizations are on the `tenant` model, where ownership is
  the only arm). A refusal is `403` with reason `ORG_OWNER_REQUIRED`.
- **Roles are a closed set**: `owner`, `admin`, `member` on a membership;
  `member`, `admin` on an invitation (an owner is appointed, never invited).
  Anything else is `400`. The set is written in `studio-backend/src/user_profile/rest.rs`
  (`MEMBERSHIP_ROLES`) and `invitations.rs` (`INVITABLE_ROLES`) — the OpenAPI
  types `role` as a string, so this is one of the facts
  [frontend-handover-hardcode.md](../frontend-handover-hardcode.md) warns about:
  copy it knowingly, or ask for an enum.
- **"Owner" is one thing.** Only an **active** `owner` membership administers:
  the backend gives that person the organization's owner grant in the access
  config and takes it away when they are demoted, suspended, removed or leave.
  The screen writes the membership and **nothing else** — never the access
  config.
- **The last owner.** Demoting, suspending or removing the only active owner is
  `400` (the constraint text says why); so is removing the only person at all.
  A person who is not a member is `404`.
- **Suspended** keeps the row and its role and grants nothing while it stands.
- **Removing** also deletes that person's *personal* connections in the
  organization (`connections_removed`). Say so in the confirmation.
- **An invitation is not a link to send.** The person sees it when they sign in
  with that address proven, and accepts it themselves — the portal already does
  this in `OrganizationAccessGate`. The `token` in the create answer is for other
  channels; the screen need not show it. An invitation is pending while
  `accepted_at_epoch_ms` is empty and `expires_at_epoch_ms` is in the future.
- **The directory speaks Keycloak ids.** `studio-identity` rows carry the
  Keycloak subject; membership routes need the Studio `user_id`. `resolve` is
  the bridge. The directory answers `503` on a Studio with no Keycloak admin
  configured — a state, not a bug.

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker.

**Use case**: administer who belongs to the organization.

### See who is in the organization

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-organization-people-read`

**Actor**: Organization owner

**Success Scenarios**:
- Every member is listed with name (or e-mail, or a short id), role, standing and how they joined, and the pending invitations beneath.

**Error Scenarios**:
- The caller is not an owner; the screen says the list is for the organization's owners instead of showing an empty room.
- The read fails; whatever was shown stays, with a way to try again.

**Steps**:
1. [ ] - `p1` - Owner opens People on the organization level - `inst-1`
2. [ ] - `p1` - Read the room: `cpt-studiofrontend-algo-organization-people-read` - `inst-2`
3. [ ] - `p1` - **RETURN** the members and the pending invitations - `inst-3`

### Open a member's identities

- [ ] `p2` - **ID**: `cpt-studiofrontend-flow-organization-people-identities`

**Actor**: Organization owner

**Success Scenarios**:
- The row unfolds into the person's Studio id, every sign-in identity (provider, subject, verified, when linked) and every attributed account (kind, account, confidence, whether activity counts as theirs).
- A platform administrator also sees, for each Keycloak login, what the directory says: the account's name, username and e-mail, the broker it came through (`github`, or a password), and its directory status.

**Error Scenarios**:
- The person left meanwhile (`404`); the panel says their identities could not be read, and the next re-read drops the row.
- The person has no login yet (added before anyone signed in as them); the panel says so rather than showing an empty table.

**Steps**:
1. [ ] - `p1` - Owner activates the row's ▸ - `inst-1`
2. [ ] - `p1` - `API: GET /cf/studio-user/v1/organizations/{org}/members/{user}/identities` - `inst-2`
3. [ ] - `p2` - **IF** the caller is a platform administrator, match each `keycloak` login's `subject` to the directory row with that `id` - `inst-3`
4. [ ] - `p1` - **RETURN** the logins and the aliases - `inst-4`

Only for somebody in the organization: authority over a room is authority over
the people in it. Studio's own records, never the IdP: the IdP reader answers
about the signed-in person alone, so an owner never enumerates realm accounts
through this screen.

### Change a member's role

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-organization-people-role`

**Actor**: Organization owner

**Success Scenarios**:
- The row shows the new role as the server has it; promoting to owner lets that person administer at once.

**Error Scenarios**:
- The change would leave no active owner; it is not offered, and if it is sent anyway the refusal's text is shown and the row keeps its role.

**Steps**:
1. [ ] - `p1` - Owner picks a role for a row - `inst-1`
2. [ ] - `p1` - `API: PUT /cf/studio-user/v1/users/{user}/memberships/{org}` with the new role and the current status - `inst-2`
3. [ ] - `p1` - Re-read the room - `inst-3`
4. [ ] - `p1` - **RETURN** the row as the server has it - `inst-4`

### Suspend or resume a member

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-organization-people-standing`

**Actor**: Organization owner

**Success Scenarios**:
- The row reads Suspended (or Active again); the role is kept.

**Error Scenarios**:
- Suspending the only active owner is not offered.

**Steps**:
1. [ ] - `p1` - Owner activates Suspend (Resume) on a row - `inst-1`
2. [ ] - `p1` - `API: PUT …/memberships/{org}` with the same role and `status: suspended` (`active`) - `inst-2`
3. [ ] - `p1` - Re-read the room - `inst-3`
4. [ ] - `p1` - **RETURN** the row as the server has it - `inst-4`

### Remove a member

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-organization-people-remove`

**Actor**: Organization owner

**Success Scenarios**:
- After a confirmation that names the person and says their personal connections go too, the row is gone.

**Error Scenarios**:
- The only active owner, or the only person, is not removable; the control says why.
- The confirmation is dismissed; nothing is written.

**Steps**:
1. [ ] - `p1` - Owner activates Remove on a row and confirms - `inst-1`
2. [ ] - `p1` - `API: DELETE /cf/studio-user/v1/users/{user}/memberships/{org}` - `inst-2`
3. [ ] - `p1` - Re-read the room - `inst-3`
4. [ ] - `p1` - **RETURN** the room without them - `inst-4`

### Invite someone by e-mail

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-organization-people-invite`

**Actor**: Organization owner

**Success Scenarios**:
- The address appears under "Waiting to be accepted" with its role and expiry.

**Error Scenarios**:
- The address or role is refused; the form keeps what was typed and shows the reason.

**Steps**:
1. [ ] - `p1` - Owner types an address and picks Member or Admin - `inst-1`
2. [ ] - `p1` - `API: POST /cf/studio-user/v1/organizations/{org}/invitations` - `inst-2`
3. [ ] - `p1` - Re-read the invitations - `inst-3`
4. [ ] - `p1` - **RETURN** the pending list with the new invitation - `inst-4`

### Withdraw an invitation

- [ ] `p2` - **ID**: `cpt-studiofrontend-flow-organization-people-withdraw`

**Actor**: Organization owner

**Success Scenarios**:
- The invitation is gone from the pending list and can no longer be accepted.

**Error Scenarios**:
- It was accepted meanwhile: withdrawing deletes the record, not the membership it produced; the re-read shows the person among the members.
- It is already gone (`404`, "no such invitation in this organization"); the list is re-read.

**Steps**:
1. [ ] - `p1` - Owner activates Withdraw on a pending invitation - `inst-1`
2. [ ] - `p1` - `API: DELETE /cf/studio-user/v1/organizations/{org}/invitations/{id}` - `inst-2`
3. [ ] - `p1` - **RETURN** the room re-read - `inst-3`

### Add a person from the directory

- [ ] `p2` - **ID**: `cpt-studiofrontend-flow-organization-people-add`

**Actor**: Platform administrator

**Success Scenarios**:
- The person is a member at once, with their name, whether or not they have signed in before.

**Error Scenarios**:
- The directory is unavailable (`503`); the picker is not offered and the screen says to invite by e-mail.

**Steps**:
1. [ ] - `p1` - Platform administrator picks someone from the directory and a role - `inst-1`
2. [ ] - `p1` - Add them: `cpt-studiofrontend-algo-organization-people-add` - `inst-2`
3. [ ] - `p1` - **RETURN** the room with them in it - `inst-3`

## 3. Processes / Business Logic (CDSL)

### Read the room

- [ ] `p1` - **ID**: `cpt-studiofrontend-algo-organization-people-read`

**Input**: the organization in scope

**Output**: its members and pending invitations, or a reason there are none to show

**Steps**:
1. [ ] - `p1` - **IF** no organization is in scope - `inst-1`
   1. [ ] - `p1` - **RETURN** nothing to show; the screen says to pick an organization - `inst-2`
2. [ ] - `p1` - `API: GET /cf/studio-user/v1/organizations/{org}/members`, walking `offset`/`limit` until `total` - `inst-3`
3. [ ] - `p1` - **IF** the answer is `403` - `inst-4`
   1. [ ] - `p1` - **RETURN** Forbidden: the list is for the organization's owners - `inst-5`
4. [ ] - `p1` - `API: GET /cf/studio-user/v1/organizations/{org}/invitations`; keep those not accepted and not expired - `inst-6`
5. [ ] - `p1` - Name each member by `display_name`, else `email`, else a short form of `user_id` - `inst-7`
6. [ ] - `p1` - **RETURN** the members and the pending invitations - `inst-8`

### Guard the last owner

- [ ] `p1` - **ID**: `cpt-studiofrontend-algo-organization-people-last-owner`

**Input**: the room, and one member

**Output**: whether that member's role, standing and membership may be changed from here

**Steps**:
1. [ ] - `p1` - Count the members whose role is `owner` and status `active` - `inst-1`
2. [ ] - `p1` - **IF** this member is one of them and the count is one - `inst-2`
   1. [ ] - `p1` - **RETURN** locked: no demotion, no suspension, no removal; say "add another owner first" - `inst-3`
3. [ ] - `p1` - **RETURN** free; the server still decides - `inst-4`

### Add a person who may not have signed in yet

- [ ] `p2` - **ID**: `cpt-studiofrontend-algo-organization-people-add`

**Input**: a directory row (Keycloak subject, name, e-mail) and a role

**Output**: their membership

**Steps**:
1. [ ] - `p1` - `API: POST /cf/studio-user/v1/resolve` with `provider: keycloak`, the subject, the name and the e-mail — the person is created with that name if new - `inst-1`
2. [ ] - `p1` - `API: PUT /cf/studio-user/v1/users/{user_id}/memberships/{org}` with the role and `source: assignment` - `inst-2`
3. [ ] - `p1` - **RETURN** the membership - `inst-3`

## 4. States (CDSL)

### People Screen State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-organization-people`

**States**: NoOrganization, Loading, Listed, Empty, Forbidden, Failed

**Initial State**: NoOrganization

**Transitions**:
1. [ ] - `p1` - **FROM** NoOrganization **TO** Loading **WHEN** an organization is in scope - `inst-1`
2. [ ] - `p1` - **FROM** Loading **TO** Listed **WHEN** the members read answers with rows - `inst-2`
3. [ ] - `p1` - **FROM** Loading **TO** Empty **WHEN** it answers with none; the invite form is still offered - `inst-3`
4. [ ] - `p1` - **FROM** Loading **TO** Forbidden **WHEN** it answers `403` - `inst-4`
5. [ ] - `p1` - **FROM** Loading **TO** Failed **WHEN** it fails otherwise; rows already shown are kept - `inst-5`
6. [ ] - `p1` - **FROM** Listed **TO** Loading **WHEN** a write succeeds, or the organization is switched - `inst-6`
7. [ ] - `p1` - **FROM** Failed **TO** Loading **WHEN** the owner asks again - `inst-7`

## 5. Definitions of Done

### The screen is people-mfe's, on the organization level

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-people-level`

The system **MUST** replace `people-mfe`'s placeholder with this screen, keeping
the registration `mfe.json` already has (organization level, `/people`), and
**MUST** drop its `_BlankApiService`.

**Implements**:
- `cpt-studiofrontend-flow-organization-people-read`

**Touches**:
- Entities: `mfe.json` (people-mfe), `HomeScreen`, a `PeopleApiService`

### Membership is the authority

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-people-authority`

The system **MUST** read and write the organization's people through
`studio-user` only, and **MUST NOT** list account-management's tenant users
(`/tenants/{id}/users`) or use `studio-identity`'s assignment
(`POST /users/{id}/assignment`) for it.

The tenant-user list is a Keycloak group projection: a person can be in it
without belonging, and belong without being in it. The assignment rewrites the
person's Keycloak groups to **one** organization, deleting the others, while
`studio-user` holds several memberships per person — using it here would
silently take people out of their other organizations.

**Implements**:
- `cpt-studiofrontend-algo-organization-people-read`
- `cpt-studiofrontend-algo-organization-people-add`

**Touches**:
- API: `/cf/studio-user/v1/organizations/{org}/members`, `/cf/studio-user/v1/users/{user}/memberships/{org}`

### One change, then the room as the server has it

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-people-reread`

The system **MUST** re-read the room after every write, and **MUST NOT** patch
the row from what it sent.

The server changes more than the row: an owner write moves the access-config
grant, a removal deletes connections, an invitation may have been accepted in
the meantime. What was sent is not what is true.

**Implements**:
- `cpt-studiofrontend-flow-organization-people-role`
- `cpt-studiofrontend-flow-organization-people-standing`
- `cpt-studiofrontend-flow-organization-people-remove`

### The last owner is visible before it is a refusal

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-people-last-owner`

The system **MUST** disable demoting, suspending and removing the only active
owner, saying why, and **MUST** still show the server's refusal if one comes.

**Implements**:
- `cpt-studiofrontend-algo-organization-people-last-owner`

### The roles are the backend's

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-organization-people-roles`

The system **MUST** offer exactly `owner`, `admin`, `member` on a membership and
`member`, `admin` on an invitation, and **MUST** show a role outside that set as
it is rather than dropping the row.

A row written before the backend validated roles may carry anything; hiding it
would hide a person.

**Touches**:
- Entities: `PeopleApiService` types; see `frontend-handover-hardcode.md`

### An invitation is accepted where the person signs in

- [ ] `p2` - **ID**: `cpt-studiofrontend-dod-organization-people-invite`

The system **MUST** invite through `studio-user` invitations and **MUST NOT**
create accounts (no `POST /tenants/{id}/users`, no made-up addresses). The
invitee's side is `OrganizationAccessGate`, which already lists and accepts
invitations.

**Implements**:
- `cpt-studiofrontend-flow-organization-people-invite`
- `cpt-studiofrontend-flow-organization-people-withdraw`

### Two organizations of the same name are told apart

- [ ] `p2` - **ID**: `cpt-studiofrontend-dod-organization-people-identity`

The system **MUST** show the organization's short id beside its name on this
screen.

On Dev two organizations are called "Constructor Fabric", and a membership was
granted in the wrong one because nothing on screen differed.

## 6. Acceptance Criteria

- [ ] People on the organization level lists every member with name, role, standing and how they joined, from one paged read of `studio-user`.
- [ ] A person with no profile name is shown by e-mail, else by a short id — never as an empty row.
- [ ] A person assigned from the identity directory is named after their IdP name and e-mail; a name they gave themselves is never overwritten. Re-running the membership backfill names those assigned before this.
- [ ] Opening a row shows the person's sign-in identities and attributed accounts; a platform administrator also sees the directory's account for each Keycloak login.
- [ ] A non-owner opening People is told the list is for owners, not shown an empty room.
- [ ] Changing a role, suspending, resuming and removing each re-read the room; the row shows what the server has.
- [ ] Promoting someone to owner lets them open this screen immediately; demoting them takes that away.
- [ ] The only active owner cannot be demoted, suspended or removed from the screen, and the control says why.
- [ ] Remove asks first, naming the person and saying their personal connections go too.
- [ ] Inviting by e-mail adds a pending invitation with its role and expiry; withdrawing removes it.
- [ ] A platform administrator can add a person from the directory, and they appear with their name even if they never signed in; where the directory answers `503`, the screen says to invite by e-mail instead.
- [ ] The header names the organization and its short id.

## 7. Pitfalls met on the way

Found while building the prototype's version (#455, #456); each cost a cycle.

- **`user_id` is not the Keycloak `sub`.** Memberships key on the canonical
  Studio person. A directory row's `id` is the Keycloak subject; pass it through
  `resolve` first.
- **A person created by `resolve` without a name has none.** Always send the
  directory's `display_name` and `email`; the members list then names them.
- **`studio-identity` is for the platform administrator only**, and may be
  unconfigured (`503`). Treat both as states of the add control, not errors of
  the screen.
- **`RestMockPlugin` matches the exact `METHOD url`.** Build the paths in one
  exported module (as `accountsPaths.ts` does) and key the mocks off it, or the
  mocks silently match nothing.
- **`total` is across pages.** The members read is `?offset=&limit=` with a
  ceiling of 200; walk it rather than read the first page as the whole room.
- **Do not port the prototype's organization create/delete as is.** It writes
  account-management directly; `studio-organizations` (`POST`/`DELETE
  /organizations`) also writes the owner membership and grant, and evicts the
  members before deleting.
