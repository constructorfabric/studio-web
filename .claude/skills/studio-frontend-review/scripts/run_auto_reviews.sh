#!/usr/bin/env bash
# Unattended studio-frontend reviews, posted as the authenticated `gh` user.
#
#   run_auto_reviews.sh            review every open PR that find_prs.py reports
#   run_auto_reviews.sh 371 380    review these PRs (still skipped if nothing is under studio-frontend/)
#   DRY_RUN=1 run_auto_reviews.sh  full review, but publish_review.py only runs with --dry-run
#
# Env: REVIEW_RUNS (workdir root, default ~/.cache/studio-frontend-review), MAX_BUDGET_USD (per PR, default 15),
#      CLAUDE_BIN (default claude), REVIEW_MODEL (orchestrator model, default sonnet). Run it from a checkout that has this skill (a dedicated clone on main is best:
#      the review worktrees are created from it). Cron setup (PATH, logging of git pull failures):
#      references/automation.md, "Option A".
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
runs="${REVIEW_RUNS:-$HOME/.cache/studio-frontend-review}"
claude_bin="${CLAUDE_BIN:-claude}"
case "$runs" in "$HOME/.claude"*) echo "REVIEW_RUNS must not be under ~/.claude: Claude Code blocks writes there" >&2; exit 2;; esac
mkdir -p "$runs"

# One run at a time: a cron tick that lands while the previous review is still going just exits.
exec 9>"$runs/.lock"
flock -n 9 || { echo "$(date -Is) another run is in progress"; exit 0; }

cd "$root"
if [ "$#" -gt 0 ]; then prs=("$@"); else mapfile -t prs < <(python3 "$here/find_prs.py"); fi
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
  echo "$(date -Is) PR #$pr: starting"
  "$claude_bin" -p "/studio-frontend-review $pr --auto. Workdir: $runs/pr-$pr/.$dry" \
    --model "${REVIEW_MODEL:-sonnet}" \
    --add-dir "$runs" \
    --permission-mode acceptEdits \
    --allowedTools "${allowed[@]}" \
    --disallowedTools "${denied[@]}" \
    --max-budget-usd "${MAX_BUDGET_USD:-15}" \
    --output-format text \
    | tail -n 5 || echo "$(date -Is) PR #$pr: claude exited with $?"
done
