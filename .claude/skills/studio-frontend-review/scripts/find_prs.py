#!/usr/bin/env python3
"""List open PRs that touch the review scope and whose current head has not been reviewed yet.

Usage: find_prs.py [--repo owner/name] [--scope studio-frontend/] [--include-drafts] [--include-own]
                   [--json]
A head counts as reviewed when a review by the authenticated `gh` user carries the marker that
publish_review.py writes (`<!-- studio-frontend-review sha=<head> ... -->`), or when review_state.py has a
local record of it (a quiet follow-up round, or a head with nothing new to review).
Prints one PR number per line (or a JSON array with --json).
"""
import argparse
import json
import subprocess
import sys

import review_state


def gh(args):
    res = subprocess.run(["gh"] + args, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])} failed:\n{res.stderr}")
    return res.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="constructorfabric/studio-web")
    ap.add_argument("--scope", default="studio-frontend/")
    ap.add_argument("--include-drafts", action="store_true")
    ap.add_argument("--include-own", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    me = gh(["api", "user", "--jq", ".login"]).strip()
    prs = json.loads(gh(["pr", "list", "--repo", a.repo, "--state", "open", "--limit", "100",
                         "--json", "number,title,isDraft,author,headRefOid,files"]))
    todo = []
    for pr in prs:
        if pr["isDraft"] and not a.include_drafts:
            continue
        if pr["author"]["login"] == me and not a.include_own:
            continue
        # `gh pr list` returns at most 100 files per PR; a bigger PR that touches the scope only
        # beyond that is re-checked by plan_review.py, which exits 3 when nothing is in scope.
        paths = [f["path"] for f in pr.get("files") or []]
        if len(paths) < 100 and not any(p.startswith(a.scope) for p in paths):
            continue
        if any(e["sha"] == pr["headRefOid"] for e in review_state.load_local(a.repo, pr["number"])):
            continue
        marker = f"studio-frontend-review sha={pr['headRefOid']}"
        reviews = json.loads(gh(["api", "--paginate", "--slurp",
                                 f"repos/{a.repo}/pulls/{pr['number']}/reviews?per_page=100"]))
        if any(r["user"]["login"] == me and marker in (r.get("body") or "")
               for page in reviews for r in page):
            continue
        todo.append({"number": pr["number"], "title": pr["title"], "head": pr["headRefOid"],
                     "author": pr["author"]["login"]})

    if a.json:
        print(json.dumps(todo, indent=2, ensure_ascii=False))
    else:
        for pr in todo:
            print(pr["number"])


if __name__ == "__main__":
    main()
