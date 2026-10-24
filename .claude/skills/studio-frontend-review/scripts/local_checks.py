#!/usr/bin/env python3
"""Measure what reading guesses at: which changed lines no test runs, what the PR copied, what nothing uses.

Usage: local_checks.py <workdir> [--no-sandbox] [--skip coverage,jscpd,knip]
Run from the repo root after prepare_review.py. Everything runs sandboxed (sandbox.py): the tests execute
the PR's code, and knip loads its config files.

Writes <workdir>/local-checks.md, limited to the lines this round reviews (every changed line in round 1,
the lines new since the last reviewed head in a follow-up):
  - Coverage: `vitest --coverage` (v8) per vitest config that owns a changed file — changed lines no test
    executes, branches never taken, functions never called; files no test loads at all.
  - Duplication: jscpd clones with at least one side on a changed line — both sides new (copied inside the
    PR) or a copy of existing code.
  - Unused: knip — files and exports added by the PR that nothing imports.
The report is evidence for findings, not findings: the reviewers still apply the testing philosophy (logic,
not markup) and the duplication/convention thresholds of the checklists.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import sandbox
from plan_review import added_lines

CODE = re.compile(r"\.(ts|tsx|js|jsx|mjs|cjs)$")
TEST = re.compile(r"(\.|_)(test|spec)\.[jt]sx?$|/__tests__/|/__test-utils__/")


def git(*args, cwd=None):
    return subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd, check=True).stdout


def parse_ranges(text):
    out = set()
    for part in (text or "").split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return out


def ranges(nums):
    nums, out = sorted(nums), []
    for n in nums:
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return ", ".join(f"{a}-{b}" if b > a else str(a) for a, b in out)


def changed_lines(plan, tree):
    """{path from repo root: {line numbers}} this round reviews."""
    files = {f["path"] for s in plan["slices"] for f in s["files"]}
    if plan.get("since"):
        return {f["path"]: parse_ranges(f.get("new_lines")) for s in plan["slices"] for f in s["files"]}
    head = git("rev-parse", "HEAD", cwd=tree).strip()
    mb = git("merge-base", f"origin/{plan['pr']['baseRefName']}", head, cwd=tree).strip()
    added = added_lines(mb, head, plan.get("scope") or "")
    return {p: {n for n, _ in added.get(p, [])} for p in files}


def config_dir(fe, rel):
    """The directory (relative to studio-frontend/) of the vitest config that owns rel."""
    d = os.path.dirname(rel)
    while d:
        if os.path.exists(os.path.join(fe, d, "vitest.config.ts")):
            return d
        d = os.path.dirname(d)
    return ""


def coverage(workdir, fe, prefix, lines, no_sandbox):
    # Source files only: not tests, not type declarations, not tool configs at the package roots.
    sources = [p for p in lines if CODE.search(p) and not TEST.search(p) and not p.endswith(".d.ts") and lines[p]
               and "/" in p[len(prefix):] and not re.search(r"(^|/)[^/]*\.config\.[cm]?[jt]s$", p)]
    by_cfg = {}
    for p in sources:
        by_cfg.setdefault(config_dir(fe, p[len(prefix):]), []).append(p)
    out = []
    for cfg, paths in sorted(by_cfg.items()):
        slug = cfg.replace("/", "_") or "root"
        report_dir = f"{workdir}/coverage/{slug}"
        # src-app runs from studio-frontend/ (as the repo's test:unit does); the others from their own directory.
        cwd = fe if cfg in ("", "src-app") else os.path.join(fe, cfg)
        config = os.path.join(cfg, "vitest.config.ts") if cwd == fe else "vitest.config.ts"
        # reportOnFailure: a test that fails for reasons of its own (a generated file missing) must not cost
        # the whole report.
        cmd = ["npx", "vitest", "run", "--config", config, "--passWithNoTests", "--coverage.enabled=true",
               "--coverage.provider=v8", "--coverage.reporter=json", "--coverage.reportOnFailure=true",
               f"--coverage.reportsDirectory={report_dir}"]
        code, log = sandbox.run(cmd, cwd, workdir, network=False, no_sandbox=no_sandbox, timeout=900)
        final = f"{report_dir}/coverage-final.json"
        if not os.path.exists(final):
            out.append(f"- `{cfg or '.'}`: coverage did not run (exit {code}): {log.strip()[-300:]}")
            continue
        data = {os.path.realpath(k): v for k, v in json.load(open(final)).items()}
        failed = re.search(r"Tests\s+(\d+) failed", log)
        out.append(f"### vitest config `{cfg or '.'}/vitest.config.ts`" + (f" ({failed.group(1)} tests failed on this head)" if failed else ""))
        for p in sorted(paths):
            want = lines[p]
            entry = data.get(os.path.realpath(os.path.join(fe, p[len(prefix):])))
            if entry is None:
                out.append(f"- `{p}`: no test loads this file ({len(want)} changed lines)")
                continue
            stmt_lines = {v["start"]["line"] for v in entry["statementMap"].values()}
            uncovered = {entry["statementMap"][k]["start"]["line"] for k, n in entry["s"].items() if n == 0}
            executable = stmt_lines & want
            missed = uncovered & want
            branches = []
            for bid, br in entry["branchMap"].items():
                for i, loc in enumerate(br["locations"]):
                    line = (loc.get("start") or {}).get("line") or br["loc"]["start"]["line"]
                    if entry["b"][bid][i] == 0 and (line in want or br["loc"]["start"]["line"] in want):
                        side = ("then" if i == 0 else "else") if br["type"] == "if" else f"{br['type']} #{i + 1}"
                        branches.append(f"L{br['loc']['start']['line']} {side}")
            fns = [f"`{fn['name']}` (L{fn['decl']['start']['line']})" for fid, fn in entry["fnMap"].items()
                   if entry["f"][fid] == 0 and fn["decl"]["start"]["line"] in want]
            if not (missed or branches or fns):
                out.append(f"- `{p}`: every changed executable line runs in a test ({len(executable)} lines)")
                continue
            parts = []
            if missed:
                parts.append(f"lines never run: {ranges(missed)} ({len(missed)}/{len(executable)} changed executable lines)")
            if branches:
                parts.append("branches never taken: " + ", ".join(sorted(set(branches), key=lambda s: int(s[1:].split()[0]))))
            if fns:
                parts.append("functions never called: " + ", ".join(fns))
            out.append(f"- `{p}`: " + "; ".join(parts))
    return out


def overlaps(name, start, end, fe, prefix, lines):
    rel = prefix + os.path.relpath(os.path.join(fe, name), fe) if not os.path.isabs(name) else prefix + os.path.relpath(name, fe)
    want = lines.get(rel, set())
    return rel, bool(want & set(range(start, end + 1)))


def jscpd(workdir, fe, prefix, lines, no_sandbox):
    out_dir = f"{workdir}/jscpd"
    roots = [d for d in ("src-app", "packages", "src") if os.path.isdir(os.path.join(fe, d))]
    cmd = ["jscpd", "--silent", "--reporters", "json", "--output", out_dir, "--min-lines", "5", "--min-tokens", "50",
           "--format", "typescript,tsx,javascript,jsx", "--ignore", "**/node_modules/**,**/dist/**,**/*.d.ts,**/*.json",
           "--absolute", *roots]
    code, log = sandbox.run(cmd, fe, workdir, network=False, no_sandbox=no_sandbox, timeout=600)
    report = f"{out_dir}/jscpd-report.json"
    if not os.path.exists(report):
        return [f"- jscpd did not run (exit {code}): {log.strip()[-300:]}"]
    src, tests, seen = [], [], set()
    for d in json.load(open(report)).get("duplicates", []):
        a, b = d["firstFile"], d["secondFile"]
        ra, na = overlaps(a["name"], a["start"], a["end"], fe, prefix, lines)
        rb, nb = overlaps(b["name"], b["start"], b["end"], fe, prefix, lines)
        if not (na or nb):
            continue
        key = tuple(sorted([(ra, a["start"]), (rb, b["start"])]))
        if key in seen:
            continue
        seen.add(key)
        kind = "copied inside this PR" if (na and nb) else "copy of existing code"
        new, old = ((ra, a), (rb, b)) if na else ((rb, b), (ra, a))
        line = (f"- {d['lines']} lines, {kind}: `{new[0]}:{new[1]['start']}-{new[1]['end']}` ≈ "
                f"`{old[0]}:{old[1]['start']}-{old[1]['end']}`")
        (tests if TEST.search(new[0]) and TEST.search(old[0]) else src).append(line)
    out = ["Source code:", *(src or ["- none"]), "",
           "Test files (much of this is `vi.hoisted` / `vi.mock` boilerplate the repo repeats on purpose; a shared "
           "fixture or harness copied between suites is the part worth a finding):", *(tests or ["- none"])]
    return out


def knip(workdir, fe, prefix, lines, no_sandbox):
    # Our own config: the repo has none, and knip's eslint plugin can't load eslint.config.js (typescript-eslint
    # is not installed — a known pre-existing issue). Workspaces and entry points are still auto-detected.
    cfg = f"{workdir}/knip.json"
    json.dump({"eslint": False}, open(cfg, "w"))
    # Exports and types only: unused-file results are mostly tests and alias-imported helpers knip can't
    # resolve (`@frontx-test-utils/*`), i.e. noise.
    cmd = ["knip", "--config", cfg, "--reporter", "json", "--no-progress", "--no-exit-code",
           "--include", "exports,types"]
    code, log = sandbox.run(cmd, fe, workdir, network=False, no_sandbox=no_sandbox, timeout=600)
    start = log.find("{")
    try:
        data = json.loads(log[start:log.rfind("}") + 1]) if start >= 0 else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return [f"- knip did not produce a report (exit {code}): {log.strip()[-300:]}"]
    out = ["Check before reporting: knip does not resolve every tsconfig alias, so an export used only through "
           "an alias import can show up here."]
    for issue in data.get("issues", []):
        rel = prefix + issue["file"]
        if TEST.search(rel):
            continue
        want = lines.get(rel, set())
        for kind in ("exports", "types"):
            for e in issue.get(kind) or []:
                if e.get("line") in want:
                    out.append(f"- `{rel}:{e['line']}`: unused {kind[:-1]} `{e['name']}`")
    return out if len(out) > 1 else ["- no export or type added by this PR is unused"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--no-sandbox", action="store_true")
    ap.add_argument("--skip", default="")
    a = ap.parse_args()
    workdir = os.path.abspath(a.workdir)
    plan = json.load(open(f"{workdir}/plan.json"))
    tree = f"{workdir}/tree"
    fe = f"{tree}/studio-frontend"
    prefix = "studio-frontend/"
    skip = set(filter(None, a.skip.split(",")))
    if not sandbox.setup(workdir, a.no_sandbox):
        sys.exit(2)
    lines = changed_lines(plan, tree)
    scope = (f"lines added since `{plan['since'][:10]}` (round {plan['round']})" if plan.get("since")
             else f"every changed line (round {plan.get('round', 1)})")

    sections = [f"# Local checks — {scope}\n",
                "Measured on the PR head in the sandbox. Evidence for findings, not findings: apply the testing "
                "philosophy (ask for tests of logic, not markup) and the duplication thresholds. Quote the line "
                "from here in the finding's evidence and `verify`.\n"]
    if "coverage" not in skip:
        sections += ["## Coverage of changed code (vitest --coverage, v8)", *coverage(workdir, fe, prefix, lines, a.no_sandbox), ""]
    tools_ok = ("jscpd" in skip and "knip" in skip) or sandbox.ensure_tools(workdir, a.no_sandbox)
    if "jscpd" not in skip:
        sections += ["## Duplication touching changed lines (jscpd, ≥ 5 lines / 50 tokens)",
                     *(jscpd(workdir, fe, prefix, lines, a.no_sandbox) if tools_ok else ["- jscpd not installed"]), ""]
    if "knip" not in skip:
        sections += ["## Unused code added by this PR (knip)",
                     *(knip(workdir, fe, prefix, lines, a.no_sandbox) if tools_ok else ["- knip not installed"]), ""]
    open(f"{workdir}/local-checks.md", "w").write("\n".join(sections) + "\n")
    print("\n".join(sections))
    print(f"-> {workdir}/local-checks.md")


if __name__ == "__main__":
    main()
