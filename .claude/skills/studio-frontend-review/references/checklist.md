# Review checklist

Priority order. Spend attention roughly in this order; report in this order.

## 1. Architecture and spec conformance (highest priority)

The question is not "is this code nice" but "does this change do what the specs say, in the way the architecture says things are done here".

- **Specs.** Compare behaviour against the PRD / issue / contract docs in the context pack. Missing requirement, extra behaviour nobody asked for, different semantics (e.g. spec says 404, code returns empty list) — all findings. Quote the spec line.
- **ADRs.** A change that contradicts an accepted ADR is a blocker unless the PR also adds a superseding ADR. A significant new decision (new storage, new communication channel, new cross-cutting pattern, new dependency with architectural weight) without an ADR is a finding — ask for one, don't demand it for small things.
- **Boundaries.** Code in the wrong layer/module, a package reaching into another's internals, a frontend bypassing the agreed contract, business logic in UI components or transport handlers.
- **Contracts.** Changes to public APIs, schemas, events, error codes: are they backward compatible or versioned? Are the contract docs/catalogues (e.g. errors catalogue, events catalogue, API conventions) updated together with the code?
- **Consistency with existing patterns.** A new way of doing something the repo already does one way (fetching, state, errors, config) — point at the existing pattern. File placement and code-level conventions are covered in section 4.
- **Generated artefacts.** If the PR contains tool-generated files (codegen clients, stubs), check the source they come from changed consistently — schema changed but client not regenerated, or a generated file edited by hand.

## Agent-written code

Most PRs here are written by AI agents, not people. Agents are fluent and confident, so their mistakes look plausible. Keep these failure modes in mind through every section below:
- **Reinvention** — a new helper/hook/util/type that already exists in the repo under another name. Search before accepting any new utility.
- **Speculative generality** — options, parameters, abstraction layers, config nobody asked for; "extensible" frameworks for one use.
- **Defensive noise** — try/catch that swallows, fallbacks and default values that hide a broken contract, optional chaining on things that can't be null. These turn bugs into silent wrong behaviour.
- **Invented APIs** — calls to functions, props, endpoints or library methods that don't exist or have a different signature. Check the definition.
- **Near-miss spec** — it implements something close to the requirement, not the requirement. Read the spec line, not the PR description's paraphrase of it.
- **Self-confirming tests** — tests that mock the unit under test, assert what the mocks return, or were adjusted to pass against the code instead of against the spec.
- **Inconsistent parallel edits** — the same change applied in several places, with one of them slightly different or missed.
- **Leftovers** — dead code, unused exports, stale comments describing a previous iteration, narrating comments ("// now we call the API").

## 2. Bugs

Concrete, reproducible defects. State the input or state that triggers them and what goes wrong.
- logic errors, wrong conditions, off-by-one, inverted checks;
- unhandled errors and rejected promises, swallowed errors, error paths that leave state half-updated;
- races and ordering (async effects, stale closures, concurrent requests, missing cancellation);
- null/undefined/empty handling at boundaries;
- resource leaks (listeners, subscriptions, timers, connections);
- security at trust boundaries: authz checks, injection, secrets in code/logs.

Not a bug: a hypothetical that requires the code to be called in a way it never is. Check the callers before reporting.

## 3. Duplication

- New code that re-implements something that already exists in the repo — search (`grep`/`rg`) for similarly named functions, hooks, utilities, constants before reporting, and name the existing one.
- Copy-paste inside the PR (same block in two files/slices).
- Duplicated knowledge: the same constant, mapping or validation rule defined in two places that must stay in sync.

## 4. Repo conventions: file structure and code patterns

Agents write code that is correct in general but foreign to this repo. A codebase stays navigable only if new code looks like the code next to it. The rule: **the repo's existing majority is the standard**, not the reviewer's taste and not general best practice.

**Establish the convention before reporting.** Look at 2–3 sibling files of the same kind (neighbouring components, handlers, modules), then confirm with a count across the repo, e.g.:

```bash
rg -c --type ts '^export const \w+: FC<' src | wc -l     # arrow components with FC type
rg -c --type ts '^export function [A-Z]\w*\(' src | wc -l # function-declaration components
```

