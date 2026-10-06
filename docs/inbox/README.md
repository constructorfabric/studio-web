# Inbox

Material that is not maintained: reports of something done once, and drafts
that have already been sent. It is kept because the reasoning in it is cited or
may be wanted again, not because it describes Studio as it is now. Nothing here
is a specification, and nothing here should be read as current without checking
the code.

When a document here turns out to describe something that is still true and
still needed, it moves out into [`docs/`](../README.md) and gets kept up to date.
When nobody has needed it for a long time, delete it; git keeps it.

## Reports

- [graph-storage-stand-report-2026-09-03.md](graph-storage-stand-report-2026-09-03.md) — the first integration of graph-storage as a dependency, and what the stand found.
- Graph-storage integration no. 3 (2026-09-27/28, weftgraph 0.1.0 from crates.io), in Russian:
  [summary](graph-storage-integration-3/00-summary.md),
  [publish and switch](graph-storage-integration-3/01-publish-and-switch.md),
  [stand and functional checks](graph-storage-integration-3/02-stand-and-functional.md),
  [load](graph-storage-integration-3/03-load.md),
  [consumers and fixes](graph-storage-integration-3/04-consumers-and-fixes.md),
  [first deploy onto an existing environment](graph-storage-integration-3/05-first-deploy.md).

## Sent drafts

Messages, issues and pull requests to the gears team, July–August 2026. Each
was pasted where it was meant to go; what came of it is recorded in
[`../upstream/gears-rust-issues.md`](../upstream/gears-rust-issues.md).

- [gears-feedback.md](gears-feedback.md) — the first round of feedback and proposals.
- [discord-messages.md](discord-messages.md), [discord-reply.md](discord-reply.md), [discord-reply-closed-derivations.md](discord-reply-closed-derivations.md) — the Discord thread.
- [bug-report-metadata-schemas.md](bug-report-metadata-schemas.md) — typed tenant-metadata schemas cannot be registered.
- [pr-openapi-drift.md](pr-openapi-drift.md) — the per-gear OpenAPI path drift fix (cited by ADR-0020).
- [pr-typed-metadata-fix.md](pr-typed-metadata-fix.md) — the typed tenant-metadata envelope fix.
- [pr-closed-derivations.md](pr-closed-derivations.md) — `x-gts-closed-derivations` in gts-spec and gts-rust.
