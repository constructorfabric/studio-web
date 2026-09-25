# Running the review automatically

Goal: every PR that touches `studio-frontend/` gets a review from **@vasylcf**, without anyone starting it.
Both options below run the same thing — `scripts/run_auto_reviews.sh` → `/studio-frontend-review <N> --auto`.
The identity is whatever `gh` is authenticated as; the Claude usage is whoever's Claude credentials run it.

What makes it safe to run unattended:
- `find_prs.py` picks open, non-draft PRs not authored by you whose **current head** is not reviewed yet: no
  review carrying the `<!-- studio-frontend-review sha=<head> ... -->` marker and no local record in
  `$REVIEW_RUNS/state/` (heads reviewed without posting).
- A new push is a follow-up round: only lines added since the last reviewed head are reviewed, threads from
  earlier rounds are re-checked in place (resolved when fixed), and a round with nothing new posts nothing.
  So a 1000+ line PR gets one exhaustive review and then small, converging follow-ups — not a fresh full
  review per push.
- The runner plans before starting Claude: nothing under `studio-frontend/` (exit 3) or no new lines there
  since the last reviewed head (exit 5) is recorded and costs no Claude run.
- Each run starts from an empty workdir, so findings from an earlier head can't leak into the next one.
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

- Cost cap per run: `MAX_BUDGET_USD_ROUND1` for a full round (default 40), `MAX_BUDGET_USD` for a follow-up
  (default 15). Models: round-1 reviewers `REVIEW_ROUND1_MODEL` (default `opus`; `sonnet` makes every round
  Sonnet-only), follow-up reviewers `REVIEW_ARCH_MODEL` / `REVIEW_SLICE_MODEL` (default `sonnet`), orchestrator
  `REVIEW_MODEL` (default `sonnet`); the verifier is always Sonnet.
- The review is additive to CodeRabbit: points already in `existing-comments.md` are not repeated.
- To pause: comment out the cron line / disable the workflow. To force a full re-review of every line, run
  `/studio-frontend-review <N> --full` by hand. Local records: `$REVIEW_RUNS/state/<owner>__<repo>-<N>.json`
  (delete it to forget the quiet rounds; the markers on GitHub still count).
- Option B (Actions) has no persistent `$REVIEW_RUNS`, so quiet rounds aren't remembered there: a head
  with nothing new is planned again on the next event (cheap — exit 5 before Claude starts).
