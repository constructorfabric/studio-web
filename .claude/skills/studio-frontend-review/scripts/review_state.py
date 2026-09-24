"""Which heads of a PR this skill has already reviewed.

Two sources, merged: the hidden marker on reviews posted by the authenticated `gh` user
(`<!-- studio-frontend-review sha=<head> round=<k> -->`), and a local record for heads that were reviewed
without posting anything (a follow-up round with no new findings, nothing new under the scope). The local
record lives in `$REVIEW_RUNS/state/` (default `~/.cache/studio-frontend-review/state/`).
Imported by plan_review.py, publish_review.py and find_prs.py.
"""
import json
import os
import re
import time

MARKER = "<!-- studio-frontend-review sha={sha} round={round} -->"
MARKER_RE = re.compile(r"<!-- studio-frontend-review sha=([0-9a-f]{7,40})(?: round=(\d+))? -->")


def state_dir():
    runs = os.environ.get("REVIEW_RUNS") or os.path.expanduser("~/.cache/studio-frontend-review")
    return os.path.join(runs, "state")


def _path(repo, pr):
    return os.path.join(state_dir(), f"{repo.replace('/', '__')}-{pr}.json")


def load_local(repo, pr):
    try:
        with open(_path(repo, pr)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return []


def record(repo, pr, sha, posted, note=""):
    """Remember that `sha` was reviewed (posted=False: reviewed, nothing posted)."""
    entries = load_local(repo, pr)
    if any(e["sha"] == sha for e in entries):
        return
    entries.append({"sha": sha, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "posted": posted, "note": note})
    os.makedirs(state_dir(), exist_ok=True)
    with open(_path(repo, pr), "w") as fh:
        json.dump(entries, fh, indent=2)


def reviewed_heads(repo, pr, reviews, me):
    """Reviewed heads, oldest first: [{"sha", "at", "url"}]. `reviews` is the flat REST list of PR reviews."""
    seen = {}
    for r in reviews:
        if (r.get("user") or {}).get("login") != me:
            continue
        m = MARKER_RE.search(r.get("body") or "")
        if m and m.group(1) not in seen:
            seen[m.group(1)] = {"sha": m.group(1), "at": r.get("submitted_at") or "", "url": r.get("html_url")}
    for e in load_local(repo, pr):
        seen.setdefault(e["sha"], {"sha": e["sha"], "at": e["at"], "url": None})
    return sorted(seen.values(), key=lambda h: h["at"])
