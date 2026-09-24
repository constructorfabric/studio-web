# Studio frontend rules

Project-specific rules for `studio-frontend/` (the shell, MFEs under `src-app/mfe_packages/`, packages under
`packages/`, `mfe-shared`). Written by the frontend team. They extend `checklist.md`; where the two disagree,
**these win** — they describe how this project is actually built.

**Correctness first, then project patterns, traceability, hygiene and maintainability.**

Apply only the sections the change actually touches. A config-only change skips accessibility and UI patterns;
a pure UI change skips API contracts unless it calls an endpoint.

## 0. What the review may and may not change

* Tracked files are read-only: no edits to source, generated files under git, formatting, dependencies, lockfiles or snapshots.
* Rebuilding untracked build output is allowed when verification needs it: `dist`, `packages/*/dist`, generated `mfe.json` in `dist`. Check with `git status --short` afterwards that nothing tracked changed.
* Use check-only commands: `cfs validate`, `cfs validate-toc <files>`. Do **not** run `cfs toc` — it rewrites the Markdown files.

---

## 2. Correctness

This is the core of the line pass: go through every changed line with these questions before looking at patterns.

Check:

* logic errors;
* incorrect conditions;
* missing error, empty and loading states;
* incorrect state transitions;
* races and stale state;
* lifecycle problems;
* API/request failures;
* incorrect assumptions about response shapes;
* regressions in existing flows;
* broken edge cases and boundary conditions.

### Studio invariants

* MFE module realms are isolated — the host auth token does **not** reach MFE requests; each MFE must set up its own auth.
* `descriptor.fetch()` is cached for 30 s by default — a mutation followed by a re-fetch will show stale data unless the cache is bypassed/invalidated.
* i18n: a missing locale file renders the raw key. Every new key must exist in every locale file, including duplicated English ones.
* `mfe.json` is generated from `dist` — changing the source manifest alone does nothing until the rebuild (see section 8).
* MFE `domainActions` is not a permission list and must not be treated as access control (see section 5).

Verify these invariants against the current implementation when the review depends on them.

---

## 3. Regression surface and compatibility

For every changed behavior, identify what can be affected outside the changed lines.

Check:

* direct callers and consumers;
* shared hooks/components/models;
* all usages when changing shared APIs;
* producers and consumers when changing API contracts;
* existing branches of conditional logic;
* old behavior that must remain unchanged;
* optional/default behavior of changed shared APIs;
* independently built/deployed MFEs that may temporarily use a different version of a shared package;
* generated artifacts that may lag behind source changes.

Pay particular attention to changes from "always" to conditional behavior. Do not assume all consumers update atomically.

A finding about a regression must identify the concrete affected flow.

---

## 4. Async, lifecycle and data contracts

### Async and lifecycle

For asynchronous or stateful code, explicitly check for:

* requests completing after unmount;
* stale closures;
* incomplete effect dependencies;
* duplicate requests caused by remounts;
* race conditions between consecutive requests;
* mutation followed by stale cached data;
* loading or error state getting stuck;
* state updates based on obsolete requests;
* cancellation/cleanup where the existing project pattern requires it.

Do not report theoretical race conditions without a credible execution path.

### Data and API contracts

Do not infer runtime API behavior from TypeScript types alone.

When an endpoint or data contract changes:

* inspect the actual endpoint/schema when available;
* inspect all existing callers;
* check success and error responses;
* check nullable/optional fields;
* check backwards compatibility;
* check loading and empty responses;
* verify serialization/deserialization assumptions.

---

## 5. Security boundaries

Check that:

* UI visibility is not treated as authorization — a hidden or disabled control is not evidence of authorization;
* `domainActions` is not used as access control;
* authorization happens at the actual API/domain boundary;
* tokens and credentials are not exposed through props, URLs, localStorage, logs or generated artifacts;
* privileged data does not cross MFE boundaries unintentionally;
* errors and logs do not leak secrets or sensitive user data.

---

## 6. Project patterns

The first question for every UI change:

**Is it done the way the rest of the project does it?**

Prefer repository evidence over generic frontend best practices.

For every pattern finding, inspect at least one existing nearby implementation of the same concept and use it as the reference.

### Design system

* Values are themed tokens: theme → `tailwind.config.ts` → utility classes.
* No hardcoded colors, sizes, spacings or pixel values copied from a mockup.
* Text sizes come from named type-ramp roles, not raw px.
* Prefer ui-kit components.
* The shell's own UI system is legacy; do not extend it.

### MFE structure

* No `services/`.
* Hooks belong in `shared/`.
* Pure logic belongs in `model/`.
* Code used by more than one MFE belongs in the `mfe-shared` package.
* MFE slots mount via `ExtensionDomainSlot`.
* The slice-driven scaffold `Popup`/`Overlay`/`Footer` render nothing — flag any new use.
* No permanent router in the shell — routing is coming from FrontX upstream.

