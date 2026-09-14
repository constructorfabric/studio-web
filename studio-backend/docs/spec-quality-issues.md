# spec-quality issue drafts (found wiring the detectors into Studio, 2026-09-11)

Ready to send to whoever owns the spec-quality service. Both were hit building
the Documents queue, which runs the detectors over a project's real
repository files and records the verdicts against each document. Reproduction is
deterministic and needs nothing but the service — every response below came from
`POST /v1/analyze/*` through our wrapper with a document this repository
contains.

Neither is a blocker for us: we work around both, and the workarounds are in the
code with these numbers next to them. They are filed because the workarounds are
worse than the fixes, and because anyone else integrating will hit them.

---

## 1. `leak` verification clears true positives, and is on by default

`POST /v1/analyze/leak` takes a `verify` flag. Omitting it behaves as
`verify: true`, and in that mode the detector does not discriminate at all.

Two documents of known kind, each declared correctly and then incorrectly:

| document | `doc_type` sent | `verify` | `passed` | `leak_share` |
|---|---|---|:--:|---:|
| a design contract | `design` | false | yes | 0.00 |
| a design contract | `adr` | false | **NO** | 0.68 |
| a design contract | `prd` | false | **NO** | 1.00 |
| a real ADR | `adr` | false | yes | 0.00 |
| a real ADR | `prd` | false | **NO** | 0.99 |
| a real ADR | `design` | false | **NO** | 0.99 |
| a design contract | `adr` | **true** | **yes** | **0.00** |
| a design contract | `adr` | **omitted** | **yes** | **0.00** |

Unverified, the answer is exactly right: the same file passes as `design` and
fails as `adr` or `prd`, and the share tracks how wrong the declared type is.
Verified, every one of those passes — including an ADR read as a PRD whose raw
share is 0.99, with five sections the classifier marked `belongs: false` at
confidence 0.98.

So the verification pass is discarding candidates the classifier was nearly
certain about, and the default hides it.

**Why it matters to a consumer.** A gate wired to the verified answer opens for
everything while looking like it has checked. We found this only because we
tried to make the check fail on purpose and could not — the first several
probes, on genuinely mixed documents, came back clean and nearly shipped as a
working gate.

**Reproduce**

```bash
# same document, same declared type, three verify settings
for V in '"verify": false' '"verify": true' ''; do
  curl -s -X POST "$BASE/v1/analyze/leak" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"text\": $(jq -Rs . < docs/theia-bridge-contract-v1.md),
         \"path\": \"docs/x.md\", \"doc_type\": \"adr\",
         \"gate_threshold\": 0.05 ${V:+, $V}}"
done
# verify=false  -> passed=false, leak_share=0.716, 5 leaks
# verify=true   -> passed=true,  leak_share=0.0,   0 leaks
# omitted       -> passed=true,  leak_share=0.0,   0 leaks
```

**Ask.** Either the verification prompt is too permissive and should be tuned,
or `verify` should default to `false` — but the two cannot both stay as they
are, because the default currently answers "clean" for every document we have
tried.

**Our workaround.** `detectLeak` sends `verify: false`, with this table in the
comment (`studio-frontend-prototype/src/spec-quality.tsx`).

---

## 2. `traceability` in `extract` mode finds no pairs, whatever the notation

`POST /v1/analyze/traceability` with `mode: "extract"` returns `n_pairs: 0` and
`pairs: []` for every document set we could construct, including sets in the
canonical layout the service's own error message names (`PRD.md`, `DESIGN.md`,
`ADR/0001-x.md`, `features/y.md`) with explicit identifiers referenced across
documents.

Four notations tried, two documents each — a `PRD.md` declaring an identifier
and a `DESIGN.md` referring to it:

| how the reference is written | `docs_used` | `docs_ignored` | `n_pairs` |
|---|:--:|:--:|:--:|
| `REQ-1: …` / `Implements REQ-1 …` | 2 | 0 | **0** |
| `[REQ-1] …` / `Implements [REQ-1] …` | 2 | 0 | **0** |
| front matter `id: REQ-1` / `traces: REQ-1` | 2 | 0 | **0** |
| `REQ-1: …` / a `traces: REQ-1` line | 2 | 0 | **0** |

Both documents are reported as **used** and none as ignored, so the set is being
read — it simply yields no pairs.

`mode: "classify"` then consumes that empty extraction and answers
`passed: true`, `n_pairs: 0`, `verdicts: []`, `counts` all zero. So the drift
check reports success on a set it has not compared.

**Why it matters to a consumer.** There is nothing to act on: no relation to
store, no per-document verdict to gate on, and a `passed` that means "nothing
was compared" rather than "nothing is wrong". We would like to record
`traces_to` relations in our artifact graph and open stage gates on drift, and
can do neither.

**Ask.** Either document the identifier notation `extract` recognises — if these
four are all wrong, the right one is not discoverable from the error messages or
from the shape of the response — or fix the extraction. And, separately:
`classify` should not answer `passed: true` when `n_pairs` is zero; "nothing
compared" is not "no drift".

**Our workaround.** None. `traceability` is offered in the Analyze tab and is
deliberately not wired to any stage gate, because there is nothing to wire.

---

## Not an issue: `purpose` always names a type

Recording it here because it looks like one and is not. `doc_type` is not an
opinion the classifier can decline to have — it returns one of the types it
knows whatever it is handed, so a task list and a roadmap both come back
`decomposition`. The evidence for the answer is `mixture`: its `other` share is
the part that is not specification content, and `1 - other` separates real
specifications (0.72–0.99 in our sample) from files that are not one
(0.00–0.35). We gate on that and it works.

Worth a line in the API docs, though: a consumer reading `doc_type` alone will
believe it.
