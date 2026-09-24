# ADR-0022: The address decides where the shell is, and the shell alone writes it

Date: 2026-09-24
Status: accepted
Branch: `feat/shell-router`
Issue: #376, under #310

## Context

The portal has levels — organization, workspace, project — and a rail per
level (ADR-0008, `studio-frontend/docs/sdlc/FEATURE/shell-levels.md`). It has
no address. `presentation.route` is a string nothing reads, and the feature
that introduced the levels said so on purpose:

> There is **no address**. FrontX has no routing … routing is coming
> upstream, so this feature writes neither a router nor a bridge to one.
> (`cpt-studiofrontend-dod-shell-levels-no-address`)

That DoD accepted two costs — a reload returns the session to the organization
level, and there is no link to a project — and claimed that its rules would
make "adopting the framework's router a configuration change rather than a
rewrite". Issue #310 now needs a link to an artifact inside a project, and the
upstream router has landed. Neither half of that claim survives contact with
it.

**What shipped upstream.** `@gears-frontx/routing` and
`@gears-frontx/routing-tanstack`, both `0.3.0-alpha.0`, published 2026-09-23
(gears-frontx #588, #585, #624). The first is a contract: one navigation
history per JavaScript realm, a URL grammar in which every mounted extension
is one query entry `domain=token;name=value`, and a per-domain signal that
reports which registered extension the URL names. The second binds that
contract to TanStack Router inside one micro-frontend. Nothing turns either on:
there is no `FrontXConfig` key, no plugin and no bootstrap call, and the
`mfes` and `api` packages are forbidden by upstream's own dependency rules from
importing routing at all. A host writes the glue itself — the consumer
obligations O1–O7 in `packages/routing/architecture/DESIGN.md` — and the
reference integration into the template shell (gears-frontx #638) is open and
blocked by #623. This shell is the first consumer.

**What the library does and does not do.** It resolves the URL against a
registered-extensions source the host supplies, reports transitions, and
writes the URL when told to (`backProjectEntries`). It never mounts, never
reads the pathname — that is the host's "shell subroute", copied verbatim — and
never reads a manifest. An extension's token is its `presentation.route`
without the leading `/`, and it must match `[a-z][a-z0-9-]*`. A route that
does not is silently not routable. Of the nineteen routes declared under
`src-app/mfe_packages/`, five qualify (`/search`, `/connections`,
`/projects`, `/people`, `/kits`); every section of a project or of the
organization (`/projects/artifacts`, `/organization/overview`, …) and the
frame fixture (`/fixture/frame`) do not. The library keeps foreign query
segments — an OAuth `state`, a `utm_*` — across its own writes.

**What this shell already is.** `mountScreen.ts` mounts through
`executeActionsChain` with `FRONTX_ACTION_MOUNT_EXT`, and `ScreenDomainImpl`
in `src-app/app/mfe/bootstrap.ts` handles that action with an
`ExclusiveMountStrategy` — the two seams the obligations assume. The level
context lives in the `app/context` slice: the organization comes from the
signed-in person's memberships, the workspace is resolved per organization
and defaults to the first, and a project exists only after `projects-mfe`
publishes `opened` with the project's `{id, name}` and its siblings. The MFE
then opens the project when the shell's `project.selected` property comes
back — `ProjectsRoot.tsx` says "that is the only way in" — and follows the
`section` property the same way. The first screen is chosen by
`MfeScreenContainer.onAttached`, which always asks for the organization level.
`AccountsApiService.getTenant` returns a tenant's name and `parent_id`, so a
project id alone leads to its workspace and organization.

**Two facts that shape the edges.** Theia, the eventual occupant of the
project area (#310), runs in an iframe — another realm — and cannot join the
shared history; whatever it needs from the address, the shell hands over.
And the OIDC provider redirects to `${origin}/` and `AuthGate` scrubs the
callback parameters with `window.history.replaceState`, so a pasted link
does not survive a sign-in unless something carries it across.

## Decision

### One entry in the screen domain, query only

The shell projects exactly one domain, the screen domain, under the root key
`screen`. The pathname stays `/`; everything the shell knows about where it
is travels as parameters of that one entry:

```
/?screen=people;org=<orgId>
/?screen=organization;org=<orgId>;section=workspaces
/?screen=projects;org=<orgId>;workspace=<workspaceId>
/?screen=projects;org=<orgId>;workspace=<workspaceId>;project=<projectId>;section=artifacts
```

The library then manages the whole address. A hierarchy in the pathname
(`/org/{o}/ws/{w}/project/{p}`) reads better and was rejected: the library
never interprets the pathname, so the shell would own a second parser and
serializer, a second `push`, and two mechanisms that have to agree. Overlay,
popup and sidebar are not in the address. A hidden screen (`placement:
hidden`, #371) is routable like any other — `?screen=fixture;org=<orgId>`
mounts the fixture.

### The token is the first segment of the route; the section is a parameter

A screen's token is the first path segment of its `presentation.route`,
validated with the library's own `validateName`. Every extension whose route
starts with the same segment belongs to one group, and the group is one
registration in the screen domain. This is a rule of this shell, not of the
library, and it exists because the manifests already say what the URL should
say: `/projects/artifacts` is the `projects` screen at its `artifacts`
section, and `presentation.section` already carries that token. Renaming
sixteen routes to `projects-artifacts` and friends would make a section change
look like a screen change in the address when no mount happens, and
`organization-mfe` has no sectionless item at all.

The extension the group mounts — its route owner — is chosen by the lowest
level first, then the item without a section, then the lowest `order`. The
order of those tie-breakers matters: `/projects/overview` has the lowest
`order` in its group but declares the project level, and mounting it with no
project open would make `useScreenLevel` report a project level and the rail
draw project sections over an empty project. So `projects` mounts `/projects`
(workspace level) and `organization` mounts `/organization/overview`. Which
same-entry extension is mounted never changes what the address says: the
group's token is written, and the section comes from the context, not from
the mounted id.

The registered-extensions source is built once, after `bootstrapMFE` has
registered every manifest, and supplies no `onChange`: the set does not
change after start-up. The root `DomainKey` has no public constructor in
`0.3.0-alpha.0` (gears-frontx #638, item 2); one helper casts the validated
name, and nothing else does.

### The parameters a level carries

Parameters are written by the level in scope — the owner's level, deepened
to project while a project is open — always in this order, and only as far
down as that level goes:

| Level in scope | Parameters |
|---|---|
| organization | `org`, then `section` when the group has sections |
| workspace | `org`, `workspace` |
| project | `org`, `workspace`, `project`, `section` |

A workspace is not written for an organization-level screen even though the
slice holds one: the address says what the screen is scoped to, not what the
slice happens to remember. Parameters this shell does not know are ignored on
read and dropped on write. #320 extends the project row with the artifact
(`artifact`, `repository`, `path`, `kind`) under the `space` token; nothing
here forecloses that.

### The URL is where navigation is decided

Every navigation is a write to the address, and nothing else moves the shell.
A click in the rail, a pick or a level change in the context chain, a project
opened or closed inside `projects-mfe`, a workspace chosen on a screen — each
computes the route it means and calls `navigate(route, verb)`, which is
`backProjectEntries` on the `screen` key. The library reports the transition,
and one function, `materialize`, brings the shell to what the address now
says. The handlers in `appContextEffects.ts` no longer touch the context
slice; they translate an event into a route. The event names stay, so `Rail`
and `ContextChain` are unchanged.

The verb is decided by who navigated:

| Origin | Verb |
|---|---|
| a person: rail, chain, a project opened or closed in the MFE, a workspace picked on a screen | `push` |
| the MFE moving to a section by itself (`announceSection`) | `replace` |
| a default filled or an unknown id dropped by `materialize` | `replace` |
| the first screen when the address is empty | `replace` |

`materialize` is idempotent. It compares each part of the route with the
slice and the mounted group and changes only what differs; mounting the group
that is already mounted does nothing. When the state it reached differs from
the route it was given — a default was filled, an id was refused — it writes
the normalized route with `replace`. A converged state writes nothing, so the
library's echo of the shell's own write, which comes back as a transition,
finds nothing to do, and no loop can start. The library caps re-entrant
rounds at a hundred and throws; a test holds the convergence.

`opened` from `projects-mfe` carries data the address cannot: the project's
name and the workspace's projects for the switcher. The handler stores both in
the slice first and navigates second, so `materialize` finds the name in the
cache and nothing is fetched twice.

### `materialize` is the only writer of the context, and the only mounter

The slice becomes a function of the address and of three catalogs the shell
fetches: the organizations the person may act in, the workspaces of the
organization in scope, and the projects known for a workspace. Each catalog
arrives on its own time and re-runs `materialize` against the current route;
the route never waits for a catalog, and a catalog never picks a value the
route did not name.

A project named in the address is resolved in this order: the cache of the
workspace's projects (an `opened` publish, a sibling list, a previous visit),
then `getTenant(projectId)`. The tenant's `parent_id` must be the workspace in
the route. `project.selected` is published as soon as the id is known, so the
MFE opens the project without waiting; the context chain shows a skeleton in
the project slot until the name arrives.

The mount is the last step: if the mounted group is not the route's group,
`materialize` calls `mountScreen` with the group's owner and, when the mount
resolves, runs again — the address may have moved meanwhile, and
`mountScreen`'s own generation counter already refuses a superseded mount.
Nothing else in the shell calls `mountScreen`.

### Start-up and the first report

`AuthGate` scrubs the OIDC callback before the authenticated app mounts, and
the navigation history is created lazily, in `startRouting`, so no history
write by the gate is ever made behind the library's back. `bootstrapMFE` and
`app/context/fetch` run in parallel as today. When the screen slot attaches,
`startRouting` resolves the history, creates the signal and one observer for
the `screen` key; the first report is synchronous, and `materialize` mounts
the group at once — a mount needs no catalog. The organization, workspace and
project parts land as their catalogs do. An empty address becomes the
organization level's entry point and is written with `replace`, so a reload
from then on keeps the place. When access is `unassigned` the route is not
applied and nothing mounts; the gate shows the onboarding state as before.

### A link survives the sign-in redirect

`login()` stores the current `search` and `hash` in `sessionStorage` under
`studio.oidc.return_to` before redirecting, and `AuthGate`'s scrub restores
it with the same `replaceState` it already performs. Only a relative string
beginning with `?` or `#` is stored or restored; an origin or a path is never
taken from storage. Both changes live in `auth/` and import nothing from
routing.

### What is refused, and how it degrades

Every refusal is a `console.warn` and a normalized `replace`; none throws.

- An unknown token — the observer reports it unresolved — lands on the
  organization level's entry point.
- An organization outside the person's list becomes the first one; the
  workspace and project are dropped with it.
- A workspace outside the organization's list is dropped, and the project with
  it.
- A project that answers 404 or 403, or whose parent is not the workspace in
  the route, is dropped, and the section with it.
- A mount that fails is retried once as the level's entry point; if that fails
  too, nothing is mounted and the warning says so, which is today's behaviour.

### MFEs stay URL-unaware

No MFE imports `@gears-frontx/routing` or reads `location`; the rule of
`cpt-studiofrontend-dod-shell-levels-no-address` that forbade it stands, and a
`dependency-cruiser` rule enforces that the package is imported from
`src-app/app/routing/` only. MFEs keep publishing actions and reading shared
properties, and the properties keep their shapes. `@gears-frontx/routing-tanstack` inside an MFE waits until upstream hands a mounted MFE its
`EntryAddress` (#638, item 1); when it does, the parameters above are what
that MFE's virtual location will already contain.

### Considered and rejected

- **The slice as the source of truth, the address as its projection.** Fewer
  files change: the existing handlers keep writing the slice and call a
  `reflect(verb)` afterwards. Rejected for having two writers of the same
  fact — a handler and a transition can both decide what is open, and every
  bug of the old prototype's navigation was a disagreement between them. One
  direction is worth the rewrite of `appContextEffects.ts`.
- **A store subscription that writes the address by heuristic.** The least
  code, and the verb is guessed from what changed; Back then skips a
  workspace switch and stops on a filled default. It does not meet #376's
  Done-when.
- **Waiting for the template integration (gears-frontx #638).** It is blocked
  by #623 with no date, and #310 is scheduled now. What the template will do
  is the same glue; if its shape differs when it lands, the difference is
  confined to `src-app/app/routing/`.
- **Renaming the routes to single tokens** and **the hierarchy in the
  pathname** — both above, in the sections that chose otherwise.

## Consequences

- `shell-levels.md` is amended, not rewritten: `cpt-studiofrontend-dod-shell-levels-no-address` keeps its rule about MFEs and loses "there is no
  address" and the two accepted costs; the acceptance items that expect a
  reload to return to the organization level are inverted; the flows note
  that a click navigates and the shell follows the address.
- `src-app/app/routing/` is new — token grouping, the route codec,
  `navigate`, `materialize`, `startRouting` — with tests on an in-memory
  navigation history. `appContextEffects.ts` and its 27 tests are rewritten
  around navigation and catalogs; `MfeScreenContainer.test.tsx` follows the
  new `onAttached`; `Rail.test.tsx` and `ContextChain.test.tsx` do not move.
- `@gears-frontx/routing@0.3.0-alpha.0` is a dependency of the shell. It has
  no dependencies of its own, so the `mfes`, `api` and `gts-plugin` pins do
  not move. `routing-tanstack` pins `routing` exactly; the day an MFE takes
  it, the two versions move together.
- The address is the durable state, and only it: a reload or a pasted link
  reproduces the screen, the level and the section; anything an MFE keeps
  outside the shared properties is still lost on reload, as before.
- Back and Forward across the editor remount its frame cold (ADR-0021); the
  backend session survives, the frame's own state does not. #310 accepts
  that; a keep-alive strategy is a separate decision.
- The address carries ids in the clear and, with #320, a repository path.
  The budget is about 2000 characters and nothing enforces it.
- Search and the wizards stay overlays without an address. Making one
  addressable is a second domain key and a second observer, not a change to
  this design.
- The frame fixture is reachable by address in every build. #321 decides
  whether it stays in the production catalogue.
- When gears-frontx #623 gives extensions a `route` of their own with a
  registration-time uniqueness check, the first-segment rule is revisited; the
  address format need not change for that.
- `FrontXConfig.routerMode` in the vendored `packages/framework` stays
  declared and unread, as it was; removing it is a template concern.
