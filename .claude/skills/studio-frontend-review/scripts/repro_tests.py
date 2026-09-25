#!/usr/bin/env python3
"""Run reproduction tests for review findings against the PR head, in a sandbox.

Usage: repro_tests.py <workdir> [--no-sandbox] [--setup-only]

Input: <workdir>/repro/*.test.ts / *.test.tsx, one file per finding, each starting with two header lines:
    // repro-for: <finding id, e.g. slice-3:s3-1>
    // place: src-app/app/routing          (directory relative to studio-frontend/ where the test runs)
Each file holds at least one control test (its name starts with "control:") that must pass, and the test(s)
that show the bug, which must fail on an assertion.

What it does:
  1. Once per workdir: `npm ci --ignore-scripts` and the package builds in <workdir>/tree/studio-frontend
     (network on, but $HOME hidden — no gh, Claude or npm credentials).
  2. Copies each test to its place in the worktree, runs them with vitest (network off), removes them again.
  3. Writes findings/repro.json: {"<finding id>": {"status", "file", "command", "tests": [...]}} where status is
       reproduced      — every control test passed and a bug test failed on an assertion;
       not-reproduced  — every test passed: the finding is probably wrong (or the test misses the path);
       broken          — the file did not load, a control failed, or failures are not assertions.
The PR's code runs here, so outside --no-sandbox it only runs inside bubblewrap: a read-only root, a tmpfs
over $HOME, no network while tests run. --no-sandbox is for a person running it by hand on trusted code.
"""
import argparse
import glob
import json
import os
import re
import shutil
import sys

from sandbox import run as sandboxed, setup as sandbox_setup


def setup(workdir, fe, no_sandbox):
    return sandbox_setup(workdir, no_sandbox)


def header(path):
    meta = {}
    with open(path) as fh:
        for line in fh.readlines()[:5]:
            m = re.match(r"^//\s*(repro-for|place):\s*(\S+)", line)
            if m:
                meta[m.group(1)] = m.group(2).strip().strip("/")
    return meta


def classify(result):
    """reproduced | not-reproduced | broken from one vitest file result."""
    tests = result.get("assertionResults") or []
    if result.get("status") == "failed" and not tests:
        return "broken"
    controls = [t for t in tests if t["title"].lower().startswith("control")]
    bugs = [t for t in tests if t not in controls]
    if not controls or any(t["status"] != "passed" for t in controls) or not bugs:
        return "broken"
    failed = [t for t in bugs if t["status"] == "failed"]
    if not failed:
        return "not-reproduced"
    assertion = all(any(re.search(r"AssertionError|expected .* to ", m) for m in t.get("failureMessages") or [""])
                    for t in failed)
    return "reproduced" if assertion else "broken"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--no-sandbox", action="store_true")
    ap.add_argument("--setup-only", action="store_true")
    a = ap.parse_args()
    workdir = os.path.abspath(a.workdir)
    fe = f"{workdir}/tree/studio-frontend"
    if not os.path.isdir(fe):
        sys.exit(f"{fe} not found: run prepare_review.py first")
    if not setup(workdir, fe, a.no_sandbox):
        sys.exit(2)
    if a.setup_only:
        print("setup done")
        return

    files = sorted(glob.glob(f"{workdir}/repro/*.test.ts") + glob.glob(f"{workdir}/repro/*.test.tsx"))
    if not files:
        sys.exit(f"no tests in {workdir}/repro/")
    placed, results = {}, {}
    for src in files:
        meta = header(src)
        if not meta.get("repro-for") or not meta.get("place"):
            results[os.path.basename(src)] = {"status": "broken", "file": src, "tests": [],
                                              "error": "missing '// repro-for:' or '// place:' header"}
            continue
        dest_dir = os.path.normpath(os.path.join(fe, meta["place"]))
        if not dest_dir.startswith(fe + "/") or not os.path.isdir(dest_dir):
            results[meta["repro-for"]] = {"status": "broken", "file": src, "tests": [], "error": f"bad place {meta['place']}"}
            continue
        dest = os.path.join(dest_dir, "zz-repro-" + os.path.basename(src))
        shutil.copyfile(src, dest)
        placed[dest] = (src, meta["repro-for"])

    try:
        by_config = {}
        for dest in placed:
            rel = os.path.relpath(dest, fe)
            config = "src-app/vitest.config.ts" if rel.startswith("src-app/") else "vitest.config.ts"
            by_config.setdefault(config, []).append(rel)
        for config, rels in by_config.items():
            out_json = f"{workdir}/repro/vitest-{config.replace('/', '_')}.json"
            cmd = ["npx", "vitest", "run", "--config", config, "--reporter=json", f"--outputFile={out_json}", *rels]
            code, out = sandboxed(cmd, fe, workdir, network=False, no_sandbox=a.no_sandbox, timeout=600)
            report = json.load(open(out_json)) if os.path.exists(out_json) else {"testResults": []}
            by_name = {os.path.realpath(r["name"]): r for r in report.get("testResults", [])}
            for rel in rels:
                dest = os.path.join(fe, rel)
                src, fid = placed[dest]
                r = by_name.get(os.path.realpath(dest), {"status": "failed", "assertionResults": [],
                                                         "message": out[-1500:]})
                results[fid] = {
                    "status": classify(r),
                    "file": src,
                    "command": f"cd studio-frontend && npx vitest run --config {config} {rel}",
                    "tests": [{"name": t["title"], "status": t["status"],
                               "message": (t.get("failureMessages") or [""])[0][:600]} for t in r.get("assertionResults") or []],
                    **({"error": (r.get("message") or out[-1500:])[:1500]} if not r.get("assertionResults") else {}),
                }
    finally:
        for dest in placed:
            if os.path.exists(dest):
                os.remove(dest)

    os.makedirs(f"{workdir}/findings", exist_ok=True)
    json.dump(results, open(f"{workdir}/findings/repro.json", "w"), indent=2, ensure_ascii=False)
    for fid, r in results.items():
        failing = [t["name"] for t in r["tests"] if t["status"] == "failed"]
        print(f"{fid:30s} {r['status']:15s} {'; '.join(failing)[:90]}" + (f"  !! {r.get('error', '')[:120]}" if r["status"] == "broken" else ""))
    print(f"-> {workdir}/findings/repro.json")


if __name__ == "__main__":
    main()
