---
target: branding system across portal, session IDE, and desktop
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 3
p1_count: 4
timestamp: 2026-08-27T04-14-11Z
slug: branding-system
---
Method: dual-agent (A: design review, source-only — no running stack; B: detector + measured evidence)
Detector caveat: ran DEGRADED (htmlparser2/css-select/css-tree/domutils unavailable). Custom properties,
selector matching and computed contrast were NOT evaluated by the tool; zero-counts on the portal targets
are undercounts. All contrast ratios below were computed independently, not by the detector.
Browser evidence: skipped — nothing listening on 8080/8081/8090, Docker daemon down, stack deliberately not started.

# Design Health Score — 24/40 (applicable max 40, no n/a)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Best system-design in the repo (one loader, 140ms threshold, named captions, role=status). Reduced-motion forces nearly the whole marquee field on — the "static ring" promise is inherited from an arc spinner this is not. |
| 2 | Match System / Real World | 2 | welcome-view.js sells document review ("Write. Talk. Decide.", Q3→Q4 specimens) to an audience PRODUCT.md defines as engineers arriving with repositories. "Gear" ships verbatim in 35 locale files. |
| 3 | User Control and Freedom | 3 | Two-click destructive confirms with 2600ms self-disarm; Escape on drawer and scrim. Focus ring globally suppressed after pointer input. |
| 4 | Consistency and Standards | 1 | Two brands, four accent palettes, five marks, five icon languages, 29 font sizes, 15 radii against one token used 9/125 times. |
| 5 | Error Prevention | 3 | Credentials never reach the session by construction. Status-line five-field cap enforced in CSS, not policy. |
| 6 | Recognition Rather Than Recall | 2 | No wordmark inside the IDE at all; five unrelated marks; "Open" and "Open Studio" adjacent with the distinction stated nowhere. |
| 7 | Flexibility and Efficiency | 3 | Commands first-class and bindable; event.code not event.key. Portal has no keyboard story. |
| 8 | Aesthetic and Minimalist Design | 2 | Stated discipline contradicted by white shadows in light mode, warning icons in the navigational accent, stock-render favicon. |
| 9 | Error Recovery | 2 | Raw HTTP status and bare e.message at sign-in; scaffold instructions in primary nav; 100s-of-MB first-run download reports only to console.info. |
| 10 | Help and Documentation | 3 | Welcome board built from the product's own live classes so it cannot drift; leader lines hidden by measurement. Documents the wrong product; aria-label disagrees with visible heading. |
| **Total** | | **24/40** | Consistency is the whole gap. |

# Design Specificity Verdict

Split, and it splits backwards against reach. Remove the string "Constructor Studio" from the portal and
nothing identifies the product: shadcn/Tailwind admin console, violet primary, slate neutrals, 56px bar.
The session IDE is materially more specific (icons.js argues each glyph from its failure modes; two-tier
line system with measured contrast justifications). The desktop mark is the most specific artefact in
either repo and the least seen.

There is no Studio mark. There are five: raster CF over a 3D mesh (favicon), flip-dot CF (loader + splash),
flip-dot S (desktop icon), CS monogram and S monogram (prototype), plus an unused FrontX dot-cluster.
The S/CF split (Fabric = family, S = product) is deliberate and well argued in icon.svg — and implemented
in exactly one place.

# Priority Issues

- **[P0] The crossing does not exist.** PRODUCT.md names portal → "Open Studio" → session IDE as *the*
  core journey. `studio-frontend/src-app` contains no "Open Studio" and no session API client. The
  launcher ships only in the prototype, which PRODUCT.md calls a playground. Fix: build it; brand
  consistency across the seam is the second problem.
- **[P0] "FrontX" and "FrontX Studio" are live in production.** `index.html:7` titles every portal tab
  FrontX. `<StudioOverlay />` is mounted unconditionally at `App.tsx:41` with no DEV guard and no vite
  stub; its heading renders "FrontX Studio". Fix: set the title; gate the overlay at the mount site and
  alias the package to a stub in the production build.
