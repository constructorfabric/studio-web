# studio-credstore-pg

A credstore value-store plugin that survives a restart.

The design — why the in-memory value store lost people's tokens (issue #66),
why this plugin replaces the static one rather than sitting beside it, why it
is a `system` gear, how values are sealed and what changing the key does — is
[`docs/design/studio-credstore-pg.md`](../../../docs/design/studio-credstore-pg.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-credstore-pg`, capabilities `[system, db]`, deps `types_registry`.
- Config section `gears.studio-credstore-pg`: `vendor` (must equal
  `credstore.vendor`), `priority` (50; must stay below
  `static-credstore-plugin`'s 100), `key_env` (`STUDIO_CREDSTORE_KEY`).
- Key from `STUDIO_CREDSTORE_KEY`, base64 of 32 bytes:
  `openssl rand -base64 32`. Unset: the plugin does not register and values do
  not survive a restart. Malformed: the boot fails.
- Database `studio_credstore_values`, which must exist before the first boot.
  On a volume that already exists, create it once by hand:
  `docker compose exec -T graph-postgres psql -U studio -d studio -c 'CREATE DATABASE studio_credstore_values OWNER studio;'`
- Enabled in the docker, oidc and k8s profiles; not in dev or postgres.
- No REST surface — it is a plugin, reached only through credstore.

## Tests

- `store_tests.rs` — each test on a fresh PostgreSQL database
  (`crate::test_pg::fresh_database`), so it needs Docker.
- `config.rs` — checks every shipped profile: wherever this gear is enabled it
  outranks the static plugin and names the key variable the code reads.
