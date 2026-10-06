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

Decided on 2026-10-06: a project chooses, per repository, whether changes go
to the branch or through a pull request. The choice is made when the
repository is picked from a connection, and Share follows it from then on (see
[Through a pull request](#through-a-pull-request)).

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
| `review` | The branch refuses direct changes. The commit went to `studio/<person>/<yyyymmddhhmm>`, with *Ask for review* opening the host's pull-request link. Both GitHub's branch protection (`GH006`) and its rulesets (`GH013`, "Changes must be made through a pull request") count as refusing. In a project that shares through pull requests, the outcome is the plan rather than a refusal: see below. |
| `conflict` | "Someone changed the same part of … since you started. Nothing was sent yet." Each document has *Compare*, then *Keep my wording* / *Keep theirs* (`-X ours` / `-X theirs`). Everything else either side changed is kept. |
| `sign-in`, `offline` | What to do about it. |
| `failed` | A plain sentence, plus *Copy details* with git's text. |

Every commit Share makes is signed off as the person (`Signed-off-by`), so a
repository that checks DCO accepts the review that follows.

## Through a pull request

Some teams do not commit to their working branch at all. For them, the
project's record of the repository says so: `share_mode` in its entry of the
project config's `sources[]` (`cf.studio.project.config.v1`).

| `share_mode` | What Share does |
|---|---|
| `branch` (or absent) | Commits and pushes to the branch the project works on, as above. |
| `pull_request` | Sends the documents to the person's pull request. |

**Where it is chosen.** It is chosen when the repository is picked from a
connection. The choice is *Commit to the branch* (the default) or *Through a
pull request*, and there are two places to make it:

- **The portal's *Create project* wizard.** On the *Repositories* step, each
  picked row has a *Changes* column with the choice.
- **The prototype.** In *Pick from a connector…* and on the Sources tab,
  *Changes:* beside the *Add* button applies to the repositories being added.
  Its source list notes "shared through a pull request".

Pull requests are offered only for GitHub connections. GitHub's is the only
driver that can open them; for other providers the option is disabled.

**What a share does then.** Each person has one branch per repository,
`studio/<person>/share`, and at most one open pull request from it.

1. The IDE asks Studio how the repository is shared and whether the person's
   request is open: `GET /studio-connector/v1/sources/{source}/sharing?project_id=…&head=studio/<person>/share`.
   `source` is the repository's checkout folder, which is how the project
   names it. When Studio does not answer (no project behind the window, a
   repository the project does not list), Share goes straight to the branch,
   as before.
2. The documents and their `.studio` companions become one commit, built in an
   index of its own (`GIT_INDEX_FILE`) from the files as they are on disk. Its
   parent is the person's branch while the request is open, so the request
   grows by one commit. Otherwise (no request yet, or the last one was merged
   or closed) the parent is the base branch as the remote has it now, and the
   branch is replaced.
3. The commit is pushed to `studio/<person>/share`. **The checkout's own branch,
   its index and every working file stay as they were.** In a portal session,
   one checkout serves everybody, and a commit there that the team's branch
   does not have would come back at the next pull as a duplicate of the
   squash-merged request.
4. The IDE asks Studio to open the request, or to return the one already open:
   `POST /studio-connector/v1/sources/{source}/pull-requests?project_id=…`
   with `{ head, base, title, body }`. Studio opens it with the connection's
   token. Neither the portal session's browser nor the desktop holds that
   token.

The dialog says *This project takes changes through review*. The button reads
*Send N documents for review*, and *Open pull request* links to the request.
A document that is, here, exactly what the person's branch has is listed
under *In your pull request* and is not counted as unshared. It stays changed
in the checkout until the request is merged and the checkout pulls. If the
person edits it again, it is listed as unshared again.

If the commit arrived but the request could not be opened, the person is told
so. The branch is there, and the next share tries again.

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

- `document-share-service.test.ts` (real git, a bare remote; the pull-request
  road under *through a pull request*);
- `share-model.test.ts`;
- the backend's `project_sources` and `connectors` tests (`share_mode`, the
  two routes);
- the portal's `projects-mfe` wizard tests (the choice is saved).
- `assistant-reveal-guard.test.ts`;
- `markdown-preserve.test.ts`;
- `markdown-diff-git-service.test.ts` (`committedVersion`);
- product-ext's `md-rewrap.test.js`.

## Not done

- **Changing the mode of a repository already in a project.** It is chosen
  only when the repository is added. For now, edit `share_mode` in the
  project config.
- **Pull requests on GitLab and Bitbucket.** Their drivers cannot open one
  yet, so the portal offers the mode only for GitHub.

- **The desktop's Sync** pulls through the same check, but has not been driven
  in a built electron-app.
- **Who edited a document** comes from its Studio history. An edit made outside
  Studio's editors (a terminal, another tool) has no recorded editor, so it
  counts as the person's own and is ticked.
