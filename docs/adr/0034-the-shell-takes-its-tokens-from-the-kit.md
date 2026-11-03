---
type: adr
status: proposed
date: 2026-10-05
---

# ADR-0034: The shell takes its tokens from the kit

**ID**: `cpt-studio-adr-the-shell-takes-its-tokens-from-the-kit`

Status: proposed · 2026-10-05 · Amends ADR-0007 (§3, §4 and the radius exception) and ADR-0008 (the avatar's colour-by-name) · Relates to ADR-0006 · PR [#622](https://github.com/constructorfabric/studio-web/pull/622)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Outcome](#decision-outcome)
  - [The shell reads its token values from `ui-kit/theme.css`](#the-shell-reads-its-token-values-from-ui-kitthemecss)
  - [The theme's appearance selects the kit palette](#the-themes-appearance-selects-the-kit-palette)
  - [The vendored framework gets the published lines](#the-vendored-framework-gets-the-published-lines)
  - [What the shell still owns](#what-the-shell-still-owns)
  - [The MFEs do not change](#the-mfes-do-not-change)
  - [Considered and rejected](#considered-and-rejected)
  - [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

`@gears-frontx/ui-kit 0.4.0-alpha.6` repaints the product: primary moves
from violet `#8257e6` to blue `#0065e3`, the accent becomes solid primary,
and the radius and type scales are rebuilt — 115 values in `theme.css`. The
deployed prototype on `studio.constructor.rocks` already wears them. The
MFEs take them for free: each carries `theme.css?inline` into its shadow
root.

The shell does not. The template's themes carry a palette of their own
(shadcn-style, `colors.blue[600]` primary); in #9 (`e9ade26`, 2026-08-15) a
commit after the seed, "shell chrome in the ui-kit Studio palette",
replaced it with the kit's values converted to HSL triplets, and kept the
kit's CSS out of the document because whole colours would have broken the
shell's `hsl(var(--x))` utilities. #11 turned the copy into whole colours
(ADR-0007) and added a snapshot of the default theme to `globals.css`
(54 declarations) and a bridge of kit-only names (32 more). ADR-0007 refused
to import `theme.css` because its
`@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }`
rule would repaint the shell on a dark OS whatever theme was chosen: the
shell set no `data-theme` at all. So every kit release re-opens the same job
in three places.

The FrontX template has solved this since. `template-shell` imports
`theme.css` once at its entry, and `@gears-frontx/framework 0.2.0-alpha.4`
(npm, 2026-09-03) gives `ThemeConfig` an `appearance: 'light' | 'dark'`;
`themeRegistry.apply()` stamps it as `data-theme` on `<html>` and writes the
theme's variables as `:root:root { … }`. This repository's
`packages/framework` is the template's `0.2.0-alpha.0` from the seed and has
none of it.

Whether the shell should take `framework` and its siblings from npm instead
of the vendored `packages/` is a wider question, open with the team on
2026-10-05; it is not decided here.

## Decision Outcome

### The shell reads its token values from `ui-kit/theme.css`

`globals.css` imports `@gears-frontx/ui-kit/theme.css`. The default-theme
snapshot and the kit-only bridge are deleted with it; both existed only
because the import was refused. The five themes lose the 39 names they
copied from the kit and the 23 names the FrontX template left behind and
nothing reads (`--left-menu-*`, `--spacing-*`, `--error`, `--shadow-*`,
`--transition-*`, `--radius-none`); their Tailwind bindings (`error`,
`mainMenu`, `spacing`) go with them, and the one use, `ml-xl` in
`Header.tsx`, becomes `ml-8` — 2rem, the value of the kit's `--space-8`. The
radius exception ADR-0007 made for the mockup's 8px drawer rows is
withdrawn: the shell takes the kit's scale, as the MFEs do.

This amends ADR-0007 §4. Its reasoning was right for the mechanism it had;
the next section is what changed.

### The theme's appearance selects the kit palette

Every theme declares `appearance`: `default` and `light` are `'light'`;
`dark`, `dracula` and `dracula-large` are `'dark'` — the mapping
`useHostChrome` already applies in the MFEs. `apply()` writes it as
`data-theme` on `<html>`, so the kit's `[data-theme='light']` or
`[data-theme='dark']` block paints. The OS-driven fallback then never
decides anything: with the attribute at `light` it is excluded by its own
`:not()`; with the attribute at `dark` it carries the same values as the
explicit dark block. `index.html` carries a static `data-theme="light"` so
that the first paint, before any script, is the light the shell starts in.

A theme's own variables are written as `:root:root` (0,2,0), above the
kit's `[data-theme='dark']` (0,1,0). Against the fallback rule, which has
the same specificity, a theme still wins on order: the theme's `<style>` is
appended to `<head>` at runtime, after the stylesheet that carries
`theme.css`. The kit's `body, [data-theme]` paint rule is accepted: it sets
background, colour and `font-family` from the same tokens the shell sets
them from.

### The vendored framework gets the published lines

`appearance` (in `packages/framework/src/types.ts`) and the `data-theme`
stamp and `:root:root` rule (in
`packages/framework/src/registries/themeRegistry.ts`) are copied from the
published `0.2.0-alpha.4`, with its names, defaults and doc comment. It is a
stop-gap until the npm question above is decided: if the shell moves to the
published packages, these lines leave with `packages/`; if it does not, they
are what the next sync from the template would bring anyway.

### What the shell still owns

- **`--font-sans`.** The kit says `'Inter'`; the only registered family is
  `'Inter Variable'` (see the `@fontsource` comment in `globals.css`). Every
  theme carries the token, as before, and `themes.test.ts` holds it there.
  Miss it and the text falls back to `system-ui` with nothing in the
  console.
- **Dracula's colours**, as overrides on top of the kit's dark block — and
  Dracula Large's type ramp and radii, which it scales by one and a half on
  purpose.
- **The rail's `--sidebar*` overrides** in `Rail.module.css`: not new names,
  a local re-colouring of the kit's `Sidebar` onto the card surface. Gone with
  the rail since `shell-levels` replaced it with tabs (2026-10-08).

### The MFEs do not change

They keep carrying `theme.css?inline`, re-anchored on `:host` by
`anchorKitThemeOnShadowHost`, and keep mapping the host's theme id to
`data-theme="light" | "dark"` on the screen root. That is the template's own
pattern (`template-mfe/_blank-mfe/src/lifecycle.tsx`), and the template
gives the reason: an MFE "cannot assume which shell build hosts it". With
the shell on the kit's palette, `default`, `light` and `dark` now look the
same on both sides; under the two Dracula themes the MFE screens show the
kit's dark palette. That is the pattern, not a defect of this change.

The kit's alpha.6 changes reach the MFE screens in two places that need a
local answer: `Empty` is capped at `32rem` with no auto margins, so the six
call sites centre it themselves (`.empty { margin-inline: auto }`); and the
kit's `body, [data-theme]` rule now paints the three overlay roots with
`--background`, so they restate `--card` one selector deeper
(`.dialog[data-theme]`, `.wizard[data-theme]`, `.form[data-theme]`).

### Considered and rejected

- **Keep the hand copies and update the 115 values.** The job then returns
  with every kit release, in three places. Rejected.
- **Keep the shell violet** and override the kit inside the MFEs. Rejected
  on 2026-10-05: the design and the deployed prototype are blue; the shell
  follows the kit.
- **Import `theme.css` without `data-theme`.** A dark OS would repaint the
  shell in the kit's dark palette under every theme — the reason ADR-0007
  gave. Rejected.
- **Take `framework` from npm in the same change.** It carries the lines
  this record needs, but the move touches the MFE auth handoff, the
  shadow-root styles and the overlay attach/detach race, and needs the
  team's agreement. Kept out; a record of its own if it goes ahead.

### Consequences

- The shell is blue, with the kit's radii and type ramp, on `default`,
  `light` and `dark`; the two Dracula themes keep their colours over the
  kit's dark geometry. `themes.test.ts` loses its assertion that body text
  is `0.9375rem` and holds `appearance` and the font instead.
- **The shell's own avatar goes; the kit's `Avatar` replaces it.**
  `components/ui/avatar.tsx` (Radix, a twelve-hue colour-by-name palette in
  `--avatar-*` in every theme) is deleted with `@radix-ui/react-avatar`;
  `UserMenu` and the owner row of the new-project wizard use
  `@gears-frontx/ui-kit`'s `Avatar` — a photo when there is one, otherwise
  initials on the kit's neutral fill. A person is expected to have a photo,
  so colour-by-name is not worth a palette of our own.
- The next kit upgrade is a version number in seven `package.json` files,
  `npm install`, a rebuild of the MFEs and a look at the screens.
- `color-scheme` is now set, by the kit, per appearance: native controls,
  scrollbars and autofill follow the dark themes for the first time.
- `packages/framework` differs from the template's `0.2.0-alpha.0` in two
  more files; both changes are the published `alpha.4` code.

### Amendment 2026-10-30 — the framework comes from npm

With the FrontX packages from npm (#946), `packages/` is gone, and the lines
copied into `packages/framework` above left with it, as this record expected:
`@gears-frontx/framework` 0.2.0-alpha.16 stamps `data-theme` from `appearance`
and writes the `:root:root` rule itself. The rest of this record stands.

## More Information

- **Not in this record:** MFEs inheriting the shell's tokens through the
  shadow boundary instead of carrying `theme.css` (it would bring Dracula to
  the screens, and goes against the template's stated reason above); the
  differences in component metrics between the kit and the prototype (Button,
  Input, Tabs, TableHead, Empty), which are a question for the kit against
  Figma, not for this shell.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-portal-shell` — the shell paints from the kit's tokens and selects the kit palette by the theme's appearance
* `cpt-studio-actor-mfe` — the MFEs' theming is unchanged; the record states why Dracula does not reach their screens
* `cpt-studio-adr-shell-tokens-as-whole-colours` — ADR-0007 §3, §4 and its radius exception are amended; its notation decision stands
* `cpt-studio-adr-simplified-navigation-shell` — ADR-0008's avatar colour-by-name is withdrawn; the kit's `Avatar` has none
