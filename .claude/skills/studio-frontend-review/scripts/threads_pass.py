#!/usr/bin/env python3
"""Re-check our open review threads between rounds, so an answered thread is closed without waiting for a push.

A round re-checks threads only when the PR gets a new head with new lines under the scope. An author who
answers without pushing ("fixed in the previous commit", "not taken, because …"), or whose push changes nothing
under the scope, or whose PR is merged before the next round, would leave our threads open for good. This pass
covers those cases.

Usage:
  threads_pass.py find [--repo owner/name] [--merged-days 14]   PR numbers with threads to re-check, one per line
  threads_pass.py prepare <N> <workdir> [--repo owner/name]      worktree at the head + files for the orchestrator
  threads_pass.py record <workdir>                              remember the re-checked threads as handled

`find` looks at open PRs (not drafts) and PRs merged in the last --merged-days days that this skill has reviewed
(a local state file exists). An open PR qualifies only when its head is already reviewed — otherwise the next
round handles the threads; a merged PR always does. A thread needs a re-check when someone answered after our last word, or when nobody answered and the
commented lines changed (outdated). A thread already re-checked at its current last comment is skipped (state in
$REVIEW_RUNS/state/threads-handled.json), so a thread we deliberately leave open never costs another run.

`prepare` writes <workdir>/tree (detached worktree at the head), open-threads.json (only the threads to re-check),
plan.json (the head, for publish_review.py --plan), an empty approved.json and summary.md.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

import review_state
from prepare_review import own_threads, sh


def handled_path():
    return os.path.join(review_state.state_dir(), "threads-handled.json")


def load_handled():
    try:
        return json.load(open(handled_path()))
    except (OSError, ValueError):
        return {}


def pending(repo, n, me):
    handled = load_handled()
    threads = own_threads(repo, n, me) or []
    return [t for t in threads if t["needs_recheck"] and handled.get(t["thread_id"]) != t["last_comment_id"]]


def head_reviewed(repo, n, head, me):
    if any(e["sha"] == head for e in review_state.load_local(repo, n)):
        return True
    reviews = json.loads(sh("gh", "api", "--paginate", "--slurp", f"repos/{repo}/pulls/{n}/reviews?per_page=100"))
    return any(h["sha"] == head for h in review_state.reviewed_heads(repo, n, [r for p in reviews for r in p], me))


def cmd_find(a):
    me = sh("gh", "api", "user", "--jq", ".login").strip()
    since = (datetime.date.today() - datetime.timedelta(days=a.merged_days)).isoformat()
    fields = "number,isDraft,author,headRefOid,state"
    prs = json.loads(sh("gh", "pr", "list", "--repo", a.repo, "--state", "open", "--limit", "100", "--json", fields))
    prs += json.loads(sh("gh", "pr", "list", "--repo", a.repo, "--state", "merged", "--limit", "100",
                         "--search", f"merged:>={since}", "--json", fields))
    for pr in prs:
        n = pr["number"]
        if pr["isDraft"] or pr["author"]["login"] == me or not review_state.load_local(a.repo, n):
            continue
        # An open PR whose head is not reviewed yet gets a round, which re-checks the threads; a merged one never will.
        if pr["state"] == "OPEN" and not head_reviewed(a.repo, n, pr["headRefOid"], me):
            continue
        if pending(a.repo, n, me):
            print(n)


def cmd_prepare(a):
    me = sh("gh", "api", "user", "--jq", ".login").strip()
    n, workdir = int(a.pr), os.path.abspath(a.workdir)
    pr = json.loads(sh("gh", "pr", "view", str(n), "--repo", a.repo, "--json",
                       "number,title,state,headRefOid,baseRefName,url"))
    threads = pending(a.repo, n, me)
    os.makedirs(workdir, exist_ok=True)
    tree = f"{workdir}/tree"
    if not os.path.isdir(tree):
        sh("git", "fetch", "-q", "origin", f"pull/{n}/head")
        sh("git", "worktree", "add", "-q", "--detach", tree, pr["headRefOid"])
    json.dump(threads, open(f"{workdir}/open-threads.json", "w"), indent=2, ensure_ascii=False)
    json.dump({"repo": a.repo, "pr": pr, "round": None, "threads_only": True},
              open(f"{workdir}/plan.json", "w"), indent=2)
    open(f"{workdir}/approved.json", "w").write("[]\n")
    open(f"{workdir}/summary.md", "w").write("Threads re-checked between rounds.\n")
    print(f"PR #{n} ({pr['state'].lower()}) at {pr['headRefOid'][:10]}: {len(threads)} threads to re-check "
          f"-> {workdir}/open-threads.json, code at {tree}")


def cmd_record(a):
    threads = json.load(open(os.path.join(a.workdir, "open-threads.json")))
    handled = load_handled()
    for t in threads:
        if t.get("needs_recheck"):
            handled[t["thread_id"]] = t["last_comment_id"]
    os.makedirs(review_state.state_dir(), exist_ok=True)
    json.dump(handled, open(handled_path(), "w"), indent=2)
    print(f"{sum(bool(t.get('needs_recheck')) for t in threads)} threads recorded as re-checked")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("find")
    f.add_argument("--repo", default="constructorfabric/studio-web")
    f.add_argument("--merged-days", type=int, default=14)
    p = sub.add_parser("prepare")
    p.add_argument("pr")
    p.add_argument("workdir")
    p.add_argument("--repo", default="constructorfabric/studio-web")
    r = sub.add_parser("record")
    r.add_argument("workdir")
    a = ap.parse_args()
    {"find": cmd_find, "prepare": cmd_prepare, "record": cmd_record}[a.cmd](a)


if __name__ == "__main__":
    main()
