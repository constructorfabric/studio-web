# space-mfe

The editor screen: a frame package (ADR-0021) at the project level,
`placement: hidden`, `presentation.route: '/space'`. The shell mounts it when
the address names `screen=space` — opening an artifact is a navigation (#320).

The frame loads the address in `…space.mfe.frame_url.v1~`: the project's Theia
session, which the shell reuses or launches when the editor opens and publishes
once it answers (#322). The shell then talks to the IDE in the frame — the
theme, the member's token, the file to open — and calls the editor ready when
the IDE answers (#323, `docs/feature/editor-bridge.md`); the frame never reads
the portal's address.

The package's own page (`index.html`) is never what the frame shows: since
#322 the property holds the session's address or `null`. The package exists
for its `mfe.json` — the frame entry, its property, its placement — and its
`devUrl` only satisfies the manifest generator, which asks one of every frame
package.
