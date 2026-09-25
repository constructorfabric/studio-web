#!/usr/bin/env python3
"""Plan a PR review: filter noise, weigh files, pack them into similar-sized slices.

Usage: plan_review.py <PR number or URL> [--repo owner/name] [--out plan.json]
                      [--target 700] [--max-slices 8] [--scope studio-frontend/] [--full] [--record-skips]
Only files under --scope are reviewed; the rest of the PR is listed as out of scope.

Rounds. Round 1 reviews every changed line. When an earlier head of the PR was already reviewed
(review_state.py), the next round reviews only the lines added since that head — compared by the content
of the PR's own added lines, so a rebase onto a newer base does not count as new code. --full forces a
round-1 style review of everything.

Exit codes: 3 — nothing under --scope; 5 — follow-up round with no new lines under --scope since the last
reviewed head. With --record-skips (the unattended runner) both are recorded as reviewed, so the same head
is not planned again. Run from inside a local clone of the repo; requires `gh` authenticated for it.
"""
import argparse
import fnmatch
import json
import math
import os
import re
import subprocess
import sys
from collections import Counter, OrderedDict

import review_state

NOISE_PATTERNS = [
    "*package-lock.json", "*pnpm-lock.yaml", "*yarn.lock", "*Cargo.lock", "*go.sum",
    "*poetry.lock", "*uv.lock", "*Gemfile.lock", "*composer.lock", "*.lock",
    "*.snap", "*__snapshots__/*", "*.min.js", "*.min.css", "*.map",
    "dist/*", "*/dist/*", "dist-lib/*", "*/dist-lib/*", "build/*", "*/build/*",
    "vendor/*", "*/vendor/*", "node_modules/*", "*/node_modules/*",
    "*.generated.*", "*.gen.*", "*/generated/*", "*_generated.*", "*.pb.go", "*_pb2.py",
    "*.svg", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico", "*.woff", "*.woff2", "*.ttf",
    "*.pdf", "*.zip",
]

ARCH_SIGNAL_PATTERNS = [
    "*openapi*", "*swagger*", "*.proto", "*schema*", "*contract*", "*migrations/*", "*migration*",
    "*package.json", "*Cargo.toml", "*go.mod", "*pyproject.toml", "*docker-compose*", "*Dockerfile*",
    "docs/adr/*", "*/adr/*", "*routes*", "*router*", "*events*", "*errors*",
]

SPEC_PATTERNS = [
    "docs/adr/*.md", "*/adr/*.md", "*PRD*", "*prd*", "docs/*.md", "*/docs/*.md",
    "CLAUDE.md", "*/CLAUDE.md", "AGENTS.md", "*/AGENTS.md", "PRODUCT.md", "*spec*.md",
]

# Data-like files: reviewed, but a line of JSON/grammar costs far less attention than a line of code.
DATA_PATTERNS = ["*.json", "*.tmLanguage*", "*.csv", "*.xml"]
DATA_EXCEPTIONS = ["*package.json", "*tsconfig*.json", "*openapi*", "*schema*"]

# Styling, demos, stories and prose: still reviewed (tokens, conventions, spec drift), but a line needs
# roughly half the attention of a line of logic.
LIGHT_PATTERNS = ["*.css", "*.scss", "*.sass", "*.less", "*.stories.*", "*/demo/*", "*/examples/*",
                  "*/stories/*", "*.md", "*.mdx", "*.txt"]

TEST_RE = re.compile(r"(\.|_)(test|spec|e2e)(\.|_)|(^|/)(__tests__|tests?|e2e)/")


def gh(args):
    res = subprocess.run(["gh"] + args, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"gh {' '.join(args)} failed:\n{res.stderr}")
    return res.stdout


