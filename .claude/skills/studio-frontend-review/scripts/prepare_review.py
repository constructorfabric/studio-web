#!/usr/bin/env python3
"""Prepare a planned review: worktree, context-pack skeleton, per-agent brief files.

Usage: prepare_review.py <workdir>          (workdir contains plan.json from plan_review.py)
Run from inside a local clone of the PR's repository.

Writes:
  <workdir>/tree/                 git worktree at the PR head
  <workdir>/pr-body.md            full PR description
  <workdir>/context.md            context pack skeleton — fill in the "Specs to read" section
  <workdir>/briefs/<agent>.md     one ready-to-send prompt per agent (architecture, slice-k or single)
  <workdir>/findings/             empty, agents write here
Prints the agent list with the model each one must be launched with.
"""
import json
import os
import subprocess
import sys

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKLIST = f"{SKILL}/references/checklist.md"
BRIEFS = f"{SKILL}/references/agent-briefs.md"
STUDIO = f"{SKILL}/references/studio-checklist.md"


def sh(*args, check=True):
    res = subprocess.run(args, capture_output=True, text=True)
    if check and res.returncode != 0:
        sys.exit(f"{' '.join(args)} failed:\n{res.stderr}")
    return res.stdout


def fmt_file(f):
    return f"- {f['path']} +{f['additions']} -{f['deletions']}" + (f" (lines {f['lines']})" if f.get("lines") else "")


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


ARCH_BODY = """
Your scope is the PR as a whole, at the structural level — slice reviewers are handling line-level bugs,
so do not do a line-by-line pass. Focus on checklist section 1 (architecture and spec conformance),
PR-wide test coverage (does a new major flow have an e2e test?), duplication across the PR or with
existing code in the repo, and file structure (checklist section 4: do the new files land where files of
that kind already live?). Code-pattern conventions inside files are the slice reviewers' job.

How to work:
1. Read the spec documents listed in the context pack. Note the requirements and decisions relevant to this PR.
2. Get the structural picture: `git -C <tree> diff --stat <base>...HEAD`, new files/directories,
   changed public interfaces (exports, routes, schemas, contracts, events, error codes, component props).
3. Read the diffs of the structural files.
4. For each requirement/decision, check the code honours it. Look for boundary violations and new
   patterns that diverge from existing ones (search the repo to find the existing pattern). If the PR
   description lists breaking or consumer-visible changes, check that list against the base branch.
5. For every new file and directory, find where existing files of the same kind live and how they are
   named; report placement/naming that breaks the dominant layout.
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


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    workdir = os.path.abspath(sys.argv[1])
    plan = json.load(open(f"{workdir}/plan.json"))
    pr, repo = plan["pr"], plan["repo"]
    n, base = pr["number"], f"origin/{pr['baseRefName']}"
    tree = f"{workdir}/tree"

    if not os.path.isdir(tree):
        # Detached worktree at the exact head commit: no local branch to collide with or clean up.
        sh("git", "fetch", "-q", "origin", pr["baseRefName"], f"pull/{n}/head")
        sh("git", "worktree", "add", "-q", "--detach", tree, pr["headRefOid"])
    os.makedirs(f"{workdir}/findings", exist_ok=True)
    os.makedirs(f"{workdir}/briefs", exist_ok=True)
    open(f"{workdir}/pr-body.md", "w").write(plan.get("body") or "")

    # What others (people, CodeRabbit, earlier runs of this skill) already said, so it isn't repeated.
    inline = json.loads(sh("gh", "api", "--paginate", "--slurp", f"repos/{repo}/pulls/{n}/comments?per_page=100", check=False) or "[]")
    reviews = json.loads(sh("gh", "api", "--paginate", "--slurp", f"repos/{repo}/pulls/{n}/reviews?per_page=100", check=False) or "[]")
    said = [f"- {c['user']['login']} on `{c['path']}:{c.get('line') or c.get('original_line')}`: "
            + c["body"].strip().replace("\n", " ")[:400] for page in inline for c in page]
    said += [f"- {r['user']['login']} (review, {r['state']}): " + r["body"].strip().replace("\n", " ")[:600]
             for page in reviews for r in page if (r.get("body") or "").strip()]
    open(f"{workdir}/existing-comments.md", "w").write("\n".join(said) + "\n" if said else "none\n")

    checks = sh("gh", "pr", "checks", str(n), "--repo", repo, check=False).strip() or "(no checks reported)"
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

    context = f"""# Context pack — PR #{n} ({repo})

