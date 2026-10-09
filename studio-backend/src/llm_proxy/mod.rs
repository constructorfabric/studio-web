//! studio-llm-proxy — Studio's one way out to a model provider, on a person's
//! key.
//!
//! The agents in an IDE session (Claude Code, Codex) and the IDE's built-in
//! chat (Theia AI) reach their providers through this gear, under the Studio
//! gateway (`/studio-llm/v1/*`), authenticated with the member's own Studio
//! token. The call leaves with that member's key — their profile key, else an
//! AI connection they reach ([`keys`]) — so no provider key ever enters the
//! IDE container, and Studio holds none of its own.
//!
//! It is also Studio's one way out to a model provider (ADR-0039): another
//! gear that needs a provider takes [`port::ModelProviders`] from the
//! ClientHub rather than calling one itself.

pub mod config;
pub mod gear;
pub mod keys;
pub mod port;
pub mod providers;
pub mod rest;
