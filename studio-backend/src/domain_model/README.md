# studio-domain-model

Stores the Studio **domain model** as GTS types in Graph Storage, so you can
create objects of those types, extend the types with new fields, and regenerate
the frontend from the stored model.

The design — where the model lives and why it is per tenant, how every edit
becomes a version and how concurrent edits stay safe, how objects and relations
are checked against the model, the mapping to GTS and the HTTP surface — is
[`docs/design/studio-domain-model.md`](../../../docs/design/studio-domain-model.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-domain-model`, capabilities `[rest]`, deps `types_registry`; no
  config section.
- Prefers the graph-storage gear (the default `graph` feature); without it
  (`--no-default-features`) the gear falls back to an in-memory store, so the
  create/read loop still runs.
- The seed `ontology.core.json` comes from `studio-internal/domain-model-ui`
  (`core/entities.json` etc.). Refresh it from there rather than editing it
  here; a tenant's live model is in the graph, not in this file.

## Run the loop

```bash
# 1. start the backend (real graph store on the `graph` feature, default)
cargo run -- --config config/dev.yaml run

# 2. exercise create -> relate -> extend -> read
demo/domain-model.sh

# 3. regenerate the model-UI file set from what is stored
curl -s -H "Authorization: Bearer studio-admin-token" \
  http://127.0.0.1:8090/cf/studio-domain-model/v1/types > /tmp/types.json
node scripts/regen-domain-frontend.mjs /tmp/types.json --out regen-out \
  --validate ../../studio-internal/domain-model-ui/schema-validator.js
```

## Layout

- `ontology.core.json` — the bootstrap seed: the regeneration-complete core model
- `ontology.rs` — loads the model; derives node/edge types; **extends** a type;
  resolves what a type inherits (`effective_properties`); reassembles a model
  from what the graph stores (`from_parts`)
- `validate.rs` — checks an object against the type the model says it is
- `gts.rs` — GTS id derivation (node/edge ids, family derivation, instance ids)
  including the meta layer: `model`, `model_version`, `object_type` and the
  `revises` / `inherits` / `declares` edges
- `store.rs` — `DomainStore` over the graph-storage SDK + in-memory fallback
- `service.rs` / `rest.rs` / `mod.rs` — orchestration, HTTP surface, gear wiring
- `../../scripts/regen-domain-frontend.mjs` — model → model-UI file set
