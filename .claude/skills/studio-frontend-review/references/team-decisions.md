# Team decisions

What the frontend team has already ruled on. Each entry is a finding authors declined with a reason that holds
beyond one PR, or a project decision a reviewer would otherwise argue with. Never raise what an entry rules out,
and never argue with it in a thread. An entry stops applying only when the ADR or document it names changes.

New entries come from `$REVIEW_RUNS/state/decision-candidates.md`, which the runner fills with every thread we
withdrew; a person moves the ones that generalise here. Keep each entry to: the rule, why, where it was decided.

## Traceability

- **Specs track — no `cfs` markers, DoDs or FEATURE updates.** For the project Specs list (`projects-mfe`
  specs rows, Spec Quality check, `docs/feature/project-specs.md`) the issue body is the spec. Don't ask for
  `@cpt-*` markers, DoDs or `project-specs.md` changes there. Declined in #711 and #806; #690 shipped without.

## Tests

- **Routing is tested with unit tests, not e2e.** ADR-0028 tests navigation on an in-memory history; the e2e
  suite holds only the sign-in smoke. Missing e2e for a navigation flow is not a finding (checklist §6). #459.
- **No test files in `__test-utils__`.** `vitest.shared.ts` excludes that directory, so a test placed there never
  runs. A test of a test helper lives next to its callers. #380.
- **Code moved unchanged is not this PR's coverage gap.** If a function or class moves without change from
  `main` or another file, missing tests or old conventions in it are pre-existing — raise them only as a
  behaviour bug. #645, #697.

## Structure and conventions

- **UI-kit workarounds stay local.** ADR-0034 records CSS workarounds for the kit (the `Empty` centring, dialog
  surfaces under `[data-theme]`) copied into each MFE on purpose; the fix belongs in the kit. Not duplication.
  #622.
- **`@constructor-studio/mfe-shared` ships as source, with no `dist`.** Its README records the trade-off. #645.
- **API types live in their service file.** `StudioRun`, `StudioSession` and the like are declared inline in
  the `*ApiService.ts` that returns them; there is no separate DTO module convention. #709.
- **No design token, no finding.** A fixed size (bar heights and similar) where the kit defines no token is
  accepted. #697.

## Scope

- **Staged work.** An unused export, an unchecked DoD or a missing caller that the PR body says a named
  follow-up PR completes is not a finding in this PR. #645 (#643).
