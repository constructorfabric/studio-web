# Verifying the collaborative editing work

Twenty-three pull requests (#260–#282) put collaborative document editing into
the backend, the portal and the embedded IDE. This is how to check that they
actually work, in the order that makes a failure mean something.

The order matters more than usual here. **Identity is underneath everything
else**: if the IDE and the portal disagree about who you are, presence shows two
people where there is one, a comment is attributed to a stranger, "waiting on
you" waits on somebody who does not exist, and every later check fails for the
same single reason. So identity is checked first, and nothing downstream is
worth debugging until it passes.

---

## Layer 0 — are you even testing today's code?

`theia/product-ext` is hand-written JavaScript with **no build step**, which
makes it fast to change and easy to verify the wrong copy of. The session image
bakes it in, and `docker compose up` does **not** rebuild that image once the
tag exists — deliberately, it is a ten-minute build.

So a check that "fails" most often fails because the container is running
yesterday's file.

```bash
scripts/dev-up.sh          # warns when cf-studio-theia:local predates HEAD
docker compose build session-image   # when it does
```

And to be certain, ask the image rather than the checkout:

```bash
docker run --rm cf-studio-theia:local \
    grep -c 'studio-link-card' /home/theia/product-ext/src/browser/link-card-marks.js
```

A grep for something the change introduced answers "is my code in there" without
starting anything.

---

## Layer 1 — what a machine checks, in three seconds

Seven suites cover the logic the collaboration work added. They are plain
`node:assert`, no runner, no `node_modules`:

```bash
cd theia/product-ext
for t in identity collab-roster collab tasks element-anchor link-cards git-identity; do
    node test/$t.test.js || echo "FAILED: $t"
done
```

119 checks. What each one is actually defending:

| suite | the thing that would otherwise break silently |
| --- | --- |
| `identity` | a person having two identities, or an agent's write being applied as a person's |
| `collab-roster` | your own second tab showing up as a colleague; a ghost that never leaves |
| `collab` | the write claim, and "read just now ago" |
| `tasks` | `roma@example.com` producing an assignee called `@example.com` |
| `element-anchor` | an anchor that re-points every time a panel opens; an area that drifts on resize |
| `link-cards` | a card that names the wrong ticket — worse than a raw URL, because a raw URL is obviously a raw URL |
| `git-identity` | commits attributed to the container instead of the person |

The other ten suites in that directory need `jsdom`, which is not installed in a
plain checkout. They are not part of this work.

## Layer 2 — the backend gates

The thread counting (#265, #269) is Rust, and its tests want a PostgreSQL, so
they run in the image CI uses rather than against a local toolchain:

```bash
scripts/backend-check.sh test comment_threads   # 18 tests
scripts/backend-check.sh                        # fmt, clippy, build, features, test
```

**If the counts come back zero on a real repository**, check `TEXT_EXT` in
`artifact_ingest/clone.rs` includes `"jsonl"` before looking anywhere else. The
fold is correct whatever that list says, and silently useless without it — which
is exactly why the test for the extension lives next to the fold.

## Layer 3 — the prototype

The portal work (#267, #268, #270) is in `studio-frontend-prototype`, which is a
self-contained app with its own dependencies — not the workspace-and-packages
build that `studio-frontend` next door needs:

```bash
cd studio-frontend-prototype
npm ci && npm test        # vitest, 131 tests in 13 files
```

`work-inbox.test.ts` is the one that covers what is waiting on you.

Do **not** reach for `npm run build:packages` here: that belongs to
`studio-frontend`, the other application, and nothing in this work is in it.

---

## Layer 4 — the stand, with two people

Everything above is arithmetic. The product is two people in one document, and
that needs two identities. **Two tabs of the same account is not a second
person** — and proving that is itself one of the checks.

```bash
scripts/dev-up.sh
#   Portal:   http://localhost:8080
#   API/docs: http://localhost:8090/cf/docs
```

The realm ships with exactly the two people this needs, which is why no account
has to be created first:

| | username | password |
| --- | --- | --- |
| A | `admin` | `studio` |
| B | `demo` | `studio` |

Sign in as `admin` in your ordinary window and as `demo` in a private one.

Two files in this checkout are called `realm-studio.json` and they do not agree.
The one compose mounts is **`docker/keycloak/realm-studio.json`**, and it is the
one with `demo` in it; `keycloak/realm-studio.json` is the deployment's, whose
`admin` password is `change-me-on-first-login` and which has no second person at
all. If `demo` does not exist, that is which file came up.

Keycloak's own console is separate again — `admin`/`admin` on
<https://localhost:8443>, the bootstrap account, not a Studio identity.

### 1. Identity — the one that has to pass first

Sign in to the portal as A, open the IDE.

- **Expect**: the collaboration strip above the document tabs shows *your portal
  name*.
- **Fails as**: a generated or anonymous name; a name you are allowed to edit;
  the same human appearing twice in the roster.

The generated name is not cosmetic. It means the IDE did not adopt the portal's
`sub` and has minted a local identity, so everything below attributes to the
wrong person.

### 2. A commit is signed by the person who made it

In the IDE, change a file, commit it, then in the IDE's terminal:

```bash
git log -1 --format='%an <%ae>'
```

- **Expect**: your portal name and verified e-mail.
- **Fails as**: the container's default — or the error that started this work,
  *"Make sure you configure your user.name and user.email in git."*

### 3. Presence, and its expiry

Sign in as B in a private window.

- **Expect**: the portal shows both of you online, each with a way to be
  reached.
- Close B's window. **Expect**: B disappears within ~12 seconds (the TTL), on
  its own, with nothing clicked.
- Open a **second tab as A**. **Expect**: still one A. A second tab is not a
  colleague.

### 4. Co-editing, above the tabs

Both open the same document.

- **Expect**: each sees the other on the one-line strip *above the open document
  tabs* — not in a left-hand panel.

### 5. A hand-off between two browsers

A types and saves. Watch B.

- **Expect**: B's editor takes the change in place; B's caret keeps its
  position; a notice names A for about five seconds.
- **Fails as**: B's own unsaved edit vanishing, or the notice naming B.

Attribution here is content-keyed, not time-keyed, on purpose: it is what stops
an agent's write from being applied as a person's.

### 5a. What the colleague changed

Right after step 5, on B's side.

- **Expect**: the status line reads `A edited this` and is clickable; clicking
  opens a tab `<doc> (A's changes)` with the version B had before A started on
  the left and A's on the right, A's words marked
  ([rendered-markdown-diff.md](rendered-markdown-diff.md)). Two saves A made a
  second apart are **one** change there, not the last of them.
- After the status line has gone back to the save state, open History.
  **Expect**: A's entry has a *What changed* button that opens the same kind of
  comparison against the last different version.
- **Fails as**: "No changes" on A's entry — the history of a shared checkout
  records A's save twice (A's own entry and B's record of it), and the second
  must be compared past the first.

### 5b. Two people, one paragraph, the same moment

A types; a quarter of a second later B types in the same document, before A's
autosave lands.

- **Expect**: B's banner reads `A changed this on disk.` — the writer named,
  not just "Changed on disk." *Compare* heads the rail with
  `A's version (on disk) → your unsaved version`, and *Side by side* opens the
  two versions rendered with the same labels.
- With B in the Workbench (the WYSIWYG editor) instead: the conflict banner
  appears with *Side by side* beside *Compare*. Its columns say `On disk` — that
  editor has no co-editing client to ask who wrote it.
- **On a Windows bind mount** a workspace mounted from `C:\` is `9p` (drvfs)
  inside the container and delivers no file events. Both editors still notice,
  each through its own two-second poll — the WYSIWYG one since it got one; the
  banner then comes up to two seconds late. A Docker volume is what a portal
  session has, and the closer stand.

### 5c. Reading a proposal, and a colleague's suggestions, whole

- An unclaimed write (an agent's) lands while A has the document open.
  **Expect**: the proposal header has *Side by side*; it opens `Before ↔
  Proposed by assistant`, the edited words marked, rewrapped paragraphs counted
  as formatting, not edits.
- B switches to *Suggesting* and types. **Expect** on A's side, in the
  Suggestions section: *Side by side: B*, opening `Document ↔ B's suggestions`
  with only B's change. **Known**: A may need to reopen the document before B's
  suggestion is listed at all.

### 5d. What changed since you last looked

A opens the document and leaves (closes it, or the page). Something changes it.
A opens it again.

- **Expect**: a banner `Changed since you last looked (<when>)` with *See
  changes* and *Dismiss*. *See changes* opens the remembered version beside the
  current one. Either answer makes the current version the remembered one; no
  answer keeps the offer for next time.
- Another person, another browser: their own memory. Nothing of this is in
  `.studio/`.

### 5e. The discussions a change touches

With open threads in the document, open any comparison from the Documents
editor — *Last commit* is the simplest.

- **Expect**: a badge on each passage a thread quotes, in both columns; a
  **warning** badge on the left where the change removed a quoted passage (its
  tooltip: the discussion will lose its place); the summary counts them, e.g.
  `1 changed · 1 discussion on changed text · 1 would lose its place`.

### 5f. A colleague's branch

B's branch exists in the repository (pushed, or local in the shared checkout).

- *Compare with Branch or Tag... (Rendered)* on the document. **Expect**: the
  refs newest first with their author, then two questions. *Mine ↔ B's branch*
  shows how the document differs; *What B's branch changed* shows only B's
  edits since it branched off, not what happened on yours meanwhile.

### 5g. A pull while the document is open

A has the document open in Documents. B pushes an edit to it from elsewhere;
the shared checkout pulls (or A presses *Share with the team*).

- **Expect**: A's editor takes B's version as *B edited this document* (status
  line, history), `git status` shows nothing to commit, and no proposal.
- **Fails as**: the pulled paragraph vanishing from the file and a proposal
  waiting — the old behaviour, where the next share committed the file back.
- **Control**: write to the file by hand (`printf ... >>`). That is still held
  as a proposal and the file is put back.

### 5h. Two editors, one line

A edits a sentence in Documents and saves; B edits the same document in the
WYSIWYG editor (Workbench) and saves.

- **Expect**: `git diff --numstat` shows `1 1` after each save — tables, wrapped
  paragraphs and list bullets nobody touched stay as they were — and A's editor
  applies B's save as B's, with no proposal.

### 5i. Share with the team

A, who knows no git, edits two documents in Doc editing.

- **Expect**: the status bar says *2 documents not shared*; *Share with the
  team* (Team group) lists them, takes a sentence, and afterwards the commit is
  A's, carries only those documents and their `.studio` companions, and is on
  the remote; the tree is clean. On a protected branch it lands on
  `studio/<person>/<time>` with a link to open a pull request.
- **Fails as**: files A never opened appearing in the commit, or an editor of
  the pulled documents showing a proposal (see 5g).

### 5j. Share through a pull request

In the prototype, attach a GitHub repository to a project with *Changes:
Through a pull request* (*Pick from a connector…*), or switch an attached one
to it in the *Changes* column of the project's Sources list. In its session,
A edits a document and shares it.

- **Expect**: the dialog says the project takes changes through review; the
  button reads *Send 1 document for review*. Afterwards a pull request from
  `studio/<A>/share` into the source's branch is open, holding one commit that
  is A's, signed off, with only that document and its `.studio` files.
  `git log -1` and `git status` in the checkout are what they were before the
  share. Shared again, the document is listed under *In your pull request*
  and not counted in the status bar.
- **Then**: A edits it again and shares. The same request now has two
  commits. Merge it (squash), let the checkout pull, edit, and share. A new
  request opens, starting from the merged branch.
- **Fails as**: a commit on the checkout's own branch (the next pull would
  replay it), a second open request from the same person, or a request that
  carries the old commit after a merge.
- **Control**: a repository on *Commit to the branch* still shares as in 5i;
  switching it back there in the Sources list makes the next share go to the
  branch again.

### 5k. Committed in Source Control, sent through Share

On a source set to *Through a pull request*, whose branch refuses direct
pushes, A edits two documents and commits them in Source Control (once with
an empty message), then presses *Sync Changes*.

- **Expect**: the push is refused, and the checkout is two commits ahead. The
  Share button in the ribbon has a badge with the number of documents, and so
  does the status bar. Source Control has *Share with the Team* in its
  *Changes* title bar, which opens the same window. The window lists the
  committed documents as *committed here, not sent yet*, ticked, and *Send 2
  documents for review* is enabled. After sending, `studio/<A>/share` has one
  signed-off commit with those documents as they are on disk. The checkout's
  `HEAD` and the team's branch are unchanged. The badge and the status line
  are gone. An edit to one of those documents brings it back as unshared,
  while the others read *In your pull request*.
- **Fails as**: *Send for review* disabled with *A change you shared earlier
  has not reached the team yet*, the badge staying after the send, or a
  commit on the checkout's own branch.
- **Control**: on *Commit to the branch*, Share still pushes those commits
  as they are (5i). Source Control's own buttons behave exactly as before in
  both modes, and on the desktop its title bar has no Share button.

### 6. Commenting on something that was rendered

In rich view:

- comment on a **heading, a table, an image** — without selecting any text;
- **drag a rectangle** over an image and comment on that.

Then resize the window.

- **Expect**: the rectangle stays over the same part of the picture.
- Now make the element drastically taller than it was wide. **Expect**: it
  *asks for reattachment* rather than quietly sliding the rectangle onto
  something else.

### 7. A link that says what it is

On its own line in rich view, paste a pull request URL.

- **Expect**: a line above it reading `pull request · <owner>/<repo> · #<n>`.
- Paste `https://example.com/some/page`. **Expect**: nothing happens, and the
  URL stays editable. That is the whole fallback — there is no failure path to
  test, because an unrecognised link is a link.

Nothing is fetched. Disconnect the network and the cards render identically;
that is the design, not a cache.

### 8. A comment becomes a task, and the tasks are visible

- Turn a comment into a task in one click. **Expect**: it appears under
  `## Tasks` in the document, with an assignee, in the Markdown itself.
- Open the tasks view. **Expect**: yours first, then somebody's, then nobody's,
  then done.

### 9. The portal knows what is waiting on you

With threads in the repository, let ingest run, then open the project overview.

- **Expect**: what is waiting on you, on the overview — before any notification.

### 10. A run that finishes says so

Start background work, let it end, and stay in the IDE.

- **Expect**: the IDE says it finished, without a reload.

---

## What cannot be checked, because it was not built

**Notifications leaving Studio** — requirement §10, *"you shouldn't have to go
into the product to learn about comments"*. It is blocked on a decision between
a project channel, personal e-mail and a stored inbox, each of which adds a
subsystem rather than a function. `TASKS.md` carries it. Nothing in this
document covers it, and nothing should appear to.