- **[P0] Three tokens lie, and the warning channel has no colour.** `--studio-amber/cyan/green` all hold
  #0b2275. `--theia-notificationsWarningIcon-foreground: var(--studio-amber)` means a warning is painted
  the same navy as a link, a button, the focus ring and the selection. An abandoned amber-and-cream brand
  (#d59b3b, #f1eee7, #16171c, #61c9d7) still lives in var() fallbacks; repositories-view.js:872-885
  interleaves two generations of the system. Fix: rename to --studio-accent, add real --studio-warning
  (#9A6700, 4.9:1) and --studio-verified (#1A7F4B, 5.0:1), purge every var(token, #hex) fallback.
- **[P1] Inter is declared on four surfaces and loads on one.** Zero font binaries committed in either
  repo. IDE renders San Francisco / Segoe UI. Portal registers 'Inter Variable', everything else declares
  'Inter', so the spellings would not match even if a face were added. Weights 620/640/650 across ~55
  sites encode a distinction static system faces cannot render. 29 font sizes, 13 inside the 9–15px band.
  `--studio-mono` referenced once, defined never. Fix: bundle both faces into Theia, settle one family
  name, define --studio-mono, collapse the weight and size ladders.
- **[P1] Focus ring globally suppressed.** `body[data-studio-input="pointer"] :focus-visible { outline:
  none !important }` (product-frontend-module.js:837) removes the indicator from everything including
  Monaco, for anyone whose last input was a pointer. WCAG 2.4.7. Fix: scope to the two controls that
  misbehaved.
- **[P1] Contrast failures on shipped values.** White on #5b73e8 (every dark primary button) 4.15:1.
  --studio-muted on --studio-chrome 4.05:1 and on --studio-surface-raised 4.24:1. Untokenised #9298a8
  (30 uses) 2.89:1 and #d59b3b (29 uses) 2.45:1 — both fail AA-large as text. Every border on every
  surface 1.18–1.59:1 against 3:1 non-text minimum; in the IDE this is documented and deliberate.
- **[P1] Nine toast declarations are silently invalid.** globals.css:188-219 wraps whole colours in a
  second hsl(); the parser drops all nine. The file's own line-50 comment says the tokens are whole colours.
- **[P2] Five icon languages.** Material Symbols (portal chrome), Lucide (portal MFEs), the product's own
  1.8-stroke set (IDE), VS Code codicons (every IDE tab and palette entry), plus vendor marks. Quality's
  tab is a beaker while icons.js spends fifteen lines arguing it must be a gauge. Seven MFE READMEs
  instruct lucide:* while every shipped manifest uses material-symbols:*.
- **[P2] Fifteen radii, one token used 9/125 times.** Three unrelated radius scales. --studio-shadow used
  once; its inline fallback does not match its declaration. No duration or easing tokens; the house curve
  is spelled three ways.

# Persona Red Flags

**Staff engineer evaluating the platform:** tab says FrontX; favicon is a stock render; drawer can display
"copy the _blank-mfe reference scaffold in mfe_packages/"; Shift+` produces "FrontX Studio"; the demo they
came for does not exist in the portal; the IDE's first screen sells document review with a Q3→Q4 example.

**Security/platform reviewer (governance is the pitch):** backend state in user copy (HTTP status, bare
e.message); the warning channel is chromatically identical to "this is clickable"; "gear" and "Theia" and
"container" surfaced as product vocabulary in 35 locale files and a live toggle label.

**Keyboard-driven low-vision engineer:** focus ring suppressed after pointer input; six measured contrast
failures above; --studio-focus is a naming error (used as a selection halo, never as the focus ring) and
focus rings have four distinct treatments.

# Minor Observations

default.ts and light.ts are byte-identical (two entries in a five-theme picker). Two Dracula themes = 40%
of the theme roster. Dracula's // #hex comments do not match the HSL that ships. mocks.ts:43 seeds a tenant
named "Constructor Fabric" — the parent brand as sample data in the child. All seven MFE dev pages titled
"Blank MFE Remote". theia/src-gen still titles itself "Eclipse Theia" (electron-app declares no
frontend.config). Desktop artifacts ship as "Constructor Studio-...zip" and "ConstructorStudio-...dmg".
No favicon link in any Theia index.html. Portal scrim colour hardcoded twice, no --scrim token.
--studio-positive, --studio-success, --studio-slot-ring consumed but never defined.
Favicon is 79KB raster, 200x200; no .ico, no apple-touch-icon, no SVG favicon anywhere.

# Fixed During This Review

splash.svg rebuilt on flicker-dot's unit grid (9x5, one blank column, whole field drawn, centred by
construction, product tokens, dark mode). loader.js marquee reversed to right-to-left across all three
vendored copies, seal re-recorded, 25 tests pass. icon.svg was invalid XML (-- inside an XML comment,
rendering only because render-icon.mjs injects it into HTML) — now parses.
