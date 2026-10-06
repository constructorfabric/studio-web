# PR descriptions — `x-gts-closed-derivations` (gts-spec + gts-rust)

Branches are ready locally, commits signed off:
- `C:\Repos\CFS\gts-spec` → `feat/x-gts-closed-derivations`
- `C:\Repos\CFS\gts-rust` → `feat/x-gts-closed-derivations`

Open the **spec PR first**, then the rust PR with a link to it.

---

## PR 1 — GlobalTypeSystem/gts-spec

**Title:** `feat(spec): x-gts-closed-derivations schema modifier (0.14 draft)`

**Description:**

### Summary

Adds a third schema modifier, `x-gts-closed-derivations`. Declared on a base
type (typically an open, abstract envelope), it requires every schema deriving
from that base to resolve to a **closed content model at its own top level**
(§4.4: effective `additionalProperties: false` after `$ref`/`allOf`
resolution). Enforced at registration (when validation is enabled) and in
OP#12 — regardless of how the schema is registered: API, config seeding, or
macro-generated.

### Motivation

The extensible-envelope pattern (per-tenant metadata, plugin payloads) needs
the base open so derived schemas can declare their own payload properties
(§3.1). But openness is inherited: if a derived schema is also open, a
mistyped property (`automation_levl` next to a declared `automation_level`)
validates successfully and is silently ignored — defeating server-side
validation. §4.4.1 already recommends "closed envelope with designated open
containers"; this modifier covers the complementary layout where the **base
itself** is the open derivation anchor, and makes "derived must close its
level" a registry-enforced invariant instead of a convention.

Agreed with the account-management/types-registry maintainers as the
resolution of the open-envelope discussion (context: derived tenant-metadata
schemas could not be registered at all; opening the base was acceptable only
if derived schemas are guaranteed closed).

### Changes

- §9.11 title + intro: three modifiers instead of two.
- §9.11.1: keyword table row, combination table (`final`+`closed-derivations`
  → INVALID; `abstract`+`closed-derivations` → the expected envelope pairing),
  mutual-exclusion paragraph.
- New §9.11.4 "`x-gts-closed-derivations` semantics": derivation guard,
  typical use, why grandchildren need no extra checks (§3.1 blocks additions
  under a closed parent; re-opening fails §4.1 derivation compatibility — so
  implementations check only schemas whose *immediate* base declares the
  modifier), no propagation, evolution note (base payload stays property-free;
  a base payload field is a MAJOR bump), top-level placement.
- §9.11.4/§9.11.5 renumbered to §9.11.5/§9.11.6; the one cross-reference
  updated.
- §4.4.1: cross-reference from the recommended-pattern discussion.
- Version: 0.14 (draft) row + header bump.

### Notes for reviewers

- The check is deliberately scoped to *direct* derivations — deeper levels are
  covered by existing rules (see §9.11.4 item 3), keeping OP#12 cost O(chain).
- Conformance tests for OP#12: happy to add to `tests/` in this PR or as a
  follow-up once the wording settles — maintainers' preference?
- Reference implementation PR (gts-rust): <link to PR 2>.

---

## PR 2 — GlobalTypeSystem/gts-rust

**Title:** `feat(gts): enforce x-gts-closed-derivations in OP#12 chain validation`

**Description:**

### Summary

Implements the `x-gts-closed-derivations` schema modifier proposed in
GlobalTypeSystem/gts-spec#<N> (0.14 draft, §9.11.4): a base type may require
every derived schema to resolve to a closed content model at its own top
level. Enforced in `validate_schema_chain` (OP#12) next to the existing
`x-gts-final` guard.

### Changes

- `gts/src/schema_modifiers.rs`
  - new constant `X_GTS_CLOSED_DERIVATIONS` with doc comment;
  - `validate_schema_modifiers`: boolean-only value, top-level placement
    (same fail-fast rule as the other modifiers), and rejection of the
    meaningless `x-gts-final` + `x-gts-closed-derivations` combination.
- `gts/src/store.rs` — in `validate_schema_chain`, for each (base, derived)
  pair: if the base declares the modifier, the derived schema's effective
  top-level `additionalProperties` (via the existing
  `extract_effective_schema`, which already folds `allOf` through the
  closedness-preserving lattice) must be `false`; otherwise
  `StoreError::ValidationError` naming the modifier, the base and the derived
  id.
- `gts/src/store_test.rs` — five tests:
  - closed derived schema under a closed-derivations base → passes;
  - derived with `additionalProperties: true` → rejected (message names the
    modifier);
  - derived with `additionalProperties` omitted (default-open) → rejected;
  - closedness contributed by an `allOf` conjunct → passes;
  - `final` + `closed-derivations` on one schema → modifier validation error.

### Why only direct derivations are checked

A closed derived level already prevents grandchildren from adding properties
(§3.1), and a grandchild re-opening the level would accept instances its
closed parent rejects — failing derivation compatibility (§4.1) through the
existing checks. See spec §9.11.4 item 3.

### Testing

```bash
cargo test -p gts
```

All existing tests pass unchanged (the modifier is opt-in; schemas without it
are unaffected).

### Related

- Spec: GlobalTypeSystem/gts-spec#<N>
- Motivating discussion: gears-rust tenant-metadata envelope (open abstract
  base + mandatory-closed derived metadata schemas); pairs with the planned
  open-content-model support in `struct_to_gts_schema`.

---

**После открытия:**
1. Вписать номер spec-PR в описание rust-PR (два места `#<N>`).
2. Ссылки на оба PR — в Discord-ответ (`discord-reply-closed-derivations.md`).
3. gears-rust PR#2 (наш форк) пересобрать после релиза gts-rust: модификаторы
   на envelope + `additionalProperties: false` в derived вместо wrapper-хака.
