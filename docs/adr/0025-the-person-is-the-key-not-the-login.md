---
type: adr
status: proposed
date: 2026-09-10
---

# ADR-0025: The person is the key on the request path, not the login

**ID**: `cpt-studio-adr-the-person-is-the-key-not-the-login`

Status: **proposed** · Date: 2026-09-10 · Amends ADR-0023, ADR-0012

Renumbered from ADR-0014 (`studio-backend/docs/adr/`) when the two ADR trees were unified; ADR-0014 is document types as components.

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0023 gave Studio a canonical person (`user`), the sign-in methods that reach
it (`login`), the non-login identifiers attributed to it (`alias`) and per-org
role (`membership`). ADR-0012 made attribution self-service and made a provider's
proof of control the only thing that binds. Both are implemented.

Nothing uses them.

That is not a figure of speech. Empirically, before this ADR:

- `resolve_or_provision` was reachable from exactly two places — `GET/POST
  /studio-user/v1/me*` and the platform-admin `POST /studio-user/v1/resolve`. A
  person who never opened a profile screen had **no `user` row at all**.
- Every other Studio gear that records an actor reads `ctx.subject_id()` — the
  *sign-in method*, not the person: `connectors` (`created_by`), `documents`,
  `kit_registry` (`requested_by`), `studio_session`.
- `membership` is written only by its own admin route. The path that actually
  assigns a person to an organization (`identity_directory.assign`) writes a
  Keycloak `tenant_id` attribute instead, and the portal derives the organization
  list from that attribute plus child tenants — the single-home assumption
  ADR-0011 §1 ruled out.

So Studio carries three identifiers for one human — the Keycloak subject, the
`tenant_id`-bearing IdP projection, and the canonical `user_id` — and the one
designed to be canonical is the one nothing depends on, while the one everything
depends on is the one two prior ADRs already called wrong.

This has a concrete, present cost. `confirm_aliases_from_connections` compared
`connection.created_by` with `ctx.subject_id()`: **subject to subject**. A person
who signed up with e-mail and later added GitHub holds two logins and one `user`,
and the proof of control they left behind under the first login was invisible
from the second — the exact failure the canonical person exists to prevent,
inside the feature built to prevent it. The personal-connection edit guard in
`connectors::update` had the same shape and the same hole.

One constraint shapes the answer: `toolkit_security::SecurityContext` is closed.
It carries `subject_id`, `subject_type`, `subject_tenant_id`, `token_scopes` and
`bearer_token`, with no extension point, and the studio backend never owns the
axum `Router` — `toolkit::bootstrap::run_server` composes it, so there is no seam
for a global middleware that could attach a resolved person to a request.

## Considered Options

- **A global axum middleware that attaches the person to every request.** The
  natural shape, and not available: `toolkit::bootstrap::run_server` owns the
  router, and gears only contribute sub-routers in `register_rest`.
- **Extend `SecurityContext` now.** The correct end state (§4), but it forks a
  fast-moving `gears-rust main` and blocks in-repo progress on an upstream review
  cycle. The resolver reaches the same behaviour without the fork.
- **Re-key every subject-holding column to `user_id` in one migration.** Cleaner
  end state, but it rewrites four gears' storage at once for a change whose value
  is provable one call site at a time — and `resolve_recorded_subject` makes those
  columns readable as people without touching them.
- **Have each gear resolve the person itself from the `login` table.** Four copies
  of one rule is how a human ends up keyed four different ways; that is the defect
  being fixed, not a way to fix it.
- **Hold the resolver on `ConnectorService`.** `IdentityService` already holds a
  view of the connection catalogue for its confirmation ceremony, so owning each
  other makes the pair unconstructible in either order. The resolver is therefore
  *borrowed* into `update` (`Option<&dyn PersonResolver>`) rather than stored.

## Decision Outcome

**One resolver, published as an interface, and person-to-person comparison
wherever a person is what was meant.**

### 1. `PersonResolver` is the only way to turn a caller into a person

