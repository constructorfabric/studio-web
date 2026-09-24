# Agent briefs

`scripts/prepare_review.py` renders the architecture, slice and single-agent briefs from the plan — send those files as-is. The templates below are the reference for what they contain, and the verifier brief (which you fill by hand, since it depends on what the reviewers found). The point is that every slice agent gets the same instructions, so quality doesn't vary between slices or between PRs.

All agents: `subagent_type: "general-purpose"`, `model` set explicitly (see SKILL.md).

## Findings format (all agents write this)

A JSON array to the given path:

```json
[
  {
    "id": "arch-1",
    "severity": "blocker | major | minor | nit",
    "category": "architecture | spec | bug | duplication | conventions | smell | tests",
    "file": "path/relative/to/repo.ts",
    "line": 42,
    "start_line": 38,
    "side": "RIGHT",
    "title": "One-line statement of the problem",
    "body": "The comment exactly as it would be posted: problem → why it matters → suggestion.",
    "evidence": "What you checked: spec quote with path, caller location, existing function path, reproduction.",
    "confidence": "high | medium"
  }
]
```

- `line` is a line number in the **new** file (side `RIGHT`) for added/changed code; use `side: "LEFT"` with the old line number only when commenting on removed code. `start_line` is optional, for multi-line ranges.
- For PR-wide findings without a single location (e.g. "no e2e for the new flow", "missing ADR"), set `file` to the most relevant file and `line` to `null`.
- Don't report low-confidence guesses. If you couldn't verify something, either verify it or leave it out.
- An empty array is a valid result.

## Architecture / spec agent

```
You are reviewing the architecture and spec conformance of GitHub PR #<N> in <owner/repo>.
Do not spawn subagents. Do not modify files, commit, or post anything to GitHub.

Worktree at the PR head: <workdir>/tree  (base branch: <base>)
Context pack (read first): <workdir>/context.md
Checklist (read first): .claude/skills/studio-frontend-review/references/checklist.md
Findings format: .claude/skills/studio-frontend-review/references/agent-briefs.md, section "Findings format"

Your scope is the PR as a whole, at the structural level — slice reviewers are handling line-level bugs,
so do not do a line-by-line pass. Focus on checklist section 1 (architecture and spec conformance),
PR-wide test coverage (does a new major flow have an e2e test?), duplication across the PR or with
existing code in the repo, and file structure (checklist section 4: do the new files land where files of
that kind already live?). Code-pattern conventions inside files are the slice reviewers' job.

How to work:
1. Read the spec documents listed in the context pack. Note the requirements and decisions relevant to this PR.
2. Get the structural picture: `git -C <workdir>/tree diff --stat <base>...HEAD`, new files/directories,
   changed public interfaces (exports, routes, schemas, contracts, events, error codes).
3. Read the diffs of the structural files: `git -C <workdir>/tree diff <base>...HEAD -- <paths>`.
4. For each requirement/decision, check the code honours it. Look for boundary violations and new
   patterns that diverge from existing ones (search the repo to find the existing pattern).
5. For every new file and directory, find where existing files of the same kind live and how they are
   named; report placement/naming that breaks the dominant layout.

Write findings to <workdir>/findings/architecture.json. Finish with a 3–5 sentence summary of the
architectural shape of the PR and your overall assessment (this goes into the review summary).
```

## Slice agent

```
You are reviewing slice <k> of <total> of GitHub PR #<N> in <owner/repo>.
Do not spawn subagents. Do not modify files, commit, or post anything to GitHub.

Worktree at the PR head: <workdir>/tree  (base branch: <base>)
Context pack (read first): <workdir>/context.md
Checklist (read first): .claude/skills/studio-frontend-review/references/checklist.md
Findings format: .claude/skills/studio-frontend-review/references/agent-briefs.md, section "Findings format"

Your slice (review every changed line of these files):
<file list with +/- counts; for split files add "lines <a>-<b>" from the plan>

A file marked "lines a-b" is shared with another slice: review only the changed lines in that range
of the new file, but read the rest of the file as needed for context.

Other slices cover the rest of the PR; the full file list is in the context pack. Another agent covers
PR-wide architecture, but if you see a spec or architecture problem in your files, report it.

How to work:
1. Read the diff of your files: `git -C <workdir>/tree diff <base>...HEAD -- <files>`.
2. For each changed file, open the full new version when the diff alone doesn't show enough context.
3. Go through the checklist sections in order for every file. Before reporting a bug, check the callers.
   Before reporting duplication, search the repo for the existing implementation and name it.
4. For conventions (checklist section 4), open 2–3 existing sibling files of the same kind first and
   note how they are written; confirm a pattern is dominant with an `rg` count before reporting a
   deviation. One finding per deviating pattern, listing all places in your slice.
5. For tests, apply the checklist's testing philosophy — ask for tests of logic, not of markup.

Write findings to <workdir>/findings/slice-<k>.json. Finish with one or two sentences on the overall
quality of your slice.
```

## Single agent (small PR)

Use the slice brief with slice = all files, and append the architecture agent's steps 1, 4 and 5 plus its
summary instruction. Findings path: `<workdir>/findings/single.json`.

## Verifier agent

```
You are verifying review findings for GitHub PR #<N> in <owner/repo> before they are shown to the author.
Do not spawn subagents. Do not modify files, commit, or post anything to GitHub.

Worktree at the PR head: <workdir>/tree  (base branch: <base>)
Context pack: <workdir>/context.md
Findings to verify (blocker/major only — minors are checked by the orchestrator): <workdir>/findings/to_verify.json

For each finding, open the cited location and the evidence and decide:
- confirmed — the problem is real and the comment is accurate;
- downgraded — real but less severe than stated (give the new severity);
- rejected — wrong: the code handles it, the caller never does that, the spec says otherwise,
  the "duplicate" is not actually equivalent, or the finding is noise.
Also check that `line` points at the right place in the new file and that the comment body is
accurate and actionable; fix the body if it overstates.

Known points needing a decision:
<contradictions between reviewers and likely duplicate pairs noted by the orchestrator; settle each
against the code and the base branch (`git -C <tree> show <base>:<path>`) rather than picking a side>

Be adversarial: the cost of posting a wrong comment is higher than missing a minor one.

Write <workdir>/findings/verified.json: the same array, each item with added fields
"verdict" (confirmed | downgraded | rejected | duplicate), "verdict_reason", "duplicate_of" for
duplicates, and (if changed) updated "severity" / "body" / "line".
```
