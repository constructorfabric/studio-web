# PR #2 — fix for the typed tenant-metadata bug (TESTS GREEN — ready to open)

**Branch:** `fix/typed-tenant-metadata-envelope` (fork, commit `3c19809d`, based on upstream main — independent of PR #1)
**Title:** `fix(account-management): open the tenant-metadata envelope payload so typed derived schemas can register`

Local verification done (2026-07-30): toolkit-gts(+macros), account-management-sdk and
the new types-registry integration test — all green.

## Body (их шаблон)

### Description

The `gts.cf.core.am.tenant_metadata.v1~` envelope reached types-registry with
`additionalProperties: false`: the upstream gts-macros emitter closes the generated
object unconditionally, and its attribute surface offers no override (a
`#[schemars(extend(...))]` on the struct is overwritten by the emitter — we tried).
The OP#12 chain-narrowing check therefore rejected **any** derived metadata schema
declaring a typed payload property (`switch_to_ready` fails, gear init aborts). That
made the PRD §5.7 promise — "extensible tenant metadata with GTS-validated payloads
(branding, contacts)" — unrealisable: only free-form `type: object` derived schemas
could register. Found while building the Constructor Studio backend; confirmed as a
bug on Discord (2026-07-29). Fixes #<issue>.

The fix, entirely within this repo:

- **toolkit-gts-macros**: new wrapper-only `gts_type_schema` argument
  `open_payload = true` — stripped before forwarding to upstream (which rejects
  unknown attributes); the inventory `schema_fn` post-processes the emitted JSON and
  sets `additionalProperties: true` at the schema root. `toolkit-gts` re-exports
  `serde_json` for the generated code.
- **account-management-sdk**: `TenantMetadataEnvelopeV1` declares
  `open_payload = true`; `docs/schemas/tenant_metadata.v1.schema.json` synced.

Semantically the envelope payload was always meant to be open: derived schemas own
the payload shape, and `MetadataService` validates entries against the **derived**
schema at PUT time (`metadata_schema_registry`) — the base is an envelope, not a
payload contract. Traits stay strict (`x-gts-traits-schema` unchanged,
`additionalProperties: false` inside it). Verified along the way that OP#12 honours
an explicit `additionalProperties: true` — the narrowing rule itself needs no change.

### Type of Change

- [x] Bug fix (non-breaking change which fixes an issue)

### Testing

- [x] New tests added:
  - `types-registry/tests/abstract_envelope_tests.rs` — a typed derived schema under
    an open abstract envelope registers and survives `switch_to_ready`;
  - `account-management-sdk` sync test `tenant_metadata_envelope_payload_is_open` —
    asserts the **inventory entry** (what types-registry actually registers) and the
    docs artifact both carry `additionalProperties: true` (the raw
    `gts_schema_with_refs()` accessor intentionally still reflects the upstream
    emitter's closed default — documented in the test).
- [x] Unit tests pass (`cargo test -p cf-gears-toolkit-gts-macros -p cf-gears-toolkit-gts -p cf-gears-account-management-sdk -p cf-gears-types-registry`)
- [x] Manual testing completed — original repro (one typed entry in
  `types-registry.config.entities`) previously aborted post-init on a 20-gear
  assembly.

### Documentation

- [x] API documentation updated (`docs/schemas/tenant_metadata.v1.schema.json`)

### Checklist

- [x] Code follows project style guidelines (conventional commit, DCO signed)
- [x] Self-review completed
- [x] No linting errors (`cargo clippy`)
- [x] Code is properly formatted (`cargo fmt`)
- [x] Tests pass (`cargo test`)

### Related Issues

Fixes #<номер issue про typed tenant-metadata>

## Version bump note (their CONTRIBUTING requires justification)

`cf-gears-account-management-sdk` — PATCH (pre-1.0: 0.x.y+1): the generated schema
gains `additionalProperties: true`, which only *widens* what derived schemas may
declare; no Rust API change. If maintainers consider schema output a public contract
change, MINOR is the conservative pick — happy to адjust.

## После открытия

1. В issue дописать "Fix proposed in #<PR>"; в PR — номер issue.
2. Обновить Discord-тред ссылкой.
3. После мержа: вернуть typed-схему в наш studio-backend
   (`config/*.yaml` — properties обратно) и убрать client-side-валидацию
   workaround (пометки "until gears issue #4" в конфиге и ADR-0002).