Published on the ClientHub by `studio-user` in its `init` (so it is resolvable
from any gear's REST phase), under the same scope key as `AliasResolver`:

```text
resolve_caller(&SecurityContext)  -> user_id          -- JIT-provisions
resolve_recorded_subject(&str)    -> Option<user_id>   -- never provisions
```

It takes a `SecurityContext`, not a subject string, on purpose: a gear can
resolve **its own caller** and nobody else. Looking up other people stays a REST
operation behind its own authority gate, so this cannot quietly become a
directory.

`resolve_caller` provisions, and that is safe: the subject comes off a bearer the
platform has already authenticated. This is the same act `/me` performed, now
available to every gear instead of only to the profile screen. `/me`'s own helper
calls it, so there is one implementation of the rule rather than two.

`resolve_recorded_subject` deliberately does **not** provision. Its argument is a
subject read out of storage, which nobody has authenticated; minting a person for
one would invent people out of stale rows. It is the migration seam: a column
holding a token subject can be *read as a person* without being rewritten.

### 2. Ownership is compared between people

The confirmation ceremony and the personal-connection edit guard both resolve the
recorded subject to a person before comparing. A proof left under one of your own
logins is yours under all of them.

The three-way outcome is a pure function (`alias_policy::proof_owner`), stated as
tests rather than discovered in production, like the rest of that module:

| `created_by` | outcome |
|---|---|
| resolves to the caller's person | recorded |
| resolves to another person | skipped — theirs to record |
| empty, or a subject no `login` knows | skipped as unknown, never guessed |

A subject no `login` row knows cannot be another of the caller's own logins — the
caller resolved to a person to get here, so their own login exists. Reading it as
`Unknown` rather than as `AnotherPerson` is both truthful and the safe direction.

### 3. Consumers migrate one at a time, and the fallback is the strict one

`created_by` keeps storing a subject. Nothing is re-keyed, no migration runs, and
a deployment where `studio-user` is inert (no database) keeps working: the guard
then compares sign-in methods exactly as before. That fallback can refuse an edit
the person should have been allowed; it can never allow one they should not.

This ADR migrates the two call sites where the confusion was a security hole.
`documents`, `kit_registry` and `studio_session` record an actor for display and
audit, and are migrated when each is next touched.

### 4. `SecurityContext.person_id` is the end state, and an upstream ask

The right place for the resolved person is beside the subject in the security
context, resolved once at the authentication edge instead of per consumer. That
is a gears-rust change (`toolkit-security`, plus the authn-resolver plugin
contract), so it is named here as the target rather than blocked on: when it
lands, `PersonResolver` becomes a lookup at the edge and the consumers already
speak in `user_id`.

### Consequences

- (+) A proof of control, and the right to edit the connection that carries it,
  follow the human rather than the sign-in method. This is the first behaviour in
  the product that actually distinguishes the two.
- (+) One implementation of "who is calling, as a person"; the next gear that
  needs it asks the hub instead of reinventing it.
- (−) `resolve_caller` is an indexed `SELECT` per call, uncached. Fine at the
  present call rate and wrong at scale: a request-scoped cache belongs with the
  `SecurityContext` change in §4, not in a per-consumer memo.
- (−) A person still has no `user` row until something on their path resolves
  them. Provisioning at the authentication edge (ADR-0023 follow-up 4) remains the
  only complete fix.
- (−) Three person-spaces still exist. This ADR makes the canonical one
  load-bearing; retiring the Keycloak `tenant_id` attribute in favour of
  `membership` is the next step and is not done here.

## More Information

### Follow-ups

1. **`membership` becomes the organization authority.** Half done — **ADR-0016**
   gives the table a writer on the real assignment path plus a backfill for
   history. Still outstanding: the portal reading `/me/memberships` instead of
   `me.subject_tenant_id` plus child tenants (which needs the ADR-0011 §3
   no-membership state, absent from the frontend), and removing the `tenant_id`
   attribute (ADR-0011 §1, Phase 0 item 1).
2. ~~**`federated_identities` as a login source.**~~ **Done — ADR-0015.** The
   premise stated here was wrong in a way worth recording: `identity_directory`
   did not "already read them". Keycloak ships no `federatedIdentities` key on a
   user representation at all, so the deserialization was dead and
   `DirectoryIdentity.identity_provider` had always been `None`. The data is only
   behind a dedicated per-user endpoint. ADR-0015 wires it as a second proof
   channel for the alias ceremony and fixes the empty column.
3. ~~**PDP dual-key match**~~ **Done — ADR-0040 §5.** A grant names the person;
   every matcher uses `grant_keys_of` (person id, then the person's logins), and
   `POST /studio-user/v1/grants/backfill` rekeys the old grants.
4. **`SecurityContext.person_id` upstream**, per §4.
5. **Migrate the remaining actor columns** (`documents`, `kit_registry`,
   `studio_session`) as each is next touched — the full list is in ADR-0040
   FU2 (`reports`, `domain_model`, `scheduler`, `tasks`, presence too).
6. **Naming.** The module is `user_profile` but owns logins, memberships and
   aliases; the IdP projection occupies `/studio-identity/v1` while the canonical
   gear sits at `/studio-user/v1`. Rename to `studio_user` and
   `/studio-idp-directory/v1` — cheap, and the current pair makes the system hard
   to discuss.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-user`
* `cpt-studio-fr-canonical-user`
