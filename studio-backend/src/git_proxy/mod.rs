//! studio-git — the Git remote a desktop session clones from (ADR-0027 §3).
//!
//! A desktop session must not hold a source host's token, so its clones do not
//! point at the source host. They point here: a Git smart-HTTP proxy that
//! authenticates the member's own Studio token, finds the repository in the
//! workspace's settings under that member's identity, reads the repository's
//! token from credstore, and attaches it on the way upstream. It is
//! `studio-llm-proxy`'s pattern applied to Git — the member holds an identity,
//! the server holds the key.
//!
//! Git speaks Basic authentication, and the api-gateway reads only Bearer, so
//! the three protocol routes are `.anonymous().exposed()` and this gear
//! authenticates them itself through the AuthN resolver — the same resolver the
//! gateway uses, so a token that the portal accepts is accepted here and one it
//! refuses is refused here.
//!
//! A push that goes through also moves the server's copy (ADR-0027 phase 2):
//! each project source it went to gets the `artifact.ingest` run the portal's
//! Re-sync would queue. See [`refresh`].

pub mod gear;
pub mod refresh;
pub mod rest;
pub mod sdk;
pub mod sources;
