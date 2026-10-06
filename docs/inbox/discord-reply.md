# Discord follow-up #2 (proposing where + what) — ready to paste

Quick follow-up on the metadata bug and the docs fix:

**1. Docs PR is ready.** Rather than deleting the per-gear OpenAPI artifacts (they're
wired into DESIGN.md and Cypilot validation), we fixed them in place: stripped the
phantom `/api` prefix from all account-management (16) and resource-group paths,
verified every path against `docs/api/api.json`, renamed `{schema_id}` → `{code}` to
match the real route, and added a header note pointing to api.json as the source of
truth. One residual left for the owner: RG declares `/groups/{group_id}/hierarchy`
but the implementation exposes `/ancestors` + `/descendants` — that's a content
decision, flagged in the PR body. PR: <link after push>

**2. The typed tenant-metadata bug — filing it on GitHub Issues**, per CONTRIBUTING
("Getting Help → GitHub Issues: for bug reports and feature requests"). A public
issue also keeps it discoverable for the next adopter (the member-handle "known
limitation" wasn't findable anywhere public and cost us a debugging cycle) and gives
our failing test + fix PR something to reference.

We have the report fully written: env (main @ 71218154), one-line config repro, both
failure paths (draft-07 → OP#12 narrowing vs the closed base envelope; `gts://` chain
`$schema` → "Unknown meta-schema"), expected/actual, and a **recommended fix**: relax
the base envelope (`additionalProperties: true` at the payload level of
`gts.cf.core.am.tenant_metadata.v1~`, traits schema stays strict) — one data-only
line in a schema AM owns, no OP#12 changes, payload validation still enforced by the
derived schema at PUT time. We're offering the fix PR + failing-first test alongside.

Say the word and we file it (or send it wherever you point us).
