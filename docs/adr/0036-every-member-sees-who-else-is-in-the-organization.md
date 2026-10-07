---
type: adr
status: proposed
date: 2026-10-07
---

# ADR-0036: Every member sees who else is in the organization

**ID**: `cpt-studio-adr-every-member-sees-who-else-is-in-the-organization`

Status: **proposed** · Date: 2026-10-07 · Extends ADR-0019 (`people.view`) and applies ADR-0023 (an organization sees its own projection of a person)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Who is in an organization can be read only with `people.view` (ADR-0019 §2).
On the `tenant` access model, where every organization on the stands sits,
that privilege is held by the owner alone. So an ordinary member cannot see the
people they work with — not a name, not a photo, not who to ask — although the
product's People screen, and every screen that names a colleague, assumes they
can.

`people.view` is not the wrong gate; it guards the wrong amount. The members
listing carries what an administrator needs: every address a person holds, how
they sign in, how their membership arose, and members who are suspended. That
is rightly an administrator's. What a colleague needs is much less, and it
should not take an administrator's privilege to read it.

## Considered Options

1. **Keep `people.view` as the only way in.** An organization that wants its
   members to see each other moves to the `roles` model, where the seeded
   `editor` and `viewer` hold `people.view`. Correct, but it hands every member
   the whole administrative listing — addresses and sign-ins included — and it
   makes a basic product screen depend on an access-model switch most
   organizations never make.
2. **Grant `people.view` to every member on the `tenant` model.** The same
   over-sharing as option 1, without even the switch.
3. **A smaller projection any active member may read.** Name, photo, role,
   the organization's description of the person (company, department, title,
   manager) and when they were last seen; no addresses and no sign-ins. The
   administrative listing stays behind `people.view`.

## Decision Outcome

Chosen option: **3**.

### 1. The colleague projection

`GET /studio-user/v1/me/colleagues` answers, for each organization the caller
is an **active** member of, every **active** member of it: user id, display
name, photo URL, role, the organization's description of them, and when they
were last seen. One row per organization and person, the caller included.

It does not carry e-mail addresses, sign-in methods, attributed identities,
how the membership arose, or anybody whose membership is suspended. Those stay
on `GET /organizations/{org_id}/members` and its identities, behind
`people.view`.

### 2. The scope is the caller's own memberships

The route takes no organization. The organizations it reads are the caller's
active memberships, so there is nothing a caller can name to look into an
organization they do not belong to (ADR-0011 §2: membership is the authority).
That also keeps it inside rule C1 of the API conventions: the scope comes from
who is asking, not from the path.

### 3. Suspension counts on both sides

A suspended member sees nobody through that organization, and nobody sees them
there. Suspension grants nothing while it stands (ADR-0011 §2), and being seen
by colleagues, or seeing them, is something the membership grants.

### Consequences

- Every member can show the people they work with without an administrator's
  privilege, on either access model.
- An organization's description of a person (ADR-0023) is now visible to all of
  its members, not only to its owners. That is its purpose — it is how
  colleagues know who someone is — and it says so where it is edited.
- "Last seen" is visible to colleagues. It is coarse (five minutes) and says
  only that somebody used Studio, not what they did.
- The photo URL is a capability URL (`/avatars/{user_id}/{digest}`); handing it
  to every member hands them that photo, which is the point of a photo.

## More Information

### What this does not decide

- Whether a member may see the organization's invitations. They stay behind
  `people.view`.
- A per-project team. On the `roles` model the team is the set of role grants on
  the project (ADR-0019), read through the access config as before.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md), [studio-user](../design/studio-user.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-entity-user-person`
* `cpt-studio-interface-user-rest`
* `cpt-studio-fr-org-administration`
