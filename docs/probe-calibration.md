# Calibrating findings against history

How many of the bugs a repository's maintainers went on to fix a findings
producer would have reported beforehand, and how many of its reports a later
fix confirms. Measured with [`scripts/probe-calibrate.mjs`](../scripts/probe-calibrate.mjs)
on any git repository, for any producer that can say where its finding is: the
spec findings ([spec-findings.md](spec-findings.md), the domain-model rules in
[spec-domain-model.md](spec-domain-model.md#calibration)), and later an audit
of code.

Status: a tool, 2026-10-19. The calibrations recorded so far were judged by
hand against the documents; this one is judged by what happened next.

## Why this exists

A calibration by reading says whether each finding is right. It does not say
what the producer missed, and the people judging know what they hoped to
find. History answers both without a judge: a fix a maintainer committed is a
bug somebody cared about, and if its lines were already there at an earlier
commit, a producer run at that commit could have reported it.

The method is LogicStar's PROBE ("Frontier coding agents find different bugs
than maintainers fix"). Their frontier agents, told to find all bugs in a
snapshot, found 25% of the bugs maintainers later fixed, and 33% of their
reports matched a later fix.

## The method

1. **A snapshot at T0.** The producer runs on the checkout at T0 and on
   nothing else.
2. **The reference set, T0 → T1.** Every non-merge commit in `T0..T1` under
   the paths whose subject reads as a fix (a conventional `fix:`, or "fix" or
   "bug" as a word; `--fix-pattern` replaces the rule). For each hunk of the
   fix, the lines it replaced (its old side, in the fix's parent) are mapped
   back to T0 through `git diff -U0 T0 <fix>^`: a line that diff changed or
   added was written after T0, so the bug on it was too, and it is dropped. A
   pure insertion counts at the line it follows. What is left is one item per
   (fix, file, T0 line range).
3. **The findings at T0**, as JSON — an array, or `{ "findings": [...] }`:

   ```json
   [{ "id": "f1", "file": "docs/design/x.md", "line": 42, "text": "…" },
    { "id": "f2", "file": "src/a.rs", "start": 10, "end": 14, "text": "…" }]
   ```

   `line_start`/`line_end`, as Studio's findings carry them, are read too.
4. **Matching and scores.** A finding matches an item in the same file whose
   range it overlaps within `--tolerance` lines (3 by default). **Recall** is
   the share of items matched, and also of fixes (a fix is found when any of
   its items is). **Precision** is the share of findings that match an item.

```sh
git worktree add ../probe-t0 <T0>                 # what the producer sees
# … run the producer in ../probe-t0, write findings.json …
node scripts/probe-calibrate.mjs --t0 <T0> --t1 <T1> \
  --paths 'docs/**/*.md' --findings findings.json   # --json for the whole result
git worktree remove ../probe-t0
```

T0 and T1 are refs or dates; a date is the last first-parent commit of
`--branch` (HEAD by default) before it. Without `--findings` the script
prints the reference set only.

## The T0 discipline

The producer must not see anything after T0, or the measure measures memory.
Run it in a worktree of T0 (`git worktree add <dir> T0`), not in the working
copy; give an agent no network and no access to the repository's later
history (a worktree shares the object store: `git log --all` in it shows the
fixes, so an agent with a shell needs a copy made by `git archive T0`
instead). A producer with a model behind it may have seen the repository in
training; prefer a T0 after its cutoff.

## Caveats

- **Precision is a lower bound.** A real bug nobody fixed by T1 is
  unmatched, as is one fixed in a commit whose subject does not say so.
- **A match is by place, not meaning.** A finding next to a fix may be about
  another bug. The matched pairs are listed to be sorted by hand (or by a
  judge model) into same bug / different bug / not a bug, as PROBE does.
- **The reference set is noisy.** A `fix:` commit may also refactor; a fix
  to a typo counts like one to a race. A wide hunk makes an item easy to hit.
- **Renames are not followed.** A file renamed between T0 and the fix drops
  out of the reference set.
- Squash merges help: one fix is one commit. A merge commit itself is never
  read.
