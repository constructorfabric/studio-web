# What Studio needs from account-management

*From the Studio backend team, 2026-09-14. Against `cf-gears-account-management`
0.7.2 (rev `719ab47`), which is what we run, read against `main` at `5cd9446`.*

We keep Studio's access config — the document naming an organization's owners
and the roles its members hold — in AM tenant metadata, under
`gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~`. It is what our
PDP evaluates to answer every administrative question.

That turned out to be a place an authority document cannot safely live, and the
reason is structural rather than a bug in AM. This is one request with a small
second one behind it.

Nothing here is a bug report. DESIGN already describes the model we want — the
"Metadata steward" row says per-schema grants are explicit and there is "no
implicit access to all metadata schemas", and `TYPE_ID` is passed on every
authorize call precisely so a PDP can decide per schema. AM does its part. What
is missing is the one thing that makes using it possible.

---

## 1. Let a PDP read the document it decides with, without deciding first

**Today.** Every tenant-metadata read is PEP-gated. A PDP whose own policy lives
in AM metadata must read that policy to answer a request — and the read is
itself a request, which comes back to the PDP. There is no service-identity or
internal read path that skips the round trip.

The only way out is to make the schema's family un-gated: answer any request
about it from the request alone, without reading anything. That is what we do —
`gts.cf.core.am.tenant.v1`, `…tenant_metadata.v1` and `…tenant_type.v1` are
short-circuited to the tenant clamp in our PDP, with a comment explaining the
recursion.

**Why that hurt.** The escape applies to the whole family and to every action.
The tenant clamp answers "is this caller inside this tenant", and every member
of an organization is. So any member could `PUT` the access config with an owner
grant naming themselves, and then administer and delete the organization. We
reproduced it on a stand: one write turned 403s into 200s, up to and including
`DELETE` of the organization, which takes every membership and every member's
personal connections with it.

The document that decides who is an owner was protected by nothing stronger than
"you are in the tenant", *because* it lives where deciding requires reading.

**What we did instead.** Split the escape by action. Reads keep the guard — the
recursion is real and deciding who may read this document does mean reading it.
Writes do not have that problem: the decision reads the document, and that read
is still clamped, so it terminates. Writes to this one `type_id` are now decided
by ownership read out of the document itself, with two openings (a document that
does not exist yet, which is an organization being created; and a document
nobody owns, which ownership cannot gate).

It works and it is a rule about one specific document sitting inside a
general-purpose PDP. Everyone who stores an authority document in tenant
metadata will write this rule, and will get it wrong the same way we did on the
first attempt: we passed the caller's tenant as the tenant whose ownership to
check, which on this request is the person's home tenant rather than the
organization being written — so the barrier read the platform root's config,
found none, took the "does not exist yet" opening and allowed the write. The
attack still returned 200 with the barrier in place. Only a probe on the live
request showed it.

**What we need.** A way for a gear to read its own policy document without that
read being a policy decision. Either of:

- a read path authenticated by the gear's service identity that does not consult
  the PDP; or
- a schema trait — "policy source" — that AM serves to the registered PDP
  out-of-band, the way `inheritance_policy` is already a per-schema trait the
  registry resolves.

Then the recursion disappears, the family-wide escape can go, and the schema is
gated by ordinary per-schema policy — which is what the "Metadata steward" row
already describes and what `TYPE_ID` already makes expressible.

**How we would know it works.** Our PDP reads the access config through that
path and drops the recursion guard for the schema. A member's write to
`…cf.studio.access.config.v1~` is then refused by ordinary `Metadata.write`
policy on that `SCHEMA_ID`, not by a special case in our code, and a
non-member's read is refused the same way.

---

## 2. Let a schema say that only one gear may write it

**Today.** Any caller the policy admits can write any schema through
`PUT /tenants/{id}/metadata/{type_id}`. A schema has an inheritance policy and a
validation schema; it has no owner.

**Why that matters here.** Studio's access config has exactly one writer in our
assembly — `set_owner_grant`, which writes the tenant, the membership and the
grant as one ordered operation. Our portal writing the same document directly is
what made the hole above reachable at all, and it is also how the document
acquired a role ladder that disagreed with the one the backend seeds.

A document with one writer and an invariant across three stores should not be
reachable through a generic route. Per-caller policy is the wrong instrument for
it: the answer is not "which people may write this" but "nobody, except the gear
that owns it".

**What we need.** A schema trait binding a metadata schema to an owning gear's
service identity: writes through the generic route are refused for everyone, and
the owning gear writes through the same route under its own identity. Reads stay
governed by ordinary policy.

**How we would know it works.** The portal's direct `PUT` of the access config
is refused with the schema's owner named, and the only writes that land are the
ones `set_owner_grant` makes.

---

## What we are not asking for

- **A change to how `TYPE_ID` is passed.** It is already on every authorize
  call, already carries the chained id, and is exactly what a per-schema
  decision needs. The gap is that we cannot *use* it for this schema, not that
  it is missing.
- **A Studio-specific concept anywhere in AM.** Both requests are about metadata
  schemas in general; the access config is only the first document we have that
  is an authority rather than a preference.
- **Removing the recursion guard for us.** It is correct. We want the reason for
  it to stop existing.

## Summary

| | What | Why |
| --- | --- | --- |
| 1 | A non-recursive read path for a PDP's own policy document | Without it the schema must be exempt from policy, and an exemption that covers writes is a privilege escalation |
| 2 | A schema trait naming its owning gear | A document with one writer and a cross-store invariant should not be reachable through a generic route |

The first is the one that matters. The second would have prevented the same
incident by a different road, and it is smaller.
