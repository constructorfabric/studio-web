# ADR-0006: Rebuild the portal frontend on FrontX

Date: 2026-08-11
Status: accepted
Branch: `frontend-frontx`

## Context

The current portal SPA — moved aside to `studio-frontend-prototype/` on
`main` — is a deliberate walking skeleton grown from two runtime dependencies,
one hand-written API client and a single outsized `App.tsx`. It proved the
backend contract end-to-end but is not the shape the product UI should grow in.

[FrontX](https://github.com/SysoevAndrey/gears-frontx) (part of Gears) is an
ecosystem for AI-driven frontend projects: a `frontx` CLI that assembles a
repository from versioned templates, a runtime that makes the application
extensible by microfrontends (`@gears-frontx/mfes` / `gts-plugin` / `api`), and
an AI-tooling kit. Its `template-shell` seeds the host application (Vite +
React 19 + Module Federation + the type-check/lint/test toolchain);
`template-mfe` contributes the microfrontend workspace
(`src-app/mfe_packages/`).

## Decision

Rebuild the portal on FrontX, incrementally, on the `frontend-frontx` branch.
The target shape is a **shell + one microfrontend** to start.

1. **Consume FrontX through its CLI** (`frontx install` + `frontx add`), not by
   hand-copying template content. Templates declare ownership boundaries
   (`frontx-template.json`) and `frontx add` refuses to write over unaccounted
   content — so `studio-frontend/` starts out empty (the old application lives
   on in `studio-frontend-prototype/`) and **no placeholder files are created
   on template-owned paths** (`package.json`, `tsconfig*`,
   `vite.config.ts`, `index.html`, `src/`, `public/`, `README.md`,
   `.gitignore`, …). The exact template source-spec/ref is pinned when the
   shell is applied.
2. **The deployment wrapper stays**: `Dockerfile`, `Dockerfile.src`,
   `nginx.conf.template`, `docker/10-runtime-env.sh` are not template-owned;
   they are carried over from the prototype's current copies (paths retargeted
   at `studio-frontend/`) and keep serving `dist/` + proxying `/cf` and
   `/studio`; they are adapted once the FrontX build pipeline is in place.
3. **npm, not pnpm.** The FrontX ecosystem is npm-centric — templates ship
   `package-lock.json` and rely on npm workspaces/overrides.
4. **Node ≥ 24.14, npm ≥ 10** (FrontX `engines`); `studio-frontend/.nvmrc`
   pins the major, CI runs Node 24.
5. **TypeScript comes from the template**: `^5.4.2`, resolving to the latest
   5.x (≈5.9). Moving to TS 6/7 is a FrontX ecosystem upgrade, out of scope
   here.
6. **AI tooling via Constructor Studio (`cfs`)**, i.e. the
   `cyber-pilot-kit-frontx` kit registered in `.cf-studio/` — no
   superpowers-style spec/plan artifacts are kept in this repository.

## Consequences

- On this branch, until the shell is applied: the new `frontx` CI job is a
  green no-op (it detects the missing `package.json`). The prototype is
  untouched — its `frontend` CI job and the compose `frontend` service still
  build `studio-frontend-prototype/`, so the README quick start keeps working.
- `release.yml` is untouched — releases are tag-driven from `main`.
- Expected stack once `template-shell`/`template-mfe` are applied: React
  19.2.x, Vite 6 + `@module-federation/vite`, Tailwind 3.4, Redux Toolkit +
  React Query, vitest; microfrontends live in `src-app/mfe_packages/`.
