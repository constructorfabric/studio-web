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
| The Documents editor's conflict comparison — *Side by side*, beside *Close comparison* | the colleague's version on disk ↔ your unsaved version | Doc editing |
| The status line's `Alice edited this`, while it shows | what you had before Alice's saves began ↔ the document now | Doc editing |
| A History entry's *What changed* | the last different version before it ↔ that entry | Doc editing |
| The assistant's proposal header — *Side by side*, beside *Accept all / Reject all* | the base it was computed against ↔ what it proposes | Doc editing |
| The Suggestions section — *Side by side: Bob*, one per person | the document ↔ the document with only Bob's suggestions applied | Doc editing |
| The banner *Changed since you last looked* — *See changes* | the version you last had on screen ↔ now | Doc editing |
| *Compare with Branch or Tag... (Rendered)* — palette, explorer *Compare* group | your file ↔ the ref, or what the ref changed since it branched off yours | any |
| The desktop's Sync notification — *Show N changed documents* | each document before Sync ↔ after | desktop |

Every comparison opened from the Documents editor carries the document's open
discussions: a badge on each passage a thread quotes, a warning badge where the
change removed it, and both counted in the summary.

The tab follows both versions: when the file is saved or a commit moves HEAD,
the comparison is drawn again at the same scroll position. Its header has the
previous and next change, *Show only the changes* (each unchanged run folded to
one line, one block of context kept either side; a fold opens on click), *Open
as a text diff*, and *Read both versions again*. The strip beside the scrollbar
marks every change at its height in the document and scrolls there on click.

## With other people

The portal's session is one container per workspace with one checkout
(`product-ext/src/node/collab.js`), so two people in a document are two editors
over the same file, and the comparison is how one reads what the other did. What
the Documents editor hands the view is worked out in
`product-ext/src/browser/rendered-compare.js`, tested by
`test/rendered-compare.test.js`:

- **A colleague's save is one change, not one save.** Their editor autosaves
  about every second while they type, and each save is applied in place on your
  side. The change kept is the run: from the body you had before their first
  save to the body after their last, for as long as it is the same author,
  nothing of yours came in between, and no pause is longer than two minutes.
  The status line names them for five seconds and, while it does, opens that
  run.
- **A history entry's change is against the last different version**, not the
  previous entry. The history of a shared checkout is written by every editor
  open on it, so Alice's own "Edited" entry and Bob's "Alice edited this
  document" hold the same bytes one after the other; compared with each other
  they are "no changes". The button is not shown when nothing different came
  before.
- **A conflict names whose version is on disk** when co-editing knows — the
  claim a colleague's editor made for those bytes, the same one that lets a save
  be applied instead of held for review. The banner reads `Alice changed this on
  disk.` and the column `Alice's version (on disk)`. It is asked after the
  conflict is entered, so a slow or absent co-editing backend never delays
  keeping both versions; it only names one of them a moment later, or never.
  The WYSIWYG editor has no co-editing client, so its column stays `On disk`.
- **A proposal or a person's suggestions, read whole.** The review queue and the
  tracked page decide a change one hunk at a time; a long rewrite is also read.
  The assistant's proposal is its stored base beside its proposed body. A
  person's suggestions are `tracked-changes.js`'s `suggestedMarkdown` over that
  person's entries alone — the document as it would be if only they were
  accepted. One button per person, not per card.
- **Since you last looked.** The version you last had on screen is kept on your
  own machine (`localStorage`, beside identity: it is about what one person saw,
  not part of the shared `.studio/`) — when you save, close the document, or
  answer the offer. Opening it again when it is no longer that version shows
  *Changed since you last looked*; the offer is never opened by itself, and an
  unanswered one is made again next time. The key is the page's base URI as well
  as the file, because every portal session names its checkout `/workspace`.
  Documents over 200 000 characters are not kept.
