# Git hooks

Shared, tracked git hooks that keep the tree formatted so CI never fails on
`cargo fmt --check`.

## Enable (once per clone)

```
git config core.hooksPath .githooks
```

That's it — from now on `git commit` runs `.githooks/pre-commit`, which blocks a
commit when `studio-backend` isn't `rustfmt`-clean.

On Unix, make sure the hook is executable:

```
chmod +x .githooks/pre-commit
```

(Git for Windows runs the hook regardless of the executable bit.)

## What the hook does

- Runs `cargo fmt --manifest-path studio-backend/Cargo.toml --all -- --check`.
- Fails the commit (with the fix command) if anything is unformatted.
- Skips gracefully when `cargo` isn't installed — CI is still the backstop.

Fix formatting with:

```
cargo fmt --manifest-path studio-backend/Cargo.toml --all
```

Emergency bypass (use sparingly): `git commit --no-verify`.

## Frontend (optional, later)

If you want the hook to also gate the prototype's TypeScript formatting, add a
Prettier config to `studio-frontend-prototype` and extend `pre-commit` with a
`prettier --check "src/**/*.{ts,tsx}"` step. Left out for now to avoid false
positives, since the prototype has no Prettier config yet.
