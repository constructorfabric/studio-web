#!/usr/bin/env python3
"""Render the approval draft from findings and their verdicts.

Usage: render_draft.py <workdir> [--summary "text"] [--keep-nits]
Combines findings/merged.json with verdicts from findings/verified.json (verifier agent, blocker/major)
and findings/self_verdicts.json (orchestrator, minor/nit: {"<id>": {"verdict": ..., "verdict_reason": ...,
optional "severity"/"body"}}). Then:
  - drops rejected and duplicate findings;
  - drops nits when there are 5+ substantive findings (listed at the end, not posted);
  - folds minor documentation drift (findings on .md/.mdx/.txt files) into one comment when there are 2+;
  - sorts by severity then category priority and numbers the result.
Writes <workdir>/draft.md (for the user) and <workdir>/numbered.json (to build approved.json from).
"""
import argparse
import json
import os

SEVERITY = ["blocker", "major", "minor", "nit"]
CATEGORY = ["architecture", "spec", "bug", "duplication", "conventions", "smell", "tests"]


def rank(f):
    sev = f.get("severity", "nit")
    cat = f.get("category", "smell")
    return (SEVERITY.index(sev) if sev in SEVERITY else 9, CATEGORY.index(cat) if cat in CATEGORY else 9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--summary", default="<summary>")
    ap.add_argument("--keep-nits", action="store_true")
    a = ap.parse_args()
    wd = os.path.abspath(a.workdir)
    findings = json.load(open(f"{wd}/findings/merged.json"))
    plan = json.load(open(f"{wd}/plan.json"))

    # Apply verdicts: the verifier's (full records) and the orchestrator's own (patches by id).
    by_id = {f["id"]: f for f in findings}
    verified_path = f"{wd}/findings/verified.json"
    if os.path.exists(verified_path):
        for v in json.load(open(verified_path)):
            if v.get("id") in by_id:
                by_id[v["id"]].update(v)
    self_path = f"{wd}/findings/self_verdicts.json"
    if os.path.exists(self_path):
        for fid, patch in json.load(open(self_path)).items():
            if fid in by_id:
                by_id[fid].update(patch)
    unverified = [f["id"] for f in findings if not f.get("verdict")]
    if unverified:
        print(f"!! {len(unverified)} findings have no verdict yet: {', '.join(unverified)}")

    kept = [f for f in findings if f.get("verdict") not in ("rejected", "duplicate")]
    dropped = [f for f in findings if f.get("verdict") in ("rejected", "duplicate")]

    substantive = [f for f in kept if f.get("severity") != "nit"]
    nits_dropped = []
    if not a.keep_nits and len(substantive) >= 5:
        nits_dropped = [f for f in kept if f.get("severity") == "nit"]
        kept = substantive

    # One comment for minor doc drift instead of one per file.
    docs = [f for f in kept if f.get("severity") == "minor"
            and os.path.splitext(f.get("file") or "")[1] in (".md", ".mdx", ".txt")]
    if len(docs) >= 2:
        kept = [f for f in kept if f not in docs]
        body = "Documentation that no longer matches the code in this PR:\n\n" + "\n".join(
            f"- `{f['file']}{':' + str(f['line']) if f.get('line') else ''}` — {f['title']}" for f in docs)
        kept.append({"id": "docs-drift", "severity": "minor", "category": "spec", "file": docs[0]["file"],
                     "line": None, "title": f"Documentation drift in {len(docs)} places", "body": body,
                     "folded": [f["id"] for f in docs]})
    kept.sort(key=rank)
    for i, f in enumerate(kept, 1):
        f["n"] = i

    pr = plan["pr"]
    agents = "1 sonnet" if plan["single_agent"] else f"1 {plan['architecture_model']} + {len(plan['slices'])} sonnet"
    lines = [f"PR #{pr['number']} — {pr['title']}",
             f"({plan['reviewable_weight']} reviewable lines, {len(plan['slices'])} slices, agents: {agents}"
             + (" + 1 sonnet verifier" if os.path.exists(verified_path) else "") + ")", "",
             f"Summary: {a.summary}", ""]
    for f in kept:
        loc = f"{f.get('file')}:{f.get('line')}" if f.get("line") else f"{f.get('file')} (PR-wide)"
        tag = f" [{f['verdict']}]" if f.get("verdict") == "downgraded" else ""
        lines.append(f"[{f['n']}] {f.get('severity', '').upper()} · {f.get('category')} · {loc}{tag}")
        lines.append(f"    {f.get('title')}")
        for bl in f.get("body", "").strip().splitlines():
            lines.append(f"    {bl}")
        lines.append("")
    if dropped:
        lines.append("Dropped by verification: " + "; ".join(
            f"{f['id']} ({f['verdict']}{' of ' + f['duplicate_of'] if f.get('duplicate_of') else ''})" for f in dropped))
    if nits_dropped:
        lines.append("Nits not posted (5+ substantive findings): " + "; ".join(
            f"{f.get('file')}:{f.get('line')} {f.get('title')}" for f in nits_dropped))
    if plan["noise_files"]:
        lines.append("Skipped as noise: " + ", ".join(x["path"] for x in plan["noise_files"]))

    open(f"{wd}/draft.md", "w").write("\n".join(lines) + "\n")
    json.dump(kept, open(f"{wd}/numbered.json", "w"), indent=2, ensure_ascii=False)
    print(f"{len(kept)} findings in {wd}/draft.md ({len(dropped)} dropped)")
    for f in kept:
        print(f"[{f['n']:2d}] {f.get('severity', ''):6s} {f.get('category', ''):12s} {f.get('title', '')[:95]}")


if __name__ == "__main__":
    main()
