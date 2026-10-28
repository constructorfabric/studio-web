# gearbox-studio

Gearbox inside Constructor Studio: the gear catalogue, products, their
resolution, the lock, conflicts and generation, as Theia views beside
Studio's own.

**Provenance.** Ported from Gearbox Studio,
[`MikeFalcon77/gearbox@55f7015`](https://github.com/MikeFalcon77/gearbox/tree/55f7015a95f0564ecccb6bbb73fbe586102bce82/ide/gearbox-studio).
The engine now lives at
[`constructorfabric/gearbox`](https://github.com/constructorfabric/gearbox)
under Apache-2.0, and the session image downloads it from the release
`STUDIO_GEARBOX_RELEASE` names in `theia/Dockerfile`, at the commit
`STUDIO_GEARBOX_REF`: `cf63925` on `constructorfabric/gearbox` main since
2026-10-27. From 2026-10-19 until then it was a build of `6d60603` on
`MikeFalcon77/gearbox` `feature/gdl-extensible`, because GDL 1.0 had not
reached `constructorfabric/gearbox` yet. `src/common/generated/`,
`src/common/extension-points.ts`, `src/browser/gdl/generated/` and
`src/browser/ai/generated/` are copied from `6d60603` verbatim, because they
describe the engine's wire format;
the views are still the 55f7015 port, with the rename applied. Every file
copied from it keeps its original text apart from the changes marked
`Constructor Studio:`.

## What is ported, and what is not

Gearbox Studio was a whole IDE. It narrowed Theia by rebinding: it hid the
debug, test, terminal, problems and outline views, quietened the status bar,
pruned menus, owned the workspace, and folded and closed panels as its context
changed (its ADR-0011). None of that is ported. Here Gearbox is one set of
views among Studio's, and Studio's Workbench and Documents perspectives, the
collab strip, Orca and the Explorer stay as they are.

- **Ported as it was:** the protocol and the engine's generated types, the
  engine process and its RPC service, the catalogue and product stores, the
  product edit service, and every view (catalogue, product, inspector, graph,
  conflicts, lock, generate, start, create product and gear, add gear).
- **Adapted:**
  - `node/gearbox-environment.ts` replaces Gearbox Studio's lookup of its own
    Cargo checkout. The workspace is `/workspace` (`GEARBOX_WORKSPACE`; on a
    desktop, the folder the window names), the engine is `GEARBOX_ENGINE`,
    else `gearbox` on the PATH (the session image carries it; a desktop
    fetches it as an extension and points `GEARBOX_ENGINE` at it), and the
    roots are the checkouts under the workspace that hold a `gear.gdl`
    (`GEARBOX_ROOT`).
  - Every service that still arranges panels asks
    `shell/gearbox-shell-gate.ts` first, and acts only inside a Gearbox
    perspective.
  - No view opens at start-up. The Product view opens when a person opens a
    product.
- **Opening from the portal.** Each portal section opens the IDE its own way:
  a document from Specs in Documents, a file from Sources in the Workbench, the
  artifact graph from Artifacts, and a product from Components in the Gearbox
  perspective (`studio.openProduct` → `gearbox.product.openAt`), with the
  catalogue left, the product in the middle, the Inspector right and Conflicts
  below. Nothing of Studio's is hidden; switching back restores each layout.
- **Gear projects.** A `new_gears` project is born with a `gear.gdl` the engine
  wrote (the portal's scaffold asks `gearbox/gear/scaffold` for it), and its
  **Open in IDE** sends `studio.openGear` → `gearbox.gear.openAt`: the project's
  gear, found in its checkout (the `gears-rust` corpus beside it is skipped),
  opens in the Gear view of the Gearbox perspective. New Gear defaults its
  destination to the project's repository, beside the gears already there.
- **A repository with no gears and no product** (a desktop member who opened
  one repository, studio-web say). Products are found under
  `<repository>/products/<name>/product.gdl` as well as in each checkout, and
  that is where New Product suggests one. New Product offers the gear corpus
  as a source: the per-machine copy under `~/ConstructorStudio/corpus` when it
  is there (checked when the workspace has no gears of its own), else
  "Bring the gears here" inline. It is declared as an absolute `path(...)`,
  because `gearbox/product/create` writes path sources only; such a product
  resolves on this machine. A product that names its corpus as
  `git(url, rev)` opens anywhere: the commit is brought into the same
  per-machine cache (through the Studio relay for a private corpus), never
  into the project. Add gear with no product open opens New Product.
- **The header's product half is a strip on the Product view.** Gearbox
  Studio's shell header (`ToolbarWidget`) carried the product's resolved
  state, the draft's **Apply changes / Discard** and Resolve / Close. Studio's
  top panel is the menu, the mode tabs and the ribbon, so those live in the
  Product view's head instead (`product/product-status-strip.tsx`), on every
  stage, beside the pending-changes count.
- **The Gearbox menu** is labelled here (`menus.ts`, `GearboxMenuContribution`):
  Gearbox Studio labelled it from `ShellPolicy`, which is not ported, and
  Theia 1.75 draws only labelled top-level menus. Studio's mode allow-list keeps
  it in Building and Full functionality; its entries appear with a product open.
  Building's ribbon also carries Resolve and Lock.
- **With no product open**, the Product view offers New, Open, Continue, the
  workspace's products and Recent (`product/product-empty-state.tsx`): the
  Start screen is not opened at start-up, and on the desktop product-ext's
  start page stands where it stood.
- **An open waits for the gears in its own step**
  (`ProductSessionService.awaitProjection`). The engine answers one request at
  a time, and the product's `product/load` used to queue behind the whole
  catalogue projection, with the view on "Reading the description…" for as
  long as that took (90 s and more on a cold Windows start). The opening
  checklist now counts the gears as they load, the product is handed to the
  store only once they are in, and a projection silent for 120 s stops the
  open with the reason and restores the previous product.
- **An engine request is ended for silence, not for length**
  (`silenceVerdict`): any output restarts its allowance, a silent engine is
  ended at the timeout, and a busy one at ten times it.
- **The screen scope is started, inside Building only**
  (`shell/studio-screen-scope.ts`): a closed or replaced product's Add Gear,
  Lock and Generate are withdrawn. It folds no panel and opens no Start
  screen; the Product view and Conflicts are the perspective's frame and stay.
- **Build and Run** under Generate's Apply (`generate/run-panel.tsx`,
  `common/run-product.ts`, `node/run-support.ts`): `cargo build` and `cargo run
  -- --config config/<app>.yaml run` in two named terminals per product, the
  REST address with Open, and the linked-gears check. Cargo missing, or the
  MSVC linker on Windows, is said with a link instead of a terminal error (the
  session image has no Rust, so it says so there). A product whose gears need
  a database runs with `config/<app>.local.yaml`, the generated file plus a
  Postgres server (`127.0.0.1:5432`, user `postgres`, password from
  `GEARS_PG_PASSWORD`) and one database per gear; **Start a local Postgres**
  runs `postgres:18-alpine` in docker and creates them, only when asked.
- **From Gearbox Studio's refresh** ([constructorfabric/gearbox#14](https://github.com/constructorfabric/gearbox/pull/14),
  `139a18b`), frontend only -- no wire change, so it runs on the pinned engine:
  - The catalogue and Add Gear share one tree (`catalogue/catalogue-model.ts`,
    `catalogue-tree.tsx`): plugins grouped under their host's extension point,
    or flat, by the `gearbox.catalogue.groupPlugins` setting; search over
    names, ids, descriptions, scenarios and interfaces, which opens folded
    branches. The catalogue keeps Studio's own blocks (the listed corpus and
    **Bring the gears here**, failed roots, its diagnostics).
  - Add Gear writes the source alias the product declares, not the catalogue's
    directory name (`add-gear/product-source.ts`): a checkout under another
    folder name no longer fails with GBX0102. A git source keeps its id, which
    is the directory `node/git-sources.ts` brings it into. A plugin chosen
    under a host the product lacks adds that host in the same preview.
  - Diagnostics show errors and warnings first, information and hints folded,
    and the code, location and evidence under **Details**.
  - The Product view is one workspace: the product's name (Open another
    product), the profile, a **Product** menu (settings, Add profile, Recheck,
    Close, Open GDL), and four sections -- **Composition** (a searchable list of
    the selected gears, plugins folded, settings beside it, the product's
    summary before a choice), **Topology**, **Checks** and **Generate**.
    Overview is **Product settings**. The status strip with Apply and Discard
    stays under the name, in place of Gearbox Studio's bottom draft bar: one
    Apply. Generate is the Generate widget itself, attached in the section
    (`ProductWidget.mountGenerate`), so its Build, Run and Deploy come along;
    every command that showed the view opens the section. A pending draft
    blocks Generate's Apply.
  - Catalogue diagnostics are a screen beside Conflicts, opened from the
    Catalogue's count.
  - **Gearbox: Configure Sources** (`shell/configure-sources-contribution.ts`)
    chooses or clones a gears checkout into `gearbox.sourceRoots`; the
    catalogue hands it to the backend before each load
    (`useConfiguredRoots`), and an open reads it in place of a declared root
    this machine lacks. Never asked at start: the Catalogue offers it when it
    has no gears and no server to list them.
  - In a Gearbox perspective the window names the open product or gear
    (`shell/studio-window-title-updater.ts`); elsewhere the title is Theia's.
  - Not taken: Gearbox Studio's Windows packaging (the desktop's own installer
    does more) and its native title bar on Windows (to check on a Windows
    desktop: theirs could not be dragged by the custom frame).
