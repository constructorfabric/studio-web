# Discord reply — closing the loop on open envelope + closed derivations

**Context:** Diffora agreed to the open base on the condition that every derived
metadata schema is closed at its own level, and asked what enforces this for
schemas registered through the API (macro-generated ones come out closed
anyway). Andrej: enforcement belongs in gts-spec/gts-rust, not in gears.

---

## Message to send

@Diffora @aviator5 — deal accepted, and your open question answered at the level
it belongs to: the type system, not the gears.

**Proposal: a third schema modifier, `x-gts-closed-derivations`.** Declared on
the (open, abstract) base; the registry then requires every derived schema to
resolve to a **closed content model at its own top level** — effective
`additionalProperties: false` after `$ref`/`allOf` resolution. Registration and
OP#12 fail otherwise, no matter how the schema arrives (API, config seeding, or
macros). Your typo scenario is exactly the test case: a derived schema that
would accept `automation_levl` doesn't get registered in the first place.

Both parts are ready on branches:

- **gts-spec** `feat/x-gts-closed-derivations` — 0.14 draft: §9.11.4 semantics,
  keyword/combination tables (final+closed-derivations rejected as meaningless,
  abstract+closed-derivations named as the expected envelope pairing), §4.4.1
  cross-reference. Notably: grandchildren need no extra checks — a closed
  derived level already blocks additions via §3.1, and re-opening fails
  derivation compatibility (§4.1), so implementations only check schemas whose
  immediate base declares the modifier.
- **gts-rust** `feat/x-gts-closed-derivations` — the check in
  `validate_schema_chain` right next to the `x-gts-final` guard, reusing the
  existing effective-schema extraction (the allOf closedness lattice), plus
  five tests: closed passes, open and default-open rejected, closed-via-allOf
  passes, final+closed-derivations rejected as a modifier combination.

How it composes with what we agreed:

1. @aviator5's open-content support in `struct_to_gts_schema` opens the
   envelope at the source;
2. `cf.core.am.tenant_metadata.v1~` gets `x-gts-abstract` +
   `x-gts-closed-derivations` + open payload — traits schema stays strict;
3. our `cf.studio.workspace.settings.v1~` (and every future derived metadata
   schema) carries `additionalProperties: false` — which the registry now
   *requires* rather than hopes for;
4. base payload stays property-free; if it ever needs a field, that's
   `tenant_metadata.v2~` — agreed.

If the shape looks right I'll open both PRs (spec first, rust referencing it),
and we'll rework the gears-side PR to just apply the modifiers once the
gts-rust release lands.

---

**Заметки (не отправлять):**

- Ветки локально: `C:\Repos\CFS\gts-spec` и `C:\Repos\CFS\gts-rust`, обе
  `feat/x-gts-closed-derivations`, коммиты с sign-off.
- Перед пушем: `cargo test -p gts` в gts-rust (в WSL; в песочнице cargo нет).
- Наш PR#2 в gears-rust после этого трансформируется: вместо wrapper-хака
  `open_payload` — модификаторы на envelope + `additionalProperties: false`
  в derived; workaround-конфиги studio-backend чистим тогда же.
