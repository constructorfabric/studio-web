# studio-reports

The reports a Studio draws, and where each one's data comes from in an
organization.

The design — a report as a definition over a data set, the source an
organization configures once, refreshes and schedules, the REST surface and
how a source is stored — is
[`docs/design/studio-reports.md`](../../../docs/design/studio-reports.md). The
decision is ADR-0033. This README is what you need to work in the directory.

## In the assembly

- Gear `studio-reports`, capabilities `[rest]`, deps `types_registry`,
  `account_management`, `credstore`. No configuration section.
- One GTS type, `gts.cf.studio.reports.report_source.v1~`, registered at init;
  sources live in graph-storage, or in memory without the `graph` feature.
- One task type, `reports.refresh`, registered on
  [`../tasks`](../tasks). `POST …/sync` answers 503 when `studio-tasks` has no
  database.
- The board is read by [`../components_catalog`](../components_catalog) and
  reached only through `components_catalog::port::RoadmapCatalog`; schedules go
  through `scheduler::port::Schedules`; the plan file is read through a GitHub
  connection from [`../connectors`](../connectors).
- The Reports screen is `studio-frontend-prototype/src/reports.tsx`.

## Working here

- Another report over the same data is another definition: a built-in goes in
  `presets/` and into `PRESETS` in `definition.rs`. Another data set is another
  entry in `REPORTS` in `service.rs`.
- The workbook must stay identical to the planning team's for
  `back_roadmap`; `roadmap/workbook_tests.rs` and `roadmap/summary_tests.rs`
  hold the rules, `definition_tests.rs` every value key and refusal,
  `service_tests.rs` save, refresh and definition choice.
