# studio-spec-quality

A thin, authenticated wrapper over the external spec-quality service — the
detector API that judges whether a specification is any good.

The design — why the service's key stays here, why the submit is a passthrough
and the wait is a run, how a verdict is read and recorded, and the REST
surface — is
[`docs/design/studio-spec-quality.md`](../../../docs/design/studio-spec-quality.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-spec-quality`, capabilities `[rest]`, no gear deps.
- Config section `gears.studio-spec-quality`: `base_url` (or the variable
  named by `base_url_env`, default `STUDIO_SPEC_QUALITY_BASE_URL`, which wins)
  and the key (a literal `api_key`, which wins, or the variable named by
  `api_key_env`, default `STUDIO_SPEC_QUALITY_API_KEY`). Prefer the variable:
  the key does not belong in a config file. Without both, the gear still
  loads and every analysis call answers a 500 saying what to set.
- Task types `spec_quality.analyze` and `spec_quality.analyze_batch` run on
  [`../tasks`](../tasks) and announce every transition on
  [`../studio_events`](../studio_events); follow them as
  `subject_type: task_run`.
- What a verdict means is [`../documents`](../documents)' and its callers'
  business, by design; this gear only reads it.
- The upstream's result shapes are undocumented. `verdict.rs`, `findings.rs`
  and `analysis.rs` read every key defensively, and their tests pin the
  shapes taken from real answers — extend those when the service changes.
