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
  `account_management`. Owns no database; the one thing it keeps is the
  organization's logo (below).
- Config section `gears.studio-organizations`: `self_service` — `open`
  (default; `true` reads the same), `request` or `off` (`false`), parsed in
  [`creation.rs`](creation.rs) — and `max_owned` (unset: no limit). Anything
  but `open` refuses creation with `SELF_SERVICE_DISABLED`; set `off` with
  `studio-user`'s `on_first_login` in an installation inside one company.
- Organization requests (ADR-0051), when `self_service: request`:
  `/studio-organizations/v1/organization-requests` — file, list (`scope=mine`
  or, for a platform administrator, `all`), `{id}/cancel`, `{id}/decision`.
  The record lives in studio-user and is reached only through its
  `OrganizationRequests` interface; approval creates the tenant under the
  request's id (`OrganizationService::approve`), so repeating it finishes the
  same organization, and studio-user's `settle_approval` makes the requester
  the owner (`source: request`). Without the interface those routes answer
  503 and nothing else changes.
- Needs [`../user_profile`](../user_profile) for creation and deletion; without
  it those routes answer 503 rather than creating an organization nobody owns.
  The creator's membership and owner grant are one call into it
  (`AssignmentRecorder::record_creation`), and who may delete is its answer
  (`OrgAuthority::may_dispose`): this gear writes the tenant and never reads or
  writes the access config's grants itself (ADR-0040).
- The rollups read `studio-documents` and `studio-artifact-ingest` through
  their ClientHub ports when present; a missing one leaves its columns null.
- [`port.rs`](port.rs) publishes `ProjectsOf` at init: an organization's
  project tenants with their workspaces, for the components registry. It is
  the rollups' walk (`rollups::children_of`, every page), and a listing that
  fails is an error there, not an empty organization. No other gear walks
  the tenant tree itself.

- The organization's logo ([`logo.rs`](logo.rs)): `GET`, `PUT` and `DELETE
  /studio-organizations/v1/logo?organization_id=`. One account-management
  metadata row on the organization (`cf.studio.organization.logo.v1~`, declared
  in every `config/*.yaml`), base64 PNG, JPEG, WebP or GIF of at most 256 KiB,
  checked as a photo is (`user_profile::check_avatar`). Read as the caller;
  written as this gear's service after `OrgAuthority::may_administer(…,
  "access.manage")`, and the PDP refuses anybody else's write of the row
  (`studio_authz_plugin::GEAR_HELD_METADATA`).

- The organization's overview ([`overview.rs`](overview.rs)): `GET
  /studio-organizations/v1/overview?organization_id=`. Its rules are tests in
  `overview_tests.rs`; its sources (studio-usage `OrganizationUsage`,
  studio-tasks `RecentRuns`, artifact-ingest `OpenPullRequests`, the registry,
  studio-user's roster and aliases) are resolved per request, and each one
  missing nulls its part of the answer.

## Working here

- `clean_name` and the rollup rules are unit tests in `service.rs` and
  `rollups.rs`.
- A new rollup column is nullable and settled on its own, like the others: a
  failure must cost that column, not the row, and never read as `0`.
