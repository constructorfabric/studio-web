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
- An organization's plain explanations of gears (`/gear-explanations`) are
  one account-management metadata row on the organization,
  `cf.studio.product.gear_explanations.v1~`, declared in every
  `config/*.yaml` and written only by this gear, as the service
  (`studio_authz_plugin::GEAR_HELD_METADATA`). A generated one comes from
  `llm_proxy::port::ModelProviders::complete` on the caller's key.
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
- `project_roots.rs` — the gears an organization's projects keep in their own
  repositories: each project's `product.gdl` (at its repository's root) is
  read from a clone of the source it is already connected by; its
  `source(id, at = path("…"))` directories become roots of the
  organization's corpus, after its gear repositories, and the gears it names
  are the project's product (`GET …/projects/{id}/product` answers them, with
  `from_file`). No second "gear repository" connection for a project that
  holds its gears. Read with the organization's roots (`gear_roots::scope_for`).
- `gearbox.rs` — the corpus checkout, the engine catalogue, extension points,
  completion, the preview, the corpus relay's upstream.
- `explanations.rs` — gears in plain words: the stored row, the model's
  question and the cleanup of its answer, and the rule that a model never
  writes over a person's words unless asked. `explanations_rest.rs` (a child of
  `rest.rs`) — its three routes.
- `rest.rs` — the routes, including where a new `product.gdl` is written
  (`product_path_for`: `products/<id>/product.gdl`, or where it already is).

## Working here

- The engine is a CLI read as JSON (`--format json`); the backend, session and
  desktop images download it from the same constructorfabric/gearbox release
  (`STUDIO_GEARBOX_RELEASE`, its commit `STUDIO_GEARBOX_REF`, each archive's
  SHA-256 pinned). Bump them together, then run the ignored
  `the_pinned_engine_reads_the_corpus_and_resolves_what_studio_writes` with the
  new binary and the corpus: the parsers default what they do not find, so a
  changed output shape shows up only there.
- The deprecated paths go once no supported desktop release reads them; the IDE
  already asks `/studio-product/v1/gearbox/catalogue` first.
- `ComponentCatalog::engine_completion`, which spec-mapping calls, still lives
  on the catalogue's port and calls this engine; it is to move here.
