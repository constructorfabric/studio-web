# Frame fixture

Proves `MfeHandlerIframe` without any product code: an MFE package whose entry
is a frame, built and served like every other package, mounted by the shell
into the screen area.

It is deliberately a real workspace package. A fixture assembled by hand in the
shell would prove the loader and nothing else; this one proves the whole path —
build, manifest, registry, handler, mount.

Its rail item is temporary. The portal cannot yet hide a screen from
navigation; once #318 lands, this extension takes `placement: hidden` and the
item disappears.

See `docs/adr/0021-an-mfe-entry-may-be-a-frame.md`.