Report only when the repo has a clearly dominant pattern (roughly 80%+ of comparable code) and the PR deviates from it. If the repo itself is mixed, it's not a finding — at most mention it in the summary. Never report what a linter/formatter enforces.

**File structure** — do the new files land where files of that kind already live?
- directory placement (feature folder vs shared, `components/` vs `ui/`, where hooks, api clients, types, tests, stories go);
- file naming (kebab-case vs PascalCase, `index.ts` barrels or not, `.test.ts` next to source vs `__tests__/`);
- module shape (one component per file, co-located styles/types, how a feature folder is laid out — compare with an existing feature folder);
- new top-level directories or a new layering scheme are architecture questions — report under section 1.

**Code patterns** — does the code follow the repo's idioms? For example:
- how components are declared: repo uses `const MyComponent: FC<IMyComponentProps> = (props) => { const { visible } = props }`, the PR writes `function MyComponent({ visible }: MyComponentProps) {}`;
- naming of types and interfaces (`IProps` prefix or not, `Props` suffix), exports (named vs default);
- how data is fetched, state is held, errors are surfaced, i18n strings and styles are written, logging is done;
- the same for backend code: handler/service/repository shape, error types, DI style.

**Report once per pattern, not once per occurrence.** One finding: what the convention is (with a reference file that shows it), what the PR does instead, and the list of places. Anchor it on the first occurrence. Severity: usually **minor**; **major** when the deviation is spread across much of the PR or introduces a second competing way of doing something structural (a new folder scheme, a different state approach).

## 5. Code smells

Only ones with a real maintenance cost: functions doing several unrelated things, deep nesting that hides the main path, misleading names, dead code added by the PR, magic values with meaning, leaky abstractions, commented-out code, TODOs without an issue. Skip pure style that a formatter or linter owns.

## 6. Test coverage — test logic, not markup

The team's testing philosophy. Apply it; don't ask for tests it considers pointless.

**Ask for tests when:**
- the PR adds or changes **logic** (domain rules, state transitions, data transforms, parsing, validation, permission checks, custom hooks' behaviour) and it has no unit test;
- the PR adds a **new major user flow** (a new end-to-end scenario a user can go through) and there is no e2e test for it — always say this explicitly;
- a flow's **error handling is critical** and there's no e2e for the intentionally-failing path (e.g. backend error shows the right message and the UI recovers).

**Don't ask for tests of:**
- layout/markup/styling, snapshot or visual baselines — UI changes too often, such tests live a week or two and then get rubber-stamped;
- "component X calls hook Y" — test the hook itself; if that part of the flow is critical, cover it in the e2e scenario;
- trivial glue, re-exports, config.

**Scope of e2e:** the main happy path of the flow, plus optionally one deliberately-breaking path to verify errors are handled. Corner cases belong in unit tests, not e2e. If an e2e test in the PR tries to cover corner cases, suggest moving them to unit level.

**Weak tests** are findings too: tests that assert implementation details, mock the thing under test, or would pass if the logic were deleted.

## Severity

- **blocker** — contradicts a spec/ADR, breaks a contract, a real bug on a main path, a security hole. Should not merge as is.
- **major** — a bug on a secondary path, missing test for new logic or missing e2e for a new flow, meaningful duplication, boundary violation.
- **minor** — smells, local improvements, small inconsistencies.
- **nit** — optional polish. Keep few; they are dropped automatically when the review has 5+ substantive findings.

Documentation findings: a doc that promises behaviour or API the code doesn't have (or hides a real
behaviour change from consumers/agents) is **major**; a wrong number, stale wording or leftover phrase in
an otherwise correct doc is **minor** — minor doc drift is folded into a single comment.

## Writing the comment

- Lead with the problem in one sentence, then why it matters, then a concrete suggestion. Short code snippets are fine.
- Point at evidence: the spec line, the existing function, the caller that breaks.
- Ask a question instead of asserting when you're not sure of intent ("Is the empty list intentional here? The PRD says…").
- No praise padding, no restating the diff.
