# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: software engineers working on a codebase.** They arrive with repositories
(GitHub, GitLab, self-hosted GitLab/GHE, or a plain HTTPS Git URL) and want to work on
them — read, edit, review, ship — with AI agents alongside. The working surface is a
per-workspace Theia IDE session launched from the portal ("Open Studio"), not a local
checkout: sources are cloned into the workspace on first launch and the session lives in
a container the platform owns.

Two secondary audiences are factual parts of the system but are not who the product is
designed around: project administrators (invite members, bind sources, manage connectors
and secrets) and platform/tenant admins (the hidden organization level, ADR-0009/0010,
reachable today only behind `localStorage.setItem("studio.platformAdmin", "on")`).

## Product Purpose

Constructor Studio gives an engineering team a governed place to do project work: a
project holds its people, sources, secrets and connectors, and launches a full IDE
session against those sources with AI agents already configured. Success is that an
engineer opens a project and is working — repos cloned, agents authenticated, quality
and search surfaces present — without assembling any of it locally.

## Positioning

**AI agents inside governed workspaces.** Agent work (Theia AI with @Universal/@Coder,
Codex, Claude Code) runs inside a tenant-scoped workspace where credentials, sources and
outputs are platform-managed rather than local. The LLM provider key never enters the
session container — the portal bridge configures Theia AI through the backend's
`studio-llm-proxy` gear, and Git PATs travel as credstore secret references injected via
an inline credential helper, never written into `.git/config`. A local IDE with an agent
plugin cannot claim this; a hosted IDE without the tenant model cannot either.

## Operating Context

- **The portal** (`studio-frontend/`, FrontX shell + microfrontends, ADR-0006) is where
  projects, people, integrations and secrets live. Shell chrome is a 56px top bar plus an
  overlay drawer (ADR-0008); each MFE owns its own area, gutters and heading.
- **The session IDE** (`theia/`) is Eclipse Theia 1.74.0 with `studio-product-ext` adding
  the product surface: quality scan/measures/marks, flow rail and log, figure and table
  editors, a markdown editor, search, repositories and project views, and a rail nav.
- **The prototype** (`studio-frontend-prototype/`) is the pre-FrontX SPA, kept as a
  playground on port 8081. It still carries the "Open Studio" launcher; the FrontX portal
  on 8080 does not yet.
- Sessions bind to loopback ports 41000–41099, live 4 hours before a reaper collects
  them, and survive backend restarts through label adoption.
- Sign-in is real OIDC (Authorization Code + PKCE) against Keycloak; static dev tokens
  remain for scripts. Sessions renew silently from a refresh token in `sessionStorage`.

## Capabilities and Constraints

- **Terminology, and where the UI and the platform disagree on purpose.** Concept v2
  (`docs/concept-v2-project-is-the-unit.md`, status: exploration, not accepted) says
  *project* at two granularities — a **root project** (AM tenant of type `workspace`) and
  the **nested projects** inside it. Wire words are deliberately untouched:
  `tenant_type: workspace`, `workspace_id`, `.cf-workspace.toml`, and the frontend type
  `Workspace` all stay, so the seam stays visible in code.
- **Organizations are hidden, not removed.** They still own the shared connector
  catalogue and anchor the admin hierarchy; they lost navigation only.
- **Authorization is allow-all.** The Studio PDP is a parked milestone (ADR-0004). Roles
  shown in the UI are *derived* from server state (Owner = `created_by`, Editor =
  Resource Group membership, otherwise Viewer); `Admin` is grant-only, and concept-v2
  grants live in `localStorage` (`studio.concept.roleGrants`), never on the backend.
  Every row must say whether its value is `derived` or a `local` grant. Design must not
  present role control as enforcement.
- **Two UI systems run side by side on purpose** while the shared kit is incomplete: the
  shell composes app-owned shadcn-style primitives in `src-app/app/components/ui/` with
  Tailwind; the MFE screens use `@gears-frontx/ui-kit` inside shadow roots. ADR-0007
  settled the token contract — shell theme tokens hold **whole colours**, not bare HSL
  triplets. New shared components must respect that contract.
- **Nav grouping is an `order` band, not a manifest field** (ADR-0008): below 100 is a
  working area, 100+ is the tenant level, and the separator is drawn where the sort
  crosses 100.
- **Kubernetes v1 runs with IDE sessions disabled** (`studio-session.enabled=false`)
  until the per-session Pod driver lands (ADR-0003). Any portal surface that assumes a
  session must degrade honestly in that deployment.
- Cloning is HTTPS-only — the session container has no SSH key or agent — even when a
  workspace manifest lists `git@…` remotes.
- Undecided, and not to be invented: whether nested projects may nest further (the gear
  has no parent link, so exactly two levels exist today); whether root projects ever
  derive an owner (AM records no `created_by` for them); what the shared connector
  catalogue is called if organizations stay hidden ("Integrations" is holding the job).

## Brand Commitments

The product is **Constructor Studio**, from Constructor Fabric; the repo is assembled on
CF/Gears. Nothing visual is pinned: the user confirmed there is no binding brand system,
mockup set, or style authority for design work at this point. Existing marks in the tree
(`studio-frontend/public/favicon.png`, `FrontXLogoIcon`/`FrontXLogoTextIcon`) are FrontX
template scaffolding, not a committed Studio identity. The Figma "Constructor Studio
mockups" file that ADR-0008 cites is the source of the *shell's current structure*, and
is recorded here as history, not as a visual mandate.

The one idiom that is a genuine constraint rather than a preference: the session surface
lives inside Theia, so it inherits a workbench's widget model, keybindings and theming
variables. That is a functional boundary — not a decision that the IDE must *look* like
stock Theia.

## Evidence on Hand

Real: the running system (compose brings up Postgres, Keycloak, backend, portal 8080,
prototype 8081, API docs at 8090/cf/docs), the ADR set in `docs/adr/`, the domain model
in `domain-model/`, the deploy contract in `deploy/PIPELINES.md`, and a working Theia
image published to ghcr.

Absent — must not be fabricated: no customers, testimonials, case studies, press,
benchmarks, pricing, licensing terms, or usage numbers exist anywhere in this repo. There
is no marketing site and no public-facing copy. Where the model reserves a surface that
does not exist yet (knowledge graph, findings, workflow runs, kits), it stays reserved.

## Product Principles

1. **The project is the unit.** Everything a person needs — sources, people, secrets,
   connectors, the IDE session — belongs to a project and is reached from it. No surface
   should require picking a container first.
2. **Say only what the backend can prove.** Derived state is labelled as derived, local
   overlays are labelled as local, and a control that cannot enforce anything is not
   dressed up as one.
3. **Credentials never travel to where the work happens.** Keys and PATs stay in
   credstore and reach the session by reference; any design that would surface, store or
   echo a secret in the client is wrong by construction.
4. **The seams stay visible.** Where the UI's noun and the platform's noun disagree, or
   where a capability is parked, the code and the interface both admit it rather than
   papering over it with a rename or a placeholder.
5. **Reserved is not empty.** A surface the model anticipates but does not yet have shows
   as reserved, never as fake data.

## Accessibility & Inclusion

No product-specific standard has been established. The functional constraint worth
carrying: the session surface is a keyboard-first workbench, so anything added inside
Theia must be reachable and operable by keyboard alongside its existing keybindings.
