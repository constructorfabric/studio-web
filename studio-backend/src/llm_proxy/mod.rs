//! studio-llm-proxy — OpenAI-compatible LLM proxy for in-IDE AI (Theia AI).
//!
//! Theia AI's `ai-openai` provider speaks the OpenAI chat-completions
//! protocol against any base URL. This gear exposes that protocol under the
//! Studio gateway (`/studio-llm/v1/*`) and forwards verbatim to whatever
//! OpenAI-compatible upstream is configured (no default provider — see
//! `config`), attaching the server-held API key. The IDE containers
//! therefore authenticate with the user's own Studio token — the provider
//! key never leaves the backend.

pub mod config;
pub mod gear;
pub mod providers;
pub mod rest;
