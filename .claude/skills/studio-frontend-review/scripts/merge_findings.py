#!/usr/bin/env python3
"""Merge per-agent findings and split them for verification.

Usage: merge_findings.py <workdir>
Writes:
  findings/merged.json     every finding, with `source` (agent name) and a unique `id` ("<agent>:<id>")
  findings/to_verify.json  blocker + major only — the verifier agent's input
Minor and nit findings are verified by the orchestrator itself (verdicts go to findings/self_verdicts.json).
The overview groups findings by file so overlapping reports from different agents are easy to spot.
"""
import glob
import json
import os
import sys
from collections import Counter, defaultdict


def main():
    workdir = os.path.abspath(sys.argv[1])
    merged = []
    for path in sorted(glob.glob(f"{workdir}/findings/*.json")):
        name = os.path.basename(path)[:-5]
        if name in ("merged", "verified", "to_verify", "self_verdicts"):
            continue
        try:
            items = json.load(open(path))
        except json.JSONDecodeError as e:
            print(f"!! {path}: invalid JSON ({e}) — ask that agent to fix it or read it by hand")
            continue
        for i, f in enumerate(items):
            f["source"] = name
            f["id"] = f"{name}:{f.get('id') or i + 1}"
            merged.append(f)
    json.dump(merged, open(f"{workdir}/findings/merged.json", "w"), indent=2, ensure_ascii=False)
    heavy = [f for f in merged if f.get("severity") in ("blocker", "major")]
    json.dump(heavy, open(f"{workdir}/findings/to_verify.json", "w"), indent=2, ensure_ascii=False)

    print(f"{len(merged)} findings -> {workdir}/findings/merged.json")
    print("  by severity:", dict(Counter(f.get("severity") for f in merged)))
    print(f"  {len(heavy)} blocker/major -> findings/to_verify.json (verifier agent if > 5, else verify yourself)")
    print(f"  {len(merged) - len(heavy)} minor/nit -> verify yourself, write findings/self_verdicts.json")
    by_file = defaultdict(list)
    for f in merged:
        by_file[f.get("file") or "(no file)"].append(f)
    for file, items in sorted(by_file.items()):
        flag = "  <- several agents" if len({f["source"] for f in items}) > 1 else ""
        print(f"\n{file}{flag}")
        for f in items:
            print(f"  {f['id']:28s} {f.get('severity', ''):7s} {f.get('category', ''):12s} L{f.get('line')}  {f.get('title', '')[:80]}")


if __name__ == "__main__":
    main()
