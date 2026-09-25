#!/usr/bin/env python3
"""Publish approved findings as one GitHub review with inline comments, plus replies in earlier threads.

Usage: publish_review.py <PR number> --findings approved.json --summary summary.md
                         [--repo owner/name] [--event COMMENT|APPROVE|REQUEST_CHANGES] [--dry-run]
                         [--head-sha <sha reviewed>] [--plan plan.json] [--replies replies.json]
                         [--quiet-if-empty] [--auto]

Every review ends with a hidden marker `<!-- studio-frontend-review sha=<head> round=<k> -->`; find_prs.py
and plan_review.py use it to skip reviewed heads and to review only newer lines next time. --head-sha
aborts (exit 4) if the PR moved on since the review started, so comments are never anchored to lines of
a commit nobody reviewed. --plan supplies the round and the previous head (for "pre-existing" labels).

Every finding is posted inline. One whose line is not commentable goes on the nearest commentable line
of the same file ("Line N:" prefix); one whose file is not in the diff is refused — re-anchor it.

--replies: [{"thread_id", "comment_id", "action": "reply"|"resolve", "body"}] — a reply is posted in
the thread of `comment_id`; resolve marks `thread_id` resolved (with an optional reply first).
--quiet-if-empty: no findings → post no review (replies still go out). The head is recorded locally as
reviewed (review_state.py) either way, so it is not picked up again. --auto labels the review as automated.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile

import review_state

AUTO_NOTE = ("> 🤖 Automated review (Claude Code, `studio-frontend-review` skill), posted on behalf of @{login}. "
             "Findings are machine-verified but may still be wrong — reply in the thread if so.")
AUTO_REPLY = "🤖 "
SEVERITY_LABEL = {"blocker": "**Blocker**", "major": "**Major**", "minor": "**Should fix**", "nit": "Nit"}
RESOLVE = "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }"


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


def format_body(f, plan, moved_from=None):
    head = f"{SEVERITY_LABEL.get(f.get('severity', ''), '')} · {f.get('category', '')}".strip(" ·")
    if f.get("preexisting") and plan and plan.get("since"):
        k = plan.get("round", 2)
        head += f" · pre-existing at `{plan['since'][:10]}`, not raised in round {k - 1}"
    text = (f"Line {moved_from}: " if moved_from else "") + f["body"].strip()
    body = f"{head}\n\n{text}" if head else text
    if f.get("reproduced") and f.get("repro_file"):
        sha = (plan or {}).get("pr", {}).get("headRefOid", "")[:7]
        tests = f.get("repro_tests") or []
        failing = ", ".join(f"`{t}`" for t in tests)
        body += f"\n\n**Reproduced** on `{sha}`: {failing} {'fails' if len(tests) == 1 else 'fail'} (control cases pass)."
        saved_as = f["repro_command"].split()[-1]
        body += f"\n\n**How to verify:** save the test below as `studio-frontend/{saved_as}` and run `{f['repro_command']}`"
        try:
            code = [l for l in open(f["repro_file"]).read().splitlines() if not re.match(r"^//\s*(repro-for|place):", l)]
        except OSError:
            code = []
        if code:
            shown = "\n".join(code[:150]) + ("\n// … (truncated)" if len(code) > 150 else "")
            body += f"\n\n<details><summary>Reproduction test</summary>\n\n```ts\n{shown}\n```\n</details>"
    elif (f.get("verify") or "").strip():
        body += f"\n\n**How to verify:** {f['verify'].strip()}"
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("--findings", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--repo")
    ap.add_argument("--event", default="COMMENT", choices=["COMMENT", "APPROVE", "REQUEST_CHANGES"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--head-sha")
    ap.add_argument("--plan")
    ap.add_argument("--replies")
    ap.add_argument("--quiet-if-empty", action="store_true")
    ap.add_argument("--auto", action="store_true")
    a = ap.parse_args()

    repo_args = ["--repo", a.repo] if a.repo else []
    meta = json.loads(gh(["pr", "view", a.pr, *repo_args, "--json", "number,url,headRefOid"]))
    owner_repo = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", meta["url"]).group(1)
    if a.head_sha and a.head_sha != meta["headRefOid"]:
        print(f"PR head moved: reviewed {a.head_sha[:10]}, now {meta['headRefOid'][:10]} — not publishing")
        sys.exit(4)
    head = a.head_sha or meta["headRefOid"]
    plan = json.load(open(a.plan)) if a.plan else None
    pages = json.loads(gh(["api", "--paginate", "--slurp", f"repos/{owner_repo}/pulls/{meta['number']}/files?per_page=100"]))
    lines = {f["filename"]: commentable_lines(f.get("patch")) for page in pages for f in page}

    findings = json.load(open(a.findings))
    summary = open(a.summary).read().strip()
    replies = json.load(open(a.replies)) if a.replies else []

    comments, refused = [], []
    for f in findings:
        path, line, side = f.get("file"), f.get("line"), f.get("side", "RIGHT")
        if path not in lines or not lines[path][0 if side == "RIGHT" else 1]:
            refused.append(f)
            continue
        allowed = lines[path][0 if side == "RIGHT" else 1]
        moved_from = None
        if line not in allowed:
            # Nearest commentable line of the same file; the body says which line the comment is about.
            moved_from = line
            line = min(allowed, key=lambda x: abs(x - (line or 0)))
        body = format_body(f, plan, moved_from)
        c = {"path": path, "line": line, "side": side, "body": body}
        start = f.get("start_line")
        if start and start < line and start in allowed and all(x in allowed for x in range(start, line + 1)):
            c["start_line"], c["start_side"] = start, side
        comments.append(c)
    if refused:
        for f in refused:
            print(f"!! not in the diff, can't post inline: {f.get('file')}:{f.get('line')} {f.get('title', '')[:80]}")
        sys.exit("re-anchor these findings on a changed line of a file in the diff (nothing is posted only in the summary)")

    login = gh(["api", "user", "--jq", ".login"]).strip()
    body = summary
    if a.auto:
        body = AUTO_NOTE.format(login=login) + "\n\n" + body
    body += "\n\n" + review_state.MARKER.format(sha=head, round=(plan or {}).get("round", 1))
    payload = {"commit_id": head, "event": a.event, "body": body, "comments": comments}
    post_review = bool(comments) or not a.quiet_if_empty

    print(f"{len(comments)} inline comments, event {a.event}"
          + ("" if post_review else " — no findings, no review posted (--quiet-if-empty)"))
    print(f"{sum(r.get('action') == 'reply' or bool(r.get('body')) for r in replies)} thread replies, "
          f"{sum(r.get('action') == 'resolve' for r in replies)} threads to resolve")
    if a.dry_run:
        print(json.dumps({"review": payload if post_review else None, "replies": replies}, indent=2, ensure_ascii=False))
        return

    if post_review:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            json.dump(payload, tmp)
        out = json.loads(gh(["api", "-X", "POST", f"repos/{owner_repo}/pulls/{meta['number']}/reviews", "--input", tmp.name]))
        print(out.get("html_url", out))
    for r in replies:
        if (r.get("body") or "").strip():
            text = (AUTO_REPLY if a.auto else "") + r["body"].strip()
            gh(["api", "-X", "POST", f"repos/{owner_repo}/pulls/{meta['number']}/comments/{r['comment_id']}/replies",
                "-f", f"body={text}"])
        if r.get("action") == "resolve" and r.get("thread_id"):
            gh(["api", "graphql", "-f", f"query={RESOLVE}", "-F", f"id={r['thread_id']}"])
    review_state.record(owner_repo, meta["number"], head, posted=post_review,
                        note=f"round {(plan or {}).get('round', 1)}: {len(comments)} findings, {len(replies)} thread actions")


if __name__ == "__main__":
    main()
