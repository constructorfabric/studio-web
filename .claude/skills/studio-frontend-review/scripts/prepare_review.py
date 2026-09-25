#!/usr/bin/env python3
"""Prepare a planned review: worktree, context-pack skeleton, per-agent brief files.

Usage: prepare_review.py <workdir>          (workdir contains plan.json from plan_review.py)
Run from inside a local clone of the PR's repository.

Writes:
  <workdir>/tree/                 git worktree at the PR head
  <workdir>/pr-body.md            full PR description
  <workdir>/existing-comments.md  what people, CodeRabbit and earlier runs already said
  <workdir>/open-threads.json     unresolved threads this skill opened in earlier rounds (re-checked, replied to)
  <workdir>/cfs-validate.md       `cfs validate --local-only` at the head, split into new vs already on the base
  <workdir>/context.md            context pack skeleton — fill in the ORCHESTRATOR sections
  <workdir>/briefs/<agent>.md     one ready-to-send prompt per agent (architecture, slice-k or single)
  <workdir>/findings/             empty, agents write here
A workdir left from another head is cleared first (findings, verdicts, briefs, worktree), so nothing
from an earlier run can leak into this one.
Prints the agent list with the model each one must be launched with.
"""
import json
import os
import re
import shutil
import subprocess
import sys

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKLIST = f"{SKILL}/references/checklist.md"
BRIEFS = f"{SKILL}/references/agent-briefs.md"
STUDIO = f"{SKILL}/references/studio-checklist.md"

THREADS_QUERY = """query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine
      comments(first: 50) { nodes { databaseId author { login } body createdAt } } } } } } }"""

CFS_ISSUE_RE = re.compile(r"^\s*(?:⚠|✗|>)\s+(\S+?):(\d+) \[([\w-]+)\]\s*(.*)$")


def sh(*args, check=True, cwd=None):
    res = subprocess.run(args, capture_output=True, text=True, cwd=cwd)
    if check and res.returncode != 0:
        sys.exit(f"{' '.join(args)} failed:\n{res.stderr}")
    return res.stdout


def fmt_file(f):
    extra = []
    if f.get("lines"):
        extra.append(f"lines {f['lines']}")
    if f.get("new_lines"):
        extra.append(f"new since the last round: {f['new_lines']}")
    return f"- {f['path']} +{f['additions']} -{f['deletions']}" + (f" ({'; '.join(extra)})" if extra else "")


def reset_workdir(workdir, head):
    """Clear a workdir that was used for another head: stale findings/verdicts would mix into this run."""
    mark = f"{workdir}/.head"
    old = open(mark).read().strip() if os.path.exists(mark) else None
    if old == head:
        return
    for wt in ("tree", "base-tree"):
        if os.path.isdir(f"{workdir}/{wt}"):
            sh("git", "worktree", "remove", "--force", f"{workdir}/{wt}", check=False)
    for d in ("findings", "briefs"):
        shutil.rmtree(f"{workdir}/{d}", ignore_errors=True)
    for f in ("verified.json", "approved.json", "replies.json", "summary.md", "draft.md", "numbered.json"):
        if os.path.exists(f"{workdir}/{f}"):
            os.remove(f"{workdir}/{f}")
    sh("git", "worktree", "prune", check=False)
    open(mark, "w").write(head + "\n")


def cfs_issues(output):
    """[(severity, file, line, rule, message)] from `cfs validate` text output."""
    issues, cur = [], None
    for line in output.splitlines():
        m = CFS_ISSUE_RE.match(line)
        if m:
            cur = {"file": m.group(1), "line": int(m.group(2)), "rule": m.group(3), "msg": m.group(4), "sev": "?"}
            issues.append(cur)
            continue
        if cur is None:
            continue
        s = line.strip()
        if s.startswith("severity:"):
            cur["sev"] = s.split(":", 1)[1].strip()
        elif not cur["msg"] and s and not s.startswith(("->", "Fix:")):
            cur["msg"] = s
    return issues