- **Discussions.** `threadNotes` turns the document's open inline threads into
  notes (the quote, and the opener's name and first line); the view badges each
  cell holding a quote. A quote on the left and nowhere on the right is the edit
  taking the text a thread is anchored to — that thread will lose its place, and
  its badge and the summary say so (`1 would lose its place`). Resolved threads
  and component threads (no quote) are not carried.
- **A colleague's branch.** *Compare with Branch or Tag* lists the refs of the
  repository the document is in, newest first, through a small RPC
  (`common/markdown-diff-git-protocol.ts`, node side
  `node/markdown-diff-git-service.ts`) that runs git in the document's own
  directory — a portal session's checkout or any of a desktop project's clones.
  Then one of two questions: *Mine ↔ ref*, or *What ref changed* — the merge
  base against the ref, which is a pull request's view: their edits, without
  what happened on yours since. A picked ref that could read as a git option is
  refused.
- **What Sync brought (desktop).** Each member has their own clone there, so
  Sync is how a colleague's edits arrive. A fast-forward records HEAD before and
  after and the markdown files added or modified between them
  (`DesktopGitSync.brought`); the Sync notification offers them, and each opens
  as it was before Sync beside as it is now.

**Two editors format differently — and no longer write it.** The Documents
editor and the WYSIWYG one serialise markdown differently: line wrapping, table
padding, list bullets. Each now writes back the file's own lines for every
block that renders the same as before, so a save changes only what was edited:

- WYSIWYG: `preserveUnchangedBlocks` (`studio/src/browser/markdown-editor/
  markdown-preserve.ts`) cuts the file and the text being saved into the
  blocks this view compares, lines them up by their rendering, and keeps the
  file's spelling of every equal one. An edited or added list item takes its
  list's own bullet — `*` among `-` items would start a second list.
- Documents: `preserveWrapping` (`product-ext/src/browser/md-rewrap.js`)
  restores line breaks against the file on disk (it used to restore against its
  own serialisation, so nothing came back), and a table whose cells are all the
  same keeps its padding and delimiter row.

On the stand, Alice saving from Documents and then Bob from the WYSIWYG editor
change one line between them; before, 27 lines added and 79 removed for one
sentence. The view still counts formatting-only rows apart (`1 changed · 17
formatting only`) for files written by anything else.

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
    notes: [{ quote: 'quick brown', label: 'Alice: really?' }],  // optional: discussions to badge
});
```

`studio.markdownDiff.compareWithHead` takes a file `URI` and, optionally, a
second argument `{ notes }`. A text snapshot (`content`) lives as long as the
page; a tab restored with the layout after a reload says its snapshots are
gone instead of showing two empty columns. `compare` has no
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
- **Not driven in a built desktop app:** the Sync notification's *Show changed
  documents*. What it shows is covered — `desktop-git.test.ts` against a real
  remote, and the comparison of two `git:` revisions in the portal session —
  but not the click itself in electron-app. It needs a desktop build and a
  signed-in desktop session; see [desktop-studio.md](desktop-studio.md).

## Found on the way, not changed here

- **A colleague's suggestions appeared only after a reload** — fixed: a watch
  on a `.studio` folder that did not exist yet was inert, and a watch is not
  recursive by default (`product-ext/src/browser/watch-tree.js`).
- **The Documents editor held git operations for review** — fixed. A write
  nobody claimed became a proposal and the file was put back, and that included
  a `git pull` or `git checkout` in the shared checkout: the next share then
  committed the old text over the colleague's commit. Now a write whose content
  is exactly what a commit has for the file — HEAD, or the branch it follows
  while a pull is still moving it — is the commit author's edit, applied like a
  colleague's save (`studio.git.committedVersion`, answered by
  `MarkdownDiffGitService.committedVersion`). An agent's write or a hand edit
  equals no commit and is still held. The one write this lets through
  unreviewed is a revert to a committed version (`git checkout -- file`); the
  history keeps what was there before.
- **The WYSIWYG editor's saves were held as an agent's** in a colleague's
  Documents editor — fixed: it claims its writes like the Documents editor
  does (`studio.collab.claimWrite`).
- **Two serialisers** — fixed; see [With other people](#with-other-people).
- **The WYSIWYG editor now polls** (`EXTERNAL_POLL_MS`, every two seconds, file
  resources only, not while saving or hidden), as the Documents editor always
  did: on a workspace bind-mounted from Windows (`9p`/drvfs inside the
  container) there are no file events at all, and before this it never raised
  its conflict banner or took a colleague's save there.

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

Two people need two browser profiles, each named before the IDE boots (navigate
to `/favicon.ico`, set `localStorage` `studio-identity-name` and
`studio-identity-id`, then load the IDE), and a workspace on a **Docker
volume**, not a bind mount from `C:\` — see the limit above. The scenarios are
5a and 5b in [verifying-the-collaboration-work.md](verifying-the-collaboration-work.md).
