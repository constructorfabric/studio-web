# ADR-0007: Shell theme tokens hold whole colours

Date: 2026-08-18
Status: accepted
Branch: `frontend-adjust-shell-to-mocup`

## Context

The shell and the microfrontends run two different UI systems, and this is on
purpose while the shared kit is incomplete: the shell composes app-owned
shadcn-style primitives in `src-app/app/components/ui/` with Tailwind, while the
five MFE screens use `@gears-frontx/ui-kit` inside their shadow roots.

The new navigation mockups need two components the shell does not have — a
dropdown menu for the top bar's context switcher and a separator for the
drawer's rules. Both already exist in ui-kit. Importing one turned out to render
a component that works but is not painted: it opens, positions and takes the
keyboard, yet has no surface, border or shadow.

The cause is not CSS leakage — a kit component imports only its own CSS chunk
with class names hashed by CSS modules, and pulls in no palette. The cause is
that the shell and the kit disagree on the **shape of a token's value** under the
same name:

```css
/* shell theme (themes/*.ts, injected as :root by themeRegistry.apply) */
--popover: 0 0% 100%;          /* three numbers, not a colour */
background-color: hsl(var(--popover));   /* the shell always wraps */

/* ui-kit component CSS */
background-color: var(--popover);        /* expects a colour already */
```

Substituting a bare triplet where a colour is expected produces an invalid
declaration, which CSS drops. The triplet form was a deliberate choice for the
older shadcn convention and was codified in `themes/utils.ts:hslToVar`, a helper
whose whole job was to strip the `hsl()` wrapper.

Measured before deciding: the shell's `default`, `light` and `dark` palettes are
**value-identical** to ui-kit's — 19 of 19 tokens in light, 14 of 14 in dark —
because they were hand-copied from it, with a comment saying so in each of the
five theme files. Two families are genuinely different and must not be handed
over: `--radius-*` (the shell's `.125/.25/.5/1rem` against the kit's
`calc(var(--radius) ± Npx)`, i.e. `.375/.5/.75/1rem` — the mockup's 8px drawer
rows depend on the shell's scale) and `--font-sans` (the kit names `'Inter'`,
while the only registered family is `'Inter Variable'`; see
`globals.css`).

## Decision

Keep the shell as the source of its own palette, and change the **notation** so
that both Tailwind and ui-kit components can read the same tokens.

1. **Theme token values become whole colours.** Every colour in the five
   `themes/*.ts` is wrapped: `'0 0% 100%'` → `'hsl(0 0% 100%)'`. Wrapping rather
   than converting to hex keeps the change provably value-preserving and the
   diff reviewable. `hslToVar` and `themes/utils.ts` are deleted; the two
   Dracula themes now use their `hsl(...)` palette entries directly.
2. **Tailwind reads them unwrapped**: `hsl(var(--border))` → `var(--border)`,
   42 entries in `tailwind.config.ts`.
3. **Opacity modifiers go through `color-mix`.** A whole colour has no channel
   slot for `<alpha-value>`, so the six `mainMenu` colours — the only family that
   honours `/NN`, for `bg-mainMenu-hover/65` — resolve as
   `color-mix(in oklab, var(--left-menu-hover) calc(<alpha-value> * 100%), transparent)`.
   Tailwind substitutes the literal, so an unmodified utility stays opaque.
4. **`ui-kit/theme.css` is NOT imported.** The kit-only names the shell lacks
   (`--space-*`, `--text-meta-*`, `--border-width`, `--icon-size-sm`,
   `--popover-border`, `--popover-shadow`) are declared in `globals.css` with the
   kit's own values instead. Importing the file would bring two rules the shell
   cannot afford: its unlayered `body, [data-theme]` paint rule, and
   `:root:not([data-theme='light'])` inside `@media (prefers-color-scheme: dark)`,
   which outranks on specificity the plain `:root` that `themeRegistry.apply()`
   writes — an OS in dark mode would repaint the whole shell in the kit's dark
   palette regardless of the chosen theme.
5. **`@gears-frontx/ui-kit` becomes a declared dependency of the shell.** It
   previously resolved only through workspace hoisting from the MFE packages.

Acceptance criterion for the change: the shell looks **identical** before and
after, on all five themes. It is a notation refactor, not a repaint.

### One more place had to move with it: `@gears-frontx/studio`

The criterion above was initially violated, and the way it failed is worth
recording because it is invisible to every static check.

`StudioOverlay` — the dev panel, rendered unconditionally from `App.tsx` —
injects a `#frontx-studio-styles` stylesheet of "self-contained utility styles"
into the host document at runtime. Those utilities are named exactly like the
app's (`text-muted-foreground`, `bg-popover`, …) and were written in the old
convention, `color: hsl(var(--muted-foreground))`. Against a token that now holds
a whole colour that resolves to a doubly-wrapped `hsl()` — invalid, so the
declaration is dropped and the element inherits its parent's colour.

The file's own comment states the discipline that keeps it from colliding:
":where() ensures host-app Tailwind utilities take precedence when available."
Four rules had lost the wrapper (`text-foreground`, `text-muted-foreground`,
`text-muted-foreground/70`, `hover:text-muted-foreground`), so they carried real
class specificity, sat later in `<head>` than `globals.css`, and beat the app's
own utilities. The visible result was muted icons and chevrons rendering almost
black — which reads as "our colour tokens are broken", and sends you auditing the
palette instead of looking for a second stylesheet.

So `packages/studio` moved to the new notation too: the four leaking rules are
back inside `:where()`, the 34 `hsl(var(--x))` values are whole colours, and the
alpha ones use `color-mix`. Note this is an edit to a gears package vendored under
`packages/` — it belongs upstream as well, both halves of it: the notation, and
the missing `:where()` (that half is a defect independent of this migration).

Two lessons for the next token change: a static grep over the app is not enough
when a dependency injects global utilities at runtime, and the check that would
have caught it is reading a computed colour in a real browser, which is what
finally did.

## Consequences

- Any ui-kit component can now be used in shell chrome without glue. This commit
  uses `DropdownMenu` (context switcher, user menu) and `Separator` (top bar and
  drawer rules).
- The kit-token block in `globals.css` has to grow when a newly adopted kit
  component reads a name that is not there yet. The failure is visible
  immediately — the component renders unpainted — and the fix is one line.
- `src-app/vitest.config.ts` now inlines `@gears-frontx/ui-kit` in
  `server.deps.inline`, for the same reason `vitest.mfe.base.ts` already did:
  the kit's ESM imports per-component CSS chunks, and an externalized dep is
  loaded by Node, which cannot import `.css`.
- The palette is still duplicated across five theme files, each still a hand
  copy of the kit's. That is untouched here and remains the next step: with the
  notation now shared, those files can start deriving from `ui-kit/theme.css`
  rather than restating it. That step needs a decision about how a theme selects
  the kit's light/dark scope, since `themeRegistry.apply()` writes `:root`
  variables and never sets `data-theme`.
- Unrelated but found while measuring: `npm run lint` fails in this repository
  independently of this change — `eslint.config.js` imports `typescript-eslint`,
  which no `package.json` declares (true in `HEAD` as well).
