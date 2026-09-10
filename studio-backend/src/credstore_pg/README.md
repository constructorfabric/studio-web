# studio-credstore-pg

A credstore value-store plugin that survives a restart.

## Why it exists (issue #66)

credstore splits a secret in two: the metadata row lives in its own Postgres
database, the value lives in whatever backend plugin is selected. The only
plugin CF/Gears ships is `static-credstore-plugin`, whose backend is a
`HashMap` seeded from YAML.

So every `docker compose restart backend` left the metadata intact and the
values gone. `get` then fails closed on the value fingerprint fence and answers
`Ok(None)`, and any token a user had typed into the portal — source PATs
(`studio-repo-*`, `studio-root-*`), connector tokens (`studio-connection-*`) —
was unrecoverable. Unlike `openai-key` or `anthropic-key`, there is no
environment variable to re-seed those from.

This gear makes the value store a table.

## It replaces the static plugin rather than sitting beside it

credstore resolves its backend through `choose_plugin_instance`, which filters
by `vendor` and returns the single instance with the lowest `priority`. There
is no chain and no fallback: at `priority: 50` this gear displaces
`static-credstore-plugin` (100) outright, and that plugin's config-seeded
secrets stop being reachable. In the Studio profiles that costs nothing —
those entries are empty and the values arrive from the environment through
[`../secrets_bootstrap`](../secrets_bootstrap) on every boot.

The one escape hatch is the key. With no `STUDIO_CREDSTORE_KEY` this gear logs
a warning and does not register at all, so the static plugin wins again and the
deployment behaves exactly as it did before #66. A key that is present but
malformed fails the boot instead — a silent downgrade there would only be
discovered as lost secrets after the next restart.

## Why it is a `system` gear

`GtsPluginSelector` memoises the *successful* resolution for the life of the
process. If a feature gear touched a secret before this plugin had published
its instance to the types-registry, credstore would latch onto the static
plugin forever and this gear would silently do nothing. System gears initialize
before every non-system gear, which closes that window by construction rather
than by luck of ordering.

## Storage

One table, `studio_credstore_values`, in **its own** database — values and
metadata deliberately do not share one. Each value is sealed with AES-256-GCM
under a deployment key from the environment, with the key class
(`tenant | reference | owner`) as associated data. That mirrors credstore's own
split-knowledge stance: fingerprints in the credstore database, values here,
the key in neither.

A bonus falls out of persistence: credstore keeps its fence key in the value
store too (`cfs-internal-fence-key`, nil tenant). Once the store is durable the
fence key stops being regenerated every boot — which is what made surviving
metadata rows read as poisoned in the first place.

## In the assembly

- Gear `studio-credstore-pg`, capabilities `[system, db]`, deps `types_registry`.
- Config section `gears.studio-credstore-pg`; key from `STUDIO_CREDSTORE_KEY`.
- No REST surface — it is a plugin, reached only through credstore.
