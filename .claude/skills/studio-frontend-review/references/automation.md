# Running the review automatically

Goal: every PR that touches `studio-frontend/` gets a review from **@vasylcf**, without anyone starting it.
Both options below run the same thing — `scripts/run_auto_reviews.sh` → `/studio-frontend-review <N> --auto`.
The identity is whatever `gh` is authenticated as; the Claude usage is whoever's Claude credentials run it.

What makes it safe to run unattended:
- `find_prs.py` picks open, non-draft PRs not authored by you whose **current head** has no review carrying
  the `<!-- studio-frontend-review sha=<head> -->` marker. A new push → new head → one new review. No state files.
- `plan_review.py` exits 3 when nothing reviewable is under `studio-frontend/` → nothing is posted.
- `publish_review.py --head-sha` refuses to post if the PR moved during the review.
- Event is always `COMMENT` (never approve / request changes), with a visible "automated review" note.
- Headless Claude runs with a narrow tool allowlist, no `gh api` / `git push` / `gh pr merge`; the
  GitHub write happens only inside `publish_review.py`.

## Option A — on your machine (recommended to start)

No org changes, no admin rights, no tokens stored anywhere new: it uses your existing `gh` login and your
Claude Code login. Downside: reviews only happen while the machine (WSL) is on.

```bash
# a dedicated clone on main, so your working checkout is never touched
git clone git@github.com:constructorfabric/studio-web.git ~/projects/fabric/studio-web-review
cd ~/projects/fabric/studio-web-review

# check what it would do
python3 .claude/skills/studio-frontend-review/scripts/find_prs.py --json
DRY_RUN=1 .claude/skills/studio-frontend-review/scripts/run_auto_reviews.sh <N>

# crontab -e   (WSL: cron must be running — `sudo service cron start`, or enable systemd in /etc/wsl.conf)
PATH=/home/<you>/.local/bin:/usr/local/bin:/usr/bin:/bin
*/15 8-20 * * 1-5  { cd $HOME/projects/fabric/studio-web-review && git pull -q --ff-only || { echo "$(date -Is) git pull failed, skipping this run"; exit 1; }; .claude/skills/studio-frontend-review/scripts/run_auto_reviews.sh; } >> $HOME/.cache/studio-frontend-review/cron.log 2>&1
```

`PATH` is needed because cron's default one has neither `claude` nor `~/.local/bin`. The whole line, including
`git pull`, logs to `cron.log`, so a deleted branch or a diverged clone shows up there instead of silently
stopping reviews.

## Option B — GitHub Actions (reviews within minutes of a push, machine-independent)

Needs a repo admin, once: an environment `frontend-review` limited to the `main` branch, with two secrets:
- `REVIEW_GH_TOKEN` — a fine-grained PAT of **vasylcf**: repository `constructorfabric/studio-web` only,
  *Pull requests: Read and write*, *Contents: Read*, *Metadata: Read*. Reviews then appear as vasylcf.
- `ANTHROPIC_API_KEY` (an org/project API key — the clean option for CI), or `CLAUDE_CODE_OAUTH_TOKEN`
  from `claude setup-token` if usage should come from your own Claude subscription.

Trade-offs to agree on with the team first: anyone with admin on the repo can use a token that acts as you;
the workflow file lands on `main` and is visible to everyone; `pull_request_target` runs the workflow from
`main` (PR authors can't change it), and the job only *reads* PR code, never builds or runs it.

```yaml
# .github/workflows/frontend-review.yml
name: Frontend review
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
    paths: ["studio-frontend/**"]
concurrency:
  group: frontend-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  review:
    if: ${{ !github.event.pull_request.draft && github.event.pull_request.user.login != 'vasylcf' }}
    runs-on: ubuntu-latest
    environment: frontend-review
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4          # main: the skill and scripts come from the base branch
        with: { fetch-depth: 0 }
      - run: npm install -g @anthropic-ai/claude-code
      - name: Review
        env:
          GH_TOKEN: ${{ secrets.REVIEW_GH_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          REVIEW_RUNS: ${{ runner.temp }}/reviews
        run: .claude/skills/studio-frontend-review/scripts/run_auto_reviews.sh ${{ github.event.pull_request.number }}
```

## Tuning

- Cost cap per PR: `MAX_BUDGET_USD` (default 15). Orchestrator model: `REVIEW_MODEL` (default `sonnet`);
  subagents follow the budget rules in `SKILL.md`.
- The review is additive to CodeRabbit: points already in `existing-comments.md` are not repeated.
- To pause: comment out the cron line / disable the workflow. To force a re-review of the same head:
  edit that review on GitHub and remove its marker line (submitted reviews can't be deleted), or run
  `run_auto_reviews.sh <N>` by hand.
