#!/usr/bin/env python3
"""Publish approved findings as a single GitHub review with inline comments.

Usage: publish_review.py <PR number> --findings approved.json --summary summary.md
                         [--repo owner/name] [--event COMMENT|APPROVE|REQUEST_CHANGES] [--dry-run]
                         [--head-sha <sha reviewed>] [--auto]

Every review ends with a hidden marker `<!-- studio-frontend-review sha=<head> -->`; find_prs.py uses it
to skip heads that were already reviewed. --head-sha aborts (exit 4) if the PR moved on since the review
started, so comments are never anchored to lines of a commit nobody reviewed. --auto labels the review
as automated.

Findings whose line is not part of the diff are appended to the review body as file:line references,
so nothing approved is silently dropped.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile

MARKER = "<!-- studio-frontend-review sha={sha} -->"
AUTO_NOTE = ("> 🤖 Automated review (Claude Code, `studio-frontend-review` skill), posted on behalf of @{login}. "
             "Findings are machine-verified but may still be wrong — reply in the thread if so.")

SEVERITY_LABEL = {"blocker": "**Blocker**", "major": "**Major**", "minor": "Minor", "nit": "Nit"}


def gh(args, stdin=None):
    res = subprocess.run(["gh"] + args, capture_output=True, text=True, input=stdin)
    if res.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])} failed:\n{res.stderr}")
    return res.stdout


def commentable_lines(patch):
    """Return ({right line numbers}, {left line numbers}) that GitHub accepts comments on."""
    right, left = set(), set()
    if not patch:
        return right, left
    r = l = 0
    for line in patch.split("\n"):
        m = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if m:
            l, r = int(m.group(1)), int(m.group(2))
            continue
        if line.startswith("+"):
            right.add(r); r += 1
        elif line.startswith("-"):
            left.add(l); l += 1
        elif line.startswith("\\"):
            continue
        else:
            right.add(r); left.add(l); r += 1; l += 1
    return right, left


def format_body(f):
    label = SEVERITY_LABEL.get(f.get("severity", ""), "")
    cat = f.get("category", "")
    head = f"{label} · {cat}" if label else cat
    return f"{head}\n\n{f['body'].strip()}" if head else f["body"].strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("--findings", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--repo")
    ap.add_argument("--event", default="COMMENT", choices=["COMMENT", "APPROVE", "REQUEST_CHANGES"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--head-sha")
    ap.add_argument("--auto", action="store_true")
    a = ap.parse_args()

    repo_args = ["--repo", a.repo] if a.repo else []
    meta = json.loads(gh(["pr", "view", a.pr, *repo_args, "--json", "number,url,headRefOid"]))
    owner_repo = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", meta["url"]).group(1)
    if a.head_sha and a.head_sha != meta["headRefOid"]:
        print(f"PR head moved: reviewed {a.head_sha[:10]}, now {meta['headRefOid'][:10]} — not publishing")
        sys.exit(4)
    pages = json.loads(gh(["api", "--paginate", "--slurp", f"repos/{owner_repo}/pulls/{meta['number']}/files?per_page=100"]))
    lines = {f["filename"]: commentable_lines(f.get("patch")) for page in pages for f in page}

    findings = json.load(open(a.findings))
    summary = open(a.summary).read().strip()

    comments, unanchored = [], []
    for f in findings:
        path, line, side = f.get("file"), f.get("line"), f.get("side", "RIGHT")
        ok = path in lines and line is not None and line in lines[path][0 if side == "RIGHT" else 1]
        if not ok:
            unanchored.append(f)
            continue
        c = {"path": path, "line": line, "side": side, "body": format_body(f)}
        start = f.get("start_line")
        if start and start < line and start in lines[path][0 if side == "RIGHT" else 1]:
            c["start_line"], c["start_side"] = start, side
        comments.append(c)

    body = summary
    if unanchored:
        body += "\n\n---\n\n"
        for f in unanchored:
            loc = f"`{f['file']}:{f['line']}`" if f.get("line") else (f"`{f['file']}`" if f.get("file") else "")
            text = format_body(f).replace("\n", "\n  ")
            body += f"- {loc} {text}\n\n"

    if a.auto:
        login = gh(["api", "user", "--jq", ".login"]).strip()
        body = AUTO_NOTE.format(login=login) + "\n\n" + body
    body += "\n\n" + MARKER.format(sha=a.head_sha or meta["headRefOid"])

    payload = {"commit_id": a.head_sha or meta["headRefOid"], "event": a.event, "body": body, "comments": comments}

    print(f"{len(comments)} inline comments, {len(unanchored)} in body, event {a.event}")
    if a.dry_run:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
        json.dump(payload, tmp)
    out = json.loads(gh(["api", "-X", "POST", f"repos/{owner_repo}/pulls/{meta['number']}/reviews", "--input", tmp.name]))
    print(out.get("html_url", out))


if __name__ == "__main__":
    main()
