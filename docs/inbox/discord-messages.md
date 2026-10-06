# Discord messages for the gears team (ready to paste)

Tone: "first adopter, we may well be holding it wrong — please correct us". Each
message fits Discord's 2000-char limit. Post as a thread: #1 opens, #2–5 one per topic.

---

## Message 1 — opener

Hey team! We're building the Constructor Studio backend on gears-rust — our own server
assembled after `cf-gears-example-server` (13 gears: gateway, static authn/authz,
types-registry, tenant-resolver, resource-group, **account-management** + static-idp).
We ran the full scenario end-to-end: platform bootstrap → our own tenant types via GTS
→ org/workspace with the parent-type barrier → users through the IdP contract → user
groups in RG → dual-consent conversion to self-managed → tenant metadata. Works on both
SQLite and Postgres profiles, with a React portal running on top. Overall impression is
great — we got the entire tenancy layer without writing a single line of our own Rust 👍

Along the way we hit 4 rough spots. **We fully accept some of these may be us using
things wrong rather than bugs** — we'd appreciate a pointer to the right way. One
message per topic below, with logs and what we tried. Our assembly is in
studio-web/studio-backend and every item reproduces deterministically — happy to share
code/config or hop on a call for a live demo.

---

## Message 2 — types-registry: can't see WHY a static entity fails to register

**Context:** we seed our GTS types via `types-registry.config.entities`. On failure the
log only says:

```
ERROR types_registry::gear: Failed to register static GTS entity
  gts_id="gts.cf.core.am.tenant_type.v1~cf.studio.organization.v1~"
  error=invalid_argument: Request validation failed
```

The actual cause (in our case: a 4-part GTS segment — `cf.studio.organization.v1`,
missing the namespace) lives in `InvalidArgument::FieldViolations`, but `Display`
collapses it to that fixed string (`toolkit-canonical-errors/src/error.rs:154`), and
the gear logs `error = %error`. We ended up diagnosing it by reading gts-id sources.

**Question/proposal:** could the static-entity loop (and `ReadyCommitFailed` handling)
log the field violations in full? Or is there a log level/flag we missed?

---

## Message 3 — account-management: OpenAPI artifact paths vs actual routes

**Context:** we generated a client from `docs/account-management-v1.yaml` — every call
404'd. The artifact declares `/api/account-management/v1/...`, the code registers
routes without `/api`: `src/api/rest/routes/me.rs:17` → `/account-management/v1/me`.
Behind the gateway (`prefix_path: /cf`) the real URL is
`/cf/account-management/v1/...`. The served OpenAPI at `/cf/docs` is correct — only the
committed artifact drifts.

**Question/proposal:** is the artifact meant to be a source of truth or just docs? If
the latter, maybe regenerate it from the served spec + add a diff check to the
`api_contracts` workflow? We're happy to send a PR.

---

## Message 4 — PRD §5.6: which resource_type for user-group membership?

**Context:** PRD §5.6 says `allowed_memberships` must include the platform user
resource type `gts.cf.core.am.user.v1~`. Doing exactly that:

```
POST /resource-group/v1/memberships/{group}/gts.cf.core.am.user.v1~/{user}
→ 400 invalid_argument
```

With the member-handle type `gts.cf.core.rg.type.v1~cf.core.am.user.v1~`
(`account-management-sdk/src/gts.rs:99`, `USER_RG_TYPE_CODE`) it works — verified live.
Looks like the code is right and the PRD lags behind.

**Question/proposal:** please confirm the member-handle is the intended type, and fix
§5.6 (and the description in `docs/schemas/user_group.v1.schema.json` if it repeats the
bare id).

---

## Message 5 — MAIN question: how do we declare a TYPED tenant-metadata schema?

**Context:** we want "Studio workspace settings" as a derived metadata schema — PRD
§5.7 promises GTS-validated payloads ("branding, contacts" as examples). We could not
register a typed schema **any way we tried**:

Attempt 1 — `$schema: draft-07` + properties:

```
Schema '...workspace.settings.v1~' is not compatible with base
'gts.cf.core.am.tenant_metadata.v1~': property 'automation_level': derived schema
adds new property but base has additionalProperties: false
```

(the base is an empty envelope with no properties; OP#12 treats it as closed → a
derived schema may not add a single field)

Attempt 2 — `$schema: "gts://gts.cf.core.am.tenant_metadata.v1~"` (the convention
mentioned in the `metadata_schema_registry.rs` comments):

```
failed to compile trait schema: Unknown meta-schema:
'gts://gts.cf.core.am.tenant_metadata.v1~'. Custom meta-schemas must be registered...
```

We're currently shipping a free-form `type: object` (shape validated client-side), but
that defeats the feature. **What's the intended way?** If there isn't one yet, two
ideas: relax the base envelope (`additionalProperties: true` at the payload level,
traits staying strict) or exempt `x-gts-abstract` envelope bases from
property-narrowing in OP#12 — plus a working example in the docs. Repro: one entry in
`types-registry.config.entities` → `switch_to_ready` fails
(`post-init failed for gear 'types-registry'`).
