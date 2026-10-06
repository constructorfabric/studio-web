# Spec findings

What Studio reports about a specification document, where in the text it is,
and what a person can do with it.

Status: proposal, 2026-10-01. This iteration covers only what the Spec Quality
service already answers. Everything else is under [Later](#later).

## Why this exists

The Spec Quality detectors answer with far more than Studio keeps. Their raw
results carry line ranges, the passage itself, a reason and the model's evidence
(`gate.violations[]`, `sections[]`, `clusters[].occurrences[]`), and
`spec_quality/verdict.rs` throws all of that away, keeping one pass/fail and a
share. So the Specs list can say "2 findings", but nobody can see where they
are, a person cannot say "this is intended", and a re-run cannot tell a fixed
finding from a new one.

This iteration turns each detector answer into a list of **findings**, each one
placed in the text, and gives them a lifecycle.

## The catalogue

Every finding has a `rule`, which says what was caught and decides the default
severity.

| Rule | From | Catches | Severity | Anchor |
|---|---|---|---|---|
| `purpose.foreign_section` | `purpose` `gate.violations[]` | A section that reads as another document kind ("PRD section reads as DECISION") | high if `confidence` ≥ 0.9, otherwise medium | `line_start`–`line_end`, section |
| `purpose.not_a_spec` | `purpose` `mixture.other` | The document is mostly not specification content (spec share < 0.5, the prototype's `MIN_SPEC_SHARE`) | medium | the document |
| `leak.foreign_content` | `leak` `leaks[]` | A passage that reads as another kind (`reads_as`) than the declared type | high if `confidence` ≥ 0.9, otherwise medium | `line_start`–`line_end`, section |
| `bloat.cross_document` | `bloat` `clusters[]` | The same passage in two or more documents | medium | `line_start`–`line_end` and the passage per occurrence; the other occurrences as `related` |
| `bloat.self_repeat` | `bloat` `clusters[]` | A passage repeated inside one document | low | as above |

`message` is the detector's own `reason` where it gives one, and `evidence[]`
is its `evidence`. `leak` is always sent with `verify: false`
(`docs/upstream/spec-quality-issues.md` §1).

`traceability` produces no findings. In `extract` mode it finds zero pairs in
every set tried (`spec-quality-issues.md` §2), so there is nothing to place.

What the shapes are based on: the service's OpenAPI types `result` as a bare
`object`. The fields above come from real answers: the 24 stored
`spec_quality.analyze` runs on dev (23 `purpose`, 1 `bloat`), and live calls of
all three detectors through a local backend on 2026-10-01.

Checked against the files that run analysed:

- **Line numbers are right**, every time. For a `purpose` or `leak` section,
  `line_start` is the first line of its body, two lines below the heading.
- **`bloat`'s character offsets are not.** One occurrence in six matched its
  own passage, and one was two characters long for a 569-character passage. They
  are not read. A finding is placed by its lines, and `bloat`'s quote is found
  inside them with whitespace collapsed, because the service quotes a passage
  reflowed onto one line.
- **`bloat` reports a paragraph and a sentence inside it as duplicates of each
  other.** Occurrences in one file whose lines overlap are read as one passage.
- **The detectors are not deterministic.** The same PRD gave 16, 14 and 17
  findings in three runs. That matters for the lifecycle below.

That run on this repository's own documents, as a sample of what comes back:

| Case | Findings |
|---|---|
| `purpose`, `docs/prd/constructor-studio.md` as `prd` | 14–17 sections that read as design (the count differs run to run), each with lines, a reason and evidence |
| `purpose`, ADR-0019 as `adr` | 1: "8. The config read gets a cache" reads as design |
| `leak`, ADR-0019 declared as `prd` | 11–12 sections, confidence 0.98–0.99 |
| `bloat`, ADR-0016, 0018, 0019 | 2 passages shared by 0018 and 0019, 2 repeats inside 0018 |

## The finding

```jsonc
{
  "id": "3c9e…",               // the fingerprint, stable across re-runs
  "rule": "purpose.foreign_section",
  "detector": "purpose",
  "severity": "high",           // high | medium | low
  "message": "PRD section reads as DECISION (belongs in a decision doc, not a prd)",
  "anchor": {
    "section": "Requested change",
    "line_start": 59, "line_end": 69,
    "quote": null                // bloat gives the passage
  },
  "related": [ { "path": "docs/PRD.md", "anchor": { … } } ],
  "evidence": ["llm: Requests options and trade-offs for enabling/disabling TOC validation."],
  "confidence": 0.96
}
```

**The fingerprint** is a hash of the rule, the document path, the section and
the quote. Line numbers are deliberately left out: lines shift whenever someone
edits above the passage, and a dismissal must survive that.

## Recording, and analysis on sync

**The run records its own results.** Until now the Specs tab and the IDE's
Analyze panel each followed a run, read every verdict and posted a
`spec_finding` node back, so nothing was kept unless a tab stayed open to the
end, and an analysis nobody watched could not be kept at all. A
`spec_quality.analyze_batch` run whose payload names what each document is
(`record`: workspace, project, and per path the graph node, binding or Studio
document) records as each document finishes:

- the `spec_finding` node per detector per document, with `severity`,
  `summary` and `score` in the words the clients used, and the findings under
  `details.findings` in the same shape `/verdicts` answers;
- the gate verdict on the binding or Studio document that a stage reads;
- for `bloat`, a `duplicates` edge between the two documents of each pair.

`POST /studio-documents/v1/…/quality/{detector}` always asks for it. The
clients no longer write anything: a second write without `details.findings`
would replace the one the run made.

**On source sync.** A sync already reads every file and records each binding's
`content_sha`. The classification pass now also notes the typed documents
whose text is new or different, and queues `purpose` and `leak` for them and
`bloat` over every typed document the sync read, each recording as above.
Capped at `analyze_on_sync_max_documents` (50) per sync, skipped while Spec
Quality has no key, switchable with `gears.studio-documents.config.analyze_on_sync`.
A re-sync of an unchanged repository queues nothing.

Checked end to end on a local backend with the graph (2026-10-01): one
classification pass over three documents queued three runs, which recorded 9
`spec_finding` nodes with their findings and 9 gate verdicts within 25 s; a
second pass with one document changed queued `purpose` and `leak` for that
document only, plus `bloat`; a third with nothing changed queued nothing.

**Still to come**, after this iteration's UI step:

- **As intended.** Dismissing a finding by its id, kept for as long as the id
  keeps appearing. It needs storage that survives a re-run upserting the node,
  so a dismissal does not live inside the node.
- **Resolved needs the text to have changed.** The detectors are not
  deterministic, so a finding missing from one run of an unchanged document has
  not been fixed. Today a re-run replaces the node; with dismissals, a finding
  only becomes resolved when a run on a different `content_sha` does not
  report it.
- **Staleness.** Each finding's lines refer to the text that was analysed. When
  the document has changed since, the client finds the passage again, by quote
  or section, and shows the finding as stale when it cannot.

## Order of work

1. **The verdict carries findings** (#594). `GET /studio-spec-quality/v1/verdicts`
   returns `findings[]`.
2. **The run records them, and a sync starts it.** The Specs row counts and
   lists the findings.
3. **Theia.** Findings in the editor: the panel, Show in text, the underline,
   through the quality pipeline the Markdown editor already has
   (`product-ext/src/browser/quality-anchor.js`, `quality-marks.js`).
4. **As intended**, resolved and staleness, as above.

## Later

To discuss after this iteration:

- **Structure findings from our own template check.** Today `validate.rs`
  answers with strings and no positions: placeholders, missing, empty or short
  sections, front-matter, the title.
- **IDs and references across a project.** Duplicate IDs, dangling references,
  broken links. This is what `traceability` should have given.
- **A review against the kit's checklists.** The criteria in
  `documents/review/*/checklist.md` (#394), with proposed changes.
- **Asks of the Spec Quality service:**
  - result schemas in its OpenAPI;
  - character offsets that match the text, for `purpose` and `bloat`;
  - an overlapping passage not reported as its own duplicate;
  - the two defects in `spec-quality-issues.md`.
