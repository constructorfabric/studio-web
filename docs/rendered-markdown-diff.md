# The rendered markdown comparison

Two versions of a markdown document, rendered and laid side by side, with what
was added, removed and reworded marked in the rendering rather than in the
source. It is for reading a change as a document: a rewritten section, a moved
paragraph, a table that gained a row. Deciding on a change — accepting or
rejecting a hunk of an AI proposal — stays where it was, in the Documents
editor's review queue.

The idea is [Markdown Diff Visualiser](https://github.com/arjuntic/markdown-diff-visualiser)
(MIT); the implementation is ours, in `theia/studio/src/browser/markdown-diff/`.
[What differs from the original](#what-differs-from-the-original) says why.

## Where it opens from

The same view, from every place two versions of a document meet:

| From | What is compared | Mode |
|---|---|---|
| The tab of a markdown file — the *Compare with HEAD (Rendered)* button, or the command of that name | the last commit ↔ the file | any editor that knows its file: the WYSIWYG editor, the text editor |
| The explorer's context menu, *Compare* group | the last commit ↔ the file | Workbench, Full |
| A text diff of two markdown versions — the *Open Rendered Diff* button on its tab (Source Control's changes, the timeline, any `vscode.diff`) | the two sides of that diff | any |
| The WYSIWYG editor's conflict banner — *Side by side*, beside *Compare* | on disk ↔ your unsaved version | Workbench |
| The Documents editor's History rail — *Last commit* in its head | the last commit ↔ the saved file | Doc editing |
| The Documents editor's History rail, two versions selected — *Side by side* | the older ↔ the newer version | Doc editing |
| The Documents editor's conflict comparison — *Side by side*, beside *Close comparison* | on disk ↔ your unsaved version | Doc editing |

The tab follows both versions: when the file is saved or a commit moves HEAD,
the comparison is drawn again at the same scroll position. Its header has the
previous and next change, *Show only the changes* (each unchanged run folded to
one line, one block of context kept either side; a fold opens on click), *Open
as a text diff*, and *Read both versions again*. The strip beside the scrollbar
marks every change at its height in the document and scrolls there on click.

## How a comparison is made

1. **Both versions are cut into blocks** by markdown-it's own block structure —
   paragraphs, headings, tables, code blocks, quotes, and each list item
   separately, because a list is where documents change most and one bullet
   added to twenty should not mark the whole list. Front matter is one block.
   Every block renders on its own and is still well-formed.
2. **The block sequences are diffed** (`diffArrays` from `diff`), by kind and
   text, trailing spaces ignored.
3. **Within each run of changes, removed and added blocks are paired.** A pair
   is two blocks of the same kind that share at least 35% of their words; the
   pairing is the order-preserving one with the most words in common (an LCS
   weighted by similarity), so an edited paragraph finds its counterpart even
   ten blocks into a rewritten section. A pair is *modified*. What no pair
   claims is laid out side by side as *replaced* — a removed block and an
   unrelated one that took its place — or as *added* or *removed* on its own.
4. **A modified block's words are marked on the rendered text.** Both blocks
   are rendered first, their text nodes read in order, the two texts diffed by
   words, and each changed range wrapped where it lies, across element
   boundaries if needed. Changes separated only by whitespace or one short
   word are joined into one mark, the rule `product-ext/src/browser/diff.js`
   applies to its line view. A block where most words changed is marked as a
   whole; one where the text is identical and only markup changed (a link
   target, a reformatted table) is marked with a dashed edge and no fill.
5. **Mermaid blocks are drawn**, both versions, and compared whole.

The view is one grid with one scrollbar: each row holds a block from each
version, so the columns stay aligned without synchronising two scroll
positions, and a block on one side only leaves a hatched cell on the other.

## Where the versions are read from

Each side is a Theia `Resource`, so anything with a resource resolver can be
compared:

- **A file** — `file:`.
- **A git revision** — `git:<path>?{"path":<fsPath>,"ref":<ref>}`, the address
  the built-in `vscode.git` extension reads through its file system provider:
  `HEAD` for the last commit, `~` for the index. Nothing of our own runs git;
  the comparison works wherever that extension runs, in the portal's session
  and on the desktop alike. The `fsPath` is spelt in the **backend's** path
  syntax (`OS.backend.isWindows`), not the browser's — a portal session opened
  from Windows would otherwise name a Linux file `\workspace\docs\spec.md`,
  which `vscode.git` cannot place in any repository.
- **A text** — a history entry, the unsaved side of a conflict. It is held in
  `InMemoryResources` (`memory://studio-markdown-diff/…`) for as long as its tab
  is open, and is gone after a reload.

A side that cannot be read — a file added since HEAD is not in HEAD — compares
as empty, and its column label carries the reason in its tooltip.

## Using it from another extension

The command `studio.markdownDiff.compare` takes a `MarkdownDiffRequest` and is
how `product-ext` opens the view without depending on the `studio` package:

```js
commandRegistry.executeCommand('studio.markdownDiff.compare', {
    title: 'spec.md (history)',              // optional
    left: { content: older, label: 'Monday' },     // or { uri: 'git:…' }
    right: { uri: 'file:///workspace/docs/spec.md' },
    base: 'file:///workspace/docs/spec.md',  // optional: relative images and links
});
```

`studio.markdownDiff.compareWithHead` takes a file `URI`. `compare` has no
palette entry; *Compare with HEAD (Rendered)* and *Open Rendered Diff* do, and
show where they apply. Inside `studio`, inject `MarkdownDiffService` instead.

## Security

The rendering goes into the IDE's own DOM, not a webview, so everything
markdown-it produces passes through DOMPurify, with inline styles, form
controls, frames and embeds removed as well — a document must not be able to
lay a fixed-position box over the workbench. Links do not navigate the IDE:
`http(s)` and `mailto` open through the opener service, relative paths open the
file, anchors do nothing. Relative images are read through the file service and
shown from blob URLs. Mermaid runs with `securityLevel: 'strict'`, and its SVG
goes through `sanitizeMermaidSvg`.

## Mermaid is the page's one copy

The WYSIWYG editor and this view load mermaid from the `mermaid.js` script that
both applications build beside `bundle.js` (`mermaid-entry.mjs`), exposed as the
global `studioMermaid` — the same script and global `product-ext`'s
`mermaid-view.js` uses (`markdown-editor-mermaid-render.ts`). It used to be
`import('mermaid')`, which esbuild inlines into the IIFE bundle: a second
mermaid, about 1.5 MB more in the first parse, and in Doc editing a render that
never settled. Render ids are unique in the page, because mermaid removes any
element that already has the id it renders under — another tab's diagram.

## What differs from the original

| | Markdown Diff Visualiser | Here |
|---|---|---|
| Unit | the line ranges of a `git diff` hunk, each range rendered separately — a changed table row renders as a fragment that is no longer a table | markdown-it blocks and list items, each well-formed alone |
| Input | git only, three fixed modes | any two resources or texts |
| Word marks | diffed on the source, then looked for in the rendered HTML — stops matching as soon as a block has markup | diffed on the rendered text nodes |
| Pairing | none: a run of changes is all removed, then all added | order-preserving best pairing by similarity |
| Alignment | spacer elements and two synchronised scroll positions | one grid, one scrollbar |
| Rendering | a webview behind CSP, markdown-it with its own highlight.js | the IDE's DOM behind DOMPurify, the diff editor's colours, the editor's mermaid |
| New dependencies | `diff`, `diff-match-patch`, `highlight.js`, `markdown-it` and two plugins, `parse-diff` | none new to the application: `diff` (already `@theia/scm`'s) and `@theia/monaco` are declared by `studio`; markdown-it and DOMPurify are Theia core's |

## Not done

- **No syntax highlighting** in code blocks, and **no KaTeX** — math shows as
  its source.
- **Images in both columns are the working tree's**: a revision's image is the
  image's own diff, not the document's.
- **Task lists** render as boxes, read-only.
- **The WYSIWYG editor's conflict banner did not appear on the verification
  stand** (2026-10-05, `cf-studio-theia:local` run standalone): with the editor
  dirty and the file changed outside, the banner never came, so its *Side by
  side* button is covered by a unit test only. The detection
  (`MarkdownEditorModel.syncExternalContents`) predates this work and was not
  changed; the Documents editor's conflict on the same stand worked end to end.

## Verifying

`npm test` in `theia/studio` runs `markdown-diff-model`, `-render` and `-uri`
and the editor suites. The end-to-end check that found the two bugs no unit
test could — the browser-side `fsPath`, and a diff editor's resource uri being
its modified side — is the hot-reload loop of the session image: copy
`theia/studio/src` and `theia/product-ext/src` into a container of
`cf-studio-theia:local`, `npx tsc -p .` in `/app/studio`, `npx theia build
--mode production` in `/app/browser-app` (about 12 s), reload, and drive the IDE
over CDP. Measure the DOM rather than trusting a build: `.studio-md-diff-row`
counts by kind, `.studio-md-diff-mermaid svg`, the summary text.
