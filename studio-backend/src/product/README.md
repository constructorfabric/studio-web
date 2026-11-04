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

- Gear `studio-product`, capabilities `[db, rest]`, deps `types_registry`,
  `account_management`. A `database:` section (`studio_product`) keeps a
  product's description by revision (ADR-0053; `descriptions.rs`,
  `description_service.rs`, `descriptions_rest.rs`); otherwise the `STUDIO_GEARBOX_*` variables
  are read in [`gearbox.rs`](gearbox.rs); Gearbox is off unless
  `STUDIO_GEARBOX_WORKDIR` is set (the chart's `backend.gearbox`).
- One record per project, `project_product`, kept in the catalogue graph
  through [`../catalog_graph`](../catalog_graph); the old `project_gear_repo`
  is still read, and folded into the project's sources (ADR-0060). Their type
  ids keep the `gts.cf.studio.catalog.` prefix, because stored nodes carry them;
  this gear registers them (`catalog_graph::gts::product_type_schemas`).
- A project's repositories are its one list of sources (`project.config`
  `sources[]`, [`../project_sources.rs`](../project_sources.rs)), with no
  hidden main one (ADR-0060). `gears_here` marks where "Create a gear" writes,
  `publish_here` where a published `product.gdl` goes (none: Studio keeps the
  revisions only), and the description travels with its *home* source (the
  `publish_here` one, else the first with a connection), where its `path(...)`
  sources resolve.
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

- `service.rs` — `ProductService`: the project's product record; its sources
  as write targets -- `home_target` (the source the description travels
  with), `publish_target` (the one marked `publish_here`), `gears_target` (the
  one marked `gears_here`; the old gear repository folded in by
  `fold_legacy_gear_repo`); create a repository.
- `sources_lock.rs` — what a description says about its sources: the
  `source(...)` scan, the refusal of one repository named twice (ADR-0060
  §2), and the lock a revision keeps -- each source's commit at save -- with
  the refs a dev or a protected build takes (`build_refs`, §3).
- `save_guard.rs` — a save composes from the whole record, and is refused
  when it would still drop a picked gear or the frontend the latest revision
  had (§4).
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
  completion, the preview, the corpus relay's upstream. The preview is two
  steps: `describe` renders the text from the catalogue alone, `check` runs
  the engine on it (one at a time). A save keeps what `describe` made before
  `check` runs, and `rest.rs` runs the check on a task of its own that keeps
  the verdict under `checks.<profile>`; a save answers within
  `SAVE_ANSWERS_WITHIN` (20 s), inside the gateway's fixed 30 s, with
  `checking: true` if the check is still running (ADR-0053, amendment
  2026-11-04). The same text saved again is the latest revision, never a
  conflict (`descriptions::settled`), so a client may resend a lost save.
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
