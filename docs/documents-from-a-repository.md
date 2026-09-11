# Documents that were already in the repository

A Studio project acquires its documents one of two ways, and the difference
decides what the first move is.

**The repository was empty.** Nothing exists yet, so Studio creates the
documents: pick a type, get its template, fill it in by hand or by answering the
type's questionnaire (`documents/intake.rs`), and be judged against that type's
section checklist and rules. Publishing commits them back through a connection
(`studio-connector`, `POST …/connections/{id}/files`).

**The repository already had documents.** They were written before Studio ever
saw them, by people who never picked a type. Nothing can be validated until
something decides *which template each file was written against*. That is what
this describes.

Both paths end in the same place: a document, a type, and a conformance verdict
against that type's template.

## Where each of those lives in the portal

A workspace owns the catalogue and the authoring: document types, the journey's
stages and capabilities, and the documents written from those types before any
project has claimed one. A project's **Documents** tab is what its repository
actually contains — it reports, it does not author. A document reaches a project
by being written into its repository, and reaches that tab by being ingested and
identified; editing it is the IDE's job, because the file is in the repository
and that is where the repository's editor is.

That split is why the journey counts both (below): a project whose PRD has
always lived in its repository has a PRD.

## Where the content lives, and where it does not

The content stays in the artifact graph, where `studio-artifact-ingest` put it.
`studio-documents` records only a **binding**:

```
studio_document_bindings
  id            uuid5(tenant, project, node_id) — re-classifying is an upsert
  node_id       the artifact.file node holding the bytes
  path          kept locally so the review queue reads without the graph
  type_key      NULL while undetermined
  state         detected | confirmed | manual | unknown | not_a_document
  confidence    0.0–1.0
  source        front_matter | heuristic | spec_quality | manual
  candidates    what else it might be, with reasons
  conforms      + the full validation report
  content_sha   digest, so a stale verdict is distinguishable from a current one
```

Copying each `.md` into a second table would leave two versions of one file to
drift apart on every re-sync, and buy nothing. The project id is part of the
row identity, so the same graph node bound at workspace and at project level is
two bindings rather than a collision.

## Deciding what a file is

Three steps, cheapest first, each running only on what the previous one could
not settle (`documents/classify.rs`):

1. **Declared.** Front matter names the type (`type: prd`, `doc_type: …`,
   matching either a type key or its display name). Whoever wrote the file
   already answered the question; take the answer.
2. **Inferred**, offline and free. Score every candidate type on four
   independent signals — which of its *required* sections the file actually has
   (weight 0.55), what the path is called (0.20), what the title says (0.15),
   which required front-matter keys are filled (0.10; types requiring none give
   that weight back to sections). Accept the winner only if it scores ≥ 0.45
   **and** leads the runner-up by ≥ 0.08. Two types that score alike are
   ambiguous, and guessing between them is worse than asking.
3. **Detected.** For what is still undetermined, the portal runs the Spec
   Quality `purpose` detector (`classify_doc_type: true`, reads `doc_type` off
   the result). One LLM round-trip per document, so it runs only on the
   leftovers and only when asked.

Everything else is `unknown` with its candidates attached, which is the honest
answer. Scoring is derived from each type's own definition — key, name,
sections, rules — never from a hard-coded table of filenames, so a
workspace-defined type is detected on exactly the same terms as a built-in one.

## What a re-scan may overwrite

A classification run leaves a binding alone for two different reasons:

- **a person ruled on it** (`confirmed`, `manual`, `not_a_document`) — re-guessing
  would overwrite a decision, which is the one thing a background pass must
  never do;
- **Spec Quality answered it** — that verdict cost an LLM round-trip, and
  offline scoring already had its turn on that file and did not settle it.
  Discarding the expensive answer to re-run the cheap one that failed is
  strictly worse. The proposal still waits for a person.

Our own guess is exactly what a re-scan is *for*: improving a type's template
has to be able to change it. Either way the run refreshes conformance against
what the file says today.

## What a stage counts

A stage requirement is met by a document created in Studio **or** by a
repository file someone bound to that type — only one a person settled, never an
unreviewed proposal.

A stage's *gates* are met the same way from either side. A detector's verdict is
a row in `studio_document_analyses` whose subject is one or the other: a
document Studio holds, or a binding. Exactly one of the two columns is set,
which the database checks, and forgetting either subject takes its verdicts with
it.

That row is an **index**, not the record. The finding itself — detector, score,
raw result — lives in the artifact graph joined to the file node, which is what
survives and what the queue shows. The row answers the one question a gate asks,
cheaply: did this detector pass for this document. Walking the graph to answer
it, per stage, per requirement, is not the shape of that question.

Only `passed` opens a gate. Pending, failed, and anything this build cannot
interpret keep it shut, and verdicts never cross between the two kinds of
subject: a document's passing verdict says nothing about a repository file of
the same type.

## The person's ruling

`PUT …/document-bindings/{id}` takes one explicit action — `confirm` the
proposal, `set` a type outright, `reject` (this file is not a document), or
`reset` back to the queue. `source: spec_quality` is the one other source a
caller may claim, and it lands as a proposal rather than a decision. Pass
`content` to re-check conformance against the new type in the same call.

## When it happens

A sync classifies the prose it reads, as it reads it. That is the only moment
the whole repository's text is in hand, and doing it then is the difference
between a synced repository whose documents are known and one that merely has
files in it.

Neither gear can answer alone: `studio-artifact-ingest` walks the repository and
ends up holding every file's path and text; `studio-documents` owns the type
catalogue and decides what each file is. So the seam between them is a trait
this gear declares (`documents::port::DocumentClassifier`) and the ingest gear
calls — published on the ClientHub, because the documents gear stands down when
it has no database and a consumer that finds no client should simply not
classify rather than fail a repository sync.

Classification never fails the sync. The repository is ingested either way, and
the pass is idempotent, so a failure costs a re-run of the cheap half rather
than the clone.

The portal's **Scan repository** does the same thing on demand, for the
repositories that were synced before this existed and for a checkout the IDE
cloned after the fact.

## Why classification takes content in the request

The gear owns document types, not the graph. Keeping `classify` a pure function
of `(path, content, catalogue)` keeps it testable, keeps the graph the single
copy of the bytes, and means the caller — which already loaded the files to show
them — is not made to load them twice. The trade is batching: send a few dozen
files per call, not a whole repository.

## What ingesting this repository shows

Run against `docs/adr/*` and a few files that are not ADRs at all: every ADR
detected at 76% confidence, clear of the runner-up (`upstream_reqs`, 18%);
`README.md`, `TASKS.md` and `roadmap-alignment.md` correctly left undetermined;
`main.rs` and `docker-compose.yml` skipped as non-prose.

The conformance findings on those ADRs are worth reading, because they are the
point of the exercise: every one is missing a `## Status` section and a
`status:` front-matter key. This repository's ADR convention genuinely differs
from the built-in `adr` template — which is a workspace's cue to override the
type (ADR-0014 makes that a catalogue edit), not a defect in the documents.
