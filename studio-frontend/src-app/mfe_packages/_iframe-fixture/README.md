# Frame fixture

Proves `MfeHandlerIframe` without any product code: an MFE package whose entry
is a frame, built and served like every other package, mounted by the shell
into the screen area.

It is deliberately a real workspace package. A fixture assembled by hand in the
shell would prove the loader and nothing else; this one proves the whole path —
build, manifest, registry, handler, mount.

Its extension is `placement: hidden` (#318): registered and mountable, but in
no level's rail.

Its frame reads the same address property as the editor's,
`…space.mfe.frame_url.v1~`, and the shell seeds that with `space-mfe`'s page
whenever that package is in the catalogue (`seedFrameUrl`). So while both are
built, this fixture's frame shows the editor's placeholder, not `index.html`
here. That proves the same path; the page's content is not what the fixture is
for.

See `docs/adr/0021-an-mfe-entry-may-be-a-frame.md`.
