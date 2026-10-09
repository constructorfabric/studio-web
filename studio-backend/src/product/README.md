# studio-product

What a project builds out of gears: the repository its gears live in, the
gears picked for its product, and what the Gearbox engine says about them. It
also writes a new gear's skeleton into the project's repository and relays the
gear corpus to IDEs that cannot clone it themselves.

The design — why this split from the catalogue, the engine shared with the IDE,
the deprecated paths, the REST surface and the two node types — is
[`docs/design/studio-product.md`](../../../docs/design/studio-product.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-product`, capabilities `[rest]`, deps `types_registry`,
  `account_management`. No config section: the `STUDIO_GEARBOX_*` variables
  are read in [`gearbox.rs`](gearbox.rs); Gearbox is off unless
  `STUDIO_GEARBOX_WORKDIR` is set (the chart's `backend.gearbox`).
- Two records per project, `project_gear_repo` and `project_product`, kept in
  the catalogue graph through [`../catalog_graph`](../catalog_graph). Their type
  ids keep the `gts.cf.studio.catalog.` prefix, because stored nodes carry them;
  this gear registers them (`catalog_graph::gts::product_type_schemas`).
- Routes under `/studio-product/v1`. Three old paths under
  `/studio-components-catalog/v1/gearbox/` (`catalogue` and the two corpus
  relay routes) are registered here too, deprecated, for IDEs and desktop
  clones from before the move: `register_legacy_routes` in [`rest.rs`](rest.rs).
- [`port.rs`](port.rs) is what [`../components_catalog`](../components_catalog)
  reads through: `engine(hub)`, the Gearbox engine published at `init`, and
  `ProjectProducts` / `Products`, a project's gear repository.
  [`sdk.rs`](sdk.rs) names the engine's types. Nothing here reads the
  catalogue.
- Repository writes go through a `connectors::sdk::Repository` opened on a
  connection from [`../connectors`](../connectors); the corpus checkout is
  `connectors::sdk::git_checkout`; the corpus relay reuses
  [`../git_proxy`](../git_proxy)'s `authenticate_member` and streaming.

## The files

- `service.rs` — `ProductService`: get and set a project's gear repository and
  product, write files into the project's repository (the gear repository, or
  the one its project config names), create a repository.
- `skeleton.rs` — the canonical starter gear. `scaffold.rs` — one branch, one
  commit, and optionally a pull request, through the connection's
  `connectors::sdk::Repository`; the provider API is the driver's
  (`connectors/github_write.rs`).
- `gearbox.rs` — the corpus checkout, the engine catalogue, extension points,
  completion, the preview, the corpus relay's upstream.
- `rest.rs` — the routes, including where a new `product.gdl` is written
  (`product_path_for`: `products/<id>/product.gdl`, or where it already is).

## Working here

- The engine is a CLI read as JSON (`--format json`); the backend, session and
  desktop images build it at the same `STUDIO_GEARBOX_REF`. Bump them together.
- The deprecated paths go once no supported desktop release reads them; the IDE
  already asks `/studio-product/v1/gearbox/catalogue` first.
- `ComponentCatalog::engine_completion`, which spec-mapping calls, still lives
  on the catalogue's port and calls this engine; it is to move here.
