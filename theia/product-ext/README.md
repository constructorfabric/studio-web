# studio-product-ext

The product surface over Theia: the Markdown editor, quality rail, flow rail and
log, figure and table editors, search, repositories and project views, comments
and tracked changes.

## These files are source

**`src/` is hand-written JavaScript. Edit it directly.** There is no TypeScript
behind it, no transpile step, no generator — what you read is what runs.

This directory was called `lib/` until now, and that name cost people real time:
`lib/` is where a Theia extension puts its `tsc` output, so the whole package
read as build artefacts and got skipped. The sibling extensions `studio/` and
`drawio-editor/` *are* TypeScript and *do* keep generated output in their own
`lib/` — which is why the ambiguity was worth removing rather than documenting.

The one exception is called out in its own header:

| file | how to change it |
| --- | --- |
| `src/browser/vendor/markdown-engine.js` | generated — edit `build/markdown-engine.mjs`, then `npm run build:engine` |

That is 206 KB of vendored remark/micromark bundled to CommonJS, out of ~2.3 MB
in the package. Everything else — all 68 files under `src/browser`, plus
`src/node`, `src/common` and `src/flow-mcp` — is written by hand.

## Layout

| directory | runs in | notes |
| --- | --- | --- |
| `src/browser` | frontend bundle | UI, editors, node views, stores |
| `src/node` | Theia backend | preview endpoint, viewer credentials, quality and flow backends |
| `src/common` | both | JSON-RPC service paths shared by the two sides |
| `src/flow-mcp` | its own process | zero-dependency stdio MCP server; see `REGISTER.md` |
| `build/` | build time | the markdown engine generator, and nothing else |
| `test/` | `node` | plain `node:assert` suites, no runner |

Entry points are declared in `package.json` under `theiaExtensions`; Theia's own
generator turns them into `browser-app/src-gen/*`.

## Working on it

```bash
npm test                     # all suites, no runner or browser needed
node test/node-views.test.js # one suite
```

To see a change in a running IDE, rebuild the frontend bundle from `theia/`:

```bash
npm run watch:browser
```

The session container bakes the bundle into the image, so a change reaches a
containerised session only on the next image build.

## Where this package comes from

`product-ext` is **vendored**. Upstream is `studio-desktop`'s `app/product-ext`,
which is itself vendored from `studio-internal` (see `SOURCE.json` there). Both
of those still spell the directory `lib/`.

So a change made only here is lost on the next sync. Land it upstream, or land
it here and port it deliberately — and when syncing, translate the path:
`app/product-ext/lib/…` upstream is `theia/product-ext/src/…` here. The only
code that cared about the spelling is `src/node/flow-backend.js`, which now
probes both.
