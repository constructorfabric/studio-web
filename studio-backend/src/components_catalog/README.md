# studio-components-catalog

Catalogues *our own gears* — every crate published under the
`constructorfabric` keyword on crates.io, and the gears and FrontX packages
its repository scans find — in the knowledge graph, and says how ready each one
is and how good. Scaffolding gears and composing products moved to
[`../product`](../product) (studio-product).

The design — why the catalogue exists, how a field's three sources are
reconciled, kinds and categories, the grade, what a sync reads and prunes, the
REST surface and the node types — is
[`docs/design/studio-components-catalog.md`](../../../docs/design/studio-components-catalog.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-components-catalog`, capabilities `[rest]`, deps
  `types_registry`, `account_management`, `credstore`.
- No config section: the gear reads its environment —
  `STUDIO_COMPONENTS_CATALOG_KEYWORD`, `STUDIO_CRATES_IO_BASE`. The
  `STUDIO_GEARBOX_*` variables are studio-product's.
- A sync is a `catalog.sync` run on [`../tasks`](../tasks): `POST /sync`, then
  poll `GET /studio-tasks/v1/runs/{id}`. It answers 503 in a profile whose
  `studio-tasks` has no database. A body without `repositories` reads the
  sources stored on the server and walks the registry after them.
- Repository access is a connection from [`../connectors`](../connectors); the
  graph is the same one [`../artifact_ingest`](../artifact_ingest) writes to.
  The node vocabulary and the store are
  [`../catalog_graph`](../catalog_graph) (`gts.rs`, `sink.rs`), shared with
  studio-product; this gear builds its own sink and touches only its own node
  types. Without the `graph` feature the catalogue is held in memory.
- The Gearbox engine (gear facts from `gear.gdl`, the corpus checkout, the
  engine catalogue for the reference, completion) and a project's gear
  repository (for its code dependencies) are read through
  `product::port` (`engine`, `Products`) and `product::sdk`, never the
  other way round.
- [`port.rs`](port.rs) is what [`../reports`](../reports) reads the roadmap
  through (`RoadmapCatalog`) and what [`../spec_mapping`](../spec_mapping)
  reads the components through (`ComponentCatalog`); activity comes from
  [`../insight`](../insight)'s `port::ComponentDelivery`.

## Where the rules are

- Field precedence: [`values.rs`](values.rs). Grade: [`quality.rs`](quality.rs),
  rules from the field schema's `quality` block. Kinds and categories:
  [`taxonomy.rs`](taxonomy.rs).
- The join with the engine: [`reference.rs`](reference.rs). Activity per gear:
  [`activity.rs`](activity.rs). History: [`history.rs`](history.rs).
- Board reading: [`roadmap.rs`](roadmap.rs). Repository facts:
  [`repo_facts.rs`](repo_facts.rs), pure functions tested against real
  fragments of `gears-rust`.
- A project's own gears (`ComponentCatalog::project_gears`):
  [`project_gears.rs`](project_gears.rs) — a `gear.toml`/`gear.gdl` directory
  or a `#[toolkit::gear(name = …)]` attribute in the project's repository,
  read by `RepoEnricher::project_gears` from the repositories
  `project_dependencies` reads. Bounded (150 Rust files by name, 80 gears,
  256 KiB a file) and cached per repository until one of the files it read
  changes. Not stored in the graph: they are the project's, not the
  organization's catalogue.
- Whose connection an organization reads and writes through:
  [`ownership.rs`](ownership.rs) — only one held by the organization or
  below it, never one inherited from the platform's root. The walk,
  `project_gears`/`project_dependencies`, the sync and the `/sources` routes
  ask it.
- `ComponentCatalog::engine_completion` in [`port.rs`](port.rs) calls
  studio-product's engine; it is to move to studio-product.
- The organization's registry (ADR-0041, phase P1): [`registry.rs`](registry.rs)
  keeps the catalogue sources on the server (`source` nodes, `GET`/`PUT
  /sources`), the excluded projects (`registry_settings`), and the walk —
  every project from `organizations::port::ProjectsOf`, each repository
  `project_repos` resolves, read with `RepoEnricher::project_gears_unless`
  only when its stored fingerprint (`registry_read`) moved. What a walk writes
  is the pure `registry::plan`, tested in
  [`registry_tests.rs`](registry_tests.rs): a new entry is `declared` (or a
  `candidate`, P3), no state a person set moves, an entry with no occurrence left is `orphaned`
  and kept. The task is `catalog.registry` ([`registry_task.rs`](registry_task.rs));
  a `catalog.sync` with `registry: true` runs it as its last phase. The hourly
  schedule (platform-level, naming the organization) is ensured when sources or
  exclusions are saved; studio-git queues a walk of a pushed project through
  `port::Registry::queue_refresh`. Spec-mapping reads a project's own gears
  from `port::Registry` when it has found any there.
- The registry's lifecycle (ADR-0041, phase P2):
  [`registry_decisions.rs`](registry_decisions.rs). `POST
  /registry/{name}/decisions` moves an entry by the pure `transition`/`apply`
  table (register, reject, deprecate, restore, publish, merge, edit), records a
  `registry_decision` node joined by `decided`, and for a merge re-points the
  occurrences (`repoint`) and adds the name to the target's `aliases`, which
  `registry::plan` consults so later findings land on the target. Only an
  organization administrator decides: studio-user's `OrgAuthority` with the
  privilege `component.registry`. Tested in
  [`registry_decisions_tests.rs`](registry_decisions_tests.rs).
- Candidates (ADR-0041, phase P3): [`candidates.rs`](candidates.rs) holds the
  pure structural detectors (REST surface, persistence, types, a port/sdk,
  docs, consumers, copies across projects; weights, the threshold and the cap),
  run by `project_gears_unless(…, with_candidates: true)` over the tree and the
  files already read, and `apply_copies` across a walk's reads. `registry::plan`
  writes them as `candidate` entries with `detected` occurrences, moves one
  found declared to `declared`, and re-proposes a rejected one whose module
  fingerprint changed ([`registry_candidates_tests.rs`](registry_candidates_tests.rs),
  [`candidates_tests.rs`](candidates_tests.rs)). Declare it is
  [`registry_declare.rs`](registry_declare.rs): `POST /registry/{name}/declare`
  asks studio-product's `product::port::GearDeclarations` for the files and the
  pull request, in the project's tenant, and records a `declare` decision.
- The fingerprint ([`project_gears.rs`](project_gears.rs) `fingerprint`) is a
  uuid5 of the files read and `DISCOVERY_VERSION`, because it is stored: move
  the version when discovery's rules change, and every repository is read once
  more.
