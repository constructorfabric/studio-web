# Agent briefs

`scripts/prepare_review.py` renders the architecture, slice and single-agent briefs from the plan — send those
files as-is. Their text lives in that script (`RULES` for every reviewer, `ARCH_BODY`, `SLICE_BODY`, and
`followup_block` for rounds after the first), so every agent gets the same instructions and quality doesn't
vary between slices or between PRs. The verifier brief below is filled by hand, since it depends on what the
reviewers found.

All agents: `subagent_type: "general-purpose"`, `model` set explicitly (see SKILL.md).

## Findings format (all agents write this)

A JSON array to the given path:

```json
[
  {
    "id": "arch-1",
    "severity": "blocker | major | minor | nit",
    "category": "bug | architecture | spec | traceability | duplication | conventions | smell | tests",
    "file": "path/relative/to/repo.ts",
    "line": 42,
    "start_line": 38,
    "side": "RIGHT",
    "title": "One-line statement of the problem",
    "body": "The comment exactly as it would be posted: problem → why it matters → suggestion.",
    "failure": "blocker/major only: the concrete sequence — input or state → wrong result.",
    "verify": "One line: a command, a test name, or a short manual sequence that shows the problem.",
    "preexisting": false,
    "evidence": "What you checked: spec quote with path, caller location, existing function path, reproduction.",
    "confidence": "high | medium"
  }
]
```

- **Severity is about behaviour.** `blocker` / `major` only for broken behaviour, and only with `failure` filled
  in; `merge_findings.py` lowers anything else to `minor`. Missing tests, traceability (`cfs`, `@cpt`, FEATURE
  docs), duplication, conventions and smells are `minor` ("should fix") at most. `nit` is optional polish.
- **Every finding is posted inline.** `line` is a line in the **new** file (side `RIGHT`) on a changed line of a
  file in the diff; use `side: "LEFT"` with the old line number only for removed code. `start_line` is optional,
  for multi-line ranges. If the root cause is in unchanged code, anchor on the changed line that exposes it and
  name the other location in the body. PR-wide points (no e2e for the new flow, missing ADR) anchor on the most
  relevant changed line. Nothing lives only in the review summary.
- `verify` ends every comment as "**How to verify:** …". Prefer a runnable command or the name of the test that
  fails; for a UI bug, the click sequence.
- `preexisting: true` only in a follow-up round, for a behaviour bug in code that already existed at the last
  reviewed head. The comment is labelled "pre-existing at `<sha>`, not raised in round N".
- Claims about `cfs validate` come from `cfs-validate.md` only — quote it, never predict it.
- Don't report low-confidence guesses. If you couldn't verify something, either verify it or leave it out.
- An empty array is a valid result.

## Reproduction tests

One vitest file per behaviour finding, at `<workdir>/repro/<short-name>.test.ts` (`.tsx` for components).
`scripts/repro_tests.py` copies it into the worktree, runs it sandboxed and removes it again.

```ts
// repro-for: slice-3:s3-1                 ← the finding id from merged.json
// place: src-app/app/routing              ← directory under studio-frontend/ it runs in (imports resolve from there)
import { describe, expect, it, vi } from 'vitest';
…
describe('repro: <finding title>', () => {
  it('control: <the closest case that works today>', () => { … });   // must pass
  it('<the expected behaviour the finding says is broken>', () => { … });  // must fail on an assertion
});
```

- **Assert the correct behaviour** (from the spec/ADR/the finding), so the bug test *fails* on this head and
  would pass once fixed. Never assert the buggy output.
- **A control case is required**: the nearest variant that works (the same flow with the value the existing
  tests use, a sibling path). It proves the harness is right; a failing control marks the file `broken`.
  The benchmark on #380 caught exactly this: a history-length control failed because an earlier test had
  left forward entries — without it, a broken test would have "confirmed" the bug.
- Put controls first; keep tests independent of order (jsdom's `window` is shared within the file).
- Reuse the repo's harnesses instead of inventing mocks: copy the `vi.hoisted` / `vi.mock` block and `setup()`
  of the sibling test (`materialize.test.ts`, `appContextEffects.test.ts`, …), `@frontx-test-utils/*`
  (`freshNavigationHistory`, `screenFixture`, `createMfeBridgeFixture`). Mock only what the finding is not
  about; for a flow across modules, wire the real ones (real `startRouting` + real effects over jsdom history).
- No network, no timers longer than `setTimeout(r, 0)`, no snapshots, no changes to tracked files.
- Title the bug test with the expected behaviour; its failure message is quoted in the comment.

## Verifier agent

```
You are verifying review findings for GitHub PR #<N> in <owner/repo> before they are posted.
Do not spawn subagents. Do not modify tracked files, commit, or post anything to GitHub (writing under
<workdir> — verdicts, reproduction tests — is expected).

Worktree at the PR head: <workdir>/tree  (base branch: <base>)
Context pack: <workdir>/context.md
Findings to verify: <workdir>/findings/to_verify.json

For each finding, open the cited location and the evidence and decide:
- confirmed — the problem is real and the comment is accurate;
- downgraded — real but less severe than stated (give the new severity);
- rejected — wrong: the code handles it, the caller never does that, the spec says otherwise,
  the "duplicate" is not actually equivalent, or the finding is noise.
Also check:
- blocker/major: `failure` is a real, reachable sequence (walk it through the code); otherwise downgrade;
- `line` is a changed line in the diff that shows the problem;
- `verify` is a real command/test/sequence that would show it; fix or write it if not;
- claims about `cfs validate` match `<workdir>/cfs-validate.md` word for word — strike anything it doesn't say;
- `preexisting: true` findings really existed at the last reviewed head (`git -C <tree> show <since>:<path>`);
- the body doesn't overstate; fix it if it does.

Known points needing a decision:
<contradictions between reviewers and likely duplicate pairs noted by the orchestrator; settle each
against the code and the base branch (`git -C <tree> show <base>:<path>`) rather than picking a side>

Be adversarial: the cost of posting a wrong comment is higher than missing a minor one.

For every blocker/major and every `bug` finding you confirm (at most 6, biggest first), also write a
reproduction test to <workdir>/repro/ following .claude/skills/studio-frontend-review/references/agent-briefs.md,
"Reproduction tests", then run `python3 .claude/skills/studio-frontend-review/scripts/repro_tests.py <workdir>`
and read findings/repro.json: fix a `broken` file once and re-run; if a finding is `not-reproduced`, check
whether your test really exercises the path — fix and re-run once, else reject the finding.

Write <workdir>/findings/verified.json: the same array, each item with added fields
"verdict" (confirmed | downgraded | rejected | duplicate), "verdict_reason", "duplicate_of" for
duplicates, and (if changed) updated "severity" / "body" / "line" / "verify".
```

When open threads need re-checking (SKILL.md step 4) and there are more than 8 of them, append to the same
verifier brief: `Also re-check the threads with needs_recheck: true in <workdir>/open-threads.json: for each,
say fixed | not fixed | disputed-and-right | disputed-and-wrong, with the line that shows it. Write
<workdir>/findings/threads.json: [{"comment_id", "status", "evidence"}].`
