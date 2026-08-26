//! studio-spec-quality — a thin, authenticated wrapper over the external
//! spec-quality service (the detector API whose Swagger lives at the
//! configured `base_url`/docs).
//!
//! The service analyses specification documents with four async detectors —
//! `bloat` (cross-doc duplication), `purpose` (section roles + a purpose
//! gate), `leak` (foreign-content verdicts) and `traceability` (an ID graph
//! or LLM drift judging) — and authenticates with its OWN shared secret. This
//! gear exposes those endpoints under the Studio gateway
//! (`/cf/spec-quality/v1/*`) and forwards to the upstream verbatim, attaching
//! the server-held key. Callers authenticate with their normal Studio token —
//! the spec-quality key never leaves the backend (it lives in this gear's
//! config, same pattern as `studio-llm-proxy`).
//!
//! Shape mirrors `studio-llm-proxy`: bytes in, bytes out, upstream status and
//! content-type preserved. The upstream is async (submit → 202 `TaskCreated`,
//! then poll `GET /v1/tasks/{id}`); the wrapper stays stateless and forwards
//! both the submit and the poll, so the caller drives the task lifecycle.

pub mod config;
pub mod gear;
pub mod rest;
