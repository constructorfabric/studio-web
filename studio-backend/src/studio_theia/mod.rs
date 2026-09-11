//! studio-theia — backend-to-backend bridge to the per-session Theia node
//! backend (ADR-0010). Publishes [`sdk::TheiaControlClientV1`] for
//! studio→Theia control calls and mounts the Theia→studio event ingress.
//!
//! Phase 2: endpoint discovery resolves through [`discovery::StudioSessionResolver`]
//! (studio-session control endpoint + per-session S2S token); the event ingress
//! authenticates and republishes onto `studio-events`. Dormant
//! unless `studio-theia.enabled = true`. See
//! `docs/adr/0010-theia-backend-bridge.md` and
//! `docs/theia-bridge-contract-v1.md`.

pub mod config;
pub mod control_client;
pub mod discovery;
pub mod gear;
pub mod rest;
pub mod sdk;
pub mod service;
pub mod sink;
