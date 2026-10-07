# studio-assembly

What this backend is made of, said by the running process: the linked gears in
start order, their dependencies, which are Studio's and which the platform's,
which are plugins and of what, the build commit and the IDE session image. The
prototype's `/architecture/` page draws it.

The design — why the gears are read from the registry and not listed, why the
commit and the purposes are compiled in, how a plugin's host is found — is
[`docs/design/studio-assembly.md`](../../../docs/design/studio-assembly.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-assembly`, capabilities `[rest]`, no dependencies, no config,
  no database. One route: `GET /studio-assembly/v1/manifest`.
- `../../build.rs` compiles in `STUDIO_BUILD_COMMIT` (set by CI; empty for a
  local build) and the first paragraph of section 1.1 of every
  `docs/design/*.md`. A build context without `docs/design/` still builds, with
  a cargo warning and no purposes.

## Working here

- The classification rules are unit tests in `manifest.rs`;
  `every_gear_design_contributes_a_purpose` fails when a gear design loses its
  `### 1.1` paragraph.
- A new gear needs nothing here. A new gear *design* is picked up by the next
  build.
- Check a running stand with
  `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8090/cf/studio-assembly/v1/manifest`;
  the gear count matches the `Gear dependency order resolved (topo)` line of
  the boot log (which this gear prints a second time at its own `init`).
