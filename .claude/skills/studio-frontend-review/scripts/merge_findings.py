#!/usr/bin/env python3
"""Merge per-agent findings, enforce the severity rule and split them for verification.

Usage: merge_findings.py <workdir>
Writes:
  findings/merged.json     every finding, with `source` (agent name) and a unique `id` ("<agent>:<id>")
  findings/to_verify.json  the verifier agent's input: blocker + major, or every finding when there are
                           more than 8 (an exhaustive round produces many minors; one verifier checks them all)
The rest is verified by the orchestrator itself (verdicts go to findings/self_verdicts.json).

Severity rule: blocker/major are for broken behaviour only. A blocker/major finding in a category that is
not about behaviour (tests, traceability, duplication, conventions, smell), or without a concrete
`failure`, is lowered to minor here and the change is printed — the reader triages by the label, so it
must mean the same thing on every PR.
The overview groups findings by file so overlapping reports from different agents are easy to spot.
"""
import glob
import json
import os
import sys
from collections import Counter, defaultdict

RESERVED = ("merged", "verified", "to_verify", "self_verdicts", "threads", "repro")
BEHAVIOUR = ("bug", "architecture", "spec")


def main():
    workdir = os.path.abspath(sys.argv[1])
    merged, capped = [], []
    for path in sorted(glob.glob(f"{workdir}/findings/*.json")):
        name = os.path.basename(path)[:-5]
        if name in RESERVED:
            continue
        try:
            items = json.load(open(path))
        except json.JSONDecodeError as e:
            print(f"!! {path}: invalid JSON ({e}) — ask that agent to fix it or read it by hand")
            continue
        for i, f in enumerate(items):
            f["source"] = name
            f["id"] = f"{name}:{f.get('id') or i + 1}"
            if f.get("severity") in ("blocker", "major") and (
                    f.get("category") not in BEHAVIOUR or not (f.get("failure") or "").strip()):
                capped.append(f"{f['id']} ({f.get('severity')} {f.get('category')}"
                              + ("" if (f.get("failure") or "").strip() else ", no failure scenario") + ")")
                f["severity_claimed"], f["severity"] = f["severity"], "minor"
            merged.append(f)
    json.dump(merged, open(f"{workdir}/findings/merged.json", "w"), indent=2, ensure_ascii=False)
    heavy = [f for f in merged if f.get("severity") in ("blocker", "major")]
    to_verify = merged if len(merged) > 8 else heavy
    json.dump(to_verify, open(f"{workdir}/findings/to_verify.json", "w"), indent=2, ensure_ascii=False)

    print(f"{len(merged)} findings -> {workdir}/findings/merged.json")
    print("  by severity:", dict(Counter(f.get("severity") for f in merged)))
    if capped:
        print(f"  lowered to minor (blocker/major is for broken behaviour with a failure scenario): {'; '.join(capped)}")
    if to_verify is merged:
        print(f"  all {len(merged)} -> findings/to_verify.json (more than 8: one sonnet verifier checks them all)")
    else:
        print(f"  {len(heavy)} blocker/major -> findings/to_verify.json (verifier agent if > 5, else verify yourself)")
        print(f"  {len(merged) - len(heavy)} minor/nit -> verify yourself, write findings/self_verdicts.json")
    missing = [f["id"] for f in merged if not (f.get("verify") or "").strip()]
    if missing:
        print(f"  !! no `verify` line: {', '.join(missing)} — add one while verifying")
    by_file = defaultdict(list)
    for f in merged:
        by_file[f.get("file") or "(no file)"].append(f)
    for file, items in sorted(by_file.items()):
        flag = "  <- several agents" if len({f["source"] for f in items}) > 1 else ""
        print(f"\n{file}{flag}")
        for f in items:
            pre = " pre-existing" if f.get("preexisting") else ""
            print(f"  {f['id']:28s} {f.get('severity', ''):7s} {f.get('category', ''):12s} L{f.get('line')}{pre}  {f.get('title', '')[:80]}")


if __name__ == "__main__":
    main()