def git(*args):
    res = subprocess.run(["git", *args], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {res.stderr.strip()}")
    return res.stdout


def added_lines(a, b, scope):
    """{path: [(new line number, stripped content)]} for the lines added between commits a and b."""
    out = git("diff", "-U0", "--no-color", "--no-renames", a, b, "--", scope or ".")
    res, path, r, in_header = {}, None, 0, False
    for line in out.split("\n"):
        if line.startswith("diff --git "):
            path, in_header = None, True
            continue
        if in_header:
            if line.startswith("+++ "):
                path = None if line[4:] == "/dev/null" else line[6:]
                continue
            if not line.startswith("@@"):
                continue
            in_header = False
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if m:
            r = int(m.group(1))
            continue
        if path and line.startswith("+"):
            res.setdefault(path, []).append((r, line[1:].strip()))
            r += 1
    return res


def git_files(base, head):
    """The PR's files between two commits, shaped like the GitHub files API returns them (for --at)."""
    status = {"A": "added", "M": "modified", "D": "removed", "T": "modified"}
    kinds = dict(l.split("\t", 1)[::-1] for l in git("diff", "--name-status", "--no-renames", base, head).splitlines())
    out = []
    for line in git("diff", "--numstat", "--no-renames", base, head).splitlines():
        add, dele, path = line.split("\t", 2)
        adds, dels = (0, 0) if add == "-" else (int(add), int(dele))
        f = {"filename": path, "status": status.get(kinds.get(path, "M")[0], "modified"),
             "additions": adds, "deletions": dels, "changes": adds + dels}
        if add != "-":
            patch = git("diff", "--no-color", "--no-renames", base, head, "--", path)
            f["patch"] = patch[patch.find("\n@@") + 1:] if "\n@@" in patch else ""
        out.append(f)
    return out


def lines_new_since(since, head, base_ref, scope):
    """{path: [line numbers at head]} of the PR's added lines that were not among its added lines at `since`.
    Each side is diffed against its own merge-base, so base-branch changes pulled in by a rebase don't
    count as new. Blank lines are ignored."""
    mb_head = git("merge-base", base_ref, head).strip()
    mb_since = git("merge-base", base_ref, since).strip()
    now, before = added_lines(mb_head, head, scope), added_lines(mb_since, since, scope)
    new = {}
    for path, lines in now.items():
        old = Counter(c for _, c in before.get(path, []))
        for n, c in lines:
            if not c:
                continue
            if old[c] > 0:
                old[c] -= 1
            else:
                new.setdefault(path, []).append(n)
    return new


def ranges(nums):
    """[3, 4, 5, 9] -> "3-5, 9"."""
    out, start, prev = [], None, None
    for n in sorted(nums):
        if start is not None and n == prev + 1:
            prev = n
            continue
        if start is not None:
            out.append(f"{start}-{prev}" if prev > start else str(start))
        start = prev = n
    if start is not None:
        out.append(f"{start}-{prev}" if prev > start else str(start))
    return ", ".join(out)


def matches(path, patterns):
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def group_key(path):
    """Feature-level grouping: the file's directory, up to 5 segments deep (tests fold onto their source dir)."""
    parts = path.split("/")[:-1]
    parts = [p for p in parts if p not in ("__tests__", "tests", "test", "e2e", "__snapshots__")]
    return "/".join(parts[:5]) or "."


def source_stem(path):
    base = os.path.basename(path)
    base = re.sub(r"(\.|_)(test|spec|e2e)(?=\.)", "", base)
    return base.split(".")[0]


def changed_new_lines(patch):
    """Line numbers in the new file that were added (for splitting one big file into ranges)."""
    out, r = [], 0
    for line in (patch or "").split("\n"):
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", line)
        if m:
            r = int(m.group(1)); continue
        if line.startswith("+"):
            out.append(r); r += 1
        elif not line.startswith("-") and not line.startswith("\\"):
            r += 1
    return out


def split_file(f, cap):
    """Split a single oversized file into pieces covering ranges of its new-file lines."""
    lines = f["_changed_lines"]
    n = math.ceil(f["weight"] / cap)
    if n <= 1 or len(lines) < n:
        return [f]
    size = math.ceil(len(lines) / n)
    pieces = []
    for i in range(n):
        chunk = lines[i * size:(i + 1) * size]
        if not chunk:
            break
        start = 1 if i == 0 else chunk[0]
        end = chunk[-1] if i < n - 1 else None
        pieces.append({**f, "weight": f["weight"] * len(chunk) / len(lines),
                       "lines": f"{start}-{end if end else 'end'}"})
    return pieces


def pack(groups, target, max_slices):
    """Pack groups into n slices in path order; split a group only if it alone exceeds 1.3x the cap."""
    total = sum(g["weight"] for g in groups)
    n = max(1, math.ceil(total / target))
    over_budget = n > max_slices
    if over_budget:
        n = max_slices
    cap = max(target, total / n)

    units = []
    for g in groups:
        g = {**g, "files": [p for f in g["files"] for p in (split_file(f, cap) if f["weight"] > 1.3 * cap else [f])]}
        if g["weight"] > 1.3 * cap and len(g["files"]) > 1:
            chunk, w = [], 0
            for f in g["files"]:
                if chunk and w + f["weight"] > cap:
                    units.append({"key": g["key"], "files": chunk, "weight": w})
                    chunk, w = [], 0
                chunk.append(f)
                w += f["weight"]
            if chunk:
                units.append({"key": g["key"], "files": chunk, "weight": w})
        else:
            units.append(g)

    # Pack in path order so neighbouring feature folders share a slice (locality helps the reviewer see
    # how files relate); close a slice once it reaches its share of the total.
    share = total / n
    slices, cur = [], {"files": [], "weight": 0, "areas": []}
    for u in sorted(units, key=lambda u: u["files"][0]["path"]):
        if cur["files"] and cur["weight"] + u["weight"] / 2 > share and len(slices) < n - 1:
            slices.append(cur)
            cur = {"files": [], "weight": 0, "areas": []}
        cur["files"].extend(u["files"])
        cur["weight"] += u["weight"]
        if u["key"] not in cur["areas"]:
            cur["areas"].append(u["key"])
    slices.append(cur)
    slices = [s for s in slices if s["files"]]
    for i, s in enumerate(slices, 1):
        s["id"] = i
        s["weight"] = round(s["weight"])
        s["files"].sort(key=lambda f: (f["path"], f.get("lines", "")))
        for f in s["files"]:
            f.pop("_changed_lines", None)
            f["weight"] = round(f["weight"])
    return slices, over_budget


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("--repo")
    ap.add_argument("--out")
    ap.add_argument("--target", type=int, default=700)
    ap.add_argument("--max-slices", type=int, default=8)
    ap.add_argument("--scope", default="studio-frontend/", help="path prefix to review; '' for the whole PR")
    ap.add_argument("--full", action="store_true", help="review every changed line even if an earlier head was reviewed")
    ap.add_argument("--record-skips", action="store_true", help="record exit 3/5 heads as reviewed (unattended runs)")
    ap.add_argument("--at", help="benchmark: plan a blind round 1 of the PR as it was at this commit "
                                 "(files from git, no earlier rounds; prepare_review.py then hides every comment)")
    ap.add_argument("--body-file", help="use this file as the PR description (e.g. the version before any review)")
    a = ap.parse_args()

    repo_args = ["--repo", a.repo] if a.repo else []
    meta = json.loads(gh(["pr", "view", a.pr, *repo_args, "--json",
                          "number,title,body,url,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,author,isDraft"]))
    owner_repo = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", meta["url"]).group(1)
    files = json.loads(gh(["api", "--paginate", "--slurp", f"repos/{owner_repo}/pulls/{meta['number']}/files?per_page=100"]))
    files = [f for page in files for f in page]
    if a.at:
        # Benchmark: the PR as it was at an earlier commit. Files come from git against the merge-base.
        git("fetch", "-q", "origin", meta["baseRefName"], f"pull/{meta['number']}/head", a.at)
        meta["headRefOid"] = git("rev-parse", a.at).strip()
        mb = git("merge-base", f"origin/{meta['baseRefName']}", meta["headRefOid"]).strip()
        files = git_files(mb, meta["headRefOid"])
        meta["additions"] = sum(f["additions"] for f in files)
        meta["deletions"] = sum(f["deletions"] for f in files)
        meta["changedFiles"] = len(files)
    if a.body_file:
        meta["body"] = open(a.body_file).read()
    head = meta["headRefOid"]

    def skip(code, msg):
        print(f"PR #{meta['number']}: {msg} — skipping")
        if a.record_skips:
            review_state.record(owner_repo, meta["number"], head, posted=False, note=msg)
        sys.exit(code)

    # Earlier rounds: heads this skill already reviewed, other than the current one.
    previous = []
    if not a.at:
        me = gh(["api", "user", "--jq", ".login"]).strip()
        reviews = [r for page in json.loads(gh(["api", "--paginate", "--slurp",
                   f"repos/{owner_repo}/pulls/{meta['number']}/reviews?per_page=100"])) for r in page]
        previous = [h for h in review_state.reviewed_heads(owner_repo, meta["number"], reviews, me) if h["sha"] != head]
    since, new_lines, since_note = None, None, ""
    if previous and not a.full:
        since = previous[-1]["sha"]
        try:
            git("fetch", "-q", "origin", meta["baseRefName"], f"pull/{meta['number']}/head", since)
            new_lines = lines_new_since(since, head, f"origin/{meta['baseRefName']}", a.scope)
        except RuntimeError as e:
            # The reviewed head is gone (force-push, then GC) or unreachable: review everything instead.
            since_note = f"could not diff against the last reviewed head {since[:10]} ({e}); reviewing everything"
            since, new_lines = None, None

    reviewable, noise, out_of_scope, unchanged_since = [], [], [], []
    arch_signals = []
    for f in files:
        path, status = f["filename"], f["status"]
        entry = {"path": path, "status": status, "additions": f["additions"], "deletions": f["deletions"]}
        if a.scope and not path.startswith(a.scope):
            out_of_scope.append(entry)
            continue
        # Only explicit patterns count as noise. A file GitHub returns without a patch (too large) is
        # still reviewed — agents read its diff from the worktree — so nothing big slips through.
        if matches(path, NOISE_PATTERNS):
            noise.append(entry)
            continue
        if matches(path, DATA_PATTERNS) and not matches(path, DATA_EXCEPTIONS):
            factor = 0.3
        elif matches(path, LIGHT_PATTERNS):
            factor = 0.5
        else:
            factor = 1.0
        if new_lines is not None:
            # Follow-up round: only lines added since the last reviewed head are in scope.
            fresh = new_lines.get(path, [])
            if not fresh:
                unchanged_since.append(path)
                continue
            entry["new_lines"] = ranges(fresh)
            entry["weight"] = factor * len(fresh)
            entry["_changed_lines"] = fresh
        else:
            entry["weight"] = factor * (f["additions"] + 0.3 * f["deletions"])
            entry["_changed_lines"] = changed_new_lines(f.get("patch"))
        if "patch" not in f and f["changes"] > 0:
            entry["no_github_patch"] = True
        entry["is_test"] = bool(TEST_RE.search(path))
        reviewable.append(entry)
        if matches(path, ARCH_SIGNAL_PATTERNS):
            arch_signals.append(f"touches {path}")

    new_dirs = sorted({os.path.dirname(f["path"]) for f in reviewable if f["status"] == "added"}
                      - {os.path.dirname(f["path"]) for f in reviewable if f["status"] != "added"})
    new_dirs = [d for d in new_dirs if not any(d.startswith(o + "/") for o in new_dirs if o != d)]
    for d in new_dirs[:10]:
        arch_signals.append(f"new directory {d}/")

    body = meta.get("body") or ""
    issue_refs = sorted(set(re.findall(r"(?<![\w/])#(\d+)", body)))
    tracker_refs = sorted(set(re.findall(r"\b[A-Z][A-Z0-9]+-\d+\b", body)))
    if re.search(r"\b(ADR|PRD|RFC)\b", body, re.I):
        arch_signals.append("PR description references ADR/PRD/RFC")

    # Keep a test next to the source it tests: give it the source's group key if one exists.
    # Several sources can share a stem (src/tabs/tabs.tsx and demo/tabs.tsx): pick the closest by path.
    stems = {}
    for f in reviewable:
        if not f["is_test"]:
            stems.setdefault(source_stem(f["path"]), []).append(f["path"])

    def test_key(path):
        candidates = stems.get(source_stem(path))
        if not candidates:
            return group_key(path)
        best = max(candidates, key=lambda c: len(os.path.commonpath([c, path])) if os.path.dirname(c) else 0)
        if not os.path.commonpath([best, path]):
            return group_key(path)
        return group_key(best)

    groups = OrderedDict()
    for f in sorted(reviewable, key=lambda f: f["path"]):
        key = test_key(f["path"]) if f["is_test"] else group_key(f["path"])
        g = groups.setdefault(key, {"key": key, "files": [], "weight": 0})
        g["files"].append(f)
        g["weight"] += f["weight"]

    total_weight = sum(f["weight"] for f in reviewable)
    if not reviewable and since:
        skip(5, f"no new lines under '{a.scope}' since the last reviewed head {since[:10]}")
    if not reviewable:
        skip(3, f"nothing reviewable under '{a.scope}' ({len(out_of_scope)} files out of scope, {len(noise)} noise)")
    slices, over_budget = pack(list(groups.values()), a.target, a.max_slices)

    # Small PRs: one agent does everything. arch_opus only matters when REVIEW_ARCH_MODEL=auto.
    single_agent = total_weight <= 400
    round1_model = None if since else (os.environ.get("REVIEW_ROUND1_MODEL") or None)
    arch_opus = not single_agent and (total_weight > 800 or (len(arch_signals) >= 2 and total_weight > 300))

    try:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
        tracked = subprocess.run(["git", "-C", top, "ls-files"], capture_output=True, text=True).stdout.split()
        spec_candidates = [p for p in tracked if matches(p, SPEC_PATTERNS) and "node_modules" not in p][:200]
    except Exception:
        spec_candidates = []

    plan = {
        "pr": {k: meta[k] for k in ("number", "title", "url", "baseRefName", "headRefName", "headRefOid",
                                     "additions", "deletions", "changedFiles", "isDraft")},
        "author": (meta.get("author") or {}).get("login"),
        "repo": owner_repo,
        "body": body,
        "issue_refs": issue_refs,
        "tracker_refs": tracker_refs,
        "reviewable_weight": round(total_weight),
        "scope": a.scope,
        # Benchmark run (--at): prepare_review.py shows the agents no comments, threads or CI of the PR.
        "blind": bool(a.at),
        # Round k > 1 reviews only lines added since `since`, the last reviewed head (see the module doc).
        "round": len(previous) + 1,
        "since": since,
        "since_note": since_note,
        "previous_heads": previous,
        "unchanged_since": unchanged_since,
        "noise_files": noise,
        "out_of_scope_files": out_of_scope,
        "architecture_signals": arch_signals,
        # Sonnet (5) everywhere by default. REVIEW_ROUND1_MODEL sets both reviewer models of a full round;
        # otherwise REVIEW_ARCH_MODEL pins the architecture model ("auto": opus on big PRs, only when asked).
        "architecture_model": round1_model or (os.environ.get("REVIEW_ARCH_MODEL") or "sonnet").replace("auto", "opus" if arch_opus else "sonnet"),
        "slice_model": round1_model or os.environ.get("REVIEW_SLICE_MODEL") or "sonnet",
        "single_agent": single_agent,
        "over_budget": over_budget,
        "slices": slices,
        "agent_count": 1 if single_agent else 1 + len(slices),
        "spec_candidates": spec_candidates,
    }

    out = json.dumps(plan, indent=2, ensure_ascii=False)
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w") as fh:
            fh.write(out)

    print(f"PR #{meta['number']}: {meta['title']}")
    if since:
        print(f"  round {plan['round']}: only lines added since {since[:10]} "
              f"({len(reviewable)} files with new lines, {len(unchanged_since)} unchanged since)")
    elif since_note:
        print(f"  round {plan['round']}: {since_note}")
    print(f"  +{meta['additions']} -{meta['deletions']} in {meta['changedFiles']} files; "
          f"reviewable weight {round(total_weight)}; noise files {len(noise)}")
    print(f"  slices: {len(slices)}  (target {a.target}, max {a.max_slices})"
          + ("  ** OVER BUDGET — ask the user before proceeding **" if over_budget else ""))
    for s in slices:
        print(f"    slice {s['id']}: weight {s['weight']}, {len(s['files'])} files, areas: {', '.join(s['areas'][:4])}")
    for n_ in noise:
        print(f"    skipped (noise): {n_['path']}  +{n_['additions']} -{n_['deletions']}")
    if out_of_scope:
        print(f"    out of scope (not under '{a.scope}'): {len(out_of_scope)} files")
    print(f"  architecture model: {'n/a (single agent)' if single_agent else plan['architecture_model']}; "
          f"slice model: {plan['slice_model']}")
    for sig in arch_signals[:8]:
        print(f"    signal: {sig}")
    print(f"  review agents: {plan['agent_count']} (+1 verifier if > 5 findings)")
    if issue_refs or tracker_refs:
        print(f"  references in body: {' '.join('#' + i for i in issue_refs)} {' '.join(tracker_refs)}")
    if a.out:
        print(f"  plan written to {a.out}")


if __name__ == "__main__":
    main()
