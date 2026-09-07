# ADR-0012: Attributing an external identity is self-service, and only a proof of control binds

Status: **proposed** · Date: 2026-09-07 · Amends ADR-0006

## Context

ADR-0006 gave Studio a canonical `user` and, with `alias`, an owner for
`external (kind, id) → user`. It left attribution a **platform-admin** act:
`POST /studio-user/v1/users/{user_id}/aliases`, no self-service route.

That is the wrong hand on the lever. Nobody but the person knows which GitLab
account is theirs, and the person is the party with the interest in getting it
right. An operator can only guess, and at Studio's scale there is no operator to
do the guessing anyway.

Two more things were missing, and they turn out to be the same problem:

**Nothing proved control.** ADR-0006 committed to "verified-only auto-link" for
`login`, but said nothing about where a *verified* GitHub account comes from. A
commit author address cannot supply it — that is whatever the committer put in
`git config user.email`, unauthenticated and trivially spoofed. Under a rule that
lets an address bind, spoofing one is enough to be credited with someone's work.

**The write was unguarded.** `identity_alias`'s primary key is the v5 UUID of
`(kind, external_id)`, so `add_alias` did not append — it *repointed*. A second
caller writing the same external identity silently moved it off the first user,
`confirmed` rows included. Safe only because the route was admin-only; an
account-takeover primitive the moment it is not. And `confidence` was coerced:
anything that was not `"confirmed"` became `"suggested"`, so a typo'd `confirmd`
turned into a hypothesis with nobody told.

## Decision

### 1. Three confidences, and only the strongest attributes anything

| confidence | meaning | attributes? |
|---|---|---|
| `confirmed` | the provider confirmed the person controls the account | **yes** |
| `claimed` | the person says it is theirs, unproven | no |
| `suggested` | the system noticed a similarity | no |

`claimed` is new. ADR-0006 had only `confirmed | suggested`, which left nowhere
to put "this is mine, I cannot prove it yet" — the state a person is in before
they add a credential. It records intent and grants nothing.

An unrecognised confidence is now a 400, not a silent downgrade.

### 2. The proof of control already existed and was being discarded

`ConnectorDriver::test()` asks a provider "who am I?" using **the caller's own
credential** and returns the account it resolved to — `github.rs`, `gitlab.rs`,
`bitbucket.rs`. A PAT is issued by the account it authenticates as, so a
successful `test()` is a proof of control, and a stronger one than any operator
assertion. `studio-connector` already stored the answer in `Connection.account`.

What was missing is that the connection record did not name the **person**:
it carried `owner_tenant_id` and no `created_by`. So a verified
`(provider, account)` pair sat in the catalogue with nothing to attach it to.
With `created_by`, `POST /studio-user/v1/me/aliases/confirm` records the proof —
no token is read and nothing is re-probed.

Only a `personal` connection counts. A `workspace`- or `organization`-scoped one
is a team or bot credential: it proves control of *an* account, not of the
caller's own, and is skipped. So is a connection whose creator is unknown (a row
written before `created_by`): there is a proof, but nothing says whose, and
guessing is the failure this whole design exists to avoid.

Keycloak `federated_identities` — already read by `identity_directory` — is a
second proof channel for whichever providers the realm brokers. Not wired here.

### 3. Only a proof displaces somebody else

One row per external identity means a write is a contest, not an append. The
rule, whole:

- unattributed → the first assertion takes it;
- your own row → you may raise your confidence (`claimed` → `confirmed`), an
  identical write is a no-op, and you may not lower it (that would discard your
  own proof);
- somebody else's row → **only `confirmed` takes it**; the one exception is a
  machine's `suggested`, which yields to any human assertion, because a
  hypothesis must never stand between a person and their own account.

Two `confirmed` writes on one identity mean a shared or stolen credential. The
most recent proof wins — nothing blocks — and the displacement is reported
(`written_over_a_proof`) rather than happening silently.

### 4. Attribution flows to the graph from `confirmed` only

`connectors/graph_sync` keyed person nodes `person:{login}` — no provider in the
key, so a GitHub `alice` and a GitLab `alice` were one node, and no node reached
a Studio user. Now: `person:studio:{user_id}` when the identity is confirmed, so
one human is one node across providers; `person:{provider}:{login}` otherwise.

The resolver handed to the graph returns confirmed rows *only*. A claim or a
suggestion must not be readable as an attribution, and the narrow interface is
what makes that true by construction rather than by remembering to filter.

## What this changes in ADR-0006

- alias attribution becomes self-service (`/me/aliases`); the admin route stays
  but goes through the same policy — an admin writing on somebody's behalf must
  not be able to take a proven identity either;
- `confidence` gains `claimed`;
- `IdentityStore` gains `find_alias` / `find_aliases` / `delete_alias`. There was
  no way to ask who holds an external identity at all — only what a given user
  holds — so neither the policy nor graph attribution was expressible;
- editing a `personal` connection is restricted to its creator. The record is now
  evidence, and rotating a token re-stamps `Connection.account` while
  `created_by` stays put; without that guard a tenant member could point somebody
  else's personal connection at an account of their choosing and have the
  confirmation recorded against that person.

Everything else in ADR-0006 stands: the canonical `user` is the person, `login`
is a way in, `membership` carries per-org role, storage is relational, merge is
first-class.

## What was rejected

A separate `studio-identity` gear with its own append-only journal, tenant-scoped
and keyed on the Keycloak subject. It was written first, before ADR-0006 was
found, and it is not in this PR. Two gears owning the same mapping and two
different person identifiers is worse than one, and ADR-0006's canonical
`user_id` is the better anchor: it survives an IdP migration, which a Keycloak
subject does not.

Its journal did buy one thing this does not have: several people could hold a
pending claim on one identity at once, and resolution decided between them. Under
one row per identity the second claimant is refused instead, and told to prove
control. Simpler, strictly safer, and it tells the person something actionable
immediately.

## Consequences

- (+) The person with the knowledge and the interest does the work; no operator
  queue on the main path.
- (+) The strongest evidence available (provider-confirmed control) replaces the
  weakest (an unauthenticated commit header).
- (+) The knowledge graph gets one person node per human across providers.
- (+) The unguarded repoint in `add_alias` is closed on both routes.
- (−) Attribution is incomplete until people claim and prove. Historic commits
  from unproven accounts stay unattributed rather than guessed at — the trade.
- (−) Changing the graph person key orphans existing `person:{login}` nodes; they
  are re-created under the new key on the next sync and the old ones need a
  one-off sweep.
- (−) A displaced proof is reported in the response and nowhere else. There is no
  admin view for it yet.

## Follow-ups

1. **Suggestion sources.** Nothing writes `suggested` yet: the value exists,
   resolves and renders, but the only ways onto a person's list are `claim` and
   `confirm`. The sources to add — commit author addresses from the graph,
   Keycloak e-mail, `federated_identities`, login equality across providers.
2. `federated_identities` as a second proof channel, alongside the connector PAT.
3. An admin view for displaced proofs and for identities two people contest.
4. Sweep the orphaned `person:{login}` graph nodes.
5. Two confirmed identities of one person contributing to the same repository
   collapse onto one node, so their two `contributed_to` edges collide on
   `(src, dst)` and the commit count of whichever lands last wins. Needs an edge
   discriminator or a summed count.
