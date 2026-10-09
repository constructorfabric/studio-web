# catalog_graph

The catalogue graph: the GTS vocabulary of catalogue nodes and the store they
are written to. Shared code, not a gear.

[`../components_catalog`](../components_catalog) (studio-components-catalog)
and [`../product`](../product) (studio-product) both keep their records here.
Each registers the types-registry schemas of the node types it owns and reads
and writes only those: the catalogue registers `gts::type_schemas`, the
product `gts::product_type_schemas` (`project_gear_repo`, `project_product`).
Their designs list the node types:
[studio-components-catalog](../../../docs/design/studio-components-catalog.md#31-domain-model),
[studio-product](../../../docs/design/studio-product.md#31-domain-model).

## The files

- `gts.rs` — type ids, deterministic instance ids (uuid5 in the catalogue's own
  namespace), the node and edge shapes, and the schemas each gear registers.
- `sink.rs` — `CatalogSink` and its two implementations: `GraphSink` over
  graph-storage (`graph` feature) and `MemorySink` without it.
  `build_sink(hub, gear)` picks one; each gear builds its own.

## Working here

- A type id is data: stored nodes carry it. The product's types keep the
  `gts.cf.studio.catalog.` prefix they had before studio-product split out;
  renaming one needs a migration of the stored nodes.
- A gear that adds a node type registers it in the types-registry from its own
  `init`, not the other gear's. In graph-storage, `GraphSink::register_types`
  registers the whole vocabulary, both gears' types, before each write.
