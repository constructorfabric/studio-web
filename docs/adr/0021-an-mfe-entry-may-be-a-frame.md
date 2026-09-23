# ADR-0021: An MFE entry may be a frame, and its address arrives at runtime

Date: 2026-09-22
Status: accepted
Branch: `feat/iframe-mfe-handler`

## Context

Everything the portal mounts today is a Module Federation remote. `main.tsx`
registers exactly one loader — `new MfeHandlerMF(FRONTX_MFE_ENTRY_MF)` — and
every package under `src-app/mfe_packages/` is built, manifested and served on
that assumption.

Issue #310 asks for the Theia editor inside the project area. Theia is not a
module this portal can import; it is an application served by the session gate
on its own address, and the only way to put it on screen is a frame. The
platform has no iframe loader and no mention of one: `@gears-frontx/mfes` is
silent on the subject. It is, however, deliberately silent — `MfeHandler` is a
public abstract class, the handler list is the host application's to write, and
gears-frontx ADR-0006 registers the Module Federation handler at priority zero
precisely so that a more specific loader can be added by someone else. The
extension point was left open; this decision walks through it.

Three facts about the runtime shape what can be built on that opening.

- **Handler selection happens on the base type, not on priority.** The type
  plugin's `isTypeOf` is prefix matching. An entry chained off
  `gts.frontx.mfes.mfe.entry.v1~` is simply not an `entry_mf.v1~`, so
  `MfeHandlerMF` never claims it and the two loaders never compete.
- **The container is always a shadow root.** `DefaultMountManager` calls
  `createShadowRoot` before any handler branch, and the injected
  `:host { all: initial }` means a frame with no explicit size collapses to
  nothing.
- **A load is cached per extension instance.** The same lifecycle object is
  reused across mounts, and `unmount` receives only the container — never the
  bridge that was handed to `mount`.

The build pipeline is the part that does not bend. `generate-mfe-manifests.ts`
walks every directory holding an `mfe.json`, demands the `mf-manifest.json` the
federation plugin leaves behind, reads `manifest.metaData.remoteEntry`, and
throws when an entry carries no `exposeAssets`. A frame has none of these: it
has an address, and the address is not known at build time.

## Decision

### The frame is an entry subtype this repository owns

A new schema, `src-app/app/mfe/schemas/entry_iframe.v1.json`, declares
`gts.frontx.mfes.mfe.entry.v1~constructor_studio.mfes.mfe.entry_iframe.v1~`
by the same move `extension_screen_leveled.v1.json` already makes for screens:
`allOf` over a `$ref` to the FrontX base type, registered from `main.tsx` with
`gtsPlugin.registerSchema`. Nothing in gears-frontx changes. The base entry
contract asks only for `id`, `requiredProperties`, `actions` and
`domainActions`; the three fields that make an entry federated are declared by
`entry_mf.v1.json` and are not inherited.

The subtype chains off `entry.v1~` and **not** off `entry_mf.v1~`. That is what
keeps `MfeHandlerMF` from matching it, and it is why `MfeHandlerIframe` needs no
priority above zero to win. A priority is declared anyway, because a handler
that relies on nobody else ever chaining off its base type is relying on a
coincidence.

### The entry names a property, never an address

The subtype adds exactly one field: `urlProperty`, the id of the shared
property the frame's address arrives in. The entry carries no URL, and the
handler knows nothing about Theia, about sessions, or about who writes that
property. Iteration 2 puts a static page in it; iteration 3 puts the session
gate's address.

A development-only `fallbackUrl` was considered and rejected. Two roads to one
value is a branch in the handler that exists only until the first real writer
lands, and then has to be found and removed.

### The loader is built on `ChildMfeBridgeImpl`

`MfeHandler` requires a `bridgeFactory`, and the shipped
`MfeBridgeFactoryDefault` is one line — `new ChildMfeBridgeImpl(domainId,
instanceId)` — because the runtime does the actual wiring through its own,
separate bridge factory. `MfeHandlerIframe` therefore writes that line itself
rather than importing the default: `MfeBridgeFactoryDefault` is exported from
the pinned `0.3.0-alpha.2` but has since left the package's public surface,
while `ChildMfeBridgeImpl` is exported from both.

The version stays at `0.3.0-alpha.2`, which every consuming package already
pins exactly. Moving to `alpha.7` renames `ChildMfeBridge`'s identity fields and
is a repository-wide change with its own reasons; it is not this one.

### The lifecycle keeps teardown per container

Because a load is cached and `unmount` is handed only the container, the
lifecycle holds its subscriptions in a table keyed by container and drops the
one belonging to the container being unmounted. A single closure would leak a
listener on the second mount and keep writing `src` into a frame that is no
longer on the page.

The frame is created with explicit `width: 100%`, `height: 100%` and no border,
for the shadow root's sake, and shows a waiting state while the property holds
nothing. The waiting state carries `role="status"`, because it is not only an
opening screen: it comes back when the address is cleared after a frame has
been on display, and that is a change a screen reader would otherwise pass
over in silence.

### Redrawing is driven by the value, not by the notification

