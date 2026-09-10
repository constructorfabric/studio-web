# studio-secrets-bootstrap

Self-heal for config-seeded credstore secrets, run once at start.

## Why it exists

The dev credstore value-store (`static-credstore-plugin`) is in-memory: its
values and its fence key die with every backend restart, while the secret
**metadata** lives in Postgres and survives. A restart therefore leaves
references like `openai-key` fence-poisoned — `GET` fails closed — and consumers
(mini-chat provisioning its OAGW upstream) spin on `failed_precondition` until
somebody manually `PUT`s the secret with `If-Match: *`.

This gear performs that heal automatically. For every configured
`(reference, environment variable)` pair it checks accessibility and, when the
reference is broken or missing, rewrites the secret through
`WritePrecondition::Exists` — the SDK's documented healing path for
fence-poisoned references (credstore ADR-0003) — falling back to `create` when
no metadata exists at all.

## It fails quietly on purpose

Boot never fails because of a seed. A problem is a warning; consumers keep
retrying. A deployment where a key is genuinely absent should start and say so,
not refuse to come up.

## Its relationship to studio-credstore-pg

[`../credstore_pg`](../credstore_pg) removes the *cause* — values in a durable
table stop dying at restart. This gear stays useful either way: it is also how
a key held only in the environment (`STUDIO_LLM_API_KEY` and friends) gets into
credstore in the first place, on every boot, without anyone typing it into the
portal.

## In the assembly

- Gear `studio-secrets-bootstrap`, capabilities `[stateful]`, deps `credstore`.
- Config section `gears.studio-secrets-bootstrap` — the list of
  `(ref, env var)` pairs.
- No REST surface. Its `start` spawns and returns, as every `start` must.