### Icons

* No runtime Iconify fetches — they break offline behavior and drop `className`.

---

## 7. Accessibility

For UI changes check:

* keyboard interaction;
* focus management;
* semantic HTML;
* accessible names for icon-only controls;
* correct disabled vs `aria-disabled` semantics;
* dialog/popover focus behavior;
* loading/error announcements where appropriate;
* contrast using project theme tokens;
* reduced-motion behavior for new animations.

Do not consider accessibility verified from visual inspection alone.

---

## 8. Generated artifacts

When source/config changes generate artifacts:

* identify the generator;
* determine whether generated output is committed;
* rebuild untracked output when required (see "What the review may and may not change");
* inspect the resulting artifact;
* do not review only the source declaration when runtime consumes generated output.

---

## 9. Traceability

For changes that introduce or materially change a user-facing feature:

* a `cfs` FEATURE artifact is required at `studio-frontend/docs/sdlc/FEATURE/<name>.md`;
* the artifact should follow the shape of `project-create.md`;
* code carries `@cpt-dod` / `@cpt-algo` markers;
* checked algorithms wrap every `inst-N` in `@cpt-begin` / `@cpt-end`;
* a new MFE `src` is added to `codebase` in `.cf-studio/config/artifacts.toml`, otherwise its markers are never checked;
* `cfs validate` and `cfs validate-toc <changed .md files>` must pass.

Do not require a FEATURE artifact for unrelated bug fixes, refactors or maintenance unless the project convention explicitly requires one.

---

## 10. Tests

Existing tests must keep passing.

Missing new tests are a note, not a blocker, unless the team explicitly requires them.

When tests exist, check that they:

* exercise the changed behavior rather than only implementation details;
* cover important negative/error paths;
* cover relevant boundary conditions;
* do not rely on snapshots as the only evidence for behavioral changes;
* follow existing project testing patterns.

Run the narrowest relevant test suite first, then broader checks when needed.

---

## 11. Performance

Flag performance issues only when there is a credible impact.

Check for:

* unnecessary network requests;
* repeated descriptor/API fetches;
* expensive work on every render;
* large dependencies introduced into shared/runtime paths;
* unnecessary rerenders of shared components;
* eagerly loaded large assets.

Do not report speculative micro-optimizations.

---

## 12. Observability and failures

For new asynchronous or externally dependent behavior:

* errors must not be silently swallowed;
* meaningful error information must be preserved;
* user-facing failure states must be handled where appropriate;
* existing telemetry/logging conventions should be followed.

---

## 13. Hygiene

Check for:

* unrelated changes;
* accidental formatting-only churn;
* unrelated lockfile changes;
* unrelated certificate/config changes;
* generated files changed unintentionally;
* environment/tool-version churn;
* unnecessary refactors mixed into the feature;
* long explanatory comments or headers.

Comments should be short. Technical debt should be a one-line `TODO:`.

---

## 14. Verification

Verify findings rather than asserting them.

Use the most appropriate evidence:

* code-path inspection;
* comparison with an existing project pattern;
* tests;
* build output;
* generated artifact inspection;
* endpoint/API verification;
* `cfs validate` / `cfs validate-toc`;
* runtime verification with `dev:all` when behavior requires it.

For Studio runtime verification:

* MFE menu items do nothing without the `:30xx` preview servers;
* rebuild `packages/*/dist` after a branch switch when generated package output is relevant.

Every finding must have concrete evidence.

If a suspected problem could not be verified, do **not** present it as a confirmed finding. Put it in a separate `Plausible` note and explain what could not be verified.

---

## 15. Review discipline

Do not report:

* purely stylistic preferences without a project convention;
* hypothetical problems without a credible failure path;
* unrelated refactors;
* generic "best practice" violations that contradict no project pattern;
* performance concerns without plausible impact;
* missing abstractions that are not needed by the current behavior.

### Known pre-existing issues — do not report

* `npm run lint` fails because `typescript-eslint` is not installed. Do not treat the lint failure as a finding of the reviewed change.
* IDE-only TS1259 in `tailwind.config.ts` — no tsconfig covers that file; the build is unaffected.

Prefer a small number of well-supported findings over a large number of speculative ones.

---

## 16. Severity

These map onto the generic checklist's levels; use them to calibrate Studio-specific findings (`nit` stays available for optional polish):

* **blocker** — deterministic production failure, data loss, security/access-control failure, or broken core flow;
* **major** — user-visible functional regression or incorrect behavior in a supported flow;
* **minor** — localized defect or maintainability/pattern issue with limited impact.

Severity must be tied to a concrete failure scenario, not personal preference.

---

## Verdict

The review summary ends with exactly one verdict:

* `ready`
* `ready after fixes`
* `needs rework`

### Review principle

**Do not ask "does this code look reasonable?" Ask "what concrete behavior changed, what can it break, how does Studio normally implement this, and what evidence proves the finding?"**
