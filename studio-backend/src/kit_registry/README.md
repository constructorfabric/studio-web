# studio-kits

The catalogue of kits, and which kits a project wants installed.

The design — why kit bytes stay in Git, what the gear records and what `cfs`
does, scope and reconciliation, the REST surface and where installations are
stored — is [`docs/design/studio-kits.md`](../../../docs/design/studio-kits.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-kits`, capabilities `[rest]`, deps `account_management`.
- No configuration: the catalogue is `official_catalogue()` in `service.rs`.
  Adding a kit, or moving its pinned default commit, is a change there.
- Materialize, reconcile and the repository list call the project's session
  through [`../studio_theia`](../studio_theia), so they need a backend built
  with the `theia-bridge` feature and a running session; without either they
  answer 503.
- A project's installations are one tenant-metadata document,
  `cf.studio.project.kit_installations.v1~`, declared in `config/*.yaml`.
- The prototype flow and the installer inside the session are in the
  repository-root [`docs/kit-registry-prototype.md`](../../../docs/kit-registry-prototype.md).