`updateSharedProperty` notifies every subscriber on every write, whether or not
the value changed, so the same address arrives again on any republish — a
session refetch, a reconnect, a second writer agreeing with the first. The
lifecycle therefore remembers what each mount is currently showing and does
nothing when the new value equals it. Assigning `src` the address a frame
already holds is a fresh navigation rather than a no-op: the frame reloads, and
once a real editor is inside, that is unsaved work. The waiting state is
cheaper to redraw but no more welcome, since replacing a live region announces
it again.

### Not every entry is federated, and the manifest generator learns it

`generate-mfe-manifests.ts` gains one branch, chosen per package rather than
per entry: when none of a package's declared entries descend from the Module
Federation subtype, the whole package skips enrichment entirely — no
`mf-manifest.json`, no `remoteEntry`, no `exposeAssets`. A package is either
federated or framed, never a mixture of the two; one that declares both an MF
entry and a frame entry is a configuration error the generator rejects, with
a message that names the mixture, rather than one that takes the federated
path and fails deep inside expecting a build that was never meant to exist.
A frame package carries no `manifest` block in its `mfe.json` at all; it
declares a top-level `devUrl` instead, which is the one thing a federated
package's `remoteEntry` was being read for. The page address is then resolved
by the ladder already there: `/mfes/<package>/` from `--base-path` in a
production image, and `devUrl` otherwise.

`manifest` becomes optional in the generated config, and `bootstrap.ts` has to
be taught to tolerate that. It does not today: `MfeManifestConfig.manifest` is
required, and both `resolveRuntimePublicPaths` and `mfeStylesheetHrefs` reach
through `config.manifest.metaData` with the optional chaining on `metaData`
rather than on `manifest`, so the first frame package to reach either of them
throws. Both guards are part of this change, not something inherited.

This work belongs here rather than in #321. The frame entry is born in this
change; the first product package to use one should find the pipeline already
knowing what it is.

### The fixture is a real package

`src-app/mfe_packages/_iframe-fixture` is an ordinary workspace package whose
Vite config omits the federation plugin and builds one static page. Two of the
three build scripts need nothing: `build:mfes` discovers it by the `--port` in
its preview script and runs `vite build`, and `package:mfe-assets` copies its
`dist/` beside every other remote. Port 3080: every other preview port already
in use — 3010, 3020, 3030, 3040, 3050 and 3060 — is spoken for by an existing
package, 3070 is reserved by ADR-0008 for a future `inbox-mfe`, and 3099
belongs to `_blank-mfe`; 3080 is the first free one.

A fixture that is loaded the way a product package is loaded proves the whole
path — build, manifest, registry, handler, mount. One assembled by hand in the
shell would prove the handler and nothing else.

### The address property is the one from the #310 contract, and the shell seeds it

`...comm.shared_property.v1~constructor_studio.space.mfe.frame_url.v1~`, with its
constant in `@constructor-studio/mfe-shared`, is added to the screen domain's
shared properties — without that, contract validation refuses an entry that
requires it.

The id differs by one token from the one #310 wrote down. #310 spells it
`constructor_studio.space.frame_url.v1~`, which the GTS parser rejects —
`validateGtsID` answers *"Invalid GTS segment #2 … Too few tokens"*, because an
instance segment is five tokens and that one is four. #310 states the five-token
rule itself, in the same section, so this is a slip in the contract rather than a
disagreement with it. The `mfe` namespace token restores the count and matches
the entry id two lines above it in the same contract,
`constructor_studio.space.mfe.main.v1`. Whoever implements the other half of
#310 takes this spelling, not the issue's. At start-up the shell puts the fixture's page address into it,
read from the generated manifest so the value is correct in development and in
a production image alike.

That seeding is not scaffolding. It is the step #321 describes as "while there
is no session, the shell puts a static page into that property"; what changes
later is the source of the value, not the mechanism.

### The fixture's screen is visible until #318

The fixture declares a leveled screen at the organization level with a high
`order`, and it appears in the rail. The portal cannot yet hide a screen from
navigation — that is #318, and this change deliberately does not wait for it.
Seeing the page in a running portal is worth a temporary rail item; the item
goes away when `placement: hidden` exists.

## Consequences

* A frame is a weaker tenant of a screen than a module is. The screen domain
  mounts exclusively, eviction removes the container, and a frame therefore
  loses everything it held when the user leaves and mounts it again cold on the
  way back. Nothing in this ADR changes that, and #310 will have to say what it
  means for an editor session before the editor actually lands there.
* In development the fixture is served from its own preview port and is
  cross-origin to the portal; in a production image it is same-origin under
  `/mfes/`. Irrelevant while nothing talks to the frame, and the first thing to
  check when #323 starts posting messages into one.
* The rail carries a demonstration item in every environment, production
  included, between this change and #318.
* The frame is created with `referrerpolicy="no-referrer"` but no `sandbox`.
  Under `/mfes/` in a production image it is same-origin with the portal
  regardless, so its document can reach `window.parent` directly. Nothing is
  inside it yet but a static page this repository ships, and #323 is the
  issue that puts a real application there and starts posting messages across
  that boundary — it is the place to decide what the frame may be trusted
  with, and to say so rather than inherit this silence.
* The eventual move to `alpha.7` now has one more caller of the bridge's
  identity fields to update.
* The generator's new branch is the price #321 does not pay. It is also the
  first time this repository has said in code that a micro-frontend need not be
  a module, which is the claim the platform will be asked to adopt later.
