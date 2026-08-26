# ADR-0008: Simplified navigation shell — overlay drawer, top bar, context slot

Date: 2026-08-18
Status: accepted
Branch: `frontend-adjust-shell-to-mocup`

## Context

A new mockup set ("Scenario group / Simplified navigation", node `40000817:2519`
of the Constructor Studio mockups file) reshapes the shell. Until now the shell
occupied a permanent 232px left column with a 56px collapsed rail, put the
mounted screen's title in a header beside it, and kept the signed-in identity and
sign-out at the foot of the menu.

The mockups move all of that:

- Navigation opens from a burger as a **320px panel over the content**, top bar
  included, behind a `rgba(15,18,24,0.48)` scrim.
- The mounted MFE occupies **everything below a single 56px top bar**, full width.
- The top bar carries the burger, the product name, **which context the session
  is in**, and — on the right — search, inbox and the user's avatar.
- Search becomes a centred 640×520 dialog rather than a screen in the menu.
- The 232px `Overview / Artifacts / Findings / …` rail visible in the project
  frames sits **inside** the project frame, i.e. it is a project MFE's own
  navigation, not shell chrome.

## Decision

### The shell keeps only the top bar in the flow

`Layout` is a top bar plus a content row. Navigation leaves the flow entirely, so
nothing reserves width for it while it is closed. `Screen` drops its `px-4`: with
the column gone each MFE owns its full area and its own gutters — a graph canvas
and a data table do not want the same inset. The shell stops titling the mounted
screen; the MFE owns its heading.

### The drawer's open state reuses the framework's `collapsed` flag

`collapsed === true` means the drawer is closed. This keeps
`layout/menu/collapsed` — the one layout event that already exists end-to-end —
as the single channel anything in the app, an MFE included, can open or close the
drawer through, rather than introducing a second one. The framework's menu slice
defaults to the open state a permanent column wanted, so `main.tsx` dispatches
`setMenuCollapsed(true)` at boot; dispatched rather than emitted so the first
paint is already closed, with no flash of an open panel.

Consequences inside the drawer, all following from it being an overlay: no
collapsed rail (a drawer has two states, not three), no identity footer
(sign-out cannot live behind a panel that is closed most of the time), and it
closes itself after a selection, because it covers the very screen the selection
mounts.

### A separator is placed by an `order` band, not a new manifest field

The drawer stays registry-driven: whatever registers in the screen domain
appears, sorted by `presentation.order`. The mockup rules a line between the
working areas and `My Organization`, but `presentation` has no notion of groups —
`{ label, icon?, route, order? }` is the whole shape, and the shell-owned
`extension_screen.v1.json` schema is what would have to change to add one. The
navigation-composition guideline shipped with `template-shell` already records
flat `order` as a known limitation tracked upstream.

So the shell reads a **band** out of the flat key: below 100 are working areas,
**100 and above is the tenant level**, and the rule is drawn where the sort
crosses 100. No new manifest field, and no MFE id written into the shell.
`organization-mfe` therefore declares `order: 100`.

### The context slot is one slot with two scopes

The top bar's second slot names either the organization or the open project. Its
state lives in a shell slice, `app/context`, and ownership is split along the
gear that owns the data:

- **Organizations**: the shell resolves them itself, through
  `AccountsApiService` — `/me` for the home tenant id, then
  `/tenants/{id}` and `/tenants/{id}/children`, filtered to
  `tenant_type == …cf.studio.tenant.organization.v1~`.
- **Projects**: the shell never requests them. They belong to the
  `studio-project` gear, i.e. `projects-mfe`, which publishes them by emitting
  `app/context/project/opened` and `app/context/projects`.

Selections travel back out as `app/context/org/changed` and
`app/context/project/changed`; leaving a project is `app/context/project/closed`,
which the shell also emits itself whenever a global area is chosen from the
drawer — choosing Projects or People means the session is no longer inside a
project, and no MFE has to say so.

Until `projects-mfe` emits its two events the slot simply stays at organization
scope. That is the designed resting state, not a missing feature.

### Search and inbox are overlay extensions, found by route

The shell owns the dialog frame, its scrim, Escape and dismissal; the content is
whichever MFE mounted into the overlay domain. `search-mfe` moves its extension
from the screen domain to the overlay domain and keeps `presentation.route:
'/search'`; the shell mounts whichever overlay extension claims that route.

Two non-obvious requirements came out of making that work, both worth recording
because neither reports itself honestly:

**An overlay contribution needs a derived extension type.** The overlay domain
instance pins no `extensionsTypeId`, so it looked as though a contribution could
target it with the bare base type `gts.frontx.mfes.ext.extension.v1~…`. It cannot:
GTS refuses to register an instance whose type has no schema, and no schema exists
for the base extension type — the shell registers one only for the derived *screen*
type. So the shell now owns a second derived type,
`src-app/app/mfe/schemas/extension_overlay.v1.json`, modelled on the template's
`extension_screen.v1` and registered alongside it in `main.tsx`. It makes
`presentation.route` **required**, which is right: it is what the top bar matches
on, so an overlay contribution without it is unreachable.

**Every `~`-separated segment of a GTS id needs exactly five dot-separated
parts.** A four-part leaf (`constructor_studio.overlays.search.v1`) makes the whole
id invalid. GTS derives an instance's schema id by trimming the last segment off a
*valid* id, so an invalid one yields no schema id at all — and the error reads
`No schema found for instance`, which points at the schema rather than at the name.