def run_cfs(root, subdir):
    """(exit code or None, output) of `cfs validate --local-only` run from <root>/<subdir>."""
    cwd = os.path.join(root, subdir) if subdir else root
    env = {**os.environ, "CFS_DECISION_LOG": "off"}  # don't write a decisions log into the worktree
    try:
        r = subprocess.run(["cfs", "validate", "--local-only"], cwd=cwd, capture_output=True, text=True,
                           timeout=300, env=env)
    except subprocess.TimeoutExpired:
        return None, "timed out after 300 s"
    return r.returncode, r.stdout + r.stderr


def cfs_report(workdir, tree, base, scope):
    """Write cfs-validate.md: what `cfs validate` says at the head, and which of it is new in this PR."""
    path = f"{workdir}/cfs-validate.md"
    subdir = scope.strip("/")
    if not shutil.which("cfs"):
        open(path, "w").write("`cfs` is not installed where this review runs. Say nothing about what "
                              "`cfs validate` reports; a traceability convention breach is still a finding.\n")
        return
    code, out = run_cfs(tree, subdir)
    open(f"{workdir}/cfs-head.txt", "w").write(out)
    base_tree = f"{workdir}/base-tree"
    mb = sh("git", "-C", tree, "merge-base", base, "HEAD").strip()
    sh("git", "worktree", "add", "-q", "--detach", base_tree, mb)
    try:
        base_code, base_out = run_cfs(base_tree, subdir)
    finally:
        sh("git", "worktree", "remove", "--force", base_tree, check=False)
    head_issues, base_issues = cfs_issues(out), cfs_issues(base_out)
    # Line numbers shift between base and head; an issue is the same when file, rule and message match.
    known = {(i["file"], i["rule"], i["msg"]) for i in base_issues}
    new = [i for i in head_issues if (i["file"], i["rule"], i["msg"]) not in known]
    old = [i for i in head_issues if (i["file"], i["rule"], i["msg"]) in known]

    def fmt(i):
        return f"- {i['sev'].upper()} `{subdir + '/' if subdir else ''}{i['file']}:{i['line']}` [{i['rule']}] {i['msg']}"

    def counts(issues):
        errs = sum(1 for i in issues if i["sev"] == "error")
        return f"{errs} errors, {len(issues) - errs} warnings"

    text = f"""# `cfs validate --local-only`, run from `{subdir or '.'}/`

The only source for claims about what `cfs validate` reports. Quote it; never say a check fails or passes
beyond what is written here. A traceability convention the tool does not flag (a checked `inst` without a
code anchor, …) is a convention finding, not a failing check.

- head: exit {code} — {counts(head_issues)} (full output: `{workdir}/cfs-head.txt`)
- base (merge-base {mb[:10]}): exit {base_code} — {counts(base_issues)}

## New in this PR — report these (errors are findings; warnings only if the PR caused them)
{chr(10).join(fmt(i) for i in new) or "none"}

## Already on the base — pre-existing, not findings
{chr(10).join(fmt(i) for i in old) or "none"}
"""
    open(path, "w").write(text)


