#!/usr/bin/env python3
"""Render the approval draft and the review summary from findings and their verdicts.

Usage: render_draft.py <workdir> [--summary "text"]
Combines findings/merged.json with verdicts from findings/verified.json (verifier agent) and
findings/self_verdicts.json (orchestrator: {"<id>": {"verdict": ..., "verdict_reason": ...,
optional "severity"/"body"/"verify"}}). Then:
  - drops rejected and duplicate findings (nits are kept: the round is exhaustive and tiered);
  - folds minor documentation drift (findings on .md/.mdx/.txt files) into one comment when there are 2+;
  - sorts by severity then category priority and numbers the result.
Writes <workdir>/draft.md (for the user), <workdir>/numbered.json (to build approved.json from) and
<workdir>/summary.md — a header saying what this round covered and the tier counts, then --summary.
Edit summary.md after changing the approved set; the header counts are for the full set.
"""
import argparse
import json
import os

SEVERITY = ["blocker", "major", "minor", "nit"]
LABEL = {"blocker": "BLOCKER", "major": "MAJOR", "minor": "SHOULD FIX", "nit": "NIT"}
CATEGORY = ["architecture", "spec", "bug", "traceability", "duplication", "conventions", "smell", "tests"]


def rank(f):
    sev = f.get("severity", "nit")
    cat = f.get("category", "smell")
    return (SEVERITY.index(sev) if sev in SEVERITY else 9, CATEGORY.index(cat) if cat in CATEGORY else 9)


