# studio-organizations

A person creates an organization and owns it; the portfolio's rollups in one
request.

The design — why creation is one ordered, resumable operation, how deletion
undoes it, what the rollups count and why an unknown count is null, and the
REST surface — is
[`docs/design/studio-organizations.md`](../../../docs/design/studio-organizations.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-organizations`, capabilities `[rest]`, deps
  `account_management`. Owns no storage.
- Config section `gears.studio-organizations`: `self_service` (default
  `true`). `false` refuses creation with `SELF_SERVICE_DISABLED`; set it with
  `studio-user`'s `on_first_login` in an installation inside one company.
- Needs [`../user_profile`](../user_profile) for creation and deletion; without
  it those routes answer 503 rather than creating an organization nobody owns.
  The creator's membership and owner grant are one call into it
  (`AssignmentRecorder::record_creation`), and who may delete is its answer
  (`OrgAuthority::may_dispose`): this gear writes the tenant and never reads or
  writes the access config's grants itself (ADR-0040).
- The rollups read `studio-documents` and `studio-artifact-ingest` through
  their ClientHub ports when present; a missing one leaves its columns null.

## Working here

- `clean_name` and the rollup rules are unit tests in `service.rs` and
  `rollups.rs`.
- A new rollup column is nullable and settled on its own, like the others: a
  failure must cost that column, not the row, and never read as `0`.
