# studio-components-catalog

Catalogues *our own gears* — every crate published under the
`constructorfabric` keyword on crates.io, and the gears and FrontX packages
its repository scans find — in the knowledge graph, says how ready each one is
and how good, and scaffolds new ones into a project's repository.

The design — why the catalogue exists, how a field's three sources are
reconciled, kinds and categories, the grade, what a sync reads and prunes, the
Gearbox preview and corpus relay, the REST surface and the node types — is
[`docs/design/studio-components-catalog.md`](../../../docs/design/studio-components-catalog.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-components-catalog`, capabilities `[rest]`, deps
  `types_registry`, `account_management`, `credstore`.
- No config section: the gear reads its environment —
  `STUDIO_COMPONENTS_CATALOG_KEYWORD`, `STUDIO_CRATES_IO_BASE`, and the
  `STUDIO_GEARBOX_*` variables in [`gearbox.rs`](gearbox.rs) (Gearbox is off
  unless `STUDIO_GEARBOX_WORKDIR` is set; the chart's `backend.gearbox`).
- A sync is a `catalog.sync` run on [`../tasks`](../tasks): `POST /sync`, then
  poll `GET /studio-tasks/v1/runs/{id}`. It answers 503 in a profile whose
  `studio-tasks` has no database.
- Repository access is a connection from [`../connectors`](../connectors); the
  graph is the same one [`../artifact_ingest`](../artifact_ingest) writes to.
  Without the `graph` feature the catalogue is held in memory.
- [`port.rs`](port.rs) is what [`../reports`](../reports) reads the roadmap
  through, and nothing else; activity comes from
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
- The starter gear: [`skeleton.rs`](skeleton.rs); writing it:
  [`scaffold.rs`](scaffold.rs).