**Title:** {pr['title']}
**Base:** {base} — diff with `git -C {tree} diff {base}...HEAD -- <paths>`
**Size:** +{pr['additions']} -{pr['deletions']} in {pr['changedFiles']} files; reviewable weight {plan['reviewable_weight']}.
Assume the code is AI-agent-written (see checklist "Agent-written code").

## What the PR claims to do
Full description: `{workdir}/pr-body.md` — read it.
<!-- ORCHESTRATOR: 3–6 line summary of intent, stated rules, declared breaking changes -->

## Already said on this PR
Existing review comments (people, CodeRabbit, earlier automated runs): `{workdir}/existing-comments.md`.
Don't re-report a point that is already raised there unless you have new evidence that it is worse than stated.

## Linked issues
References in the body: {refs}
<!-- ORCHESTRATOR: acceptance criteria of linked issues (gh issue view), or "none" -->

## Specs to read (paths relative to the worktree)
<!-- ORCHESTRATOR: pick from plan.spec_candidates the ADR/PRD/contract docs this PR touches; one line of why each -->

## Conventions
{chr(10).join('- `' + c + '`' for c in conventions) or '- none found'}
Establish code conventions from existing unchanged sibling files, not from this list alone.

## CI
```
{checks}
```
Rely on CI for lint/type/test status — don't re-report it.
Known pre-existing issues — never report them: `npm run lint` fails because `typescript-eslint` is not installed;
IDE-only TS1259 in `studio-frontend/tailwind.config.ts`.

## Files changed (grouped by slice)
Noise skipped: {noise}
{oos_note}
""" + "\n".join(files) + "\n"
    open(f"{workdir}/context.md", "w").write(context)

    agents = []
    total = len(plan["slices"])
    if plan["single_agent"]:
        s = plan["slices"][0]
        body = header("You are the single reviewer (line pass + architecture)", n, repo, tree, base, workdir)
        body += "\nYour files (review every changed line):\n" + "\n".join(fmt_file(f) for f in s["files"]) + "\n"
        body += "\nThis is a small PR, so you are also the architecture/spec reviewer. Do two passes.\n"
        body += "\nArchitecture pass:" + ARCH_BODY.split("How to work:")[1]
        body += "\nLine pass:" + SLICE_BODY.split("How to work:")[1]
        body += f"\nWrite findings to {workdir}/findings/single.json. Finish with a 3–5 sentence summary of the PR's shape and your overall assessment.\n"
        open(f"{workdir}/briefs/single.md", "w").write(body)
        agents.append(("single", "sonnet"))
    else:
        body = header("You are reviewing the architecture and spec conformance", n, repo, tree, base, workdir) + ARCH_BODY
        body += f"\nWrite findings to {workdir}/findings/architecture.json. Finish with a 3–5 sentence summary of the architectural shape of the PR and your overall assessment.\n"
        open(f"{workdir}/briefs/architecture.md", "w").write(body)
        agents.append(("architecture", plan["architecture_model"]))
        for s in plan["slices"]:
            k = s["id"]
            body = header(f"You are reviewing slice {k} of {total}", n, repo, tree, base, workdir)
            body += "\nYour slice (review every changed line of these files):\n" + "\n".join(fmt_file(f) for f in s["files"]) + "\n"
            body += SLICE_BODY
            body += f"\nWrite findings to {workdir}/findings/slice-{k}.json. Finish with one or two sentences on the overall quality of your slice.\n"
            open(f"{workdir}/briefs/slice-{k}.md", "w").write(body)
            agents.append((f"slice-{k}", "sonnet"))

    print(f"worktree: {tree}")
    print(f"context skeleton: {workdir}/context.md  (fill the ORCHESTRATOR sections)")
    print("agents to launch in one message (subagent_type general-purpose, model as shown):")
    for name, model in agents:
        print(f"  {name:14s} model={model:7s} brief={workdir}/briefs/{name}.md")


if __name__ == "__main__":
    main()