Both mistakes had the same, badly misleading symptom, and it is the reason
`overlayContract.test.ts` exists: `bootstrapMFE` registers packages in a plain loop
with no per-package try/catch, and `MfeScreenContainer` renders the screen domain's
slot only after that promise resolves. One unregisterable extension therefore means
**no screen slot at all** — while the drawer still lists every extension that
registered before the failure. The menu looks perfectly healthy and every click
mounts into nothing.

The inbox is the same mechanism with nothing behind it yet: the button exists and
is disabled until an overlay extension claims `/inbox`. Its unread indicator is
implemented but driven by a prop that is currently `false` — a hardcoded dot
would announce messages nobody has.

### Chrome controls are the kit's Button, not raw `<button>`

Now that the shell depends on ui-kit, the top bar's three controls and the
drawer's close control are `Button` from the kit rather than hand-rolled
elements. The geometry lines up with the kit's own tokens rather than fighting
them: `size="lg"` is `--control-height-lg` (40px) with a 20px glyph, which is
exactly the burger and the drawer's close control; `size="default"` is
`--control-height-md` (36px), which is the round utility pills. An `icon` with no
children sets `data-icon-only` → `aspect-ratio: 1`, so nothing states a width.

The more valuable part is that `variant="ghost"` sets
`color: var(--muted-foreground)` **on the control**. Icon bodies paint from
`currentColor`, so the muted glyph colour now comes from the button's own variant
instead of a class someone has to remember to put on a wrapper — the exact
mistake that made these icons render near-black (see ADR-0007). Where the mockup
departs from the kit's defaults, it does so through the kit's own knobs —
`--button-bg` for the pills' filled circle, `--icon-size-sm` for the 18px glyph
that is not one of the kit's steps — rather than by overriding its classes.

Unavailability is `aria-disabled`, not the native `disabled` attribute. The kit
dims a natively-disabled button to `opacity: .42`, and at that opacity the muted
circle all but dissolves into the header — so the inbox pill read as a *different
colour* from the search one rather than the same control in another state. With
`aria-disabled` (which the kit does not style) the surface stays put, the glyph
carries the state, and assistive tech is told what `disabled` would have told it.

Cost: the hand-maintained kit-token block in `globals.css` grew from 12 entries to
28, because Button reads 40 tokens and the shell declared 19 of them. The five
colour-ish additions are mapped onto tokens the shell already themes
(`--border-strong` → `var(--input)`, `--surface-elevated` → `var(--card)`,
`--primary-hover` → a `color-mix` off `var(--primary)`, …) instead of being frozen
at the kit's light-mode hex, so dark and dracula still track. This is the second
time that block has grown for one component, which is the argument for the
convergence ADR-0007 names as the next step.

### Identity moves to the top bar, keeping its colour contract

The avatar keeps the product's deterministic colour-by-name rather than the flat
brand fill the mockup happens to draw: the hue is a contract shared with
`people-mfe`'s copy of the avatar component, and one person must not read as two
colours on two screens.

## Consequences

- MFE count goes from 6 directories to 7: `_blank-mfe` (reference), four screens
  in the drawer, the new `organization-mfe` (port 3060, `order: 100`), and
  `search-mfe` now serving the overlay. Port 3070 is left free for a future
  `inbox-mfe`.
- `organization-mfe` was scaffolded through the shipped `add-mfe-package` skill
  and workflow, with one stated deviation: copied from `kits-mfe` rather than
  `_blank-mfe`. The reference scaffold has diverged from the five Studio MFEs —
  it carries local shadcn primitives and lacks `anchorKitThemeOnShadowHost` — so
  copying it would have produced the only screen that does not anchor the kit
  theme on its shadow host.
- `components/ui/sidebar.tsx`'s `Sidebar` no longer pins width, border or rail;
  those belong to the consumer now, since one primitive cannot serve both a
  232px column and a 320px overlay. Its `SidebarHeader` is no longer used by the
  drawer: that primitive puts its logo slot in an 18px icon box, which would
  squash the 40px close control.
- Identity tests moved out of `Menu.test.tsx` into `UserMenu.test.tsx`, following
  the control to its new home.
- `SearchDialog` keeps the overlay slot in the tree permanently and hides only the
  frame around it. The mounter attaches the extension's root to the slot's element,
  so a slot that appears only once something is mounted has nothing to attach to at
  mount time — the same reason `MfeScreenContainer` never conditionally renders the
  screen slot.
- **Not built here**, deliberately: the 232px project rail (it belongs to a
  project MFE), the inbox surface (designed, but out of this task's scope), and
  hooking the organization switcher to the framework's tenant slice — `setTenant`
  / `changeTenant` / `initTenantEffects` exist but are dormant in this app, and
  lighting them up is its own change.
- The shell's navigation behaviour now diverges from the
  `navigation-composition` guideline shipped under
  `.frontx/ai/@gears-frontx/frontx-template-shell/`. That file is a template
  deliverable reconciled by `frontx upgrade`, so it is **not** edited here; this
  ADR is where the divergence is recorded. (It is also already stale on a
  separate point: it describes the menu re-reading the registry on a 500 ms
  interval, which `Menu.tsx` replaced with a store subscription.)
