# studio-spec-mapping

From a project's specification to the gears that build it: what the
specification needs, which gears cover each need, what members decided about
the proposals, and where the product runs.

The design — why the specification is read as written, why a contract match
never shares a ranking with a word match, how a decision ranks and expires, and
the REST surface — is
[`docs/design/studio-spec-mapping.md`](../../../docs/design/studio-spec-mapping.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-spec-mapping`, capabilities `[rest]`, no config, no database.
- It owns rules, not data. Each kind of data is read through its owner's port,
  resolved per request from the ClientHub:
  - `documents::port::SpecNeeds` — a project's workspace, the vocabulary, and
    what the project's documents need (the index the documents gear writes);
  - `components_catalog::port::ComponentCatalog` — the components and their
    profiles, a project's code dependencies, the engine's completion;
  - `artifact_ingest::port::MappingDecisionStore` — the decisions.
- A missing port makes the routes that need it answer 503.

## The files

- `reading.rs` — what a document needs, read as it is written: capabilities
  inferred from its Functional Requirements, and its non-functional statements.
  The documents gear calls it when it indexes a document; nothing else does.
- `plan.rs` — the rules: contract → evidence → gap, built first within a step,
  ranked by decisions; `deployment_profile`. Pure functions over JSON values.
- `rest.rs` — the routes, and the assembly of a project's plan from the ports.

## Working here

- The rules are unit tests in `plan.rs` and `reading.rs`, over hand-made
  components and documents; the assembly is tested in `rest.rs`.
- `mentions` in `plan.rs` is the one word rule for both a gear's text and a
  document's: a term matches at the start of a word, never inside one.
- A change to `reading.rs` reaches a repository document on its next sync, and a
  Studio document on its next write: the result is stored in the documents
  gear's index, not computed per request.
- Checking it end to end needs the catalogue synced with the Gearbox engine:
  the recipe is in the PR that introduced the gear.