- **Engine workarounds, each to go with the pin that fixes it:**
  - `node/sources-list.ts`: a product `product/create` wrote has no comma
    after its last source, and `add_source` appends without one (GBX0101).
    The list is closed first, guarded by the engine reading the product the
    same before and after. [gearbox#1](https://github.com/MikeFalcon77/gearbox/issues/1)
  - New Gear says that a scaffold is not catalogued until its code carries
    `#[toolkit::gear]` (GBX0211, then GBX0301 in a product), and where a
    corpus host's plugin has to be moved.
    [gearbox#2](https://github.com/MikeFalcon77/gearbox/issues/2)
  - The run configuration's database section.
    [gearbox#4](https://github.com/MikeFalcon77/gearbox/issues/4)
- **Tests:** `npm test` in this package runs the unit tests of the rules
  (`src/**/*.test.ts`, jest, Node; `*.test.tsx` under jsdom).
- **Not ported:** everything under Gearbox Studio's `browser/theia/` except
  the read-only `product.lock` editor, its layout migration, the Anthropic key
  settings and `@theia/ai-anthropic`, the AI connectivity check, the Fabric
  theme and fonts, the shell header, and Switch Product (never registered in
  Gearbox Studio either).

## Phases

| | | |
|---|---|---|
| P1 | this package, the engine service, every view reachable from View → Views | done |
| P2 | native GDL language, markers, completion and the catalogue checks on any `product.gdl`; `theia/gdl-language` leaves the image (kept as the plain VS Code client) | done |
| P3 | graph, inspector, lock, conflicts, generate verified in a session | done |
| P4 | start screen and the create/add wizards verified | |
| P5 | the `@Gearbox` chat agent and tools, through Studio's model (by mention; Codex stays the default) | done |
| P6a | the Gearbox perspective beside Workbench and Documents; `studio.openProduct` lands a portal product in it; the Inspector links a gear to its page in the portal's component catalogue (`studio.openComponent`) | done |
| P6c | gear projects: `new_gears` scaffolds carry the engine's `gear.gdl`, `studio.openGear` opens the project's gear, New Gear writes into the project's repository | done |
| P6b | the header's product half on the Product view (Apply/Discard, state, Resolve, Close), the Gearbox menu, screen scope inside the Gearbox perspective; the Fabric themes dropped | done |
| P7 | engine pin 55f7015 and the IDE changes since 3b64969; Build and Run after Generate | done |
