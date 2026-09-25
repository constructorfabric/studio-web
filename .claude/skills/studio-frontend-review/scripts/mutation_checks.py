#!/usr/bin/env python3
"""Do the PR's tests notice when its key logic breaks? Apply a few hand-picked mutations and see.

Usage: mutation_checks.py <workdir> [--no-sandbox]
Input: <workdir>/mutations.json — 3 to 6 mutations of logic this PR adds, on lines local-checks.md reports as
executed by tests (a line no test runs is a coverage finding already):
  [{"id": "m1", "file": "studio-frontend/src-app/app/effects/contextCatalogs.ts", "line": 189,
    "find": "if (context().workspace?.id !== workspaceId) return;",   exact text on that line
    "replace": "",                                                      what breaks it
    "why": "drops a projects answer that arrives for a workspace since left"}]
Good mutations: invert or remove a guard, drop a branch, swap `===`/`!==`, return early, remove a dispatch,
change an off-by-one bound. One idea per mutation.

For each mutation: patch the file in <workdir>/tree, run `vitest related` for it with the vitest config that
owns it (sandboxed, no network), restore the file. Writes findings/mutations.json and prints:
  killed    — a test failed: the logic is pinned;
  survived  — every related test passed with the logic broken: the tests run the line but don't check it
              (a "tests" finding: name the mutation and what should have caught it);
  no-tests  — no test imports the file;  invalid — `find` is not on that line (fix and re-run).
"""
import argparse
import json
import os
import re
import sys

import sandbox
from local_checks import config_dir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--no-sandbox", action="store_true")
    a = ap.parse_args()
    workdir = os.path.abspath(a.workdir)
    tree, prefix = f"{workdir}/tree", "studio-frontend/"
    fe = f"{tree}/studio-frontend"
    muts = json.load(open(f"{workdir}/mutations.json"))
    if not sandbox.setup(workdir, a.no_sandbox):
        sys.exit(2)
    results = {}
    for m in muts[:6]:
        path = os.path.join(tree, m["file"])
        rel = m["file"][len(prefix):] if m["file"].startswith(prefix) else m["file"]
        original = open(path).read()
        lines = original.split("\n")
        i = m["line"] - 1
        if not (0 <= i < len(lines)) or m["find"] not in lines[i]:
            results[m["id"]] = {**m, "status": "invalid", "detail": f"line {m['line']} is: {lines[i].strip() if 0 <= i < len(lines) else '(out of range)'}"}
            continue
        lines[i] = lines[i].replace(m["find"], m["replace"], 1)
        cfg = config_dir(fe, rel)
        cwd = fe if cfg in ("", "src-app") else os.path.join(fe, cfg)
        config = os.path.join(cfg, "vitest.config.ts") if cwd == fe else "vitest.config.ts"
        # Absolute: a config may set its own `root` (src-app does), and `related` resolves against it.
        target = os.path.join(fe, rel)
        try:
            open(path, "w").write("\n".join(lines))
            code, log = sandbox.run(["npx", "vitest", "related", "--run", "--config", config, "--passWithNoTests", target],
                                    cwd, workdir, network=False, no_sandbox=a.no_sandbox, timeout=600)
        finally:
            open(path, "w").write(original)
        files = re.search(r"Test Files\s+(.*)", log)
        tests = re.search(r"Tests\s+(.*)", log)
        failed = re.findall(r"^\s*(?:×|FAIL)\s+(.+)$", log, re.M)
        if not tests or "no test files" in log.lower():
            status = "no-tests"
        elif code == 0:
            status = "survived"
        else:
            status = "killed"
        results[m["id"]] = {**m, "status": status, "tests": tests.group(1).strip() if tests else "",
                            "files": files.group(1).strip() if files else "", "failed": failed[:5],
                            "command": f"cd {os.path.relpath(cwd, tree)} && npx vitest related --run --config {config} "
                                       f"{os.path.relpath(target, cwd)}",
                            **({"log": log.strip()[-600:]} if status == "no-tests" else {})}
    os.makedirs(f"{workdir}/findings", exist_ok=True)
    json.dump(results, open(f"{workdir}/findings/mutations.json", "w"), indent=2, ensure_ascii=False)
    for mid, r in results.items():
        print(f"{mid:6s} {r['status']:9s} {r['file'].split('/')[-1]}:{r['line']}  {r.get('why', '')[:70]}  [{r.get('tests', r.get('detail', ''))}]")
    print(f"-> {workdir}/findings/mutations.json")


if __name__ == "__main__":
    main()
