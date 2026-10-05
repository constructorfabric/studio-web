# Sharing documents without git

The people who write specifications in Studio are mostly managers. They edit
documents, and git, branches and pull requests are not their concern. This note
covers what was built so that what they edit reaches the repository with one
button, changes only what they edited, and does not undo a colleague's work
along the way. It also covers why the assistant panel no longer opens by
itself.

Decided on 2026-10-05:

- changes go straight to the branch the project works on, and to a branch of
  their own only when that one refuses them;
- in a portal session (one checkout for everybody) a person shares the
  documents *they* edited;
- sharing is a prominent button, never automatic.

## Share with the team

In Doc editing, the *Team* group of the mode bar has **Share with the team**.
The status bar keeps the count in view: *2 documents not shared*.

The dialog lists the documents not shared yet, by their first heading. The
ones the person edited are ticked. A document with no recorded editor (edited
in the text editor, or on the desktop, where a clone is one person's) counts as
theirs. Documents only colleagues edited are listed apart, under *Edited by
others*, and are left for those colleagues to share unless ticked. It asks for one sentence ("What changed?") and has
*See changes* beside each document, which opens the
[rendered comparison](rendered-markdown-diff.md) against the last shared
version. Unsaved edits are saved first.

What a share does (`theia/studio/src/node/document-share-service.ts`, through
the same git runner as the desktop's Sync and Push, so credentials are what
they already are):

1. Stages the chosen documents and their `.studio` companions (comments,
   suggestions, history), and nothing else that happens to be changed in the
   checkout.
2. Commits them as the person. Colleagues recorded as editing the same
   documents go in as `Co-authored-by`.
3. Fetches, and rebases only if the branch is behind. `pull --autostash`
   rewrote working files that were open in editors, so it is not used.
4. Pushes.

Outcomes are said in words, not in git's:

| Outcome | What the person sees |
|---|---|
| `shared` | Shared with the team. |
| `review` | The branch refuses direct changes. The commit went to `studio/<person>/<yyyymmddhhmm>`, with *Ask for review* opening the host's pull-request link. |
| `conflict` | "Someone changed the same part of … since you started. Nothing was sent yet." Each document has *Compare*, then *Keep my wording* / *Keep theirs* (`-X ours` / `-X theirs`). Everything else either side changed is kept. |
| `sign-in`, `offline` | What to do about it. |
| `failed` | A plain sentence, plus *Copy details* with git's text. |

## A save changes only what was edited

The Documents editor and the WYSIWYG editor each write markdown with their own
serialiser. Both now write back the file's own lines for every block that
renders the same as before, so a one-sentence edit is a one-line diff. Before,
a single edit could rewrite a whole document (27 lines added and 79 removed,
then reformatted again by the other editor). Details:
[rendered-markdown-diff.md](rendered-markdown-diff.md#with-other-people).

## What git writes is the repository's, not a proposal

The Documents editor holds a write nobody claimed for review. That is how an
agent's edit becomes a proposal instead of the live document. It used to catch
git too: a pull, or a share that brought a colleague's commit, was held as a
proposal and the file put back. The next share then committed the old text over
the colleague's commit, and nobody saw it happen.

Now there are three kinds of write:

- **Content that equals a commit's version of the file** is applied as that
  commit author's edit, like a colleague's save. "Commit" means HEAD, or the
  branch HEAD follows while a pull is still moving HEAD. The check is
  `studio.git.committedVersion`, answered by
  `MarkdownDiffGitService.committedVersion`.
- **The WYSIWYG editor's saves** are claimed (`studio.collab.claimWrite`), so a
  colleague's Documents editor applies them as that person's.
- **An agent's write or a hand edit** equals no commit and is still held for
  review.

## The assistant panel does not open by itself

Claude Code, Codex and AI Chat each add a view to the right flank. Their views
arrive after the layout is built, and the newest one used to take the
selection, so opening a document met a sign-in page for a tool nobody asked
for.

`AssistantRevealGuard` (`theia/studio/src/browser/assistant-reveal-guard.ts`)
undoes a reveal nobody asked for. If the flank showed a tab before, that tab
comes back; if it showed none, the flank folds. Asking for an assistant means a
click in the right flank, or a command that opens an assistant (*Claude Code:
Open*, the Agents button, a seeded question). Startup, plugin registration and
mode switches are not requests. After 8 interventions in one page load it
stands aside rather than fight a plugin.

## Checking it

The checks are 5g–5i in
[verifying-the-collaboration-work.md](verifying-the-collaboration-work.md).
Unit tests:

- `document-share-service.test.ts` (real git, a bare remote);
- `share-model.test.ts`;
- `assistant-reveal-guard.test.ts`;
- `markdown-preserve.test.ts`;
- `markdown-diff-git-service.test.ts` (`committedVersion`);
- product-ext's `md-rewrap.test.js`.

## Not done

- **The desktop's Sync** pulls through the same check, but has not been driven
  in a built electron-app.
- **Who edited a document** comes from its Studio history. An edit made outside
  Studio's editors (a terminal, another tool) has no recorded editor, so it
  counts as the person's own and is ticked.
