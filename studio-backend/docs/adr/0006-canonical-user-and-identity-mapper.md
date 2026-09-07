# ADR-0006: A canonical Studio user, its sign-in methods, and the identity mapper

Status: **proposed** · Date: 2026-09-04 · Deciders: Studio backend team

## Context

Studio is a cloud, multi-tenant product. Two facts drive this decision:

1. **One person holds different roles in different organizations.** Role is a
   property of *membership in an organization*, not of the person.
2. **Keycloak (the IdP) is not enough to be the person.** The IdP authenticates
   and owns credentials, but it cannot be the home for: a Studio-owned profile
   we control; a person identifier that survives an IdP migration or a change of
   login method; one person reached through several sign-in methods; or
   attribution of *non-login* identifiers (a commit author, a chat handle, an
   external system's user id) to a person.

ADR-0001 (`identity-mapping`) already saw the attribution need and proposed a
`studio-identity` gear that stored **links, not people** — `external (system,
ref) → platform_user_id`, keeping the person in the IdP. Since then the product
decision has moved: we do want a person entity *inside* Studio. This ADR extends
ADR-0001 rather than replacing its intent — the link concept survives as the
`alias` below, but it now points at a Studio-owned user instead of a raw
IdP-issued UUID.

Today, empirically (see `identity_directory` and `studio_authz_plugin`):

- Account Management's user surface is an IdP-backed projection; it owns no user
  entity.
- The authorization PDP keys grants directly on the token subject (the IdP
  identity id): `grant.subjectId == subject`.
- A single `tenant_id` attribute on the identity encodes one *home* org — a
  single-home assumption a multi-org product must outgrow.

## Decision

Introduce a Studio domain gear **`studio-user`** that owns the canonical person
and maps identities onto it. The records below are relational (see *Storage*);
the same shapes project into the graph when a visualization/attribution need is
real. Conceptually:

```text
user   (gts.cf.studio.identity.user.v1~)   -- the person + profile, ROLE-FREE.
                                               Studio-owned id (uuid v4),
                                               independent of any IdP.
login  (gts.cf.studio.identity.login.v1~)  -- (provider, subject) -> user.
                                               A way to sign in. One user, many.
alias  (gts.cf.studio.identity.alias.v1~)  -- (kind, external_id) -> user.
                                               A NON-login identifier attributed
                                               to a user; confidence confirmed |
                                               suggested (this realizes ADR-0001).
membership (gts.cf.studio.identity.membership.v1~)
                                            -- (user, org) -> role held THERE.
                                               One person, many memberships; this
                                               is where per-org role lives.
```

Edges `has_login`, `has_alias` and `has_membership` connect a user to its
identities and organization memberships.

The **identity mapper** is the gear's service: `resolve(provider, subject) ->
user_id`, provisioning a user the first time an identity is seen (JIT). Profile
CRUD is self-service at `/studio-user/v1/me*`; alias attribution and merge are
platform-admin. Storage is the graph-storage gear (in-memory fallback when the
`graph` feature is off), reached under a root-scoped context derived from the
caller.

### What we deliberately settled

- **Role never lives in the profile.** It is a property of organization
  membership. The existing tenant grants already hold role per-org; we do not
  move them.
- **Keycloak stays the authenticator.** `studio-user` owns *who the person is*
  (profile, links, and — later — the authorization anchor), not credentials. For
  "one human, several logins", Keycloak's own account linking still applies; a
  linked Keycloak user is simply one `login` from our side.
- **Non-breaking PDP path (incremental).** We do NOT re-key the grant model now.
  The mapper resolves `subject -> user_id` at the edge and carries it beside the
  existing subject id; grants move to `user_id` later, lane by lane. (Phase 2.)
- **Verified-only auto-link.** A new login auto-links to an existing user only
  when its email is verified by a trusted IdP; otherwise linking is an explicit,
  confirmed action. Auto-linking on an unverified email is an account-takeover
  vector and is refused.
- **Merge is first-class.** Two users found to be one person are merged: every
  login and alias is repointed and the source is tombstoned with a `merged_into`
  pointer that reads follow. Without merge the graph grows duplicates (same
  human, two IdPs Keycloak never linked).
- **`suggested` aliases grant nothing.** A heuristic attribution is a hypothesis,
  shown as such; only `confirmed` is trusted.
- **Cross-tenant privacy / PII.** The person is global, so the full profile is
  visible only to the person and platform admins; an organization sees only a
  projection for its own membership. Deletion (right-to-be-forgotten) erases the
  profile and anonymizes link/alias edges rather than breaking history.

## Options considered

- **Lean only on Keycloak account linking.** Solves "many logins, one account"
  but cannot own a cross-tenant profile, a stable-across-IdP id, or non-login
  attribution. Insufficient for the product need.
- **Extend `identity_directory`.** That gear is a read-only admin projection over
  Keycloak plus an assign-to-org writer; it assumes identity == actor. Wrong
  shape for owning a person.
- **Re-key the whole PDP to `user_id` now (big-bang).** Cleaner end state but
  rewrites the grant model, AM's group/attribute conventions, and every existing
  grant at once. Rejected in favor of the incremental path.

## Consequences

- (+) One owner for the person; connectors and graph attribution resolve to a
  single, stable Studio id; ADR-0001's mapping need is met by `alias`.
- (+) Profile and attribution work immediately without touching the PDP or the
  token.
- (−) One more gear to operate. Provisioning has a first-touch race (two
  simultaneous first logins could mint two users) that merge repairs; acceptable
  for now, to be hardened.
- (−) The single-home `tenant_id` assumption and the PDP grant keys still stand;
  they are addressed in Phase 2, not here.

## Storage: relational is the system of record, graph is a projection

Decision (revised): the canonical records — `user`, `login`, `membership`,
`alias` — are **relational tables owned by the gear**, not generic graph nodes.
The rule we hold: *the graph holds what we need to visualize and find paths
through*; a person's account record is looked up and constrained, not traversed.
Modeling it as typed JSON nodes loses exactly what this data needs — columns,
indexes, unique constraints, foreign keys, transactions — and the prototype
shows the cost directly: `list_logins` / `list_memberships` are full type scans,
and uniqueness is faked with deterministic uuid5 keys instead of a real
`UNIQUE`.

So:

- **Relational (SeaORM, the gear owns its own database — the `credstore_pg` /
  `DatabaseCapability` pattern):** system of record.
- **Graph:** a *derived projection* of the identity map (person ⇄ external
  identities and memberships), built when the visualization / connector-
  attribution use case is real. It references the relational `user_id`; it is
  never the source of truth.

### Schema (v0.1)

```text
identity_user
  id            uuid  PRIMARY KEY            -- Studio-owned, IdP-independent
  display_name  text  NULL
  email         text  NULL
  avatar_url    text  NULL
  locale        text  NULL
  merged_into   uuid  NULL  -> identity_user(id)
  created_at / updated_at  timestamptz

identity_login
  id            uuid  PRIMARY KEY
  provider      text  NOT NULL
  subject       text  NOT NULL
  user_id       uuid  NOT NULL -> identity_user(id)
  verified      bool  NOT NULL default false
  linked_at     timestamptz
  UNIQUE (provider, subject)                 -- the resolve hot path
  INDEX (user_id)

identity_membership
  id            uuid  PRIMARY KEY
  user_id       uuid  NOT NULL -> identity_user(id)
  org_id        uuid  NOT NULL                -- AM tenant id
  role          text  NOT NULL
  source        text  NOT NULL                -- assignment | grant | manual
  created_at / updated_at  timestamptz
  UNIQUE (user_id, org_id)
  INDEX (org_id)                             -- "who is in this org"

identity_alias
  id            uuid  PRIMARY KEY
  kind          text  NOT NULL                -- github | slack | ...
  external_id   text  NOT NULL
  user_id       uuid  NOT NULL -> identity_user(id)
  confidence    text  NOT NULL                -- confirmed | suggested
  added_at      timestamptz
  UNIQUE (kind, external_id)
```

The service API (`resolve`, profile, membership ops, merge) is unchanged — only
the storage trait behind it moves from `IdentitySink` (node/edge) to a typed
`IdentityStore` repository with a `PgStore` (SeaORM) and a `MemoryStore` for the
graph-less/test path. Resolve becomes an indexed `SELECT … WHERE provider=? AND
subject=?`; the full scans disappear; uniqueness and FK integrity become real.

## Implementation status

- **Phase 1 (done):** `user` / `login` / `alias`, the mapper (`resolve` + JIT
  provisioning), self-service profile, and admin alias + merge.
- **Phase 2 (done here):** `membership` as a first-class node with per-org role,
  self and admin read (`/me/memberships`, `/users/{id}/memberships`) and admin
  write/remove (`PUT`/`DELETE …/memberships/{org_id}`); a `resolve` endpoint for
  the authentication edge and tooling. Merge moves memberships too.
- **Not yet wired (needs a compiler in the loop):** automatic population of
  memberships from the real assignment path, and the PDP change — see below.

## Follow-ups (remaining)

1. **Populate memberships from the real assignment path.** When an identity is
   assigned to an org (`identity_directory.assign`, or the portal's People
   screen), also `resolve` the canonical user and record the membership. Options:
   the portal calls `PUT …/memberships/{org}` after assignment (no backend
   coupling), or `studio-user` publishes an SDK client that `identity_directory`
   depends on and calls in-process. The second needs gear-lifecycle care (the
   graph store resolves in the REST phase), so land it against a compiler.
2. **PDP dual-key match (non-breaking).** Today `studio_authz_plugin` matches
   grants by the IdP subject id, and `privilege_for` maps no Studio resource yet
   (the role path is dormant). When the first Studio resource is role-mapped,
   resolve `subject -> user_id` via the mapper and match a grant whose
   `subjectId` is EITHER the subject or the `user_id` — old grants keep working,
   new `user_id`-keyed grants start working. This is gated on there being a
   mapped resource, so it is deliberately not written blind.
3. **Active-organization context.** Carry the person in the token and make the
   active org a session context the PDP clamps to, replacing the single-home
   `tenant_id` assumption.
4. **Provisioning at the authn edge** (authn-resolver plugin) so `/me` is not the
   only path that mints a user; feed `identity_directory`'s unassigned view from
   unmapped identities. The `resolve` endpoint is the seam for this.