def own_threads(repo, n, me):
    """Unresolved review threads opened by `me` (earlier rounds of this skill)."""
    owner, name = repo.split("/")
    res = subprocess.run(["gh", "api", "graphql", "-f", f"query={THREADS_QUERY}", "-F", f"owner={owner}",
                          "-F", f"name={name}", "-F", f"number={n}"], capture_output=True, text=True)
    if res.returncode != 0:
        return None
    nodes = json.loads(res.stdout)["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
    out = []
    for t in nodes:
        comments = t["comments"]["nodes"]
        if t["isResolved"] or not comments or (comments[0]["author"] or {}).get("login") != me:
            continue
        first, last = comments[0], comments[-1]
        body = [l for l in first["body"].strip().splitlines() if l.strip()]
        out.append({
            "thread_id": t["id"],
            "comment_id": first["databaseId"],
            "path": t["path"],
            "line": t["line"] or t["originalLine"],
            "outdated": t["isOutdated"],
            "label": body[0] if body else "",
            "title": body[1][:200] if len(body) > 1 else "",
            "replies": len(comments) - 1,
            "last_author": (last["author"] or {}).get("login"),
            "last_body": last["body"].strip()[:600] if last is not first else "",
            # Someone answered after our last word ("fixed in …", a disagreement): re-check it this round.
            # Otherwise our word is the last one and the thread waits for the author — leave it alone.
            "needs_recheck": (last["author"] or {}).get("login") != me,
        })
    return out


def header(role, n, repo, tree, base, workdir):
    return f"""{role} of GitHub PR #{n} in {repo}.
Do not spawn subagents. Do not modify files, commit, or post anything to GitHub.

Worktree at the PR head: {tree}  (base: {base}; diff with `git -C {tree} diff {base}...HEAD -- <paths>`,
old versions with `git -C {tree} show {base}:<path>`)
Context pack (read first): {workdir}/context.md
Checklist (read first): {CHECKLIST}
Studio frontend rules (read first; they override generic advice where they disagree): {STUDIO}
Findings format: {BRIEFS}, section "Findings format"
"""


RULES = """
Rules for every reviewer:
- Exhaustive. Report every problem in your scope you can verify, of every severity, in this one pass. There
  is no quota and no "top N": later rounds review only lines changed after this head, so anything you leave
  out now will not be raised later. Don't stop at the first finding in a file.
- Severity. `blocker` / `major` only for broken behaviour, with the concrete failure in `failure` (input or
  state → wrong result). Missing tests, traceability, duplication, conventions and smells are `minor`
  ("should fix") at most, however important; `nit` is optional polish.
- Every finding has `verify`: one line — a command, a test name, or a short manual sequence that shows it.
- Anchor every finding on a changed line of a file in the diff (the line that causes or shows the problem).
  If the root cause is in unchanged code, anchor on the changed line that exposes it and name the other
  location in the body. Nothing is posted only in the summary.
- `cfs`: quote {workdir}/cfs-validate.md. Never state what `cfs validate` would report beyond it.
- When you confirm a bug in a function, read that function's other branches and sibling paths (the
  fallback, the retry, the navigate/replace path, the error path) for the same class of mistake.
- For a guard or trigger condition, check what it is meant to catch *and* every normal case it also
  matches (`items.length === 0` also matches a genuinely empty list).
- When an ADR or spec names a single writer or owner of a piece of state, grep every writer of that
  field (`rg "\\.<field>\\s*=" `, reducers, setters) and report the others.
- When a module is rewritten or moved, compare it with the base (`git show <base>:<path>`) for dropped
  tests and dropped `@cpt-*` markers.
"""

ARCH_BODY = """
Your scope is the PR as a whole, at the structural level — slice reviewers are handling line-level bugs,
so do not do a line-by-line pass. Focus on checklist section 1 (architecture and spec conformance),
PR-wide test coverage (does a new major flow have an e2e test?), duplication across the PR or with
existing code in the repo, file structure (checklist section 4: do the new files land where files of
that kind already live?) and traceability (`cfs-validate.md`, FEATURE docs, `@cpt` markers).
Code-pattern conventions inside files are the slice reviewers' job.

How to work:
1. Read the spec documents listed in the context pack. Note the requirements and decisions relevant to
   this PR, especially invariants ("X is the only writer of Y", "Z never …").
2. Get the structural picture: `git -C <tree> diff --stat <base>...HEAD`, new files/directories,
   changed public interfaces (exports, routes, schemas, contracts, events, error codes, component props).
3. Read the diffs of the structural files.
4. For each requirement/decision, check the code honours it — for an invariant, search the whole tree
   for code that breaks it, not only the file that implements it. Look for boundary violations and new
   patterns that diverge from existing ones (search the repo to find the existing pattern). If the PR
   description lists breaking or consumer-visible changes, check that list against the base branch.
5. For every new file and directory, find where existing files of the same kind live and how they are
   named; report placement/naming that breaks the dominant layout.
6. Go through `cfs-validate.md`: every new error is a finding (anchor it on the changed line of that doc).
"""

SLICE_BODY = """
A file marked "lines a-b" is shared with another slice: review only the changed lines in that range
of the new file, but read the rest of the file as needed for context.

Other slices cover the rest of the PR; the full file list is in the context pack. Another agent covers
PR-wide architecture, but if you see a spec or architecture problem in your files, report it.

How to work:
1. Read the diff of your files.
2. For each changed file, open the full new version when the diff alone doesn't show enough context.
3. Go through the checklist sections in order for every file. Before reporting a bug, check the callers.
   Before reporting duplication, search the repo for the existing implementation and name it.
4. For conventions (checklist section 4), open 2–3 existing sibling files of the same kind first and
   note how they are written; confirm a pattern is dominant with an `rg` count before reporting a
   deviation. One finding per deviating pattern, listing all places in your slice. When you say a
   pattern is new or pre-existing, check the base branch — don't infer it.
5. For tests, apply the checklist's testing philosophy — ask for tests of logic, not of markup.
"""


def followup_block(plan):
    since, k = plan["since"][:10], plan["round"]
    return f"""
This is review round {k}. Round {k - 1} reviewed head {since}. Review only the lines listed as "new since
the last round" for your files — the only lines added or changed after that head; read anything else for
context. Code that already existed at {since} was reviewed then: report a problem there only if it is a
`blocker` / `major` behaviour bug, with `"preexisting": true` (it is labelled "pre-existing at {since}, not
raised in round {k - 1}"). Everything else in unchanged code is out of scope this round. Points already
raised in open threads (`open-threads.json`) are handled by the orchestrator — don't report them again.
"""


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    workdir = os.path.abspath(sys.argv[1])
    plan = json.load(open(f"{workdir}/plan.json"))
    pr, repo = plan["pr"], plan["repo"]
    n, base = pr["number"], f"origin/{pr['baseRefName']}"
    tree = f"{workdir}/tree"
    followup = bool(plan.get("since"))

    reset_workdir(workdir, pr["headRefOid"])
    if not os.path.isdir(tree):
        # Detached worktree at the exact head commit: no local branch to collide with or clean up.
        sh("git", "fetch", "-q", "origin", pr["baseRefName"], f"pull/{n}/head")
        sh("git", "worktree", "add", "-q", "--detach", tree, pr["headRefOid"])
    os.makedirs(f"{workdir}/findings", exist_ok=True)
    os.makedirs(f"{workdir}/briefs", exist_ok=True)
    open(f"{workdir}/pr-body.md", "w").write(plan.get("body") or "")

    blind = plan.get("blind")
    # What others (people, CodeRabbit, earlier runs of this skill) already said, so it isn't repeated.
    # A blind benchmark run (plan_review.py --at) sees none of it: later comments would give answers away.
    inline = [] if blind else json.loads(sh("gh", "api", "--paginate", "--slurp", f"repos/{repo}/pulls/{n}/comments?per_page=100", check=False) or "[]")
    reviews = [] if blind else json.loads(sh("gh", "api", "--paginate", "--slurp", f"repos/{repo}/pulls/{n}/reviews?per_page=100", check=False) or "[]")
    said = [f"- {c['user']['login']} on `{c['path']}:{c.get('line') or c.get('original_line')}`: "
            + c["body"].strip().replace("\n", " ")[:400] for page in inline for c in page]
    said += [f"- {r['user']['login']} (review, {r['state']}): " + r["body"].strip().replace("\n", " ")[:600]
             for page in reviews for r in page if (r.get("body") or "").strip()]
    open(f"{workdir}/existing-comments.md", "w").write("\n".join(said) + "\n" if said else "none\n")

    me = sh("gh", "api", "user", "--jq", ".login").strip()
    threads = [] if blind else own_threads(repo, n, me)
    json.dump(threads or [], open(f"{workdir}/open-threads.json", "w"), indent=2, ensure_ascii=False)
    if threads is None:
        threads_note = "Could not read review threads (GraphQL failed): don't post thread replies this run."
    elif threads:
        threads_note = (f"{len(threads)} unresolved threads opened by earlier rounds: `{workdir}/open-threads.json` "
                        f"({sum(t['needs_recheck'] for t in threads)} answered since our last word). "
                        "The orchestrator re-checks them in their threads; never open a new thread on one of these points.")
    else:
        threads_note = "No unresolved threads from earlier rounds."

    cfs_report(workdir, tree, base, plan.get("scope") or "")

    checks = ("(benchmark run: CI of the current head is not shown)" if blind else
              sh("gh", "pr", "checks", str(n), "--repo", repo, check=False).strip() or "(no checks reported)")
    # Only instruction files that govern the touched paths: the repo root and ancestors of changed files.
    touched_dirs = {os.path.dirname(f["path"]) for s_ in plan["slices"] for f in s_["files"]}
    def governs(doc):
        d = os.path.dirname(doc)
        return d == "" or any(t == d or t.startswith(d + "/") for t in touched_dirs)
    conventions = [p for p in sh("git", "-C", tree, "ls-files").split()
                   if os.path.basename(p) in ("CLAUDE.md", "AGENTS.md") and governs(p)]
    files = [f"- [slice {s['id']}] {fmt_file(f)[2:]}" for s in plan["slices"] for f in s["files"]]
    noise = ", ".join(f"{x['path']} +{x['additions']} -{x['deletions']}" for x in plan["noise_files"]) or "none"
    oos = plan.get("out_of_scope_files") or []
    oos_note = (f"Out of scope (not under `{plan.get('scope')}`, reviewed by someone else — do not report on them, "
                f"but read them if a frontend change depends on them): "
                + ", ".join(x["path"] for x in oos[:40]) + (" …" if len(oos) > 40 else "")) if oos else ""
    refs = " ".join([f"#{i}" for i in plan["issue_refs"]] + plan["tracker_refs"]) or "none"
    if followup:
        unchanged = plan.get("unchanged_since") or []
        round_note = (f"**Round {plan['round']} — follow-up.** Head {plan['since'][:10]} was reviewed in round "
                      f"{plan['round'] - 1}. Only lines added since then are in scope (listed per file below). "
                      f"{len(unchanged)} files in scope have no new lines and are context only: "
                      + (", ".join(f"`{p}`" for p in unchanged[:30]) + (" …" if len(unchanged) > 30 else "")))
    else:
        round_note = (f"**Round {plan['round']}** — every changed line under `{plan.get('scope')}` is in scope. "
                      "This pass must be exhaustive: later rounds review only lines changed after this head."
                      + (f" ({plan['since_note']})" if plan.get("since_note") else ""))

    context = f"""# Context pack — PR #{n} ({repo})

**Title:** {pr['title']}
**Base:** {base} — diff with `git -C {tree} diff {base}...HEAD -- <paths>`
**Size:** +{pr['additions']} -{pr['deletions']} in {pr['changedFiles']} files; reviewable weight {plan['reviewable_weight']}.
Assume the code is AI-agent-written (see checklist "Agent-written code").

{round_note}

## What the PR claims to do
Full description: `{workdir}/pr-body.md` — read it.
<!-- ORCHESTRATOR: 3–6 line summary of intent, stated rules, declared breaking changes -->

## Already said on this PR
Existing review comments (people, CodeRabbit, earlier automated runs): `{workdir}/existing-comments.md`.
Don't re-report a point that is already raised there unless you have new evidence that it is worse than stated.
{threads_note}

## Linked issues
References in the body: {refs}
<!-- ORCHESTRATOR: acceptance criteria of linked issues (gh issue view), or "none" -->

## Specs to read (paths relative to the worktree)
<!-- ORCHESTRATOR: pick from plan.spec_candidates the ADR/PRD/contract docs this PR touches; one line of why each -->

## Conventions
{chr(10).join('- `' + c + '`' for c in conventions) or '- none found'}
Establish code conventions from existing unchanged sibling files, not from this list alone.

## CI and `cfs`
```
{checks}
```
Rely on CI for lint/type/test status — don't re-report it.
Known pre-existing issues — never report them: `npm run lint` fails because `typescript-eslint` is not installed;
IDE-only TS1259 in `studio-frontend/tailwind.config.ts`.
`cfs validate`: `{workdir}/cfs-validate.md` — the only source for what it reports.

## Files changed (grouped by slice)
Noise skipped: {noise}
{oos_note}
""" + "\n".join(files) + "\n"
    open(f"{workdir}/context.md", "w").write(context)

    rules = RULES.format(workdir=workdir) + (followup_block(plan) if followup else "")
    # Slice reviewers (and the single agent) are Sonnet unless REVIEW_SLICE_MODEL says otherwise.
    slice_model = os.environ.get("REVIEW_SLICE_MODEL") or "sonnet"
    agents = []
    total = len(plan["slices"])
    if plan["single_agent"]:
        s = plan["slices"][0]
        body = header("You are the single reviewer (line pass + architecture)", n, repo, tree, base, workdir) + rules
        body += "\nYour files (review every changed line" + (" that is new since the last round" if followup else "") + "):\n"
        body += "\n".join(fmt_file(f) for f in s["files"]) + "\n"
        body += "\nThis is a small review, so you are also the architecture/spec reviewer. Do two passes.\n"
        body += "\nArchitecture pass:" + ARCH_BODY.split("How to work:")[1]
        body += "\nLine pass:" + SLICE_BODY.split("How to work:")[1]
        body += f"\nWrite findings to {workdir}/findings/single.json. Finish with a 3–5 sentence summary of the PR's shape and your overall assessment.\n"
        open(f"{workdir}/briefs/single.md", "w").write(body)
        agents.append(("single", slice_model))
    else:
        body = header("You are reviewing the architecture and spec conformance", n, repo, tree, base, workdir) + rules + ARCH_BODY
        body += f"\nWrite findings to {workdir}/findings/architecture.json. Finish with a 3–5 sentence summary of the architectural shape of the PR and your overall assessment.\n"
        open(f"{workdir}/briefs/architecture.md", "w").write(body)
        agents.append(("architecture", plan["architecture_model"]))
        for s in plan["slices"]:
            k = s["id"]
            body = header(f"You are reviewing slice {k} of {total}", n, repo, tree, base, workdir) + rules
            body += "\nYour slice (review every changed line" + (" that is new since the last round" if followup else "") + " of these files):\n"
            body += "\n".join(fmt_file(f) for f in s["files"]) + "\n"
            body += SLICE_BODY
            body += f"\nWrite findings to {workdir}/findings/slice-{k}.json. Finish with one or two sentences on the overall quality of your slice.\n"
            open(f"{workdir}/briefs/slice-{k}.md", "w").write(body)
            agents.append((f"slice-{k}", slice_model))

    print(f"round {plan['round']}" + (f" (follow-up: lines new since {plan['since'][:10]})" if followup else " (full)"))
    print(f"worktree: {tree}")
    print(f"context skeleton: {workdir}/context.md  (fill the ORCHESTRATOR sections)")
    print(f"cfs: {workdir}/cfs-validate.md")
    print(f"open threads from earlier rounds: {len(threads or [])} -> {workdir}/open-threads.json")
    print("agents to launch in one message (subagent_type general-purpose, model as shown):")
    for name, model in agents:
        print(f"  {name:14s} model={model:7s} brief={workdir}/briefs/{name}.md")


if __name__ == "__main__":
    main()
