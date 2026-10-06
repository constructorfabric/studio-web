# studio-git

The Git remote a desktop session clones from and pushes to (ADR-0027): a Git
smart-HTTP proxy that takes the member's Studio token and attaches the
workspace's stored token upstream.

The design — why a desktop never holds a source host's token, how the protocol
routes authenticate themselves, what a push re-syncs, the REST surface — is
[`docs/design/studio-git.md`](../../../docs/design/studio-git.md). This README
is what you need to work in the directory.

## In the assembly

- Gear `studio-git`, capabilities `[rest]`, deps `account_management`,
  `credstore`, `authn_resolver`; all three clients are required at init.
- No Cargo feature and no config section.
- `sources::Source` is also the source type of
  [`../studio_session`](../studio_session) and
  [`../project_sources.rs`](../project_sources.rs);
  [`../components_catalog`](../components_catalog) reuses `rest.rs`'s
  authentication and relay for the gear corpus.

## Working here

- Every decision that needs no network — the upstream URL, the presented token,
  the upstream credential, the syncs a push asks for — is a plain function in
  `sources.rs` or `refresh.rs`, with its tests beside it.
