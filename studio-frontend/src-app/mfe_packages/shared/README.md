# @constructor-studio/mfe-shared

What more than one MFE of this repository needs, in one place: the host plumbing
(theme, language, the organization in scope), the studio-connector client, the
`studio-tasks` and `studio-events` clients with the run follower built on them,
and the parser for the gears' RFC 7807 refusals.

**This is source, not a built package.** `exports` points at `src/index.ts` and
there is no `dist`: both consumers are bundlers (`moduleResolution: "bundler"`
for `tsc`, vite for the build), so each MFE compiles this code into its own
bundle. That is deliberate — a `dist` here would be one more thing that goes
stale between branches while `dev:all` rebuilds only the MFEs.

**One import is built output.** `tasks/StudioEventsApiService` takes
`SseAuthPlugin` from `@gears-frontx/frontx-template-shell`, which resolves to the
shell's `dist-lib`. After a change to `src/api/sse` or `SseAuthPlugin`, run
`npm run build:package`: `dev:all` does not rebuild it. This lasts until the
transport moves into FrontX.

**It does not touch MFE isolation.** Nothing here is added to any MFE's
`sharedDeps`, so nothing becomes a runtime singleton: every MFE realm keeps its
own compiled copy and its own instances, exactly as it already does with
`@gears-frontx/ui-kit`. What crosses a realm boundary is still only what goes
through `globalThis`: the QueryClient, which the framework hands over, and the
host session, which the shell publishes (`sharedAuthTransport`) under the key
its `dist-lib` exports, `SHARED_AUTH_SESSION_SYMBOL`.

**What belongs here:** code that is *byte-identical* in two or more MFEs. If one
MFE needs to diverge, move that piece back into it. Do not add a flag or an
option to the shared version — that is how this folder turns into a dumping
ground whose every change can break every MFE at once.

**Counts in translations.** FrontX's `t` fills `{param}` and picks no plural
form, so a count goes through `t.count(key, n)` from `createText`: it reads
`key_one`, `key_few` or `key_many` by the plural rule of the language in use,
with `{count}` filled. `_one` carries `{count}`, never a literal `1` — Russian
21 is "one" too. The language's own rule applies only to a language whose
dictionaries are translated, `TRANSLATED_LANGUAGES` in `screenText.ts` (en and
ru); any other reads its dictionary, an English copy today, by the English rule.
Add a language there once its dictionaries are translated, with its `_few`
forms. Without `_few` a dictionary's `_many` is read; English never has one, so a
locale missing `_few` does not fall through to English.

The build scripts skip this directory on purpose: `EXCLUDED_PACKAGES` in
`scripts/lib/mfe-tools.ts` holds the name `shared`, so `build:mfes` and
`dev:all` never mistake it for an MFE. `scripts/run-mfe-type-checks.mjs` does
pick it up, through the `type-check` script above.
