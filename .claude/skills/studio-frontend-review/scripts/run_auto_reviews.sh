#!/usr/bin/env bash
# Unattended studio-frontend reviews, posted as the authenticated `gh` user.
#
#   run_auto_reviews.sh            review every open PR that find_prs.py reports
#   run_auto_reviews.sh 371 380    review these PRs (still skipped if nothing is under studio-frontend/)
#   DRY_RUN=1 run_auto_reviews.sh  full review, but publish_review.py only runs with --dry-run
#
# Env: REVIEW_RUNS (workdir root, default ~/.cache/studio-frontend-review), MAX_BUDGET_USD (follow-up round,
#      default 15), MAX_BUDGET_USD_ROUND1 (full round, default 40), CLAUDE_BIN (default claude),
#      REVIEW_MODEL (orchestrator model, default sonnet), REVIEW_ROUND1_MODEL (round-1 reviewers, default opus),
#      REVIEW_ARCH_MODEL (architecture agent in follow-ups, default sonnet; "auto": opus on big PRs),
#      REVIEW_REPO (default constructorfabric/studio-web).
# Run it from a checkout that has this skill (a dedicated clone on main is best: the review worktrees are
# created from it). Cron setup (PATH, logging of git pull failures): references/automation.md, "Option A".
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
runs="${REVIEW_RUNS:-$HOME/.cache/studio-frontend-review}"
repo="${REVIEW_REPO:-constructorfabric/studio-web}"
claude_bin="${CLAUDE_BIN:-claude}"
case "$runs" in "$HOME/.claude"*) echo "REVIEW_RUNS must not be under ~/.claude: Claude Code blocks writes there" >&2; exit 2;; esac
mkdir -p "$runs"
export REVIEW_RUNS="$runs"   # review_state.py keeps its record of reviewed heads under $REVIEW_RUNS/state

# One run at a time: a cron tick that lands while the previous review is still going just exits.
exec 9>"$runs/.lock"
flock -n 9 || { echo "$(date -Is) another run is in progress"; exit 0; }

# Models. Round 1 — the only pass that sees all the code — has its architecture and slice reviewers on Opus
# (a blind benchmark on #380 found 3x the behaviour bugs); follow-up rounds, the verifier and the
# orchestrator stay on Sonnet. REVIEW_ROUND1_MODEL=sonnet makes every round Sonnet-only.
export REVIEW_ROUND1_MODEL="${REVIEW_ROUND1_MODEL:-opus}"
export REVIEW_ARCH_MODEL="${REVIEW_ARCH_MODEL:-sonnet}"

cd "$root"
if [ "$#" -gt 0 ]; then prs=("$@"); else mapfile -t prs < <(python3 "$here/find_prs.py" --repo "$repo"); fi
[ "${#prs[@]}" -gt 0 ] || { echo "$(date -Is) nothing to review"; exit 0; }

dry=""
[ "${DRY_RUN:-}" = "1" ] && dry=" DRY RUN: run publish_review.py only with --dry-run and report what would be posted."

# Narrow allowlist: PR code is untrusted input, so no bypassPermissions. Scripts do all GitHub writes.
allowed=(
  Read Grep Glob Write Edit Agent TodoWrite
  "Bash(python3 .claude/skills/studio-frontend-review/scripts/*)"
  "Bash(git -C *)" "Bash(git diff *)" "Bash(git show *)" "Bash(git log *)" "Bash(git status *)"
  "Bash(git worktree remove *)" "Bash(git rev-parse *)"
  "Bash(gh pr view *)" "Bash(gh pr diff *)" "Bash(gh pr checks *)" "Bash(gh issue view *)"
  "Bash(rg *)" "Bash(grep *)" "Bash(ls *)" "Bash(cat *)" "Bash(head *)" "Bash(tail *)" "Bash(wc *)"
  "Bash(sed -n *)" "Bash(jq *)" "Bash(mkdir -p *)"
)
denied=("Bash(gh pr merge *)" "Bash(gh pr review *)" "Bash(gh api *)" "Bash(git push *)" "Bash(git commit *)")

for pr in "${prs[@]}"; do
  wd="$runs/pr-$pr"
  # A fresh workdir every run: findings and verdicts from an earlier head must never mix into this one.
  for wt in tree base-tree; do
    if [ -d "$wd/$wt" ]; then git worktree remove --force "$wd/$wt" 2>/dev/null || true; fi
  done
  rm -rf "$wd"
  git worktree prune
  mkdir -p "$wd"

  # Plan before starting Claude: nothing under studio-frontend/ (3) or nothing new since the last reviewed
  # head (5) is recorded as reviewed and costs no Claude run.
  rc=0
  python3 "$here/plan_review.py" "$pr" --repo "$repo" --out "$wd/plan.json" --record-skips > "$wd/plan.log" 2>&1 || rc=$?
  case "$rc" in
    0) ;;
    3|5) echo "$(date -Is) PR #$pr: skipped — $(grep -m1 'skipping' "$wd/plan.log")"; continue ;;
    *) echo "$(date -Is) PR #$pr: plan failed (exit $rc)"; tail -n 5 "$wd/plan.log"; continue ;;
  esac
  round="$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["round"], ("(lines new since " + p["since"][:10] + ")") if p["since"] else "(full)", "reviewers:", p["slice_model"])' "$wd/plan.json")"
  # A full round costs more (all the code, Opus reviewers) than a follow-up.
  case "$round" in *"(full)"*) budget="${MAX_BUDGET_USD_ROUND1:-40}" ;; *) budget="${MAX_BUDGET_USD:-15}" ;; esac
  # Steps 2 and 2b are deterministic and slow (install, build, coverage): run them here, not inside Claude.
  if ! python3 "$here/prepare_review.py" "$wd" > "$wd/prepare.log" 2>&1; then
    echo "$(date -Is) PR #$pr: prepare failed"; tail -n 5 "$wd/prepare.log"; continue
  fi
  python3 "$here/local_checks.py" "$wd" > "$wd/local-checks.log" 2>&1 \
    || echo "$(date -Is) PR #$pr: local checks failed, reviewing without them ($(tail -n 1 "$wd/local-checks.log"))"
  echo "$(date -Is) PR #$pr: starting round $round, budget \$$budget"
  "$claude_bin" -p "/studio-frontend-review $pr --auto. Workdir: $wd/. Steps 1, 2 and 2b are done: plan.json, prepare_review.py (its output with the agents to launch: $wd/prepare.log) and local-checks.md. Fill the ORCHESTRATOR sections of context.md, then continue with step 3.$dry" \
    --model "${REVIEW_MODEL:-sonnet}" \
    --add-dir "$runs" \
    --permission-mode acceptEdits \
    --allowedTools "${allowed[@]}" \
    --disallowedTools "${denied[@]}" \
    --max-budget-usd "$budget" \
    --output-format text \
    | tail -n 5 || echo "$(date -Is) PR #$pr: claude exited with $?"
done
