# Bug report — ready to file on constructorfabric/gears-rust

**Title:** `GTS/AM: typed derived tenant-metadata schemas cannot be registered — OP#12 treats the base envelope as a closed empty object`

**Labels (suggested):** bug, types-registry, account-management

---

## Summary

AM's extensible tenant metadata (AM PRD §5.7) is designed around GTS-registered derived
schemas with validated payloads ("branding, contacts" as the PRD's examples). In
practice, a derived metadata schema that declares **any** typed property cannot be
registered: both documented/plausible authoring conventions fail, so the only
registrable derived schema is a free-form `type: object` — which defeats the
"GTS-validated payload" feature. Confirmed as "looks like a bug" by Diffora on
Discord (2026-07-29).

## Environment

- gears-rust `main` @ `71218154` (2026-07-29), also reproduced on the previous release
- assembly: cf-gears-example-server-style build (20 gears), SQLite and Postgres profiles
- entity seeded via `types-registry.config.entities`

## Reproduction

Add one entity to `types-registry.config.entities`:

```yaml
- "$id": "gts://gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~"
  "$schema": "http://json-schema.org/draft-07/schema#"
  type: "object"
  properties:
    automation_level:
      type: "string"
      enum: ["manual", "recommendations", "autonomous"]
  x-gts-traits:
    inheritance_policy: "override_only"
```

Start the server → `switch_to_ready` fails, gear init aborts:

```
ERROR types_registry::gear: GTS validation error
  gts_id=gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~
  Schema '...workspace.settings.v1~' is not compatible with base
  'gts.cf.core.am.tenant_metadata.v1~': property 'automation_level': derived schema
  adds new property but base 'gts.cf.core.am.tenant_metadata.v1~' has
  additionalProperties: false
Error: post-init failed for gear 'types-registry'
Caused by: Failed to switch to ready mode: Ready commit failed with 1 errors
```

The base envelope (`gears/system/account-management/docs/schemas/tenant_metadata.v1.schema.json`)
declares no `properties` and no top-level `additionalProperties`; the OP#12 narrowing
check treats it as a **closed empty object**, so no derived schema may add a single
payload field.

**Attempt 2** — the convention referenced in AM's `metadata_schema_registry.rs`
comments ("derived metadata schemas carry `$schema: gts://gts.cf.core.am.tenant_metadata.v1~`"):

```
GTS validation error ... trait validation failed: failed to compile trait schema:
Unknown meta-schema: 'gts://gts.cf.core.am.tenant_metadata.v1~'. Custom meta-schemas
must be registered in the registry before use
```

i.e. the convention AM's own comments describe is not supported by types-registry.

## Expected

A documented, working way to register a derived tenant-metadata schema with typed,
validated payload properties — as promised by AM PRD §5.7 / FR "extensible tenant
metadata".

## Actual

Every typed derived schema is rejected at registration; only free-form
`type: object` (no payload validation) registers.

## Root cause (narrowed down while preparing the fix)

The envelope reaches types-registry with an **explicit** `additionalProperties:
false`: the upstream gts-macros emitter closes every generated object
unconditionally, and its attribute surface offers no override (a
`#[schemars(extend("additionalProperties" = true))]` on the struct is overwritten by
the emitter — verified by test). OP#12 itself is fine: it honours an explicit
`additionalProperties: true` (verified by an integration test registering a typed
derived schema under an open envelope).

## Recommended fix

**Relax the base envelope**: add `additionalProperties: true` at the payload level of
`gts.cf.core.am.tenant_metadata.v1~` (the `x-gts-traits-schema` stays strict).
Rationale:

- data-only, one-line change in a schema AM itself owns — no OP#12/gts-crate changes,
  smallest blast radius (the narrowing rule stays correct for regular schemas);
- semantically right: the base is an *envelope* — payload shape is the derived
  schema's job, and it IS enforced at `PUT .../metadata/{type_id}` by
  `metadata_schema_registry` compiling the derived schema;
- unblocks PRD §5.7 immediately for every adopter.

Alternatives considered: exempting `x-gts-abstract` envelope bases from
property-narrowing in OP#12 (systemic, but touches the gts crate and every chain
check), or supporting the `gts://` chain `$schema` from AM's comments (largest
change). Either could follow later; the envelope relaxation doesn't preclude them.

Plus a working authoring example in the docs.

## Offer → Fix PR ready

We've implemented the fix (all tests green): a wrapper-only
`gts_type_schema(open_payload = true)` argument in toolkit-gts-macros that opens the
schema root in the inventory `schema_fn`, applied to `TenantMetadataEnvelopeV1`, with
a types-registry integration test and an SDK inventory/docs sync guard.
PR: #<link>. Our 20-gear Studio integration serves as the verification bed — we
currently ship the free-form workaround with client-side validation and will switch
back to typed schemas the moment this lands.

---

**Как завести (после ответа команды «где»):**

```bash
gh issue create --repo constructorfabric/gears-rust \
  --title "GTS/AM: typed derived tenant-metadata schemas cannot be registered — OP#12 treats the base envelope as a closed empty object" \
  --body-file docs/inbox/bug-report-metadata-schemas.md   # секцию до '---'
```
