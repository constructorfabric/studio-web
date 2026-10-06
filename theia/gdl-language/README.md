# gdl-language

> **Not shipped in the session image.** Since P2 of
> [`gearbox-studio`](../gearbox-studio/README.md), the session IDE has the `.gdl`
> language natively: the grammar, the engine's diagnostics, completion and hover,
> and the catalogue checks on any `product.gdl`. They run on the same engine
> process as the Gearbox views, so the editor and the Product and Conflicts views
> share one state. This package is kept as the plain VS Code client for places
> that have no Theia: desktop VS Code, a future Electron build without
> `gearbox-studio`, and Codespaces. It still builds and tests on its own
> (`npm ci && npm test && npm run build`), and nothing builds it into
> `theia/Dockerfile`. It should not be installed next to `gearbox-studio`: two
> registrations of the `gdl` language and two engines would mark every file
> twice.

`gear.gdl` and `product.gdl` in VS Code: highlighting, plus diagnostics,
completion and hover from [Gearbox](https://github.com/constructorfabric/gearbox).

The engine is the language server. `gearbox rpc --stdio` answers LSP
`initialize`, `didOpen`/`didChange` with `publishDiagnostics` (the `GBX…` codes of
[gdl.md](https://github.com/constructorfabric/gearbox/blob/main/docs/gdl.md)),
`completion` and `hover`. This extension starts it and lets
`vscode-languageclient` carry the protocol; it has no GDL semantics of its own.

- **Where it runs.** The extension host (node), as an ordinary VS Code extension.
  It needs the engine on the PATH or in `gearbox.gdl.enginePath`; the session
  image builds one at a pinned commit (`STUDIO_GEARBOX_REF`) for `gearbox-studio`.
- **Source roots.** The repository around each `gear.gdl` in the workspace
  (nearest `.git`), not the workspace folder: a managed workspace is a container
  of checkouts, and the engine should see each as its own source.
  `gearbox.gdl.roots` overrides it.
- **No engine, no server.** A missing binary leaves highlighting working and
  says why in the `GDL` output channel.

`syntaxes/gdl.tmLanguage.json` is generated from Gearbox's
`ide/gearbox-studio/src/browser/gdl/gdl-grammar.ts` at the same commit, whose
word lists are themselves generated from the engine's globals. Regenerate it
when `STUDIO_GEARBOX_REF` moves.

```sh
npm ci && npm test && npm run build
```