def scope_header(plan, kept, threads):
    k, head = plan.get("round", 1), plan["pr"]["headRefOid"][:10]
    behaviour = sum(1 for f in kept if f.get("severity") in ("blocker", "major"))
    should = sum(1 for f in kept if f.get("severity") == "minor")
    nits = sum(1 for f in kept if f.get("severity") == "nit")
    counts = f"{behaviour} behaviour (blocker/major), {should} should-fix, {nits} nits"
    reproduced = sum(1 for f in kept if f.get("reproduced"))
    if reproduced:
        counts += f"; {reproduced} reproduced by a failing test on this head"
    if plan.get("since"):
        since = plan["since"][:10]
        text = (f"**Round {k}** — reviewed the lines under `{plan['scope']}` added since `{since}` (round {k - 1}); "
                f"code unchanged since then was not re-reviewed, except for behaviour bugs, marked pre-existing. "
                f"Findings: {counts}.")
    else:
        text = (f"**Round {k}** — the whole `{plan['scope']}` part of the PR at `{head}` was reviewed in one pass, "
                f"and this is the complete list of what could be verified: {counts}. "
                f"Later rounds review only lines changed after `{head}` and answer in existing threads.")
    if threads:
        text += f" Earlier threads re-checked: {threads}."
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--summary", default="<summary>")
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
    # Reproduction results (repro_tests.py): a failing test confirms, a passing one rejects — unless the
    # orchestrator's self_verdicts entry gives "repro_override" (why the test missed the path).
    repro_path = f"{wd}/findings/repro.json"
    repro = json.load(open(repro_path)) if os.path.exists(repro_path) else {}
    for fid, r in repro.items():
        f = by_id.get(fid)
        if not f:
            continue
        if r["status"] == "reproduced":
            failing = [t["name"] for t in r["tests"] if t["status"] == "failed"]
            f.update({"reproduced": True, "repro_file": r["file"], "repro_command": r["command"],
                      "repro_tests": failing})
            if f.get("verdict") in (None, "rejected"):
                f["verdict"], f["verdict_reason"] = "confirmed", "reproduction test fails on the head"
        elif r["status"] == "not-reproduced" and not f.get("repro_override"):
            f["verdict"], f["verdict_reason"] = "rejected", "reproduction test passes on the head"
        else:
            f["repro_status"] = r["status"]
    unverified = [f["id"] for f in findings if not f.get("verdict")]
    if unverified:
        print(f"!! {len(unverified)} findings have no verdict yet: {', '.join(unverified)}")

    kept = [f for f in findings if f.get("verdict") not in ("rejected", "duplicate")]
    dropped = [f for f in findings if f.get("verdict") in ("rejected", "duplicate")]

    # One comment for minor doc drift instead of one per file, anchored where the first one was.
    docs = [f for f in kept if f.get("severity") == "minor" and not f.get("preexisting")
            and os.path.splitext(f.get("file") or "")[1] in (".md", ".mdx", ".txt")]
    if len(docs) >= 2:
        kept = [f for f in kept if f not in docs]
        body = "Documentation that no longer matches the code in this PR:\n\n" + "\n".join(
            f"- `{f['file']}{':' + str(f['line']) if f.get('line') else ''}` — {f['title']}" for f in docs)
        kept.append({"id": "docs-drift", "severity": "minor", "category": "spec", "file": docs[0]["file"],
                     "line": docs[0].get("line"), "title": f"Documentation drift in {len(docs)} places", "body": body,
                     "verify": "; ".join(f.get("verify") for f in docs if f.get("verify")) or "",
                     "verdict": "confirmed", "folded": [f["id"] for f in docs]})
    kept.sort(key=rank)
    for i, f in enumerate(kept, 1):
        f["n"] = i

    threads_note = ""
    replies_path = f"{wd}/replies.json"
    if os.path.exists(replies_path):
        rs = json.load(open(replies_path))
        resolved = sum(1 for r in rs if r.get("action") == "resolve")
        answered = sum(1 for r in rs if r.get("action") == "reply")
        threads_note = f"{resolved} verified fixed and resolved, {answered} answered in their thread"

    pr = plan["pr"]
    agents = "1 sonnet" if plan["single_agent"] else f"1 {plan['architecture_model']} + {len(plan['slices'])} sonnet"
    header = scope_header(plan, kept, threads_note)
    lines = [f"PR #{pr['number']} — {pr['title']}",
             f"(round {plan.get('round', 1)}, {plan['reviewable_weight']} reviewable lines, {len(plan['slices'])} slices, "
             f"agents: {agents}" + (" + 1 sonnet verifier" if os.path.exists(verified_path) else "") + ")", "",
             header, "", f"Summary: {a.summary}", ""]
    for f in kept:
        loc = f"{f.get('file')}:{f.get('line')}" if f.get("line") else f"{f.get('file')} (no line — anchor it before publishing)"
        tags = [t for t in (f["verdict"] if f.get("verdict") == "downgraded" else "",
                            "REPRODUCED" if f.get("reproduced") else "",
                            f"repro {f['repro_status']}" if f.get("repro_status") else "",
                            "pre-existing" if f.get("preexisting") else "",
                            f"claimed {f['severity_claimed']}" if f.get("severity_claimed") else "") if t]
        lines.append(f"[{f['n']}] {LABEL.get(f.get('severity'), '?')} · {f.get('category')} · {loc}"
                     + (f" [{', '.join(tags)}]" if tags else ""))
        lines.append(f"    {f.get('title')}")
        for bl in f.get("body", "").strip().splitlines():
            lines.append(f"    {bl}")
        lines.append(f"    How to verify: {f.get('verify') or '(missing — add one)'}")
        lines.append("")
    if dropped:
        lines.append("Dropped by verification: " + "; ".join(
            f"{f['id']} ({f['verdict']}{' of ' + f['duplicate_of'] if f.get('duplicate_of') else ''})" for f in dropped))
    if plan["noise_files"]:
        lines.append("Skipped as noise: " + ", ".join(x["path"] for x in plan["noise_files"]))

    open(f"{wd}/draft.md", "w").write("\n".join(lines) + "\n")
    open(f"{wd}/summary.md", "w").write(header + "\n\n" + a.summary.strip() + "\n")
    json.dump(kept, open(f"{wd}/numbered.json", "w"), indent=2, ensure_ascii=False)
    print(f"{len(kept)} findings in {wd}/draft.md ({len(dropped)} dropped); summary in {wd}/summary.md")
    for f in kept:
        print(f"[{f['n']:2d}] {LABEL.get(f.get('severity'), '?'):10s} {f.get('category', ''):12s} {f.get('title', '')[:90]}")


if __name__ == "__main__":
    main()
