# studio-secrets-bootstrap

Self-heal for config-seeded credstore secrets, run once at start.

The design — why a restart left secrets fence-poisoned, how the heal decides
between leaving, overwriting and creating a secret, why it never fails the boot,
and its relationship to [`../credstore_pg`](../credstore_pg) — is
[`docs/design/studio-secrets-bootstrap.md`](../../../docs/design/studio-secrets-bootstrap.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-secrets-bootstrap`, capabilities `[stateful]`, deps `credstore`.
- Config section `gears.studio-secrets-bootstrap` — the list of
  `(ref, value_env, sharing)` seeds; `sharing` is `shared` unless set.
- No REST surface. Its `start` spawns and returns, as every `start` must.
- The tests in `mod.rs` run the heal against a credstore that records what it
  was asked to do.
